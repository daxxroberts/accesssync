/**
 * admin/routes/webhooks.js
 * Admin Hub — Webhook Inspector
 *
 * GET /admin/webhooks/recent?limit=50&since=<ISO>  Recent webhook log entries
 * GET /admin/webhooks/:id                           Full detail for one entry
 *
 * Frontend polls /recent every 10 seconds using `since` param for incremental updates.
 */

const router = require('express').Router();
const db     = require('../../db');

// ── GET /admin/webhooks/recent ─────────────────────────────────
router.get('/recent', async (req, res) => {
  try {
    const { limit = 50, since } = req.query;

    const params  = [];
    const conditions = ['1=1'];

    if (since) {
      params.push(since);
      conditions.push(`wl.received_at > $${params.length}`);
    }

    params.push(parseInt(limit));

    const result = await db.query(
      `SELECT wl.id,
              wl.event_id,
              wl.received_at,
              wl.hmac_status,
              wl.dedup_status,
              wl.event_type,
              wl.error_detail,
              c.name AS client_name
       FROM webhook_log wl
       LEFT JOIN clients c ON c.id = wl.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY wl.received_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/webhooks] GET /recent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/webhooks/:id ────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT wl.*, c.name AS client_name
       FROM webhook_log wl
       LEFT JOIN clients c ON c.id = wl.client_id
       WHERE wl.id = $1`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Admin/webhooks] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
