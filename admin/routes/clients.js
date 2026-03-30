/**
 * admin/routes/clients.js
 * Admin Hub — Clients Panel
 *
 * GET   /admin/clients        List all clients
 * PATCH /admin/clients/:id    Update client fields
 */

const router = require('express').Router();
const db     = require('../../db');
const { encryptApiKey } = require('../../core/crypto-utils');
const { suspendLocationMembers } = require('../../core/location-lapse');

const EDITABLE_FIELDS = ['name', 'hardware_platform', 'tier', 'notification_email', 'status', 'site_id', 'site_name', 'platform'];

// ── POST /admin/clients — Create new client ────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, platform = 'wix', hardware_platform, tier, site_id, site_name, notification_email, site_url } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Business rule: tier determines hardware_platform (DR — Connect=Kisi, Base/Pro=Seam)
    // Explicit hardware_platform override allowed for admin use only.
    const derivedHardware = hardware_platform || (tier === 'Connect' ? 'kisi' : tier ? 'seam' : null);

    const result = await db.query(
      `INSERT INTO clients (name, platform, hardware_platform, tier, site_id, site_name, site_url, notification_email, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW(), NOW())
       RETURNING id, name, platform, hardware_platform, tier, site_id, site_name, notification_email, status, created_at`,
      [name.trim(), platform, derivedHardware, tier || null, site_id || null, site_name || null, site_url || null, notification_email || null]
    );
    console.log(`[Admin/clients] Created new client: ${result.rows[0].name} (${result.rows[0].id})`);
    res.status(201).json({ ok: true, client: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Site ID already in use' });
    console.error('[Admin/clients] POST / error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

// ── POST /admin/clients/:id/api-key ────────────────────────────────
// Set or rotate the Kisi API key for a client (DR-028).
// Write-only: plaintext is encrypted before storage, never returned.
router.post('/:id/api-key', async (req, res) => {
  try {
    const { id } = req.params;
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE clients SET kisi_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [encrypted, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    console.log(`[Admin/clients] API key set for client ${id} (${result.rows[0].name})`);
    res.json({ ok: true, message: 'API key saved' });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/clients/:id/api-key/status ──────────────────────────
// Returns whether a key is set — never returns the key itself.
router.get('/:id/api-key/status', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT kisi_api_key FROM clients WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ hasKey: !!result.rows[0].kisi_api_key });
  } catch (err) {
    console.error('[Admin/clients] GET /:id/api-key/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══ Location Management ════════════════════════════════════════════

// ── GET /admin/clients/:id/locations ──────────────────────────────
router.get('/:id/locations', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT l.id, l.name, l.city, l.state,
              l.subscription_status, l.tier, l.subscribed_at, l.subscription_id,
              l.created_at,
              (l.kisi_api_key IS NOT NULL) AS has_location_key,
              COUNT(DISTINCT pm.id)::int  AS mapping_count
       FROM locations l
       LEFT JOIN plan_mappings pm ON pm.location_id = l.id
       WHERE l.client_id = $1
       GROUP BY l.id
       ORDER BY l.created_at ASC`,
      [id]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/clients] GET /:id/locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/clients/:id/locations — Create location ───────────
router.post('/:id/locations', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, state, tier } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Verify client exists
    const clientCheck = await db.query('SELECT id FROM clients WHERE id = $1', [id]);
    if (!clientCheck.rows.length) return res.status(404).json({ error: 'Client not found' });

    const result = await db.query(
      `INSERT INTO locations (client_id, name, city, state, tier, subscription_status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'inactive', NOW())
       RETURNING id, client_id, name, city, state, tier, subscription_status, created_at`,
      [id, name.trim(), city || null, state || null, tier || null]
    );
    console.log(`[Admin/clients] Created location ${result.rows[0].name} for client ${id}`);
    res.status(201).json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /admin/clients/:id/locations/:locationId ─────────────────
router.patch('/:id/locations/:locationId', async (req, res) => {
  try {
    const { id, locationId } = req.params;
    const LOCATION_FIELDS = ['name', 'city', 'state', 'tier', 'subscription_status', 'subscription_id', 'subscribed_at'];
    const updates = {};
    for (const f of LOCATION_FIELDS) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 3}`);
    const values     = [locationId, id, ...Object.values(updates)];

    const result = await db.query(
      `UPDATE locations
       SET ${setClauses.join(', ')}
       WHERE id = $1 AND client_id = $2
       RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] PATCH /:id/locations/:locationId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/clients/:id/locations/:locationId/api-key ──────────
// Set or rotate the Kisi API key override for a specific location (DR-028).
router.post('/:id/locations/:locationId/api-key', async (req, res) => {
  try {
    const { id, locationId } = req.params;
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'apiKey is required' });

    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE locations SET kisi_api_key = $1
       WHERE id = $2 AND client_id = $3
       RETURNING id, name`,
      [encrypted, locationId, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    console.log(`[Admin/clients] Location API key set for ${result.rows[0].name} (${locationId})`);
    res.json({ ok: true, message: 'Location API key saved' });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/locations/:locationId/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/clients/:id/locations/:locationId/suspend ──────────
// OB-20: Trigger location subscription lapse — suspend all provisioned members.
router.post('/:id/locations/:locationId/suspend', async (req, res) => {
  try {
    const { id: clientId, locationId } = req.params;
    const { status = 'suspended' } = req.body; // 'suspended' or 'cancelled'

    console.log(`[Admin/clients] Lapse trigger: location ${locationId}, status → ${status}`);
    const result = await suspendLocationMembers(locationId, clientId, status);

    res.json({
      ok: true,
      suspended: result.suspended,
      skipped:   result.skipped,
      errors:    result.errors,
    });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/locations/:locationId/suspend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/clients/:id/locations/:locationId/activate ─────────
// Re-activate a location subscription (does NOT re-provision members — that requires new Wix events).
router.post('/:id/locations/:locationId/activate', async (req, res) => {
  try {
    const { id: clientId, locationId } = req.params;
    const { subscription_id, tier } = req.body;

    const result = await db.query(
      `UPDATE locations
       SET subscription_status = 'active',
           subscribed_at = NOW(),
           subscription_id = COALESCE($3, subscription_id),
           tier = COALESCE($4, tier)
       WHERE id = $1 AND client_id = $2
       RETURNING id, name, subscription_status`,
      [locationId, clientId, subscription_id || null, tier || null]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });

    console.log(`[Admin/clients] Location ${result.rows[0].name} activated`);
    res.json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/locations/:locationId/activate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
