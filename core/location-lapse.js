/**
 * @file location-lapse.js
 * @layer core/layer4
 * @role subscription-lapse
 * @reads locations, clients, connector_subscriptions, member_access, plan_mappings
 * @writes member_access, member_access_log, locations.subscription_status
 * @calls hardware-adapter (suspendAccess)
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
 *   2. Find all active members with role assignments tied to this location
 *   3. Call hardwareAdapter.suspendAccess() per member
 *   4. Update member_access.status → 'disabled'
 *   5. Log to member_access_log
 *   6. Set locations.subscription_status → target status
 *
 * Layer: Core Engine (Layer 4) — coordinates Standard Adapter writes + Hardware Adapter calls.
 * DR-027: Per-location subscription model.
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');
const { getTraceId, getActor } = require('./trace-context');

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

  // 1. Resolve client + location context via connector_subscriptions
  const ctxResult = await db.query(
    `SELECT cs.hardware_platform,
            cs.hardware_api_key  AS enc_key,
            l.name               AS location_name,
            l.subscription_status AS current_status
     FROM locations l
     JOIN clients c ON c.id = $1
     JOIN connector_subscriptions cs ON cs.client_id = $1 AND cs.status = 'active'
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

  // 2. Find all active members at this location via member_access (new schema)
  const membersResult = await db.query(
    `SELECT DISTINCT
            ma.id               AS member_id,
            ma.hardware_user_id,
            ma.platform_member_id,
            ma.status           AS current_access_status
     FROM   member_access ma
     JOIN   plan_mappings pm ON pm.client_id = ma.client_id AND pm.location_id = $1
     WHERE  ma.client_id = $2
       AND  ma.status IN ('active', 'pending_sync', 'in_flight')`,
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
        await hardwareAdapter.suspendAccess(platform, apiKey, row.hardware_user_id);
      } else {
        log.warn('location.no_hardware_user', { memberId: row.member_id });
        skipped++;
      }

      await db.query(
        `UPDATE member_access
         SET    status = 'disabled', updated_at = NOW()
         WHERE  id = $1`,
        [row.member_id]
      );

      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO member_access_log (member_id, client_id, event_type, credential_type, created_at, trace_id, actor_type, actor_id)
         VALUES ($1, $2, 'location_suspended', 'location_lapse', NOW(), $3, $4, $5)`,
        [row.member_id, clientId, getTraceId() || null, _actor.type || null, _actor.id || null]
      );

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
  await db.query(
    `UPDATE locations SET subscription_status = $1 WHERE id = $2`,
    [status, locationId]
  );
}

module.exports = { suspendLocationMembers };
