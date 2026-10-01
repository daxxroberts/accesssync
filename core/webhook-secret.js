/**
 * core/webhook-secret.js — per-client Wix webhook signing secret (OB-238).
 *
 * Every client signs its Velo webhooks with its OWN secret, stored encrypted in
 * clients.wix_webhook_secret (DR-028). There is no platform-wide fallback: a
 * client without a secret cannot have webhooks accepted, so the secret is
 * generated the moment the client row is created.
 */

'use strict';

const crypto = require('crypto');
const db = require('../db');
const { encryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');

/** 32 random bytes, base64 — same shape as the Setup Hub "Rotate secret" button. */
function generateWebhookSecret() {
  return crypto.randomBytes(32).toString('base64');
}

/**
 * Give the client a secret if it has none. Never overwrites an existing secret
 * (onboarding can be re-run against an existing client).
 *
 * @param {string} clientId
 * @returns {Promise<string|null>} the new plaintext secret when one was created
 *   (show it to the operator once), or null when the client already had one.
 */
async function ensureWebhookSecret(clientId) {
  const plaintext = generateWebhookSecret();
  const result = await db.query(
    `UPDATE clients SET wix_webhook_secret = $1, updated_at = NOW()
      WHERE id = $2 AND wix_webhook_secret IS NULL
      RETURNING id`,
    [encryptApiKey(plaintext), clientId]
  );
  if (!result.rows.length) return null;
  log.warn('clients.wix_webhook_secret.auto_generated', { clientId });
  return plaintext;
}

module.exports = { generateWebhookSecret, ensureWebhookSecret };
