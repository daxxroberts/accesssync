/**
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
 *   4. Update member_access_state → 'disabled'
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

  // 1. Resolve client + location context
  const ctxResult = await db.query(
    `SELECT c.hardware_platform,
            c.kisi_api_key   AS client_key,
            l.kisi_api_key   AS location_key,
            l.name           AS location_name,
            l.subscription_status AS current_status
     FROM clients c
     JOIN locations l ON l.id = $2 AND l.client_id = $1
     WHERE c.id = $1`,
    [clientId, locationId]
  );

  if (!ctxResult.rows.length) {
    throw new Error(`[LocationLapse] Location ${locationId} not found for client ${clientId}`);
  }

  const { hardware_platform, client_key, location_key, location_name, current_status } = ctxResult.rows[0];

  if (current_status === 'cancelled') {
    console.log(`[LocationLapse] Location ${location_name} already cancelled — skipping member suspension`);
    return { suspended: 0, skipped: 0, errors: [] };
  }

  const encKey = location_key || client_key;
  const apiKey = encKey ? decryptApiKey(encKey) : process.env.KISI_API_KEY_MOCK;
  if (!apiKey) throw new Error(`[LocationLapse] No API key available for client ${clientId}`);

  const platform = hardware_platform || 'kisi';

  // 2. Find all active members with role assignments at this location
  const membersResult = await db.query(
    `SELECT DISTINCT
            mi.id              AS member_id,
            mi.hardware_user_id,
            mi.platform_member_id,
            mas.status         AS current_access_status
     FROM   member_role_assignments mra
     JOIN   plan_mappings pm  ON pm.id = mra.mapping_id AND pm.location_id = $1
     JOIN   member_identity  mi  ON mi.id = mra.member_id  AND mi.client_id = $2
     JOIN   member_access_state mas ON mas.member_id = mi.id
     WHERE  mas.status IN ('active', 'pending_sync', 'in_flight')`,
    [locationId, clientId]
  );

  const rows = membersResult.rows;
  if (!rows.length) {
    console.log(`[LocationLapse] No active members at location ${location_name} (${locationId})`);
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
        console.warn(`[LocationLapse] Member ${row.member_id} has no hardware_user_id — skipping hardware call`);
        skipped++;
      }

      await db.query(
        `UPDATE member_access_state
         SET    status = 'disabled', updated_at = NOW()
         WHERE  member_id = $1`,
        [row.member_id]
      );

      await db.query(
        `INSERT INTO member_access_log (member_id, client_id, event_type, credential_type, created_at)
         VALUES ($1, $2, 'location_suspended', 'location_lapse', NOW())`,
        [row.member_id, clientId]
      );

      suspended++;
    } catch (err) {
      console.error(`[LocationLapse] Failed to suspend member ${row.member_id}:`, err.message);
      errors.push(`${row.platform_member_id}: ${err.message}`);
    }
  }

  // 6. Update location subscription_status
  await _setLocationStatus(locationId, targetStatus);

  console.log(
    `[LocationLapse] ${location_name}: ${suspended} suspended, ${skipped} skipped, ${errors.length} errors`
  );
  return { suspended, skipped, errors };
}

async function _setLocationStatus(locationId, status) {
  await db.query(
    `UPDATE locations SET subscription_status = $1 WHERE id = $2`,
    [status, locationId]
  );
}

module.exports = { suspendLocationMembers };
