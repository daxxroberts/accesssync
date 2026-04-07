/**
 * @file reconciliation.js
 * @layer core/layer4
 * @role cron-nightly
 * @schedule nightly via Railway Cron
 * @reads member_access_state, error_queue, locations, clients
 * @writes member_access_state, config_alert_log
 * @calls hardware-adapter (getLocks), BullMQ (re-queue), resend (digest)
 * @exports instance (NightlyReconciliation)
 * @dr DR-003, DR-008, DR-020
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

class NightlyReconciliation {

  constructor() {
    this.staleThresholdMinutes = 10;
  }

  /**
   * Main entry point for the Railway Cron Job
   */
  async runNightlySweep() {
    console.log('[Nightly Reconciliation] Starting sweep at', new Date().toISOString());

    try {
      // Step 1: Clean up stale in_flight records (crash protection)
      await db.query(
        `UPDATE member_access_state
         SET status = 'failed', updated_at = NOW()
         WHERE status = 'in_flight'
           AND updated_at < NOW() - INTERVAL '10 minutes'`
      );
      console.log('[Nightly Reconciliation] Stale in_flight records reset to failed.');

      // Step 2: Sync Door Lockdown States
      await this._syncDoorLockdownStates();

      // Step 3: Fetch Actionable Records
      const recordsToProcess = await this._fetchActionableRecords();
      console.log(`[Nightly Reconciliation] Found ${recordsToProcess.length} actionable records.`);

      // Step 4: Re-process records with rate limit compliance
      for (const record of recordsToProcess) {
        await this._processRecordTargeted(record);
        await this._sleep(250); // Respect Kisi 5 req/sec (DR-008)
      }

      // Step 5: Send Operator Email Digest
      await this._generateAndSendDigest();

      console.log('[Nightly Reconciliation] Sweep complete.');
    } catch (error) {
      console.error('[Nightly Reconciliation] CRITICAL ERROR during sweep:', error);
    }
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
        console.warn(`[Nightly Reconciliation] No API key for location ${loc.location_id} — skipping lockdown sync.`);
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
        ).catch(e => console.error('[Nightly Reconciliation] Failed to log lockdown alert:', e.message));
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
      console.warn(`[Nightly Reconciliation] No error_queue entry for member ${record.member_id}. Skipping.`);
      return;
    }

    const { event_type: eventType, payload } = errorResult.rows[0];
    let standardEvent;
    try {
      standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      console.error(`[Nightly Reconciliation] Failed to parse payload for member ${record.member_id}:`, e.message);
      return;
    }

    const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
      ? 'grant'
      : 'revoke';

    // 2. Re-queue to BullMQ — respects in_flight lock and concurrency controls (not direct grant-revoke call)
    await eventQueue.add(jobName, { tenantId: record.client_id, standardEvent });
    console.log(`[Nightly Reconciliation] Re-queued ${jobName} for member ${record.member_id} (${record.platform_member_id}).`);
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

    console.log('[Nightly Reconciliation] DIGEST:', JSON.stringify(digest, null, 2));

    if (configAlertsResult.rows.length === 0 && failedJobsResult.rows.length === 0) {
      console.log('[Nightly Reconciliation] Digest: nothing to report.');
      return;
    }

    // DR-020: Send nightly digest via Resend — same pattern as retry-engine._notifyOperator
    const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;
    if (!toEmail) {
      console.warn('[Nightly Reconciliation] ACCESSSYNC_OWNER_NOTIFICATION_EMAIL not set — digest logged only.');
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
      console.log(`[Nightly Reconciliation] Digest sent to ${toEmail}`);
    } catch (err) {
      console.error('[Nightly Reconciliation] Failed to send digest email:', err.message);
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
    console.error(err);
    process.exit(1);
  });
}
