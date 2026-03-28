/**
 * admin/routes/clients.js
 * Admin Hub — Clients Panel
 *
 * GET   /admin/clients        List all clients
 * PATCH /admin/clients/:id    Update client fields
 */

const router = require('express').Router();
const db     = require('../../db');

const EDITABLE_FIELDS = ['name', 'hardware_platform', 'tier', 'notification_email', 'status', 'site_id', 'site_name', 'platform'];

// ── GET /admin/clients ─────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id,
              c.name,
              c.platform,
              c.site_id,
              c.site_name,
              c.hardware_platform,
              c.tier,
              c.status,
              c.notification_email,
              c.last_sync_at,
              c.created_at,
              c.updated_at,
              COUNT(DISTINCT mi.id)::int  AS member_count,
              COUNT(DISTINCT CASE WHEN mas.status = 'active' THEN mi.id END)::int AS active_count
       FROM clients c
       LEFT JOIN member_identity    mi  ON mi.client_id  = c.id
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       GROUP BY c.id
       ORDER BY c.created_at ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/clients] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/clients/:id ───────────────────────────────────────
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = {};
    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
    const values     = [id, ...Object.values(updates)];

    const result = await db.query(
      `UPDATE clients
       SET ${setClauses.join(', ')}, updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      values
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, client: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] PATCH /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
