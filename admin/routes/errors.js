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
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../../core/redis-utils');

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

    const result = await db.query(
      `SELECT eq.*,
              c.name  AS client_name,
              mi.email        AS member_email,
              mi.display_name AS member_display_name
       FROM error_queue eq
       LEFT JOIN clients        c  ON c.id  = eq.client_id
       LEFT JOIN member_identity mi ON mi.id = eq.member_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY eq.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    const countResult = await db.query(
      `SELECT COUNT(*) FROM error_queue eq WHERE ${conditions.slice(0, -2).join(' AND ')}`,
      params.slice(0, -2)
    );

    res.json({
      data:   result.rows,
      total:  parseInt(countResult.rows[0].count),
      limit:  parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('[Admin/errors] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/errors/:id ──────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT eq.*,
              c.name          AS client_name,
              mi.email        AS member_email,
              mi.display_name AS member_display_name,
              mi.platform_member_id,
              mi.source_platform
       FROM error_queue eq
       LEFT JOIN clients         c  ON c.id  = eq.client_id
       LEFT JOIN member_identity mi ON mi.id = eq.member_id
       WHERE eq.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Admin/errors] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[Admin/errors] POST /:id/dismiss error:', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[Admin/errors] POST /:id/retry error:', err.message);
    res.status(500).json({ error: err.message });
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
    console.error('[Admin/errors] POST /bulk-retry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
