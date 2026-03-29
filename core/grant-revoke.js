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
const { decryptApiKey } = require('./crypto-utils');

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
      // DR-028: apiKey resolved per-mapping by plan-mapping-resolver (location override || client default)
      const apiKey = mapping.apiKey;
      console.log(`[Grant] Assigning role to user ${hardwareUserId} in group ${mapping.hardwareGroupId}`);
      const roleId = await hardwareAdapter.assignRole(
        mapping.hardwarePlatform, apiKey, hardwareUserId, mapping.hardwareGroupId
      );
      assignments.push({ mappingId: mapping.mappingId, roleAssignmentId: String(roleId) });
    }

    await db.query(
      `INSERT INTO member_access_log (member_id, client_id, event_type)
       VALUES ($1, $2, 'provisioned')`,
      [memberId, tenantId]
    );

    console.log(`[Grant] Success for member ${wixEvent.platformMemberId}, ${assignments.length} role(s) assigned`);
    return assignments;
  }

  /**
   * Executes the hardware revoke for a member.
   * Called by queue-worker after Standard Adapter resolves lock and reads existing state.
   *
   * Three paths based on eventType:
   *   payment.failed       → Suspend (preserve roles for fast recovery) → returns 'disabled'
   *   plan/booking cancel  → Remove all role assignments (preserve user) → returns 'revoked'
   *   member.deleted       → Delete user from hardware org entirely      → returns 'deleted'
   *
   * @param {string} tenantId
   * @param {string} memberId
   * @param {string} hardwareUserId
   * @param {Array}  roleAssignmentIds  all active role assignment IDs for this member
   * @param {string} hardwarePlatform
   * @param {string} eventType
   * @param {Object} wixEvent
   * @returns {string} targetStatus   passed to standardAdapter.completeRevoke()
   */
  /**
   * Looks up and decrypts the client-level Kisi API key for revoke operations.
   * Revokes are org-level operations — client key is correct for all single-org operators.
   * Multi-org per-location revoke is a future enhancement (post V1).
   */
  async _getClientApiKey(tenantId) {
    const result = await db.query('SELECT kisi_api_key FROM clients WHERE id = $1', [tenantId]);
    const enc = result.rows[0]?.kisi_api_key;
    if (enc) return decryptApiKey(enc);
    return process.env.KISI_API_KEY_MOCK; // fallback: remove after all clients have DB keys
  }

  async processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform, eventType, wixEvent) {
    console.log(`[Revoke] Processing revoke (${eventType}) for tenant ${tenantId}, member ${wixEvent.platformMemberId}`);

    const apiKey = await this._getClientApiKey(tenantId);

    switch (eventType) {

      case 'payment.failed': {
        // Suspend the user account — all role assignments preserved for fast recovery
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
        // Remove every role assignment the member holds
        for (const raId of roleAssignmentIds) {
          await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
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
