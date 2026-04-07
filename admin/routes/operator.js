/**
 * admin/routes/operator.js
 * AccessSync Operator Dashboard API
 *
 * Operator-facing endpoints — admin JWT required (via router-level middleware).
 * Client identified by UUID in URL path.
 * Auth: Admin JWT on all routes. Onboarding signup endpoints exempt (use invite token instead).
 */

const express = require('express');
const crypto  = require('crypto');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const { encryptApiKey, decryptApiKey: decryptKey } = require('../../core/crypto-utils');
const wixPlansApi = require('../../adapters/wix/wix-plans-api');
const { requireAuth } = require('../middleware/auth');

// Global rate limiter on all operator read endpoints (100 req/min/IP)
router.use(rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true, legacyHeaders: false }));

// Auth gate: require admin JWT on all operator routes EXCEPT onboarding signup
// (signup endpoints use requireInviteToken instead — operator isn't logged in yet)
router.use(function operatorAuth(req, res, next) {
  // Skip auth for onboarding signup endpoints that use invite tokens
  if (req.headers['x-invite-token']) return next();
  if (req.method === 'POST' && req.path === '/verify-bypass') return next();
  return requireAuth(req, res, next);
});

/**
 * Wix-first flow: Re-enqueue all pending_hardware members for a client.
 * Called after an API key is saved/rotated so parked members get provisioned.
 * Returns the count of members re-queued.
 */
async function retryPendingHardwareMembers(clientId) {
  const result = await db.query(
    `SELECT mi.platform_member_id, mi.source_platform, mas.pending_plan_id
     FROM member_access_state mas
     JOIN member_identity mi ON mi.id = mas.member_id
     WHERE mas.client_id = $1 AND mas.status = 'pending_hardware'`,
    [clientId]
  );
  if (result.rows.length === 0) return 0;

  for (const row of result.rows) {
    await eventQueue.add('grant', {
      tenantId: clientId,
      standardEvent: {
        platformMemberId: row.platform_member_id,
        sourcePlatform: row.source_platform || 'wix',
        eventType: 'retry.pending_hardware',
        planId: row.pending_plan_id,
      }
    });
  }

  console.log(`[operator] Re-queued ${result.rows.length} pending_hardware members for client ${clientId}`);
  return result.rows.length;
}

// ── GET /operator/webhook-url ────────────────────────────────────
// Returns the core engine webhook URL for this installation.
// Used by the onboarding wizard Step 5. Must be before /:clientId.
router.get('/webhook-url', (req, res) => {
  const base = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
  res.json({ url: base ? `${base}/webhooks/wix` : null });
});

// ── POST /operator/verify-bypass ─────────────────────────────────
// Owner bypass PIN validation for onboarding (skips Kisi key step).
// PIN checked against OWNER_PIN env var (Railway ADMIN service) — never hardcoded.
router.post('/verify-bypass', (req, res) => {
  const { pin } = req.body;
  const expected = process.env.OWNER_PIN;
  if (!expected || !pin || pin !== expected) {
    return res.status(403).json({ error: 'Invalid PIN' });
  }
  console.log('[operator/setup] Owner bypass PIN accepted');
  res.json({ ok: true });
});

// ══ Operator Signup Endpoints ═════════════════════════════════════════════════
// OB-24: Protected by invite token. Operators receive a link with ?invite=TOKEN.
// Token checked against OPERATOR_INVITE_TOKEN env var. Without it, 403.
// Rate-limited to 5 requests per IP per minute as defense-in-depth.

const signupLimiter = {};
function requireInviteToken(req, res, next) {
  // Rate limiting: 5 signup requests per IP per minute
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  if (!signupLimiter[ip]) signupLimiter[ip] = [];
  signupLimiter[ip] = signupLimiter[ip].filter(t => now - t < 60_000);
  if (signupLimiter[ip].length === 0) delete signupLimiter[ip]; // prevent unbounded growth
  else if (signupLimiter[ip].length >= 5) {
    return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  }
  if (signupLimiter[ip]) signupLimiter[ip].push(now);
  else signupLimiter[ip] = [now];

  // Token check — timing-safe comparison to prevent side-channel attacks
  const expected = process.env.OPERATOR_INVITE_TOKEN;
  if (!expected) {
    console.warn('[operator/auth] OPERATOR_INVITE_TOKEN not configured — blocking signup');
    return res.status(503).json({ error: 'Signup is not currently available' });
  }
  const token = req.headers['x-invite-token'];
  if (!token || Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Valid invite link required' });
  }
  next();
}

// ── POST /operator/clients ───────────────────────────────────────
// Operator self-onboarding: create a new client account.
router.post('/clients', requireInviteToken, async (req, res) => {
  try {
    const {
      name, platform = 'wix', hardware_platform, tier,
      site_id, site_name, site_url, notification_email, wix_api_key,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Business rule: tier determines hardware_platform (Connect=Kisi, Base/Pro=Seam)
    // Explicit hardware_platform override allowed.
    const derivedHardware = hardware_platform || (tier === 'Connect' ? 'kisi' : tier ? 'seam' : null);

    // Encrypt Wix API key if provided (same AES-256-GCM pattern as hardware keys)
    const encryptedWixKey = wix_api_key ? encryptApiKey(wix_api_key.trim()) : null;

    const result = await db.query(
      `INSERT INTO clients (name, platform, hardware_platform, tier, site_id, site_name, site_url, notification_email, wix_api_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', NOW(), NOW())
       RETURNING id, name, platform, hardware_platform, tier, site_id, site_name, notification_email, status, created_at`,
      [name.trim(), platform, derivedHardware, tier || null, site_id || null, site_name || null, site_url || null, notification_email || null, encryptedWixKey]
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
router.post('/clients/:clientId/locations', requireInviteToken, async (req, res) => {
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
router.post('/clients/:clientId/api-key', requireInviteToken, async (req, res) => {
  try {
    const { clientId } = req.params;
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE clients SET hardware_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [encrypted, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    console.log(`[operator/setup] API key set for client ${clientId} (${result.rows[0].name})`);

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'API key saved', pendingRetried: retried });
  } catch (err) {
    console.error('[operator/setup] POST /clients/:clientId/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /operator/clients/:clientId/locations/:locationId/activate ──
// Activates a location during onboarding (OB-44/OB-45).
// Sets subscription_status = 'active' so plan-mapping-resolver (DR-027) allows provisioning.
router.post('/clients/:clientId/locations/:locationId/activate', requireInviteToken, async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const result = await db.query(
      `UPDATE locations
       SET subscription_status = 'active', subscribed_at = NOW()
       WHERE id = $1 AND client_id = $2 AND subscription_status = 'inactive'
       RETURNING id, name, subscription_status, subscribed_at`,
      [locationId, clientId]
    );
    if (!result.rows.length) {
      const check = await db.query(
        'SELECT subscription_status FROM locations WHERE id = $1 AND client_id = $2',
        [locationId, clientId]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Location not found' });
      return res.json({ ok: true, location: check.rows[0], already_active: true });
    }
    console.log(`[operator/setup] Location ${result.rows[0].name} (${locationId}) activated for client ${clientId}`);
    res.json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[operator] POST activate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/clients/:clientId/kisi-groups ─────────────────
// Returns all Kisi access groups for the client's org (OB-42).
// Used by onboarding Step 4 (after key validation) and plan-mapping screen.
router.get('/clients/:clientId/kisi-groups', async (req, res) => {
  const { clientId } = req.params;
  try {
    const { decryptApiKey } = require('../../core/crypto-utils');
    const kisiAdapter = require('../../adapters/kisi/kisi-adapter');

    const clientResult = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]);
    if (!clientResult.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!clientResult.rows[0].hardware_api_key) return res.status(400).json({ error: 'No API key configured', noKey: true });

    const apiKey = decryptApiKey(clientResult.rows[0].hardware_api_key);
    const groups = await kisiAdapter.getGroups(apiKey);

    res.json({
      groups: groups.map(g => ({
        id: g.id,
        name: g.name,
        description: g.description || null,
      })),
      count: groups.length,
    });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ groups: [], count: 0, error: 'Invalid API key' });
    console.error('[operator] GET kisi-groups error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/clients/:clientId/api-key/status ──────────────
// Returns whether an org-level API key is configured (OB-35/38).
router.get('/clients/:clientId/api-key/status', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ hasKey: !!result.rows[0].hardware_api_key });
  } catch (err) {
    console.error('[operator] GET api-key/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/clients/:clientId/api-key/test ────────────────
// Validates the org-level API key against Kisi (OB-35/38).
router.get('/clients/:clientId/api-key/test', async (req, res) => {
  const { clientId } = req.params;
  try {
    const { decryptApiKey } = require('../../core/crypto-utils');
    const kisiConnector = require('../../adapters/kisi/kisi-connector');
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!result.rows[0].hardware_api_key) return res.status(400).json({ valid: false, error: 'No API key set' });

    const apiKey = decryptApiKey(result.rows[0].hardware_api_key);
    await kisiConnector.makeRequest('/groups?limit=1', { method: 'GET' }, apiKey);
    res.json({ valid: true });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ valid: false, error: 'Invalid API key' });
    if (err.statusCode === 403) return res.json({ valid: false, error: 'Lacks required permissions' });
    console.error('[operator] GET api-key/test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /operator/clients/:clientId/api-key ─────────────────────
// Update (rotate) the org-level API key (OB-35/38).
router.put('/clients/:clientId/api-key', async (req, res) => {
  const { clientId } = req.params;
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE clients SET hardware_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [encrypted, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    console.log(`[operator] API key rotated for client ${clientId}`);

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'API key updated', pendingRetried: retried });
  } catch (err) {
    console.error('[operator] PUT api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/clients/:clientId/notification-email ─────────
// Return the current notification email (Sprint 5.3).
router.get('/clients/:clientId/notification-email', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query('SELECT notification_email FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ email: result.rows[0].notification_email || null });
  } catch (err) {
    console.error('[operator] GET notification-email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /operator/clients/:clientId/notification-email ─────────
// Update the operator notification email (Sprint 5.3).
router.put('/clients/:clientId/notification-email', async (req, res) => {
  const { clientId } = req.params;
  const { email } = req.body;
  if (!email || typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'email is required' });
  }
  const trimmed = email.trim();
  // Basic format check — block obviously malformed values
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  try {
    const result = await db.query(
      `UPDATE clients SET notification_email = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name`,
      [trimmed, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    console.log(`[operator] Notification email updated for client ${clientId}`);
    res.json({ ok: true, message: 'Notification email updated' });
  } catch (err) {
    console.error('[operator] PUT notification-email error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /operator/clients/:clientId ──────────────────────────
// Update editable client fields (operator-facing)
router.patch('/clients/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const result = await db.query(
      'UPDATE clients SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
      [name.trim(), clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, client: result.rows[0] });
  } catch (err) {
    console.error('[operator] PATCH /clients/:clientId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId ─────────────────────────────────────
// Client overview: name, platform status, all-location stats
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [clientResult, errorCount, activeMembers, totalMembers, locationCount, pendingHardware] = await Promise.all([
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
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_access_state
         WHERE client_id = $1 AND status = 'pending_hardware'`,
        [clientId]
      ),
    ]);

    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({
      client: clientResult.rows[0],
      stats: {
        error_count:      errorCount.rows[0].count,
        active_members:   activeMembers.rows[0].count,
        total_members:    totalMembers.rows[0].count,
        location_count:   locationCount.rows[0].count,
        pending_hardware: pendingHardware.rows[0].count,
      },
    });
  } catch (err) {
    console.error('[operator] GET /:clientId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations/:locationId/notification-email ──
// Returns per-location notification email (falls back to client email)
router.get('/:clientId/locations/:locationId/notification-email', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const result = await db.query(
      `SELECT l.notification_email AS location_email, c.notification_email AS client_email
       FROM locations l JOIN clients c ON c.id = l.client_id
       WHERE l.id = $1 AND l.client_id = $2`,
      [locationId, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    const row = result.rows[0];
    res.json({
      email:     row.location_email || row.client_email || null,
      source:    row.location_email ? 'location' : 'client',
      isOverride: !!row.location_email,
    });
  } catch (err) {
    console.error('[operator] GET location notification-email error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /operator/:clientId/locations/:locationId/notification-email ──
// Set per-location notification email
router.put('/:clientId/locations/:locationId/notification-email', async (req, res) => {
  const { clientId, locationId } = req.params;
  const { email } = req.body;
  if (!email || !email.trim()) return res.status(400).json({ error: 'email is required' });
  try {
    const result = await db.query(
      `UPDATE locations SET notification_email = $1 WHERE id = $2 AND client_id = $3 RETURNING id, name, notification_email`,
      [email.trim(), locationId, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({ ok: true, email: result.rows[0].notification_email });
  } catch (err) {
    console.error('[operator] PUT location notification-email error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/locations/:locationId/api-key ──────
// Store encrypted per-location Kisi API key override (DR-028).
// Write-only. Null out by sending empty string.
router.post('/:clientId/locations/:locationId/api-key', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return res.status(400).json({ error: 'apiKey is required' });
    }
    if (apiKey.trim().length < 20) {
      return res.status(400).json({ error: 'API key too short' });
    }
    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      `UPDATE locations SET hardware_api_key = $1
       WHERE id = $2 AND client_id = $3
       RETURNING id, name`,
      [encrypted, locationId, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    console.log(`[operator] Location API key set for ${locationId} (${result.rows[0].name})`);

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'Location API key saved', pendingRetried: retried });
  } catch (err) {
    console.error('[operator] POST /:clientId/locations/:locationId/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/:clientId/locations/:locationId/api-key/test ──
// Validates stored location API key override against Kisi (DR-028).
// Falls back to client-level key if no location override set.
router.get('/:clientId/locations/:locationId/api-key/test', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const { decryptApiKey } = require('../../core/crypto-utils');
    const kisiConnector = require('../../adapters/kisi/kisi-connector');

    const [locResult, clientResult] = await Promise.all([
      db.query('SELECT hardware_api_key FROM locations WHERE id = $1 AND client_id = $2', [locationId, clientId]),
      db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]),
    ]);
    if (!locResult.rows.length) return res.status(404).json({ error: 'Location not found' });

    const encryptedKey = locResult.rows[0].hardware_api_key || clientResult.rows[0]?.hardware_api_key;
    if (!encryptedKey) return res.status(400).json({ valid: false, error: 'No API key set', source: null });

    const source = locResult.rows[0].hardware_api_key ? 'location' : 'client';
    const apiKey = decryptApiKey(encryptedKey);
    await kisiConnector.makeRequest('/groups?limit=1', { method: 'GET' }, apiKey);

    res.json({ valid: true, source });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ valid: false, error: 'Invalid API key — Kisi rejected it' });
    if (err.statusCode === 403) return res.json({ valid: false, error: 'Authenticated but lacks required permissions' });
    console.error('[operator] GET /:clientId/locations/:locationId/api-key/test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /operator/:clientId/locations ───────────────────────────
// Location list with per-location error count, door count, plan count
router.get('/:clientId/locations', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [locations, errorCounts, doorCounts, planCounts] = await Promise.all([
      db.query(
        `SELECT id, name, city, state, subscription_status, tier,
                subscribed_at, hardware_api_key IS NOT NULL AS has_location_key,
                hardware_platform, notification_email
         FROM locations
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
        error_count:      errMap[loc.id] || 0,
        door_count:       doorMap[loc.id] || 0,
        plan_count:       planMap[loc.id] || 0,
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
        `SELECT id, source_plan_id, hardware_group_id, plan_name, door_name, status, created_at
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
           AND mi.id IN (
             SELECT mra2.member_id FROM member_role_assignments mra2
             JOIN plan_mappings pm2 ON pm2.id = mra2.mapping_id
             WHERE pm2.location_id = $2
           )
         ORDER BY mal.created_at DESC LIMIT 10`,
        [clientId, locationId]
      ),
      db.query(
        `SELECT DISTINCT mi.id, mi.platform_member_id, mas.status, mas.provisioned_at, mas.updated_at
         FROM member_identity mi
         JOIN member_access_state mas ON mas.member_id = mi.id
         LEFT JOIN member_role_assignments mra ON mra.member_id = mi.id
         LEFT JOIN plan_mappings pm ON pm.id = mra.mapping_id
         WHERE mi.client_id = $1
           AND (pm.location_id = $2 OR EXISTS (
             SELECT 1 FROM plan_mappings pm2
             WHERE pm2.location_id = $2
               AND pm2.source_plan_id = mas.pending_plan_id
           ))
         ORDER BY mas.updated_at DESC NULLS LAST`,
        [clientId, locationId]
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
        `SELECT id, source_plan_id, plan_name, door_name, hardware_group_id, status, allow_multiple, max_members, created_at
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
// Accepts `groups: [{ hardware_group_id, door_name }]` for multi-group mapping.
// Also accepts legacy single-group fields for backward compat.
router.patch('/:clientId/plan-mappings/:mappingId', async (req, res) => {
  const { clientId, mappingId } = req.params;
  const { status, door_name, hardware_group_id, groups, allow_multiple, max_members } = req.body;
  try {
    // Update plan_mappings row (legacy fields + status + multi-member config)
    const fields = [], vals = [mappingId, clientId];
    if (status !== undefined)            { fields.push(`status = $${vals.length + 1}`);            vals.push(status); }
    if (door_name !== undefined)         { fields.push(`door_name = $${vals.length + 1}`);         vals.push(door_name); }
    if (hardware_group_id !== undefined) { fields.push(`hardware_group_id = $${vals.length + 1}`); vals.push(hardware_group_id); }
    if (allow_multiple !== undefined)    { fields.push(`allow_multiple = $${vals.length + 1}`);    vals.push(!!allow_multiple); }
    if (max_members !== undefined)       { fields.push(`max_members = $${vals.length + 1}`);       vals.push(Math.max(1, Math.min(20, parseInt(max_members) || 1))); }

    // If groups array provided, use first group for backward compat on plan_mappings row
    if (groups && Array.isArray(groups) && groups.length > 0) {
      if (hardware_group_id === undefined) {
        fields.push(`hardware_group_id = $${vals.length + 1}`); vals.push(groups[0].hardware_group_id);
      }
      if (door_name === undefined) {
        fields.push(`door_name = $${vals.length + 1}`); vals.push(groups[0].door_name || null);
      }
    }

    if (!fields.length && !groups) return res.status(400).json({ error: 'No fields to update' });

    let mapping;
    if (fields.length) {
      const result = await db.query(
        `UPDATE plan_mappings SET ${fields.join(', ')} WHERE id = $1 AND client_id = $2 RETURNING *`,
        vals
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
      mapping = result.rows[0];
    } else {
      const result = await db.query('SELECT * FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]);
      if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
      mapping = result.rows[0];
    }

    // Write multi-group junction table
    if (groups && Array.isArray(groups)) {
      // Delete existing groups for this mapping, then insert new ones
      await db.query('DELETE FROM plan_mapping_groups WHERE mapping_id = $1', [mappingId]);
      for (const g of groups) {
        if (g.hardware_group_id) {
          await db.query(
            `INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id, door_name)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [mappingId, g.hardware_group_id, g.door_name || null]
          );
        }
      }
    }

    res.json(mapping);
  } catch (err) {
    console.error('[operator] PATCH plan-mappings/:mappingId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/plan-mappings/:mappingId/groups ──────
// Returns groups assigned to a specific plan mapping.
router.get('/:clientId/plan-mappings/:mappingId/groups', async (req, res) => {
  try {
    const { clientId, mappingId } = req.params;
    // Verify mapping belongs to client
    const check = await db.query('SELECT id FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Mapping not found' });

    const result = await db.query(
      'SELECT id, hardware_group_id, door_name, created_at FROM plan_mapping_groups WHERE mapping_id = $1 ORDER BY created_at',
      [mappingId]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    console.error('[operator] GET plan-mappings/:mappingId/groups error:', err.message);
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

// ── GET /operator/:clientId/recent-members ──────────────────────
// Returns the 5 most recently provisioned members for dashboard display.
router.get('/:clientId/recent-members', async (req, res) => {
  const { clientId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 5, 10);
  try {
    const result = await db.query(
      `SELECT mi.platform_member_id, mas.status, mas.updated_at
       FROM member_access_state mas
       JOIN member_identity mi ON mi.id = mas.member_id
       WHERE mas.client_id = $1
       ORDER BY mas.updated_at DESC
       LIMIT $2`,
      [clientId, limit]
    );
    res.json({ members: result.rows });
  } catch (err) {
    console.error('[operator] GET /:clientId/recent-members error:', err.message);
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

// ══ OB-31: Access Log endpoint ════════════════════════════════════
// GET /operator/:clientId/access-log
// Paginated access events for last 30 days with location + type filter.
router.get('/:clientId/access-log', async (req, res) => {
  const { clientId } = req.params;
  const { location_id, event_type, page = 1, limit = 25, start_date, end_date } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  try {
    const params = [clientId];
    const conditions = ['mal.client_id = $1'];

    if (start_date) {
      params.push(start_date);
      conditions.push(`mal.created_at >= $${params.length}::date`);
    } else {
      conditions.push("mal.created_at > NOW() - INTERVAL '30 days'");
    }
    if (end_date) {
      params.push(end_date);
      conditions.push(`mal.created_at < ($${params.length}::date + INTERVAL '1 day')`);
    }

    if (location_id) {
      params.push(location_id);
      conditions.push(
        `EXISTS (SELECT 1 FROM member_role_assignments mra
                 JOIN plan_mappings pm ON pm.id = mra.mapping_id AND pm.location_id = $${params.length}
                 WHERE mra.member_id = mal.member_id)`
      );
    }
    if (event_type) {
      params.push(event_type);
      conditions.push(`mal.event_type = $${params.length}`);
    }

    params.push(parseInt(limit));
    params.push(offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT mal.id, mal.event_type, mal.credential_type, mal.error_code,
                mal.created_at, mi.platform_member_id
         FROM member_access_log mal
         JOIN member_identity mi ON mi.id = mal.member_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY mal.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total
         FROM member_access_log mal
         WHERE ${conditions.join(' AND ')}`,
        params.slice(0, params.length - 2)
      ),
    ]);

    res.json({
      events: rows.rows,
      total:  countRow.rows[0].total,
      page:   parseInt(page),
      limit:  parseInt(limit),
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/access-log error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══ OB-32: Access Stats endpoint ══════════════════════════════════
// GET /operator/:clientId/access-stats
// Aggregated hourly averages over last 30 days for bar chart.
router.get('/:clientId/access-stats', async (req, res) => {
  const { clientId } = req.params;
  const { location_id } = req.query;

  try {
    const params = [clientId];
    let locationFilter = '';
    if (location_id) {
      params.push(location_id);
      locationFilter = `AND EXISTS (SELECT 1 FROM member_role_assignments mra
                         JOIN plan_mappings pm ON pm.id = mra.mapping_id AND pm.location_id = $${params.length}
                         WHERE mra.member_id = mal.member_id)`;
    }

    const result = await db.query(
      `SELECT EXTRACT(HOUR FROM mal.created_at)::int AS hour,
              COUNT(*)::int AS event_count,
              COUNT(DISTINCT DATE(mal.created_at))::int AS day_count
       FROM member_access_log mal
       WHERE mal.client_id = $1
         AND mal.created_at > NOW() - INTERVAL '30 days'
         ${locationFilter}
       GROUP BY EXTRACT(HOUR FROM mal.created_at)
       ORDER BY hour`,
      params
    );

    // Build 24-hour array with averages
    const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: i, avg: 0 }));
    result.rows.forEach(row => {
      const days = row.day_count || 1;
      hourly[row.hour].avg = Math.round((row.event_count / days) * 10) / 10;
    });

    res.json({ hourly });
  } catch (err) {
    console.error('[operator] GET /:clientId/access-stats error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══ Wix Plans API (outbound) ═══════════════════════════════════════

// ── GET /operator/:clientId/wix-plans ────────────────────────────
// Fetches all pricing plans + booking services from Wix for the plan mapping page.
// Auto-creates plan_mappings rows for new plans/services (auto-accept).
router.get('/:clientId/wix-plans', async (req, res) => {
  try {
    const { clientId } = req.params;
    const client = await db.query('SELECT id, wix_api_key, site_id FROM clients WHERE id = $1', [clientId]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!client.rows[0].wix_api_key) {
      return res.status(400).json({ error: 'No Wix API key set for this client', plans: [] });
    }
    if (!client.rows[0].site_id) {
      return res.status(400).json({ error: 'No Wix site ID set for this client', plans: [] });
    }

    const apiKey = decryptKey(client.rows[0].wix_api_key);
    const allPlans = await wixPlansApi.listAllMappable(apiKey, client.rows[0].site_id);

    // Auto-accept: create plan_mappings rows for plans not yet in DB
    if (allPlans.length > 0) {
      const existing = await db.query(
        'SELECT source_plan_id FROM plan_mappings WHERE client_id = $1',
        [clientId]
      );
      const existingIds = new Set(existing.rows.map(r => r.source_plan_id));

      for (const plan of allPlans) {
        if (!existingIds.has(plan.id)) {
          await db.query(
            `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, status, created_at)
             VALUES ($1, $2, '', $3, 'inactive', NOW())
             ON CONFLICT DO NOTHING`,
            [clientId, plan.id, plan.name]
          ).catch(e => console.warn('[wix-plans] Auto-insert failed for', plan.id, e.message));
        }
      }
    }

    res.json({ plans: allPlans });
  } catch (err) {
    console.error('[operator] GET /:clientId/wix-plans error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Wix API key management ──────────────────────────────────────

// GET /operator/clients/:clientId/wix-api-key/status
router.get('/clients/:clientId/wix-api-key/status', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await db.query('SELECT wix_api_key FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ hasKey: !!result.rows[0].wix_api_key });
  } catch (err) {
    console.error('[operator] GET wix-api-key/status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /operator/clients/:clientId/wix-api-key
router.put('/clients/:clientId/wix-api-key', async (req, res) => {
  try {
    const { clientId } = req.params;
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.trim()) return res.status(400).json({ error: 'apiKey is required' });

    const encrypted = encryptApiKey(apiKey.trim());
    const result = await db.query(
      'UPDATE clients SET wix_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
      [encrypted, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, message: 'Wix API key saved' });
  } catch (err) {
    console.error('[operator] PUT wix-api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /operator/clients/:clientId/wix-api-key/test
router.get('/clients/:clientId/wix-api-key/test', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await db.query('SELECT wix_api_key, site_id FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!result.rows[0].wix_api_key) return res.json({ valid: false, error: 'No Wix API key set' });
    if (!result.rows[0].site_id) return res.json({ valid: false, error: 'No Wix site ID set for this client' });

    const apiKey = decryptKey(result.rows[0].wix_api_key);
    const testResult = await wixPlansApi.testApiKey(apiKey, result.rows[0].site_id);
    res.json(testResult);
  } catch (err) {
    console.error('[operator] GET wix-api-key/test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
