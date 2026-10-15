/**
 * @file owner-daily-email.js
 * @layer core/layer4
 * @role owner-daily-email
 * @reads diagnostic_log (sent-today guard); everything else through core/owner-health.js
 * @writes nothing (the send is logged; the logger persists email.owner_daily.sent)
 * @exports sendOwnerDaily, maybeSendOwnerDaily
 *
 * The owner daily (handoff/OWNER_HUB_PROPOSAL_2026-10-15.md §3): one email a day to the AccessSync owner
 * address, INCLUDING an all-clear, so a missing email always means something is wrong. Subject = the Hub's
 * verdict line. One line per gym problem (reason, who acts, since), counts only, never member names. It renders
 * from the same computation as the Hub (core/owner-health.js), so the page and the email cannot disagree.
 *
 * Scheduled by admin/server.js: every 15 minutes it asks maybeSendOwnerDaily(), which sends once per UTC day
 * during OWNER_DAILY_HOUR_UTC (default 13:00 UTC, early morning US Central). The once-a-day guard is the
 * diagnostic_log row the logger writes for email.owner_daily.sent, so a restart during the hour does not send twice.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const { computeOwnerHealth, verdictLine } = require('./owner-health');
const { sendOperatorEmail } = require('./operator-mailer');
const { renderOwnerDaily } = require('./operator-email-templates');

let _lastSentDay = null;
const dayOf = (d) => d.toISOString().slice(0, 10);

async function sentToday() {
  try {
    const r = await db.query(
      `SELECT 1 FROM diagnostic_log
        WHERE error_code = 'EMAIL_OWNER_DAILY_SENT' AND created_at >= date_trunc('day', NOW())
        LIMIT 1`
    );
    return !!(r && r.rows && r.rows.length);
  } catch (err) {
    log.warn('email.owner_daily.guard_failed', {}, err);
    return false;
  }
}

/** Send the owner daily now, whatever the hour. Returns { sent, reason? }. */
async function sendOwnerDaily() {
  const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;
  if (!toEmail) {
    log.warn('email.owner_daily.no_recipient', {});
    return { sent: false, reason: 'no_recipient' };
  }
  let health;
  try {
    health = await computeOwnerHealth();
  } catch (err) {
    log.error('email.owner_daily.health_failed', {}, err);
    return { sent: false, reason: 'health_failed' };
  }
  health.verdict_line = verdictLine(health);
  const result = await sendOperatorEmail({
    toEmail,
    render: renderOwnerDaily,
    renderArgs: health,
    logContext: { alert: 'owner_daily', verdict: health.verdict },
  });
  if (result.sent) {
    _lastSentDay = dayOf(new Date());
    log.info('email.owner_daily.sent', { toEmail, verdict: health.verdict, problems: health.problems.length, platform: health.platform.length });
  } else {
    log.error('email.owner_daily.failed', { toEmail, reason: result.reason });
  }
  return result;
}

/** Called every 15 minutes by the scheduler: sends once per UTC day, only during hourUtc. */
async function maybeSendOwnerDaily({ hourUtc = 13, now = new Date() } = {}) {
  if (now.getUTCHours() !== hourUtc) return { sent: false, reason: 'not_the_hour' };
  const day = dayOf(now);
  if (_lastSentDay === day) return { sent: false, reason: 'already_sent_today' };
  if (await sentToday()) { _lastSentDay = day; return { sent: false, reason: 'already_sent_today' }; }
  return sendOwnerDaily();
}

/** Test hook. */
function _resetForTests() { _lastSentDay = null; }

module.exports = { sendOwnerDaily, maybeSendOwnerDaily, _resetForTests };
