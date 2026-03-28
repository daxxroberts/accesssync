/**
 * grant-revoke.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Executes the idempotent core grant and revoke logic
 * - Enforces the `in_flight` state lock to block race conditions (DR-011)
 * - Performs identity resolution: DB cache first, Kisi API fallback
 * - Calls appropriate Kisi adapter methods
 * - Commits all state changes to DB with full audit trail
 */

const db = require('../db');
const kisiAdapter = require('../adapters/kisi-adapter');
const planMappingResolver = require('./plan-mapping-resolver');

class GrantRevokeLogic {

  /**
   * Flow A: New Member Grant
   * Maps to FLOW_New_Member_Grant.md
   *
   * Sequence:
   *   1. Resolve plan → hardware group mapping
   *   2. Acquire in_flight lock (atomic transaction)
   *   3. Resolve Kisi identity (DB cache → API fallback)
   *   4. Assign role in Kisi
   *   5. Commit success state + audit log
   *   Error path: release in_flight lock, log failure
   */
  async processGrant(tenantId, wixEvent) {
    console.log(`[Grant] Processing grant for tenant ${tenantId}, member ${wixEvent.platformMemberId}`);

    // Step 1: Resolve hardware tier from plan mapping
    const mapping = await planMappingResolver.resolve(tenantId, wixEvent.planId);
    if (!mapping) return; // Unmapped plan — already alerted in resolver

    const apiKey = process.env.KISI_API_KEY_MOCK;
    let memberId = null;

    try {
      // Step 2: Get or create identity record; check + set in_flight lock (atomic)
      const dbClient = await db.getClient();
      try {
        await dbClient.query('BEGIN');

        // UPSERT identity record — creates on first encounter, touches updated_at on replay
        // Email/name not stored here — fetched from Wix on-demand (data minimization decision)
        const identityResult = await dbClient.query(
          `INSERT INTO member_identity
           (client_id, platform_member_id, hardware_platform, source_platform, source_tag)
           VALUES ($1, $2, $3, $4, 'accesssync')
           ON CONFLICT (client_id, source_platform, platform_member_id)
           DO UPDATE SET updated_at = NOW()
           RETURNING id, hardware_user_id`,
          [tenantId, wixEvent.platformMemberId, mapping.hardwarePlatform,
           wixEvent.sourcePlatform || 'wix']
        );
        memberId = identityResult.rows[0].id;

        // Enforce in_flight lock (DR-011)
        const stateResult = await dbClient.query(
          'SELECT status FROM member_access_state WHERE member_id = $1',
          [memberId]
        );
        if (stateResult.rows.length > 0 && stateResult.rows[0].status === 'in_flight') {
          throw new Error(`in_flight lock active — concurrent modification rejected for member ${wixEvent.platformMemberId}`);
        }

        // Set in_flight
        await dbClient.query(
          `INSERT INTO member_access_state (member_id, client_id, status)
           VALUES ($1, $2, 'in_flight')
           ON CONFLICT (member_id) DO UPDATE SET status = 'in_flight', updated_at = NOW()`,
          [memberId, tenantId]
        );

        await dbClient.query('COMMIT');
      } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
      } finally {
        dbClient.release();
      }

      // Step 3: Resolve Kisi user identity (DB cache → Kisi API)
      const hardwareUserId = await this._resolveIdentity(memberId, wixEvent.email, wixEvent.name, apiKey);

      // Step 4: Assign role in Kisi
      console.log(`[Grant] Assigning role to user ${hardwareUserId} in group ${mapping.hardwareGroupId}`);
      const roleId = await kisiAdapter.assignRole(apiKey, hardwareUserId, mapping.hardwareGroupId);

      // Step 5: Commit success
      await db.query(
        `UPDATE member_access_state
         SET status = 'active', role_assignment_id = $1, provisioned_at = NOW(), updated_at = NOW()
         WHERE member_id = $2`,
        [String(roleId), memberId]
      );
      await db.query(
        `INSERT INTO member_access_log (member_id, client_id, event_type)
         VALUES ($1, $2, 'provisioned')`,
        [memberId, tenantId]
      );
      console.log(`[Grant] Success for member ${wixEvent.platformMemberId}, role ${roleId}`);

    } catch (error) {
      console.error(`[Grant] Failed for ${wixEvent.platformMemberId}:`, error.message);

      // Release in_flight lock — must not leave member permanently blocked
      if (memberId) {
        await db.query(
          `UPDATE member_access_state SET status = 'failed', updated_at = NOW() WHERE member_id = $1`,
          [memberId]
        ).catch(e => console.error('[Grant] Failed to release in_flight lock:', e.message));
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type, error_code)
           VALUES ($1, $2, 'provisioning_failed', 'GRANT_001')`,
          [memberId, tenantId]
        ).catch(e => console.error('[Grant] Failed to write failure log:', e.message));
      }

      // BUG-01 fix: throw so BullMQ retries. Dead-letter flow handled by queue-worker worker.on('failed').
      throw error;
    }
  }

  /**
   * Flow B: Revoke Access
   * Maps to FLOW_Revoke.md
   * Three distinct paths based on eventType (DR-011):
   *   payment.failed       → Suspend (preserve role for fast recovery)
   *   plan/booking cancel  → Remove role assignment (preserve user)
   *   member.deleted       → Delete user from Kisi entirely (permanent)
   */
  async processRevoke(tenantId, eventType, wixEvent) {
    console.log(`[Revoke] Processing revoke (${eventType}) for tenant ${tenantId}, member ${wixEvent.platformMemberId}`);

    const apiKey = process.env.KISI_API_KEY_MOCK;
    let memberId = null;

    try {
      // Step 1: Look up identity and current access state from DB
      const identityResult = await db.query(
        `SELECT id, hardware_user_id
         FROM member_identity
         WHERE client_id = $1 AND source_platform = $2 AND platform_member_id = $3`,
        [tenantId, wixEvent.sourcePlatform || 'wix', wixEvent.platformMemberId]
      );

      if (identityResult.rows.length === 0) {
        console.warn(`[Revoke] No identity record for member ${wixEvent.platformMemberId}. Skipping.`);
        return;
      }

      memberId = identityResult.rows[0].id;
      const hardwareUserId = identityResult.rows[0].hardware_user_id;

      const stateResult = await db.query(
        `SELECT status, role_assignment_id FROM member_access_state WHERE member_id = $1`,
        [memberId]
      );

      if (stateResult.rows.length === 0) {
        console.warn(`[Revoke] No access state for member ${wixEvent.platformMemberId}. Skipping.`);
        return;
      }

      const { status, role_assignment_id: roleAssignmentId } = stateResult.rows[0];

      // Step 2: Enforce in_flight lock (DR-011)
      if (status === 'in_flight') {
        throw new Error(`in_flight lock active — concurrent modification rejected for member ${wixEvent.platformMemberId}`);
      }

      // Step 3: Set in_flight
      await db.query(
        `UPDATE member_access_state SET status = 'in_flight', updated_at = NOW() WHERE member_id = $1`,
        [memberId]
      );

      // Step 4: Execute correct revoke path
      switch (eventType) {

        case 'payment.failed': {
          // Path A: Suspend access, preserve role — fast recovery when payment restored
          await kisiAdapter.suspendAccess(apiKey, hardwareUserId, `Payment failed on ${new Date().toISOString()}`);
          await db.query(
            `UPDATE member_access_state SET status = 'disabled', updated_at = NOW() WHERE member_id = $1`,
            [memberId]
          );
          await db.query(
            `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'disabled')`,
            [memberId, tenantId]
          );
          break;
        }

        case 'plan.cancelled':
        case 'booking.cancelled': {
          // Path B: Remove role assignment, preserve Kisi user record
          if (roleAssignmentId) {
            await kisiAdapter.removeRole(apiKey, roleAssignmentId);
          }
          await db.query(
            `UPDATE member_access_state
             SET status = 'revoked', role_assignment_id = NULL, updated_at = NOW()
             WHERE member_id = $1`,
            [memberId]
          );
          await db.query(
            `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'revoked')`,
            [memberId, tenantId]
          );
          break;
        }

        case 'member.deleted': {
          // Path C: Permanent — delete user from Kisi org entirely
          if (hardwareUserId) {
            await kisiAdapter.deleteUser(apiKey, hardwareUserId);
          }
          await db.query(
            `UPDATE member_access_state SET status = 'deleted', updated_at = NOW() WHERE member_id = $1`,
            [memberId]
          );
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
          break;
        }

        default:
          console.error(`[Revoke] Unknown event type: ${eventType}`);
      }

      console.log(`[Revoke] Success for member ${wixEvent.platformMemberId}, event ${eventType}`);

    } catch (error) {
      console.error(`[Revoke] Failed:`, error.message);

      // Release in_flight lock
      if (memberId) {
        await db.query(
          `UPDATE member_access_state SET status = 'failed', updated_at = NOW() WHERE member_id = $1`,
          [memberId]
        ).catch(e => console.error('[Revoke] Failed to release in_flight lock:', e.message));
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type, error_code)
           VALUES ($1, $2, 'provisioning_failed', 'REVOKE_001')`,
          [memberId, tenantId]
        ).catch(e => console.error('[Revoke] Failed to write failure log:', e.message));
      }

      // BUG-01 fix: throw so BullMQ retries. Dead-letter flow handled by queue-worker worker.on('failed').
      throw error;
    }
  }

  /**
   * 3-Step Identity Resolution Chain
   * Called only from processGrant after the identity record exists in DB.
   *
   * @param {string} memberId       - member_identity.id (UUID)
   * @param {string} email
   * @param {string} name
   * @param {string} apiKey
   * @returns {string} Kisi hardware_user_id
   */
  async _resolveIdentity(memberId, email, name, apiKey) {
    // 1. DB cache check
    const cached = await db.query(
      'SELECT hardware_user_id FROM member_identity WHERE id = $1',
      [memberId]
    );
    if (cached.rows[0]?.hardware_user_id) {
      console.log(`[Identity] DB cache hit for member ${memberId}`);
      return cached.rows[0].hardware_user_id;
    }

    // 2. Look up in Kisi by email
    let kisiId = await kisiAdapter.findUserByEmail(apiKey, email);

    if (kisiId) {
      console.log(`[Identity] Found existing Kisi user: ${kisiId}`);
    } else {
      // 3. Create in Kisi
      console.log(`[Identity] Creating new Kisi user for ${email}`);
      kisiId = await kisiAdapter.createUser(apiKey, email, name);
    }

    // Cache to DB
    await db.query(
      `UPDATE member_identity SET hardware_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [String(kisiId), memberId]
    );

    return String(kisiId);
  }
}

module.exports = new GrantRevokeLogic();
