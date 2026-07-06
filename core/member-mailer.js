/**
 * core/member-mailer.js — DR-052
 * The I/O half of member-facing branded email: branding load, ship-dark gate,
 * atomic dedup, Resend send, send-log stamping.
 *
 * CONTRACT: sendMemberEmail NEVER throws and never blocks the caller's pipeline —
 * grant/revoke jobs must succeed or fail on their own merits regardless of email
 * delivery. Callers fire-and-forget with `.catch()` anyway (belt and braces).
 *
 * Idempotency: member_email_log UNIQUE (client_id, email_type, dedup_key) +
 * INSERT ... ON CONFLICT DO NOTHING RETURNING id — the clients.first_grant_sent
 * atomic-flag pattern generalized. A conflicting insert means this exact email
 * was already sent (or is being sent by a concurrent worker): skip silently.
 *
 * FROM strategy (Builder ruling 2026-07-05): display-name branding —
 * "{Gym Name}" <RESEND_MEMBER_FROM_EMAIL || RESEND_FROM_EMAIL> with Reply-To set
 * to the gym's admin contact (clients.notification_email). Per-client verified
 * domains are a deliberate later phase.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const { getTraceId } = require('./trace-context');
const { brandingFromClientRow } = require('./email-templates');

/**
 * @param {Object} p
 * @param {string} p.clientId          tenant UUID
 * @param {string|null} p.memberMasterId  member_master.id (audit linkage; nullable)
 * @param {string} p.emailType         'access_ready' | 'access_removed' | 'sub_member_invite' | 'test'
 * @param {string} p.dedupKey          uniqueness key within (client, emailType)
 * @param {string} p.recipient         destination email address
 * @param {Function} p.render          template fn (renderAccessReady etc.) — called with
 *                                     { branding, ...p.renderArgs }
 * @param {Object} [p.renderArgs]      template-specific args (member, plans, planName, ...)
 * @param {boolean} [p.bypassEnabledGate]  true ONLY for the operator "send test email"
 *                                     button — a test send is the operator explicitly
 *                                     asking, so the ship-dark toggle doesn't apply.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function sendMemberEmail(p) {
  const traceId = getTraceId() || null;
  try {
    if (!p || !p.clientId || !p.emailType || !p.dedupKey || !p.recipient || typeof p.render !== 'function') {
      log.warn('email.member.failed', { clientId: p && p.clientId, emailType: p && p.emailType, reason: 'bad_args' });
      return { sent: false, reason: 'bad_args' };
    }

    // 1. Branding + gate in one read.
    const clientRes = await db.query(
      `SELECT name, notification_email, member_emails_enabled,
              email_logo_url, email_primary_color, email_secondary_color
       FROM clients WHERE id = $1`,
      [p.clientId]
    );
    if (!clientRes.rows.length) {
      log.warn('email.member.failed', { clientId: p.clientId, emailType: p.emailType, reason: 'client_not_found' });
      return { sent: false, reason: 'client_not_found' };
    }
    const client = clientRes.rows[0];

    // 2. Ship-dark gate (DR-052): default false for every client; per-client enablement
    //    only after live verification. Test sends bypass — the operator asked explicitly.
    if (!client.member_emails_enabled && !p.bypassEnabledGate) {
      log.info('email.member.skipped_disabled', { clientId: p.clientId, emailType: p.emailType, traceId });
      return { sent: false, reason: 'disabled' };
    }

    // 3. Atomic dedup — once-only per (client, type, key), safe under concurrency.
    const ins = await db.query(
      `INSERT INTO member_email_log (client_id, member_master_id, email_type, dedup_key, recipient, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (client_id, email_type, dedup_key) DO NOTHING
       RETURNING id`,
      [p.clientId, p.memberMasterId || null, p.emailType, p.dedupKey, p.recipient, traceId]
    );
    if (!ins.rows.length) {
      log.info('email.member.suppressed', { clientId: p.clientId, emailType: p.emailType, dedupKey: p.dedupKey, traceId });
      return { sent: false, reason: 'duplicate' };
    }
    const logId = ins.rows[0].id;

    // 4. Render through the gym's branding and send.
    const branding = brandingFromClientRow(client);
    const { subject, html, text } = p.render(Object.assign({ branding }, p.renderArgs || {}));

    const fromAddress = process.env.RESEND_MEMBER_FROM_EMAIL || process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io';
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const sendPayload = {
      from:    `${branding.gymName.replace(/[<>"]/g, '')} <${fromAddress}>`,
      to:      p.recipient,
      subject,
      html,
      text,
    };
    if (client.notification_email) sendPayload.reply_to = client.notification_email;

    const result = await resend.emails.send(sendPayload);
    const resendId = result && result.data && result.data.id ? result.data.id : null;
    if (result && result.error) {
      // Resend SDK reports failures on result.error rather than throwing.
      await db.query(
        `UPDATE member_email_log SET delivery_status = 'failed' WHERE id = $1`,
        [logId]
      ).catch(() => {});
      log.warn('email.member.failed', {
        clientId: p.clientId, emailType: p.emailType, traceId,
        reason: result.error.message || String(result.error),
      });
      return { sent: false, reason: 'resend_error' };
    }

    // 5. Stamp the provider id (Phase-2 delivery-webhook join key).
    if (resendId) {
      await db.query(
        `UPDATE member_email_log SET resend_id = $1 WHERE id = $2`,
        [resendId, logId]
      ).catch(() => {});
    }

    log.info('email.member.sent', {
      clientId: p.clientId, emailType: p.emailType, dedupKey: p.dedupKey, resendId, traceId,
    });
    return { sent: true };
  } catch (err) {
    log.warn('email.member.failed', {
      clientId: p && p.clientId, emailType: p && p.emailType, traceId,
    }, err);
    return { sent: false, reason: 'exception' };
  }
}

// ─── Queue-worker orchestration hooks (DR-052) ───────────────────────────────
// Suppression is an ALLOW-LIST, not a block-list: member emails fire only for
// real webhook events or explicitly allowed member-hub synthetic sources. Any
// synthetic event without an allowed source — reconcile drift repair, self-heals,
// future untagged synthetics — is silently skipped. Fail-quiet beats member spam.

const templates = require('./email-templates');

const GRANT_ALLOWED_SYNTHETIC  = new Set(['multi-member.submit', 'multi-member.holder_claim']);
const REVOKE_ALLOWED_SYNTHETIC = new Set(['multi-member.remove_sub']);
const REVOKE_EMAIL_EVENT_TYPES = new Set(['plan.cancelled', 'booking.cancelled']);

function _grantEmailAllowed(standardEvent) {
  const e = standardEvent || {};
  if (!e.synthetic) return true;
  return GRANT_ALLOWED_SYNTHETIC.has(e.syntheticSource);
}

function _revokeEmailAllowed(standardEvent) {
  const e = standardEvent || {};
  if (!REVOKE_EMAIL_EVENT_TYPES.has(e.eventType)) return false;
  if (!e.synthetic) return true;
  return REVOKE_ALLOWED_SYNTHETIC.has(e.syntheticSource);
}

/**
 * M1/M3 — fire the access-ready (holder) or sub-member-invite email after a
 * successful grant. Fire-and-forget from queue-worker; never throws.
 * Sub-members are detected data-first (member_access.sub_master_id) rather than
 * by event plumbing, so every sub grant gets the right copy.
 */
async function maybeSendGrantEmail({ clientId, accessId, standardEvent, assignments, eventKey }) {
  try {
    if (!_grantEmailAllowed(standardEvent)) {
      log.info('email.member.suppressed', {
        clientId, emailType: 'access_ready', reason: 'synthetic_source',
        syntheticSource: standardEvent && standardEvent.syntheticSource,
      });
      return { sent: false, reason: 'synthetic_source' };
    }

    const memberRes = await db.query(
      `SELECT mm.id AS member_master_id, mm.email, mm.first_name, ma.sub_master_id
       FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.id = $1`,
      [accessId]
    );
    const m = memberRes.rows[0];
    if (!m || !m.email) {
      log.info('email.member.skipped_disabled', { clientId, emailType: 'access_ready', reason: 'no_recipient' });
      return { sent: false, reason: 'no_recipient' };
    }

    // Plan + door display names from this grant's mappings.
    const mappingIds = (assignments || []).map(a => a.mappingId).filter(Boolean);
    let plans = (assignments || []).map(a => ({ planName: a.planName || null, doorName: null }));
    if (mappingIds.length) {
      const pmRes = await db.query(
        `SELECT plan_name, door_name FROM plan_mappings WHERE id = ANY($1::uuid[])`,
        [mappingIds]
      ).catch(() => ({ rows: [] }));
      if (pmRes.rows.length) plans = pmRes.rows.map(r => ({ planName: r.plan_name, doorName: r.door_name }));
    }

    const planId  = (standardEvent && standardEvent.planId) || (assignments && assignments[0] && assignments[0].sourcePlanId) || 'na';
    const orderId = (assignments && assignments[0] && assignments[0].wixOrderId) || eventKey || 'noorder';

    if (m.sub_master_id) {
      // M3 — sub-member: "{holder} added you to {plan} at {gym}"
      const holderRes = await db.query(
        `SELECT first_name, last_name, display_name FROM member_master WHERE id = $1`,
        [m.sub_master_id]
      ).catch(() => ({ rows: [] }));
      const h = holderRes.rows[0] || {};
      const holderName = [h.first_name, h.last_name].filter(Boolean).join(' ') || h.display_name || 'The plan holder';
      return await sendMemberEmail({
        clientId, memberMasterId: m.member_master_id,
        emailType: 'sub_member_invite',
        dedupKey: `${accessId}:${planId}:${orderId}`,
        recipient: m.email,
        render: templates.renderSubMemberInvite,
        renderArgs: {
          member: { firstName: m.first_name },
          holderName,
          planName: (plans[0] && plans[0].planName) || null,
        },
      });
    }

    return await sendMemberEmail({
      clientId, memberMasterId: m.member_master_id,
      emailType: 'access_ready',
      dedupKey: `${accessId}:${planId}:${orderId}`,
      recipient: m.email,
      render: templates.renderAccessReady,
      renderArgs: { member: { firstName: m.first_name }, plans },
    });
  } catch (err) {
    log.warn('email.member.failed', { clientId, emailType: 'access_ready' }, err);
    return { sent: false, reason: 'exception' };
  }
}

/**
 * M2 recipient capture — MUST run synchronously between completeRevoke and
 * finalizeRevoke: finalize NULLs member PII (DR-044) in the same awaited job,
 * so this is the last moment the address exists. Returns null when the email
 * won't be sent anyway (suppressed) so callers can skip the lookup entirely.
 */
async function captureAccessRemovedContext({ clientId, accessId, standardEvent }) {
  try {
    if (!_revokeEmailAllowed(standardEvent)) return null;
    const memberRes = await db.query(
      `SELECT mm.id AS member_master_id, mm.email, mm.first_name
       FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.id = $1`,
      [accessId]
    );
    const m = memberRes.rows[0];
    if (!m || !m.email) return null;

    let planName = null;
    if (standardEvent && standardEvent.planId) {
      const pmRes = await db.query(
        `SELECT plan_name FROM plan_mappings WHERE source_plan_id = $1 AND client_id = $2 LIMIT 1`,
        [standardEvent.planId, clientId]
      ).catch(() => ({ rows: [] }));
      planName = (pmRes.rows[0] && pmRes.rows[0].plan_name) || null;
    }
    return { memberMasterId: m.member_master_id, email: m.email, firstName: m.first_name, planName };
  } catch (err) {
    log.warn('email.member.failed', { clientId, emailType: 'access_removed', reason: 'capture_failed' }, err);
    return null;
  }
}

/** M2 send — uses the pre-captured context; safe to fire-and-forget. */
async function maybeSendAccessRemovedEmail({ clientId, accessId, standardEvent, context, eventKey }) {
  if (!context) return { sent: false, reason: 'no_context' };
  const planId = (standardEvent && standardEvent.planId) || 'all';
  return sendMemberEmail({
    clientId, memberMasterId: context.memberMasterId,
    emailType: 'access_removed',
    dedupKey: `${accessId}:${planId}:${eventKey || 'noevent'}`,
    recipient: context.email,
    render: templates.renderAccessRemoved,
    renderArgs: { member: { firstName: context.firstName }, planName: context.planName },
  });
}

module.exports = {
  sendMemberEmail,
  maybeSendGrantEmail,
  captureAccessRemovedContext,
  maybeSendAccessRemovedEmail,
};
