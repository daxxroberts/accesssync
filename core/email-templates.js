/**
 * core/email-templates.js — DR-052
 * Pure, zero-I/O render layer for member-facing branded emails.
 *
 * Design (Builder spec 2026-07-05): every gym email is built from exactly three branding
 * inputs — logo, primary color, secondary color — on a white body, with the gym's admin
 * contact in the footer. No other theming knobs. These are the GYM's emails, so fallback
 * colors are neutral (#333), never AccessSync's DR-014 indigo.
 *
 * Every render returns { subject, html, text }. The text part is always generated —
 * multipart with a plain-text alternative is a deliverability requirement, not a nicety.
 *
 * SECURITY: every interpolated value (gym name, member name, plan/door names, emails) runs
 * through escapeHtml. Gym and plan names are operator/Wix-supplied strings — treat as hostile.
 *
 * Pure/I-O split mirrors core/billing-snapshot.js: this file is statically testable with
 * no mocks; all DB/Resend work lives in core/member-mailer.js.
 */

'use strict';

const NEUTRAL_TEXT = '#333333';

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidHexColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Normalize a clients row into the branding object every template consumes.
 * Invalid/missing colors fall back to neutral; missing logo falls back to a
 * gym-name text header. notification_email doubles as the member-facing
 * admin contact (Reply-To + footer) per DR-052.
 */
function brandingFromClientRow(row) {
  const r = row || {};
  return {
    gymName:        r.name || 'Your gym',
    logoUrl:        (typeof r.email_logo_url === 'string' && /^https:\/\//.test(r.email_logo_url)) ? r.email_logo_url : null,
    primaryColor:   isValidHexColor(r.email_primary_color)   ? r.email_primary_color   : NEUTRAL_TEXT,
    secondaryColor: isValidHexColor(r.email_secondary_color) ? r.email_secondary_color : NEUTRAL_TEXT,
    adminEmail:     r.notification_email || null,
  };
}

/**
 * The one shared layout. Table-based, 600px, white body — the only styling that
 * varies per gym is the logo and the two colors (Builder's three-input model).
 * bodyHtml is trusted-composed by the render functions below (which escape all
 * interpolations); callers outside this module must not pass raw user input.
 */
function renderLayout({ branding, heading, bodyHtml, bodyText, ctaText, ctaUrl }) {
  const b = branding;
  const safeGym   = escapeHtml(b.gymName);
  const safeAdmin = b.adminEmail ? escapeHtml(b.adminEmail) : null;

  const headerInner = b.logoUrl
    ? '<img src="' + escapeHtml(b.logoUrl) + '" alt="' + safeGym + '" height="48" style="display:block;height:48px;max-width:280px;border:0;outline:none;" />'
    : '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:#ffffff;">' + safeGym + '</span>';

  const ctaHtml = (ctaText && ctaUrl)
    ? '<tr><td style="padding:8px 32px 24px 32px;">' +
        '<a href="' + escapeHtml(ctaUrl) + '" target="_blank" ' +
          'style="display:inline-block;background-color:' + b.secondaryColor + ';color:#ffffff;' +
          'font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;' +
          'padding:12px 24px;border-radius:6px;">' + escapeHtml(ctaText) + '</a>' +
      '</td></tr>'
    : '';

  const html =
    '<!DOCTYPE html>' +
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>' +
    '<body style="margin:0;padding:0;background-color:#f4f4f4;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;">' +
        '<tr><td align="center" style="padding:24px 12px;">' +
          '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">' +
            // Logo header on the primary-color band
            '<tr><td align="center" style="background-color:' + b.primaryColor + ';padding:24px 32px;">' + headerInner + '</td></tr>' +
            // Heading
            '<tr><td style="padding:32px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:' + NEUTRAL_TEXT + ';">' +
              escapeHtml(heading) +
            '</td></tr>' +
            // Body (composed + escaped by render fns)
            '<tr><td style="padding:8px 32px 24px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:' + NEUTRAL_TEXT + ';">' +
              bodyHtml +
            '</td></tr>' +
            ctaHtml +
            // Footer: gym name · admin contact · powered-by
            '<tr><td style="padding:20px 32px;border-top:1px solid #e8e8e8;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:#888888;">' +
              safeGym +
              (safeAdmin ? ' &middot; Questions? Contact <a href="mailto:' + safeAdmin + '" style="color:' + b.secondaryColor + ';">' + safeAdmin + '</a>' : '') +
              '<br/>Powered by AccessSync' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>';

  const textLines = [
    heading,
    '',
    bodyText,
    (ctaText && ctaUrl) ? '\n' + ctaText + ': ' + ctaUrl : '',
    '',
    '--',
    b.gymName + (b.adminEmail ? ' - Questions? Contact ' + b.adminEmail : ''),
    'Powered by AccessSync',
  ].filter(l => l !== '');

  return { html, text: textLines.join('\n') };
}

/**
 * M1 — Access ready. Fired when a grant completes (completeGrant post-rollup).
 * plans: [{ planName, doorName }] — one or more plan/door pairs from this grant.
 */
function renderAccessReady({ branding, member, plans }) {
  const first  = (member && member.firstName) ? member.firstName : null;
  const gym    = branding.gymName;
  const list   = (plans || []).filter(p => p && (p.planName || p.doorName));

  const planHtml = list.length
    ? '<ul style="margin:8px 0;padding-left:20px;">' +
        list.map(p =>
          '<li>' + escapeHtml(p.planName || 'Your plan') +
          (p.doorName ? ' &mdash; ' + escapeHtml(p.doorName) : '') + '</li>'
        ).join('') +
      '</ul>'
    : '';
  const planText = list.map(p => '  - ' + (p.planName || 'Your plan') + (p.doorName ? ' - ' + p.doorName : '')).join('\n');

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;">Your door access at <strong>' + escapeHtml(gym) + '</strong> is set up and ready to use.</p>' +
    planHtml +
    '<p style="margin:12px 0 0 0;">Use the Kisi app on your phone to tap in at the door.</p>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'Your door access at ' + gym + ' is set up and ready to use.\n' +
    (planText ? '\n' + planText + '\n' : '') +
    '\nUse the Kisi app on your phone to tap in at the door.';

  const { html, text } = renderLayout({ branding, heading: 'Your access is ready', bodyHtml, bodyText });
  return { subject: 'Your access at ' + gym + ' is ready', html, text };
}

/**
 * M2 — Access removed. Fired on true cancellation (targetStatus='inactive'),
 * never on holder self-release / reconcile drift / member.deleted.
 */
function renderAccessRemoved({ branding, member, planName }) {
  const first = (member && member.firstName) ? member.firstName : null;
  const gym   = branding.gymName;
  const plan  = planName || 'membership';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;">Your <strong>' + escapeHtml(plan) + '</strong> plan at <strong>' + escapeHtml(gym) + '</strong> has ended, and the door access that came with it has been turned off.</p>' +
    '<p style="margin:0;">If this is unexpected, please get in touch.</p>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'Your ' + plan + ' plan at ' + gym + ' has ended, and the door access that came with it has been turned off.\n\n' +
    'If this is unexpected, please get in touch.';

  const { html, text } = renderLayout({ branding, heading: 'Your access has ended', bodyHtml, bodyText });
  return { subject: 'Your ' + plan + ' access at ' + gym + ' has ended', html, text };
}

/**
 * M3 — Sub-member invited. Same completeGrant hook as M1 but differentiated copy
 * when the grant originated from a multi-member submit (syntheticSource).
 */
function renderSubMemberInvite({ branding, member, holderName, planName }) {
  const first  = (member && member.firstName) ? member.firstName : null;
  const gym    = branding.gymName;
  const holder = holderName || 'The plan holder';
  const plan   = planName || 'their plan';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;"><strong>' + escapeHtml(holder) + '</strong> added you to their <strong>' + escapeHtml(plan) + '</strong> plan at <strong>' + escapeHtml(gym) + '</strong>.</p>' +
    '<p style="margin:0;">Your door access is being set up now &mdash; watch for the app setup email so you can tap in with your phone.</p>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    holder + ' added you to their ' + plan + ' plan at ' + gym + '.\n\n' +
    'Your door access is being set up now - watch for the app setup email so you can tap in with your phone.';

  const { html, text } = renderLayout({ branding, heading: 'You’ve been added at ' + gym, bodyHtml, bodyText });
  return { subject: holder + ' added you to ' + plan + ' at ' + gym, html, text };
}

module.exports = {
  escapeHtml,
  isValidHexColor,
  brandingFromClientRow,
  renderLayout,
  renderAccessReady,
  renderAccessRemoved,
  renderSubMemberInvite,
};
