/**
 * @file grant-revoke.js
 * @layer core/layer4
 * @role provisioning
 * @reads plan_mappings, member_identity, member_access_log, member_role_assignments
 * @writes member_access_log, config_alert_log, diagnostic_log (via logger)
 * @calls hardware-adapter
 * @exports processGrant, processRevoke
 * @dr DR-022, DR-026
 *
 * grant-revoke.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Pure grant and revoke logic
 * - Hardware calls via hardwareAdapter (Layer 5) — never calls Kisi/Seam directly
 * - Audit trail writes to member_access_log and config_alert_log
 * - Returns targetStatus to queue-worker so Standard Adapter (Layer 3) can write state
 *
 * Does NOT write to member_identity or member_access_state (DR-023 — Standard Adapter owns these).
 * Identity is resolved before this module is called. Lock is acquired before. State is written after.
 */

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const planMappingResolver = require('./plan-mapping-resolver');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');

class GrantRevokeLogic {

  /**
   * Executes the hardware grant for a member across all active plan mappings.
   * Called by queue-worker after Standard Adapter resolves identity and acquires lock.
   *
   * @param {string} tenantId
   * @param {string} memberId         member_identity.id
   * @param {string} hardwareUserId   resolved hardware platform user ID
   * @param {Array}  mappings         from planMappingResolver.resolve() — array of active mappings
   * @param {Object} wixEvent         standard event object
   * @returns {Array} assignments     [{ mappingId, roleAssignmentId }] — passed to completeGrant()
   */
  async processGrant(tenantId, memberId, hardwareUserId, mappings, wixEvent) {
    const assignments = [];

    for (const mapping of mappings) {
      const apiKey = mapping.apiKey;
      log.info('grant.role.assigning', {
        tenantId, memberId, hardwareUserId,
        hardwareGroupId: mapping.hardwareGroupId,
        mappingId: mapping.mappingId,
      });
      const roleId = await hardwareAdapter.assignRole(
        mapping.hardwarePlatform, apiKey, hardwareUserId, mapping.hardwareGroupId
      );
      assignments.push({
        mappingId:        mapping.mappingId,
        roleAssignmentId: String(roleId),
        hardwareGroupId:  mapping.hardwareGroupId,
        sourcePlanId:     wixEvent.planId || null,
        sourceType:       wixEvent.eventType === 'booking.confirmed' ? 'booking' : 'plan',
      });
    }

    await db.query(
      `INSERT INTO member_access_log (member_id, client_id, event_type)
       VALUES ($1, $2, 'provisioned')`,
      [memberId, tenantId]
    );

    return assignments;
  }

  /**
   * Looks up and decrypts the client-level hardware API key for revoke operations.
   */
  async _getClientApiKey(tenantId) {
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [tenantId]);
    const enc = result.rows[0]?.hardware_api_key;
    if (enc) return decryptApiKey(enc);
    return null;
  }

  async processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform, eventType, wixEvent) {
    log.info('revoke.start', {
      tenantId, memberId, eventType,
      platformMemberId: wixEvent.platformMemberId,
    });

    const apiKey = await this._getClientApiKey(tenantId);

    switch (eventType) {

      case 'payment.failed': {
        await hardwareAdapter.suspendAccess(
          hardwarePlatform, apiKey, hardwareUserId,
          `Payment failed on ${new Date().toISOString()}`
        );
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'disabled')`,
          [memberId, tenantId]
        );
        return 'disabled';
      }

      case 'plan.cancelled':
      case 'booking.cancelled': {
        const sourceType = eventType === 'booking.cancelled' ? 'booking' : 'plan';
        const planId = wixEvent.planId || null;

        const raWithGroups = await db.query(
          `SELECT mra.role_assignment_id, mra.hardware_group_id
           FROM member_role_assignments mra
           WHERE mra.member_id = $1`,
          [memberId]
        );

        for (const { role_assignment_id: raId, hardware_group_id: groupId } of raWithGroups.rows) {
          await db.query(
            `DELETE FROM member_access_sources
             WHERE member_id = $1
               AND hardware_group_id = $2
               AND source_type = $3
               AND COALESCE(source_plan_id, '') = COALESCE($4, '')`,
            [memberId, groupId, sourceType, planId]
          );

          const remaining = await db.query(
            `SELECT COUNT(*) AS cnt FROM member_access_sources
             WHERE member_id = $1 AND hardware_group_id = $2`,
            [memberId, groupId]
          );

          const remainingCount = parseInt(remaining.rows[0].cnt, 10);
          if (remainingCount > 0) {
            log.info('revoke.group.skipped', {
              tenantId, memberId, hardwareGroupId: groupId, remainingSources: remainingCount,
            });
          } else {
            await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
          }
        }

        // Fallback: legacy member with no member_role_assignments rows
        if (raWithGroups.rows.length === 0 && roleAssignmentIds.length > 0) {
          log.warn('revoke.legacy_fallback', {
            tenantId, memberId, roleAssignmentCount: roleAssignmentIds.length,
          });
          for (const raId of roleAssignmentIds) {
            await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
          }
        }

        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'revoked')`,
          [memberId, tenantId]
        );
        return 'revoked';
      }

      case 'member.deleted': {
        if (hardwareUserId) {
          await hardwareAdapter.deleteUser(hardwarePlatform, apiKey, hardwareUserId);
        }
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'deleted')`,
          [memberId, tenantId]
        );
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
           VALUES ($1, 'member_deleted_review', $2)`,
          [tenantId, hardwareUserId || wixEvent.platformMemberId]
        );
        return 'deleted';
      }

      default: {
        const err = new Error(`Unknown revoke event type: ${eventType}`);
        err.code = 'REVOKE_UNKNOWN_EVENT';
        log.error('revoke.unknown_event_type', { tenantId, memberId, eventType }, err);
        throw err;
      }
    }
  }
}

module.exports = new GrantRevokeLogic();
