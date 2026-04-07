/**
 * @file hmac-monitor.js
 * @layer core/layer4
 * @role security-monitoring
 * @reads Redis (sliding window counter)
 * @writes Redis (failure count, cooldown key)
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

const WINDOW_SECONDS   = 300;  // 5-minute sliding window
const FAILURE_THRESHOLD = 3;
const ALERT_COOLDOWN_KEY = 'hmac:alert_sent';
const ALERT_COOLDOWN_TTL = 600; // 10 min — prevents alert storm if attack is sustained

async function recordFailure(clientHint = 'unknown') {
  let redis;
  try {
    redis = getRedisConnection();
    const listKey = 'hmac:failures';

    // Push timestamp, trim to last 50 entries, check window count
    const now = Math.floor(Date.now() / 1000);
    await redis.lpush(listKey, now);
    await redis.ltrim(listKey, 0, 49);
    await redis.expire(listKey, WINDOW_SECONDS * 2);

    const all = await redis.lrange(listKey, 0, -1);
    const recentCount = all.filter(t => now - parseInt(t) < WINDOW_SECONDS).length;

    if (recentCount >= FAILURE_THRESHOLD) {
      // Check cooldown — only alert once per window
      const alreadyAlerted = await redis.get(ALERT_COOLDOWN_KEY);
      if (!alreadyAlerted) {
        await redis.set(ALERT_COOLDOWN_KEY, '1', 'EX', ALERT_COOLDOWN_TTL);
        await _sendAlert(recentCount, clientHint);
      }
    }
  } catch (err) {
    // Never block the webhook flow for monitoring failures
    console.error('[HMAC Monitor] recordFailure error:', err.message);
  }
}

async function _sendAlert(count, clientHint) {
  const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  if (!toEmail) {
    console.warn('[HMAC Monitor] ACCESSSYNC_OWNER_NOTIFICATION_EMAIL not set — alert logged only.');
    console.warn(`[HMAC Monitor] ALERT: ${count} HMAC failures in 5 min. Possible webhook attack. Client hint: ${clientHint}`);
    return;
  }
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from:    process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
      to:      toEmail,
      subject: '[AccessSync] ⚠ HMAC failure spike detected',
      text: [
        `AccessSync Security Alert — ${new Date().toISOString()}`,
        '',
        `${count} webhook HMAC signature failures detected in the last 5 minutes.`,
        '',
        'This may indicate:',
        '  - A misconfigured webhook secret in Wix Secrets Manager',
        '  - An external system sending requests to your webhook URL',
        '  - A replay attack attempt',
        '',
        `Client hint: ${clientHint}`,
        '',
        'Action: Check your Wix Secrets Manager → accesssync_webhook_secret.',
        'If the secret is correct and failures continue, check Railway logs for source IPs.',
      ].join('\n'),
    });
    console.log(`[HMAC Monitor] Alert sent to ${toEmail}`);
  } catch (err) {
    console.error('[HMAC Monitor] Failed to send alert email:', err.message);
  }
}

module.exports = { recordFailure };
