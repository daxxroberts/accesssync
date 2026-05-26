/**
 * @file wix-instance.js
 * @layer admin/middleware
 * @role wix-operator-auth
 * @exports requireWixInstance, verifySignedInstance
 *
 * Verifies the Wix signed instance token appended to dashboard page iframe URLs.
 *
 * Wix appends ?instance=<token> when loading a self-hosted Dashboard Page Extension.
 * Token format: [HMACSHA-256 signature].[Base64-URL-encoded JSON data]
 * Verified using the WIX_APP_SECRET env var (App Secret Key from Wix App Dashboard).
 *
 * Lookup strategy (three-path):
 *   Path A — platform_instance_id match → known client, issue token, go to dashboard
 *   Path B — no instance match, siteId from authorizationCode matches source_site_id → update platform_instance_id, go to dashboard
 *   Path C — no match on either → redirect to onboarding
 *
 * Payload fields used:
 *   instanceId  — Wix app installation ID (maps to clients.platform_instance_id)
 *   uid         — Wix User ID of the viewer
 *   siteOwnerId — Wix User ID of the site owner
 *   permissions — 'OWNER' for site owners
 *   aid         — present if anonymous (reject immediately)
 *
 * authorizationCode param: Wix passes a signed JWT in ?authorizationCode= containing
 *   siteId (the Wix meta-site ID, maps to clients.source_site_id). Used as fallback lookup key.
 */

'use strict';

const crypto = require('crypto');
const db     = require('../../db');
const { log } = require('../../core/logger');

const APP_SECRET = process.env.WIX_APP_SECRET;

/**
 * Verifies a Wix signed instance token.
 *
 * @param {string} instance  Raw instance string from ?instance= query param
 * @returns {object} Decoded, verified payload
 * @throws  If signature invalid, anonymous user, or not site owner
 */
function verifySignedInstance(instance) {
  if (!APP_SECRET) {
    throw new Error('WIX_APP_SECRET env var not set — cannot verify Wix instance');
  }

  const dotIndex = instance.indexOf('.');
  if (dotIndex === -1) throw new Error('Malformed Wix instance — no separator found');

  const signature = instance.slice(0, dotIndex);
  const dataB64   = instance.slice(dotIndex + 1);

  // Recompute HMAC-SHA256 of the data portion using the app secret
  const expected = crypto
    .createHmac('sha256', APP_SECRET)
    .update(dataB64)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  if (signature !== expected) {
    throw new Error('Wix instance signature invalid');
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(dataB64, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Wix instance data decode failed');
  }

  // Reject anonymous viewers (aid present = not logged in)
  if (payload.aid) {
    throw new Error('Wix instance: anonymous user — access denied');
  }

  // Confirm site owner
  const isOwner = (payload.uid && payload.uid === payload.siteOwnerId) ||
                  payload.permissions === 'OWNER';

  if (!isOwner) {
    throw new Error('Wix instance: viewer is not the site owner');
  }

  return payload;
}

/**
 * Extracts siteId from the Wix authorizationCode JWT.
 * The authorizationCode is a JWS passed as a URL param by Wix — we read
 * the payload without verifying the signature (it's supplementary context,
 * not a security boundary — the signed instance token is the auth gate).
 *
 * @param {string} authCode  Raw authorizationCode query param value
 * @returns {string|null}    siteId if found, null otherwise
 */
function extractSiteIdFromAuthCode(authCode) {
  try {
    const parts = authCode.split('.');
    if (parts.length < 2) return null;
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    // payload.data is a JSON string containing decodedToken.siteId
    const data = typeof decoded.data === 'string' ? JSON.parse(decoded.data) : decoded.data;
    return data?.decodedToken?.siteId || null;
  } catch {
    return null;
  }
}

/**
 * Express middleware — verifies Wix signed instance and resolves clientId.
 *
 * Three-path lookup:
 *   Path A: platform_instance_id match → known client
 *   Path B: source_site_id match via authorizationCode → update platform_instance_id, known client
 *   Path C: no match → redirect to onboarding
 *
 * Sets req.wixOperator = { clientId, instanceId, siteId, uid } on success.
 */
async function requireWixInstance(req, res, next) {
  try {
    const instance = req.query.instance;
    if (!instance) {
      return res.status(401).send('Missing Wix instance token');
    }

    const payload = verifySignedInstance(instance);
    const { instanceId } = payload;

    if (!instanceId) {
      return res.status(401).send('Wix instance missing instanceId');
    }

    // ── Path A: look up by platform_instance_id ───────────────────────
    const byInstance = await db.query(
      'SELECT id, source_site_id FROM clients WHERE platform_instance_id = $1 LIMIT 1',
      [instanceId]
    );

    if (byInstance.rows.length) {
      req.wixOperator = {
        clientId:   byInstance.rows[0].id,
        instanceId,
        siteId:     byInstance.rows[0].source_site_id,
        uid:        payload.uid,
      };
      recordWixAdminSeen(byInstance.rows[0].id, payload.uid, payload.permissions);
      return next();
    }

    // ── Path B: fall back to source_site_id via authorizationCode ───────
    const siteId = req.query.authorizationCode
      ? extractSiteIdFromAuthCode(req.query.authorizationCode)
      : null;

    if (siteId) {
      const bySite = await db.query(
        'SELECT id, source_site_id FROM clients WHERE source_site_id = $1 LIMIT 1',
        [siteId]
      );

      if (bySite.rows.length) {
        const clientId = bySite.rows[0].id;
        // Wire up platform_instance_id so future loads hit Path A
        await db.query(
          'UPDATE clients SET platform_instance_id = $1, updated_at = NOW() WHERE id = $2',
          [instanceId, clientId]
        );
        log.info('admin.wix_instance_wired', { clientId });
        req.wixOperator = { clientId, instanceId, siteId, uid: payload.uid };
        recordWixAdminSeen(clientId, payload.uid, payload.permissions);
        return next();
      }
    } else {
      log.warn('admin.wix_instance_no_auth_code', { instanceId });
    }

    // ── Path C: no match — redirect to onboarding ─────────────────
    log.warn('admin.wix_instance_not_found', { instanceId, siteId });
    const params = new URLSearchParams();
    if (instanceId) params.set('instanceId', instanceId);
    if (siteId)     params.set('siteId', siteId);
    return res.redirect(`/onboard?${params.toString()}`);

  } catch (err) {
    log.warn('admin.wix_instance_verify_failed', {}, err);
    res.status(401).send(`Access denied: ${err.message}`);
  }
}

/**
 * UPSERT Wix admin presence into wix_admin_seen.
 * Called from requireWixInstance after successful auth (both Path A and Path B).
 * Fire-and-forget — never blocks the request, never throws. DB failures
 * logged via log.error but don't break auth (observability doctrine, DR-037).
 *
 * @param {string} clientId      UUID — resolved client
 * @param {string} wixUid        Wix User ID from signed-instance payload.uid
 * @param {string} [permissions] Wix permissions value (e.g. 'OWNER')
 */
function recordWixAdminSeen(clientId, wixUid, permissions) {
  if (!clientId || !wixUid) return;
  db.query(
    `INSERT INTO wix_admin_seen (client_id, wix_uid, permissions, first_seen_at, last_seen_at, seen_count)
     VALUES ($1, $2, $3, NOW(), NOW(), 1)
     ON CONFLICT (client_id, wix_uid) DO UPDATE
       SET last_seen_at = NOW(),
           permissions  = COALESCE(EXCLUDED.permissions, wix_admin_seen.permissions),
           seen_count   = wix_admin_seen.seen_count + 1,
           updated_at   = NOW()`,
    [clientId, wixUid, permissions || null]
  ).catch(err => {
    log.error('wix_admin_seen.upsert_failed', { clientId, wixUid }, err);
  });
}

module.exports = { requireWixInstance, verifySignedInstance };
