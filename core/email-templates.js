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
 * Copy: GROVE, Humanizer-passed 2026-09-14. Deliberately does NOT reuse the M1
 * step guide or connector usage tips — there is no app and no account. The
 * no-forward callout is what keeps a bearer QR compliant with MEMBER_EMAILS_SPEC
 * §3 (time-boxed only, sharing risk named) — it is not optional.
 *
 *   doorName        plan_mappings.door_name for the mapped group
 *   validUntilText  pre-formatted local time string (caller decides the timezone)
 *   durationLabel   e.g. '24 hours' — derived from the order window by the caller
 *   unlockUrl       Kisi access link (null → no CTA, QR only)
 *   qrSrc           'cid:…' for an inline attachment, an https URL, or null
 */
function renderDayPassReady({ branding, member, doorName, validUntilText, durationLabel, unlockUrl, qrSrc, codes, planName, units, qrGuideAttached }) {
  const first    = (member && member.firstName) ? member.firstName : null;
  const gym      = branding.gymName;
  const door     = doorName || 'the door';
  const when     = validUntilText || 'your pass expires';
  const duration = durationLabel || '24 hours';

  // codes: one per door the product is mapped to. Quantity does NOT add codes — it adds
  // days (Builder rule, 2026-09-23). A single code renders as it did before `codes` existed.
  const allCodes = (Array.isArray(codes) && codes.length ? codes : [{ qrSrc }]).filter(c => c && c.qrSrc);
  const many = allCodes.length > 1;
  const qrHtml = allCodes.map(function (c, i) {
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td align="center">' +
        (many ? '<div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;font-weight:bold;color:' + NEUTRAL_TEXT + ';margin-bottom:8px;">Code ' + (i + 1) + ' of ' + allCodes.length +
          '<span style="font-weight:normal;"> &middot; works until ' + escapeHtml(c.validUntilText || when) + '</span></div>' : '') +
        '<img src="' + escapeHtml(c.qrSrc) + '" width="220" height="220" alt="Your door code' + (many ? ' ' + (i + 1) : '') + '" style="display:block;width:220px;height:220px;border:0;outline:none;" />' +
      '</td></tr></table>';
  }).join('');
  // Quantity > 1 is days in a row from purchase — Wix has no "start date" on a cart item,
  // so the days can't be spread out. Said outright, because a buyer who planned to use
  // them one Saturday at a time finds out at a locked door otherwise.
  const n = Number.isInteger(units) && units > 1 ? units : 1;
  const daysHtml = n > 1
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;"><tr><td style="background-color:#EEF2FF;border-left:3px solid #4F6EF7;border-radius:0 8px 8px 0;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:' + NEUTRAL_TEXT + ';">' +
        '<strong>You bought ' + n + (planName ? ' &times; ' + escapeHtml(planName) : ' passes') + ', so your code works ' + escapeHtml(duration) + ' in a row.</strong> ' +
        'The time started when you bought it and runs straight through. It can&rsquo;t be paused or saved for later.' +
      '</td></tr></table>'
    : '';
  const daysText = n > 1
    ? 'You bought ' + n + (planName ? ' x ' + planName : ' passes') + ', so your code works ' + duration + ' in a row. ' +
      'The time started when you bought it and runs straight through. It can\'t be paused or saved for later.\n\n'
    : '';

  const tapHtml = unlockUrl
    ? ' If the reader doesn&rsquo;t catch it, tap the button below on your phone. The door unlocks from your browser. No app, no account.'
    : ' No app, no account.';
  const tapText = unlockUrl
    ? ' If the reader doesn\'t catch it, tap the link below on your phone. The door unlocks from your browser. No app, no account.'
    : ' No app, no account.';

  // The pass is QR only unless Kisi returned no QR image — don't warn about a link that isn't there.
  const whoCanOpen = unlockUrl ? 'Anyone with the code or the link' : (many ? 'Anyone with one of these codes' : 'Anyone with this code');
  const warnTitle = 'Don&rsquo;t forward this email';
  const warnTitleText = 'Don\'t forward this email.';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">Hi ' + escapeHtml(first || 'there') + ',</p>' +
    '<p style="margin:0 0 12px 0;">You&rsquo;re in at <strong>' + escapeHtml(gym) + '</strong> until <strong>' + escapeHtml(when) + '</strong>. That&rsquo;s ' + escapeHtml(duration) + ' from when you bought it, not the end of the day.</p>' +
    daysHtml +
    qrHtml +
    (allCodes.length
      ? '<p style="margin:0 0 12px 0;font-size:13px;color:' + NEUTRAL_TEXT + ';">' +
          (many ? 'Each code is also attached to this email as its own image, so you can save them to your phone.'
                : 'The code is also attached to this email as an image, so you can save it to your phone.') +
          (qrGuideAttached ? ' First time? The attached <strong>How to get in</strong> PDF shows exactly where to hold your phone.' : '') + '</p>'
      : '') +
    '<p style="margin:0 0 12px 0;">Hold ' + (many ? 'a' : 'this') + ' code up to the reader at ' + escapeHtml(door) + '.' + tapHtml + '</p>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr><td style="background-color:#FFF7E6;border-left:3px solid #D97706;border-radius:0 8px 8px 0;padding:12px 14px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.6;color:' + NEUTRAL_TEXT + ';">' +
      '<strong style="color:#B45309;font-size:11px;letter-spacing:.5px;text-transform:uppercase;">' + warnTitle + '</strong><br/>' +
      whoCanOpen + ' can open the door until your pass expires.' +
    '</td></tr></table>';

  const bodyText =
    'Hi ' + (first || 'there') + ',\n\n' +
    'You\'re in at ' + gym + ' until ' + when + '. That\'s ' + duration + ' from when you bought it, not the end of the day.\n\n' +
    daysText +
    (allCodes.length ? (many ? 'Your door codes are attached to this email as images.' : 'Your door code is attached to this email as an image.') +
      (qrGuideAttached ? ' First time? The attached "How to get in" PDF shows exactly where to hold your phone.' : '') + '\n\n' : '') +
    'Hold ' + (many ? 'a' : 'this') + ' code up to the reader at ' + door + '.' + tapText + '\n\n' +
    warnTitleText + ' ' + whoCanOpen + ' can open the door until your pass expires.';

  const { html, text } = renderLayout({
    branding, heading: 'Your day pass is ready', bodyHtml, bodyText,
    ctaText: unlockUrl ? 'Can’t scan? Tap to unlock' : null,
    ctaUrl:  unlockUrl || null,
  });
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
