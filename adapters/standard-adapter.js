/**
 * standard-adapter.js
 * Standard Adapter Layer (Layer 3)
 *
 * Responsibilities (DR-023):
 * - Exclusively owns member_master UPSERT and SELECT
 * - Exclusively owns member_access status writes (replaces member_access_state)
 * - Acquires and releases the in_flight lock via FOR UPDATE NOWAIT (Q-2)
 * - Writes client_activity_summary daily UPSERT (DR-024)
 *
 * Core Engine (Layer 4) never writes member_master or member_access directly.
 * All DB interaction for identity and state flows through this module.
 */

const db = require('../db');
const hardwareAdapter = require('./hardware-adapter');
const { log } = require('../core/logger');
const { getTraceId, setTraceContext } = require('../core/trace-context');

class StandardAdapter {

  /**
   * Resolves member identity and acquires the in_flight lock atomically.
   *
   * GRANT path (hardwarePlatform provided):
   *   UPSERT member_master (PII) → FOR UPDATE NOWAIT lock on member_access →
   *   UPSERT member_access status='in_flight' → increment events_received
   *   Returns: { memberId } where memberId = member_access.id
   *
   * REVOKE path (hardwarePlatform = null):
   *   SELECT member_access JOIN member_master → FOR UPDATE NOWAIT lock →
   *   UPDATE status='in_flight' → increment events_received
   *   Returns: { memberId, hardwareUserId, hardwarePlatform, roleAssignmentIds[] }
   *   Returns null if no member_access record exists (caller must skip — not an error).
   *
   * Throws IN_FLIGHT_LOCK if Postgres 55P03 lock-not-available (FOR UPDATE NOWAIT contention).
   *
   * @param {string} tenantId
   * @param {Object} event             standard event (platformMemberId, sourcePlatform, planMappingId)
   * @param {string|null} hardwarePlatform  null for revoke path
   * @returns {Object|null}
   */
  async resolveAndLock(tenantId, event, hardwarePlatform, planMappingId) {
    const dbClient = await db.getClient();
    try {
      await dbClient.query('BEGIN');

      let memberId, memberMasterId, hardwareUserId, resolvedPlatform, roleAssignmentIds = [];

      if (hardwarePlatform !== null) {
        // GRANT path

        // Step 1: UPSERT person record (PII anchor) — write email/name from event when present
        const masterResult = await dbClient.query(
          `INSERT INTO member_master (client_id, source_platform, platform_member_id, email, display_name, source_tag)
           VALUES ($1, $2, $3, $4, $5, 'accesssync')
           ON CONFLICT (client_id, source_platform, platform_member_id) DO UPDATE
             SET email        = COALESCE(EXCLUDED.email, member_master.email),
                 display_name = COALESCE(EXCLUDED.display_name, member_master.display_name),
                 updated_at   = NOW()
           RETURNING id`,
          [tenantId, event.sourcePlatform || 'wix', event.platformMemberId, event.email || null, event.name || null]
        );
        memberMasterId = masterResult.rows[0].id;

        // Step 2: Acquire row lock before UPSERT (Q-2: prevents deadlock on concurrent grant)
        // 55P03 = lock_not_available — thrown by FOR UPDATE NOWAIT when row is already locked
        try {
          // Postgres treats NULL = NULL as unknown, so when planMappingId is null we
          // must use IS NULL or the lock SELECT returns zero rows and skips the lock.
          // Both arms cover the same logical "(member_master_id, plan_mapping_id) tuple."
          if (planMappingId === null) {
            await dbClient.query(
              `SELECT id FROM member_access
               WHERE member_master_id = $1 AND plan_mapping_id IS NULL
               FOR UPDATE NOWAIT`,
              [memberMasterId]
            );
          } else {
            await dbClient.query(
              `SELECT id FROM member_access
               WHERE member_master_id = $1 AND plan_mapping_id = $2
               FOR UPDATE NOWAIT`,
              [memberMasterId, planMappingId]
            );
          }
        } catch (lockErr) {
          if (lockErr.code === '55P03') {
            const err = new Error(`in_flight lock active — concurrent modification rejected for member ${event.platformMemberId} (clientId=${tenantId})`);
            err.code = 'IN_FLIGHT_LOCK';
            throw err;
          }
          throw lockErr;
        }

        // Step 3: UPSERT access record — sets in_flight sentinel (Option B stall recovery)
        // plan_holder = true for primary members (event.planHolderId null means they are the holder)
        const isPlanHolder = !event.planHolderId;
        const accessResult = await dbClient.query(
          `INSERT INTO member_access
             (member_master_id, client_id, plan_mapping_id, source_platform, platform_member_id, status, plan_holder)
           VALUES ($1, $2, $3, $4, $5, 'in_flight', $6)
           ON CONFLICT (member_master_id, plan_mapping_id) DO UPDATE
             SET status = 'in_flight', updated_at = NOW()
           RETURNING id, hardware_user_id`,
          [memberMasterId, tenantId, planMappingId, event.sourcePlatform || 'wix', event.platformMemberId, isPlanHolder]
        );
        memberId = accessResult.rows[0].id;
        hardwareUserId = accessResult.rows[0].hardware_user_id;

      } else {
        // REVOKE path — revoke applies to ALL active access rows for this member.
        // A plan.cancelled event does not include a plan_mapping_id, so we look up
        // by member identity only and revoke every active access row.
        const accessResult = await dbClient.query(
          `SELECT ma.id, ma.hardware_user_id, ma.hardware_platform, ma.status
           FROM member_access ma
           JOIN member_master mm ON mm.id = ma.member_master_id
           WHERE mm.client_id = $1
             AND mm.source_platform = $2
             AND mm.platform_member_id = $3
             AND ma.status IN ('active', 'in_flight')`,
          [tenantId, event.sourcePlatform || 'wix', event.platformMemberId]
        );

        if (accessResult.rows.length === 0) {
          await dbClient.query('ROLLBACK');
          log.warn('adapter.no_identity', {
            platformMemberId: event.platformMemberId,
            stage: 'resolve', result: 'skipped',
          });
          return null;
        }

        // Use the first row as the primary access record (handles single-mapping case)
        memberId = accessResult.rows[0].id;
        hardwareUserId = accessResult.rows[0].hardware_user_id;
        resolvedPlatform = accessResult.rows[0].hardware_platform;

        // Acquire row lock then set in_flight
        try {
          await dbClient.query(
            `SELECT id FROM member_access WHERE id = $1 FOR UPDATE NOWAIT`,
            [memberId]
          );
        } catch (lockErr) {
          if (lockErr.code === '55P03') {
            const err = new Error(`in_flight lock active — concurrent modification rejected for member ${event.platformMemberId} (clientId=${tenantId})`);
            err.code = 'IN_FLIGHT_LOCK';
            throw err;
          }
          throw lockErr;
        }

        await dbClient.query(
          `UPDATE member_access SET status = 'in_flight', updated_at = NOW() WHERE id = $1`,
          [memberId]
        );

        // Role assignment IDs now live on member_access_sources
        const raResult = await dbClient.query(
          `SELECT role_assignment_id FROM member_access_sources
           WHERE access_id = $1 AND role_assignment_id IS NOT NULL`,
          [memberId]
        );
        roleAssignmentIds = raResult.rows.map(r => r.role_assignment_id);
      }

      await dbClient.query('COMMIT');

      // DIAG: warn-level so it lands in diagnostic_log (info stays stdout-only).
      log.warn('adapter.resolve_and_lock.committed', {
        memberId, memberMasterId, tenantId,
        platformMemberId: event.platformMemberId,
        sourcePlatform: event.sourcePlatform || 'wix',
        planMappingId,
        hardwarePlatform: hardwarePlatform || null,
        path: hardwarePlatform !== null ? 'grant' : 'revoke',
        stage: 'resolve', result: 'committed',
      });

      // DIAG: re-query from a fresh connection to verify post-COMMIT visibility.
      try {
        const verify = await db.query(
          `SELECT id, member_master_id, status FROM member_access WHERE id = $1`,
          [memberId]
        );
        log.warn('adapter.resolve_and_lock.post_commit_verify', {
          memberId, memberMasterId,
          verifyRowCount: verify.rowCount,
          verifyMemberMasterId: verify.rows[0]?.member_master_id || null,
          verifyStatus: verify.rows[0]?.status || null,
          stage: 'resolve', result: verify.rowCount === 1 ? 'verified' : 'missing',
        });
      } catch (verifyErr) {
        log.warn('adapter.resolve_and_lock.post_commit_verify_failed', { memberId }, verifyErr);
      }

      // Increment events_received — fault-tolerant (DR-024)
      this._incrementActivity(tenantId, 'events_received').catch(err =>
        log.warn('adapter.activity_update_failed', { field: 'events_received' }, err)
      );

      // Enrich trace_context with resolved memberId. Fire-and-forget.
      const _tid = getTraceId();
      if (_tid && memberId) setTraceContext(_tid, { clientId: tenantId, memberId });

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
   * memberId here is member_access.id.
   *
   * OB-89 Gate 2 — when Layer 5 (hardware-adapter) throws INVALID_HARDWARE_REQUEST because
   * email is missing, this method catches it and runs the recovery ladder:
   *   (1) Wix Members API lookup by platformMemberId → pull loginEmail + name → retry.
   *   (2) DB cache — check member_master.email from a prior event → retry.
   *   (3) Park as member_access.status='pending_identity', return null.
   * Callers that receive null must treat the grant as parked (not failed).
   *
   * @param {string} memberId          member_access.id (UUID)
   * @param {string} email             fetched from Wix on-demand (not stored — data minimization)
   * @param {string} name
   * @param {string} hardwarePlatform  e.g. 'kisi'
   * @param {string} apiKey
   * @param {Object} opts
   * @param {boolean} [opts.force]     bypass DB cache (OB-80 stale ID purge)
   * @param {string}  [opts.tenantId]  client UUID — required for Gate 2 recovery via Wix Members API
   * @param {string}  [opts.platformMemberId]  Wix member ID — required for Gate 2 recovery
   * @param {string}  [opts.userPattern]  'invited' | 'managed' — DR-043
   * @returns {string|null}            hardware user ID, or null if parked as pending_identity
   */
  async resolveIdentity(memberId, email, name, hardwarePlatform, apiKey, opts = {}) {
    const { force = false, tenantId = null, platformMemberId = null } = opts;

    // DR-043: resolve per-tenant user pattern from connector_subscriptions.
    let userPattern = opts.userPattern || null;
    if (!userPattern && tenantId) {
      try {
        const patternRow = await db.query(
          `SELECT kisi_user_pattern FROM connector_subscriptions
            WHERE client_id = $1 AND status = 'active' LIMIT 1`,
          [tenantId]
        );
        userPattern = patternRow.rows[0]?.kisi_user_pattern || 'invited';
      } catch (_) {
        userPattern = 'invited';
      }
    }
    if (!userPattern) userPattern = 'invited';

    // 1. DB cache check — reads hardware_user_id from member_access (skipped when force=true)
    const cached = await db.query(
      'SELECT hardware_user_id FROM member_access WHERE id = $1',
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

    // OB-89 Gate 2: wrap hardware calls — recover missing email if needed.
    // Email is the only identity anchor. Name is decoration (not used for matching, not
    // sent to Kisi). If email is missing, run the recovery ladder (Wix Members API → DB cache → park).
    let hardwareUserId;
    try {
      hardwareUserId = await this._callHardwareToResolveIdentity(
        hardwarePlatform, apiKey, email, name, { userPattern, clientId: tenantId }
      );
    } catch (err) {
      if (err.code === 'INVALID_HARDWARE_REQUEST' && err.missingFields?.includes('email')) {
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
            hardwarePlatform, apiKey, recovered.email, recovered.name || name || null,
            { userPattern, clientId: tenantId }
          );
        } else {
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

    // OB-80: Prior hardware_user_id changed — old source rows point at a dead Kisi user.
    // Purge by access_id (new schema has no member_id column on member_access_sources).
    if (priorHardwareUserId && priorHardwareUserId !== newHardwareUserId) {
      log.warn('adapter.identity_replaced', {
        memberId,
        priorHardwareUserId,
        newHardwareUserId,
      });
      await db.query(`DELETE FROM member_access_sources WHERE access_id = $1`, [memberId]);
    }

    // Cache hardware user ID to member_access
    await db.query(
      `UPDATE member_access SET hardware_user_id = $1, updated_at = NOW() WHERE id = $2`,
      [newHardwareUserId, memberId]
    );

    return newHardwareUserId;
  }

  /**
   * Records a successful grant:
   * - INSERTs member_billing row (idempotent on wix_order_id + cycle_index)
   * - INSERTs member_access_sources rows (access_id→billing_id link, role_assignment_id, valid_until RI-03)
   * - UPDATEs member_access.status = 'active'
   *
   * Called after hardware role assignments succeed.
   *
   * @param {string} memberId   member_access.id
   * @param {string} tenantId
   * @param {Array}  assignments  [{
   *   mappingId, roleAssignmentId, hardwareGroupId, sourcePlanId, sourceType,
   *   planEndDate,       — RI-03: written to valid_until (null = permanent)
   *   wixOrderId, wixSubscriptionId, cycleIndex, planId, planName,
   *   effectiveStart, effectiveEnd, billingSnapshot
   * }]
   */
  async completeGrant(memberId, tenantId, assignments) {
    // Write hardware_platform from first assignment so the revoke path can read it back.
    const resolvedHardwarePlatform = assignments[0]?.hardwarePlatform || null;

    // DIAG: warn-level so it lands in diagnostic_log.
    log.warn('adapter.complete_grant.entry', {
      memberId, tenantId,
      assignmentCount: assignments.length,
      hardwarePlatform: resolvedHardwarePlatform,
      stage: 'grant', result: 'start',
    });

    // Resolve member_master_id once for member_billing rows.
    // DIAG: select more columns + count so we can tell whether the row exists at all
    // vs exists with a null FK.
    const masterRow = await db.query(
      `SELECT id, member_master_id, status, plan_mapping_id, created_at, updated_at
       FROM member_access WHERE id = $1`,
      [memberId]
    );
    const memberMasterId = masterRow.rows[0]?.member_master_id;

    log.warn('adapter.complete_grant.lookup', {
      memberId, tenantId,
      lookupRowCount: masterRow.rowCount,
      lookupMemberMasterId: memberMasterId || null,
      lookupStatus: masterRow.rows[0]?.status || null,
      lookupPlanMappingId: masterRow.rows[0]?.plan_mapping_id || null,
      lookupCreatedAt: masterRow.rows[0]?.created_at || null,
      lookupUpdatedAt: masterRow.rows[0]?.updated_at || null,
      stage: 'grant', result: masterRow.rowCount === 1 ? 'lookup_ok' : 'lookup_missing',
    });

    // DIAG: if row missing, ALSO query for any member_access rows in the last 60s for
    // this tenant — to see if a sibling row exists that we should have used.
    if (masterRow.rowCount === 0) {
      try {
        const siblings = await db.query(
          `SELECT ma.id, ma.member_master_id, ma.status, ma.plan_mapping_id, ma.created_at,
                  mm.platform_member_id
           FROM member_access ma
           LEFT JOIN member_master mm ON mm.id = ma.member_master_id
           WHERE ma.client_id = $1 AND ma.created_at > NOW() - INTERVAL '60 seconds'
           ORDER BY ma.created_at DESC LIMIT 10`,
          [tenantId]
        );
        log.warn('adapter.complete_grant.recent_siblings', {
          memberId, tenantId,
          siblingCount: siblings.rowCount,
          siblings: siblings.rows.map(r => ({
            id: r.id, mmid: r.member_master_id, status: r.status,
            pm: r.plan_mapping_id, pmi: r.platform_member_id,
            createdAt: r.created_at,
          })),
        });
      } catch (siblingErr) {
        log.warn('adapter.complete_grant.sibling_lookup_failed', { memberId }, siblingErr);
      }
    }

    // member_access row is missing or member_master_id is null — fail loud.
    // This means the row was CASCADE-deleted (member_master removed mid-grant) or never
    // existed. Writing null into member_billing.member_master_id silently corrupts data;
    // throwing lets BullMQ dead-letter the job and surfaces the integrity break.
    if (!memberMasterId) {
      const err = new Error(`completeGrant: member_access row ${memberId} missing or has null member_master_id (likely CASCADE delete mid-grant)`);
      err.code = 'MEMBER_ACCESS_GONE';
      throw err;
    }

    for (const {
      mappingId, roleAssignmentId, hardwareGroupId, sourcePlanId, sourceType,
      planEndDate, wixOrderId, wixSubscriptionId, cycleIndex,
      planId, planName, effectiveStart, effectiveEnd, billingSnapshot,
    } of assignments) {
      // INSERT member_billing — idempotency guard: ON CONFLICT (wix_order_id, cycle_index) DO NOTHING
      let billingId = null;
      if (wixOrderId) {
        const billingResult = await db.query(
          `INSERT INTO member_billing
             (member_master_id, client_id, wix_order_id, wix_subscription_id, cycle_index,
              plan_id, plan_name, effective_start, effective_end, status, billing_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)
           ON CONFLICT (wix_order_id, cycle_index) DO NOTHING
           RETURNING id`,
          [
            memberMasterId, tenantId, wixOrderId, wixSubscriptionId || null,
            cycleIndex || 1, planId || null, planName || null,
            effectiveStart || null, effectiveEnd || null,
            billingSnapshot ? JSON.stringify(billingSnapshot) : null,
          ]
        );
        // If DO NOTHING fired, fetch the existing row's id
        if (billingResult.rows.length > 0) {
          billingId = billingResult.rows[0].id;
        } else {
          const existing = await db.query(
            `SELECT id FROM member_billing WHERE wix_order_id = $1 AND cycle_index = $2`,
            [wixOrderId, cycleIndex || 1]
          );
          billingId = existing.rows[0]?.id || null;
        }
      }

      // INSERT member_access_sources — new schema: access_id FK, billing_id FK, valid_until (RI-03)
      await db.query(
        `INSERT INTO member_access_sources
           (access_id, billing_id, source_type, source_plan_id, hardware_group_id,
            role_assignment_id, mapping_id, effective_start, valid_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (access_id, source_type, source_plan_id, hardware_group_id) DO UPDATE
           SET role_assignment_id = EXCLUDED.role_assignment_id,
               billing_id = COALESCE(EXCLUDED.billing_id, member_access_sources.billing_id),
               effective_start = COALESCE(EXCLUDED.effective_start, member_access_sources.effective_start),
               valid_until = EXCLUDED.valid_until`,
        [
          memberId, billingId || null, sourceType || 'plan',
          sourcePlanId || null, hardwareGroupId || null,
          roleAssignmentId || null, mappingId || null,
          effectiveStart || null, planEndDate || null,
        ]
      );
    }

    await db.query(
      `UPDATE member_access
       SET status = 'active', provisioned_at = NOW(), updated_at = NOW(),
           hardware_platform = COALESCE(hardware_platform, $2)
       WHERE id = $1`,
      [memberId, resolvedHardwarePlatform]
    );

    this._incrementActivity(tenantId, 'grants_completed').catch(err =>
      log.warn('adapter.activity_update_failed', { field: 'grants_completed' }, err)
    );

    this._maybeFireFirstGrantEmail(tenantId, memberId).catch(err =>
      log.warn('adapter.first_grant_email_failed', {}, err)
    );
  }

  /**
   * Fires the first-grant welcome email once per client (Sprint 5.5).
   * Uses clients.first_grant_sent flag — set atomically to prevent duplicate sends.
   * UNCHANGED from prior schema.
   */
  async _maybeFireFirstGrantEmail(tenantId, memberId) {
    const result = await db.query(
      `UPDATE clients
       SET first_grant_sent = true
       WHERE id = $1 AND first_grant_sent = false
       RETURNING name, notification_email`,
      [tenantId]
    );
    if (!result.rows.length) return;

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
   * Records a successful revoke — cleans up member_access_sources and sets member_access status.
   * Core Engine determines targetStatus from eventType; this layer never handles event type strings (DR-023).
   *
   * targetStatus values:
   *   'inactive'   — plan.cancelled, booking.cancelled (clears source rows)
   *   'disabled'   — payment.failed path (preserve source rows for fast recovery)
   *   'deleted'    — member.deleted (clears all source rows)
   *   'revoked'    — legacy alias for 'inactive', kept for backwards compat
   *   'cancelled'  — legacy alias for early-exit never-provisioned path
   *
   * DR-034: For 'inactive'/'revoked'/'deleted'/'cancelled' paths, removes source rows from member_access_sources.
   * Remaining-count check (before hardware removeRole call) is the caller's responsibility.
   *
   * @param {string} memberId   member_access.id
   * @param {string} tenantId
   * @param {string} targetStatus
   * @param {Object} [options]  { sourcePlanId, sourceType, hardwareGroupId }
   */
  async completeRevoke(memberId, tenantId, targetStatus, options = {}) {
    const clearRole = targetStatus === 'inactive' || targetStatus === 'revoked' || targetStatus === 'deleted' || targetStatus === 'cancelled';
    const dbClient = await db.getClient();

    try {
      await dbClient.query('BEGIN');

      if (clearRole) {
        if (options.sourcePlanId && options.hardwareGroupId) {
          await dbClient.query(
            `DELETE FROM member_access_sources
             WHERE access_id = $1
               AND hardware_group_id = $2
               AND source_type = $3
               AND COALESCE(source_plan_id, '') = COALESCE($4, '')`,
            [memberId, options.hardwareGroupId, options.sourceType || 'plan', options.sourcePlanId]
          );
        } else {
          await dbClient.query(
            `DELETE FROM member_access_sources WHERE access_id = $1`,
            [memberId]
          );
        }

        await dbClient.query(
          `UPDATE member_access SET status = $1, updated_at = NOW() WHERE id = $2`,
          [targetStatus, memberId]
        );
      } else {
        // 'disabled' path — preserve source rows, just update status
        await dbClient.query(
          `UPDATE member_access SET status = $1, updated_at = NOW() WHERE id = $2`,
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
   * Sets member_access.status = lockStatus (default: 'failed').
   * Increments errors_count in client_activity_summary (except for pending_hardware).
   *
   * Never throws — error handling in the error path must be bulletproof.
   *
   * @param {string} memberId   member_access.id
   * @param {string} tenantId
   * @param {string} lockStatus  default 'failed'
   * @param {Object} [options]   optional: { planId } — stored for pending_hardware retry
   */
  async releaseLock(memberId, tenantId, lockStatus = 'failed', options = {}) {
    if (lockStatus === 'pending_hardware' && options.planId) {
      await db.query(
        `UPDATE member_access SET status = $1, pending_plan_id = $2, updated_at = NOW() WHERE id = $3`,
        [lockStatus, options.planId, memberId]
      ).catch(err =>
        log.error('adapter.pending_hardware_failed', { memberId }, err)
      );
    } else {
      await db.query(
        `UPDATE member_access SET status = $1, updated_at = NOW() WHERE id = $2`,
        [lockStatus, memberId]
      ).catch(err =>
        log.error('adapter.lock_release_failed', { memberId }, err)
      );
    }

    if (lockStatus !== 'pending_hardware') {
      this._incrementActivity(tenantId, 'errors_count').catch(err =>
        log.warn('adapter.activity_update_failed', { field: 'errors_count' }, err)
      );
    }
  }

  /**
   * Parks a member whose Kisi user has been created but group assignment is deferred
   * because the plan's startDate is in the future.
   *
   * @param {string} memberId   member_access.id
   * @param {string} tenantId
   * @param {string} scheduledStartDate  ISO-8601 string
   */
  async parkPendingStart(memberId, tenantId, scheduledStartDate) {
    await db.query(
      `UPDATE member_access
       SET status = 'pending_start', scheduled_start_date = $2, updated_at = NOW()
       WHERE id = $1`,
      [memberId, scheduledStartDate]
    );
    this._incrementActivity(tenantId, 'events_received').catch(err =>
      log.warn('adapter.activity_update_failed', { field: 'events_received' }, err)
    );
  }

  /**
   * Daily UPSERT for client_activity_summary (DR-024).
   * Fault-tolerant — all callers .catch() this. Never awaited in critical paths.
   * UNCHANGED from prior schema.
   *
   * @param {string} tenantId
   * @param {string} field  one of: events_received, grants_completed, revokes_completed, errors_count
   */
  async _incrementActivity(tenantId, field) {
    const allowed = ['events_received', 'grants_completed', 'revokes_completed', 'errors_count'];
    if (!allowed.includes(field)) throw new Error(`Unknown activity field: ${field}`);

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
  async _callHardwareToResolveIdentity(hardwarePlatform, apiKey, email, name, options = {}) {
    let hardwareUserId = await hardwareAdapter.findUserByEmail(hardwarePlatform, apiKey, email);
    if (hardwareUserId) {
      log.info('adapter.identity_found', { hardwarePlatform, hardwareUserId });
      return hardwareUserId;
    }
    log.info('adapter.identity_creating', { hardwarePlatform, email, userPattern: options.userPattern || 'invited' });
    try {
      return await hardwareAdapter.createUser(hardwarePlatform, apiKey, email, name, options);
    } catch (err) {
      // Kisi 409 'The record already exists' — user was created between findUserByEmail and createUser.
      // Causes: concurrent grants for same member, search index lag, prior partial run.
      // Recovery: re-query by email; if found, reuse that ID.
      const isAlreadyExists =
        (err.statusCode === 409 || err.status === 409) &&
        /already exists/i.test(err.message || '');
      if (!isAlreadyExists) throw err;

      log.warn('adapter.identity.create_409_recovering', {
        hardwarePlatform, email,
        message: 'Kisi returned 409 on createUser — re-querying by email to reuse existing ID',
      });
      hardwareUserId = await hardwareAdapter.findUserByEmail(hardwarePlatform, apiKey, email);
      if (hardwareUserId) {
        log.info('adapter.identity.create_409_recovered', { hardwarePlatform, hardwareUserId, email });
        return hardwareUserId;
      }
      // Re-query failed too — surface the original 409.
      throw err;
    }
  }

  /**
   * OB-89 Gate 2 — recovery ladder for missing identity inputs.
   * Returns { email, name, source } on success, or null when exhausted.
   *
   * Tier 1: Wix Members API — authoritative, fetches current loginEmail + name.
   * Tier 2: DB cache — member_master.email from a prior event.
   * Tier 3: None — return null, caller parks as pending_identity.
   */
  async _recoverMissingEmail(memberId, tenantId, platformMemberId) {
    if (!tenantId || !platformMemberId) {
      log.warn('adapter.identity.gate2_skipped', {
        memberId, reason: 'missing_tenantId_or_platformMemberId',
      });
      return null;
    }

    // Tier 1: Wix Members API
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
          // DR-001-A narrow Gate 2 write path — cache to member_master
          // Resolve member_master_id from member_access
          const masterIdRow = (await db.query(
            `SELECT member_master_id FROM member_access WHERE id = $1`, [memberId]
          )).rows[0];
          if (masterIdRow) {
            await db.query(
              `UPDATE member_master
               SET email        = COALESCE($2, email),
                   first_name   = COALESCE($3, first_name),
                   last_name    = COALESCE($4, last_name),
                   display_name = COALESCE($5, display_name),
                   phone        = COALESCE($6, phone),
                   updated_at   = NOW()
               WHERE id = $1`,
              [
                masterIdRow.member_master_id,
                member.email, member.firstName, member.lastName,
                member.name, member.phone,
              ]
            ).catch(err => {
              log.warn('adapter.identity.gate2_cache_write_failed', { memberId, code: err.code }, err);
            });
          }

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
      log.error('adapter.identity.gate2_tier1_failed', {
        memberId, platformMemberId, httpStatus: err.statusCode, code: err.code,
      }, err);
    }

    // Tier 2: DB cache — member_master.email
    try {
      const masterIdRow = (await db.query(
        `SELECT member_master_id FROM member_access WHERE id = $1`, [memberId]
      )).rows[0];
      if (masterIdRow) {
        const cached = (await db.query(
          `SELECT email, display_name, first_name, last_name
           FROM member_master WHERE id = $1`,
          [masterIdRow.member_master_id]
        )).rows[0];
        if (cached?.email) {
          const composed = [cached.first_name, cached.last_name].filter(Boolean).join(' ').trim();
          return {
            email: cached.email,
            name: cached.display_name || composed || cached.email,
            source: 'db_cache',
          };
        }
      }
    } catch (err) {
      log.error('adapter.identity.gate2_tier2_failed', { memberId }, err);
    }

    return null;
  }

  /**
   * OB-89 Gate 2 — park a member whose grant cannot proceed.
   * Transitions member_access.status from 'in_flight' to 'pending_identity'.
   *
   * @param {string} memberId   member_access.id
   */
  async _parkPendingIdentity(memberId, tenantId, missingFields) {
    try {
      await db.query(
        `UPDATE member_access
         SET status = 'pending_identity', updated_at = NOW()
         WHERE id = $1`,
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
