/**
 * @file hardware-health-check.js
 * @layer core/layer4
 * @role cron-6hr
 * @schedule every 6 hours via Railway Cron
 * @reads locations, clients
 * @writes locations.hardware_key_last_verified, locations.hardware_key_last_error
 * @calls hardware-adapter (getLocks), resend (alerts)
 * @exports runHealthCheck
 * @dr DR-028
 *
 * hardware-health-check.js
 * Core Engine (Layer 4) — Sprint 5 ticket 5.2
 *
 * Runs every 6 hours via Railway Cron: node core/hardware-health-check.js
 *
 * Responsibilities:
 * - For each active client, validate their stored hardware API key
 * - Test: call getLocks() (lightweight, read-only) — success = key valid
 * - On failure: send a specific diagnosis email (wrong key / no key / permissions)
 * - Update locations.hardware_key_last_verified + hardware_key_last_error
 *
 * Error types and messages:
 *   401 → key is wrong or expired
 *   403 → key valid but lacks required permissions (not on Pro tier)
 *   no key → key was never set
 *   network → Railway or Kisi connectivity issue (transient, not operator fault)
 */

'use strict';

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const { decryptApiKey } = require('./crypto-utils');

async function runHealthCheck() {
  console.log('[Hardware Health Check] Starting at', new Date().toISOString());

  // Per-location iteration: each active location gets its own key + platform check
  const locationsResult = await db.query(
    `SELECT l.id AS location_id, l.name AS location_name,
            COALESCE(l.hardware_platform, c.hardware_platform, 'kisi') AS hardware_platform,
            COALESCE(l.hardware_api_key, c.hardware_api_key) AS hardware_api_key,
            COALESCE(l.notification_email, c.notification_email) AS notification_email,
            c.name AS client_name, c.id AS client_id
     FROM locations l
     JOIN clients c ON l.client_id = c.id
     WHERE c.status = 'active' AND l.subscription_status = 'active'`
  );

  for (const loc of locationsResult.rows) {
    await _checkLocation(loc);
  }

  console.log('[Hardware Health Check] Complete.');
}

async function _checkLocation(loc) {
  const platform = loc.hardware_platform;

  const encKey = loc.hardware_api_key;
  if (!encKey) {
    const msg = 'No hardware API key configured. Set your API key in the AccessSync dashboard under this location.';
    console.warn(`[Hardware Health Check] ${loc.client_name} / ${loc.location_name}: no key set.`);
    await _notifyFailure(loc, null, 'no_key', msg);
    await _updateLocationVerification(loc.location_id, null, msg);
    return;
  }

  let apiKey;
  try {
    apiKey = decryptApiKey(encKey);
  } catch (err) {
    console.error(`[Hardware Health Check] ${loc.client_name} / ${loc.location_name}: key decryption failed.`);
    return;
  }

  // Test: call getLocks() — lightweight read-only validation
  let error = null;
  let errorType = null;
  try {
    await hardwareAdapter.getLocks(platform, apiKey);
    console.log(`[Hardware Health Check] ${loc.client_name} / ${loc.location_name}: key valid ✓`);
  } catch (err) {
    error = err;
    if (err.statusCode === 401) {
      errorType = 'invalid_key';
    } else if (err.statusCode === 403) {
      errorType = 'insufficient_permissions';
    } else {
      errorType = 'network_error';
    }
    console.warn(`[Hardware Health Check] ${loc.client_name} / ${loc.location_name}: ${errorType} — ${err.message}`);
  }

  const errorMsg = error ? _diagnose(errorType, platform) : null;
  await _updateLocationVerification(loc.location_id, error ? null : new Date(), errorMsg);

  // Notify only on actionable errors (skip transient network issues)
  if (errorType && errorType !== 'network_error') {
    await _notifyFailure(loc, errorType, errorType, errorMsg);
  }
}

function _diagnose(errorType, platform) {
  switch (errorType) {
    case 'invalid_key':
      return `Your ${platform} API key was rejected (401 Unauthorized). The key may have been rotated or deleted. Generate a new key in your ${platform} account and update it in the AccessSync dashboard under Locations.`;
    case 'insufficient_permissions':
      return `Your ${platform} API key authenticated but lacks required permissions (403 Forbidden). Confirm your account is on the Pro tier — the API key must have access to locks, groups, and role assignments.`;
    case 'network_error':
      return `AccessSync could not reach the ${platform} API. This is likely a temporary connectivity issue and will resolve automatically.`;
    default:
      return `Unknown error communicating with ${platform}.`;
  }
}

async function _updateLocationVerification(locationId, verifiedAt, errorMsg) {
  await db.query(
    `UPDATE locations
     SET hardware_key_last_verified = $1,
         hardware_key_last_error    = $2
     WHERE id = $3`,
    [verifiedAt, errorMsg, locationId]
  ).catch(e => console.error('[Hardware Health Check] Failed to update location:', e.message));
}

async function _notifyFailure(loc, locName, errorType, message) {
  const toEmail = loc.notification_email || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) {
    console.warn(`[Hardware Health Check] No notification email for ${loc.client_name} / ${loc.location_name} — logged only.`);
    return;
  }

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const subject = errorType === 'invalid_key'
      ? '[AccessSync] Action required: hardware API key rejected'
      : errorType === 'insufficient_permissions'
        ? '[AccessSync] Action required: API key permissions issue'
        : '[AccessSync] Hardware API key check failed';

    await resend.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
      to:      toEmail,
      subject,
      text: [
        `AccessSync Hardware Key Alert — ${new Date().toISOString()}`,
        '',
        `Client: ${loc.client_name}`,
        `Location: ${loc.location_name}`,
        '',
        message,
        '',
        'To fix this: log in to the AccessSync dashboard → System Config → Update the API key for this location.',
        '',
        'Members will not lose existing access, but new signups will not provision until the key is corrected.',
      ].join('\n'),
    });
    console.log(`[Hardware Health Check] Alert sent to ${toEmail} for ${loc.location_name}`);
  } catch (err) {
    console.error('[Hardware Health Check] Failed to send alert:', err.message);
  }
}

// Executable entry point for Railway Cron
if (require.main === module) {
  runHealthCheck()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runHealthCheck };
