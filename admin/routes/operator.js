/**
 * @file operator.js
 * @layer admin/routes
 * @role operator-dashboard-api
 * @reads clients, locations, plan_mappings, plan_mapping_groups, member_identity,
 *        member_access_state, member_role_assignments, member_access_sources,
 *        member_access_log, error_queue, config_alert_log, diagnostic_log
 * @writes clients, locations, plan_mappings, plan_mapping_groups,
 *         member_role_assignments, member_access_sources, error_queue, config_alert_log
 * @calls hardware-adapter, kisi-adapter, kisi-connector, wix-plans-api,
 *        location-lapse, webhook-processor, crypto-utils, logger,
 *        reconciliation (sync/run, /members/:id/sync)
 * @exports router (Express)
 * @dr DR-022, DR-026, DR-027, DR-028, DR-034, DR-035
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
const kisiAdapter = require('../../adapters/kisi/kisi-adapter');
const kisiConnector = require('../../adapters/kisi/kisi-connector');
const { suspendLocationMembers } = require('../../core/location-lapse');
const { diagnoseMember, getTimeline } = require('../../core/diagnostics');
const { log } = require('../../core/logger');
const { getTraceId, getActor, runWith, mintTraceId } = require('../../core/trace-context');
const { recordActivity } = require('../middleware/activity');

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
 * Resolves the hardware API key for a client via connector_subscriptions.
 * Used by syncMappingMembers for direct hardware calls.
 */
async function resolveApiKey(clientId, locationId) {
  const cs = await db.query(
    `SELECT hardware_api_key FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
    [clientId]
  );
  const enc = cs.rows[0]?.hardware_api_key;
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
      `SELECT pm.source_plan_id, pm.location_id, cs.hardware_platform
       FROM plan_mappings pm
       JOIN connector_subscriptions cs ON cs.client_id = pm.client_id AND cs.status = 'active'
       WHERE pm.id = $1 AND pm.client_id = $2`,
      [mappingId, clientId]
    );
    if (!mapping.rows.length) return;
    const { source_plan_id, location_id, hardware_platform } = mapping.rows[0];
    const apiKey = await resolveApiKey(clientId, location_id);
    if (!apiKey) {
      log.warn('operator.sync.no_api_key', { clientId });
      return;
    }

    // ── Status deactivation: revoke all active members from all groups ──
    // C-4 safety: only call Kisi removeRole if no OTHER mapping grants the same group
    if (newStatus === 'inactive' && oldStatus === 'active') {
      const members = await db.query(
        `SELECT ma.id AS member_id, ma.hardware_user_id,
                mas.role_assignment_id, mas.hardware_group_id
         FROM member_access_sources mas
         JOIN member_access ma ON ma.id = mas.access_id
         WHERE mas.mapping_id = $1 AND ma.hardware_user_id IS NOT NULL`,
        [mappingId]
      );
      for (const m of members.rows) {
        try {
          await db.query('DELETE FROM member_access_sources WHERE access_id = $1 AND mapping_id = $2 AND hardware_group_id = $3', [m.member_id, mappingId, m.hardware_group_id]);

          const otherGrants = await db.query(
            `SELECT COUNT(*) AS cnt FROM member_access_sources
             WHERE access_id = $1 AND hardware_group_id = $2 AND mapping_id != $3`,
            [m.member_id, m.hardware_group_id, mappingId]
          );
          if (parseInt(otherGrants.rows[0].cnt, 10) > 0) {
            log.info('operator.sync.revoke_skipped', { memberId: m.member_id, hardwareGroupId: m.hardware_group_id, reason: 'other_mapping_grants' });
          } else {
            await hardwareAdapter.removeRole(hardware_platform, apiKey, m.role_assignment_id);
            log.info('operator.sync.revoked', { memberId: m.member_id, hardwareGroupId: m.hardware_group_id, reason: 'mapping_deactivated' });
          }
        } catch (err) {
          log.warn('operator.sync.revoke_failed', { memberId: m.member_id }, err);
        }
      }
      return;
    }

    // ── Status activation: grant all members with active access on this plan ──
    if (newStatus === 'active' && oldStatus === 'inactive') {
      const members = await db.query(
        `SELECT ma.id AS member_id, ma.hardware_user_id
         FROM member_access ma
         WHERE ma.client_id = $1
           AND ma.status = 'active'
           AND ma.plan_mapping_id = (SELECT id FROM plan_mappings WHERE source_plan_id = $2 AND client_id = $1 LIMIT 1)
           AND ma.hardware_user_id IS NOT NULL`,
        [clientId, source_plan_id]
      );
      for (const m of members.rows) {
        for (const groupId of newGroupIds) {
          try {
            const roleId = await hardwareAdapter.assignRole(hardware_platform, apiKey, m.hardware_user_id, groupId);
            await db.query(
              `INSERT INTO member_access_sources (access_id, mapping_id, hardware_group_id, role_assignment_id)
               VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
              [m.member_id, mappingId, groupId, String(roleId)]
            );
            log.info('operator.sync.granted', { memberId: m.member_id, hardwareGroupId: groupId, reason: 'mapping_activated' });
          } catch (err) {
            log.warn('operator.sync.grant_failed', { memberId: m.member_id, hardwareGroupId: groupId }, err);
          }
        }
      }
      return;
    }

    // ── Group diff: added groups → grant, removed groups → revoke ──
    const added   = newGroupIds.filter(id => !oldGroupIds.includes(id));
    const removed = oldGroupIds.filter(id => !newGroupIds.includes(id));

    if (!added.length && !removed.length) return;

    const activeMembers = await db.query(
      `SELECT ma.id AS member_id, ma.hardware_user_id, mas.role_assignment_id, mas.hardware_group_id
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE mas.mapping_id = $1 AND ma.hardware_user_id IS NOT NULL`,
      [mappingId]
    );

    // Also get members with active access (for added groups — they may not have source rows yet for new groups)
    const activeMembersForGrant = await db.query(
      `SELECT DISTINCT ma.id AS member_id, ma.hardware_user_id
       FROM member_access ma
       WHERE ma.client_id = $1 AND ma.status = 'active'
         AND ma.plan_mapping_id = (SELECT id FROM plan_mappings WHERE source_plan_id = $2 AND client_id = $1 LIMIT 1)
         AND ma.hardware_user_id IS NOT NULL`,
      [clientId, source_plan_id]
    );

    // Grant added groups to all active members
    for (const groupId of added) {
      for (const m of activeMembersForGrant.rows) {
        try {
          const roleId = await hardwareAdapter.assignRole(hardware_platform, apiKey, m.hardware_user_id, groupId);
          await db.query(
            `INSERT INTO member_access_sources (access_id, mapping_id, hardware_group_id, role_assignment_id)
             VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
            [m.member_id, mappingId, groupId, String(roleId)]
          );
          log.info('operator.sync.granted', { memberId: m.member_id, hardwareGroupId: groupId, reason: 'group_added' });
        } catch (err) {
          log.warn('operator.sync.grant_failed', { memberId: m.member_id, hardwareGroupId: groupId }, err);
        }
      }
    }

    // Revoke removed groups — but only call Kisi removeRole if no OTHER mapping
    // still grants the same group to this member (C-4 multi-source safety)
    for (const m of activeMembers.rows) {
      if (!removed.includes(m.hardware_group_id)) continue;
      try {
        await db.query('DELETE FROM member_access_sources WHERE access_id = $1 AND mapping_id = $2 AND hardware_group_id = $3', [m.member_id, mappingId, m.hardware_group_id]);

        // Check if ANY other mapping still grants this member the same group
        const otherGrants = await db.query(
          `SELECT COUNT(*) AS cnt FROM member_access_sources
           WHERE access_id = $1 AND hardware_group_id = $2 AND mapping_id != $3`,
          [m.member_id, m.hardware_group_id, mappingId]
        );
        if (parseInt(otherGrants.rows[0].cnt, 10) > 0) {
          log.info('operator.sync.revoke_skipped', { memberId: m.member_id, hardwareGroupId: m.hardware_group_id, reason: 'other_mapping_grants' });
        } else {
          await hardwareAdapter.removeRole(hardware_platform, apiKey, m.role_assignment_id);
          log.info('operator.sync.revoked', { memberId: m.member_id, hardwareGroupId: m.hardware_group_id, reason: 'group_removed' });
        }
      } catch (err) {
        log.warn('operator.sync.revoke_failed', { memberId: m.member_id, hardwareGroupId: m.hardware_group_id }, err);
      }
    }

  } catch (err) {
    log.error('operator.sync.unexpected_error', { clientId, mappingId }, err);
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
    log.info('operator.location.reactivated', { clientId, locationId, mappingCount: mappings.rows.length });
  } catch (err) {
    log.error('operator.location.reactivation_failed', { clientId, locationId }, err);
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
    if (groups.rows.length === 0) return;

    // getGroups is an auth check — one call tells us whether the key is valid for all groups.
    // Per-group validation would require individual GETs which Kisi supports but is expensive.
    try {
      await hardwareAdapter.getGroups(hardwarePlatform || 'kisi', apiKey);
    } catch (err) {
      const isAuthError = err.statusCode === 401 || err.statusCode === 403;
      if (isAuthError) {
        const _actor = getActor() || {};
        const _tid = getTraceId() || null;
        for (const { hardware_group_id } of groups.rows) {
          await db.query(
            `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, created_at, trace_id, actor_type, actor_id)
             VALUES ($1, 'api_key_invalid_after_rotation', $2, NOW(), $3, $4, $5)`,
            [clientId, hardware_group_id, _tid, _actor.type || null, _actor.id || null]
          );
        }
        log.warn('operator.apikey.key_invalid_after_rotation', { clientId, groupCount: groups.rows.length });
      }
    }
  } catch (err) {
    log.error('operator.apikey.validation_failed', { clientId }, err);
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
      ? `SELECT mm.platform_member_id, mm.source_platform, pm.source_plan_id AS pending_plan_id
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         JOIN plan_mappings pm ON pm.id = ma.plan_mapping_id
         WHERE ma.client_id = $1 AND ma.status = 'pending_hardware'
           AND pm.source_plan_id = $2`
      : `SELECT mm.platform_member_id, mm.source_platform, pm.source_plan_id AS pending_plan_id
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         LEFT JOIN plan_mappings pm ON pm.id = ma.plan_mapping_id
         WHERE ma.client_id = $1 AND ma.status = 'pending_hardware'`,
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

  log.info('operator.retry.pending_hardware', { clientId, count: result.rows.length });
  return result.rows.length;
}

// ── GET /operator/webhook-url ────────────────────────────────────
// Returns the core engine webhook URL for this installation.
// Used by the onboarding wizard Step 5. Must be before /:clientId.
router.get('/webhook-url', (req, res) => {
  const base = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
  res.json({ url: base ? `${base}/webhooks/wix` : null });
});

// ── GET /operator/:clientId/setup-snippets ────────────────────────
// Returns pre-populated Wix setup data for the Setup Guide tab:
// webhook URL, HMAC secret, and clientId — all operator-scoped.
// HMAC secret comes from WIX_WEBHOOK_SECRET env var (single secret per deployment).
router.get('/:clientId/setup-snippets', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    const base = (process.env.CORE_ENGINE_URL || '').replace(/\/$/, '');
    const webhookUrl   = base ? `${base}/webhooks/wix` : null;
    const hmacSecret   = process.env.WIX_WEBHOOK_SECRET || null;
    const adminHubBase = (process.env.ADMIN_HUB_URL || base || '').replace(/\/$/, '');
    res.json({ clientId, webhookUrl, hmacSecret, adminHubBase });
  } catch (err) {
    log.error('operator.setup_snippets.error', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
  log.info('operator.setup.bypass_accepted');
  res.json({ ok: true });
});

// ══ Operator Signup Endpoints ═════════════════════════════════════════════════
// OB-24: Protected by invite token. Operators receive a link with ?invite=TOKEN.
// Token checked against OPERATOR_INVITE_TOKEN env var. Without it, 403.
// Rate-limited to 5 requests per IP per minute as defense-in-depth.

const signupLimiter = rateLimit({ windowMs: 60_000, max: 5, standardHeaders: true, legacyHeaders: false });
function requireInviteToken(req, res, next) {
  // Rate-limit first (5 req/IP/min), then check invite token.
  signupLimiter(req, res, () => {
    // Token check — timing-safe comparison to prevent side-channel attacks
    const expected = process.env.OPERATOR_INVITE_TOKEN;
    if (!expected) {
      log.warn('operator.auth.invite_token_missing');
      return res.status(503).json({ error: 'Signup is not currently available' });
    }
    const token = req.headers['x-invite-token'];
    if (!token || Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return res.status(403).json({ error: 'Valid invite link required' });
    }
    next();
  });
}

// ── GET /operator/site-id/verify ─────────────────────────────────
// Onboarding Step 1: validate a Wix site ID before account creation.
// Checks UUID format and whether the source_site_id is already registered.
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
      `SELECT c.id, c.name,
              cs.hardware_platform,
              (ARRAY_AGG(DISTINCT bs.tier) FILTER (WHERE bs.tier IS NOT NULL))[1] AS tier,
              (cs.id IS NOT NULL) AS has_api_key
       FROM clients c
       LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       LEFT JOIN billing_subscriptions   bs ON bs.client_id = c.id AND bs.status = 'active'
       WHERE c.source_site_id = $1
       GROUP BY c.id, cs.id, cs.hardware_platform
       LIMIT 1`,
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
        client: {
          id: c.id,
          name: c.name,
          billing:   c.tier === null ? null : { tier: c.tier },
          connector: c.hardware_platform === null ? null : { platform: c.hardware_platform, has_key: c.has_api_key },
        },
        locations: locs.rows,
      });
    }
    res.json({ valid: true, message: 'Site ID accepted — full verification happens at the Wix API key step' });
  } catch (err) {
    log.error('operator.onboard.site_verify_failed', {}, err);
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
      'SELECT id FROM clients WHERE id = $1 AND source_site_id = $2 LIMIT 1',
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
    log.error('operator.onboard.session_issue_failed', { clientId }, err);
    res.status(500).json({ error: 'Session issue failed' });
  }
});

// ── POST /operator/clients ───────────────────────────────────────
// Operator self-onboarding: create a new client account.
router.post('/clients', requireInviteToken, async (req, res) => {
  try {
    const {
      name, platform = 'wix', hardware_platform, tier,
      source_site_id, platform_instance_id, source_site_name, source_site_url, notification_email, source_api_key,
    } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });

    // Business rule: tier determines hardware_platform (Connect=Kisi, Base/Pro=Seam)
    // Explicit hardware_platform override allowed.
    const derivedHardware = hardware_platform || (tier === 'Connect' ? 'kisi' : tier ? 'seam' : null);

    // Encrypt source platform API key if provided (AES-256-GCM pattern, same as hardware keys)
    const encryptedSourceKey = source_api_key ? encryptApiKey(source_api_key.trim()) : null;

    // Upsert on source_site_id — prevents duplicate clients if onboarding is re-run.
    // On conflict, update platform_instance_id in case it changed (reinstall).
    const result = await db.query(
      `INSERT INTO clients (name, platform, hardware_platform, tier, source_site_id, platform_instance_id, source_site_name, source_site_url, notification_email, source_api_key, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', NOW(), NOW())
       ON CONFLICT (source_site_id) DO UPDATE
         SET platform_instance_id = EXCLUDED.platform_instance_id,
             updated_at      = NOW()
       RETURNING id, name, platform, hardware_platform, tier, source_site_id, platform_instance_id, source_site_name, notification_email, status, created_at`,
      [name.trim(), platform, derivedHardware, tier || null, source_site_id || null, platform_instance_id || null, source_site_name || null, source_site_url || null, notification_email || null, encryptedSourceKey]
    );
    log.info('operator.setup.client_upserted', { clientId: result.rows[0].id, name: result.rows[0].name });
    res.status(201).json({ ok: true, client: result.rows[0] });
  } catch (err) {
    log.error('operator.setup.client_create_failed', {}, err);
    res.status(500).json({ error: 'Internal server error' });
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

    // Two INSERTs — locations row, then a paired billing_subscriptions row
    // ('inactive' until activate endpoint fires).
    const result = await db.query(
      `INSERT INTO locations (client_id, name, city, state, created_at)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, client_id, name, city, state, created_at`,
      [clientId, name.trim(), city || null, state || null]
    );
    if (tier) {
      await db.query(
        `INSERT INTO billing_subscriptions (client_id, location_id, tier, status)
         VALUES ($1, $2, $3, 'inactive')`,
        [clientId, result.rows[0].id, tier]
      );
    }
    log.info('operator.setup.location_created', { clientId, locationName: result.rows[0].name });
    res.status(201).json({
      ok: true,
      location: { ...result.rows[0], tier: tier || null, subscription_status: 'inactive' },
    });
  } catch (err) {
    log.error('operator.setup.location_create_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
    const clientCheck = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!clientCheck.rows.length) return res.status(404).json({ error: 'Client not found' });
    const existingCs = await db.query(
      `SELECT hardware_platform FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
      [clientId]
    );
    const hwPlatform = existingCs.rows[0]?.hardware_platform || 'kisi';
    await db.query(
      `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status, updated_at)
       VALUES ($1, $2, $3, 'active', NOW())
       ON CONFLICT (client_id, hardware_platform) DO UPDATE
         SET hardware_api_key = EXCLUDED.hardware_api_key,
             updated_at = NOW()`,
      [clientId, hwPlatform, encrypted]
    );
    log.info('operator.setup.apikey_set', { clientId });
    recordActivity(req, 'api_key.saved', { clientId });

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'API key saved', pendingRetried: retried });
  } catch (err) {
    log.error('operator.setup.apikey_save_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/clients/:clientId/locations/:locationId/activate ──
// Activates a location during onboarding (OB-44/OB-45).
// Sets subscription_status = 'active' so plan-mapping-resolver (DR-027) allows provisioning.
router.post('/clients/:clientId/locations/:locationId/activate', requireInviteToken, async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    // Activate by updating bs.status; create bs row if it doesn't exist yet.
    const bsUpdate = await db.query(
      `UPDATE billing_subscriptions
         SET status = 'active', subscribed_at = NOW(), updated_at = NOW()
       WHERE location_id = $1 AND client_id = $2 AND status = 'inactive'
       RETURNING location_id, status, subscribed_at`,
      [locationId, clientId]
    );
    if (!bsUpdate.rows.length) {
      // Check if location exists at all
      const locCheck = await db.query(
        `SELECT l.id, l.name, COALESCE(bs.status, 'inactive') AS subscription_status
           FROM locations l
           LEFT JOIN billing_subscriptions bs ON bs.location_id = l.id AND bs.client_id = l.client_id
          WHERE l.id = $1 AND l.client_id = $2`,
        [locationId, clientId]
      );
      if (!locCheck.rows.length) return res.status(404).json({ error: 'Location not found' });
      // Location exists but no inactive bs row to flip — either already active
      // or no bs row at all. If already active, signal that to caller; otherwise
      // create a fresh active bs row now.
      if (locCheck.rows[0].subscription_status === 'active') {
        return res.json({ ok: true, location: { id: locationId, subscription_status: 'active' }, already_active: true });
      }
      await db.query(
        `INSERT INTO billing_subscriptions (client_id, location_id, status, subscribed_at)
         VALUES ($1, $2, 'active', NOW())`,
        [clientId, locationId]
      );
      log.info('operator.setup.location_activated', { clientId, locationId, created_bs: true });
      return res.json({ ok: true, location: { id: locationId, name: locCheck.rows[0].name, subscription_status: 'active', subscribed_at: new Date().toISOString() } });
    }
    log.info('operator.setup.location_activated', { clientId, locationId });
    res.json({ ok: true, location: { id: locationId, subscription_status: 'active', subscribed_at: bsUpdate.rows[0].subscribed_at } });
  } catch (err) {
    log.error('operator.onboard.activate_failed', { clientId, locationId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/clients/:clientId/kisi-groups ─────────────────
// Returns all Kisi access groups for the client's org (OB-42).
// Used by onboarding Step 4 (after key validation) and plan-mapping screen.
router.get('/clients/:clientId/kisi-groups', async (req, res) => {
  const { clientId } = req.params;
  try {
    const clientResult = await db.query(
      `SELECT cs.hardware_api_key FROM connector_subscriptions cs
       WHERE cs.client_id = $1 AND cs.status = 'active' LIMIT 1`,
      [clientId]
    );
    if (!clientResult.rows.length || !clientResult.rows[0].hardware_api_key) {
      return res.status(400).json({ groups: [], count: 0, noKey: true, keyStatus: 'missing',
        error: 'No API key configured' });
    }

    const apiKey = decryptKey(clientResult.rows[0].hardware_api_key);
    const groups = await kisiAdapter.getGroups(apiKey);

    res.json({
      groups: groups.map(g => ({
        id:            g.id,
        name:          g.name,
        description:   g.description || null,
        locks_count:   g.locks_count  ?? 0,
        members_count: g.members_count ?? 0,
      })),
      count: groups.length,
      keyStatus: 'ok',
      noGroups: groups.length === 0,
    });
  } catch (err) {
    if (err.statusCode === 401) {
      return res.json({ groups: [], count: 0, keyStatus: 'invalid',
        error: 'API key rejected — update it in System Config' });
    }
    if (err.statusCode === 403) {
      return res.json({ groups: [], count: 0, keyStatus: 'insufficient_permissions',
        error: 'API key lacks group read permissions — check Kisi key settings' });
    }
    log.error('operator.kisi_groups.fetch_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/clients/:clientId/api-key/status ──────────────
// Returns whether an org-level API key is configured (OB-35/38).
router.get('/clients/:clientId/api-key/status', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query(
      `SELECT hardware_api_key FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
      [clientId]
    );
    res.json({ hasKey: !!(result.rows[0]?.hardware_api_key) });
  } catch (err) {
    log.error('operator.apikey.status_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/clients/:clientId/api-key/test ────────────────
// Validates the org-level API key against Kisi (OB-35/38).
router.get('/clients/:clientId/api-key/test', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query(
      `SELECT hardware_api_key FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
      [clientId]
    );
    if (!result.rows.length || !result.rows[0].hardware_api_key) {
      return res.status(400).json({ valid: false, error: 'No API key set' });
    }

    const apiKey = decryptKey(result.rows[0].hardware_api_key);
    await kisiConnector.makeRequest('/groups?limit=1', { method: 'GET' }, apiKey);
    res.json({ valid: true });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ valid: false, error: 'Invalid API key' });
    if (err.statusCode === 403) return res.json({ valid: false, error: 'Lacks required permissions' });
    log.error('operator.apikey.test_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
    const clientCheck = await db.query('SELECT id FROM clients WHERE id = $1', [clientId]);
    if (!clientCheck.rows.length) return res.status(404).json({ error: 'Client not found' });
    const existingCs = await db.query(
      `SELECT hardware_platform FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
      [clientId]
    );
    const hwPlatform = existingCs.rows[0]?.hardware_platform || 'kisi';
    const result = await db.query(
      `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status, updated_at)
       VALUES ($1, $2, $3, 'active', NOW())
       ON CONFLICT (client_id, hardware_platform) DO UPDATE
         SET hardware_api_key = EXCLUDED.hardware_api_key,
             updated_at = NOW()
       RETURNING client_id`,
      [clientId, hwPlatform, encrypted]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    log.info('operator.apikey.rotated', { clientId });
    recordActivity(req, 'api_key.rotated', { clientId });

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'API key updated', pendingRetried: retried });

    // GAP 7: validate new key can reach all active groups — writes config_alert_log on failure
    validateApiKeyGroups(clientId, apiKey.trim(), hwPlatform)
      .catch(err => log.warn('operator.apikey.validation_fire_forget_failed', { clientId }, err));
  } catch (err) {
    log.error('operator.apikey.update_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
    log.error('operator.notification.get_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
    log.info('operator.notification.updated', { clientId });
    res.json({ ok: true, message: 'Notification email updated' });
  } catch (err) {
    log.error('operator.notification.update_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
    log.error('operator.client.patch_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId ─────────────────────────────────────
// Client overview: name, platform status, all-location stats
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [clientResult, errorCount, activeMembers, totalMembers, locationCount, pendingHardware, connectorResult, billingTierResult] = await Promise.all([
      db.query(
        `SELECT id, name, source_site_url, source_site_name, platform,
                last_sync_at, last_webhook_at
         FROM clients WHERE id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM error_queue
         WHERE client_id = $1 AND status = 'failed'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(DISTINCT ma.member_master_id)::int AS count
         FROM member_access ma
         WHERE ma.client_id = $1 AND ma.status = 'active'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(DISTINCT id)::int AS count FROM member_master
         WHERE client_id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM locations WHERE client_id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_access
         WHERE client_id = $1 AND status = 'pending_hardware'`,
        [clientId]
      ),
      db.query(
        `SELECT hardware_platform, (hardware_api_key IS NOT NULL) AS has_key
         FROM connector_subscriptions
         WHERE client_id = $1 AND status = 'active'
         LIMIT 1`,
        [clientId]
      ),
      db.query(
        `SELECT (ARRAY_AGG(tier ORDER BY subscribed_at DESC NULLS LAST))[1] AS tier
         FROM billing_subscriptions
         WHERE client_id = $1 AND status = 'active'`,
        [clientId]
      ),
    ]);

    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const c = clientResult.rows[0];
    const connector = connectorResult.rows[0] || null;
    const billingTier = billingTierResult.rows[0]?.tier || null;

    res.json({
      client: {
        id:                c.id,
        name:              c.name,
        source_site_url:   c.source_site_url,
        source_site_name:  c.source_site_name,
        platform:          c.platform,
        last_sync_at:      c.last_sync_at,
        last_webhook_at:   c.last_webhook_at,
        billing: billingTier === null ? null : { tier: billingTier },
        connector: connector === null ? null : {
          platform: connector.hardware_platform,
          has_key:  connector.has_key,
        },
      },
      stats: {
        error_count:      errorCount.rows[0].count,
        active_members:   activeMembers.rows[0].count,
        total_members:    totalMembers.rows[0].count,
        location_count:   locationCount.rows[0].count,
        pending_hardware: pendingHardware.rows[0].count,
      },
    });
  } catch (err) {
    log.error('operator.client.get_failed', { clientId }, err);
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
    log.error('operator.location.notification_get_failed', { clientId, locationId }, err);
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
    log.error('operator.location.notification_put_failed', { clientId, locationId }, err);
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
    // Verify the location exists and resolve hardware_platform for the UNIQUE key.
    // Default to 'kisi' on first key set (no cs row exists yet — this UPSERT creates it).
    const locCheck = await db.query(
      `SELECT l.id, COALESCE(cs.hardware_platform, 'kisi') AS hardware_platform
         FROM locations l
         LEFT JOIN connector_subscriptions cs ON cs.client_id = l.client_id AND cs.status = 'active'
        WHERE l.id = $1 AND l.client_id = $2`,
      [locationId, clientId]
    );
    if (!locCheck.rows.length) return res.status(404).json({ error: 'Location not found' });
    const hwPlatform = locCheck.rows[0].hardware_platform;
    await db.query(
      `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status, updated_at)
       VALUES ($1, $2, $3, 'active', NOW())
       ON CONFLICT (client_id, hardware_platform) DO UPDATE
         SET hardware_api_key = EXCLUDED.hardware_api_key,
             updated_at = NOW()`,
      [clientId, hwPlatform, encrypted]
    );
    log.info('operator.location.apikey_set', { clientId, locationId });
    recordActivity(req, 'api_key.saved', { clientId, locationId });

    // Wix-first flow: auto-retry any members parked as pending_hardware
    const retried = await retryPendingHardwareMembers(clientId);

    res.json({ ok: true, message: 'Location API key saved', pendingRetried: retried });

    // GAP 6: validate new key can reach all active groups at this location
    validateApiKeyGroups(clientId, apiKey.trim(), hwPlatform)
      .catch(err => log.warn('operator.apikey.location_validation_failed', { clientId, locationId }, err));
  } catch (err) {
    log.error('operator.location.apikey_save_failed', { clientId, locationId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /operator/:clientId/locations/:locationId ─────────────
// Update location name, city, state, tier (operator-facing).
// GAP 1/2: hardware_platform intentionally excluded — changing it once members
// are provisioned would leave them in the wrong hardware system with no sync.
router.patch('/:clientId/locations/:locationId', async (req, res) => {
  const { clientId, locationId } = req.params;
  // tier lives on billing_subscriptions; name/city/state live on locations.
  // Split the update across the two tables so a single PATCH can touch both.
  const LOCATION_FIELDS = ['name', 'city', 'state'];
  const locationUpdates = {};
  for (const f of LOCATION_FIELDS) {
    if (req.body[f] !== undefined) locationUpdates[f] = req.body[f];
  }
  const tierUpdate = req.body.tier !== undefined ? req.body.tier : undefined;
  if (!Object.keys(locationUpdates).length && tierUpdate === undefined) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }
  try {
    let locationRow = null;
    if (Object.keys(locationUpdates).length) {
      const setClauses = Object.keys(locationUpdates).map((k, i) => `${k} = $${i + 3}`);
      const values = [locationId, clientId, ...Object.values(locationUpdates)];
      const result = await db.query(
        `UPDATE locations SET ${setClauses.join(', ')} WHERE id = $1 AND client_id = $2
         RETURNING id, name, city, state`,
        values
      );
      if (!result.rows.length) return res.status(404).json({ error: 'Location not found' });
      locationRow = result.rows[0];
    } else {
      const check = await db.query(
        'SELECT id, name, city, state FROM locations WHERE id = $1 AND client_id = $2',
        [locationId, clientId]
      );
      if (!check.rows.length) return res.status(404).json({ error: 'Location not found' });
      locationRow = check.rows[0];
    }
    // Tier — UPSERT into billing_subscriptions
    if (tierUpdate !== undefined) {
      await db.query(
        `INSERT INTO billing_subscriptions (client_id, location_id, tier, status)
         VALUES ($1, $2, $3, 'inactive')
         ON CONFLICT (client_id, location_id) DO UPDATE
           SET tier = EXCLUDED.tier, updated_at = NOW()`,
        [clientId, locationId, tierUpdate]
      );
    }
    // Re-read merged view for the response (nested shape)
    const enriched = await db.query(
      `SELECT l.id, l.name, l.city, l.state,
              cs.hardware_platform AS connector_platform,
              bs.tier              AS billing_tier,
              bs.status            AS billing_status
         FROM locations l
         LEFT JOIN connector_subscriptions cs ON cs.client_id = l.client_id AND cs.status = 'active'
         LEFT JOIN billing_subscriptions   bs ON bs.location_id = l.id AND bs.client_id = l.client_id
        WHERE l.id = $1 AND l.client_id = $2`,
      [locationId, clientId]
    );
    const e = enriched.rows[0];
    if (!e) {
      // Fall back to locationRow if the JOIN somehow returned nothing
      return res.json({ ok: true, location: { ...locationRow, billing: null, connector: null } });
    }
    res.json({
      ok: true,
      location: {
        id:    e.id,
        name:  e.name,
        city:  e.city,
        state: e.state,
        billing: e.billing_status === null && e.billing_tier === null ? null : {
          tier:   e.billing_tier,
          status: e.billing_status || 'inactive',
        },
        connector: e.connector_platform === null ? null : { platform: e.connector_platform },
      },
    });
  } catch (err) {
    log.error('operator.location.patch_failed', { clientId, locationId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/locations/:locationId/suspend ────────
// Operator-initiated location suspension — suspends all active members immediately.
router.post('/:clientId/locations/:locationId/suspend', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const result = await suspendLocationMembers(locationId, clientId, 'suspended');
    recordActivity(req, 'location.suspended', { clientId, locationId, suspended: result.suspended });
    res.json({ ok: true, suspended: result.suspended, skipped: result.skipped, errors: result.errors });
  } catch (err) {
    log.error('operator.location.suspend_failed', { clientId, locationId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/locations/:locationId/activate ───────
// Operator-initiated location reactivation. Re-provisions all previously
// active members via activateLocationMembers() — fire-and-forget after response.
router.post('/:clientId/locations/:locationId/activate', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const locCheck = await db.query(
      'SELECT id, name FROM locations WHERE id = $1 AND client_id = $2',
      [locationId, clientId]
    );
    if (!locCheck.rows.length) return res.status(404).json({ error: 'Location not found' });
    const bsUpdate = await db.query(
      `UPDATE billing_subscriptions SET status = 'active', subscribed_at = NOW(), updated_at = NOW()
       WHERE location_id = $1 AND client_id = $2`,
      [locationId, clientId]
    );
    if (bsUpdate.rowCount === 0) {
      await db.query(
        `INSERT INTO billing_subscriptions (client_id, location_id, status, subscribed_at)
         VALUES ($1, $2, 'active', NOW())`,
        [clientId, locationId]
      );
    }
    recordActivity(req, 'location.activated', { clientId, locationId });
    res.json({ ok: true, location: { id: locCheck.rows[0].id, name: locCheck.rows[0].name, subscription_status: 'active' } });
    // GAP 3: re-provision all previously active members at this location
    activateLocationMembers(clientId, locationId)
      .catch(err => log.warn('operator.location.reactivation_fire_forget_failed', { clientId, locationId }, err));
  } catch (err) {
    log.error('operator.location.activate_failed', { clientId, locationId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations/:locationId/api-key/test ──
// Validates stored location API key override against Kisi (DR-028).
// Falls back to client-level key if no location override set.
router.get('/:clientId/locations/:locationId/api-key/test', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    // Verify location exists, then get key from connector_subscriptions
    const [locCheck, csResult] = await Promise.all([
      db.query('SELECT id FROM locations WHERE id = $1 AND client_id = $2', [locationId, clientId]),
      db.query(
        `SELECT hardware_api_key FROM connector_subscriptions WHERE client_id = $1 AND status = 'active' LIMIT 1`,
        [clientId]
      ),
    ]);
    if (!locCheck.rows.length) return res.status(404).json({ error: 'Location not found' });

    const encryptedKey = csResult.rows[0]?.hardware_api_key;
    if (!encryptedKey) return res.status(400).json({ valid: false, error: 'No API key set', source: null });

    const source = 'connector';
    const apiKey = decryptKey(encryptedKey);
    await kisiConnector.makeRequest('/groups?limit=1', { method: 'GET' }, apiKey);

    res.json({ valid: true, source });
  } catch (err) {
    if (err.statusCode === 401) return res.json({ valid: false, error: 'Invalid API key — Kisi rejected it' });
    if (err.statusCode === 403) return res.json({ valid: false, error: 'Authenticated but lacks required permissions' });
    log.error('operator.location.apikey_test_failed', { clientId, locationId }, err);
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
        // DISTINCT ON (l.id) prevents row-multiplication when a location has multiple
        // billing_subscriptions rows (accumulated migrations or duplicate inserts).
        // Prefer 'active' billing subscription, then most recent.
        `SELECT DISTINCT ON (l.id)
                l.id, l.name, l.city, l.state,
                bs.status            AS billing_status,
                bs.tier              AS billing_tier,
                bs.subscribed_at     AS billing_subscribed_at,
                cs.hardware_platform AS connector_platform,
                (cs.hardware_api_key IS NOT NULL) AS connector_has_key,
                l.notification_email
         FROM locations l
         LEFT JOIN billing_subscriptions bs ON bs.location_id = l.id AND bs.client_id = l.client_id
         LEFT JOIN connector_subscriptions cs ON cs.client_id = l.client_id AND cs.status = 'active'
         WHERE l.client_id = $1
         ORDER BY l.id, (bs.status = 'active') DESC NULLS LAST, bs.subscribed_at DESC NULLS LAST`,
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
        id:                 loc.id,
        name:               loc.name,
        city:               loc.city,
        state:              loc.state,
        notification_email: loc.notification_email,
        billing: loc.billing_tier === null && loc.billing_status === null ? null : {
          tier:          loc.billing_tier,
          status:        loc.billing_status || 'inactive',
          subscribed_at: loc.billing_subscribed_at,
        },
        connector: loc.connector_platform === null ? null : {
          platform: loc.connector_platform,
          has_key:  loc.connector_has_key,
        },
        error_count: errMap[loc.id] || 0,
        door_count:  doorMap[loc.id] || 0,
        plan_count:  planMap[loc.id] || 0,
      })),
    });
  } catch (err) {
    log.error('operator.locations.list_failed', { clientId }, err);
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
                mm.platform_member_id
         FROM member_access_log mal
         JOIN member_access ma ON ma.id = mal.member_id
         JOIN member_master mm ON mm.id = ma.member_master_id
         WHERE mal.client_id = $1
           AND ma.id IN (
             SELECT mas2.access_id FROM member_access_sources mas2
             JOIN plan_mappings pm2 ON pm2.id = mas2.mapping_id
             WHERE pm2.location_id = $2
           )
         ORDER BY mal.created_at DESC LIMIT 10`,
        [clientId, locationId]
      ),
      db.query(
        // Active members at this location.
        // status='active' excludes removing/deleted/revoked/cancelled rows for sub-members.
        `SELECT ma.id, mm.platform_member_id, ma.status, ma.provisioned_at, ma.updated_at,
                mm.first_name, mm.last_name, mm.email,
                COALESCE(mm.display_name,
                  NULLIF(TRIM(COALESCE(mm.first_name,'') || ' ' || COALESCE(mm.last_name,'')), ''),
                  mm.email) AS member_name,
                STRING_AGG(DISTINCT pm.plan_name, ', ' ORDER BY pm.plan_name) AS plan_names
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         LEFT JOIN member_access_sources mas ON mas.access_id = ma.id
         LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
         WHERE ma.client_id = $1
           AND ma.status = 'active'
           AND pm.location_id = $2
         GROUP BY ma.id, mm.platform_member_id, ma.status, ma.provisioned_at, ma.updated_at,
                  mm.first_name, mm.last_name, mm.email, mm.display_name
         ORDER BY ma.updated_at DESC NULLS LAST`,
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
    log.error('operator.location.detail_failed', { clientId, locationId }, err);
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
        `SELECT c.id, c.name,
                cs.hardware_platform AS connector_platform,
                (ARRAY_AGG(DISTINCT bs.tier) FILTER (WHERE bs.tier IS NOT NULL))[1] AS billing_tier
         FROM clients c
         LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
         LEFT JOIN billing_subscriptions   bs ON bs.client_id = c.id AND bs.status = 'active'
         WHERE c.id = $1
         GROUP BY c.id, cs.hardware_platform`,
        [clientId]
      ),
      db.query(
        // Per-plan member count via member_access_sources.mapping_id (the source rows
        // always carry the mapping). Filter to active access rows only.
        `SELECT pm.id, pm.source_plan_id, pm.plan_name, pm.door_name, pm.hardware_group_id,
                pm.status, pm.source_status, pm.allow_multiple, pm.max_members, pm.created_at,
                COUNT(DISTINCT ma.member_master_id)::int AS member_count
         FROM plan_mappings pm
         LEFT JOIN member_access_sources mas ON mas.mapping_id = pm.id
         LEFT JOIN member_access ma ON ma.id = mas.access_id
                                   AND ma.client_id = pm.client_id
                                   AND ma.status = 'active'
         WHERE pm.client_id = $2 AND (pm.location_id = $1 OR pm.location_id IS NULL)
         GROUP BY pm.id
         ORDER BY pm.plan_name`,
        [locationId, clientId]
      ),
    ]);
    if (!locationResult.rows.length) return res.status(404).json({ error: 'Location not found' });
    const c = clientResult.rows[0] || null;
    res.json({
      location: locationResult.rows[0],
      client: c === null ? null : {
        id:   c.id,
        name: c.name,
        billing:   c.billing_tier === null ? null : { tier: c.billing_tier },
        connector: c.connector_platform === null ? null : { platform: c.connector_platform },
      },
      mappings: mappingsResult.rows,
    });
  } catch (err) {
    log.error('operator.location.mappings_failed', { clientId, locationId }, err);
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
    log.error('operator.sync.trigger_failed', { clientId }, err);
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
    log.error('operator.error.dismiss_failed', { clientId, errorId }, err);
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
    recordActivity(req, 'error.retried', { clientId, errorId });
    res.json({ queued: true });
  } catch (err) {
    log.error('operator.error.retry_failed', { clientId, errorId }, err);
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
      // Reset health_status to 'ok' if re-adding a previously-dead group
      await db.query(
        `UPDATE plan_mapping_groups SET health_status = 'ok' WHERE mapping_id = $1 AND hardware_group_id = $2`,
        [mappingId, addGroupId]
      );
      const newGroupIds = [...new Set([...oldGroupIds, addGroupId])];
      // Flip status to 'active' — auto-inserted placeholder mappings start as 'inactive'
      await db.query(`UPDATE plan_mappings SET status = 'active' WHERE id = $1`, [mappingId]);
      // M-4: Check API key and warn if missing
      const locationId = (await db.query('SELECT location_id FROM plan_mappings WHERE id = $1', [mappingId])).rows[0]?.location_id;
      const apiKey = await resolveApiKey(clientId, locationId);
      syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, oldStatus, oldStatus)
        .catch(err => log.warn('operator.sync.add_group_failed', { clientId, mappingId }, err));
      return res.json({
        ok: true,
        warning: apiKey ? null : "Your hardware API key isn't set up yet. New members won't get access until the key is added — you can do this in System Config.",
      });
    }

    if (removeGroupId) {
      // Clean up source rows for the removed group before deleting junction row
      await db.query(
        'DELETE FROM member_access_sources WHERE hardware_group_id = $1 AND mapping_id = $2',
        [removeGroupId, mappingId]
      );
      await db.query(
        `DELETE FROM plan_mapping_groups WHERE mapping_id = $1 AND hardware_group_id = $2`,
        [mappingId, removeGroupId]
      );
      const newGroupIds = oldGroupIds.filter(id => id !== removeGroupId);
      syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, oldStatus, oldStatus)
        .catch(err => log.warn('operator.sync.remove_group_failed', { clientId, mappingId }, err));
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
      await db.query('DELETE FROM plan_mapping_groups WHERE mapping_id = $1', [mappingId]);
      const validGroups = groups.filter(g => g.hardware_group_id);
      if (validGroups.length > 0) {
        const values = [];
        const placeholders = validGroups.map((g, i) => {
          values.push(mappingId, g.hardware_group_id, g.door_name || null);
          return `($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`;
        });
        await db.query(
          `INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id, door_name)
           VALUES ${placeholders.join(', ')} ON CONFLICT DO NOTHING`,
          values
        );
      }
      // Auto-sync status: groups present → active, groups empty → inactive
      const autoStatus = validGroups.length > 0 ? 'active' : 'inactive';
      if (mapping.status !== autoStatus) {
        await db.query(
          `UPDATE plan_mappings SET status = $1 WHERE id = $2`,
          [autoStatus, mappingId]
        );
        mapping = { ...mapping, status: autoStatus };
      }
    }

    recordActivity(req, 'plan_mapping.updated', { clientId, mappingId });
    res.json(mapping);

    // Compute new group IDs from junction table after write
    const newGroupIds = (groups && Array.isArray(groups))
      ? groups.map(g => g.hardware_group_id).filter(Boolean)
      : oldGroupIds; // no group change — pass same set so diff is empty

    const newStatus = status !== undefined ? status : oldStatus;

    // Sync active members to reflect group/status changes — fire-and-forget
    syncMappingMembers(clientId, mappingId, oldGroupIds, newGroupIds, newStatus, oldStatus)
      .catch(err => log.warn('operator.sync.mapping_sync_failed', { clientId, mappingId }, err));

    // Re-queue any members parked in pending_hardware for this plan mapping.
    // Scoped by source_plan_id so only members waiting on THIS plan are retried.
    retryPendingHardwareMembers(clientId, mapping.source_plan_id).catch(err =>
      log.warn('operator.retry.pending_hardware_failed', { clientId, mappingId }, err)
    );
  } catch (err) {
    log.error('operator.mapping.patch_failed', { clientId, mappingId }, err);
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
      'SELECT id, hardware_group_id, door_name, health_status, created_at FROM plan_mapping_groups WHERE mapping_id = $1 ORDER BY created_at',
      [mappingId]
    );
    res.json({ groups: result.rows });
  } catch (err) {
    log.error('operator.mapping.groups_failed', { clientId, mappingId }, err);
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
      `SELECT COUNT(DISTINCT ma.member_master_id) AS count
       FROM member_access ma
       WHERE ma.plan_mapping_id = $1 AND ma.client_id = $2`,
      [mappingId, clientId]
    );
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    log.error('operator.mapping.members_failed', { clientId, mappingId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/plan-mappings/:mappingId/holders ────────
// Returns active members on this plan-mapping for the Classic View panel.
// Counts every member with a role assignment for this mapping — holder OR sub-member —
// since the buyer (holder) only occupies a slot if they explicitly claimed one.
// Buyers who didn't claim a slot do not appear here (correct: they have no hardware access).
router.get('/:clientId/plan-mappings/:mappingId/holders', async (req, res) => {
  try {
    const { clientId, mappingId } = req.params;
    const check = await db.query('SELECT id FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Mapping not found' });

    const result = await db.query(
      `SELECT ma.id,
              mm.platform_member_id,
              mm.first_name,
              mm.last_name,
              ma.sub_master_id AS plan_holder_id,
              ma.status,
              CASE WHEN ma.sub_master_id IS NULL THEN 'holder' ELSE 'sub' END AS role
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.plan_mapping_id = $1
         AND ma.client_id = $2
       ORDER BY ma.sub_master_id NULLS FIRST, mm.platform_member_id`,
      [mappingId, clientId]
    );
    res.json({
      holders: result.rows.map(function(r) {
        return {
          id:               r.id,
          platformMemberId: r.platform_member_id,
          firstName:        r.first_name,
          lastName:         r.last_name,
          role:             r.role,
          planHolderId:     r.plan_holder_id,
          status:           r.status || 'active',
        };
      }),
    });
  } catch (err) {
    log.error('operator.mapping.holders_failed', { clientId, mappingId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/plan-mappings/:mappingId/groups/:groupId/affected-members ──
// Returns count of members assigned to a specific group within a mapping.
// Used by wire graph and classic UI for disconnect confirmation dialogs.
router.get('/:clientId/plan-mappings/:mappingId/groups/:groupId/affected-members', async (req, res) => {
  try {
    const { clientId, mappingId, groupId } = req.params;
    const check = await db.query('SELECT id FROM plan_mappings WHERE id = $1 AND client_id = $2', [mappingId, clientId]);
    if (!check.rows.length) return res.status(404).json({ error: 'Mapping not found' });

    const result = await db.query(
      `SELECT COUNT(DISTINCT mas.access_id) AS count
       FROM member_access_sources mas
       WHERE mas.mapping_id = $1 AND mas.hardware_group_id = $2`,
      [mappingId, groupId]
    );
    res.json({ count: parseInt(result.rows[0].count, 10) });
  } catch (err) {
    log.error('operator.mapping.affected_members_failed', { clientId, mappingId, groupId }, err);
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
      `SELECT cs.hardware_api_key AS raw_key, cs.hardware_platform AS platform
       FROM connector_subscriptions cs
       WHERE cs.client_id = $1 AND cs.status = 'active'
       LIMIT 1`,
      [clientId]
    );
    if (!keyRow.rows.length || !keyRow.rows[0].raw_key) {
      return res.status(400).json({ error: 'No hardware API key configured' });
    }
    const apiKey = decryptKey(keyRow.rows[0].raw_key);
    const platform = keyRow.rows[0].platform || 'kisi';

    // Fetch all member source rows for this mapping in the old groups
    const membersResult = await db.query(
      `SELECT mas.id AS mra_id, mas.access_id AS member_id, mas.role_assignment_id, mas.hardware_group_id,
              ma.hardware_user_id
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE mas.mapping_id = $1 AND mas.hardware_group_id = ANY($2::text[]) AND ma.client_id = $3`,
      [mappingId, oldGroupIds, clientId]
    );

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

        // DB: remove old source rows, insert new source rows
        const oldMraIds = rows.map(r => r.mra_id);
        await db.query('DELETE FROM member_access_sources WHERE id = ANY($1::uuid[])', [oldMraIds]);

        if (newAssignments.length > 0) {
          const values = [];
          const placeholders = newAssignments.map((a, i) => {
            values.push(memberId, mappingId, a.roleAssignmentId, a.groupId);
            return `($${i * 4 + 1}, $${i * 4 + 2}, $${i * 4 + 3}, $${i * 4 + 4})`;
          });
          await db.query(
            `INSERT INTO member_access_sources (access_id, mapping_id, role_assignment_id, hardware_group_id)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT DO NOTHING`,
            values
          );
        }

        moved++;
      } catch (err) {
        failed.push({ memberId, error: err.message });
      }
    }

    res.json({ moved, failed });
  } catch (err) {
    log.error('operator.mapping.remap_failed', { clientId, mappingId }, err);
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
    const conditions = ['ma.client_id = $1'];

    // DR-044: exclude soft-deleted and in-flight-removing sub-members from operator listing.
    // 'deleted' and 'removing' are sub-member-specific lifecycle states on member_access.status.
    conditions.push(`ma.status NOT IN ('deleted', 'removing')`);

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`ma.status = $${params.length}`);
    }

    if (location_id) {
      params.push(location_id);
      conditions.push(
        `EXISTS (
           SELECT 1 FROM member_access_sources mas2
           JOIN plan_mappings pm ON pm.id = mas2.mapping_id AND pm.location_id = $${params.length}
           WHERE mas2.access_id = ma.id
         )`
      );
    }

    params.push(parseInt(limit));
    params.push(offset);

    const [rows, countRow] = await Promise.all([
      db.query(
        `SELECT ma.id,
                mm.platform_member_id,
                ma.hardware_platform,
                mm.display_name,
                mm.first_name,
                mm.last_name,
                mm.email,
                ma.status           AS access_status,
                ma.provisioned_at,
                -- Plan(s) this member is in, aggregated.
                COALESCE(
                  (
                    SELECT ARRAY_AGG(DISTINCT pm.plan_name ORDER BY pm.plan_name)
                    FROM member_access_sources mas
                    JOIN plan_mappings pm ON pm.id = mas.mapping_id
                    WHERE mas.access_id = ma.id AND pm.plan_name IS NOT NULL
                  ),
                  -- Holder-only: pull plan names from sub-members
                  (
                    SELECT ARRAY_AGG(DISTINCT pm.plan_name ORDER BY pm.plan_name)
                    FROM member_access sub_ma
                    JOIN member_access_sources sub_mas ON sub_mas.access_id = sub_ma.id
                    JOIN plan_mappings pm ON pm.id = sub_mas.mapping_id
                    WHERE sub_ma.sub_master_id = ma.member_master_id AND pm.plan_name IS NOT NULL
                  )
                )                                AS plan_names,
                COALESCE(
                  (
                    SELECT ARRAY_AGG(DISTINCT pm.source_plan_id ORDER BY pm.source_plan_id)
                    FROM member_access_sources mas
                    JOIN plan_mappings pm ON pm.id = mas.mapping_id
                    WHERE mas.access_id = ma.id AND pm.source_plan_id IS NOT NULL
                  ),
                  (
                    SELECT ARRAY_AGG(DISTINCT pm.source_plan_id ORDER BY pm.source_plan_id)
                    FROM member_access sub_ma
                    JOIN member_access_sources sub_mas ON sub_mas.access_id = sub_ma.id
                    JOIN plan_mappings pm ON pm.id = sub_mas.mapping_id
                    WHERE sub_ma.sub_master_id = ma.member_master_id AND pm.source_plan_id IS NOT NULL
                  )
                )                                AS plan_ids,
                (
                  SELECT ARRAY_AGG(mas.valid_until ORDER BY pm.plan_name)
                  FROM member_access_sources mas
                  JOIN plan_mappings pm ON pm.id = mas.mapping_id
                  WHERE mas.access_id = ma.id AND pm.plan_name IS NOT NULL
                )                                AS plan_valid_untils,
                COALESCE(
                  (
                    SELECT pm.plan_name
                    FROM member_access_sources mas
                    JOIN plan_mappings pm ON pm.id = mas.mapping_id
                    WHERE mas.access_id = ma.id AND pm.plan_name IS NOT NULL
                    ORDER BY mas.created_at ASC
                    LIMIT 1
                  ),
                  (
                    SELECT pm.plan_name
                    FROM member_access sub_ma
                    JOIN member_access_sources sub_mas ON sub_mas.access_id = sub_ma.id
                    JOIN plan_mappings pm ON pm.id = sub_mas.mapping_id
                    WHERE sub_ma.sub_master_id = ma.member_master_id AND pm.plan_name IS NOT NULL
                    ORDER BY sub_mas.created_at ASC
                    LIMIT 1
                  )
                )                                AS plan_name,
                -- DR-042: billing snapshot on member_access directly.
                ma.billing_snapshot,
                -- Count of active source rows (hardware group assignments).
                (
                  SELECT COUNT(*)::int
                  FROM member_access_sources mas
                  WHERE mas.access_id = ma.id
                )                                AS assignment_count,
                lat.webhook_received_at,
                lat.enqueued_at,
                lat.kisi_confirmed_at,
                lat.ingest_s,
                lat.processing_s,
                lat.total_s,
                ma.sub_master_id    AS plan_holder_id,
                ma.plan_mapping_id,
                (
                  SELECT pm.plan_name
                  FROM plan_mappings pm
                  WHERE pm.id = ma.plan_mapping_id
                )                                AS sub_plan_name,
                CASE WHEN ma.sub_master_id IS NULL THEN 'holder' ELSE 'sub' END AS role,
                holder_mm.id          AS holder_id,
                holder_mm.display_name AS holder_name,
                holder_mm.email        AS holder_email
         FROM   member_access ma
         JOIN   member_master mm ON mm.id = ma.member_master_id
         LEFT JOIN member_master holder_mm ON holder_mm.id = ma.sub_master_id
         LEFT JOIN LATERAL (
           SELECT
             wl.received_at                                                        AS webhook_received_at,
             pei.processed_at                                                      AS enqueued_at,
             mas_lat.created_at                                                    AS kisi_confirmed_at,
             ROUND(EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)))::int   AS ingest_s,
             ROUND(EXTRACT(EPOCH FROM (mas_lat.created_at - pei.processed_at)))::int AS processing_s,
             ROUND(EXTRACT(EPOCH FROM (mas_lat.created_at - wl.received_at)))::int   AS total_s
           FROM webhook_log wl
           JOIN processed_event_ids pei ON pei.event_id = wl.event_id
           JOIN member_access_sources mas_lat ON mas_lat.access_id = ma.id
           WHERE wl.client_id = ma.client_id
             AND wl.normalized_payload->>'platformMemberId' = mm.platform_member_id
             AND wl.hmac_status = 'accepted'
             AND wl.dedup_status = 'new'
             AND mas_lat.created_at > wl.received_at
           ORDER BY wl.received_at DESC
           LIMIT 1
         ) lat ON TRUE
         WHERE  ${conditions.join(' AND ')}
         ORDER  BY ma.provisioned_at DESC NULLS LAST
         LIMIT  $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total
         FROM   member_access ma
         JOIN   member_master mm ON mm.id = ma.member_master_id
         WHERE  ${conditions.join(' AND ')}`,
        params.slice(0, params.length - 2)
      ),
    ]);

    // Derive effective_status: if mas.status is 'failed' but the member has at least one
    // successful role assignment, they have partial access — don't show blanket failure.
    const members = rows.rows.map(m => {
      let effectiveStatus = m.access_status;
      if (m.access_status === 'failed' && m.assignment_count > 0) {
        effectiveStatus = 'partial';
      }
      // Plan holder with active status but no role assignments: they're the billing identity
      // with no door access of their own. Show as 'holder_only' so the UI doesn't imply
      // they have a door assigned.
      if (m.role === 'holder' && m.access_status === 'active' && m.assignment_count === 0) {
        effectiveStatus = 'holder_only';
      }
      return { ...m, effective_status: effectiveStatus };
    });

    res.json({
      members,
      total:   countRow.rows[0].total,
      page:    parseInt(page),
      limit:   parseInt(limit),
    });
  } catch (err) {
    log.error('operator.members.list_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/members/:memberId/diagnose ──────────
// Client-scoped diagnostic — same checks as admin diagnose, but scope-checked to clientId.
router.get('/:clientId/members/:memberId/diagnose', async (req, res) => {
  const { clientId, memberId } = req.params;
  try {
    const scope = await db.query(
      'SELECT id FROM member_master WHERE id = $1 AND client_id = $2',
      [memberId, clientId]
    );
    if (!scope.rows.length) return res.status(404).json({ error: 'Member not found' });
    const result = await diagnoseMember(memberId);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Member not found' });
    log.error('operator.members.diagnose_failed', { clientId, memberId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/members/:memberId/timeline ──────────
// Client-scoped lifecycle timeline — same UNION query as admin timeline.
router.get('/:clientId/members/:memberId/timeline', async (req, res) => {
  const { clientId, memberId } = req.params;
  try {
    const scope = await db.query(
      'SELECT id FROM member_master WHERE id = $1 AND client_id = $2',
      [memberId, clientId]
    );
    if (!scope.rows.length) return res.status(404).json({ error: 'Member not found' });
    const result = await getTimeline(memberId);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Member not found' });
    log.error('operator.members.timeline_failed', { clientId, memberId }, err);
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
      `SELECT mm.platform_member_id, ma.status, ma.updated_at
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.client_id = $1
       ORDER BY ma.updated_at DESC
       LIMIT $2`,
      [clientId, limit]
    );
    res.json({ members: result.rows });
  } catch (err) {
    log.error('operator.members.recent_failed', { clientId }, err);
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
    log.error('operator.alerts.list_failed', { clientId }, err);
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
      `SELECT eq.id, eq.event_type, eq.error_reason AS plain_message,
              eq.plan_name, eq.door_name, eq.location_id,
              eq.retry_count, eq.status, eq.created_at,
              eq.error_code, eq.user_message, eq.action_text, eq.resolution,
              eq.occurred_count, eq.last_occurred_at,
              eq.http_status, eq.raw_api_body, eq.payload,
              eq.member_id, eq.trace_id,
              mm.first_name, mm.last_name, mm.email AS member_email,
              mm.platform_member_id
       FROM error_queue eq
       LEFT JOIN member_access ma ON ma.id = eq.member_id
       LEFT JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE eq.client_id = $1 AND eq.status = 'failed'
       ORDER BY eq.last_occurred_at DESC NULLS LAST, eq.created_at DESC
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
    log.error('operator.errors.list_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/errors/summary ──────────────────────────────────
// Total active error count + breakdown by error_code + breakdown by location.
// Used by the /errors page header and filter dropdowns.
// NOTE: placed before /:clientId/errors/:id routes to avoid param collision.
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
    log.error('operator.errors.summary_failed', { clientId }, err);
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
        `EXISTS (SELECT 1 FROM member_access_sources mas2
                 JOIN plan_mappings pm ON pm.id = mas2.mapping_id AND pm.location_id = $${params.length}
                 WHERE mas2.access_id = mal.member_id)`
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
                mal.created_at, mm.platform_member_id,
                COALESCE(mm.display_name,
                  NULLIF(TRIM(COALESCE(mm.first_name,'') || ' ' || COALESCE(mm.last_name,'')), ''),
                  mm.email) AS member_name,
                (SELECT pm.plan_name
                   FROM member_access_sources mas
                   JOIN plan_mappings pm ON pm.id = mas.mapping_id
                  WHERE mas.access_id = mal.member_id
                  ORDER BY mas.created_at ASC LIMIT 1) AS plan_name,
                (SELECT l.name
                   FROM member_access_sources mas
                   JOIN plan_mappings pm ON pm.id = mas.mapping_id
                   JOIN locations l ON l.id = pm.location_id
                  WHERE mas.access_id = mal.member_id
                  ORDER BY mas.created_at ASC LIMIT 1) AS location_name,
                (SELECT mas.hardware_group_id
                   FROM member_access_sources mas
                  WHERE mas.access_id = mal.member_id
                  ORDER BY mas.created_at ASC LIMIT 1) AS hardware_group_id
         FROM member_access_log mal
         JOIN member_access ma ON ma.id = mal.member_id
         JOIN member_master mm ON mm.id = ma.member_master_id
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
    log.error('operator.access_log.list_failed', { clientId }, err);
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
      locationFilter = `AND EXISTS (SELECT 1 FROM member_access_sources mas2
                         JOIN plan_mappings pm ON pm.id = mas2.mapping_id AND pm.location_id = $${params.length}
                         WHERE mas2.access_id = mal.member_id)`;
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
    log.error('operator.access_stats.failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══ Provisioning Latency endpoint ══════════════════════════════════
// GET /operator/:clientId/latency-stats
// Computes purchase→provisioned timing from existing tables — no new columns needed.
// T0 = webhook_log.received_at          (purchase webhook received)
// T1 = processed_event_ids.processed_at (job enqueued)
// T2 = member_access_sources.created_at (Kisi role recorded)
// Intervals: ingest (T1-T0), processing (T2-T1), total (T2-T0)
router.get('/:clientId/latency-stats', async (req, res) => {
  const { clientId } = req.params;
  try {
    // Aggregate stats over last 30 days
    const agg = await db.query(
      `WITH timing AS (
         SELECT
           wl.received_at                                          AS t0,
           pei.processed_at                                        AS t1,
           mas.created_at                                          AS t2,
           EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)) AS ingest_s,
           EXTRACT(EPOCH FROM (mas.created_at   - pei.processed_at)) AS processing_s,
           EXTRACT(EPOCH FROM (mas.created_at   - wl.received_at))  AS total_s
         FROM webhook_log wl
         JOIN processed_event_ids pei ON pei.event_id = wl.event_id
         JOIN member_master mm
           ON mm.client_id = wl.client_id
           AND mm.platform_member_id = wl.normalized_payload->>'platformMemberId'
         JOIN member_access ma ON ma.member_master_id = mm.id
         JOIN member_access_sources mas ON mas.access_id = ma.id
         WHERE wl.client_id = $1
           AND wl.received_at > NOW() - INTERVAL '30 days'
           AND wl.hmac_status = 'accepted'
           AND wl.dedup_status = 'new'
           AND mas.created_at > wl.received_at
       )
       SELECT
         COUNT(*)::int                                                     AS sample_count,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY total_s))::int AS total_median_s,
         ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY total_s))::int AS total_p95_s,
         ROUND(MAX(total_s))::int                                          AS total_max_s,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ingest_s))::int AS ingest_median_s,
         ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY processing_s))::int AS processing_median_s
       FROM timing`,
      [clientId]
    );

    // Per-member rows for recent 50 events
    const recent = await db.query(
      `SELECT
         mm.id                                                              AS member_id,
         mm.platform_member_id,
         wl.received_at                                                     AS webhook_received_at,
         pei.processed_at                                                   AS enqueued_at,
         mas.created_at                                                     AS kisi_confirmed_at,
         ROUND(EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)))::int  AS ingest_s,
         ROUND(EXTRACT(EPOCH FROM (mas.created_at   - pei.processed_at)))::int AS processing_s,
         ROUND(EXTRACT(EPOCH FROM (mas.created_at   - wl.received_at)))::int   AS total_s
       FROM webhook_log wl
       JOIN processed_event_ids pei ON pei.event_id = wl.event_id
       JOIN member_master mm
         ON mm.client_id = wl.client_id
         AND mm.platform_member_id = wl.normalized_payload->>'platformMemberId'
       JOIN member_access ma ON ma.member_master_id = mm.id
       JOIN member_access_sources mas ON mas.access_id = ma.id
       WHERE wl.client_id = $1
         AND wl.received_at > NOW() - INTERVAL '30 days'
         AND wl.hmac_status = 'accepted'
         AND wl.dedup_status = 'new'
         AND mas.created_at > wl.received_at
       ORDER BY wl.received_at DESC
       LIMIT 50`,
      [clientId]
    );

    const stats = agg.rows[0] || {};
    res.json({
      sample_count:       stats.sample_count       || 0,
      total_median_s:     stats.total_median_s     || null,
      total_p95_s:        stats.total_p95_s        || null,
      total_max_s:        stats.total_max_s        || null,
      ingest_median_s:    stats.ingest_median_s    || null,
      processing_median_s: stats.processing_median_s || null,
      recent: recent.rows,
    });
  } catch (err) {
    log.error('operator.latency_stats.failed', { clientId }, err);
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
    const client = await db.query('SELECT id, source_api_key, source_site_id FROM clients WHERE id = $1', [clientId]);
    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!client.rows[0].source_api_key) {
      return res.status(400).json({ error: 'No source API key set for this client', plans: [] });
    }
    if (!client.rows[0].source_site_id) {
      return res.status(400).json({ error: 'No source site ID set for this client', plans: [] });
    }

    const apiKey = decryptKey(client.rows[0].source_api_key);
    log.debug('operator.wix_plans.fetch_start', { clientId, siteId: client.rows[0].source_site_id });
    const allPlans = await wixPlansApi.listAllMappable(apiKey, client.rows[0].source_site_id);
    log.debug('operator.wix_plans.fetch_complete', { clientId, planCount: allPlans.length });

    // Auto-accept: create plan_mappings rows for plans not yet in DB
    if (allPlans.length > 0) {
      const [existing, locationRows] = await Promise.all([
        db.query('SELECT source_plan_id FROM plan_mappings WHERE client_id = $1', [clientId]),
        db.query(
          `SELECT l.id FROM locations l
           JOIN billing_subscriptions bs ON bs.location_id = l.id AND bs.status = 'active'
           WHERE l.client_id = $1`,
          [clientId]
        ),
      ]);
      const existingIds = new Set(existing.rows.map(r => r.source_plan_id));
      // If the client has exactly one active location, auto-assign it so plan-mapping-resolver
      // can resolve the per-location hardware API key and subscription status (DR-027/DR-028).
      const defaultLocationId = locationRows.rows.length === 1 ? locationRows.rows[0].id : null;

      const newPlans = allPlans.filter(p => !existingIds.has(p.id));
      if (newPlans.length > 0) {
        const values = newPlans.flatMap(p => [clientId, p.id, p.name, defaultLocationId]);
        const placeholders = newPlans.map((_, i) =>
          `($${i * 4 + 1}, $${i * 4 + 2}, '', $${i * 4 + 3}, 'inactive', $${i * 4 + 4}, NOW())`
        ).join(', ');
        await db.query(
          `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, status, location_id, created_at)
           VALUES ${placeholders} ON CONFLICT DO NOTHING`,
          values
        ).catch(e => log.warn('operator.wix_plans.auto_insert_failed', { clientId, count: newPlans.length }, e));
      }
    }

    res.json({ plans: allPlans });
  } catch (err) {
    log.error('operator.wix_plans.fetch_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Source API key management ───────────────────────────────────

// GET /operator/clients/:clientId/wix-api-key/status
router.get('/clients/:clientId/wix-api-key/status', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await db.query('SELECT source_api_key FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ hasKey: !!result.rows[0].source_api_key });
  } catch (err) {
    log.error('operator.wix_apikey.status_failed', { clientId: req.params.clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
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
      'UPDATE clients SET source_api_key = $1, updated_at = NOW() WHERE id = $2 RETURNING id, name',
      [encrypted, clientId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ ok: true, message: 'Source API key saved' });
  } catch (err) {
    log.error('operator.wix_apikey.save_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /operator/clients/:clientId/wix-api-key/test
router.get('/clients/:clientId/wix-api-key/test', async (req, res) => {
  try {
    const { clientId } = req.params;
    const result = await db.query('SELECT source_api_key, source_site_id FROM clients WHERE id = $1', [clientId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    if (!result.rows[0].source_api_key) return res.json({ valid: false, error: 'No source API key set' });
    if (!result.rows[0].source_site_id) return res.json({ valid: false, error: 'No source site ID set for this client' });

    const apiKey = decryptKey(result.rows[0].source_api_key);
    const testResult = await wixPlansApi.testApiKey(apiKey, result.rows[0].source_site_id);
    res.json(testResult);
  } catch (err) {
    log.error('operator.wix_apikey.test_failed', { clientId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/members/:memberId/unlock ──────────────
// Clears a stuck in_flight lock. Sets status back to 'pending' so the
// next webhook retry can proceed. Scoped to clientId for safety.
router.post('/:clientId/members/:memberId/unlock', async (req, res) => {
  const { clientId, memberId } = req.params;
  try {
    const scope = await db.query(
      `SELECT ma.status FROM member_access ma
       WHERE ma.id = $1 AND ma.client_id = $2`,
      [memberId, clientId]
    );
    if (!scope.rows.length) return res.status(404).json({ error: 'Member not found' });
    if (scope.rows[0].status !== 'in_flight') {
      return res.status(400).json({ error: `Member is not in_flight (current status: ${scope.rows[0].status})` });
    }
    await db.query(
      `UPDATE member_access SET status = 'pending', updated_at = NOW() WHERE id = $1`,
      [memberId]
    );
    log.info('operator.member.unlock', { clientId, memberId, previousStatus: 'in_flight' });
    res.json({ ok: true, status: 'pending' });
  } catch (err) {
    log.error('operator.member.unlock_failed', { clientId, memberId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /:clientId/members/:memberId/sync ─────────────────────────
// Manual per-member reconciliation. Triggered from the member drawer
// "Reconcile Member" button. Runs the full Wix ↔ DB ↔ hardware diff
// for one member and surfaces integrity issues that need operator action.
//
// Closes OB-49 at the per-member level (global level remains open).
//
// Returns:
//   { ok: true, action, granted, revoked, repaired, alerts: [...] }
//
// Possible actions: ok | repaired | access_restored | access_removed |
//                   needs_attention | wix_unavailable | no_identity |
//                   sub_member_skipped
router.post('/:clientId/members/:memberId/sync', async (req, res) => {
  const { clientId, memberId } = req.params;
  if (!clientId || !memberId) return res.status(400).json({ error: 'clientId and memberId required' });
  try {
    const reconciliation = require('../../core/reconciliation');
    const result = await reconciliation.reconcileMember(memberId, clientId);
    log.info('operator.member_sync.run', {
      clientId, memberId, action: result.action,
      granted: result.granted, revoked: result.revoked, repaired: result.repaired,
      alerts: result.alerts.length,
    });
    recordActivity(req, 'member.synced', { clientId, memberId, action: result.action });
    res.json({ ok: true, ...result });
  } catch (err) {
    log.error('operator.member_sync.failed', { clientId, memberId }, err);
    res.status(500).json({ error: 'Reconcile failed' });
  }
});

// ── POST /sync/run ─────────────────────────────────────────────────
// Manual sync trigger from the dashboard Sync button.
// Runs _syncClient() for the logged-in client only — bypasses the
// recurrence gate and nightly digest. Returns { granted, revoked }.
router.post('/sync/run', requireAuthOrOperator, async (req, res) => {
  const clientId = req.admin?.clientId || req.body?.clientId || req.query?.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  try {
    const clientResult = await db.query(
      `SELECT c.id, c.source_site_id, c.source_api_key, c.last_active_member_count,
              cs.hardware_api_key, cs.hardware_platform
       FROM clients c
       LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       WHERE c.id = $1 AND c.status = 'active'`,
      [clientId]
    );
    if (!clientResult.rows.length) return res.status(404).json({ error: 'Client not found' });

    const reconciliation = require('../../core/reconciliation');
    const operatorActor = req.admin?.email || req.admin?.userId || 'operator';
    const traceId = mintTraceId();
    reconciliation._sweepTraceId = traceId;
    const { granted, revoked, skippedHolderOptin, runId, aborted, reason, sanityGateTriggered } = await runWith(
      { traceId, actor: { type: 'operator', id: String(operatorActor) } },
      () => reconciliation._syncClient(
        clientResult.rows[0],
        { triggeredBy: 'manual', triggeredByActor: { type: 'operator', id: String(operatorActor) } }
      )
    );
    reconciliation._sweepTraceId = null;

    // Don't stamp last_sync_at on an aborted sync — the timestamp would lie about freshness
    if (!aborted) {
      await db.query(`UPDATE clients SET last_sync_at = NOW() WHERE id = $1`, [clientId]);
    }

    log.info('operator.sync.manual_run', {
      clientId, runId, granted, revoked,
      skippedHolderOptin: skippedHolderOptin || 0,
      sanityGateTriggered: !!sanityGateTriggered,
      aborted: !!aborted, reason: reason || null,
    });
    res.json({
      ok: true, runId, granted, revoked,
      skippedHolderOptin: skippedHolderOptin || 0,
      sanityGateTriggered: !!sanityGateTriggered,
      aborted: !!aborted, reason: reason || null,
    });
  } catch (err) {
    log.error('operator.sync.manual_run_failed', { clientId }, err);
    res.status(500).json({ error: 'Sync failed' });
  }
});

module.exports = router;
