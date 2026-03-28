/**
 * standard-adapter.js
 * Standard Adapter Layer (Layer 3)
 *
 * Responsibilities (DR-023):
 * - Exclusively owns member_identity UPSERT and SELECT
 * - Exclusively owns member_access_state status writes
 * - Acquires and releases the in_flight lock (DR-011)
 * - Writes client_activity_summary daily UPSERT (DR-024)
 *
 * Core Engine (Layer 4) never writes member_identity or member_access_state directly.
 * All DB interaction for identity and state flows through this module.
 */

const db = require('../db');
const hardwareAdapter = require('./hardware-adapter');

class StandardAdapter {

  /**
   * Resolves member identity and acquires the in_flight lock atomically.
   *
   * GRANT path (hardwarePlatform provided):
   *   UPSERT member_identity → check + set in_flight → increment events_received
   *   Returns: { memberId }
   *
   * REVOKE path (hardwarePlatform = null):
   *   SELECT member_identity → check + set in_flight → increment events_received
   *   Returns: { memberId, hardwareUserId, hardwarePlatform, roleAssignmentId }
   *   Returns null if no identity record exists (caller must skip — not an error).
   *
   * Throws if in_flight lock is already set (concurrent modification).
   *
   * @param {string} tenantId
   * @param {Object} event             standard event (platformMemberId, sourcePlatform)
   * @param {string|null} hardwarePlatform  null for revoke path
   * @returns {Object|null}
   */
  async resolveAndLock(tenantId, event, hardwarePlatform) {
    const dbClient = await db.getClient();
    try {
      await dbClient.query('BEGIN');

      let memberId, hardwareUserId, resolvedPlatform, roleAssignmentId;

      if (hardwarePlatform !== null) {
        // GRANT: UPSERT identity record
        const identityResult = await dbClient.query(
          `INSERT INTO member_identity
           (client_id, platform_member_id, hardware_platform, source_platform, source_tag)
           VALUES ($1, $2, $3, $4, 'accesssync')
           ON CONFLICT (client_id, source_platform, platform_member_id)
           DO UPDATE SET updated_at = NOW()
           RETURNING id, hardware_user_id`,
          [tenantId, event.platformMemberId, hardwarePlatform, event.sourcePlatform || 'wix']
        );
        memberId = identityResult.rows[0].id;
        hardwareUserId = identityResult.rows[0].hardware_user_id;
        resolvedPlatform = hardwarePlatform;

      } else {
        // REVOKE: SELECT existing row
        const identityResult = await dbClient.query(
          `SELECT id, hardware_user_id, hardware_platform
           FROM member_identity
           WHERE client_id = $1 AND source_platform = $2 AND platform_member_id = $3`,
          [tenantId, event.sourcePlatform || 'wix', event.platformMemberId]
        );

        if (identityResult.rows.length === 0) {
          await dbClient.query('ROLLBACK');
          console.warn(`[Standard Adapter] No identity record for member ${event.platformMemberId}. Skipping revoke.`);
          return null;
        }

        memberId = identityResult.rows[0].id;
        hardwareUserId = identityResult.rows[0].hardware_user_id;
        resolvedPlatform = identityResult.rows[0].hardware_platform;
      }

      // Check + acquire in_flight lock (DR-011)
      const stateResult = await dbClient.query(
        `SELECT status, role_assignment_id FROM member_access_state WHERE member_id = $1`,
        [memberId]
      );

      if (stateResult.rows.length > 0) {
        const { status, role_assignment_id } = stateResult.rows[0];
        roleAssignmentId = role_assignment_id;

        if (status === 'in_flight') {
          throw new Error(`in_flight lock active — concurrent modification rejected for member ${event.platformMemberId}`);
        }

        await dbClient.query(
          `UPDATE member_access_state SET status = 'in_flight', updated_at = NOW() WHERE member_id = $1`,
          [memberId]
        );

      } else {
        if (hardwarePlatform === null) {
          // Revoke with no state row — nothing to revoke
          await dbClient.query('ROLLBACK');
          console.warn(`[Standard Adapter] No access state for member ${event.platformMemberId}. Skipping revoke.`);
          return null;
        }

        // Grant path: INSERT new state row
        await dbClient.query(
          `INSERT INTO member_access_state (member_id, client_id, status)
           VALUES ($1, $2, 'in_flight')`,
          [memberId, tenantId]
        );
        roleAssignmentId = null;
      }

      await dbClient.query('COMMIT');

      // Increment events_received — fault-tolerant (DR-024)
      this._incrementActivity(tenantId, 'events_received').catch(err =>
        console.warn('[Standard Adapter] client_activity_summary update failed (events_received):', err.message)
      );

      if (hardwarePlatform !== null) {
        return { memberId };
      } else {
        return { memberId, hardwareUserId, hardwarePlatform: resolvedPlatform, roleAssignmentId };
      }

    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }
  }

  /**
   * Resolves the hardware user ID for a member.
   * DB cache → hardwareAdapter.findUserByEmail → hardwareAdapter.createUser → cache to DB
   *
   * Called only on grant path, after resolveAndLock() returns memberId.
   *
   * @param {string} memberId          member_identity.id (UUID)
   * @param {string} email             fetched from Wix on-demand (not stored — data minimization)
   * @param {string} name
   * @param {string} hardwarePlatform  e.g. 'kisi'
   * @param {string} apiKey
   * @returns {string} hardware user ID
   */
  async resolveIdentity(memberId, email, name, hardwarePlatform, apiKey) {
    // 1. DB cache check
    const cached = await db.query(
      'SELECT hardware_user_id FROM member_identity WHERE id = $1',
      [memberId]
    );
    if (cached.rows[0]?.hardware_user_id) {
      console.log(`[Standard Adapter] DB cache hit for member ${memberId}`);
      return cached.rows[0].hardware_user_id;
    }

    // 2. Look up by email in hardware system
    let hardwareUserId = await hardwareAdapter.findUserByEmail(hardwarePlatform, apiKey, email);

    if (hardwareUserId) {
      console.log(`[Standard Adapter] Found existing ${hardwarePlatform} user: ${hardwareUserId}`);
    } else {
      // 3. Create in hardware system
      console.log(`[Standard Adapter] Creating new ${hardwarePlatform} user for ${email}`);
      hardwareUserId = await hardwareAdapter.createUser(hardwarePlatform, apiKey, email, name);
    }

    // Cache hardware user ID to DB
    await db.query(
      `UPDATE member_identity SET hardware_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [String(hardwareUserId), memberId]
    );

    return String(hardwareUserId);
  }

  /**
   * Records a successful grant — sets member_access_state to active.
   * Called after hardware role assignment succeeds.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} roleId   hardware role assignment ID
   */
  async completeGrant(memberId, tenantId, roleId) {
    await db.query(
      `UPDATE member_access_state
       SET status = 'active', role_assignment_id = $1, provisioned_at = NOW(), updated_at = NOW()
       WHERE member_id = $2`,
      [String(roleId), memberId]
    );

    this._incrementActivity(tenantId, 'grants_completed').catch(err =>
      console.warn('[Standard Adapter] client_activity_summary update failed (grants_completed):', err.message)
    );
  }

  /**
   * Records a successful revoke — sets member_access_state to targetStatus.
   * Core Engine determines targetStatus from eventType; this layer never handles event type strings (DR-023).
   *
   * targetStatus values:
   *   'disabled'  — payment.failed path (preserve role_assignment_id for fast recovery)
   *   'revoked'   — plan.cancelled, booking.cancelled (clears role_assignment_id)
   *   'deleted'   — member.deleted (clears role_assignment_id)
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} targetStatus
   */
  async completeRevoke(memberId, tenantId, targetStatus) {
    const clearRole = targetStatus === 'revoked' || targetStatus === 'deleted';

    if (clearRole) {
      await db.query(
        `UPDATE member_access_state
         SET status = $1, role_assignment_id = NULL, updated_at = NOW()
         WHERE member_id = $2`,
        [targetStatus, memberId]
      );
    } else {
      await db.query(
        `UPDATE member_access_state SET status = $1, updated_at = NOW() WHERE member_id = $2`,
        [targetStatus, memberId]
      );
    }

    this._incrementActivity(tenantId, 'revokes_completed').catch(err =>
      console.warn('[Standard Adapter] client_activity_summary update failed (revokes_completed):', err.message)
    );
  }

  /**
   * Releases the in_flight lock on error.
   * Sets member_access_state.status = lockStatus (default: 'failed').
   * Increments errors_count in client_activity_summary.
   *
   * Never throws — error handling in the error path must be bulletproof.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} lockStatus  default 'failed'
   */
  async releaseLock(memberId, tenantId, lockStatus = 'failed') {
    await db.query(
      `UPDATE member_access_state SET status = $1, updated_at = NOW() WHERE member_id = $2`,
      [lockStatus, memberId]
    ).catch(err =>
      console.error('[Standard Adapter] Failed to release in_flight lock:', err.message)
    );

    this._incrementActivity(tenantId, 'errors_count').catch(err =>
      console.warn('[Standard Adapter] client_activity_summary update failed (errors_count):', err.message)
    );
  }

  /**
   * Daily UPSERT for client_activity_summary (DR-024).
   * Fault-tolerant — all callers .catch() this. Never awaited in critical paths.
   *
   * @param {string} tenantId
   * @param {string} field  one of: events_received, grants_completed, revokes_completed, errors_count
   */
  async _incrementActivity(tenantId, field) {
    const allowed = ['events_received', 'grants_completed', 'revokes_completed', 'errors_count'];
    if (!allowed.includes(field)) throw new Error(`Unknown activity field: ${field}`);

    // Column name validated against allowlist above — safe to interpolate
    await db.query(
      `INSERT INTO client_activity_summary (client_id, summary_date, ${field})
       VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (client_id, summary_date)
       DO UPDATE SET ${field} = client_activity_summary.${field} + 1, updated_at = NOW()`,
      [tenantId]
    );
  }
}

module.exports = new StandardAdapter();
