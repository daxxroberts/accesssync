/**
 * admin/routes/clients.js
 * Admin Hub — Clients Panel
 *
 * GET    /admin/clients              List all clients (?status=active|archived|all)
 * POST   /admin/clients              Create new client
 * PATCH  /admin/clients/:id          Update client fields
 * POST   /admin/clients/:id/archive  Archive (soft-deactivate) a client
 * POST   /admin/clients/:id/restore  Restore an archived client
 * GET    /admin/clients/:id/dependencies  Preview deletion cascade counts
 * DELETE /admin/clients/:id          Permanently delete with cascade (requires confirmation)
 * GET    /admin/clients/:id/audit    Admin action audit trail
 */

const router = require('express').Router();
const db     = require('../../db');
const { encryptApiKey, decryptApiKey } = require('../../core/crypto-utils');
const kisiConnector = require('../../adapters/kisi/kisi-connector');
const { suspendLocationMembers } = require('../../core/location-lapse');
const { logAdminAction } = require('../middleware/audit');

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
// ?status=active (default) | archived | all — filter by client status
router.get('/', async (req, res) => {
  try {
    const statusFilter = req.query.status || 'active';
    let whereClause = '';
    const params = [];
    if (statusFilter === 'archived') {
      whereClause = 'WHERE c.status = $1';
      params.push('archived');
    } else if (statusFilter === 'all') {
      whereClause = '';
    } else {
      // Default: exclude archived
      whereClause = "WHERE c.status != 'archived'";
    }

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
              c.archived_at,
              c.created_at,
              c.updated_at,
              COUNT(DISTINCT mi.id)::int  AS member_count,
              COUNT(DISTINCT CASE WHEN mas.status = 'active' THEN mi.id END)::int AS active_count
       FROM clients c
       LEFT JOIN member_identity    mi  ON mi.client_id  = c.id
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       ${whereClause}
       GROUP BY c.id
       ORDER BY c.created_at ASC`,
      params
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
    // S1: Strip encrypted API key — never return it in responses
    const { hardware_api_key, wix_api_key, ...safeClient } = result.rows[0];
    logAdminAction(id, 'client_edited', { fields: Object.keys(updates), values: updates });
    res.json({ ok: true, client: safeClient });
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
    // S3: Validate key length before encrypting — rejects empty strings and obviously wrong values
    if (apiKey.trim().length < 20) {
      return res.status(400).json({ error: 'API key too short — must be at least 20 characters' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE clients SET hardware_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [encrypted, id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    logAdminAction(id, 'api_key_rotated', { type: 'hardware', client_name: result.rows[0].name });
    console.log(`[Admin/clients] API key set for client ${id} (${result.rows[0].name})`);
    res.json({ ok: true, message: 'API key saved' });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/clients/:id/api-key/test ───────────────────────────
// Validates the stored API key by making a lightweight Kisi API call.
// Returns { valid: true } or { valid: false, error: '...' }
// Never returns the key itself.
router.get('/:id/api-key/test', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!result.rows[0].hardware_api_key) return res.status(400).json({ valid: false, error: 'No API key set for this client' });

    const apiKey = decryptApiKey(result.rows[0].hardware_api_key);
    await kisiConnector.makeRequest('/groups?limit=1', { method: 'GET' }, apiKey);

    res.json({ valid: true });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ valid: false, error: 'Invalid API key — Kisi rejected it' });
    if (err.statusCode === 403) return res.json({ valid: false, error: 'API key authenticated but lacks required permissions' });
    console.error('[Admin/clients] GET /:id/api-key/test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/clients/:id/api-key/status ──────────────────────────
// Returns whether a key is set — never returns the key itself.
router.get('/:id/api-key/status', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ hasKey: !!result.rows[0].hardware_api_key });
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
              (l.hardware_api_key IS NOT NULL) AS has_location_key,
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
    // S2: Strip encrypted API key — never return it in responses
    const { hardware_api_key, ...safeLocation } = result.rows[0];
    res.json({ ok: true, location: safeLocation });
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
      `UPDATE locations SET hardware_api_key = $1
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

// ══ Archive / Restore / Delete ════════════════════════════════════

// ── POST /admin/clients/:id/archive ──────────────────────────────
router.post('/:id/archive', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE clients SET status = 'archived', archived_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status != 'archived'
       RETURNING id, name, status, archived_at`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found or already archived' });
    logAdminAction(id, 'client_archived', { name: result.rows[0].name });
    console.log(`[Admin/clients] Archived client: ${result.rows[0].name} (${id})`);
    res.json({ ok: true, client: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/archive error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/clients/:id/restore ──────────────────────────────
router.post('/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `UPDATE clients SET status = 'active', archived_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'archived'
       RETURNING id, name, status`,
      [id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found or not archived' });
    logAdminAction(id, 'client_restored', { name: result.rows[0].name });
    console.log(`[Admin/clients] Restored client: ${result.rows[0].name} (${id})`);
    res.json({ ok: true, client: result.rows[0] });
  } catch (err) {
    console.error('[Admin/clients] POST /:id/restore error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/clients/:id/dependencies ──────────────────────────
// Returns counts of all related records — shown before deletion.
router.get('/:id/dependencies', async (req, res) => {
  try {
    const { id } = req.params;
    const client = await db.query('SELECT id, name FROM clients WHERE id = $1', [id]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });

    const counts = await db.query(
      `SELECT
        (SELECT COUNT(*)::int FROM locations WHERE client_id = $1) AS locations,
        (SELECT COUNT(*)::int FROM member_identity WHERE client_id = $1) AS members,
        (SELECT COUNT(*)::int FROM plan_mappings WHERE client_id = $1) AS plan_mappings,
        (SELECT COUNT(*)::int FROM plan_mapping_groups pmg
         JOIN plan_mappings pm ON pmg.mapping_id = pm.id WHERE pm.client_id = $1) AS plan_mapping_groups,
        (SELECT COUNT(*)::int FROM member_role_assignments mra
         JOIN member_identity mi ON mra.member_id = mi.id WHERE mi.client_id = $1) AS role_assignments,
        (SELECT COUNT(*)::int FROM member_access_state WHERE client_id = $1) AS access_states,
        (SELECT COUNT(*)::int FROM member_access_log WHERE client_id = $1) AS access_logs,
        (SELECT COUNT(*)::int FROM error_queue WHERE client_id = $1) AS error_queue,
        (SELECT COUNT(*)::int FROM config_alert_log WHERE client_id = $1) AS config_alerts,
        (SELECT COUNT(*)::int FROM client_activity_summary WHERE client_id = $1) AS activity_summaries,
        (SELECT COUNT(*)::int FROM processed_event_ids WHERE client_id = $1) AS processed_events,
        (SELECT COUNT(*)::int FROM adapter_admin_log WHERE client_id = $1) AS audit_logs,
        (SELECT COUNT(*)::int FROM webhook_log WHERE client_id = $1) AS webhook_logs`,
      [id]
    );

    res.json({
      client: client.rows[0],
      dependencies: {
        locations: counts.rows[0].locations,
        members: counts.rows[0].members,
        plan_mappings: counts.rows[0].plan_mappings,
        plan_mapping_groups: counts.rows[0].plan_mapping_groups,
        role_assignments: counts.rows[0].role_assignments,
        access_states: counts.rows[0].access_states,
        access_logs: counts.rows[0].access_logs,
        error_queue: counts.rows[0].error_queue,
        config_alerts: counts.rows[0].config_alerts,
        activity_summaries: counts.rows[0].activity_summaries,
        processed_events: counts.rows[0].processed_events,
      },
      orphan_tables: {
        audit_logs: counts.rows[0].audit_logs,
        webhook_logs: counts.rows[0].webhook_logs,
      },
    });
  } catch (err) {
    console.error('[Admin/clients] GET /:id/dependencies error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/clients/:id ────────────────────────────────────
// Permanent deletion with cascade. Requires confirmation body: { confirm: "DELETE <name>" }
router.delete('/:id', async (req, res) => {
  const pgClient = await db.getClient();
  try {
    const { id } = req.params;
    const { confirm } = req.body || {};

    // Fetch client name for confirmation check
    const clientResult = await pgClient.query('SELECT id, name FROM clients WHERE id = $1', [id]);
    if (!clientResult.rows.length) {
      pgClient.release();
      return res.status(404).json({ error: 'Client not found' });
    }
    const clientName = clientResult.rows[0].name;

    // Require explicit confirmation string
    if (!confirm || confirm !== `DELETE ${clientName}`) {
      pgClient.release();
      return res.status(400).json({
        error: 'Confirmation required',
        expected: `DELETE ${clientName}`,
        message: `Send { "confirm": "DELETE ${clientName}" } to permanently delete this client and all related data.`,
      });
    }

    await pgClient.query('BEGIN');

    // Log deletion before cascade (adapter_admin_log has no CASCADE — survives)
    await pgClient.query(
      `INSERT INTO adapter_admin_log (client_id, event_type, admin_action, details, target_entity, target_id, result, configured_at)
       VALUES ($1, 'client_deleted', 'client_deleted', $2, 'client', $1, 'success', NOW())`,
      [id, JSON.stringify({ name: clientName, deleted_at: new Date().toISOString() })]
    );

    // Clean orphan-safe tables before cascade
    await pgClient.query('DELETE FROM webhook_log WHERE client_id = $1', [id]);
    await pgClient.query('DELETE FROM processed_event_ids WHERE client_id = $1', [id]);
    await pgClient.query('DELETE FROM error_queue WHERE client_id = $1', [id]);
    // Keep the deletion audit entry — delete all other audit entries for this client
    await pgClient.query(
      `DELETE FROM adapter_admin_log WHERE client_id = $1 AND admin_action IS DISTINCT FROM 'client_deleted'`,
      [id]
    );

    // CASCADE handles: locations, plan_mappings (+ plan_mapping_groups), member_identity
    // (+ member_access_state, member_role_assignments, member_access_log),
    // config_alert_log, client_activity_summary
    await pgClient.query('DELETE FROM clients WHERE id = $1', [id]);

    await pgClient.query('COMMIT');
    console.log(`[Admin/clients] Permanently deleted client: ${clientName} (${id})`);
    res.json({ ok: true, message: `Client "${clientName}" and all related data permanently deleted` });
  } catch (err) {
    await pgClient.query('ROLLBACK').catch(() => {});
    console.error('[Admin/clients] DELETE /:id error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    pgClient.release();
  }
});

// ── GET /admin/clients/:id/audit ─────────────────────────────────
// Returns recent admin audit entries for a client.
router.get('/:id/audit', async (req, res) => {
  try {
    const { id } = req.params;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const result = await db.query(
      `SELECT id, event_type, admin_action, details, target_entity, target_id, result, configured_at, created_at
       FROM adapter_admin_log
       WHERE client_id = $1 AND admin_action IS NOT NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [id, limit]
    );
    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/clients] GET /:id/audit error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
