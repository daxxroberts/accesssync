/**
 * @file reconciliation.js
 * @layer core/layer4
 * @role cron-nightly
 * @schedule nightly via Railway Cron
 * @reads member_access_state, error_queue, locations, clients (source_api_key, source_site_id, reconciliation_interval, last_sync_at), member_identity
 * @writes member_access_state, config_alert_log, clients (last_sync_at)
 * @calls hardware-adapter (getLocks), wix-plans-api (listActiveOrders, listConfirmedBookings), BullMQ (re-queue), resend (digest)
 * @exports instance (NightlyReconciliation)
 * @dr DR-003, DR-008, DR-018, DR-020
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

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { eventQueue } = require('./webhook-processor');
const { decryptApiKey } = require('./crypto-utils');
const { listActiveOrders, listConfirmedBookings } = require('../adapters/wix/wix-plans-api');
const { log } = require('./logger');

class NightlyReconciliation {

  constructor() {
    this.staleThresholdMinutes = 10;
  }

  /**
   * Main entry point for the Railway Cron Job
   */
  async runNightlySweep() {
    log.info('reconciliation.sweep_start', {});

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
        log.info('reconciliation.skipped', { reason: 'interval_not_elapsed', interval });
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
      log.info('reconciliation.stale_reset', {});

      // Step 2: Sync Door Lockdown States
      await this._syncDoorLockdownStates();

      // Step 3: Fetch Actionable Records
      const recordsToProcess = await this._fetchActionableRecords();
      log.info('reconciliation.actionable_records', { count: recordsToProcess.length });

      // Step 4: Re-process records with rate limit compliance
      for (const record of recordsToProcess) {
        await this._processRecordTargeted(record);
        await this._sleep(250); // Respect Kisi 5 req/sec (DR-008)
      }

      // Step 5: Send Operator Email Digest
      await this._generateAndSendDigest();

      // Update last_sync_at for all active clients (DR-018)
      await db.query(`UPDATE clients SET last_sync_at = NOW() WHERE status = 'active'`);

      log.info('reconciliation.sweep_complete', {});
    } catch (error) {
      log.critical('reconciliation.sweep_failed', {}, error);
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
    log.info('reconciliation.wix_sync_start', {});

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

    log.info('reconciliation.wix_sync_complete', {});
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

    // 1. Pull Wix side — active plan orders + confirmed bookings in parallel
    const [orders, bookings] = await Promise.all([
      listActiveOrders(wixApiKey, siteId),
      listConfirmedBookings(wixApiKey, siteId),
    ]);

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
      };

      const jobId = `grant-wix-sync-${client.id}-${memberId}-${Date.now()}`;
      await eventQueue.add('grant', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
      log.info('reconciliation.grant_queued', { clientId: client.id, memberId, planId: wixData.planId, jobId });
      granted++;
    }

    // 3B. In Kisi (AccessSync-managed, primary members only), not in Wix → cancelled/lapsed → queue revoke
    for (const [memberId, kisiData] of kisiMembers) {
      if (kisiData.isSubMember) continue;     // Operator-managed — never revoke based on Wix absence
      if (wixMembers.has(memberId)) continue; // Still active in Wix

      const syntheticEvent = {
        eventType:        'plan.cancelled',
        sourcePlatform:   'wix',
        platformMemberId: memberId,
        wixSiteId:        siteId,
        synthetic:        true,
        syntheticSource:  'reconciliation.true_source_sync',
      };

      const jobId = `revoke-wix-sync-${client.id}-${memberId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
      log.info('reconciliation.revoke_queued', { clientId: client.id, memberId, jobId });
      revoked++;
    }

    log.info('reconciliation.client_sync_complete', {
      clientId: client.id, siteId,
      wixActive: wixMembers.size, kisiManaged: kisiMembers.size,
      granted, revoked,
    });

    return { granted, revoked };
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

    log.info('reconciliation.digest', { configAlerts: digest.configAlerts.length, failedJobs: digest.failedJobs.length });

    if (configAlertsResult.rows.length === 0 && failedJobsResult.rows.length === 0) {
      log.info('reconciliation.digest_empty', {});
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
      log.info('reconciliation.digest_sent', { toEmail });
    } catch (err) {
      log.error('reconciliation.digest_send_failed', { toEmail }, err);
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
