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
 * Scheduled by admin/server.js: every 15 minutes it asks maybeSendOwnerDaily(), which sends once per day
 * during OWNER_DAILY_HOUR in OWNER_DAILY_TZ (default 7:00 America/Chicago — Daxx's rule 2026-10-15: Central
 * time, never UTC). Hour and day are computed in that zone whatever the server's own clock is set to. The
 * once-a-day guard is the diagnostic_log row the logger writes for email.owner_daily.sent, so a restart during
 * the hour does not send twice.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const { computeOwnerHealth, verdictLine } = require('./owner-health');
const { sendOperatorEmail } = require('./operator-mailer');
const { renderOwnerDaily } = require('./operator-email-templates');

const DEFAULT_TZ = 'America/Chicago';
const DEFAULT_HOUR = 7;

let _lastSentDay = null;

/** Calendar day (YYYY-MM-DD) and hour of `d` in the given IANA zone. */
function localParts(d, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: parseInt(parts.hour, 10) };
}

async function sentOn(day, timeZone) {
  try {
    const r = await db.query(
      `SELECT created_at FROM diagnostic_log
        WHERE error_code = 'EMAIL_OWNER_DAILY_SENT' AND created_at > NOW() - INTERVAL '2 days'
        ORDER BY created_at DESC LIMIT 1`
    );
    const last = r && r.rows && r.rows[0] && r.rows[0].created_at;
    return !!last && localParts(new Date(last), timeZone).day === day;
  } catch (err) {
    log.warn('email.owner_daily.guard_failed', {}, err);
    return false;
  }
}

/**
 * Send the owner daily now, whatever the hour. Returns { sent, reason? }.
 * @param {{ now?: Date, timeZone?: string }} opts  the instant and zone the send counts against for the
 *   once-a-day guard; maybeSendOwnerDaily passes the tick it judged, so the guard and the hour check agree.
 */
async function sendOwnerDaily({ now = new Date(), timeZone } = {}) {
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
    _lastSentDay = localParts(now, timeZone || process.env.OWNER_DAILY_TZ || DEFAULT_TZ).day;
    log.info('email.owner_daily.sent', { toEmail, verdict: health.verdict, problems: health.problems.length, platform: health.platform.length });
  } else {
    log.error('email.owner_daily.failed', { toEmail, reason: result.reason });
  }
  return result;
}

/**
 * Called every 15 minutes by the scheduler: sends once per local day, only during `hour` in `timeZone`.
 * @param {{ hour?: number, timeZone?: string, now?: Date }} opts  defaults: 7, America/Chicago, now
 */
async function maybeSendOwnerDaily({ hour, timeZone, now = new Date() } = {}) {
  const tz = timeZone || process.env.OWNER_DAILY_TZ || DEFAULT_TZ;
  const h = Number.isInteger(hour) ? hour : (Number.isInteger(parseInt(process.env.OWNER_DAILY_HOUR, 10)) ? parseInt(process.env.OWNER_DAILY_HOUR, 10) : DEFAULT_HOUR);
  const local = localParts(now, tz);
  if (local.hour !== h) return { sent: false, reason: 'not_the_hour' };
  if (_lastSentDay === local.day) return { sent: false, reason: 'already_sent_today' };
  if (await sentOn(local.day, tz)) { _lastSentDay = local.day; return { sent: false, reason: 'already_sent_today' }; }
  return sendOwnerDaily({ now, timeZone: tz });
}

/** Test hook. */
function _resetForTests() { _lastSentDay = null; }

module.exports = { sendOwnerDaily, maybeSendOwnerDaily, localParts, DEFAULT_TZ, DEFAULT_HOUR, _resetForTests };
