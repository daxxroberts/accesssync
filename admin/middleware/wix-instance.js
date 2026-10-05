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
 *   Path C — no match on either → first open after install: create the client from the
 *            verified instanceId and go to setup (the install is the invitation)
 *
 * Payload fields used:
 *   instanceId  — Wix app installation ID (maps to clients.platform_instance_id)
 *   uid         — Wix User ID of the viewer (required; any dashboard user for the site)
 *   siteOwnerId — Wix User ID of the site owner (informational)
 *   permissions — recorded in wix_admin_seen; not used as a gate
 *   aid         — present if anonymous (reject immediately)
 *
 * authorizationCode param: Wix passes a signed JWT in ?authorizationCode= containing
 *   siteId (the Wix meta-site ID, maps to clients.source_site_id). Used as fallback lookup key.
 */

'use strict';

const crypto = require('crypto');
const db     = require('../../db');
const { log } = require('../../core/logger');
const { ensureWebhookSecret } = require('../../core/webhook-secret');

const APP_SECRET = process.env.WIX_APP_SECRET;

/**
 * Verifies a Wix signed instance token.
 *
 * @param {string} instance  Raw instance string from ?instance= query param
 * @returns {object} Decoded, verified payload
 * @throws  If signature invalid, or the viewer is anonymous / not a signed-in Wix user
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

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
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

  // Anyone Wix lets into this site's dashboard may open AccessSync for it — owner,
  // co-admin or staff. The instance is signed and scoped to ONE installation
  // (instanceId), so a viewer can only ever resolve to the client for the site they
  // are already signed into. Must be a real signed-in user, though.
  if (!payload.uid) {
    throw new Error('Wix instance: no signed-in Wix user — access denied');
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
 *   Path C: no match → create a shell client for this verified installation
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
      // The authorizationCode is read WITHOUT signature verification, so its siteId
      // is attacker-controllable. It may only claim a client that has never been
      // wired to an instance — otherwise anyone with a valid instance for their own
      // Wix site could forge another gym's siteId, overwrite that gym's
      // platform_instance_id and walk away with an operator session for it.
      // A legitimate reinstall on an already-wired client needs the owner to clear
      // platform_instance_id first.
      const bySite = await db.query(
        `SELECT id, source_site_id FROM clients
          WHERE source_site_id = $1
            AND (platform_instance_id IS NULL OR platform_instance_id = '')
          LIMIT 1`,
        [siteId]
      );

      if (bySite.rows.length) {
        const clientId = bySite.rows[0].id;
        // Wire up platform_instance_id so future loads hit Path A. Re-checked in the
        // UPDATE so two concurrent claims can't both win.
        const wired = await db.query(
          `UPDATE clients SET platform_instance_id = $1, updated_at = NOW()
            WHERE id = $2 AND (platform_instance_id IS NULL OR platform_instance_id = '')
            RETURNING id`,
          [instanceId, clientId]
        );
        if (!wired.rows.length) {
          log.warn('admin.wix_instance_wire_refused', { clientId, instanceId });
          return res.status(403).send('Access denied: this site is already connected to a different Wix installation');
        }
        log.info('admin.wix_instance_wired', { clientId });
        req.wixOperator = { clientId, instanceId, siteId, uid: payload.uid };
        recordWixAdminSeen(clientId, payload.uid, payload.permissions);
        return next();
      }
    } else {
      log.warn('admin.wix_instance_no_auth_code', { instanceId });
    }

    // ── Path C: first open after install — create the client ──────────
    // The install IS the invitation: this app is installed by the AccessSync owner
    // onto each customer's Wix site, and Wix has just signed (WIX_APP_SECRET) that
    // this viewer is the owner of that installation. Nothing here comes from the
    // URL — the only input is the verified instanceId. The shell client carries
    // that instanceId and nothing else; source_site_id stays NULL because the
    // authorizationCode site id is unsigned. The setup wizard collects and verifies
    // it, and the shell has no Kisi key / no source key so reconciliation skips it.
    const { clientId, created } = await findOrCreateClientForInstance(instanceId);
    if (created) {
      log.warn('admin.wix_instance_client_created', { clientId, instanceId });
      try {
        await ensureWebhookSecret(clientId);
      } catch (err) {
        // Not fatal here: the wizard's profile step and setup-state call it again.
        log.error('admin.wix_instance_secret_failed', { clientId }, err);
      }
    }
    req.wixOperator = { clientId, instanceId, siteId: null, uid: payload.uid, created };
    recordWixAdminSeen(clientId, payload.uid, payload.permissions);
    return next();

  } catch (err) {
    log.warn('admin.wix_instance_verify_failed', {}, err);
    res.status(401).send(`Access denied: ${err.message}`);
  }
}

const SHELL_CLIENT_NAME = 'New Wix site';

/**
 * Find the client for a verified Wix installation, creating a bare one if this is
 * the first open. Two tabs opening at once, or Wix retrying, race on the unique
 * platform_instance_id index — the loser re-reads the winner's row, so one
 * installation can never become two clients.
 *
 * @param {string} instanceId  verified Wix app instance id
 * @returns {Promise<{clientId: string, created: boolean}>}
 */
async function findOrCreateClientForInstance(instanceId) {
  try {
    const ins = await db.query(
      // reconciliation_interval '6h' = the cadence House of Gains runs on. The column default is 'daily', and the
      // nightly gate takes its interval from whichever client synced most recently, so a new client left on 'daily'
      // would stretch every client's sync to 24h and trip the panel's reconcile thresholds.
      `INSERT INTO clients (name, platform_instance_id, status, reconciliation_interval)
       VALUES ($1, $2, 'active', '6h')
       RETURNING id`,
      [SHELL_CLIENT_NAME, instanceId]
    );
    return { clientId: ins.rows[0].id, created: true };
  } catch (err) {
    if (err && err.code === '23505') {
      const existing = await db.query(
        'SELECT id FROM clients WHERE platform_instance_id = $1 LIMIT 1',
        [instanceId]
      );
      if (existing.rows.length) return { clientId: existing.rows[0].id, created: false };
    }
    throw err;
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
