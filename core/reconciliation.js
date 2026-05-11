/**
 * @file reconciliation.js
 * @layer core/layer4
 * @role cron-nightly
 * @schedule nightly via Railway Cron
 * @reads member_access, member_master, error_queue, locations, clients (source_api_key, source_site_id, reconciliation_interval, last_sync_at), member_access_sources, plan_mappings
 * @writes member_access, config_alert_log, clients (last_sync_at)
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
const { runWith, mintTraceId, getTraceId, getActor } = require('./trace-context');

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
        `UPDATE member_access
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
   * Step 0: Pull Wix active orders + confirmed bookings, diff against member_master/member_access.
   * Queue synthetic grant/revoke jobs for any mismatches found.
   *
   * Sub-members (platform_member_id containing '###as' or sub_master_id IS NOT NULL)
   * are operator-managed — they are excluded from the Wix absence revoke check.
   */
  async _syncTrueSources() {
    const sweepLogger = this._sweepLogger || log;
    const sweepTraceId = this._sweepTraceId || null;
    sweepLogger.info('reconciliation.wix_sync_start', { traceId: sweepTraceId, stage: 'cron', result: 'start' });

    const clientsResult = await db.query(
      `SELECT c.id, c.source_site_id, c.source_api_key, c.last_active_member_count,
              cs.hardware_api_key, cs.hardware_platform
       FROM clients c
       JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       WHERE c.status = 'active'
         AND c.source_api_key IS NOT NULL
         AND c.source_site_id IS NOT NULL`
    );

    for (const client of clientsResult.rows) {
      try {
        await this._syncClient(client, { triggeredBy: 'cron' });
      } catch (err) {
        log.error('reconciliation.client_sync_failed', { clientId: client.id }, err);
        // One client failure must not abort the full sweep
      }
    }

    sweepLogger.info('reconciliation.wix_sync_complete', { traceId: sweepTraceId, stage: 'cron', result: 'success' });
  }

  /**
   * Diff a single client's Wix active members against live Kisi state, queue corrections.
   * Returns { granted, revoked, skippedHolderOptin, runId } so callers (manual sync endpoint) can surface the counts.
   *
   * Sources of truth:
   *   Wix  — who should have access (active orders + confirmed bookings)
   *   Kisi — who currently has access (live role assignments, filtered to AccessSync users)
   *
   * The DB is used only as a bridge: member_access.hardware_user_id maps Kisi user IDs
   * back to Wix platform_member_ids (on member_master), and member_master.source_tag = 'accesssync'
   * filters out staff/contractors.
   *
   * Hardening (2026-04-28):
   *  - Opens a reconciliation_run audit row at start, closes at end with full counts
   *  - Respects opt-in holder rule (DR-040): does NOT auto-grant a multi-member plan holder
   *    who has not claimed a seat. Holder slot must be claimed via the Member Hub.
   *  - Mass-revoke sanity gate: if would-be revoke count >= 25% of yesterday's active count,
   *    waits 30s, re-fetches Wix, aborts revoke phase if drop persists. Grants always proceed.
   */
  async _syncClient(client, opts = {}) {
    const triggeredBy        = opts.triggeredBy || 'cron';
    const triggeredByActor   = opts.triggeredByActor || { type: 'system', id: 'reconciliation-cron' };
    const wixApiKey      = decryptApiKey(client.source_api_key);
    const hardwareApiKey = decryptApiKey(client.hardware_api_key);
    const hardwarePlatform = client.hardware_platform || 'kisi';
    const siteId = client.source_site_id;
    const traceId = this._sweepTraceId || null;

    let granted = 0;
    let revoked = 0;
    let skippedHolderOptin = 0;

    // Open the audit row immediately so even an early abort is recorded
    const runRowResult = await db.query(
      `INSERT INTO reconciliation_run
         (client_id, trace_id, triggered_by, triggered_by_actor_type, triggered_by_actor_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')
       RETURNING id`,
      [client.id, traceId, triggeredBy, triggeredByActor.type, triggeredByActor.id]
    ).catch(e => { log.error('reconciliation.run_open_failed', { clientId: client.id }, e); return { rows: [{ id: null }] }; });
    const runId = runRowResult.rows[0]?.id || null;

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
      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, 'wix_api_unavailable', $2, $3, $4, $5)`,
        [client.id, `status=${err.status || 'unknown'} code=${err.code || 'unknown'}`, getTraceId() || null, _actor.type || null, _actor.id || null]
      ).catch(() => {}); // Fault-tolerant — never block digest
      // Close the audit row as aborted before returning
      if (runId) await db.query(
        `UPDATE reconciliation_run SET status = 'aborted', abort_reason = 'wix_api_unavailable', completed_at = NOW() WHERE id = $1`,
        [runId]
      ).catch(() => {});
      // Abort this client's sync. Do NOT fall through to compare/revoke.
      return { granted: 0, revoked: 0, skippedHolderOptin: 0, runId, aborted: true, reason: 'wix_api_unavailable' };
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
    // Staff, contractors, manually-added Kisi users have no member_master row and are excluded.
    const kisiMembers = new Map();

    if (kisiUserIds.length > 0) {
      const identityResult = await db.query(
        `SELECT mm.platform_member_id, ma.sub_master_id
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         WHERE ma.client_id = $1
           AND mm.source_tag = 'accesssync'
           AND ma.hardware_user_id = ANY($2)`,
        [client.id, kisiUserIds]
      );
      for (const row of identityResult.rows) {
        kisiMembers.set(row.platform_member_id, {
          isSubMember: row.sub_master_id !== null || row.platform_member_id.includes('###as'),
        });
      }
    }

    // OB-74: Verify each Kisi role assignment has a matching member_access_sources row.
    // If not, queue a synthetic revoke — Kisi has a role with no AccessSync billing source.
    for (const assignment of kisiAssignments) {
      if (!assignment.userId) continue;
      const sourceCheck = await db.query(
        `SELECT mas.id
         FROM member_access_sources mas
         JOIN member_access ma ON ma.id = mas.access_id
         WHERE ma.client_id = $1
           AND ma.hardware_user_id = $2
           AND mas.hardware_group_id = $3
         LIMIT 1`,
        [client.id, assignment.userId, assignment.groupId]
      );
      if (sourceCheck.rows.length === 0) {
        log.warn('reconciliation.kisi_orphan_detected', {
          clientId: client.id, kisiUserId: assignment.userId,
          hardwareGroupId: assignment.groupId, traceId: this._sweepTraceId,
        });
        // Resolve which Wix member this Kisi user belongs to, so the synthetic revoke targets correctly
        const memberRow = await db.query(
          `SELECT mm.platform_member_id
           FROM member_access ma
           JOIN member_master mm ON mm.id = ma.member_master_id
           WHERE ma.client_id = $1 AND ma.hardware_user_id = $2
           LIMIT 1`,
          [client.id, assignment.userId]
        );
        if (!memberRow.rows.length) continue; // No DB record — user was never AccessSync-managed, skip
        const platformMemberId = memberRow.rows[0].platform_member_id;
        const recoEventId = `recon-kisi-orphan-${client.id}-${assignment.userId}-${Date.now()}`;
        const orphanTraceId = this._sweepTraceId || crypto.randomUUID();
        const syntheticEvent = {
          eventType:        'plan.cancelled',
          sourcePlatform:   'wix',
          platformMemberId,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.kisi_orphan',
          traceId:          orphanTraceId,
          eventId:          recoEventId,
        };
        const jobId = `revoke-kisi-orphan-${client.id}-${assignment.userId}-${Date.now()}`;
        await eventQueue.add('revoke', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
        revoked++;
      }
    }

    // 3A. In Wix, not in Kisi → paid but not provisioned → queue grant
    //     EXCEPT: opt-in holder rule (DR-040). If a Wix order is for a multi-member plan
    //     and the buyer is the would-be plan holder, do NOT auto-grant. The holder must
    //     claim a seat explicitly via the Member Hub.
    //
    //     Detection: pull all active multi-member plan_mappings for this client.
    //     A Wix order whose planId maps to one of these is a "holder situation."
    //     Skip the grant — the holder will claim through the UI when they want a seat.
    const multiMemberPlans = await db.query(
      `SELECT source_plan_id FROM plan_mappings
       WHERE client_id = $1 AND status = 'active' AND allow_multiple = true`,
      [client.id]
    ).catch(() => ({ rows: [] }));
    const multiMemberPlanIds = new Set(multiMemberPlans.rows.map(r => r.source_plan_id));

    for (const [memberId, wixData] of wixMembers) {
      if (kisiMembers.has(memberId)) continue;

      if (!wixData.planId) {
        log.warn('reconciliation.wix_order_no_plan_id', { clientId: client.id, memberId });
        continue;
      }

      // Opt-in guard: skip grant for would-be holders on multi-member plans
      if (multiMemberPlanIds.has(wixData.planId)) {
        log.info('reconciliation.grant_skipped_optin', {
          clientId: client.id, platformMemberId: memberId,
          planId: wixData.planId, traceId: this._sweepTraceId,
          reason: 'multi_member_plan_holder_must_claim',
          sourceType: 'cron', stage: 'cron', result: 'skipped',
        });
        skippedHolderOptin++;
        continue;
      }

      const recoEventId = `recon-${client.id}-${memberId}-${Date.now()}`;
      const traceId = this._sweepTraceId || crypto.randomUUID();
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
        traceId,
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
    //
    // Sanity gate: if would-be revokes >= 25% of yesterday's active count (and yesterday > 5),
    // wait 30s and re-fetch Wix once. If second snapshot agrees, proceed. If it disagrees,
    // abort revoke phase entirely. Grants always proceed (additive ops are safe).
    const wouldRevokeIds = [];
    for (const [memberId, kisiData] of kisiMembers) {
      if (kisiData.isSubMember) continue;
      if (wixMembers.has(memberId)) continue;
      wouldRevokeIds.push(memberId);
    }

    let sanityGateTriggered = false;
    let sanityGateResolved  = null;
    let revokesProceed      = true;

    const yesterdayCount = client.last_active_member_count || null;
    const SANITY_THRESHOLD = 0.25;
    const SANITY_FLOOR     = 5;

    if (wouldRevokeIds.length > 0
        && yesterdayCount && yesterdayCount > SANITY_FLOOR
        && (wouldRevokeIds.length / yesterdayCount) >= SANITY_THRESHOLD) {

      sanityGateTriggered = true;
      log.warn('reconciliation.sanity_gate_triggered', {
        clientId: client.id, traceId: this._sweepTraceId,
        wouldRevoke: wouldRevokeIds.length, yesterday: yesterdayCount,
        threshold: SANITY_THRESHOLD,
      });

      // Wait then re-fetch once
      await new Promise(r => setTimeout(r, 30000));

      let secondOrders, secondBookings;
      try {
        [secondOrders, secondBookings] = await Promise.all([
          listActiveOrders(wixApiKey, siteId),
          listConfirmedBookings(wixApiKey, siteId),
        ]);
      } catch (e) {
        log.error('reconciliation.sanity_gate_requery_failed', { clientId: client.id }, e);
        revokesProceed = false;
        sanityGateResolved = false;
      }

      if (revokesProceed) {
        const secondMembers = new Map();
        for (const o of secondOrders || []) if (o.memberId) secondMembers.set(o.memberId, true);
        for (const b of secondBookings || []) if (b.memberId && !secondMembers.has(b.memberId)) secondMembers.set(b.memberId, true);

        // Recompute would-revoke against the second snapshot
        const secondWouldRevoke = wouldRevokeIds.filter(id => !secondMembers.has(id));
        const secondRatio = yesterdayCount ? secondWouldRevoke.length / yesterdayCount : 0;

        if (secondRatio >= SANITY_THRESHOLD) {
          sanityGateResolved = true;
          log.info('reconciliation.sanity_gate_resolved_proceed', {
            clientId: client.id, secondRevokes: secondWouldRevoke.length,
          });
        } else {
          revokesProceed = false;
          sanityGateResolved = false;
          log.warn('reconciliation.sanity_gate_aborted', {
            clientId: client.id,
            firstWouldRevoke: wouldRevokeIds.length,
            secondWouldRevoke: secondWouldRevoke.length,
            yesterday: yesterdayCount,
          });
          const _actor = getActor() || {};
          await db.query(
            `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
             VALUES ($1, 'wix_snapshot_anomaly', $2, $3, $4, $5)`,
            [
              client.id,
              `first=${wouldRevokeIds.length} second=${secondWouldRevoke.length} yesterday=${yesterdayCount}`,
              this._sweepTraceId || getTraceId() || null,
              _actor.type || null,
              _actor.id || null,
            ]
          ).catch(() => {});
        }
      }
    }

    if (revokesProceed) {
      for (const memberId of wouldRevokeIds) {
        const recoEventId = `recon-${client.id}-${memberId}-${Date.now()}`;
        const traceId = this._sweepTraceId || crypto.randomUUID();
        const syntheticEvent = {
          eventType:        'plan.cancelled',
          sourcePlatform:   'wix',
          platformMemberId: memberId,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.true_source_sync',
          traceId,
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
    }

    // Update last_active_member_count for next sweep's sanity gate baseline
    await db.query(
      `UPDATE clients SET last_active_member_count = $1 WHERE id = $2`,
      [wixMembers.size, client.id]
    ).catch(() => {});

    // Close the audit row
    if (runId) await db.query(
      `UPDATE reconciliation_run
         SET status = $1, completed_at = NOW(),
             wix_active_count = $2, kisi_managed_count = $3,
             grants_queued = $4, revokes_queued = $5, grants_skipped_optin = $6,
             sanity_gate_triggered = $7, sanity_gate_resolved = $8,
             abort_reason = $9
       WHERE id = $10`,
      [
        sanityGateTriggered && !revokesProceed ? 'aborted' : 'success',
        wixMembers.size, kisiMembers.size,
        granted, revoked, skippedHolderOptin,
        sanityGateTriggered, sanityGateResolved,
        sanityGateTriggered && !revokesProceed ? 'sanity_gate_tripped' : null,
        runId,
      ]
    ).catch(e => log.error('reconciliation.run_close_failed', { runId }, e));

    log.info('reconciliation.client_sync_complete', {
      clientId: client.id, siteId, runId,
      wixActive: wixMembers.size, kisiManaged: kisiMembers.size,
      granted, revoked, skippedHolderOptin,
      sanityGateTriggered, sanityGateResolved,
    });

    return { granted, revoked, skippedHolderOptin, runId, sanityGateTriggered, sanityGateResolved };
  }

  /**
   * Reconcile a single member's access state against Wix and the hardware platform.
   *
   * Closes OB-49 at the per-member level: detects database drift (missing
   * member_access_sources rows) and surfaces config integrity issues that
   * require operator attention.
   *
   * Architectural rules (DR-023):
   *  - This function NEVER writes member_access or member_access_sources
   *    directly. All repairs flow through Standard Adapter Layer (L3) via the
   *    event queue, which makes completeGrant() handle the inserts idempotently.
   *  - Sub-members (sub_master_id != null OR platform_member_id contains '###as')
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
   *   no_identity           — Member not provisioned in AccessSync (no member_master/member_access row).
   *   sub_member_skipped    — Caller passed a sub-member; reconcile plan holder instead.
   *
   * @param {string} memberId  - member_access.id (UUID)
   * @param {string} clientId  - clients.id (UUID)
   * @returns {Object} { action, granted, revoked, repaired, alerts: [...] }
   */
  async reconcileMember(memberId, clientId) {
    const traceId = crypto.randomUUID();
    return runWith(
      { traceId, actor: { type: 'system', id: 'reconcileMember' } },
      () => this._reconcileMemberBody(memberId, clientId, traceId)
    );
  }

  async _reconcileMemberBody(memberId, clientId, traceId) {
    const result = { action: null, granted: 0, revoked: 0, repaired: 0, alerts: [] };

    // 1. Load client + verify active and configured
    const clientRes = await db.query(
      `SELECT c.id, c.source_site_id, c.source_api_key,
              cs.hardware_api_key, cs.hardware_platform
       FROM clients c
       LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       WHERE c.id = $1 AND c.status = 'active'`,
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

    // 2. Load member_access + member_master, guard against sub-members
    const identityRes = await db.query(
      `SELECT ma.id, mm.platform_member_id, ma.hardware_user_id, ma.sub_master_id, mm.source_tag
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.id = $1 AND ma.client_id = $2`,
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
    const isSubMember = identity.sub_master_id !== null
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
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
           VALUES ($1, $2, $3, $4, 'system', 'reconcileMember')`,
          [clientId, a.code, a.planId || platformMemberId, traceId]
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

    // 6. Check DB row drift — even when hardware matches Wix, member_access_sources
    //    rows may be missing (this is the bug Daxx hit). Uses access_id FK (new schema).
    const dbSourceRes = await db.query(
      `SELECT hardware_group_id FROM member_access_sources WHERE access_id = $1`,
      [memberId]
    );
    const dbSourceGroupIds = new Set(dbSourceRes.rows.map(r => r.hardware_group_id).filter(Boolean));

    const dbMissingForExpected = [...expectedGroupIds].filter(
      g => !dbSourceGroupIds.has(g)
    );

    // 7. Decide and act

    // 7a. Case: hardware has access from a source we can't trace (no active Wix sub)
    if (untraceable.length > 0 && expectedGroupIds.size === 0) {
      result.alerts.push({
        code: 'untraceable_hardware_access',
        detail: 'This member has door access in the hardware system, but we can’t find a reason for it — no active plan, no booking, no operator override. Review the member’s history and decide whether to keep or remove their access.',
      });
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, 'untraceable_hardware_access', $2, $3, 'system', 'reconcileMember')`,
        [clientId, platformMemberId, traceId]
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
              cs.hardware_platform,
              cs.hardware_api_key
       FROM locations l
       JOIN clients c ON l.client_id = c.id
       JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
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
        const _actor = getActor() || {};
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, last_seen_at, trace_id, actor_type, actor_id)
           VALUES ($1, 'lockdown_detected', $2, NOW(), $3, $4, $5)`,
          [loc.client_id, String(door.id || door.name || 'unknown'), getTraceId() || null, _actor.type || null, _actor.id || null]
        ).catch(e => log.error('reconciliation.lockdown_alert_failed', { clientId: loc.client_id }, e));
      }
    }
  }

  async _fetchActionableRecords() {
    const result = await db.query(
      `SELECT ma.id, ma.status, ma.id AS member_id, ma.client_id,
              mm.platform_member_id, ma.hardware_platform, mm.source_platform
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.status IN ('failed', 'skipped_lockdown')
         AND mm.source_tag = 'accesssync'`
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

    // Guard: never re-queue a job without a traceId — worker rejects at queue-worker.js:77
    // and BullMQ marks it exhausted on attempt 1. If the original payload predates traceId
    // discipline, mint one so the job can run rather than dying immediately.
    if (!standardEvent.traceId) {
      standardEvent.traceId = this._sweepTraceId || crypto.randomUUID();
    }

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
