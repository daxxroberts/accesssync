/**
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

class GrantRevokeLogic {

  /**
   * Executes the hardware grant for a member.
   * Called by queue-worker after Standard Adapter resolves identity and acquires lock.
   *
   * @param {string} tenantId
   * @param {string} memberId         member_identity.id
   * @param {string} hardwareUserId   resolved hardware platform user ID
   * @param {Object} mapping          from planMappingResolver.resolve()
   * @param {Object} wixEvent         standard event object
   * @returns {string} roleId         hardware role assignment ID — passed to completeGrant()
   */
  async processGrant(tenantId, memberId, hardwareUserId, mapping, wixEvent) {
    console.log(`[Grant] Assigning role to user ${hardwareUserId} in group ${mapping.hardwareGroupId}`);

    const apiKey = process.env.KISI_API_KEY_MOCK;

    const roleId = await hardwareAdapter.assignRole(
      mapping.hardwarePlatform, apiKey, hardwareUserId, mapping.hardwareGroupId
    );

    await db.query(
      `INSERT INTO member_access_log (member_id, client_id, event_type)
       VALUES ($1, $2, 'provisioned')`,
      [memberId, tenantId]
    );

    console.log(`[Grant] Success for member ${wixEvent.platformMemberId}, role ${roleId}`);
    return String(roleId);
  }

  /**
   * Executes the hardware revoke for a member.
   * Called by queue-worker after Standard Adapter resolves lock and reads existing state.
   *
   * Three paths based on eventType:
   *   payment.failed       → Suspend (preserve role for fast recovery) → returns 'disabled'
   *   plan/booking cancel  → Remove role assignment (preserve user)    → returns 'revoked'
   *   member.deleted       → Delete user from hardware org entirely     → returns 'deleted'
   *
   * @param {string} tenantId
   * @param {string} memberId
   * @param {string} hardwareUserId
   * @param {string} roleAssignmentId
   * @param {string} eventType
   * @param {Object} wixEvent
   * @returns {string} targetStatus   passed to standardAdapter.completeRevoke()
   */
  async processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentId, hardwarePlatform, eventType, wixEvent) {
    console.log(`[Revoke] Processing revoke (${eventType}) for tenant ${tenantId}, member ${wixEvent.platformMemberId}`);

    const apiKey = process.env.KISI_API_KEY_MOCK;

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
        if (roleAssignmentId) {
          await hardwareAdapter.removeRole(hardwarePlatform, apiKey, roleAssignmentId);
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
        // Flag for operator review
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
           VALUES ($1, 'member_deleted_review', $2)`,
          [tenantId, hardwareUserId || wixEvent.platformMemberId]
        );
        return 'deleted';
      }

      default:
        console.error(`[Revoke] Unknown event type: ${eventType}`);
        return 'failed';
    }
  }
}

module.exports = new GrantRevokeLogic();
