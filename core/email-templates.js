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

const { getConnectorBranding } = require('./connector-branding');

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
    // The gym's public site (clients.source_site_url) — footer link. https only.
    siteUrl:        (typeof r.source_site_url === 'string' && /^https:\/\//.test(r.source_site_url)) ? r.source_site_url : null,
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

// 5-stage step guide — email-safe (table-based, inline styles only; no flex/grid,
// which Outlook desktop's Word rendering engine drops). Stages 1-4 always render
// as "done" here (this email only fires once the grant is complete); stage 5
// ("Get the app") is the actionable one and uses the connector's icon/links.
// Null-guards connector.iconUrl/iosLink/androidLink — a stubbed connector (e.g.
// seam) must never render a broken image or a dead download link.
const STEP_GUIDE_LABELS = ['Order received', 'Account located', 'Access applied', 'Door granted', 'Get the app'];

function renderStepGuideTable({ connector, branding }) {
  const doneGlyph =
    '<div style="width:28px;height:28px;margin:0 auto 4px auto;border-radius:50%;background:' + branding.primaryColor + ';' +
    'color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;line-height:28px;text-align:center;">&#10003;</div>';
  const appIconHtml = connector.iconUrl
    ? '<img src="' + escapeHtml(connector.iconUrl) + '" width="28" height="28" alt="" style="display:block;margin:0 auto 4px auto;border-radius:7px;border:0;">'
    : doneGlyph;

  const tds = STEP_GUIDE_LABELS.map((label, i) =>
    '<td width="20%" align="center" style="font-family:Arial,Helvetica,sans-serif;font-size:10px;color:' + branding.secondaryColor + ';padding:4px;">' +
      (i === 4 ? appIconHtml : doneGlyph) + escapeHtml(label) +
    '</td>'
  ).join('');

  const linkParts = [];
  if (connector.iosLink)     linkParts.push('<a href="' + escapeHtml(connector.iosLink) + '" target="_blank" style="color:' + branding.secondaryColor + ';">Download for iPhone</a>');
  if (connector.androidLink) linkParts.push('<a href="' + escapeHtml(connector.androidLink) + '" target="_blank" style="color:' + branding.secondaryColor + ';">Download for Android</a>');
  const linksHtml = linkParts.length
    ? '<p style="margin:8px 0 0 0;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:13px;">' + linkParts.join(' &nbsp;&middot;&nbsp; ') + '</p>'
    : '<p style="margin:8px 0 0 0;text-align:center;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:' + NEUTRAL_TEXT + ';">Check with your gym for the app to use at the door.</p>';

  // Connector-specific on-device notes — setup requirements (e.g. Kisi needs
  // Bluetooth + "Always" location) and how the tap actually works day to day.
  // Null-guarded the same way as iconUrl/iosLink/androidLink above; a stubbed
  // connector (seam) has neither yet, so nothing renders.
  // Requirements render as an amber callout (tinted box + left accent + amber
  // label) so "Important" reads as a block, not a bolded word; how-it-works
  // stays neutral. Inline styles only — Outlook. Mirrors .app-tab-section--callout.
  const notesHtml = connectorNoteSections(connector).map(s => {
    const box   = s.callout
      ? 'background-color:#FFF7E6;border-left:3px solid #D97706;border-radius:0 8px 8px 0;'
      : 'background-color:#f7f7f5;border-radius:8px;';
    const label = s.callout
      ? '<strong style="color:#B45309;font-size:11px;letter-spacing:.5px;text-transform:uppercase;">' + s.title + '</strong>'
      : '<strong>' + s.title + ':</strong>';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr><td style="' + box + 'padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:' + NEUTRAL_TEXT + ';">' +
      label + '<br/>' +
      s.items.map(r => '&bull;&nbsp; ' + escapeHtml(r)).join('<br/>') +
    '</td></tr></table>';
  }).join('');

  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;"><tr>' + tds + '</tr></table>' + linksHtml + notesHtml;
}

function renderStepGuideText({ connector }) {
  const stages = STEP_GUIDE_LABELS.join(' > ');
  const linkLines = [];
  if (connector.iosLink)     linkLines.push('iPhone: ' + connector.iosLink);
  if (connector.androidLink) linkLines.push('Android: ' + connector.androidLink);
  const linksText = linkLines.length ? linkLines.join('\n') : 'Check with your gym for the app to use at the door.';
  const notesText = connectorNoteSections(connector)
    .map(s => '\n\n' + s.title + ':\n' + s.items.map(r => '- ' + r).join('\n'))
    .join('');
  return stages + '\n' + linksText + notesText;
}

// The two instructional lists a connector can carry, in display order, with
// empty/null ones dropped. Shared by the HTML and text step guides so the two
// email parts can't disagree on which sections exist or what they're called.
function connectorNoteSections(connector) {
  return [
    { title: 'Important requirements', items: connector.requirements || [], callout: true  },
    { title: 'How it works',           items: connector.usageTips    || [], callout: false },
  ].filter(s => s.items.length);
}

/**
 * M1 — Access ready. Fired when a grant completes (completeGrant post-rollup).
 * plans: [{ planName, doorName }] — one or more plan/door pairs from this grant.
 * hardwarePlatform: connector string ('kisi' | 'seam') — drives the step guide's
 * app icon/links (defaults to 'kisi', today's only live connector).
 */
function renderAccessReady({ branding, member, plans, hardwarePlatform }) {
  const first  = (member && member.firstName) ? member.firstName : null;
  const gym    = branding.gymName;
  const list   = (plans || []).filter(p => p && (p.planName || p.doorName));
  const connector = getConnectorBranding(hardwarePlatform);

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
    renderStepGuideTable({ connector, branding });

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'Your door access at ' + gym + ' is set up and ready to use.\n' +
    (planText ? '\n' + planText + '\n' : '') +
    '\n' + renderStepGuideText({ connector });

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
 * M4 — Access suspended (payment.failed). Source rows are preserved on suspend
 * (fast recovery once payment clears), unlike M2's true cancellation — copy
 * reflects that this is expected to be temporary, not a plan ending.
 */
function renderAccessSuspended({ branding, member, planName }) {
  const first = (member && member.firstName) ? member.firstName : null;
  const gym   = branding.gymName;
  const plan  = planName || 'membership';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;">We weren&rsquo;t able to process payment for your <strong>' + escapeHtml(plan) + '</strong> plan at <strong>' + escapeHtml(gym) + '</strong>, so your door access has been paused.</p>' +
    '<p style="margin:0;">Update your payment method and your access will turn back on automatically &mdash; no need to sign up again.</p>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'We weren\'t able to process payment for your ' + plan + ' plan at ' + gym + ', so your door access has been paused.\n\n' +
    'Update your payment method and your access will turn back on automatically - no need to sign up again.';

  const { html, text } = renderLayout({ branding, heading: 'Your access is paused', bodyHtml, bodyText });
  return { subject: 'Your ' + plan + ' access at ' + gym + ' is paused', html, text };
}

/**
 * M5 — Access restored (payment.recovered). Mirrors M4 — same suspend/restore
 * pair, opposite direction. No plan/door list needed since nothing changed
 * about what they have access to, only whether it's currently live.
 */
function renderAccessRestored({ branding, member, planName, hardwarePlatform }) {
  const first = (member && member.firstName) ? member.firstName : null;
  const gym   = branding.gymName;
  const plan  = planName || 'membership';
  // App name from the connector registry, never hardcoded — the only member
  // email that still said "Kisi" literally, which would be wrong for a gym on
  // another connector. Same fail-open-to-kisi default as M1.
  const app   = getConnectorBranding(hardwarePlatform).displayName;

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;">Your payment went through &mdash; your <strong>' + escapeHtml(plan) + '</strong> access at <strong>' + escapeHtml(gym) + '</strong> is back on.</p>' +
    '<p style="margin:0;">Use the ' + escapeHtml(app) + ' app on your phone to tap in at the door, same as before.</p>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'Your payment went through - your ' + plan + ' access at ' + gym + ' is back on.\n\n' +
    'Use the ' + app + ' app on your phone to tap in at the door, same as before.';

  const { html, text } = renderLayout({ branding, heading: 'Your access is back', bodyHtml, bodyText });
  return { subject: 'Your ' + plan + ' access at ' + gym + ' is back', html, text };
}

/**
 * M3 — Sub-member invited. Fires on the same completeGrant hook as M1
 * (renderAccessReady) — by the time this sends, the sub-member's own door
 * access is already live, not pending. Differs from M1 only in crediting the
 * holder who added them; everything after that (plan/door list, step guide,
 * app download links, connector requirements) is the same content M1 gives
 * the holder. There is no separate follow-up email with the real app
 * instructions, so this one has to carry them directly rather than telling
 * the member to watch their inbox for another email.
 */
function renderSubMemberInvite({ branding, member, holderName, plans, hardwarePlatform }) {
  const first  = (member && member.firstName) ? member.firstName : null;
  const gym    = branding.gymName;
  const holder = holderName || 'The plan holder';
  const list   = (plans || []).filter(p => p && (p.planName || p.doorName));
  const plan   = (list[0] && list[0].planName) || 'their plan';
  const connector = getConnectorBranding(hardwarePlatform);

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
    '<p style="margin:0 0 12px 0;"><strong>' + escapeHtml(holder) + '</strong> added you to their <strong>' + escapeHtml(plan) + '</strong> plan at <strong>' + escapeHtml(gym) + '</strong> &mdash; your door access is set up and ready to use.</p>' +
    planHtml +
    renderStepGuideTable({ connector, branding });

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    holder + ' added you to their ' + plan + ' plan at ' + gym + ' - your door access is set up and ready to use.\n' +
    (planText ? '\n' + planText + '\n' : '') +
    '\n' + renderStepGuideText({ connector });

  const { html, text } = renderLayout({ branding, heading: 'You’ve been added at ' + gym, bodyHtml, bodyText });
  return { subject: holder + ' added you to ' + plan + ' at ' + gym, html, text };
}

/**
 * M6 — Day pass ready (OB-98 / OB-251). Fires once the Kisi group link exists.
 *
 * Its own layout, not renderLayout: this email IS the credential and the only
 * instructions most buyers will read, so it is built to match the gym's QR entry
 * guide PDF — dark band, accent rule, a ticket-style pass card, the three door
 * steps beside the reader image, "good to know", troubleshooting, dark footer.
 * Still the three-input branding model (logo, primary, secondary): every color
 * below derives from those two, and text on the accent picks black or white by
 * contrast so a pale accent (HOG's yellow) never carries white text.
 *
 * Email-safe: tables + inline styles only. The steps/reader row is a "hybrid"
 * two-column row — inline-block columns that wrap to a stack on a phone with no
 * media query, with an MSO ghost table so Outlook desktop keeps them side by side.
 *
 * Deliberately does NOT reuse the M1 step guide or connector usage tips — there is
 * no app and no account. The keep-it-to-yourself note is what keeps a bearer QR
 * compliant with MEMBER_EMAILS_SPEC §3 (time-boxed only, sharing risk named) — it
 * is not optional.
 *
 *   doorName        plan_mappings.door_name for the mapped group
 *   validUntilText  pre-formatted local time string (caller decides the timezone)
 *   validUntilParts { day, time } — the same moment split for the pass card
 *   durationLabel   e.g. '24 hours' / '2 days' — derived from the order window
 *   unlockUrl       Kisi access link (null → no CTA, QR only)
 *   qrSrc           'cid:…' for an inline attachment, an https URL, or null
 *   codes           [{ qrSrc, unlockUrl, validUntilText }] — one per mapped door
 *   units           quantity bought; > 1 means that many passes back to back
 *   hardwarePlatform  picks the reader image (connector-branding qrReader)
 */
const DP_FONT  = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const DP_MUTED = '#5f6368';
const DP_LINE  = '#e6e6e1';

// WCAG relative luminance → pick the more readable of near-black / white on `hex`.
function _textOn(hex) {
  const c = String(hex).slice(1).match(/../g).map(h => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#1a1a1a' : '#ffffff';
}

// Mix `hex` toward white — a soft background tint of the accent.
function _tint(hex, amount) {
  const rgb = String(hex).slice(1).match(/../g).map(h => parseInt(h, 16));
  return '#' + rgb.map(v => Math.round(v + (255 - v) * amount).toString(16).padStart(2, '0')).join('');
}

function _dpSectionHeading(title, accent) {
  return '<tr><td class="dp-px" style="padding:32px 40px 0 40px;">' +
      '<div style="font-family:' + DP_FONT + ';font-size:19px;font-weight:bold;line-height:1.3;color:' + NEUTRAL_TEXT + ';">' + title + '</div>' +
      '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr><td style="width:44px;height:3px;line-height:3px;font-size:0;background-color:' + accent + ';">&nbsp;</td></tr></table>' +
    '</td></tr>';
}

function _dpStep(n, title, body, accent, accentText) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px 0;"><tr>' +
      '<td valign="top" style="width:44px;padding-top:1px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" valign="middle" style="width:30px;height:30px;border-radius:15px;background-color:' + accent + ';font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;line-height:30px;color:' + accentText + ';">' + n + '</td></tr></table>' +
      '</td>' +
      '<td valign="top" style="font-family:' + DP_FONT + ';">' +
        '<div style="font-size:16px;font-weight:bold;line-height:1.35;color:' + NEUTRAL_TEXT + ';">' + title + '</div>' +
        '<div style="font-size:14px;line-height:1.55;color:' + DP_MUTED + ';padding-top:3px;">' + body + '</div>' +
      '</td>' +
    '</tr></table>';
}

function _dpNote(title, body, accent) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;"><tr>' +
      '<td style="width:4px;background-color:' + accent + ';font-size:0;line-height:0;">&nbsp;</td>' +
      '<td style="padding:2px 0 2px 14px;font-family:' + DP_FONT + ';">' +
        '<div style="font-size:15px;font-weight:bold;line-height:1.4;color:' + NEUTRAL_TEXT + ';">' + title + '</div>' +
        '<div style="font-size:14px;line-height:1.55;color:' + DP_MUTED + ';padding-top:2px;">' + body + '</div>' +
      '</td>' +
    '</tr></table>';
}

function renderDayPassReady({ branding, member, doorName, validUntilText, validUntilParts, durationLabel, unlockUrl, qrSrc, codes, planName, units, hardwarePlatform, qrGuideAttached }) {
  const b        = branding;
  const first    = (member && member.firstName) ? member.firstName : null;
  const gym      = b.gymName;
  const door     = doorName || 'the door';
  const when     = validUntilText || 'your pass expires';
  const duration = durationLabel || '24 hours';
  const n        = Number.isInteger(units) && units > 1 ? units : 1;
  // Same wording as the gym's website rules: "1-Day Pass x2" — quantity, not "2 passes".
  const passName = (planName || 'Day Pass') + (n > 1 ? ' x' + n : '');
  const reader   = getConnectorBranding(hardwarePlatform).qrReader || null;

  const dark       = b.primaryColor;
  const darkText   = _textOn(dark);
  const accent     = b.secondaryColor;
  const accentText = _textOn(accent);
  const accentTint = _tint(accent, 0.82);
  // Accent as a text color only where it has contrast against the dark band.
  const onDarkAccent = _textOn(dark) === '#ffffff' ? accent : darkText;

  // codes: one per door the product is mapped to. Quantity does NOT add codes — it
  // adds days (Builder rule, 2026-09-23).
  const allCodes = (Array.isArray(codes) && codes.length ? codes : [{ qrSrc }]).filter(c => c && c.qrSrc);
  const many = allCodes.length > 1;

  const safe = {
    gym: escapeHtml(gym), door: escapeHtml(door), when: escapeHtml(when),
    duration: escapeHtml(duration), pass: escapeHtml(passName),
    day:  escapeHtml((validUntilParts && validUntilParts.day)  || when),
    time: escapeHtml((validUntilParts && validUntilParts.time) || ''),
  };

  // ── Pass card ────────────────────────────────────────────────────────────────
  const qrBlocks = allCodes.map(function (c, i) {
    return '<tr><td align="center" style="padding:' + (i === 0 ? '28px' : '8px') + ' 24px 8px 24px;">' +
        (many ? '<div style="font-family:' + DP_FONT + ';font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:' + DP_MUTED + ';padding-bottom:10px;">Code ' + (i + 1) + ' of ' + allCodes.length + '</div>' : '') +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding:14px;background-color:#ffffff;border:1px solid ' + DP_LINE + ';border-radius:12px;">' +
          '<img src="' + escapeHtml(c.qrSrc) + '" width="232" height="232" alt="Your door code' + (many ? ' ' + (i + 1) : '') + '" style="display:block;width:232px;height:232px;border:0;outline:none;" />' +
        '</td></tr></table>' +
      '</td></tr>';
  }).join('');

  const noQrBlock = allCodes.length ? '' :
    '<tr><td align="center" style="padding:28px 24px 8px 24px;font-family:' + DP_FONT + ';font-size:15px;line-height:1.55;color:' + NEUTRAL_TEXT + ';">Tap the button below on your phone at ' + safe.door + ' to unlock it.</td></tr>';

  const cta = unlockUrl
    ? '<tr><td align="center" style="padding:8px 24px 4px 24px;">' +
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:10px;background-color:' + accent + ';">' +
          '<a href="' + escapeHtml(unlockUrl) + '" target="_blank" style="display:inline-block;padding:14px 28px;font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;color:' + accentText + ';text-decoration:none;border-radius:10px;">' +
            (allCodes.length ? 'Can&rsquo;t scan? Tap to unlock' : 'Tap to unlock') +
          '</a>' +
        '</td></tr></table>' +
      '</td></tr>'
    : '';

  const statCell = function (label, value, sub, align) {
    return '<td valign="top" width="50%" style="padding:16px 20px 18px 20px;font-family:' + DP_FONT + ';text-align:' + align + ';">' +
        '<div style="font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:' + DP_MUTED + ';">' + label + '</div>' +
        '<div style="font-size:17px;font-weight:bold;line-height:1.35;color:' + NEUTRAL_TEXT + ';padding-top:4px;">' + value + '</div>' +
        (sub ? '<div style="font-size:13px;line-height:1.4;color:' + DP_MUTED + ';">' + sub + '</div>' : '') +
      '</td>';
  };

  const daysStrip = n > 1
    ? '<tr><td style="padding:0 20px 20px 20px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background-color:' + accentTint + ';border-radius:10px;padding:14px 16px;font-family:' + DP_FONT + ';font-size:14px;line-height:1.55;color:' + NEUTRAL_TEXT + ';">' +
          '<strong>' + safe.pass + ' = ' + safe.duration + ' in a row.</strong> Your time started at checkout and runs straight through. It can&rsquo;t be paused or saved for later. Bringing a friend? They buy their own pass and get their own code.' +
        '</td></tr></table>' +
      '</td></tr>'
    : '';

  const card =
    '<tr><td class="dp-px" style="padding:24px 40px 0 40px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf7;border:1px solid ' + DP_LINE + ';border-radius:16px;border-collapse:separate;overflow:hidden;">' +
        // Card header: pass name + door, on the dark brand color
        '<tr><td style="background-color:' + dark + ';border-radius:15px 15px 0 0;padding:14px 20px;font-family:' + DP_FONT + ';">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
            '<td style="font-size:15px;font-weight:bold;color:' + darkText + ';">' + safe.pass + '</td>' +
            '<td align="right" style="font-size:11px;font-weight:bold;letter-spacing:1.2px;text-transform:uppercase;color:' + onDarkAccent + ';">Admit one</td>' +
          '</tr></table>' +
        '</td></tr>' +
        qrBlocks + noQrBlock +
        '<tr><td align="center" style="padding:6px 24px 22px 24px;font-family:' + DP_FONT + ';font-size:14px;color:' + DP_MUTED + ';">' +
          (allCodes.length ? 'Scan at <strong style="color:' + NEUTRAL_TEXT + ';">' + safe.door + '</strong>' : '') +
        '</td></tr>' +
        cta +
        // Perforation — the ticket tear line
        '<tr><td style="padding:0 20px;"><div style="border-top:2px dashed ' + DP_LINE + ';font-size:0;line-height:0;height:0;">&nbsp;</div></td></tr>' +
        '<tr><td style="padding:0;">' +
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
            statCell('Works until', safe.day, safe.time, 'left') +
            statCell('Pass length', safe.duration, 'from checkout', 'right') +
          '</tr></table>' +
        '</td></tr>' +
        daysStrip +
      '</table>' +
    '</td></tr>';

  // ── Three steps beside the reader ────────────────────────────────────────────
  const steps =
    _dpStep(1, 'Open this email at the door.',
      'Turn your screen brightness all the way up. The code is also attached as an image, so you can save it to your photos.',
      accent, accentText) +
    _dpStep(2, 'Hold your phone 4&ndash;8 inches below the reader.',
      'Aim for the spot under the light on the ' + escapeHtml(reader ? reader.name : 'reader') + ' at ' + safe.door + '. Hold it still, screen facing up at the reader.',
      accent, accentText) +
    _dpStep(3, 'Wait for the green flash.',
      'When the reader flashes green, the door is unlocked. Pull it open and you&rsquo;re in.',
      accent, accentText);

  const readerCol = reader
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="background-color:#000000;border-radius:14px;padding:18px 12px 12px 12px;">' +
        '<img src="' + escapeHtml(reader.imageUrl) + '" width="120" height="' + Math.round(120 * reader.height / reader.width) + '" alt="' + escapeHtml(reader.name) + ' with a phone held below it" style="display:block;width:120px;height:auto;border:0;outline:none;" />' +
        '<div style="font-family:' + DP_FONT + ';font-size:11px;line-height:1.4;color:#9aa0a6;padding-top:10px;">' + escapeHtml(reader.name) + (reader.credit ? ' &middot; ' + escapeHtml(reader.credit) : '') + '</div>' +
      '</td></tr></table>'
    : '';

  const stepsRow = reader
    ? '<tr><td class="dp-px" style="padding:20px 40px 0 40px;font-size:0;" align="center">' +
        '<!--[if mso]><table role="presentation" width="520" cellpadding="0" cellspacing="0"><tr><td width="330" valign="top"><![endif]-->' +
        '<div style="display:inline-block;width:100%;max-width:330px;vertical-align:top;text-align:left;">' + steps + '</div>' +
        '<!--[if mso]></td><td width="20"></td><td width="170" valign="top"><![endif]-->' +
        '<div style="display:inline-block;width:100%;max-width:170px;vertical-align:top;padding:0 0 0 20px;box-sizing:border-box;" class="dp-reader">' + readerCol + '</div>' +
        '<!--[if mso]></td></tr></table><![endif]-->' +
      '</td></tr>'
    : '<tr><td class="dp-px" style="padding:20px 40px 0 40px;">' + steps + '</td></tr>';

  // ── Good to know ─────────────────────────────────────────────────────────────
  const notes =
    _dpNote('Your code has an end time.',
      'It stops working at <strong style="color:' + NEUTRAL_TEXT + ';">' + safe.when + '</strong>. A pass starts the moment you buy it, not at your first scan and not at opening time.', accent) +
    _dpNote('Keep this code to yourself.',
      'Anyone holding ' + (many ? 'one of these codes' : 'this code') + ' can open the door until it expires, so don&rsquo;t forward this email or post the image.', accent) +
    (qrGuideAttached ? _dpNote('The guide is attached too.',
      'The <strong style="color:' + NEUTRAL_TEXT + ';">How to get in</strong> PDF has these same steps if you want to save them.', accent) : '');

  const tips = [
    'Brightness all the way up, and hold the phone still, 4&ndash;8 inches below the light.',
    'Move out of direct sun or glare. Wipe the reader if it looks smudged.',
    'Code expired? A new pass sends a fresh code.',
    'Still stuck? ' + (b.adminEmail ? 'Reply to this email and the gym will help.' : 'Ask the gym staff for help.'),
  ];
  const tipsHtml = '<tr><td class="dp-px" style="padding:16px 40px 8px 40px;">' +
    tips.map(t =>
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;"><tr>' +
        '<td valign="top" style="width:20px;font-family:' + DP_FONT + ';font-size:14px;line-height:1.55;color:' + NEUTRAL_TEXT + ';">&bull;</td>' +
        '<td style="font-family:' + DP_FONT + ';font-size:14px;line-height:1.55;color:' + DP_MUTED + ';">' + t + '</td>' +
      '</tr></table>'
    ).join('') +
    '</td></tr>';

  // ── Frame ────────────────────────────────────────────────────────────────────
  const headerInner = b.logoUrl
    ? '<img src="' + escapeHtml(b.logoUrl) + '" alt="' + safe.gym + '" height="44" style="display:block;height:44px;max-width:260px;border:0;outline:none;" />'
    : '<span style="font-family:' + DP_FONT + ';font-size:22px;font-weight:bold;color:' + darkText + ';">' + safe.gym + '</span>';

  const siteLink = b.siteUrl
    ? ' &middot; <a href="' + escapeHtml(b.siteUrl) + '" target="_blank" style="color:' + darkText + ';text-decoration:underline;">' + escapeHtml(b.siteUrl.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>'
    : '';
  const contact = b.adminEmail
    ? '<br/>Questions? <a href="mailto:' + escapeHtml(b.adminEmail) + '" style="color:' + darkText + ';text-decoration:underline;">' + escapeHtml(b.adminEmail) + '</a>'
    : '';

  const preheader = 'Your door code is inside. It works until ' + when + '.';

  const html =
    '<!DOCTYPE html>' +
    '<html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<style>@media (max-width:520px){.dp-px{padding-left:20px!important;padding-right:20px!important}.dp-h1{font-size:26px!important}.dp-reader{max-width:200px!important;padding:4px 0 0 0!important}}</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:#efefeb;">' +
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#efefeb;">' + escapeHtml(preheader) + '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#efefeb;">' +
        '<tr><td align="center" style="padding:24px 10px;">' +
          '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;">' +
            // Dark band + accent rule, as on the PDF
            '<tr><td align="center" style="background-color:' + dark + ';padding:30px 32px 26px 32px;">' +
              headerInner +
              '<div style="font-family:' + DP_FONT + ';font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:' + onDarkAccent + ';padding-top:14px;">Day pass</div>' +
            '</td></tr>' +
            '<tr><td style="height:6px;line-height:6px;font-size:0;background-color:' + accent + ';">&nbsp;</td></tr>' +
            // Hero
            '<tr><td class="dp-px" style="padding:36px 40px 0 40px;font-family:' + DP_FONT + ';">' +
              '<div class="dp-h1" style="font-size:30px;font-weight:bold;line-height:1.2;color:' + NEUTRAL_TEXT + ';">' + (first ? 'You&rsquo;re in, ' + escapeHtml(first) + '.' : 'You&rsquo;re in.') + '</div>' +
              '<div style="font-size:16px;line-height:1.6;color:' + DP_MUTED + ';padding-top:10px;">Your ' + safe.gym + ' day pass is ready. Show the code below at ' + safe.door + '. It works until <strong style="color:' + NEUTRAL_TEXT + ';">' + safe.when + '</strong>, ' + safe.duration + ' from when you bought it.</div>' +
            '</td></tr>' +
            card +
            _dpSectionHeading('Three steps at the door', accent) +
            stepsRow +
            _dpSectionHeading('Good to know', accent) +
            '<tr><td class="dp-px" style="padding:18px 40px 0 40px;">' + notes + '</td></tr>' +
            _dpSectionHeading('If the reader doesn&rsquo;t catch it', accent) +
            tipsHtml +
            // Footer band
            '<tr><td style="padding:32px 0 0 0;"></td></tr>' +
            '<tr><td align="center" style="background-color:' + dark + ';padding:22px 32px;font-family:' + DP_FONT + ';font-size:12px;line-height:1.7;color:' + darkText + ';">' +
              '<strong>' + safe.gym + '</strong>' + siteLink + contact +
              '<br/><span style="opacity:0.7;">Door access powered by AccessSync</span>' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>';

  const text = [
    (first ? 'You\'re in, ' + first + '.' : 'You\'re in.'),
    '',
    'Your ' + gym + ' day pass is ready. Show the code at ' + door + '. It works until ' + when + ', ' + duration + ' from when you bought it.',
    '',
    'YOUR PASS',
    '  ' + passName,
    '  Works until: ' + when,
    '  Pass length: ' + duration + ' from checkout',
    (allCodes.length
      ? '  Your door code' + (many ? 's are' : ' is') + ' attached to this email as ' + (many ? 'images' : 'an image') + '.'
      : '  Unlock link: ' + (unlockUrl || '')),
    n > 1 ? '\n' + passName + ' = ' + duration + ' in a row. Your time started at checkout and runs straight through. It can\'t be paused or saved for later. Bringing a friend? They buy their own pass and get their own code.' : '',
    '',
    'THREE STEPS AT THE DOOR',
    '  1. Open this email at the door. Turn your screen brightness all the way up.',
    '  2. Hold your phone 4-8 inches below the reader' + (reader ? ' (' + reader.name + ')' : '') + ' at ' + door + '.',
    '  3. Wait for the green flash. The door is unlocked. Pull it open and you\'re in.',
    '',
    'GOOD TO KNOW',
    '  - Your code stops working at ' + when + '. A pass starts the moment you buy it.',
    '  - Don\'t forward this email. Anyone holding the code can open the door until it expires.',
    qrGuideAttached ? '  - The attached "How to get in" PDF has these same steps.' : '',
    '',
    'IF THE READER DOESN\'T CATCH IT',
    '  - Brightness all the way up; hold the phone still, 4-8 inches below the light.',
    '  - Move out of direct sun or glare. Wipe the reader if it looks smudged.',
    '  - Code expired? A new pass sends a fresh code.',
    '  - Still stuck? ' + (b.adminEmail ? 'Reply to this email and the gym will help.' : 'Ask the gym staff for help.'),
    '',
    '--',
    gym + (b.siteUrl ? ' - ' + b.siteUrl : '') + (b.adminEmail ? ' - Questions? ' + b.adminEmail : ''),
    'Door access powered by AccessSync',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i > 0)).join('\n');

  return { subject: 'Your ' + gym + ' day pass is ready', html, text };
}

module.exports = {
  escapeHtml,
  isValidHexColor,
  brandingFromClientRow,
  renderLayout,
  renderStepGuideTable,
  renderStepGuideText,
  renderAccessReady,
  renderAccessRemoved,
  renderAccessSuspended,
  renderAccessRestored,
  renderSubMemberInvite,
  renderDayPassReady,
};
