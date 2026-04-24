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
const { log } = require('../core/logger');

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
   *   Returns: { memberId, hardwareUserId, hardwarePlatform, roleAssignmentIds[] }
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

      let memberId, hardwareUserId, resolvedPlatform, roleAssignmentIds = [];

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
          log.warn('adapter.no_identity', {
            platformMemberId: event.platformMemberId,
            stage: 'resolve', result: 'skipped',
          });
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

        if (status === 'in_flight') {
          const lockErr = new Error(`in_flight lock active — concurrent modification rejected for member ${event.platformMemberId} (clientId=${tenantId})`);
          lockErr.code = 'IN_FLIGHT_LOCK';
          lockErr.memberId = memberId;  // carry memberId so catch block can release the lock
          throw lockErr;
        }

        // Read all role assignment IDs from member_role_assignments (multi-door)
        const raResult = await dbClient.query(
          `SELECT role_assignment_id FROM member_role_assignments WHERE member_id = $1`,
          [memberId]
        );
        if (raResult.rows.length > 0) {
          roleAssignmentIds = raResult.rows.map(r => r.role_assignment_id);
        } else {
          // Legacy fallback: single role_assignment_id from member_access_state
          roleAssignmentIds = role_assignment_id ? [role_assignment_id] : [];
        }

        await dbClient.query(
          `UPDATE member_access_state SET status = 'in_flight', updated_at = NOW() WHERE member_id = $1`,
          [memberId]
        );

      } else {
        if (hardwarePlatform === null) {
          // Revoke with no state row — nothing to revoke
          await dbClient.query('ROLLBACK');
          log.warn('adapter.no_access_state', {
            platformMemberId: event.platformMemberId,
            stage: 'resolve', result: 'skipped',
          });
          return null;
        }

        // Grant path: INSERT new state row
        await dbClient.query(
          `INSERT INTO member_access_state (member_id, client_id, status)
           VALUES ($1, $2, 'in_flight')`,
          [memberId, tenantId]
        );
        roleAssignmentIds = [];
      }

      await dbClient.query('COMMIT');

      // Increment events_received — fault-tolerant (DR-024)
      this._incrementActivity(tenantId, 'events_received').catch(err =>
        log.warn('adapter.activity_update_failed', { field: 'events_received' }, err)
      );

      if (hardwarePlatform !== null) {
        return { memberId };
      } else {
        return { memberId, hardwareUserId, hardwarePlatform: resolvedPlatform, roleAssignmentIds };
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
   * OB-89 Gate 2 — when Layer 5 (hardware-adapter) throws INVALID_HARDWARE_REQUEST because
   * email is missing, this method catches it and runs the recovery ladder:
   *   (1) Wix Members API lookup by platformMemberId → pull loginEmail + name → retry.
   *   (2) DB cache — check member_identity.email from a prior event → retry.
   *   (3) Park as member_access_state.status='pending_identity', return null.
   * Callers that receive null must treat the grant as parked (not failed).
   *
   * @param {string} memberId          member_identity.id (UUID)
   * @param {string} email             fetched from Wix on-demand (not stored — data minimization)
   * @param {string} name
   * @param {string} hardwarePlatform  e.g. 'kisi'
   * @param {string} apiKey
   * @param {Object} opts
   * @param {boolean} [opts.force]     bypass DB cache (OB-80 stale ID purge)
   * @param {string}  [opts.tenantId]  client UUID — required for Gate 2 recovery via Wix Members API
   * @param {string}  [opts.platformMemberId]  Wix member ID — required for Gate 2 recovery
   * @returns {string|null}            hardware user ID, or null if parked as pending_identity
   */
  async resolveIdentity(memberId, email, name, hardwarePlatform, apiKey, opts = {}) {
    // OB-80: caller may force re-resolution after a hardware 404 on the cached ID.
    // This bypasses the DB cache, looks up by email again, and returns the current Kisi user ID.
    const { force = false, tenantId = null, platformMemberId = null } = opts;

    // 1. DB cache check (skipped when force=true)
    const cached = await db.query(
      'SELECT hardware_user_id FROM member_identity WHERE id = $1',
      [memberId]
    );
    const priorHardwareUserId = cached.rows[0]?.hardware_user_id || null;
    if (!force && priorHardwareUserId) {
      log.info('adapter.identity_cache_hit', {
        memberId, clientId: tenantId, platformMemberId,
        stage: 'identity', result: 'success',
      });
      return priorHardwareUserId;
    }

    // OB-89 Gate 2: wrap the hardware calls. If Gate 1 (Layer 5 validator) throws
    // INVALID_HARDWARE_REQUEST because inputs are missing, run the recovery ladder and retry.
    let hardwareUserId;
    try {
      hardwareUserId = await this._callHardwareToResolveIdentity(
        hardwarePlatform, apiKey, email, name
      );
    } catch (err) {
      if (err.code === 'INVALID_HARDWARE_REQUEST' && err.missingFields?.includes('email')) {
        // Gate 2 — attempt to recover the missing email.
        log.warn('adapter.identity.gate2_recovery_triggered', {
          memberId, platformMemberId, clientId: tenantId,
          missingFields: err.missingFields,
          stage: 'identity', result: 'retry',
        });
        const recovered = await this._recoverMissingEmail(memberId, tenantId, platformMemberId);
        if (recovered && recovered.email) {
          log.info('adapter.identity.gate2_recovered', {
            memberId, platformMemberId, clientId: tenantId,
            recoveredVia: recovered.source,
            stage: 'identity', result: 'success',
          });
          hardwareUserId = await this._callHardwareToResolveIdentity(
            hardwarePlatform, apiKey, recovered.email, recovered.name || name || recovered.email
          );
        } else {
          // Ladder exhausted — park as pending_identity, return null to signal "parked, not failed".
          log.warn('adapter.identity.parked_pending_identity', {
            memberId, platformMemberId, clientId: tenantId,
            reason: 'email_unrecoverable',
            stage: 'identity', result: 'skipped',
          });
          await this._parkPendingIdentity(memberId, tenantId, err.missingFields);
          return null;
        }
      } else {
        throw err;
      }
    }

    const newHardwareUserId = String(hardwareUserId);

    // OB-80: If a prior hardware_user_id existed and we just resolved to a different one,
    // the original Kisi user was deleted and replaced. The old role_assignment_id and source
    // rows point at a dead Kisi user — they'll 404 on the next revoke and silently rot.
    // Purge them so the new grant writes clean rows.
    if (priorHardwareUserId && priorHardwareUserId !== newHardwareUserId) {
      log.warn('adapter.identity_replaced', {
        memberId,
        priorHardwareUserId,
        newHardwareUserId,
      });
      await db.query(`DELETE FROM member_role_assignments WHERE member_id = $1`, [memberId]);
      await db.query(`DELETE FROM member_access_sources   WHERE member_id = $1`, [memberId]);
    }

    // Cache hardware user ID to DB
    await db.query(
      `UPDATE member_identity SET hardware_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [newHardwareUserId, memberId]
    );

    return newHardwareUserId;
  }

  /**
   * Records a successful grant — writes all role assignments to member_role_assignments,
   * writes source rows to member_access_sources (DR-034),
   * then sets member_access_state to active.
   * Called after hardware role assignments succeed.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {Array}  assignments  [{ mappingId, roleAssignmentId, hardwareGroupId, sourcePlanId, sourceType }]
   */
  async completeGrant(memberId, tenantId, assignments) {
    for (const { mappingId, roleAssignmentId, hardwareGroupId, sourcePlanId, sourceType } of assignments) {
      // ON CONFLICT DO NOTHING — idempotent on retry (UNIQUE constraint on member_id, mapping_id, hardware_group_id)
      await db.query(
        `INSERT INTO member_role_assignments (member_id, mapping_id, role_assignment_id, hardware_group_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (member_id, mapping_id, hardware_group_id) DO NOTHING`,
        [memberId, mappingId, roleAssignmentId, hardwareGroupId || null]
      );

      // DR-034: Record why this member is in this group.
      // ON CONFLICT DO NOTHING — safe for retry (idempotent).
      if (hardwareGroupId) {
        await db.query(
          `INSERT INTO member_access_sources
             (member_id, hardware_group_id, source_type, source_plan_id, mapping_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [memberId, hardwareGroupId, sourceType || 'plan', sourcePlanId || null, mappingId || null]
        );
      }
    }

    await db.query(
      `UPDATE member_access_state
       SET status = 'active', provisioned_at = NOW(), updated_at = NOW()
       WHERE member_id = $1`,
      [memberId]
    );

    this._incrementActivity(tenantId, 'grants_completed').catch(err =>
      log.warn('adapter.activity_update_failed', { field: 'grants_completed' }, err)
    );

    // Sprint 5.5: First grant experience — send welcome email on first successful grant per client.
    // Fault-tolerant: never blocks the grant completion path.
    this._maybeFireFirstGrantEmail(tenantId, memberId).catch(err =>
      log.warn('adapter.first_grant_email_failed', {}, err)
    );
  }

  /**
   * Fires the first-grant welcome email once per client (Sprint 5.5).
   * Uses clients.first_grant_sent flag — set atomically to prevent duplicate sends.
   */
  async _maybeFireFirstGrantEmail(tenantId, memberId) {
    const result = await db.query(
      `UPDATE clients
       SET first_grant_sent = true
       WHERE id = $1 AND first_grant_sent = false
       RETURNING name, notification_email`,
      [tenantId]
    );
    if (!result.rows.length) return; // Already sent — skip

    const { name: clientName, notification_email } = result.rows[0];
    const toEmail = notification_email || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
    if (!toEmail) {
      log.info('adapter.first_grant_no_email', { clientName });
      return;
    }

    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from:    process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
        to:      toEmail,
        subject: '[AccessSync] 🎉 First member access granted',
        text: [
          `AccessSync is working — ${new Date().toISOString()}`,
          '',
          `Client: ${clientName}`,
          '',
          'Your first member has been successfully provisioned in Kisi.',
          'Their door access is live. AccessSync is running.',
          '',
          'You can view member status and access history in the AccessSync dashboard.',
        ].join('\n'),
      });
      log.info('adapter.first_grant_email_sent', { toEmail, clientName });
    } catch (err) {
      log.error('adapter.first_grant_email_error', {}, err);
    }
  }

  /**
   * Records a successful revoke — sets member_access_state to targetStatus.
   * Core Engine determines targetStatus from eventType; this layer never handles event type strings (DR-023).
   *
   * targetStatus values:
   *   'disabled'  — payment.failed path (preserve role assignments for fast recovery)
   *   'revoked'   — plan.cancelled, booking.cancelled (clears role assignments)
   *   'deleted'   — member.deleted (clears role assignments)
   *
   * DR-034: For 'revoked' path, also removes the source row from member_access_sources.
   * The caller (grant-revoke.js / queue-worker) is responsible for checking remaining
   * source count BEFORE calling hardware removeRole — this method only cleans up DB state.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} targetStatus
   * @param {Object} [options]   { sourcePlanId, sourceType, hardwareGroupId } — for DR-034 source cleanup
   */
  async completeRevoke(memberId, tenantId, targetStatus, options = {}) {
    const clearRole = targetStatus === 'revoked' || targetStatus === 'deleted';
    const dbClient = await db.getClient();

    try {
      await dbClient.query('BEGIN');

      if (clearRole) {
        // DR-034: Remove this specific source row if planId provided (targeted revoke).
        // If no planId (full delete), remove all source rows for this member.
        if (options.sourcePlanId && options.hardwareGroupId) {
          await dbClient.query(
            `DELETE FROM member_access_sources
             WHERE member_id = $1
               AND hardware_group_id = $2
               AND source_type = $3
               AND COALESCE(source_plan_id, '') = COALESCE($4, '')`,
            [memberId, options.hardwareGroupId, options.sourceType || 'plan', options.sourcePlanId]
          );
        } else {
          // Full revoke (member.deleted or no scope info) — clear all source rows
          await dbClient.query(
            `DELETE FROM member_access_sources WHERE member_id = $1`,
            [memberId]
          );
        }

        // Clear all stored role assignments atomically with state update
        await dbClient.query(
          `DELETE FROM member_role_assignments WHERE member_id = $1`,
          [memberId]
        );
        await dbClient.query(
          `UPDATE member_access_state
           SET status = $1, role_assignment_id = NULL, updated_at = NOW()
           WHERE member_id = $2`,
          [targetStatus, memberId]
        );
      } else {
        // 'disabled' path — preserve role assignments, just update status
        await dbClient.query(
          `UPDATE member_access_state SET status = $1, updated_at = NOW() WHERE member_id = $2`,
          [targetStatus, memberId]
        );
      }

      await dbClient.query('COMMIT');
    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }

    this._incrementActivity(tenantId, 'revokes_completed').catch(err =>
      log.warn('adapter.activity_update_failed', { field: 'revokes_completed' }, err)
    );
  }

  /**
   * Releases the in_flight lock on error or pending_hardware park.
   * Sets member_access_state.status = lockStatus (default: 'failed').
   * Increments errors_count in client_activity_summary (except for pending_hardware).
   *
   * Never throws — error handling in the error path must be bulletproof.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} lockStatus  default 'failed'
   * @param {Object} [options]   optional: { planId } — stored for pending_hardware retry
   */
  async releaseLock(memberId, tenantId, lockStatus = 'failed', options = {}) {
    if (lockStatus === 'pending_hardware' && options.planId) {
      await db.query(
        `UPDATE member_access_state SET status = $1, pending_plan_id = $2, updated_at = NOW() WHERE member_id = $3`,
        [lockStatus, options.planId, memberId]
      ).catch(err =>
        log.error('adapter.pending_hardware_failed', { memberId }, err)
      );
    } else {
      await db.query(
        `UPDATE member_access_state SET status = $1, updated_at = NOW() WHERE member_id = $2`,
        [lockStatus, memberId]
      ).catch(err =>
        log.error('adapter.lock_release_failed', { memberId }, err)
      );
    }

    // Don't count pending_hardware as errors — it's an expected state, not a failure
    if (lockStatus !== 'pending_hardware') {
      this._incrementActivity(tenantId, 'errors_count').catch(err =>
        log.warn('adapter.activity_update_failed', { field: 'errors_count' }, err)
      );
    }
  }

  /**
   * Parks a member whose Kisi user has been created but group assignment is deferred
   * because the plan's startDate is in the future. Sets status = 'pending_start' and
   * stores the scheduled date so sync-status.ejs can display it to the member.
   * Called by queue-worker after resolveIdentity() succeeds on an orderPurchased event
   * for a delayed-start plan. orderStarted fires when the startDate arrives and completes
   * the grant via the plan.started path.
   *
   * @param {string} memberId
   * @param {string} tenantId
   * @param {string} scheduledStartDate  ISO-8601 string
   */
  async parkPendingStart(memberId, tenantId, scheduledStartDate) {
    await db.query(
      `UPDATE member_access_state
       SET status = 'pending_start', scheduled_start_date = $2, updated_at = NOW()
       WHERE member_id = $1`,
      [memberId, scheduledStartDate]
    );
    this._incrementActivity(tenantId, 'events_received').catch(err =>
      log.warn('adapter.activity_update_failed', { field: 'events_received' }, err)
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

  // ── OB-89 Gate 2 helpers ────────────────────────────────────────────

  /**
   * Wrapper around hardware findUserByEmail + createUser. Isolated so Gate 2
   * can call it twice — first with original inputs, again with recovered inputs.
   */
  async _callHardwareToResolveIdentity(hardwarePlatform, apiKey, email, name) {
    let hardwareUserId = await hardwareAdapter.findUserByEmail(hardwarePlatform, apiKey, email);
    if (hardwareUserId) {
      log.info('adapter.identity_found', { hardwarePlatform, hardwareUserId });
      return hardwareUserId;
    }
    log.info('adapter.identity_creating', { hardwarePlatform, email });
    return hardwareAdapter.createUser(hardwarePlatform, apiKey, email, name);
  }

  /**
   * OB-89 Gate 2 — recovery ladder for missing identity inputs (email today).
   * Returns { email, name, source: 'wix_members_api' | 'db_cache' } on success, or null
   * when every tier is exhausted. Caller (resolveIdentity) parks as pending_identity on null.
   *
   * Tier 1: Wix Members API lookup by platformMemberId. Authoritative — fetches current
   *         loginEmail and name from Wix. Requires tenantId + platformMemberId in opts.
   * Tier 2: DB cache — member_identity.email from a prior event (schema already supports
   *         email; we just haven't been populating it). Fallback for when Members API fails.
   * Tier 3: None — return null, caller parks.
   */
  async _recoverMissingEmail(memberId, tenantId, platformMemberId) {
    if (!tenantId || !platformMemberId) {
      log.warn('adapter.identity.gate2_skipped', {
        memberId, reason: 'missing_tenantId_or_platformMemberId',
      });
      return null;
    }

    // Tier 1: Wix Members API (two-call: Members → Contacts for email/name)
    try {
      const clientRow = (await db.query(
        `SELECT source_api_key, source_site_id FROM clients WHERE id = $1`,
        [tenantId]
      )).rows[0];
      if (clientRow?.source_api_key && clientRow?.source_site_id) {
        const { decryptApiKey } = require('../core/crypto-utils');
        const wixMembersApi    = require('./wix/wix-members-api');
        const wixApiKey = decryptApiKey(clientRow.source_api_key);
        const member = await wixMembersApi.getMemberById(
          wixApiKey, clientRow.source_site_id, platformMemberId
        );
        if (member && member.email) {
          // DR-001-A narrow Gate 2 write path — cache the recovered identity on
          // member_identity so (a) subsequent sync runs don't re-call Wix for the
          // same member (rate-limit friendliness), (b) the Members page shows a
          // real name instead of a UUID. Null-coalesce: never overwrite an
          // existing non-null field with null from a partial Wix response.
          await db.query(
            `UPDATE member_identity
             SET email        = COALESCE($2, email),
                 first_name   = COALESCE($3, first_name),
                 last_name    = COALESCE($4, last_name),
                 display_name = COALESCE($5, display_name),
                 phone        = COALESCE($6, phone),
                 updated_at   = NOW()
             WHERE id = $1`,
            [
              memberId,
              member.email,
              member.firstName,
              member.lastName,
              member.name,
              member.phone,
            ]
          ).catch(err => {
            log.warn('adapter.identity.gate2_cache_write_failed', { memberId, code: err.code }, err);
            // Not fatal — caller still gets the recovered data via return value.
          });

          return {
            email: member.email,
            name:  member.name || member.email,
            firstName: member.firstName || null,
            lastName:  member.lastName  || null,
            phone:     member.phone     || null,
            source: 'wix_members_api',
          };
        }
        log.warn('adapter.identity.gate2_tier1_no_email', {
          memberId, platformMemberId, memberFound: !!member,
        });
      } else {
        log.warn('adapter.identity.gate2_tier1_skipped', {
          memberId, reason: 'client_missing_source_api_key_or_site_id',
        });
      }
    } catch (err) {
      // Don't let Tier 1 failure abort Tier 2.
      log.error('adapter.identity.gate2_tier1_failed', {
        memberId, platformMemberId, httpStatus: err.statusCode, code: err.code,
      }, err);
    }

    // Tier 2: DB cache — prior email stored on member_identity
    try {
      const cached = (await db.query(
        `SELECT email, display_name, first_name, last_name
         FROM member_identity WHERE id = $1`,
        [memberId]
      )).rows[0];
      if (cached?.email) {
        const composed = [cached.first_name, cached.last_name].filter(Boolean).join(' ').trim();
        return {
          email: cached.email,
          name: cached.display_name || composed || cached.email,
          source: 'db_cache',
        };
      }
    } catch (err) {
      log.error('adapter.identity.gate2_tier2_failed', { memberId }, err);
    }

    // Tier 3: ladder exhausted
    return null;
  }

  /**
   * OB-89 Gate 2 — park a member whose grant cannot proceed because required identity
   * inputs cannot be recovered. Transitions status out of 'in_flight' to 'pending_identity'
   * — which IS the lock release (the "in_flight lock" is a sentinel value in the status
   * column, not a separate boolean column per DR-011/DR-023). Waits for the next webhook
   * which may carry email via the Velo payload. Not a failure — not a dead-letter.
   */
  async _parkPendingIdentity(memberId, tenantId, missingFields) {
    try {
      await db.query(
        `UPDATE member_access_state
         SET status = 'pending_identity',
             updated_at = NOW()
         WHERE member_id = $1`,
        [memberId]
      );
      log.info('adapter.identity.parked', { memberId, tenantId, missingFields });
    } catch (err) {
      log.error('adapter.identity.park_failed', { memberId, tenantId, missingFields }, err);
      throw err;
    }
  }
}

module.exports = new StandardAdapter();
