/**
 * @file plan-door-sync.js
 * @layer core/layer4
 * @role plan-door-sync
 * @reads member_access_sources
 * @writes member_access_sources, config_alert_log
 * @calls hardware-adapter (assignRole, removeRole)
 * @exports OTHER_PLAN_KEEPS_DOOR_SQL, raiseDoorAlert, resolveDoorAlerts, grantMappingGroup, revokeMappingSource
 *
 * One member, one door of one plan: give it (Kisi first, then the row) or take it away (Kisi
 * first, C-4, then the row). Shared by the Plan Mapping page (admin/routes/operator.js — a door
 * added, taken off, remapped, a plan switched off or back on) and the reconcile sweep
 * (core/reconciliation.js — the same change finished for whoever the save missed), so a door
 * change means the same thing whichever of the two makes it.
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { log } = require('./logger');
const { getTraceId, getActor } = require('./trace-context');

// C-4: another plan still grants this member the same door → Kisi is left alone and only this
// plan's row goes. Day passes never hold a door open (a bearer link is not a seat). `mas` is
// the row being taken away.
const OTHER_PLAN_KEEPS_DOOR_SQL = `EXISTS (
         SELECT 1 FROM member_access_sources o
          WHERE o.access_id = mas.access_id AND o.hardware_group_id = mas.hardware_group_id
            AND o.mapping_id IS DISTINCT FROM mas.mapping_id AND o.source_type <> 'day_pass')`;

/**
 * One open alert per member and door. hardware_ref "member_id=<access id> group_id=<id>";
 * core/alert-context.js reads the member_id part to name the member and their location.
 * Never throws.
 */
async function raiseDoorAlert(clientId, alertType, memberId, hardwareGroupId, mappingId) {
  const _actor = getActor() || {};
  await db.query(
    `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, plan_mapping_id, trace_id, actor_type, actor_id)
     SELECT $1::uuid, $2::varchar, $3::varchar, $4::uuid, $5::varchar, $6::varchar, $7::varchar
     WHERE NOT EXISTS (
       SELECT 1 FROM config_alert_log
       WHERE client_id = $1::uuid AND alert_type = $2::varchar
         AND hardware_ref = $3::varchar AND resolved_at IS NULL
     )`,
    [clientId, alertType, `member_id=${memberId} group_id=${hardwareGroupId}`.slice(0, 255), mappingId,
      getTraceId() || null, _actor.type || null, _actor.id || null]
  ).catch(alertErr => log.error('operator.sync.door_alert_failed', { clientId, memberId, alertType }, alertErr));
}

/**
 * The condition behind a member-and-door alert is gone — the door is on (door_grant_failed /
 * door_swap_held) or off (door_removal_failed) now. Same hardware_ref as raiseDoorAlert. Never throws.
 */
async function resolveDoorAlerts(clientId, alertTypes, memberId, hardwareGroupId) {
  try {
    await db.query(
      `UPDATE config_alert_log SET resolved_at = NOW()
        WHERE client_id = $1 AND alert_type = ANY($2::varchar[]) AND hardware_ref = $3 AND resolved_at IS NULL`,
      [clientId, alertTypes, `member_id=${memberId} group_id=${hardwareGroupId}`.slice(0, 255)]
    );
  } catch (err) {
    log.warn('operator.sync.door_alert_resolve_failed', { clientId, memberId, hardwareGroupId }, err);
  }
}

/**
 * Gives one member one door of this plan: Kisi first, then the row. Returns true when the door
 * is on in Kisi (a failed row write after that is only logged — the member can get in). Never
 * throws and never alerts: the caller knows whether a failure leaves the member with no door
 * from this plan (door_swap_held) or only without the new one (door_grant_failed).
 * ctx = { clientId, mappingId, sourcePlanId, hardwarePlatform, apiKey }.
 */
async function grantMappingGroup(ctx, member, hardwareGroupId, reason) {
  const { clientId, mappingId, sourcePlanId, hardwarePlatform, apiKey } = ctx;
  const memberId = member.member_id;
  let roleId;
  try {
    roleId = await hardwareAdapter.assignRole(hardwarePlatform, apiKey, member.hardware_user_id, hardwareGroupId);
  } catch (err) {
    log.error('operator.sync.grant_failed', { clientId, mappingId, memberId, hardwareGroupId, reason, kisiDone: false }, err);
    return false;
  }
  try {
    // OB-203: source_plan_id is part of the canonical UNIQUE (client_id, access_id, source_type,
    // source_plan_id, hardware_group_id) ON CONFLICT matches on. S-11/A9: client_id + 'active'.
    await db.query(
      `INSERT INTO member_access_sources
         (client_id, access_id, source_type, source_plan_id, mapping_id, hardware_group_id,
          role_assignment_id, status, provisioned_at)
       VALUES ($1, $2, 'plan', $3, $4, $5, $6, 'active', NOW())
       ON CONFLICT (client_id, access_id, source_type, source_plan_id, hardware_group_id) DO UPDATE
         SET role_assignment_id = EXCLUDED.role_assignment_id,
             status = 'active',
             updated_at = NOW()`,
      [clientId, memberId, sourcePlanId, mappingId, hardwareGroupId, String(roleId)]
    );
    log.info('operator.sync.granted', { memberId, hardwareGroupId, reason });
  } catch (err) {
    log.error('operator.sync.grant_failed', { clientId, mappingId, memberId, hardwareGroupId, reason, kisiDone: true }, err);
  }
  return true;
}

/**
 * Takes one door away from one member because a plan mapping stopped granting it (the door
 * was taken off the plan, or the plan was switched off). Kisi FIRST, then the source row —
 * the order core/grant-revoke.js uses for a cancelled plan (2026-10-19 review H1). The other
 * way round, a Kisi failure left no row behind: the database said the member had lost the
 * door, Kisi still opened it, and nothing could find them again.
 *
 *   - C-4 (OTHER_PLAN_KEEPS_DOOR_SQL, re-checked here so a row another save already took away
 *     is skipped): Kisi is left alone when another plan grants the same door.
 *   - A row with no role assignment never reached Kisi — there is nothing to remove, the row goes.
 *   - Kisi fails → the row STAYS (it is still true: they can get in) and the gym gets a
 *     door_removal_failed alert naming the member. removeRole is 404-idempotent, so a later
 *     attempt that repeats it is safe.
 *
 * `row` comes from rowsLosingDoors (never a day-pass row). Returns true on success. Never throws.
 */
async function revokeMappingSource(ctx, row, reason) {
  const { clientId, mappingId, hardwarePlatform, apiKey } = ctx;
  const { source_id: sourceId, member_id: memberId, hardware_group_id: hardwareGroupId, role_assignment_id: raId } = row;
  let kisiDone = false;
  try {
    const live = await db.query(
      `SELECT ${OTHER_PLAN_KEEPS_DOOR_SQL} AS door_kept
       FROM member_access_sources mas WHERE mas.id = $1 AND mas.client_id = $2`,
      [sourceId, clientId]
    );
    if (!live.rows.length) return true; // already taken away (a save that overlapped this one)
    if (live.rows[0].door_kept) {
      log.info('operator.sync.revoke_skipped', { memberId, hardwareGroupId, reason: 'other_mapping_grants' });
    } else if (raId) {
      await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
      log.info('operator.sync.revoked', { memberId, hardwareGroupId, reason });
    }
    kisiDone = true;
    await db.query('DELETE FROM member_access_sources WHERE id = $1 AND client_id = $2', [sourceId, clientId]);
    return true;
  } catch (err) {
    log.error('operator.sync.revoke_failed', { clientId, mappingId, memberId, hardwareGroupId, reason, kisiDone }, err);
    if (kisiDone) return true; // the door is gone; only the bookkeeping row is left over
    await raiseDoorAlert(clientId, 'door_removal_failed', memberId, hardwareGroupId, mappingId);
    return false;
  }
}

module.exports = {
  OTHER_PLAN_KEEPS_DOOR_SQL,
  raiseDoorAlert,
  resolveDoorAlerts,
  grantMappingGroup,
  revokeMappingSource,
};
