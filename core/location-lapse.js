/**
 * @file location-lapse.js
 * @layer core/layer4
 * @role subscription-lapse
 * @reads locations, clients, connector_subscriptions, member_access, member_access_sources, plan_mappings
 * @writes member_access_log, billing_subscriptions.status
 *         (member_access_sources + member_access rollup via standard-adapter — DR-023)
 * @calls hardware-adapter (suspendAccess), standard-adapter (suspendMemberLocationSources)
 * @exports suspendLocationMembers(locationId, clientId, targetStatus)
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

  const { hardware_platform, enc_key, location_name, current_status } = ctxResult.rows[0];

  if (current_status === 'cancelled') {
    log.info('location.already_cancelled', { locationId, location: location_name });
    return { suspended: 0, skipped: 0, errors: [] };
  }

  const apiKey = enc_key ? decryptApiKey(enc_key) : null; // DR-028
  if (!apiKey) throw new Error(`[LocationLapse] No API key available for client ${clientId}`);

  const platform = hardware_platform || 'kisi';

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

module.exports = { suspendLocationMembers };
