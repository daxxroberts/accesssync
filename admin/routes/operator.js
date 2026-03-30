/**
 * admin/routes/operator.js
 * AccessSync Operator Dashboard API
 *
 * Operator-facing endpoints — no admin JWT required.
 * Client identified by UUID in URL path.
 * Auth: OB-08 (Wix JWT) will gate this properly pre-launch.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const { encryptApiKey } = require('../../core/crypto-utils');

// ── GET /operator/webhook-url ────────────────────────────────────
// Returns the core engine webhook URL for this installation.
// Used by the onboarding wizard Step 5. Must be before /:clientId.
router.get('/webhook-url', (req, res) => {
  const base = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
  res.json({ url: base ? `${base}/webhooks/wix` : null });
});

// ══ Operator Signup Endpoints (OB-24: add auth before public launch) ══════════

// ── POST /operator/clients ───────────────────────────────────────
// Operator self-onboarding: create a new client account.
// Mirrors POST /admin/clients logic but requires no admin JWT.
router.post('/clients', async (req, res) => {
  try {
    const {
      name, platform = 'wix', hardware_platform, tier,
      site_id, site_name, site_url, notification_email,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Business rule: tier determines hardware_platform (Connect=Kisi, Base/Pro=Seam)
    // Explicit hardware_platform override allowed.
    const derivedHardware = hardware_platform || (tier === 'Connect' ? 'kisi' : tier ? 'seam' : null);

    const result = await db.query(
      `INSERT INTO clients (name, platform, hardware_platform, tier, site_id, site_name, site_url, notification_email, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', NOW(), NOW())
       RETURNING id, name, platform, hardware_platform, tier, site_id, site_name, notification_email, status, created_at`,
      [name.trim(), platform, derivedHardware, tier || null, site_id || null, site_name || null, site_url || null, notification_email || null]
    );
    console.log(`[operator/setup] Created client: ${result.rows[0].name} (${result.rows[0].id})`);
    res.status(201).json({ ok: true, client: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Site ID already in use' });
    console.error('[operator/setup] POST /clients error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /operator/clients/:clientId/locations ───────────────────
// Operator self-onboarding: add a location to a new client account.
router.post('/clients/:clientId/locations', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { name, city, state, tier } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    const clientCheck = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!clientCheck.rows.length) return res.status(404).json({ error: 'Client not found' });

    const result = await db.query(
      `INSERT INTO locations (client_id, name, city, state, tier, subscription_status, created_at)
       VALUES ($1, $2, $3, $4, $5, 'inactive', NOW())
       RETURNING id, client_id, name, city, state, tier, subscription_status, created_at`,
      [clientId, name.trim(), city || null, state || null, tier || null]
    );
    console.log(`[operator/setup] Created location ${result.rows[0].name} for client ${clientId}`);
    res.status(201).json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[operator/setup] POST /clients/:clientId/locations error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /operator/clients/:clientId/api-key ─────────────────────
// Operator self-onboarding: store encrypted door system API key.
// Write-only: key is AES-256-GCM encrypted, never returned.
router.post('/clients/:clientId/api-key', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE clients SET kisi_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [encrypted, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    console.log(`[operator/setup] API key set for client ${clientId} (${result.rows[0].name})`);
    res.json({ ok: true, message: 'API key saved' });
  } catch (err) {
    console.error('[operator/setup] POST /clients/:clientId/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/:clientId ─────────────────────────────────────
// Client overview: name, platform status, all-location stats
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [clientResult, errorCount, activeMembers, totalMembers, locationCount] = await Promise.all([
      db.query(
        `SELECT id, name, site_url, platform, hardware_platform, tier,
                last_sync_at, last_wix_webhook_at
         FROM clients WHERE id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM error_queue
         WHERE client_id = $1 AND status = 'failed'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_access_state
         WHERE client_id = $1 AND status = 'active'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_identity
         WHERE client_id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM locations WHERE client_id = $1`,
        [clientId]
      ),
    ]);

    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({
      client: clientResult.rows[0],
      stats: {
        error_count:    errorCount.rows[0].count,
        active_members: activeMembers.rows[0].count,
        total_members:  totalMembers.rows[0].count,
        location_count: locationCount.rows[0].count,
      },
    });
  } catch (err) {
    console.error('[operator] GET /:clientId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations ───────────────────────────
// Location list with per-location error count, door count, plan count
router.get('/:clientId/locations', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [locations, errorCounts, doorCounts, planCounts] = await Promise.all([
      db.query(
        `SELECT id, name, city, state FROM locations
         WHERE client_id = $1 ORDER BY created_at ASC`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(*)::int AS count FROM error_queue
         WHERE client_id = $1 AND status = 'failed'
         GROUP BY location_id`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(DISTINCT door_name)::int AS count
         FROM plan_mappings
         WHERE client_id = $1 AND status = 'active'
         GROUP BY location_id`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(*)::int AS count FROM plan_mappings
         WHERE client_id = $1 GROUP BY location_id`,
        [clientId]
      ),
    ]);

    const errMap = {}, doorMap = {}, planMap = {};
    errorCounts.rows.forEach(r => { errMap[r.location_id] = r.count; });
    doorCounts.rows.forEach(r => { doorMap[r.location_id] = r.count; });
    planCounts.rows.forEach(r => { planMap[r.location_id] = r.count; });

    res.json({
      locations: locations.rows.map(loc => ({
        ...loc,
        error_count: errMap[loc.id] || 0,
        door_count:  doorMap[loc.id] || 0,
        plan_count:  planMap[loc.id] || 0,
      })),
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/locations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations/:locationId ───────────────
// Location detail: errors, plan mappings, recent access log
router.get('/:clientId/locations/:locationId', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const [errors, planMappings, accessLog, activeMembers] = await Promise.all([
      db.query(
        `SELECT id, event_type, error_reason, retry_count, plan_name, door_name, created_at
         FROM error_queue
         WHERE location_id = $1 AND status = 'failed'
         ORDER BY created_at DESC`,
        [locationId]
      ),
      db.query(
        `SELECT id, wix_plan_id, hardware_group_id, plan_name, door_name, status, created_at
         FROM plan_mappings
         WHERE location_id = $1
         ORDER BY plan_name`,
        [locationId]
      ),
      db.query(
        `SELECT mal.id, mal.event_type, mal.credential_type, mal.created_at,
                mi.platform_member_id
         FROM member_access_log mal
         JOIN member_identity mi ON mi.id = mal.member_id
         WHERE mal.client_id = $1
         ORDER BY mal.created_at DESC LIMIT 10`,
        [clientId]
      ),
      db.query(
        `SELECT mi.id, mi.platform_member_id, mas.status, mas.provisioned_at
         FROM member_identity mi
         JOIN member_access_state mas ON mas.member_id = mi.id
         WHERE mi.client_id = $1
         ORDER BY mas.provisioned_at DESC NULLS LAST`,
        [clientId]
      ),
    ]);

    res.json({
      errors: errors.rows.map(e => ({
        ...e,
        plain_message: e.error_reason,
      })),
      plan_mappings: planMappings.rows,
      access_log: accessLog.rows,
      active_members: activeMembers.rows,
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/locations/:locationId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations/:locationId/mappings ───────
// Mapping screen data: location info + client info + plan_mappings
router.get('/:clientId/locations/:locationId/mappings', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const [locationResult, clientResult, mappingsResult] = await Promise.all([
      db.query(
        `SELECT id, name, city, state FROM locations WHERE id = $1 AND client_id = $2`,
        [locationId, clientId]
      ),
      db.query(
        `SELECT id, name, hardware_platform, tier FROM clients WHERE id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT id, wix_plan_id, plan_name, door_name, hardware_group_id, status, created_at
         FROM plan_mappings WHERE location_id = $1 ORDER BY plan_name`,
        [locationId]
      ),
    ]);
    if (!locationResult.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({
      location: locationResult.rows[0],
      client:   clientResult.rows[0] || null,
      mappings: mappingsResult.rows,
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/locations/:locationId/mappings error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/sync ───────────────────────────────
// Trigger sync — V1 placeholder: updates last_sync_at
router.post('/:clientId/sync', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query(
      `UPDATE clients SET last_sync_at = NOW() WHERE id = $1 RETURNING last_sync_at`,
      [clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ last_sync_at: result.rows[0].last_sync_at });
  } catch (err) {
    console.error('[operator] POST /:clientId/sync error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/errors/:errorId/dismiss ────────────
router.post('/:clientId/errors/:errorId/dismiss', async (req, res) => {
  const { clientId, errorId } = req.params;
  try {
    const result = await db.query(
      `UPDATE error_queue
       SET status = 'resolved', resolved_at = NOW(), dismissed_by = 'operator'
       WHERE id = $1 AND client_id = $2
       RETURNING id, status`,
      [errorId, clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Error not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[operator] POST errors/:errorId/dismiss error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/errors/:errorId/retry ──────────────
router.post('/:clientId/errors/:errorId/retry', async (req, res) => {
  const { clientId, errorId } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM error_queue WHERE id = $1 AND client_id = $2`,
      [errorId, clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Error not found' });
    }
    const error = result.rows[0];
    await eventQueue.add(error.event_type, error.payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    await db.query(
      `UPDATE error_queue SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1`,
      [errorId]
    );
    res.json({ queued: true });
  } catch (err) {
    console.error('[operator] POST errors/:errorId/retry error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /operator/:clientId/plan-mappings/:mappingId ───────────
router.patch('/:clientId/plan-mappings/:mappingId', async (req, res) => {
  const { clientId, mappingId } = req.params;
  const { status, door_name, hardware_group_id } = req.body;
  try {
    const fields = [], vals = [mappingId, clientId];
    if (status !== undefined)            { fields.push(`status = $${vals.length + 1}`);            vals.push(status); }
    if (door_name !== undefined)         { fields.push(`door_name = $${vals.length + 1}`);         vals.push(door_name); }
    if (hardware_group_id !== undefined) { fields.push(`hardware_group_id = $${vals.length + 1}`); vals.push(hardware_group_id); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.query(
      `UPDATE plan_mappings SET ${fields.join(', ')} WHERE id = $1 AND client_id = $2 RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[operator] PATCH plan-mappings/:mappingId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══ OB-05: Operator-facing visibility endpoints ════════════════════
// These are consumed by OB-06 (Wix widget) once built.
// Auth: OB-08 (Wix JWT) will gate these before widget launch.

// ── GET /operator/:clientId/members ─────────────────────────────
// Paginated member list for operator's account view.
router.get('/:clientId/members', async (req, res) => {
  const { clientId } = req.params;
  const { location_id, status, page = 1, limit = 25 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const params = [clientId];
    const conditions = ['mi.client_id = $1'];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`mas.status = $${params.length}`);
    }

    if (location_id) {
      params.push(location_id);
      conditions.push(
        `EXISTS (
           SELECT 1 FROM member_role_assignments mra
           JOIN plan_mappings pm ON pm.id = mra.mapping_id AND pm.location_id = $${params.length}
           WHERE mra.member_id = mi.id
         )`
      );
    }

    params.push(parseInt(limit));
    params.push(offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT mi.id,
                mi.platform_member_id,
                mi.hardware_platform,
                mas.status          AS access_status,
                mas.provisioned_at
         FROM   member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         WHERE  ${conditions.join(' AND ')}
         ORDER  BY mas.provisioned_at DESC NULLS LAST
         LIMIT  $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total
         FROM   member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         WHERE  ${conditions.join(' AND ')}`,
        params.slice(0, params.length - 2)
      ),
    ]);

    res.json({
      members: rows.rows,
      total:   countRow.rows[0].total,
      page:    parseInt(page),
      limit:   parseInt(limit),
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/members error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/alerts ───────────────────────────────
// Config alerts (missing doors, expired credentials, location mismatches).
router.get('/:clientId/alerts', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query(
      `SELECT id, alert_type, hardware_ref, affected_member_count, resolved_at,
              created_at, last_seen_at
       FROM config_alert_log
       WHERE client_id = $1
         AND resolved_at IS NULL
       ORDER BY last_seen_at DESC
       LIMIT 50`,
      [clientId]
    );
    res.json({ alerts: result.rows });
  } catch (err) {
    console.error('[operator] GET /:clientId/alerts error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/errors ───────────────────────────────
// Error queue summary for operator view — recent failed jobs.
router.get('/:clientId/errors', async (req, res) => {
  const { clientId } = req.params;
  const { limit = 20 } = req.query;
  try {
    const result = await db.query(
      `SELECT id, event_type, error_reason AS plain_message,
              plan_name, door_name, location_id,
              retry_count, status, created_at
       FROM error_queue
       WHERE client_id = $1 AND status = 'failed'
       ORDER BY created_at DESC
       LIMIT $2`,
      [clientId, parseInt(limit)]
    );
    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM error_queue WHERE client_id = $1 AND status = 'failed'`,
      [clientId]
    );
    res.json({
      errors: result.rows,
      total:  countResult.rows[0].total,
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/errors error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
