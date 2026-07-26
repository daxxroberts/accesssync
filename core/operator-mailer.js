/**
 * core/operator-mailer.js
 * I/O layer for AccessSync's own operator-facing alert emails (DR-020 delivery model).
 *
 * Pairs with core/operator-email-templates.js the same way member-mailer.js pairs with
 * email-templates.js: all Resend/env/logging concerns live here so the templates stay
 * statically testable with no mocks.
 *
 * Six call sites previously duplicated the Resend client construction, the FROM fallback
 * chain, and ad-hoc `[...].join('\n')` bodies. This centralizes all three.
 *
 * The FROM fallback is deliberately unchanged: accesssync.io is not a verified Resend
 * sending domain, so 'onboarding@resend.dev' is the working default. It only delivers to
 * the Resend account's own address — fine here, since these alerts go to the operator.
 */

'use strict';

const { log } = require('./logger');

/**
 * Send one operator alert.
 *
 * @param {string}   toEmail    Recipient. Caller resolves per-client vs owner fallback.
 * @param {Function} render     A render fn from operator-email-templates.js.
 * @param {Object}   renderArgs Passed straight to the render fn.
 * @param {Object}   logContext Extra fields for the structured log line.
 * @returns {Promise<{sent: boolean, reason?: string}>} Never throws.
 */
async function sendOperatorEmail({ toEmail, render, renderArgs, logContext }) {
  const ctx = logContext || {};

  if (!toEmail) {
    log.warn('email.operator.no_recipient', ctx);
    return { sent: false, reason: 'no_recipient' };
  }

  try {
    const { subject, html, text } = render(renderArgs || {});

    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const result = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
      to: toEmail,
      subject,
      html,
      text,
    });

    if (result && result.error) {
      const reason = result.error.message || String(result.error);
      log.error('email.operator.failed', { ...ctx, toEmail, reason });
      return { sent: false, reason };
    }

    log.info('email.operator.sent', { ...ctx, toEmail, resendId: result?.data?.id || null });
    return { sent: true };
  } catch (err) {
    log.error('email.operator.failed', { ...ctx, toEmail }, err);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendOperatorEmail };
