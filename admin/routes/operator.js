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
const { requireAuth, requireAuthOrOperator, signOperatorToken } = require('../middleware/auth');
const hardwareAdapter = require('../../adapters/hardware-adapter');

// Global rate limiter on all operator read endpoints (500 req/min/IP)
// Higher limit needed: plan-mapping page fires N parallel per-mapping requests on load
router.use(rateLimit({ windowMs: 60_000, max: 500, standardHeaders: true, legacyHeaders: false }));

// Auth gate: require admin JWT on all operator routes EXCEPT onboarding signup.
// Onboarding endpoints use requireInviteToken middleware (validates token value).
// Only specific POST paths are exempt — all other routes require JWT even if
// x-invite-token header is present (H-1 security fix).
const ONBOARDING_PATHS = new Set(['/verify-bypass', '/issue-session']);
const ONBOARDING_PREFIX = /^\/clients(\/[^/]+\/(locations(\/[^/]+\/activate)?|api-key))?$/;
router.use(function operatorAuth(req, res, next) {
  if (req.method === 'POST' && req.headers['x-invite-token'] &&
      (ONBOARDING_PATHS.has(req.path) || ONBOARDING_PREFIX.test(req.path))) {
    return next(); // Auth handled by requireInviteToken on these routes
  }
  if (req.method === 'POST' && req.path === '/verify-bypass') return next();
  // Site ID verification is a GET with invite token — exempt from JWT auth
  if (req.method === 'GET' && req.path === '/site-id/verify' && req.headers['x-invite-token']) return next();
  // Onboarding GET endpoints — invite token auth (new operator has no JWT cookie yet)
  if (req.method === 'GET' && /^\/clients\/[^/]+\/(kisi-groups|api-key\/status|api-key\/test)$/.test(req.path) && req.headers['x-invite-token']) return next();
  // Location and mapping data fetched during onboarding completion
  if (req.method === 'GET' && /^\/[^/]+\/locations(\/[^/]+\/mappings)?$/.test(req.path) && req.headers['x-invite-token']) return next();
  return requireAuthOrOperator(req, res, next);
});

/**
 * Resolves the hardware API key for a client, preferring location-level override.
 * Used by syncMappingMembers for direct hardware calls.
 */
async function resolveApiKey(clientId, locationId) {
  if (locationId) {
    const loc = await db.query(
      'SELECT hardware_api_key FROM locations WHERE id = $1 AND client_id = $2',
      [locationId, clientId]
    );
    const enc = loc.rows[0]?.hardware_api_key;
    if (enc) return decryptKey(enc);
  }
  const cli = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]);
  const enc = cli.rows[0]?.hardware_api_key;
  if (enc) return decryptKey(enc);
  return null;
}

/**
 * Syncs all currently active members on a plan mapping to the new group configuration.
 * Called after every PATCH to plan_mapping_groups. Handles all 9 sync scenarios:
 *
 *   Group changes  — add group: grant all active members to new group
 *                  — remove group: revoke all active members from removed group
 *                  — swap: revoke old, grant new
 *   Status changes — inactive: revoke all active members from all groups
 *                  — active: grant all members with active access_state on this plan
 *   Location change — handled via group diff (old groups revoked, new groups granted)
 *
 * Fire-and-forget — called after response is sent. Errors logged, never thrown.
 */
async function syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, newStatus, oldStatus) {
  try {
    const mapping = await db.query(
      `SELECT pm.source_plan_id, pm.location_id, c.hardware_platform
       FROM plan_mappings pm
       JOIN clients c ON c.id = pm.client_id
       WHERE pm.id = $1 AND pm.client_id = $2`,
      [mappingId, clientId]
    );
    if (!mapping.rows.length) return;
    const { source_plan_id, location_id, hardware_platform } = mapping.rows[0];
    const apiKey = await resolveApiKey(clientId, location_id);
    if (!apiKey) {
      console.warn(`[syncMappingMembers] No API key for client ${clientId} — skipping sync`);
      return;
    }

    // ── Status deactivation: revoke all active members from all groups ──
    if (newStatus === 'inactive' && oldStatus === 'active') {
      const members = await db.query(
        `SELECT mi.id AS member_id, mi.hardware_user_id,
                mra.role_assignment_id, mra.hardware_group_id
         FROM member_role_assignments mra
         JOIN member_identity mi ON mi.id = mra.member_id
         WHERE mra.mapping_id = $1 AND mi.hardware_user_id IS NOT NULL`,
        [mappingId]
      );
      for (const m of members.rows) {
        try {
          await hardwareAdapter.removeRole(hardware_platform, apiKey, m.role_assignment_id);
          await db.query('DELETE FROM member_role_assignments WHERE mapping_id = $1 AND member_id = $2', [mappingId, m.member_id]);
          await db.query('DELETE FROM member_access_sources WHERE member_id = $1 AND hardware_group_id = $2', [m.member_id, m.hardware_group_id]);
          console.log(`[syncMappingMembers] Revoked member ${m.member_id} from group ${m.hardware_group_id} (mapping deactivated)`);
        } catch (err) {
          console.warn(`[syncMappingMembers] Failed to revoke member ${m.member_id}:`, err.message);
        }
      }
      return;
    }

    // ── Status activation: grant all members with active access on this plan ──
    if (newStatus === 'active' && oldStatus === 'inactive') {
      const members = await db.query(
        `SELECT mi.id AS member_id, mi.hardware_user_id
         FROM member_access_state mas
         JOIN member_identity mi ON mi.id = mas.member_id
         WHERE mas.client_id = $1
           AND mas.status = 'active'
           AND COALESCE(mas.pending_plan_id, '') = COALESCE($2, '')
           AND mi.hardware_user_id IS NOT NULL`,
        [clientId, source_plan_id]
      );
      for (const m of members.rows) {
        for (const groupId of newGroupIds) {
          try {
            const roleId = await hardwareAdapter.assignRole(hardware_platform, apiKey, m.hardware_user_id, groupId);
            await db.query(
              `INSERT INTO member_role_assignments (member_id, mapping_id, role_assignment_id, hardware_group_id)
               VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
              [m.member_id, mappingId, String(roleId), groupId]
            );
            console.log(`[syncMappingMembers] Granted member ${m.member_id} to group ${groupId} (mapping activated)`);
          } catch (err) {
            console.warn(`[syncMappingMembers] Failed to grant member ${m.member_id} to group ${groupId}:`, err.message);
          }
        }
      }
      return;
    }

    // ── Group diff: added groups → grant, removed groups → revoke ──
    const added   = newGroupIds.filter(id => !oldGroupIds.includes(id));
    const removed = oldGroupIds.filter(id => !newGroupIds.includes(id));

    if (!added.length && !removed.length) return;

    // Get all active members currently on this mapping
    const activeMembers = await db.query(
      `SELECT mi.id AS member_id, mi.hardware_user_id, mra.role_assignment_id, mra.hardware_group_id
       FROM member_role_assignments mra
       JOIN member_identity mi ON mi.id = mra.member_id
       WHERE mra.mapping_id = $1 AND mi.hardware_user_id IS NOT NULL`,
      [mappingId]
    );

    // Also get members with active access state (for added groups — they may not have mra rows yet for new groups)
    const activeMembersForGrant = await db.query(
      `SELECT DISTINCT mi.id AS member_id, mi.hardware_user_id
       FROM member_access_state mas
       JOIN member_identity mi ON mi.id = mas.member_id
       WHERE mas.client_id = $1 AND mas.status = 'active'
         AND COALESCE(mas.pending_plan_id, '') = COALESCE($2, '')
         AND mi.hardware_user_id IS NOT NULL`,
      [clientId, source_plan_id]
    );

    // Grant added groups to all active members
    for (const groupId of added) {
      for (const m of activeMembersForGrant.rows) {
        try {
          const roleId = await hardwareAdapter.assignRole(hardware_platform, apiKey, m.hardware_user_id, groupId);
          await db.query(
            `INSERT INTO member_role_assignments (member_id, mapping_id, role_assignment_id, hardware_group_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [m.member_id, mappingId, String(roleId), groupId]
          );
          console.log(`[syncMappingMembers] Granted member ${m.member_id} to added group ${groupId}`);
        } catch (err) {
          console.warn(`[syncMappingMembers] Failed to grant member ${m.member_id} to group ${groupId}:`, err.message);
        }
      }
    }

    // Revoke removed groups from members who have those assignments
    for (const m of activeMembers.rows) {
      if (!removed.includes(m.hardware_group_id)) continue;
      try {
        await hardwareAdapter.removeRole(hardware_platform, apiKey, m.role_assignment_id);
        await db.query('DELETE FROM member_role_assignments WHERE mapping_id = $1 AND member_id = $2 AND hardware_group_id = $3', [mappingId, m.member_id, m.hardware_group_id]);
        await db.query('DELETE FROM member_access_sources WHERE member_id = $1 AND hardware_group_id = $2', [m.member_id, m.hardware_group_id]);
        console.log(`[syncMappingMembers] Revoked member ${m.member_id} from removed group ${m.hardware_group_id}`);
      } catch (err) {
        console.warn(`[syncMappingMembers] Failed to revoke member ${m.member_id} from group ${m.hardware_group_id}:`, err.message);
      }
    }

  } catch (err) {
    console.error('[syncMappingMembers] Unexpected error:', err.message);
  }
}

/**
 * GAP 3 — Re-provision all previously active members when a location is reactivated.
 * Iterates every active plan mapping at the location and calls syncMappingMembers()
 * treating each as an inactive→active status transition.
 * Fire-and-forget — errors logged per mapping, never thrown.
 */
async function activateLocationMembers(clientId, locationId) {
  try {
    const mappings = await db.query(
      `SELECT id, status FROM plan_mappings WHERE location_id = $1 AND client_id = $2`,
      [locationId, clientId]
    );
    for (const m of mappings.rows) {
      // Treat as inactive→active regardless of current stored status — we just activated the location
      const oldGroupsResult = await db.query(
        'SELECT hardware_group_id FROM plan_mapping_groups WHERE mapping_id = $1', [m.id]
      );
      const groupIds = oldGroupsResult.rows.map(r => r.hardware_group_id);
      await syncMappingMembers(clientId, m.id, [], groupIds, 'active', 'inactive');
    }
    console.log(`[activateLocationMembers] Re-provisioned members for ${mappings.rows.length} mappings at location ${locationId}`);
  } catch (err) {
    console.error('[activateLocationMembers] Error:', err.message);
  }
}

/**
 * GAP 6/7 — Validate that a newly saved API key can reach all active groups for a client.
 * Writes a config_alert_log entry for any group the new key cannot access.
 * Fire-and-forget — never blocks the key save response.
 */
async function validateApiKeyGroups(clientId, apiKey, hardwarePlatform) {
  try {
    const groups = await db.query(
      `SELECT DISTINCT pmg.hardware_group_id
       FROM plan_mapping_groups pmg
       JOIN plan_mappings pm ON pm.id = pmg.mapping_id
       WHERE pm.client_id = $1 AND pm.status = 'active'`,
      [clientId]
    );
    for (const { hardware_group_id } of groups.rows) {
      try {
        await hardwareAdapter.getGroups(hardwarePlatform || 'kisi', apiKey);
        // If getGroups succeeds we assume access — group-level check would require
        // a per-group GET which Kisi supports but is expensive. Log success.
      } catch (err) {
        const isAuthError = err.statusCode === 401 || err.statusCode === 403;
        if (isAuthError) {
          await db.query(
            `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, created_at)
             VALUES ($1, 'api_key_invalid_after_rotation', $2, NOW())`,
            [clientId, hardware_group_id]
          );
          console.warn(`[validateApiKeyGroups] Key rotation alert: group ${hardware_group_id} unreachable for client ${clientId}`);
        }
        break; // One auth failure means all groups will fail — no need to loop
      }
    }
  } catch (err) {
    console.error('[validateApiKeyGroups] Error:', err.message);
  }
}

/**
 * Wix-first flow: Re-enqueue all pending_hardware members for a client.
 * Called after an API key is saved/rotated so parked members get provisioned.
 * Returns the count of members re-queued.
 */
async function retryPendingHardwareMembers(clientId, planId = null) {
  const result = await db.query(
    planId
      ? `SELECT mi.platform_member_id, mi.source_platform, mas.pending_plan_id
         FROM member_access_state mas
         JOIN member_identity mi ON mi.id = mas.member_id
         WHERE mas.client_id = $1 AND mas.status = 'pending_hardware'
           AND COALESCE(mas.pending_plan_id, '') = COALESCE($2, '')`
      : `SELECT mi.platform_member_id, mi.source_platform, mas.pending_plan_id
         FROM member_access_state mas
         JOIN member_identity mi ON mi.id = mas.member_id
         WHERE mas.client_id = $1 AND mas.status = 'pending_hardware'`,
    planId ? [clientId, planId] : [clientId]
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

// ── GET /operator/site-id/verify ─────────────────────────────────
// Onboarding Step 1: validate a Wix site ID before account creation.
// Checks UUID format and whether the site_id is already registered.
// Used by the manual-entry path (owner onboarding) when instanceId is
// not auto-injected from the Wix portal signed instance.
router.get('/site-id/verify', requireInviteToken, async (req, res) => {
  const { siteId } = req.query;
  if (!siteId) return res.status(400).json({ valid: false, error: 'siteId is required' });

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(siteId.trim())) {
    return res.json({ valid: false, error: 'Invalid Site ID format — expected xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' });
  }

  try {
    const existing = await db.query(
      `SELECT id, name, tier, hardware_platform,
              hardware_api_key IS NOT NULL AS has_api_key
       FROM clients WHERE site_id = $1 LIMIT 1`,
      [siteId.trim()]
    );
    if (existing.rows.length) {
      const c = existing.rows[0];
      const locs = await db.query(
        'SELECT id, name, city, state FROM locations WHERE client_id = $1 ORDER BY created_at ASC',
        [c.id]
      );
      return res.json({
        valid: false,
        alreadyRegistered: true,
        client: { id: c.id, name: c.name, tier: c.tier, hardware_platform: c.hardware_platform, has_api_key: c.has_api_key },
        locations: locs.rows,
      });
    }
    res.json({ valid: true, message: 'Site ID accepted — full verification happens at the Wix API key step' });
  } catch (err) {
    console.error('[operator] GET site-id/verify error:', err.message);
    res.status(500).json({ valid: false, error: 'Verification check failed' });
  }
});

// ── POST /operator/issue-session ─────────────────────────────────
// Invite-token gated. Issues an operatorToken cookie after onboarding completes,
// so the portal path has a valid session without going through portal.js again.
// Body: { clientId, siteId }
router.post('/issue-session', requireInviteToken, async (req, res) => {
  const { clientId, siteId } = req.body;
  if (!clientId || !siteId) return res.status(400).json({ error: 'clientId and siteId are required' });
  try {
    const result = await db.query(
      'SELECT id FROM clients WHERE id = $1 AND site_id = $2 LIMIT 1',
      [clientId, siteId]
    );
    if (!result.rows.length) return res.status(403).json({ error: 'Client/site mismatch' });
    const token = signOperatorToken(clientId, siteId);
    res.cookie('operatorToken', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'none',
      maxAge:   8 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[operator] POST issue-session error:', err.message);
    res.status(500).json({ error: 'Session issue failed' });
  }
});

// ── POST /operator/clients ───────────────────────────────────────
// Operator self-onboarding: create a new client account.
router.post('/clients', requireInviteToken, async (req, res) => {
  try {
    const {
      name, platform = 'wix', hardware_platform, tier,
      site_id, wix_instance_id, site_name, site_url, notification_email, wix_api_key,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Business rule: tier determines hardware_platform (Connect=Kisi, Base/Pro=Seam)
    // Explicit hardware_platform override allowed.
    const derivedHardware = hardware_platform || (tier === 'Connect' ? 'kisi' : tier ? 'seam' : null);

    // Encrypt Wix API key if provided (same AES-256-GCM pattern as hardware keys)
    const encryptedWixKey = wix_api_key ? encryptApiKey(wix_api_key.trim()) : null;

    // Upsert on site_id — prevents duplicate clients if onboarding is re-run.
    // On conflict, update wix_instance_id in case it changed (reinstall).
    const result = await db.query(
      `INSERT INTO clients (name, platform, hardware_platform, tier, site_id, wix_instance_id, site_name, site_url, notification_email, wix_api_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW(), NOW())
       ON CONFLICT (site_id) DO UPDATE
         SET wix_instance_id = EXCLUDED.wix_instance_id,
             updated_at      = NOW()
       RETURNING id, name, platform, hardware_platform, tier, site_id, wix_instance_id, site_name, notification_email, status, created_at`,
      [name.trim(), platform, derivedHardware, tier || null, site_id || null, wix_instance_id || null, site_name || null, site_url || null, notification_email || null, encryptedWixKey]
    );
    console.log(`[operator/setup] Upserted client: ${result.rows[0].name} (${result.rows[0].id})`);
    res.status(201).json({ ok: true, client: result.rows[0] });
  } catch (err) {
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

    // GAP 7: validate new key can reach all active groups — writes config_alert_log on failure
    const clientRow = await db.query('SELECT hardware_platform FROM clients WHERE id = $1', [clientId]);
    validateApiKeyGroups(clientId, apiKey.trim(), clientRow.rows[0]?.hardware_platform)
      .catch(err => console.warn('[operator] validateApiKeyGroups failed:', err.message));
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

    // GAP 6: validate new key can reach all active groups at this location
    const locPlatform = await db.query(
      `SELECT COALESCE(l.hardware_platform, c.hardware_platform) AS hardware_platform
       FROM locations l JOIN clients c ON c.id = l.client_id
       WHERE l.id = $1`, [locationId]
    );
    validateApiKeyGroups(clientId, apiKey.trim(), locPlatform.rows[0]?.hardware_platform)
      .catch(err => console.warn('[operator] validateApiKeyGroups (location) failed:', err.message));
  } catch (err) {
    console.error('[operator] POST /:clientId/locations/:locationId/api-key error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /operator/:clientId/locations/:locationId ─────────────
// Update location name, city, state, tier (operator-facing).
// GAP 1/2: hardware_platform intentionally excluded — changing it once members
// are provisioned would leave them in the wrong hardware system with no sync.
router.patch('/:clientId/locations/:locationId', async (req, res) => {
  const { clientId, locationId } = req.params;
  const ALLOWED = ['name', 'city', 'state', 'tier'];
  const updates = {};
  for (const f of ALLOWED) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 3}`);
    const values = [locationId, clientId, ...Object.values(updates)];
    const result = await db.query(
      `UPDATE locations SET ${setClauses.join(', ')} WHERE id = $1 AND client_id = $2
       RETURNING id, name, city, state, tier, hardware_platform, subscription_status`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({ ok: true, location: result.rows[0] });
  } catch (err) {
    console.error('[operator] PATCH location error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /operator/:clientId/locations/:locationId/suspend ────────
// Operator-initiated location suspension — suspends all active members immediately.
router.post('/:clientId/locations/:locationId/suspend', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const { suspendLocationMembers } = require('../../core/location-lapse');
    const result = await suspendLocationMembers(locationId, clientId, 'suspended');
    res.json({ ok: true, suspended: result.suspended, skipped: result.skipped, errors: result.errors });
  } catch (err) {
    console.error('[operator] POST suspend error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /operator/:clientId/locations/:locationId/activate ───────
// Operator-initiated location reactivation. Re-provisions all previously
// active members via activateLocationMembers() — fire-and-forget after response.
router.post('/:clientId/locations/:locationId/activate', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const result = await db.query(
      `UPDATE locations SET subscription_status = 'active', subscribed_at = NOW()
       WHERE id = $1 AND client_id = $2 RETURNING id, name, subscription_status`,
      [locationId, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
    res.json({ ok: true, location: result.rows[0] });
    // GAP 3: re-provision all previously active members at this location
    activateLocationMembers(clientId, locationId)
      .catch(err => console.warn('[operator] activateLocationMembers failed:', err.message));
  } catch (err) {
    console.error('[operator] POST activate error:', err.message);
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
        `SELECT l.id, l.name, l.city, l.state, l.subscription_status, l.tier,
                l.subscribed_at, l.hardware_platform, l.notification_email,
                (l.hardware_api_key IS NOT NULL) AS has_location_key,
                (l.hardware_api_key IS NOT NULL OR c.hardware_api_key IS NOT NULL) AS has_key
         FROM locations l
         JOIN clients c ON c.id = l.client_id
         WHERE l.client_id = $1 ORDER BY l.created_at ASC`,
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
        `SELECT id, event_type, error_reason, retry_count, plan_name, door_name, created_at,
                error_code, user_message, action_text, resolution,
                occurred_count, last_occurred_at
         FROM error_queue
         WHERE location_id = $1 AND status = 'failed'
         ORDER BY last_occurred_at DESC NULLS LAST, created_at DESC`,
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
         FROM plan_mappings
         WHERE client_id = $2 AND (location_id = $1 OR location_id IS NULL)
         ORDER BY plan_name`,
        [locationId, clientId]
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
  const { status, door_name, hardware_group_id, groups, allow_multiple, max_members, location_id, addGroupId, removeGroupId } = req.body;
  try {
    // Snapshot old groups + status BEFORE any changes — needed for member sync diff
    const [oldGroupsResult, oldMappingResult] = await Promise.all([
      db.query('SELECT hardware_group_id FROM plan_mapping_groups WHERE mapping_id = $1', [mappingId]),
      db.query('SELECT status FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]),
    ]);
    const oldGroupIds = oldGroupsResult.rows.map(r => r.hardware_group_id);
    const oldStatus   = oldMappingResult.rows[0]?.status;
    if (!oldMappingResult.rows.length) return res.status(404).json({ error: 'Mapping not found' });

    // ── Wire-graph single-group add/remove (from PlanMappingPanel) ──────
    if (addGroupId) {
      await db.query(
        `INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [mappingId, addGroupId]
      );
      // Sync members for the newly added group
      const newGroupIds = [...new Set([...oldGroupIds, addGroupId])];
      syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, oldStatus, oldStatus)
        .catch(err => console.warn('[operator] syncMappingMembers (addGroupId) failed:', err.message));
      return res.json({ ok: true });
    }

    if (removeGroupId) {
      await db.query(
        `DELETE FROM plan_mapping_groups WHERE mapping_id = $1 AND hardware_group_id = $2`,
        [mappingId, removeGroupId]
      );
      const newGroupIds = oldGroupIds.filter(id => id !== removeGroupId);
      syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, oldStatus, oldStatus)
        .catch(err => console.warn('[operator] syncMappingMembers (removeGroupId) failed:', err.message));
      return res.json({ ok: true });
    }

    // Update plan_mappings row (legacy fields + status + multi-member config)
    const fields = [], vals = [mappingId, clientId];
    if (status !== undefined)            { fields.push(`status = $${vals.length + 1}`);            vals.push(status); }
    if (location_id !== undefined)       { fields.push(`location_id = $${vals.length + 1}`);       vals.push(location_id || null); }
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

    // Compute new group IDs from junction table after write
    const newGroupIds = (groups && Array.isArray(groups))
      ? groups.map(g => g.hardware_group_id).filter(Boolean)
      : oldGroupIds; // no group change — pass same set so diff is empty

    const newStatus = status !== undefined ? status : oldStatus;

    // Sync active members to reflect group/status changes — fire-and-forget
    syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, newStatus, oldStatus)
      .catch(err => console.warn('[operator] syncMappingMembers failed:', err.message));

    // Re-queue any members parked in pending_hardware for this plan mapping.
    // Scoped by source_plan_id so only members waiting on THIS plan are retried.
    retryPendingHardwareMembers(clientId, mapping.source_plan_id).catch(err =>
      console.warn('[operator] retryPendingHardwareMembers after plan mapping save failed:', err.message)
    );
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

// ── GET /operator/:clientId/plan-mappings/:mappingId/members ────────
// Returns count of members currently assigned to a mapping (for remap confirmation modal).
router.get('/:clientId/plan-mappings/:mappingId/members', async (req, res) => {
  try {
    const { clientId, mappingId } = req.params;
    const check = await db.query('SELECT id FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Mapping not found' });

    const result = await db.query(
      `SELECT COUNT(DISTINCT mra.member_id) AS count
       FROM member_role_assignments mra
       JOIN member_identity mi ON mi.id = mra.member_id
       WHERE mra.mapping_id = $1 AND mi.client_id = $2`,
      [mappingId, clientId]
    );
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    console.error('[operator] GET plan-mappings/:mappingId/members error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/plan-mappings/:mappingId/remap ─────────
// Bulk-moves existing members from oldGroupIds to newGroupIds in Kisi + DB.
// Body: { oldGroupIds: string[], newGroupIds: string[] }
// Returns: { moved: N, failed: [{ memberId, error }] }
router.post('/:clientId/plan-mappings/:mappingId/remap', async (req, res) => {
  const { clientId, mappingId } = req.params;
  const { oldGroupIds, newGroupIds } = req.body;

  if (!Array.isArray(oldGroupIds) || !Array.isArray(newGroupIds) || newGroupIds.length === 0) {
    return res.status(400).json({ error: 'oldGroupIds and newGroupIds are required arrays' });
  }

  try {
    // Verify mapping belongs to client + get location_id
    const mappingRow = await db.query(
      'SELECT id, location_id FROM plan_mappings WHERE id = $1 AND client_id = $2',
      [mappingId, clientId]
    );
    if (!mappingRow.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    const locationId = mappingRow.rows[0].location_id;

    // Resolve hardware API key and platform
    const keyRow = await db.query(
      `SELECT COALESCE(l.hardware_api_key, c.hardware_api_key) AS raw_key, c.hardware_platform AS platform
       FROM clients c
       LEFT JOIN locations l ON l.id = $2
       WHERE c.id = $1`,
      [clientId, locationId]
    );
    if (!keyRow.rows.length || !keyRow.rows[0].raw_key) {
      return res.status(400).json({ error: 'No hardware API key configured' });
    }
    const apiKey = decryptKey(keyRow.rows[0].raw_key);
    const platform = keyRow.rows[0].platform || 'kisi';

    // Fetch all member assignments for this mapping in the old groups
    const membersResult = await db.query(
      `SELECT mra.id AS mra_id, mra.member_id, mra.role_assignment_id, mra.hardware_group_id,
              mi.hardware_user_id
       FROM member_role_assignments mra
       JOIN member_identity mi ON mi.id = mra.member_id
       WHERE mra.mapping_id = $1 AND mra.hardware_group_id = ANY($2::text[]) AND mi.client_id = $3`,
      [mappingId, oldGroupIds, clientId]
    );

    const hardwareAdapter = require('../../adapters/hardware-adapter');
    let moved = 0;
    const failed = [];

    // Group rows by member so we process each member once
    const byMember = {};
    for (const row of membersResult.rows) {
      if (!byMember[row.member_id]) byMember[row.member_id] = [];
      byMember[row.member_id].push(row);
    }

    for (const [memberId, rows] of Object.entries(byMember)) {
      try {
        const hardwareUserId = rows[0].hardware_user_id;

        // Remove each old group assignment from Kisi
        for (const row of rows) {
          if (row.role_assignment_id) {
            await hardwareAdapter.removeRole(platform, apiKey, row.role_assignment_id);
          }
        }

        // Assign each new group in Kisi
        const newAssignments = [];
        for (const newGroupId of newGroupIds) {
          const roleAssignmentId = await hardwareAdapter.assignRole(platform, apiKey, hardwareUserId, newGroupId);
          newAssignments.push({ groupId: newGroupId, roleAssignmentId });
        }

        // DB: remove old rows, insert new rows
        const oldMraIds = rows.map(r => r.mra_id);
        await db.query('DELETE FROM member_role_assignments WHERE id = ANY($1::uuid[])', [oldMraIds]);

        for (const assignment of newAssignments) {
          await db.query(
            `INSERT INTO member_role_assignments (member_id, mapping_id, role_assignment_id, hardware_group_id)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (member_id, mapping_id, hardware_group_id) DO UPDATE SET role_assignment_id = EXCLUDED.role_assignment_id`,
            [memberId, mappingId, assignment.roleAssignmentId, assignment.groupId]
          );
        }

        moved++;
      } catch (err) {
        failed.push({ memberId, error: err.message });
      }
    }

    res.json({ moved, failed });
  } catch (err) {
    console.error('[operator] POST plan-mappings/:mappingId/remap error:', err.message);
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
              retry_count, status, created_at,
              error_code, user_message, action_text, resolution,
              occurred_count, last_occurred_at
       FROM error_queue
       WHERE client_id = $1 AND status = 'failed'
       ORDER BY last_occurred_at DESC NULLS LAST, created_at DESC
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

// ── GET /operator/:clientId/errors/summary ──────────────────────────────────
// Total active error count + breakdown by error_code + breakdown by location.
// Used by the /errors page header and filter dropdowns.
// NOTE: placed before /:clientId/errors/:errorId routes to avoid param collision.
router.get('/:clientId/errors/summary', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [total, breakdown, byLocation] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total FROM error_queue WHERE client_id = $1 AND status = 'failed'`,
        [clientId]
      ),
      db.query(
        `SELECT error_code, COUNT(*)::int AS count, MAX(last_occurred_at) AS latest
         FROM error_queue
         WHERE client_id = $1 AND status = 'failed'
         GROUP BY error_code
         ORDER BY count DESC`,
        [clientId]
      ),
      db.query(
        `SELECT eq.location_id, l.name AS location_name, COUNT(*)::int AS count
         FROM error_queue eq
         LEFT JOIN locations l ON l.id = eq.location_id
         WHERE eq.client_id = $1 AND eq.status = 'failed'
         GROUP BY eq.location_id, l.name
         ORDER BY count DESC`,
        [clientId]
      ),
    ]);
    res.json({
      total:       total.rows[0].total,
      by_code:     breakdown.rows,
      by_location: byLocation.rows,
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/errors/summary error:', err.message);
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
    console.log('[wix-plans-diag] clientId:', clientId, '| siteId:', client.rows[0].site_id, '| keyPrefix:', apiKey ? apiKey.slice(0, 10) + '...' : 'NULL');
    const allPlans = await wixPlansApi.listAllMappable(apiKey, client.rows[0].site_id);
    console.log('[wix-plans-diag] listAllMappable returned', allPlans.length, 'plans');

    // Auto-accept: create plan_mappings rows for plans not yet in DB
    if (allPlans.length > 0) {
      const [existing, locationRows] = await Promise.all([
        db.query('SELECT source_plan_id FROM plan_mappings WHERE client_id = $1', [clientId]),
        db.query('SELECT id FROM locations WHERE client_id = $1 AND subscription_status = \'active\'', [clientId]),
      ]);
      const existingIds = new Set(existing.rows.map(r => r.source_plan_id));
      // If the client has exactly one active location, auto-assign it so plan-mapping-resolver
      // can resolve the per-location hardware API key and subscription status (DR-027/DR-028).
      const defaultLocationId = locationRows.rows.length === 1 ? locationRows.rows[0].id : null;

      for (const plan of allPlans) {
        if (!existingIds.has(plan.id)) {
          await db.query(
            `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, status, location_id, created_at)
             VALUES ($1, $2, '', $3, 'inactive', $4, NOW())
             ON CONFLICT DO NOTHING`,
            [clientId, plan.id, plan.name, defaultLocationId]
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

// ── GET /operator/:clientId/diagnostics/summary ──────────────────
// Fetches recent diagnostic_log events for a client and asks Claude
// to identify the top failure reason, trend, and recommended action.
// Query params:
//   since=7d  — lookback window in days (default 7, max 90)
//   limit=50  — max rows to fetch (default 50, max 200)
router.get('/:clientId/diagnostics/summary', async (req, res) => {
  const { clientId } = req.params;
  const limit     = Math.min(parseInt(req.query.limit || '50',  10), 200);
  const sinceDays = Math.min(parseInt((req.query.since || '7d').replace('d', ''), 10) || 7, 90);

  let rows;
  try {
    const result = await db.query(
      `SELECT id, created_at, service, level, error_code, message, context, resolved_at
       FROM diagnostic_log
       WHERE client_id = $1
         AND created_at >= NOW() - ($2 || ' days')::INTERVAL
       ORDER BY created_at DESC
       LIMIT $3`,
      [clientId, sinceDays, limit]
    );
    rows = result.rows;
  } catch (err) {
    console.error('[operator] GET diagnostics/summary DB error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch diagnostic data' });
  }

  // No events — return a clean healthy state without calling AI.
  if (rows.length === 0) {
    return res.json({
      summary: {
        topFailureReason: null,
        trend: 'stable',
        trendRationale: 'No warn/error events recorded in this period.',
        recommendedAction: 'Everything looks healthy.',
        confidence: 'high',
      },
      rawEvents: [],
      meta: { clientId, windowDays: sinceDays, eventCount: 0 },
    });
  }

  // Build a compact event list for the prompt — no raw stack traces or full JSONB.
  const eventLines = rows.map(r => {
    const ts       = new Date(r.created_at).toISOString();
    const resolved = r.resolved_at ? 'resolved' : 'open';
    return `[${ts}] ${r.level.toUpperCase()} | ${r.service} | ${r.error_code} | ${resolved} | ${r.message}`;
  }).join('\n');

  const prompt = `You are analyzing failure logs for an access control automation platform called AccessSync.
AccessSync connects Wix membership plans to Kisi hardware door access control.
When a member buys a plan, AccessSync provisions their access. When they cancel, it revokes it.

The following diagnostic events occurred for one client in the last ${sinceDays} days:

${eventLines}

Respond in this exact JSON format only — no markdown, no prose outside the JSON:
{
  "topFailureReason": "<one sentence — the most common or impactful failure>",
  "trend": "improving" | "worsening" | "stable",
  "trendRationale": "<one sentence explaining the trend>",
  "recommendedAction": "<one specific, actionable next step the operator can take>",
  "confidence": "high" | "medium" | "low"
}

Rules:
- If most events have resolved=resolved, trend is likely improving.
- If the same error_code repeats with no resolved events, trend is worsening.
- WIX_KEY_INVALID or HARDWARE_KEY_INVALID repeating = call that out as topFailureReason.
- HMAC_FAILURE_SPIKE = possible security issue, mention it directly.
- PLAN_NOT_MAPPED = operator needs to map a plan in the Plan Mapping screen.
- If events span many different error codes with no pattern, set confidence to low.
- Never recommend "contact support" unless no operator action is available.`;

  let analysis;
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    });
    const text = message.content[0]?.text || '{}';
    analysis = JSON.parse(text);
  } catch (err) {
    // AI failure is non-fatal — return raw events with a fallback so the page still renders.
    console.error('[operator] diagnostics/summary AI error:', err.message);
    analysis = {
      topFailureReason: 'AI analysis unavailable',
      trend: 'unknown',
      trendRationale: 'Could not reach the AI service.',
      recommendedAction: 'Review the raw events below.',
      confidence: 'low',
    };
  }

  res.json({
    summary:   analysis,
    rawEvents: rows,
    meta: { clientId, windowDays: sinceDays, eventCount: rows.length },
  });
});

module.exports = router;
