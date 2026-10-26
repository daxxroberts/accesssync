/**
 * @file location-lapse.js
 * @layer core/layer4
 * @role subscription-lapse
 * @reads locations, clients, connector_subscriptions, member_access, member_access_sources, plan_mappings
 * @writes member_access_log, billing_subscriptions.status, config_alert_log
 *         (member_access_sources + member_access rollup via standard-adapter — DR-023)
 * @calls hardware-adapter (suspendAccess, enableAccess),
 *        standard-adapter (suspendMemberLocationSources, restoreMemberLocationSources)
 * @exports suspendLocationMembers(locationId, clientId, targetStatus),
 *          reactivateLocationMembers(locationId, clientId)
 * @dr DR-027, DR-028
 *
 * core/location-lapse.js
 * AccessSync Core Engine — Location Subscription Lapse Handler
 *
 * OB-20: When a location's subscription_status transitions to 'suspended' or 'cancelled',
 * suspend hardware access for all provisioned members at that location.
 *
 * Flow:
 *   1. Resolve client hardware platform + API key
 *   2. Find all members holding an active source row under this location's mappings
 *   3. Call hardwareAdapter.suspendAccess() per member
 *   4. Flip the location's source rows 'active' → 'failed' + rollup member_access
 *      via standardAdapter.suspendMemberLocationSources (OB-257 ruling — mirrors
 *      the payment.failed suspend semantic; source rows preserved for recovery)
 *   5. Log to member_access_log
 *   6. Set locations.subscription_status → target status
 *
 * Reactivation (reactivateLocationMembers) is the inverse: it turns back on exactly the
 * members step 4 marked, via hardwareAdapter.enableAccess — the same call payment.recovered
 * makes — and restores their source rows. Before it existed, reactivation only re-granted
 * members who were still 'active', so everyone the lapse suspended stayed locked out.
 *
 * Layer: Core Engine (Layer 4) — coordinates Standard Adapter writes + Hardware Adapter calls.
 * DR-027: Per-location subscription model.
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const standardAdapter = require('../adapters/standard-adapter');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');
const { getTraceId, getActor } = require('./trace-context');
const { logMemberAccessEvent } = require('./member-access-log');

/**
 * Suspend all active member access at a location.
 * Used when a location's subscription lapses (OB-20).
 *
 * @param {string} locationId        UUID of the location
 * @param {string} clientId          UUID of the client
 * @param {'suspended'|'cancelled'} targetStatus  Status to set on the location
 * @returns {{ suspended: number, skipped: number, errors: string[] }}
 */
async function suspendLocationMembers(locationId, clientId, targetStatus = 'suspended') {
  if (!['suspended', 'cancelled'].includes(targetStatus)) {
    throw new Error(`[LocationLapse] Invalid targetStatus: ${targetStatus}`);
  }

  // 1. Resolve client + location context via connector_subscriptions + billing_subscriptions
  const { platform, enc_key, location_name, current_status } = await _resolveLocationContext(clientId, locationId);

  if (current_status === 'cancelled') {
    log.info('location.already_cancelled', { locationId, location: location_name });
    return { suspended: 0, skipped: 0, errors: [] };
  }

  const apiKey = enc_key ? decryptApiKey(enc_key) : null; // DR-028
  if (!apiKey) throw new Error(`[LocationLapse] No API key available for client ${clientId}`);

  // 2. Find members holding an active source row under this location's mappings.
  // S-11/DR-046: location membership lives on member_access_sources.mapping_id →
  // plan_mappings.location_id. (The pre-S-11 join on pm.client_id alone matched
  // every active member of the client, not just this location's members.)
  const membersResult = await db.query(
    `SELECT DISTINCT
            ma.id               AS member_id,
            ma.hardware_user_id,
            ma.platform_member_id
     FROM   member_access ma
     JOIN   member_access_sources mas ON mas.access_id = ma.id AND mas.status = 'active'
     JOIN   plan_mappings pm ON pm.id = mas.mapping_id AND pm.location_id = $1
     WHERE  ma.client_id = $2
       AND  ma.status IN ('active', 'in_flight')`,
    [locationId, clientId]
  );

  const rows = membersResult.rows;
  if (!rows.length) {
    log.info('location.no_active_members', { locationId, location: location_name });
    await _setLocationStatus(locationId, targetStatus);
    return { suspended: 0, skipped: 0, errors: [] };
  }

  const errors = [];
  let suspended = 0;
  let skipped   = 0;

  // 3–5. Suspend each member
  for (const row of rows) {
    try {
      if (row.hardware_user_id) {
        await hardwareAdapter.suspendAccess(
          platform, apiKey, row.hardware_user_id,
          `Location subscription lapsed on ${new Date().toISOString()}`,
          { clientId }
        );
      } else {
        log.warn('location.no_hardware_user', { memberId: row.member_id });
        skipped++;
      }

      // OB-257: 'disabled' is a legacy enum value (s11.sql translated it away;
      // the OB-244 CHECK constraint rejects it). The suspend write is now the
      // location-scoped source-row flip + DR-046 rollup, routed through L3.
      await standardAdapter.suspendMemberLocationSources(row.member_id, clientId, locationId);

      // created_at uses the DB column default (CURRENT_TIMESTAMP) — equivalent to NOW().
      await logMemberAccessEvent({
        memberId: row.member_id,
        clientId,
        eventType: 'location_suspended',
        credentialType: 'location_lapse',
      });

      suspended++;
    } catch (err) {
      log.error('location.suspend_member_failed', { memberId: row.member_id }, err);
      errors.push(`${row.platform_member_id}: ${err.message}`);
    }
  }

  // 6. Update location subscription_status
  await _setLocationStatus(locationId, targetStatus);

  log.info('location.lapse_complete', { location: location_name, suspended, skipped, errors: errors.length });
  return { suspended, skipped, errors };
}

async function _setLocationStatus(locationId, status) {
  // billing_subscriptions.status is now the canonical subscription state.
  // UPSERT in case no bs row exists yet (rare — most flows create it during onboarding).
  await db.query(
    `UPDATE billing_subscriptions SET status = $1, updated_at = NOW()
      WHERE location_id = $2`,
    [status, locationId]
  );
}

/**
 * Turn back on the members a lapse of this location suspended. Called by both
 * reactivation endpoints (operator portal and owner hub) after the location's
 * billing row is set back to 'active'.
 *
 * "Suspended by the lapse" = holds a source row under this location's mappings that
 * is still 'failed' with the lapse reason (standardAdapter.LOCATION_LAPSE_REASON).
 * Per member:
 *   - Wix payment failed after the lapse ('disabled' logged later than the lapse
 *     flipped their rows): left off — Wix is the truth on declines, and
 *     payment.recovered restores them. Counted in `held`.
 *   - access row in a state this path must not overwrite (in_flight = a queue job
 *     holds the person; pending_identity / recovery_pending): left off and alerted.
 *   - Kisi user: hardwareAdapter.enableAccess (the payment.recovered call), then the
 *     source rows are restored. No Kisi user (day-pass only): rows restored only.
 *   - Any failure: rows stay marked, so re-running the activate picks the member up
 *     again; the operator gets a location_reactivate_failed alert.
 *
 * Throws only when it cannot run at all (location/connector/API key missing) —
 * after alerting, since every caller is fire-and-forget.
 *
 * @param {string} locationId  UUID of the location
 * @param {string} clientId    UUID of the client
 * @returns {Promise<{ restored: number, skipped: number, held: number, errors: string[] }>}
 */
async function reactivateLocationMembers(locationId, clientId) {
  let ctx;
  let apiKey;
  try {
    ctx = await _resolveLocationContext(clientId, locationId);
    apiKey = ctx.enc_key ? decryptApiKey(ctx.enc_key) : null; // DR-028
    if (!apiKey) throw new Error(`[LocationLapse] No API key available for client ${clientId}`);
  } catch (err) {
    log.error('location.reactivate_failed', { clientId, locationId }, err);
    await _alertReactivateFailed(clientId, `location_id=${locationId} reason=no_hardware_context`);
    throw err;
  }
  const { platform, location_name } = ctx;

  // When the lapse happened, per member: its 'location_suspended' log row (written right
  // after the flip); the lapse-marked rows' updated_at only if that log write was lost.
  const membersResult = await db.query(
    `SELECT ma.id               AS member_id,
            ma.hardware_user_id,
            ma.platform_member_id,
            ma.status           AS access_status,
            EXISTS (
              SELECT 1 FROM member_access_log mal
               WHERE mal.member_id = ma.id
                 AND mal.client_id = ma.client_id
                 AND mal.event_type = 'disabled'
                 AND mal.created_at > COALESCE(
                       (SELECT MAX(ls.created_at) FROM member_access_log ls
                         WHERE ls.member_id = ma.id
                           AND ls.client_id = ma.client_id
                           AND ls.event_type = 'location_suspended'),
                       lapse.rows_updated_at)
            ) AS payment_failed_since_lapse
     FROM member_access ma
     JOIN LATERAL (
       SELECT MIN(mas.updated_at) AS rows_updated_at
         FROM member_access_sources mas
         JOIN plan_mappings pm ON pm.id = mas.mapping_id AND pm.location_id = $1
        WHERE mas.access_id = ma.id
          AND mas.client_id = $2
          AND mas.status = 'failed'
          AND mas.failure_reason = $3
     ) lapse ON lapse.rows_updated_at IS NOT NULL
     WHERE ma.client_id = $2
       AND ma.status NOT IN ('deleted', 'removing')`,
    [locationId, clientId, standardAdapter.LOCATION_LAPSE_REASON]
  );

  const errors = [];
  let restored = 0;
  let skipped  = 0;
  let held     = 0;

  for (const row of membersResult.rows) {
    const ref = `member_id=${row.member_id} kisi_user_id=${row.hardware_user_id || 'none'} location_id=${locationId}`;

    if (row.payment_failed_since_lapse) {
      log.warn('location.reactivate_member_held', {
        clientId, locationId, memberId: row.member_id, reason: 'payment_failed_since_lapse',
      });
      held++;
      continue;
    }

    if (!['active', 'inactive'].includes(row.access_status)) {
      log.warn('location.reactivate_member_busy', {
        clientId, locationId, memberId: row.member_id, accessStatus: row.access_status,
      });
      errors.push(`${row.platform_member_id}: member is ${row.access_status}`);
      await _alertReactivateFailed(clientId, ref);
      continue;
    }

    try {
      if (row.hardware_user_id) {
        await hardwareAdapter.enableAccess(platform, apiKey, row.hardware_user_id, { clientId });
      } else {
        log.warn('location.no_hardware_user', { memberId: row.member_id });
        skipped++;
      }

      await standardAdapter.restoreMemberLocationSources(row.member_id, clientId, locationId);

      await logMemberAccessEvent({
        memberId: row.member_id,
        clientId,
        eventType: 'location_reactivated',
        credentialType: 'location_lapse',
      });

      restored++;
    } catch (err) {
      log.error('location.reactivate_member_failed', { clientId, locationId, memberId: row.member_id }, err);
      errors.push(`${row.platform_member_id}: ${err.message}`);
      await _alertReactivateFailed(clientId, ref);
    }
  }

  log.info('location.reactivate_complete', {
    clientId, locationId, location: location_name, restored, skipped, held, errors: errors.length,
  });
  return { restored, skipped, held, errors };
}

// Shared by lapse and reactivation: the client's hardware connector + the location's billing state.
async function _resolveLocationContext(clientId, locationId) {
  const ctxResult = await db.query(
    `SELECT cs.hardware_platform,
            cs.hardware_api_key                 AS enc_key,
            l.name                              AS location_name,
            COALESCE(bs.status, 'inactive')     AS current_status
     FROM locations l
     JOIN clients c ON c.id = $1
     JOIN connector_subscriptions cs ON cs.client_id = $1 AND cs.status = 'active'
     LEFT JOIN billing_subscriptions bs ON bs.location_id = l.id AND bs.client_id = l.client_id
     WHERE l.id = $2 AND l.client_id = $1
     LIMIT 1`,
    [clientId, locationId]
  );

  if (!ctxResult.rows.length) {
    throw new Error(`[LocationLapse] Location ${locationId} not found for client ${clientId}`);
  }
  const row = ctxResult.rows[0];
  return { ...row, platform: row.hardware_platform || 'kisi' };
}

/**
 * One unresolved alert per (client, ref): re-running the activate after a failure
 * does not stack duplicates. Copy: core/operator-email-templates.js describeConfigAlert.
 * Never throws — the reactivation loop must reach every member.
 */
async function _alertReactivateFailed(clientId, hardwareRef) {
  try {
    const actor = getActor() || {};
    await db.query(
      `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
       SELECT $1::uuid, 'location_reactivate_failed', $2::varchar, $3::varchar, $4::varchar, $5::varchar
       WHERE NOT EXISTS (
         SELECT 1 FROM config_alert_log
          WHERE client_id = $1::uuid
            AND alert_type = 'location_reactivate_failed'
            AND hardware_ref = $2::varchar
            AND resolved_at IS NULL
       )`,
      [clientId, String(hardwareRef).slice(0, 255), getTraceId() || null, actor.type || 'system', actor.id || 'location-lapse']
    );
  } catch (err) {
    log.warn('location.reactivate_alert_failed', { clientId }, err);
  }
}

module.exports = { suspendLocationMembers, reactivateLocationMembers };
