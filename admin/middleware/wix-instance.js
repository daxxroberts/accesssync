/**
 * @file wix-instance.js
 * @layer admin/middleware
 * @role wix-operator-auth
 * @exports verifyWixInstance
 *
 * Verifies the Wix signed instance token appended to dashboard page iframe URLs.
 *
 * Wix appends ?instance=<token> when loading a self-hosted Dashboard Page Extension.
 * Token format: [HMACSHA-256 signature].[Base64-URL-encoded JSON data]
 * Verified using the WIX_APP_SECRET env var (App Secret Key from Wix App Dashboard).
 *
 * Payload fields used:
 *   instanceId  — identifies which Wix site (maps to clients.wix_site_id)
 *   uid         — Wix User ID of the viewer
 *   siteOwnerId — Wix User ID of the site owner
 *   permissions — 'OWNER' for site owners
 *   aid         — present if anonymous (reject immediately)
 */

'use strict';

const crypto = require('crypto');
const db     = require('../../db');

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
 * Express middleware — verifies Wix signed instance and resolves clientId.
 *
 * Reads ?instance= from query, verifies HMAC, confirms site owner,
 * then looks up clients.id by wix_site_id matching the instanceId.
 *
 * Sets req.wixOperator = { clientId, instanceId, uid } on success.
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

    // Resolve instanceId → clientId via site_id on clients table
    const result = await db.query(
      'SELECT id FROM clients WHERE site_id = $1 LIMIT 1',
      [instanceId]
    );

    if (!result.rows.length) {
      console.warn(`[wix-instance] No client found for instanceId: ${instanceId} — redirecting to onboarding`);
      return res.redirect(`/onboard?siteId=${encodeURIComponent(instanceId)}`);
    }

    req.wixOperator = {
      clientId:   result.rows[0].id,
      instanceId,
      uid:        payload.uid,
    };

    next();
  } catch (err) {
    console.warn('[wix-instance] Verification failed:', err.message);
    res.status(401).send(`Access denied: ${err.message}`);
  }
}

module.exports = { requireWixInstance, verifySignedInstance };
