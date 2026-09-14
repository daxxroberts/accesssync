/**
 * @file day-pass-sweep.js
 * @layer core/layer4
 * @role cron-15min
 * @schedule every 15 minutes — in-process (admin/server.js) and/or Railway Cron:
 *           node core/day-pass-sweep.js
 * @reads member_access_sources, member_access, member_master, connector_subscriptions, clients
 * @writes (none) — enqueues synthetic revoke jobs; every DB write happens in the
 *         normal revoke path (L3 completeRevoke / finalizeRevoke), never here
 * @calls webhook-processor (eventQueue), hardware-adapter (listGroupLinks, deleteGroupLink)
 * @exports runDayPassSweep
 * @ob OB-98, OB-101, OB-251
 *
 * Day passes (OB-98) are Kisi group links with a valid_until. Nothing revokes on time
 * today — Wix fires orderEnded when the 24h window closes, and Kisi is expected to
 * honour valid_until on its side (GD-02: unverified live). This sweep is the belt to
 * those suspenders:
 *
 *   Pass A — expired rows: every member_access_sources row with source_type='day_pass',
 *            status='active', valid_until <= NOW() gets a synthetic plan.cancelled revoke
 *            job (one per member × plan). The revoke path deletes the Kisi link, drops
 *            the row, flips billing to 'cancelled' (BILLING_CANCEL_ALLOWED_SYNTHETIC),
 *            and runs DR-044 finalize. Idempotent with a later real orderEnded.
 *
 *   Pass B — orphan links: a crash between POST /group_links and the source-row upsert
 *            leaves a live link with no DB row (WARD finding, 2026-09-14). Lists the
 *            org's group links, keeps only those carrying THIS client's AccessSync
 *            marker whose valid_until has passed and whose id no DB row references,
 *            and deletes them through the same marker-guarded deleteGroupLink.
 *            Never touches an operator's hand-made links (no marker) and never a link
 *            that is still valid.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const { runWith, mintTraceId } = require('./trace-context');
const { eventQueue } = require('./webhook-processor');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { decryptApiKey } = require('./crypto-utils');

const SYNTHETIC_SOURCE = 'day-pass-sweep.expired';

async function runDayPassSweep({ triggerSource = 'cron' } = {}) {
  const traceId = mintTraceId();
  return runWith(
    { traceId, actor: { type: 'system', id: `day-pass-sweep-${triggerSource}` } },
    () => _sweepBody(traceId)
  );
}

async function _sweepBody(traceId) {
  log.info('day_pass_sweep.start', { traceId });
  const expiredEnqueued = await _enqueueExpired(traceId);
  const orphansDeleted  = await _deleteOrphanLinks(traceId);
  log.info('day_pass_sweep.complete', { traceId, expiredEnqueued, orphansDeleted });
  return { expiredEnqueued, orphansDeleted };
}

/** Pass A — one synthetic revoke per (member × plan) whose pass has expired. */
async function _enqueueExpired(traceId) {
  const rows = (await db.query(
    `SELECT mas.id, mas.access_id, mas.client_id, mas.source_plan_id, mas.valid_until,
            mm.platform_member_id, mm.source_platform
     FROM member_access_sources mas
     JOIN member_access ma ON ma.id = mas.access_id
     JOIN member_master mm ON mm.id = ma.member_master_id
     WHERE mas.source_type = 'day_pass'
       AND mas.status = 'active'
       AND mas.valid_until IS NOT NULL
       AND mas.valid_until <= NOW()`
  )).rows;

  const seen = new Set();
  let enqueued = 0;
  for (const r of rows) {
    const key = `${r.access_id}|${r.source_plan_id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const jobTraceId = mintTraceId();
    const standardEvent = {
      eventType:        'plan.cancelled',
      rawEventType:     'daypass.expired',
      sourcePlatform:   r.source_platform || 'wix',
      platformMemberId: r.platform_member_id,
      planId:           r.source_plan_id,
      synthetic:        true,
      syntheticSource:  SYNTHETIC_SOURCE,
      eventId:          `daypass-expire-${r.id}`,
      traceId:          jobTraceId,
      timestamp:        new Date().toISOString(),
    };
    try {
      await eventQueue.add(
        'revoke',
        { tenantId: r.client_id, standardEvent },
        { jobId: `daypass-expire-${r.access_id}-${Date.now()}` }
      );
      enqueued++;
      log.info('day_pass_sweep.revoke_queued', {
        clientId: r.client_id, memberId: r.access_id,
        platformMemberId: r.platform_member_id, planId: r.source_plan_id,
        validUntil: r.valid_until, jobTraceId, traceId,
      });
    } catch (err) {
      log.error('day_pass_sweep.enqueue_failed', {
        clientId: r.client_id, memberId: r.access_id, planId: r.source_plan_id, traceId,
      }, err);
    }
  }
  return enqueued;
}

/** Pass B — delete expired, marker-owned links that no DB row references. */
async function _deleteOrphanLinks(traceId) {
  const clients = (await db.query(
    `SELECT cs.client_id, cs.hardware_platform, cs.hardware_api_key
     FROM connector_subscriptions cs
     JOIN clients c ON c.id = cs.client_id
     WHERE cs.status = 'active'
       AND c.status = 'active'
       AND cs.hardware_api_key IS NOT NULL`
  )).rows;

  let deleted = 0;
  for (const c of clients) {
    const platform = c.hardware_platform || 'kisi';
    let apiKey;
    try {
      apiKey = decryptApiKey(c.hardware_api_key);
    } catch (err) {
      log.warn('day_pass_sweep.key_decrypt_failed', { clientId: c.client_id, traceId }, err);
      continue;
    }

    let links;
    try {
      links = await hardwareAdapter.listGroupLinks(platform, apiKey);
    } catch (err) {
      // Unsupported platform, HTTP failure, or a page-integrity throw — skip this
      // client this sweep rather than reason from a partial list.
      log.warn('day_pass_sweep.list_links_failed', {
        clientId: c.client_id, code: err.code || null, statusCode: err.statusCode || null, traceId,
      });
      continue;
    }

    const now = Date.now();
    const candidates = (links || []).filter(l =>
      l && l.ownerClientId === c.client_id &&
      l.validUntil && !isNaN(Date.parse(l.validUntil)) && Date.parse(l.validUntil) <= now
    );
    if (candidates.length === 0) continue;

    const ids = candidates.map(l => String(l.id));
    const known = new Set((await db.query(
      `SELECT role_assignment_id FROM member_access_sources
       WHERE client_id = $1 AND source_type = 'day_pass' AND role_assignment_id = ANY($2::text[])`,
      [c.client_id, ids]
    )).rows.map(r => String(r.role_assignment_id)));

    for (const l of candidates) {
      if (known.has(String(l.id))) continue;
      try {
        await hardwareAdapter.deleteGroupLink(platform, apiKey, l.id, { clientId: c.client_id });
        deleted++;
        log.info('day_pass_sweep.orphan_link_deleted', {
          clientId: c.client_id, groupLinkId: l.id, hardwareGroupId: l.groupId || null,
          validUntil: l.validUntil, traceId,
        });
      } catch (err) {
        log.warn('day_pass_sweep.orphan_delete_failed', {
          clientId: c.client_id, groupLinkId: l.id, code: err.code || null,
          statusCode: err.statusCode || null, traceId,
        });
      }
    }
  }
  return deleted;
}

// Executable entry point for Railway Cron
if (require.main === module) {
  runDayPassSweep({ triggerSource: 'cron' })
    .then(() => process.exit(0))
    .catch(err => { log.critical('day_pass_sweep.fatal', {}, err); process.exit(1); });
}

module.exports = { runDayPassSweep, SYNTHETIC_SOURCE };
