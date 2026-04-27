/**
 * @file reconciliation.js
 * @layer core/layer4
 * @role cron-nightly
 * @schedule nightly via Railway Cron
 * @reads member_access_state, error_queue, locations, clients (source_api_key, source_site_id, reconciliation_interval, last_sync_at), member_identity, member_role_assignments, member_access_sources, plan_mappings
 * @writes member_access_state, config_alert_log, clients (last_sync_at)
 * @calls hardware-adapter (getLocks, getManagedRoleAssignments), wix-plans-api (listActiveOrders, listConfirmedBookings), plan-mapping-resolver (resolve), BullMQ (re-queue), resend (digest)
 * @exports instance (NightlyReconciliation) — exposes runNightlySweep, _syncClient, reconcileMember
 * @dr DR-003, DR-008, DR-018, DR-020, DR-023, DR-034, DR-037
 *
 * reconciliation.js
 * Core Engine (Layer 4) - Standalone script triggered by cron
 *
 * Responsibilities:
 * - Sweeps for jobs with status IN ('failed', 'skipped_lockdown')
 * - Ensures jobs are tagged source_tag = 'accesssync' (DR-003)
 * - Checks physical door lockdown state via Kisi GET /locks
 * - Re-queues eligible jobs to BullMQ (NOT direct grant-revoke — respects in_flight lock)
 * - Packages unresolved errors into a nightly digest (Resend, DR-020)
 */

const crypto = require('crypto');
const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { eventQueue } = require('./webhook-processor');
const { decryptApiKey } = require('./crypto-utils');
const { listActiveOrders, listConfirmedBookings } = require('../adapters/wix/wix-plans-api');
const planMappingResolver = require('./plan-mapping-resolver');
const { log, withTrace } = require('./logger');
const { runWith, mintTraceId } = require('./trace-context');

class NightlyReconciliation {

  constructor() {
    this.staleThresholdMinutes = 10;
  }

  /**
   * Main entry point for the Railway Cron Job
   */
  async runNightlySweep() {
    const sweepTraceId = mintTraceId();
    return runWith(
      { traceId: sweepTraceId, actor: { type: 'system', id: 'reconciliation-cron' } },
      () => this._runNightlySweepBody(sweepTraceId)
    );
  }

  async _runNightlySweepBody(sweepTraceId) {
    const sweepLogger = withTrace(sweepTraceId);
    this._sweepTraceId = sweepTraceId;
    this._sweepLogger = sweepLogger;
    sweepLogger.info('reconciliation.sweep_start', { stage: 'cron', result: 'start' });

    try {
      // Recurrence gate: skip if not enough time has elapsed since last sweep (DR-018)
      // Uses the first active client's reconciliation_interval as a global gate (V1: single client).
      const lastSyncResult = await db.query(
        `SELECT last_sync_at, COALESCE(reconciliation_interval, 'daily') AS interval
         FROM clients WHERE status = 'active' LIMIT 1`
      );
      const { last_sync_at, interval } = lastSyncResult.rows[0] || {};
      const intervalMs = { hourly: 3600000, '6h': 21600000, '12h': 43200000, daily: 86400000, weekly: 604800000 };
      const minMs = intervalMs[interval] || 86400000;
      if (last_sync_at && (Date.now() - new Date(last_sync_at).getTime()) < minMs) {
        sweepLogger.info('reconciliation.skipped', { reason: 'interval_not_elapsed', interval, stage: 'cron', result: 'skipped' });
        return;
      }

      // Step 0: True-source sync — Wix ↔ DB diff, queue corrections for missing/lapsed members
      await this._syncTrueSources();

      // Step 1: Clean up stale in_flight records (crash protection)
      await db.query(
        `UPDATE member_access_state
         SET status = 'failed', updated_at = NOW()
         WHERE status = 'in_flight'
           AND updated_at < NOW() - INTERVAL '${this.staleThresholdMinutes} minutes'`
      );
      sweepLogger.info('reconciliation.stale_reset', { stage: 'cron', result: 'success' });

      // Step 2: Sync Door Lockdown States
      await this._syncDoorLockdownStates();

      // Step 3: Fetch Actionable Records
      const recordsToProcess = await this._fetchActionableRecords();
      sweepLogger.info('reconciliation.actionable_records', { count: recordsToProcess.length, stage: 'cron', result: 'success' });

      // Step 4: Re-process records with rate limit compliance
      for (const record of recordsToProcess) {
        await this._processRecordTargeted(record);
        await this._sleep(250); // Respect Kisi 5 req/sec (DR-008)
      }

      // Step 5: Send Operator Email Digest
      await this._generateAndSendDigest();

      // Update last_sync_at for all active clients (DR-018)
      await db.query(`UPDATE clients SET last_sync_at = NOW() WHERE status = 'active'`);

      sweepLogger.info('reconciliation.sweep_complete', { stage: 'cron', result: 'success' });
    } catch (error) {
      sweepLogger.critical('reconciliation.sweep_failed', { stage: 'cron', result: 'failed' }, error);
    }
  }

  /**
   * Step 0: Pull Wix active orders + confirmed bookings, diff against member_identity.
   * Queue synthetic grant/revoke jobs for any mismatches found.
   *
   * Sub-members (platform_member_id containing '###as' or plan_holder_id IS NOT NULL)
   * are operator-managed — they are excluded from the Wix absence revoke check.
   */
  async _syncTrueSources() {
    const sweepLogger = this._sweepLogger || log;
    const sweepTraceId = this._sweepTraceId || null;
    sweepLogger.info('reconciliation.wix_sync_start', { traceId: sweepTraceId, stage: 'cron', result: 'start' });

    const clientsResult = await db.query(
      `SELECT id, source_site_id, source_api_key, hardware_api_key, hardware_platform
       FROM clients
       WHERE status = 'active'
         AND source_api_key IS NOT NULL
         AND source_site_id IS NOT NULL`
    );

    for (const client of clientsResult.rows) {
      try {
        await this._syncClient(client);
      } catch (err) {
        log.error('reconciliation.client_sync_failed', { clientId: client.id }, err);
        // One client failure must not abort the full sweep
      }
    }

    sweepLogger.info('reconciliation.wix_sync_complete', { traceId: sweepTraceId, stage: 'cron', result: 'success' });
  }

  /**
   * Diff a single client's Wix active members against live Kisi state, queue corrections.
   * Returns { granted, revoked } so callers (manual sync endpoint) can surface the counts.
   *
   * Sources of truth:
   *   Wix  — who should have access (active orders + confirmed bookings)
   *   Kisi — who currently has access (live role assignments, filtered to AccessSync users)
   *
   * The DB is used only as a bridge: member_identity.hardware_user_id maps Kisi user IDs
   * back to Wix platform_member_ids, and source_tag = 'accesssync' filters out staff/contractors.
   */
  async _syncClient(client) {
    const wixApiKey      = decryptApiKey(client.source_api_key);
    const hardwareApiKey = decryptApiKey(client.hardware_api_key);
    const hardwarePlatform = client.hardware_platform || 'kisi';
    const siteId = client.source_site_id;

    let granted = 0;
    let revoked = 0;

    // 1. Pull Wix side — active plan orders + confirmed bookings.
    //
    // OB-87: FAIL CLOSED. If EITHER Wix fetch throws, we cannot distinguish
    // "member has no active plan" from "Wix API is broken." An empty-but-valid
    // response from a broken endpoint would cause a mass revoke of real members.
    // So: on any fetch error, flag config_alert_log and abort this client's sync
    // entirely — no grants, no revokes. Nightly digest will surface the alert.
    let orders, bookings;
    try {
      [orders, bookings] = await Promise.all([
        listActiveOrders(wixApiKey, siteId),
        listConfirmedBookings(wixApiKey, siteId),
      ]);
    } catch (err) {
      log.error('reconciliation.wix_fetch_failed', {
        clientId: client.id, siteId,
        wixStatus: err.status || null,
        wixCode:   err.code || null,
      }, err);
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'wix_api_unavailable', $2)`,
        [client.id, `status=${err.status || 'unknown'} code=${err.code || 'unknown'}`]
      ).catch(() => {}); // Fault-tolerant — never block digest
      // Abort this client's sync. Do NOT fall through to compare/revoke.
      return { granted: 0, revoked: 0, aborted: true, reason: 'wix_api_unavailable' };
    }

    // Map: wixMemberId → { planId, email, name }
    // Orders take precedence; bookings fill in members not already seen
    const wixMembers = new Map();
    for (const o of orders) {
      if (o.memberId) wixMembers.set(o.memberId, { planId: o.planId, email: o.email, name: o.name });
    }
    for (const b of bookings) {
      if (b.memberId && !wixMembers.has(b.memberId)) {
        wixMembers.set(b.memberId, { planId: b.planId, email: b.email, name: b.name });
      }
    }

    // 2. Pull Kisi side — live role assignments, filtered to AccessSync-managed users via DB join
    const kisiAssignments = await hardwareAdapter.getManagedRoleAssignments(hardwarePlatform, hardwareApiKey);
    const kisiUserIds = [...new Set(kisiAssignments.map(a => a.userId).filter(Boolean))];

    // Map: platform_member_id (Wix member ID) → { isSubMember }
    // Only includes users AccessSync created (source_tag = 'accesssync').
    // Staff, contractors, manually-added Kisi users have no member_identity row and are excluded.
    const kisiMembers = new Map();

    if (kisiUserIds.length > 0) {
      const identityResult = await db.query(
        `SELECT platform_member_id, plan_holder_id
         FROM member_identity
         WHERE client_id = $1
           AND source_tag = 'accesssync'
           AND hardware_user_id = ANY($2)`,
        [client.id, kisiUserIds]
      );
      for (const row of identityResult.rows) {
        kisiMembers.set(row.platform_member_id, {
          isSubMember: row.plan_holder_id !== null || row.platform_member_id.includes('###as'),
        });
      }
    }

    // 3A. In Wix, not in Kisi → paid but not provisioned → queue grant
    for (const [memberId, wixData] of wixMembers) {
      if (kisiMembers.has(memberId)) continue;

      if (!wixData.planId) {
        log.warn('reconciliation.wix_order_no_plan_id', { clientId: client.id, memberId });
        continue;
      }

      const recoEventId = `recon-${client.id}-${memberId}-${Date.now()}`;
      const syntheticEvent = {
        eventType:        'plan.purchased',
        sourcePlatform:   'wix',
        platformMemberId: memberId,
        planId:           wixData.planId,
        email:            wixData.email,
        name:             wixData.name,
        wixSiteId:        siteId,
        synthetic:        true,
        syntheticSource:  'reconciliation.true_source_sync',
        traceId:          this._sweepTraceId,
        eventId:          recoEventId,
      };

      const jobId = `grant-wix-sync-${client.id}-${memberId}-${Date.now()}`;
      await eventQueue.add('grant', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
      log.info('reconciliation.grant_queued', {
        clientId: client.id, memberId: wixData.memberId || null,
        platformMemberId: memberId,
        planId: wixData.planId, jobId, eventId: recoEventId,
        traceId: this._sweepTraceId,
        sourceType: 'cron', stage: 'cron', result: 'success',
      });
      granted++;
    }

    // 3B. In Kisi (AccessSync-managed, primary members only), not in Wix → cancelled/lapsed → queue revoke
    for (const [memberId, kisiData] of kisiMembers) {
      if (kisiData.isSubMember) continue;     // Operator-managed — never revoke based on Wix absence
      if (wixMembers.has(memberId)) continue; // Still active in Wix

      const recoEventId = `recon-${client.id}-${memberId}-${Date.now()}`;
      const syntheticEvent = {
        eventType:        'plan.cancelled',
        sourcePlatform:   'wix',
        platformMemberId: memberId,
        wixSiteId:        siteId,
        synthetic:        true,
        syntheticSource:  'reconciliation.true_source_sync',
        traceId:          this._sweepTraceId,
        eventId:          recoEventId,
      };

      const jobId = `revoke-wix-sync-${client.id}-${memberId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
      log.info('reconciliation.revoke_queued', {
        clientId: client.id, platformMemberId: memberId,
        jobId, eventId: recoEventId,
        traceId: this._sweepTraceId,
        sourceType: 'cron', stage: 'cron', result: 'success',
      });
      revoked++;
    }

    log.info('reconciliation.client_sync_complete', {
      clientId: client.id, siteId,
      wixActive: wixMembers.size, kisiManaged: kisiMembers.size,
      granted, revoked,
    });

    return { granted, revoked };
  }

  /**
   * Reconcile a single member's access state against Wix and the hardware platform.
   *
   * Closes OB-49 at the per-member level: detects database drift (missing
   * member_role_assignments / member_access_sources rows) and surfaces config
   * integrity issues that require operator attention.
   *
   * Architectural rules (DR-023):
   *  - This function NEVER writes member_role_assignments or member_access_sources
   *    directly. All repairs flow through Standard Adapter Layer (L3) via the
   *    event queue, which makes completeGrant() handle the inserts idempotently.
   *  - Sub-members (plan_holder_id != null OR platform_member_id contains '###as')
   *    are operator-managed and skipped; reconcile the plan holder instead.
   *
   * Result actions (one of):
   *   ok                   — DB matches Wix and hardware. No changes.
   *   repaired              — Wix says active, hardware has access, but DB rows
   *                           were missing. Synthetic grant queued to L3 to
   *                           re-insert tracking rows (Kisi call is idempotent).
   *   access_restored       — Wix active, no hardware access. Grant queued.
   *   access_removed        — No active Wix sub, but hardware still had access.
   *                           Revoke queued.
   *   needs_attention       — Integrity issue surfaced. No grant/revoke fires.
   *                           See `alerts` array. Operator must resolve.
   *   wix_unavailable       — Wix API failed. No changes made. Retry later.
   *   no_identity           — Member not provisioned in AccessSync (no member_identity row).
   *   sub_member_skipped    — Caller passed a sub-member; reconcile plan holder instead.
   *
   * @param {string} memberId  - member_identity.id (UUID)
   * @param {string} clientId  - clients.id (UUID)
   * @returns {Object} { action, granted, revoked, repaired, alerts: [...] }
   */
  async reconcileMember(memberId, clientId) {
    const traceId = crypto.randomUUID();
    const result = { action: null, granted: 0, revoked: 0, repaired: 0, alerts: [] };

    // 1. Load client + verify active and configured
    const clientRes = await db.query(
      `SELECT id, source_site_id, source_api_key, hardware_api_key, hardware_platform
       FROM clients WHERE id = $1 AND status = 'active'`,
      [clientId]
    );
    if (!clientRes.rows.length) {
      result.action = 'no_identity';
      result.alerts.push({ code: 'client_not_active', detail: 'Client not found or not active.' });
      return result;
    }
    const client = clientRes.rows[0];
    if (!client.source_api_key || !client.hardware_api_key) {
      result.action = 'needs_attention';
      result.alerts.push({
        code: 'client_not_configured',
        detail: 'This client is missing the Wix or hardware API key. Finish onboarding before reconciling members.',
      });
      return result;
    }

    // 2. Load member_identity, guard against sub-members
    const identityRes = await db.query(
      `SELECT id, platform_member_id, hardware_user_id, plan_holder_id, source_tag
       FROM member_identity WHERE id = $1 AND client_id = $2`,
      [memberId, clientId]
    );
    if (!identityRes.rows.length) {
      result.action = 'no_identity';
      result.alerts.push({
        code: 'no_member_identity',
        detail: 'No record of this member in AccessSync. They may not have been provisioned yet.',
      });
      return result;
    }
    const identity = identityRes.rows[0];
    const isSubMember = identity.plan_holder_id !== null
      || (identity.platform_member_id || '').includes('###as');
    if (isSubMember) {
      result.action = 'sub_member_skipped';
      result.alerts.push({
        code: 'sub_member',
        detail: 'This is a sub-member on a multi-member plan. Reconcile the plan holder to fix sub-member access.',
      });
      return result;
    }

    const platformMemberId = identity.platform_member_id;
    const hardwareUserId   = identity.hardware_user_id;
    const wixApiKey        = decryptApiKey(client.source_api_key);
    const hardwareApiKey   = decryptApiKey(client.hardware_api_key);
    const hardwarePlatform = client.hardware_platform || 'kisi';
    const siteId           = client.source_site_id;

    // 3. Pull Wix subscriptions for this member (filtered from full list — V1)
    let activePlans;
    try {
      const [orders, bookings] = await Promise.all([
        listActiveOrders(wixApiKey, siteId),
        listConfirmedBookings(wixApiKey, siteId),
      ]);
      activePlans = [];
      for (const o of orders) {
        if (o.memberId === platformMemberId && o.planId) {
          activePlans.push({ planId: o.planId, sourceType: 'plan', email: o.email, name: o.name });
        }
      }
      for (const b of bookings) {
        if (b.memberId === platformMemberId && b.planId &&
            !activePlans.some(p => p.planId === b.planId)) {
          activePlans.push({ planId: b.planId, sourceType: 'booking', email: b.email, name: b.name });
        }
      }
    } catch (err) {
      log.error('reconcileMember.wix_fetch_failed', { clientId, memberId, traceId }, err);
      result.action = 'wix_unavailable';
      result.alerts.push({
        code: 'wix_api_unavailable',
        detail: 'Could not reach Wix to look up this member’s plans. No changes were made. Try again in a few minutes.',
      });
      return result;
    }

    // 4. Resolve current plan mappings — surface integrity issues, do not auto-fix
    const expectedGroupIds = new Set();           // hardware groups this member SHOULD be in
    const expectedAssignments = [];               // for grant repair: { planId, mappingId, hardwareGroupId, sourceType }
    let abortDueToIntegrity = false;

    for (const plan of activePlans) {
      const mappings = await planMappingResolver.resolve(clientId, plan.planId);

      if (mappings === null) {
        // Plan not recognized at all — operator hasn't mapped this Wix plan yet
        result.alerts.push({
          code: 'no_mapping_for_plan',
          detail: `This member has an active plan that isn’t mapped to any door yet. Open Plan Mappings and map plan “${plan.planId}” to a door group so they can get access.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }
      if (mappings.length === 0) {
        // Plan is mapped but no hardware group is set — Wix-first scenario
        result.alerts.push({
          code: 'mapping_missing_group',
          detail: `A mapping exists for this member’s plan, but no door group is assigned to it. Open Plan Mappings and finish setting up plan “${plan.planId}”.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }

      // Detect duplicate mappings claiming the same source_plan_id
      const uniqueMappingIds = new Set(mappings.map(m => m.mappingId));
      // Multi-group mappings legitimately produce one row per group with the same mappingId.
      // Distinct mappingIds for the same planId means duplicate plan_mappings entries.
      const distinctMappings = uniqueMappingIds.size;
      if (distinctMappings > 1) {
        result.alerts.push({
          code: 'duplicate_mappings_for_plan',
          detail: `Two or more plan mappings are set up for the same Wix plan. AccessSync can’t tell which one to use, so nothing was changed for this member. Review Plan Mappings and remove the duplicate.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }

      for (const m of mappings) {
        if (m.hardwareGroupId) {
          expectedGroupIds.add(m.hardwareGroupId);
          expectedAssignments.push({
            planId: plan.planId,
            sourceType: plan.sourceType,
            mappingId: m.mappingId,
            hardwareGroupId: m.hardwareGroupId,
          });
        }
      }
    }

    if (abortDueToIntegrity) {
      // Log to config_alert_log so the nightly digest surfaces unresolved issues
      for (const a of result.alerts) {
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
           VALUES ($1, $2, $3)`,
          [clientId, a.code, a.planId || platformMemberId]
        ).catch(e => log.error('reconcileMember.alert_log_failed', { clientId, code: a.code }, e));
      }
      result.action = 'needs_attention';
      log.info('reconcileMember.integrity_blocked', {
        clientId, memberId, platformMemberId, alertCount: result.alerts.length, traceId,
      });
      return result;
    }

    // 5. Pull live hardware role assignments for this member
    let actualGroupIds = new Set();
    if (hardwareUserId) {
      const allAssignments = await hardwareAdapter.getManagedRoleAssignments(hardwarePlatform, hardwareApiKey);
      actualGroupIds = new Set(
        allAssignments.filter(a => a.userId === hardwareUserId).map(a => a.groupId).filter(Boolean)
      );
    }

    // Untraceable hardware access: in Kisi but no Wix subscription justifies it
    const untraceable = [...actualGroupIds].filter(g => !expectedGroupIds.has(g));
    const missingHardware = [...expectedGroupIds].filter(g => !actualGroupIds.has(g));

    // 6. Check DB row drift — even when hardware matches Wix, member_role_assignments
    //    or member_access_sources rows may be missing (this is the bug Daxx hit).
    const dbAssignmentRes = await db.query(
      `SELECT hardware_group_id FROM member_role_assignments WHERE member_id = $1`,
      [memberId]
    );
    const dbGroupIds = new Set(dbAssignmentRes.rows.map(r => r.hardware_group_id).filter(Boolean));
    const dbSourceRes = await db.query(
      `SELECT hardware_group_id FROM member_access_sources WHERE member_id = $1`,
      [memberId]
    );
    const dbSourceGroupIds = new Set(dbSourceRes.rows.map(r => r.hardware_group_id).filter(Boolean));

    const dbMissingForExpected = [...expectedGroupIds].filter(
      g => !dbGroupIds.has(g) || !dbSourceGroupIds.has(g)
    );

    // 7. Decide and act

    // 7a. Case: hardware has access from a source we can't trace (no active Wix sub)
    if (untraceable.length > 0 && expectedGroupIds.size === 0) {
      result.alerts.push({
        code: 'untraceable_hardware_access',
        detail: 'This member has door access in the hardware system, but we can’t find a reason for it — no active plan, no booking, no operator override. Review the member’s history and decide whether to keep or remove their access.',
      });
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'untraceable_hardware_access', $2)`,
        [clientId, platformMemberId]
      ).catch(e => log.error('reconcileMember.alert_log_failed', { clientId }, e));
      result.action = 'needs_attention';
      log.info('reconcileMember.untraceable', { clientId, memberId, platformMemberId, traceId });
      return result;
    }

    // 7b. Case: no active Wix subs, hardware has access → revoke
    if (expectedGroupIds.size === 0 && actualGroupIds.size > 0) {
      const recoEventId = `recon-mbr-${clientId}-${platformMemberId}-${Date.now()}`;
      const syntheticEvent = {
        eventType:        'plan.cancelled',
        sourcePlatform:   'wix',
        platformMemberId,
        wixSiteId:        siteId,
        synthetic:        true,
        syntheticSource:  'reconciliation.reconcile_member',
        traceId,
        eventId:          recoEventId,
      };
      const jobId = `revoke-mbr-sync-${clientId}-${platformMemberId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
      result.revoked = 1;
      result.action = 'access_removed';
      log.info('reconcileMember.revoke_queued', { clientId, memberId, platformMemberId, jobId, traceId });
      return result;
    }

    // 7c. Case: hardware missing groups for active Wix subs → grant
    if (missingHardware.length > 0) {
      // One synthetic grant per active plan covers all missing groups
      // (queue-worker resolves mappings fresh and processes all groups for the plan).
      for (const plan of activePlans) {
        const recoEventId = `recon-mbr-${clientId}-${platformMemberId}-${Date.now()}`;
        const syntheticEvent = {
          eventType:        'plan.purchased',
          sourcePlatform:   'wix',
          platformMemberId,
          planId:           plan.planId,
          email:            plan.email,
          name:             plan.name,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.reconcile_member',
          traceId,
          eventId:          recoEventId,
        };
        const jobId = `grant-mbr-sync-${clientId}-${platformMemberId}-${plan.planId}-${Date.now()}`;
        await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
        result.granted++;
      }
      result.action = 'access_restored';
      log.info('reconcileMember.grant_queued', {
        clientId, memberId, platformMemberId, planCount: activePlans.length, traceId,
      });
      return result;
    }

    // 7d. Case: hardware matches Wix, but DB tracking rows are missing → repair
    //     Queue a synthetic grant; completeGrant() in L3 will INSERT missing rows
    //     idempotently (ON CONFLICT DO NOTHING). Kisi assignRole is idempotent —
    //     re-assigning an existing role returns the existing role.
    if (dbMissingForExpected.length > 0) {
      for (const plan of activePlans) {
        const recoEventId = `recon-mbr-repair-${clientId}-${platformMemberId}-${Date.now()}`;
        const syntheticEvent = {
          eventType:        'plan.purchased',
          sourcePlatform:   'wix',
          platformMemberId,
          planId:           plan.planId,
          email:            plan.email,
          name:             plan.name,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.reconcile_member.repair',
          traceId,
          eventId:          recoEventId,
        };
        const jobId = `repair-mbr-sync-${clientId}-${platformMemberId}-${plan.planId}-${Date.now()}`;
        await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
        result.repaired++;
      }
      result.action = 'repaired';
      log.info('reconcileMember.repair_queued', {
        clientId, memberId, platformMemberId,
        missingDbGroups: dbMissingForExpected.length, traceId,
      });
      return result;
    }

    // 7e. All clear
    result.action = 'ok';
    log.info('reconcileMember.ok', { clientId, memberId, platformMemberId, traceId });
    return result;
  }

  async _syncDoorLockdownStates() {
    // Per-location iteration: each active location has its own platform + key
    const locationsResult = await db.query(
      `SELECT l.id AS location_id, l.client_id,
              COALESCE(l.hardware_platform, c.hardware_platform, 'kisi') AS hardware_platform,
              COALESCE(l.hardware_api_key, c.hardware_api_key) AS hardware_api_key
       FROM locations l
       JOIN clients c ON l.client_id = c.id
       WHERE c.status = 'active' AND l.subscription_status = 'active'`
    );

    for (const loc of locationsResult.rows) {
      const apiKey = loc.hardware_api_key ? decryptApiKey(loc.hardware_api_key) : null;
      if (!apiKey) {
        log.warn('reconciliation.no_api_key', { locationId: loc.location_id });
        continue;
      }

      const locks = await hardwareAdapter.getLocks(loc.hardware_platform, apiKey);
      // DR-035: getLocks() normalized return shape — each adapter returns { id, name, locked: boolean }.
      // 'locked' is the canonical field. Adapters are responsible for mapping platform-specific fields.
      const lockedDoors = locks.filter(l => l.locked === true);
      for (const door of lockedDoors) {
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, last_seen_at)
           VALUES ($1, 'lockdown_detected', $2, NOW())`,
          [loc.client_id, String(door.id || door.name || 'unknown')]
        ).catch(e => log.error('reconciliation.lockdown_alert_failed', { clientId: loc.client_id }, e));
      }
    }
  }

  async _fetchActionableRecords() {
    const result = await db.query(
      `SELECT mas.id, mas.status, mas.member_id, mas.client_id,
              mi.platform_member_id, mi.hardware_platform, mi.source_platform
       FROM member_access_state mas
       JOIN member_identity mi ON mi.id = mas.member_id
       WHERE mas.status IN ('failed', 'skipped_lockdown')
         AND mi.source_tag = 'accesssync'`
    );
    return result.rows;
  }

  async _processRecordTargeted(record) {
    // 1. Fetch the latest failed event payload from error_queue
    const errorResult = await db.query(
      `SELECT event_type, payload FROM error_queue
       WHERE member_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [record.member_id]
    );

    if (errorResult.rows.length === 0) {
      log.warn('reconciliation.no_error_entry', { memberId: record.member_id });
      return;
    }

    const { event_type: eventType, payload } = errorResult.rows[0];
    let standardEvent;
    try {
      standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      log.error('reconciliation.payload_parse_failed', { memberId: record.member_id }, e);
      return;
    }

    const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
      ? 'grant'
      : 'revoke';

    // 2. Re-queue to BullMQ — respects in_flight lock and concurrency controls (not direct grant-revoke call)
    await eventQueue.add(jobName, { tenantId: record.client_id, standardEvent });
    log.info('reconciliation.requeued', { jobName, memberId: record.member_id, platformMemberId: record.platform_member_id });
  }

  async _generateAndSendDigest() {
    const sweepLogger = this._sweepLogger || log;
    const sweepTraceId = this._sweepTraceId || null;

    // Query both failure categories — operator needs both (NOVA spec)
    const configAlertsResult = await db.query(
      `SELECT client_id, alert_type, hardware_ref, created_at
       FROM config_alert_log
       WHERE resolved_at IS NULL
       ORDER BY client_id, created_at DESC`
    );

    const failedJobsResult = await db.query(
      `SELECT client_id, member_id, event_type, error_reason, created_at
       FROM error_queue
       WHERE status = 'failed'
       ORDER BY client_id, created_at DESC`
    );

    const digest = {
      generatedAt: new Date().toISOString(),
      configAlerts: configAlertsResult.rows,
      failedJobs: failedJobsResult.rows,
    };

    sweepLogger.info('reconciliation.digest', { traceId: sweepTraceId, configAlerts: digest.configAlerts.length, failedJobs: digest.failedJobs.length, stage: 'cron', result: 'success' });

    if (configAlertsResult.rows.length === 0 && failedJobsResult.rows.length === 0) {
      sweepLogger.info('reconciliation.digest_empty', { traceId: sweepTraceId, stage: 'cron', result: 'skipped' });
      return;
    }

    // DR-020: Send nightly digest via Resend — same pattern as retry-engine._notifyOperator
    const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;
    if (!toEmail) {
      log.warn('reconciliation.no_notification_email', {});
      return;
    }

    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const lines = [
        `AccessSync Nightly Digest — ${digest.generatedAt}`,
        '',
        `Config Alerts (unresolved): ${digest.configAlerts.length}`,
        ...digest.configAlerts.map(a => `  - [${a.alert_type}] ref: ${a.hardware_ref}`),
        '',
        `Failed Jobs (in error_queue): ${digest.failedJobs.length}`,
        ...digest.failedJobs.map(j => `  - [${j.event_type}] member: ${j.member_id} | ${j.error_reason}`),
      ];
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
        to: toEmail,
        subject: '[AccessSync] Nightly digest',
        text: lines.join('\n'),
      });
      sweepLogger.info('reconciliation.digest_sent', { traceId: sweepTraceId, toEmail, stage: 'cron', result: 'success' });
    } catch (err) {
      sweepLogger.error('reconciliation.digest_send_failed', { traceId: sweepTraceId, toEmail, stage: 'cron', result: 'failed' }, err);
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// --- Export and Executable Wrapper ---
const instance = new NightlyReconciliation();
module.exports = instance;

// If run directly via `node core/reconciliation.js`
if (require.main === module) {
  instance.runNightlySweep().then(() => {
    process.exit(0);
  }).catch(err => {
    log.critical('reconciliation.fatal', {}, err);
    process.exit(1);
  });
}
