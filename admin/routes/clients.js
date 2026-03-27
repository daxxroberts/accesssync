/**
 * admin/routes/clients.js
 * Admin Hub — Client Manager
 *
 * GET /api/clients        List all clients with member and error counts
 * GET /api/clients/:id    Full detail for one client
 */

const router = require('express').Router();
const db     = require('../../db');

// ── GET /api/clients ───────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id,
              c.name,
              c.status,
              c.wix_site_id,
              c.notification_email,
              c.last_sync_at,
              c.created_at,
              c.updated_at,
              COUNT(DISTINCT mi.id)::int                                    AS member_count,
              COUNT(DISTINCT eq.id) FILTER (WHERE eq.status = 'failed')::int AS open_errors
       FROM clients c
       LEFT JOIN member_identity mi ON mi.client_id = c.id
       LEFT JOIN error_queue     eq ON eq.client_id = c.id
       GROUP BY c.id
       ORDER BY c.name ASC`
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/clients] GET / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/clients/:id ───────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const clientResult = await db.query(
      `SELECT c.*,
              COUNT(DISTINCT mi.id)::int                                    AS member_count,
              COUNT(DISTINCT eq.id) FILTER (WHERE eq.status = 'failed')::int AS open_errors,
              COUNT(DISTINCT pm.id)::int                                    AS plan_mapping_count
       FROM clients c
       LEFT JOIN member_identity mi ON mi.client_id = c.id
       LEFT JOIN error_queue     eq ON eq.client_id = c.id
       LEFT JOIN plan_mappings   pm ON pm.client_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [req.params.id]
    );

    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Recent plan mappings
    const mappingsResult = await db.query(
      `SELECT id, wix_plan_id, hardware_group_id, tier_name, action, created_at
       FROM plan_mappings
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    res.json({
      ...clientResult.rows[0],
      plan_mappings: mappingsResult.rows,
    });
  } catch (err) {
    console.error('[Admin/clients] GET /:id error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
