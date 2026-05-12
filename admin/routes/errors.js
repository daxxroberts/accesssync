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

const eventQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

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
    const standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!standardEvent.traceId) standardEvent.traceId = mintTraceId();

    const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
      ? 'grant' : 'revoke';

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

    const results = { queued: 0, failed: 0, errors: [] };

    for (const id of ids) {
      try {
        const errorRow = await db.query(
          'SELECT client_id, event_type, payload FROM error_queue WHERE id = $1',
          [id]
        );
        if (!errorRow.rows.length) { results.failed++; continue; }

        const { client_id: tenantId, event_type: eventType, payload } = errorRow.rows[0];
        const standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (!standardEvent.traceId) standardEvent.traceId = mintTraceId();
        const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
          ? 'grant' : 'revoke';

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
