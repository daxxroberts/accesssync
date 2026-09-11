/**
 * admin/routes/errors.js
 * Admin Hub — Error Queue Manager
 *
 * GET  /admin/errors              Paginated error queue across all tenants
 * GET  /admin/errors/:id          Full detail for one error
 * POST /admin/errors/:id/dismiss  Mark resolved with note
 * POST /admin/errors/:id/retry    Re-enqueue to BullMQ
 * POST /admin/errors/bulk-retry   Re-enqueue multiple by ID array
 */

const router  = require('express').Router();
const db      = require('../../db');
const { log } = require('../../core/logger');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../../core/redis-utils');
const { mintTraceId } = require('../../core/trace-context');
const { jobNameForEventType } = require('../../core/event-routing');

const eventQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

// ── Retry routing ──────────────────────────────────────────────
// Both Retry handlers below used to carry their own grant list
// [plan.purchased, payment.recovered, booking.confirmed] and send EVERYTHING
// ELSE to 'revoke'. So Retry on a failed plan.started grant (delayed-start
// member) enqueued a REVOKE, and Retry on a row that is not a member event at
// all (e.g. source_retry_exhausted) also enqueued a revoke. The row was then
// marked resolved, hiding the damage. Routing now goes through
// core/event-routing.js: an event type is a grant, a revoke, or neither —
// "neither" is refused (nothing queued, row left open), never promoted to a
// revoke. Same for a payload that is missing, unparseable, or not an object.
//
// Phase 1 ("stop the bleeding", 2026-09-10): a retry that routes to 'revoke' is
// REFUSED too. Replaying a stale removal hours or days later can take door
// access from someone who has since paid, and Phase 1 enables no new removal
// path. Nothing is queued and the row stays open, so the gym owner still sees
// it and can remove the person in Kisi by hand if that is really wanted.
// Grants replay exactly as before.

const REVOKE_RETRY_DISABLED_MESSAGE =
  'Retrying a door-access removal is paused while AccessSync\'s safety checks are rolled out. '
  + 'Nothing was changed — if this person should lose access, remove them in Kisi.';

// Refusal reason → the warn event it logs.
const RETRY_REFUSED_EVENT = Object.freeze({
  unroutable_event_type: 'admin.retry.unroutable_event_type',
  unreadable_payload:    'admin.retry.unreadable_payload',
  revoke_retry_disabled: 'admin.retry.revoke_disabled',
});

/** The saved standard event as a plain object, or null when it can't be read. */
function readRetryPayload(payload) {
  let standardEvent = payload;
  if (typeof standardEvent === 'string') {
    try { standardEvent = JSON.parse(standardEvent); } catch (_) { return null; }
  }
  if (!standardEvent || typeof standardEvent !== 'object' || Array.isArray(standardEvent)) return null;
  return standardEvent;
}

/**
 * Decide what replaying one error_queue row may enqueue.
 * @returns {{ ok: true, jobName: 'grant', standardEvent: object }
 *         | { ok: false, reason: 'unroutable_event_type'|'revoke_retry_disabled'|'unreadable_payload', error: string }}
 */
function planRetry(eventType, payload) {
  const jobName = jobNameForEventType(eventType);
  if (!jobName) {
    return {
      ok: false,
      reason: 'unroutable_event_type',
      error: 'This error can\'t be retried: '
        + (eventType ? `"${eventType}" is not a grant or revoke event` : 'it has no event type')
        + ', so there is no job to re-run. Nothing was queued and the error is still open.',
    };
  }
  // Checked before the payload: a removal is refused whatever its saved event says.
  if (jobName === 'revoke') {
    return { ok: false, reason: 'revoke_retry_disabled', error: REVOKE_RETRY_DISABLED_MESSAGE };
  }
  const standardEvent = readRetryPayload(payload);
  if (!standardEvent) {
    return {
      ok: false,
      reason: 'unreadable_payload',
      error: 'This error can\'t be retried: its saved event is missing or unreadable. '
        + 'Nothing was queued and the error is still open.',
    };
  }
  return { ok: true, jobName, standardEvent };
}

/** One warn per refused retry — event name is the refusal reason. */
function warnRetryRefused(plan, ctx) {
  log.warn(RETRY_REFUSED_EVENT[plan.reason], { ...ctx, reason: plan.reason });
}

// ── GET /admin/errors ──────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status = 'failed', client_id, limit = 50, offset = 0 } = req.query;

    const conditions = ['1=1'];
    const params = [];

    if (status !== 'all') {
      params.push(status);
      conditions.push(`eq.status = $${params.length}`);
    }
    if (client_id) {
      params.push(client_id);
      conditions.push(`eq.client_id = $${params.length}`);
    }

    params.push(parseInt(limit), parseInt(offset));
    const limitIdx  = params.length - 1;
    const offsetIdx = params.length;

    // JOIN through member_access -> member_master for the affected person, plus a
    // self-JOIN through ma.sub_master_id to surface the holder when the affected
    // person is a sub-member.
    const result = await db.query(
      `SELECT eq.*,
              c.name AS client_name,
              mm.email           AS member_email,
              mm.display_name    AS member_name,
              holder_mm.email        AS holder_email,
              holder_mm.display_name AS holder_name,
              (ma.sub_master_id IS NOT NULL) AS is_sub_member
       FROM error_queue eq
       LEFT JOIN clients       c  ON c.id  = eq.client_id
       LEFT JOIN member_access ma ON ma.id = eq.member_id
       LEFT JOIN member_master mm ON mm.id = ma.member_master_id
       LEFT JOIN member_master holder_mm ON holder_mm.id = ma.sub_master_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY eq.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM error_queue eq WHERE ${conditions.join(' AND ')}`,
      params.slice(0, -2)
    );

    res.json({
      data:   result.rows,
      total:  parseInt(countResult.rows[0].count),
      limit:  parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    log.error('admin.errors_list_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /admin/errors/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    // Same JOIN as the list endpoint, plus full member identity
    // (platform_member_id, source_platform) for the detail view.
    const result = await db.query(
      `SELECT eq.*,
              c.name AS client_name,
              mm.email             AS member_email,
              mm.display_name      AS member_name,
              mm.platform_member_id,
              mm.source_platform,
              holder_mm.email        AS holder_email,
              holder_mm.display_name AS holder_name,
              (ma.sub_master_id IS NOT NULL) AS is_sub_member
       FROM error_queue eq
       LEFT JOIN clients       c  ON c.id  = eq.client_id
       LEFT JOIN member_access ma ON ma.id = eq.member_id
       LEFT JOIN member_master mm ON mm.id = ma.member_master_id
       LEFT JOIN member_master holder_mm ON holder_mm.id = ma.sub_master_id
       WHERE eq.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    log.error('admin.errors_detail_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /admin/errors/:id/dismiss ────────────────────────────
router.post('/:id/dismiss', async (req, res) => {
  try {
    const { note = '' } = req.body;
    const result = await db.query(
      `UPDATE error_queue
       SET status       = 'resolved',
           resolved_at  = NOW(),
           dismiss_note = $2,
           dismissed_by = 'admin'
       WHERE id = $1
       RETURNING id, status, resolved_at, dismiss_note`,
      [req.params.id, note]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, ...result.rows[0] });
  } catch (err) {
    log.error('admin.errors_dismiss_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /admin/errors/:id/retry ──────────────────────────────
router.post('/:id/retry', async (req, res) => {
  try {
    const errorRow = await db.query(
      'SELECT client_id, event_type, payload FROM error_queue WHERE id = $1',
      [req.params.id]
    );
    if (!errorRow.rows.length) return res.status(404).json({ error: 'Not found' });

    const { client_id: tenantId, event_type: eventType, payload } = errorRow.rows[0];
    const plan = planRetry(eventType, payload);
    if (!plan.ok) {
      // Refused: enqueue nothing and leave the row 'failed' so it stays visible.
      warnRetryRefused(plan, { clientId: tenantId, errorId: req.params.id, eventType, route: 'admin.errors.retry' });
      return res.status(422).json({ error: plan.error, reason: plan.reason });
    }
    const { jobName, standardEvent } = plan;
    if (!standardEvent.traceId) standardEvent.traceId = mintTraceId();

    await eventQueue.add(jobName, { tenantId, standardEvent }, {
      jobId: `admin-retry-${req.params.id}-${Date.now()}`
    });

    // Mark as resolved since it's been re-queued
    await db.query(
      `UPDATE error_queue
       SET status = 'resolved', resolved_at = NOW(), dismissed_by = 'admin-retry'
       WHERE id = $1`,
      [req.params.id]
    );

    res.json({ ok: true, queued: jobName });
  } catch (err) {
    log.error('admin.errors_retry_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /admin/errors/bulk-retry ─────────────────────────────
router.post('/bulk-retry', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({ error: 'ids array required' });
    }

    // skipped/skippedRows: rows refused by planRetry (unroutable event type, a
    // removal — paused in Phase 1 — or unreadable payload) — nothing queued for
    // them and they stay 'failed'.
    const results = { queued: 0, failed: 0, skipped: 0, errors: [], skippedRows: [] };

    for (const id of ids) {
      try {
        const errorRow = await db.query(
          'SELECT client_id, event_type, payload FROM error_queue WHERE id = $1',
          [id]
        );
        if (!errorRow.rows.length) { results.failed++; continue; }

        const { client_id: tenantId, event_type: eventType, payload } = errorRow.rows[0];
        const plan = planRetry(eventType, payload);
        if (!plan.ok) {
          warnRetryRefused(plan, { clientId: tenantId, errorId: id, eventType, route: 'admin.errors.bulk_retry' });
          results.skipped++;
          results.skippedRows.push({ id, reason: plan.reason, error: plan.error });
          continue;
        }
        const { jobName, standardEvent } = plan;
        if (!standardEvent.traceId) standardEvent.traceId = mintTraceId();

        await eventQueue.add(jobName, { tenantId, standardEvent }, {
          jobId: `admin-bulk-retry-${id}-${Date.now()}`
        });
        await db.query(
          `UPDATE error_queue SET status='resolved', resolved_at=NOW(), dismissed_by='admin-retry' WHERE id=$1`,
          [id]
        );
        results.queued++;
      } catch (e) {
        results.failed++;
        results.errors.push({ id, error: e.message });
      }
    }

    res.json(results);
  } catch (err) {
    log.error('admin.errors_bulk_retry_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
