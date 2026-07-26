/**
 * @file hmac-monitor.js
 * @layer core/layer4
 * @role security-monitoring
 * @reads Redis (sliding window counter)
 * @writes Redis (failure count, cooldown key), diagnostic_log (via logger)
 * @calls resend (spike alerts)
 * @exports recordFailure(clientId)
 * @dr DR-009
 *
 * hmac-monitor.js
 * Core Engine (Layer 4) — Sprint 5 ticket 5.1
 *
 * Responsibilities:
 * - Tracks HMAC rejection events in Redis using a sliding window counter
 * - Fires a Resend alert email when 3 failures occur within 5 minutes
 * - Provides recordFailure() called by wix-connector on every HMAC rejection
 *
 * Threshold: 3 failures in 300 seconds → alert fires once per window (deduped by Redis key TTL).
 * Alert is sent to ACCESSSYNC_OWNER_NOTIFICATION_EMAIL (env var).
 */

'use strict';

const { getRedisConnection } = require('./redis-utils');
const { log } = require('./logger');
const { sendOperatorEmail } = require('./operator-mailer');
const { renderHmacAlert } = require('./operator-email-templates');

const WINDOW_SECONDS    = 300;  // 5-minute sliding window
const FAILURE_THRESHOLD = 3;
const ALERT_COOLDOWN_KEY = 'hmac:alert_sent';
const ALERT_COOLDOWN_TTL = 600; // 10 min — prevents alert storm if attack is sustained

async function recordFailure(clientHint = 'unknown') {
  // Log every individual HMAC failure for per-client trend analysis.
  // clientHint is the resolved client_id UUID when available, else 'unknown'.
  const clientId = clientHint !== 'unknown' ? clientHint : null;
  log.warn('hmac.failure', { clientId, clientHint });

  let redis;
  try {
    redis = getRedisConnection();
    const safeHint = String(clientHint).replace(/[^a-zA-Z0-9_-]/g, '_');
    const listKey = `hmac:failures:${safeHint}`;
    const cooldownKey = `${ALERT_COOLDOWN_KEY}:${safeHint}`;

    // Push timestamp, trim to last 50 entries, check window count
    const now = Math.floor(Date.now() / 1000);
    await redis.lpush(listKey, now);
    await redis.ltrim(listKey, 0, 49);
    await redis.expire(listKey, WINDOW_SECONDS * 2);

    const all = await redis.lrange(listKey, 0, -1);
    const recentCount = all.filter(t => now - parseInt(t) < WINDOW_SECONDS).length;

    if (recentCount >= FAILURE_THRESHOLD) {
      const alreadyAlerted = await redis.get(cooldownKey);
      if (!alreadyAlerted) {
        await redis.set(cooldownKey, '1', 'EX', ALERT_COOLDOWN_TTL);
        await _sendAlert(recentCount, clientHint, clientId);
      }
    }
  } catch (err) {
    // Never block the webhook flow for monitoring failures
    log.error('hmac.monitor.internal_error', { clientId, clientHint }, err);
  }
}

async function _sendAlert(count, clientHint, clientId) {
  const spikeErr = new Error(`${count} HMAC failures in 5 min — possible webhook attack`);
  spikeErr.code = 'HMAC_FAILURE_SPIKE';
  log.warn('hmac.failure_spike', { clientId, clientHint, count }, spikeErr);

  const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) {
    log.warn('hmac.alert.no_email', { clientId, clientHint, count });
    return;
  }

  // Audience split: the operator is a gym owner, not a security engineer. The email says
  // what happened and whether they need to act; the failure count, client hint, and
  // signature details stay in diagnostic_log (logged above) for whoever debugs it.
  const { sent, reason } = await sendOperatorEmail({
    toEmail,
    render: renderHmacAlert,
    logContext: { alert: 'hmac_spike', clientId, clientHint, count },
  });

  if (sent) log.info('hmac.alert.sent', { toEmail, count, clientHint });
  else log.error('hmac.alert.send_failed', { clientId, clientHint, toEmail, reason });
}

module.exports = { recordFailure };
