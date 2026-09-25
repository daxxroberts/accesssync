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
    : '<span style="font-family:Arial,Helvetica,sans-serif;font-size:22px;font-weight:bold;color:' + _textOn(b.primaryColor) + ';">' + safeGym + '</span>';

  const ctaHtml = (ctaText && ctaUrl)
    ? '<tr><td style="padding:8px 32px 24px 32px;">' +
        '<a href="' + escapeHtml(ctaUrl) + '" target="_blank" ' +
          'style="display:inline-block;background-color:' + b.secondaryColor + ';color:' + _textOn(b.secondaryColor) + ';' +
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
              (safeAdmin ? ' &middot; Questions? Contact <a href="mailto:' + safeAdmin + '" style="color:' + _linkOnWhite(b) + ';">' + safeAdmin + '</a>' : '') +
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

// The five-stage progress labels. Stages 1-4 are always "done" in these emails (they
// only fire once the grant is complete); stage 5, "Get the app", is the member's move.
const STEP_GUIDE_LABELS = ['Order received', 'Account located', 'Access applied', 'Door granted', 'Get the app'];

// The two instructional lists a connector can carry, in display order, with
// empty/null ones dropped. Shared by the HTML and text parts so the two can't
// disagree on which sections exist or what they're called.
function connectorNoteSections(connector) {
  return [
    { title: 'Important requirements', items: connector.requirements || [], callout: true  },
    { title: 'How it works',           items: connector.usageTips    || [], callout: false },
  ].filter(s => s.items.length);
}

// Progress row: four done ticks on the brand color, then the app icon for "Get the app".
function _progressRow(connector, b) {
  const done = _textOn(b.primaryColor);
  const tick = '<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td align="center" valign="middle" style="width:28px;height:28px;border-radius:14px;background-color:' + b.primaryColor + ';font-family:' + DP_FONT + ';font-size:14px;font-weight:bold;line-height:28px;color:' + done + ';">&#10003;</td></tr></table>';
  const app = connector.iconUrl
    ? '<img src="' + escapeHtml(connector.iconUrl) + '" width="28" height="28" alt="" style="display:block;margin:0 auto;border-radius:7px;border:0;">'
    : '<table role="presentation" cellpadding="0" cellspacing="0" align="center"><tr><td align="center" valign="middle" style="width:28px;height:28px;border-radius:14px;background-color:' + b.secondaryColor + ';font-family:' + DP_FONT + ';font-size:14px;font-weight:bold;line-height:28px;color:' + _textOn(b.secondaryColor) + ';">5</td></tr></table>';
  const cells = STEP_GUIDE_LABELS.map((label, i) => {
    const last = i === STEP_GUIDE_LABELS.length - 1;
    return '<td width="20%" align="center" valign="top" style="padding:0 2px;">' + (last ? app : tick) +
      '<div style="font-family:' + DP_FONT + ';font-size:11px;line-height:1.3;padding-top:6px;color:' + (last ? NEUTRAL_TEXT : DP_MUTED) + ';' + (last ? 'font-weight:bold;' : '') + '">' + escapeHtml(label) + '</div>' +
      '</td>';
  }).join('');
  return '<tr><td class="dp-px" style="padding:24px 40px 0 40px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' + cells + '</tr></table></td></tr>';
}

// A bulletproof button: table cell carries the color so Outlook paints it.
function _button(href, label, bg) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:10px;background-color:' + bg + ';">' +
    '<a href="' + escapeHtml(href) + '" target="_blank" style="display:block;padding:14px 12px;font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;color:' + _textOn(bg) + ';text-decoration:none;border-radius:10px;">' + label + '</a>' +
  '</td></tr></table>';
}

/**
 * M1 access-ready and M3 sub-member invite share one body: download the app first,
 * then the three setup steps, the always-on requirements, how it works at the door,
 * and what to check when it doesn't. Only the hero line differs (`introHtml`/`introText`).
 * Same branded frame as the day-pass email (_brandFrame). A stubbed connector (seam)
 * has no links/steps/requirements, so it gets the neutral "check with your gym" card
 * and nothing Kisi-specific.
 */
function _renderAppAccess({ branding, member, plans, hardwarePlatform, eyebrow, heading, introHtml, introText }) {
  const b      = branding;
  const first  = (member && member.firstName) ? member.firstName : null;
  const gym    = b.gymName;
  const list   = (plans || []).filter(p => p && (p.planName || p.doorName));
  const c      = getConnectorBranding(hardwarePlatform);
  const app    = c.displayName;
  const accent = b.secondaryColor;
  const accentText = _textOn(accent);
  const hasLinks = !!(c.iosLink || c.androidLink);

  // ── Download card — the main call to action ──────────────────────────────────
  const buttons = [];
  if (c.iosLink)     buttons.push(_button(c.iosLink, 'Download for iPhone', b.primaryColor));
  if (c.androidLink) buttons.push(_button(c.androidLink, 'Download for Android', b.primaryColor));
  const buttonsRow = buttons.length
    ? '<tr><td align="center" style="padding:18px 20px 0 20px;font-size:0;">' +
        '<!--[if mso]><table role="presentation" width="460" cellpadding="0" cellspacing="0"><tr><td width="220" valign="top"><![endif]-->' +
        buttons.map((btn, i) =>
          (i > 0 ? '<!--[if mso]></td><td width="20"></td><td width="220" valign="top"><![endif]-->' : '') +
          '<div class="dp-stack" style="display:inline-block;width:100%;max-width:220px;vertical-align:top;padding:0 ' + (i === 0 && buttons.length > 1 ? '10px' : '0') + ' 10px ' + (i > 0 ? '10px' : '0') + ';box-sizing:content-box;">' + btn + '</div>'
        ).join('') +
        '<!--[if mso]></td></tr></table><![endif]-->' +
      '</td></tr>'
    : '';
  const icon = c.iconUrl
    ? '<img src="' + escapeHtml(c.iconUrl) + '" width="64" height="64" alt="' + escapeHtml(app) + ' app icon" style="display:block;margin:0 auto;border-radius:15px;border:0;">'
    : '';
  const card =
    '<tr><td class="dp-px" style="padding:24px 40px 0 40px;">' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#fafaf7;border:1px solid ' + DP_LINE + ';border-top:5px solid ' + accent + ';border-radius:16px;border-collapse:separate;">' +
        (hasLinks
          ? '<tr><td align="center" style="padding:26px 24px 0 24px;">' + icon + '</td></tr>' +
            '<tr><td align="center" style="padding:14px 24px 0 24px;font-family:' + DP_FONT + ';">' +
              '<div style="font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:' + DP_MUTED + ';">Step 1 &middot; Do this now</div>' +
              '<div style="font-size:24px;font-weight:bold;line-height:1.25;color:' + NEUTRAL_TEXT + ';padding-top:6px;">Download the ' + escapeHtml(app) + ' app</div>' +
              '<div style="font-size:15px;line-height:1.55;color:' + DP_MUTED + ';padding-top:6px;">It&rsquo;s your key to the door at ' + escapeHtml(gym) + '. Free on iPhone and Android.</div>' +
            '</td></tr>' +
            buttonsRow +
            '<tr><td style="padding:0 0 16px 0;"></td></tr>'
          : '<tr><td align="center" style="padding:22px 24px;font-family:' + DP_FONT + ';font-size:15px;line-height:1.55;color:' + NEUTRAL_TEXT + ';">Check with your gym for the app to use at the door.</td></tr>') +
      '</table>' +
    '</td></tr>';

  // ── Your access ──────────────────────────────────────────────────────────────
  const accessRows = list.length
    ? _dpSectionHeading('Your access', accent) +
      '<tr><td class="dp-px" style="padding:16px 40px 0 40px;">' +
        list.map(p =>
          '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;border:1px solid ' + DP_LINE + ';border-radius:10px;border-collapse:separate;"><tr>' +
            '<td style="padding:12px 16px;font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;color:' + NEUTRAL_TEXT + ';">' + escapeHtml(p.planName || 'Your plan') + '</td>' +
            '<td align="right" style="padding:12px 16px;font-family:' + DP_FONT + ';font-size:14px;color:' + DP_MUTED + ';">' + (p.doorName ? escapeHtml(p.doorName) : '') + '</td>' +
          '</tr></table>'
        ).join('') +
      '</td></tr>'
    : '';

  // ── Setup steps, requirements, how it works, troubleshooting ────────────────
  const steps = Array.isArray(c.setupSteps) ? c.setupSteps : [];
  const stepsRows = steps.length
    ? _dpSectionHeading('Set up in ' + steps.length + ' steps', accent) +
      '<tr><td class="dp-px" style="padding:20px 40px 0 40px;">' +
        steps.map((s, i) => _dpStep(i + 1, escapeHtml(s.title), escapeHtml(s.body), accent, accentText)).join('') +
      '</td></tr>'
    : '';

  // With setup steps shown, the "at the door" list drops the sign-in tip (step 2 covers it).
  const sections = connectorNoteSections(c).map(s =>
    (!s.callout && steps.length && Array.isArray(c.doorTips) && c.doorTips.length) ? { ...s, items: c.doorTips } : s);
  const req = sections.find(s => s.callout);
  const how = sections.find(s => !s.callout);
  const reqRow = req
    ? '<tr><td class="dp-px" style="padding:12px 40px 0 40px;">' +
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background-color:#FFF7E6;border-left:4px solid #D97706;border-radius:0 12px 12px 0;padding:16px 18px;font-family:' + DP_FONT + ';">' +
          '<div style="font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#B45309;">' + req.title + '</div>' +
          '<div style="font-size:16px;font-weight:bold;line-height:1.35;color:' + NEUTRAL_TEXT + ';padding-top:4px;">Keep these on, always</div>' +
          req.items.map(r =>
            '<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:8px;"><tr>' +
              '<td valign="top" style="width:24px;font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;line-height:1.5;color:#B45309;">&#10003;</td>' +
              '<td style="font-family:' + DP_FONT + ';font-size:15px;font-weight:bold;line-height:1.5;color:' + NEUTRAL_TEXT + ';">' + escapeHtml(r) + '</td>' +
            '</tr></table>'
          ).join('') +
          (c.requirementsWhy ? '<div style="font-size:13px;line-height:1.55;color:' + DP_MUTED + ';padding-top:10px;">' + escapeHtml(c.requirementsWhy) + '</div>' : '') +
        '</td></tr></table>' +
      '</td></tr>'
    : '';

  const bullets = (items) => items.map(t =>
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px 0;"><tr>' +
      '<td valign="top" style="width:20px;font-family:' + DP_FONT + ';font-size:14px;line-height:1.55;color:' + NEUTRAL_TEXT + ';">&bull;</td>' +
      '<td style="font-family:' + DP_FONT + ';font-size:14px;line-height:1.55;color:' + DP_MUTED + ';">' + t + '</td>' +
    '</tr></table>'
  ).join('');

  const howRows = how
    ? _dpSectionHeading(how.title + ' at the door', accent) +
      '<tr><td class="dp-px" style="padding:16px 40px 0 40px;">' + bullets(how.items.map(escapeHtml)) + '</td></tr>'
    : '';

  const stuck = 'Still stuck? ' + (b.adminEmail ? 'Reply to this email and the gym will help.' : 'Ask the gym staff for help.');
  const troubleItems = req
    ? ['Check that these are on: ' + req.items.join('; ') + '.',
       'Make sure you&rsquo;re signed in to ' + escapeHtml(app) + ' with the email you used at checkout.',
       stuck]
    : [stuck];
  const troubleRows = _dpSectionHeading('If the door doesn&rsquo;t open', accent) +
    '<tr><td class="dp-px" style="padding:16px 40px 0 40px;">' +
      bullets(troubleItems.map((t, i) => (req && i === 0) ? escapeHtml(t) : t)) +
    '</td></tr>';

  const html = _brandFrame({
    branding: b,
    eyebrow,
    preheader: hasLinks
      ? 'One step left: download the ' + app + ' app and sign in with your checkout email.'
      : 'Your door access at ' + gym + ' is set up.',
    heroHtml:
      '<div class="dp-h1" style="font-size:30px;font-weight:bold;line-height:1.2;color:' + NEUTRAL_TEXT + ';">' + heading(first) + '</div>' +
      '<div style="font-size:16px;line-height:1.6;color:' + DP_MUTED + ';padding-top:10px;">' + introHtml +
        (hasLinks ? ' <strong style="color:' + NEUTRAL_TEXT + ';">One step left: get the ' + escapeHtml(app) + ' app.</strong>' : '') +
      '</div>',
    rows: _progressRow(c, b) + card + accessRows + stepsRows + reqRow + howRows + troubleRows,
  });

  // ── Plain-text part ──────────────────────────────────────────────────────────
  const lines = [
    heading(first).replace(/&rsquo;/g, '\''),
    '',
    introText + (hasLinks ? ' One step left: get the ' + app + ' app.' : ''),
    '',
    STEP_GUIDE_LABELS.join(' > '),
  ];
  if (list.length) {
    lines.push('', 'YOUR ACCESS');
    list.forEach(p => lines.push('  - ' + (p.planName || 'Your plan') + (p.doorName ? ' - ' + p.doorName : '')));
  }
  lines.push('');
  if (hasLinks) {
    lines.push('DOWNLOAD THE ' + app.toUpperCase() + ' APP');
    if (c.iosLink)     lines.push('  iPhone: ' + c.iosLink);
    if (c.androidLink) lines.push('  Android: ' + c.androidLink);
  } else {
    lines.push('Check with your gym for the app to use at the door.');
  }
  if (steps.length) {
    lines.push('', 'SET UP IN ' + steps.length + ' STEPS');
    steps.forEach((s, i) => lines.push('  ' + (i + 1) + '. ' + s.title + ' ' + s.body));
  }
  sections.forEach(s => {
    lines.push('', s.title + ':');
    s.items.forEach(r => lines.push('  - ' + r));
    if (s.callout && c.requirementsWhy) lines.push('  ' + c.requirementsWhy);
  });
  lines.push('', 'IF THE DOOR DOESN\'T OPEN');
  troubleItems.forEach(t => lines.push('  - ' + t.replace(/&rsquo;/g, '\'')));
  lines.push('', '--',
    gym + (b.siteUrl ? ' - ' + b.siteUrl : '') + (b.adminEmail ? ' - Questions? ' + b.adminEmail : ''),
    'Door access - Powered by AccessSync');

  return { html, text: lines.join('\n') };
}

/**
 * M1 — Access ready. Fired when a grant completes (completeGrant post-rollup).
 * plans: [{ planName, doorName }] — one or more plan/door pairs from this grant.
 * hardwarePlatform: connector string ('kisi' | 'seam') — drives the app card, setup
 * steps and requirements (defaults to 'kisi', today's only live connector).
 */
function renderAccessReady({ branding, member, plans, hardwarePlatform }) {
  const gym = branding.gymName;
  const { html, text } = _renderAppAccess({
    branding, member, plans, hardwarePlatform,
    eyebrow:   'Your access is ready',
    heading:   (first) => first ? 'You&rsquo;re in, ' + escapeHtml(first) + '.' : 'You&rsquo;re in.',
    introHtml: 'Your door access at <strong style="color:' + NEUTRAL_TEXT + ';">' + escapeHtml(gym) + '</strong> is set up and ready to use.',
    introText: 'Your door access at ' + gym + ' is set up and ready to use.',
  });
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
 * holder who added them; everything after that (app download, setup steps,
 * requirements, how it works) is the same body M1 gives the holder. There is no
 * separate follow-up email with the real app instructions, so this one has to
 * carry them directly rather than telling the member to watch their inbox.
 */
function renderSubMemberInvite({ branding, member, holderName, plans, hardwarePlatform }) {
  const gym    = branding.gymName;
  const holder = holderName || 'The plan holder';
  const list   = (plans || []).filter(p => p && (p.planName || p.doorName));
  const plan   = (list[0] && list[0].planName) || 'their plan';
  const { html, text } = _renderAppAccess({
    branding, member, plans, hardwarePlatform,
    eyebrow:   'You\u2019ve been added',
    heading:   (first) => first ? 'You&rsquo;ve been added, ' + escapeHtml(first) + '.' : 'You&rsquo;ve been added.',
    introHtml: '<strong style="color:' + NEUTRAL_TEXT + ';">' + escapeHtml(holder) + '</strong> added you to their <strong style="color:' + NEUTRAL_TEXT + ';">' + escapeHtml(plan) + '</strong> plan at <strong style="color:' + NEUTRAL_TEXT + ';">' + escapeHtml(gym) + '</strong>. Your door access is set up and ready to use.',
    introText: holder + ' added you to their ' + plan + ' plan at ' + gym + '. Your door access is set up and ready to use.',
  });
  return { subject: holder + ' added you to ' + plan + ' at ' + gym, html, text };
}

const DP_FONT  = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const DP_MUTED = '#5f6368';
const DP_LINE  = '#e6e6e1';

// WCAG relative luminance of a #rrggbb color.
function _luminance(hex) {
  const c = String(hex).slice(1).match(/../g).map(h => {
    const v = parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

// WCAG contrast ratio between two #rrggbb colors (1..21).
function _contrast(a, b) {
  const [hi, lo] = [_luminance(a), _luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Pick the more readable of near-black / white on `hex`.
function _textOn(hex) {
  const L = _luminance(hex);
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#1a1a1a' : '#ffffff';
}

// Link color on a white body: the gym's accent when it is readable on white (WCAG AA,
// 4.5:1), else its primary, else near-black. A pale accent (HOG's #ffdb29 is 1.4:1 on
// white) stays a background/rule color and never becomes link text.
function _linkOnWhite(branding) {
  const b = branding || {};
  return [b.secondaryColor, b.primaryColor].find(c => isValidHexColor(c) && _contrast(c, '#ffffff') >= 4.5) || '#1a1a1a';
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

/**
 * The branded frame shared by the day-pass (M6) and access-ready (M1/M3) emails: dark
 * band with logo + accent eyebrow, accent rule, hero, body rows, dark footer. `rows`
 * and `heroHtml` are trusted-composed by the caller (every interpolation escaped).
 * The footer always carries "Powered by AccessSync" (deliverability test contract).
 */
function _brandFrame({ branding, eyebrow, preheader, heroHtml, rows }) {
  const b = branding;
  const safeGym  = escapeHtml(b.gymName);
  const dark     = b.primaryColor;
  const darkText = _textOn(dark);
  const accent   = b.secondaryColor;
  // Accent as a text color only where it has contrast against the dark band.
  const onDarkAccent = darkText === '#ffffff' ? accent : darkText;

  const headerInner = b.logoUrl
    ? '<img src="' + escapeHtml(b.logoUrl) + '" alt="' + safeGym + '" height="44" style="display:block;height:44px;max-width:260px;border:0;outline:none;" />'
    : '<span style="font-family:' + DP_FONT + ';font-size:22px;font-weight:bold;color:' + darkText + ';">' + safeGym + '</span>';
  const siteLink = b.siteUrl
    ? ' &middot; <a href="' + escapeHtml(b.siteUrl) + '" target="_blank" style="color:' + darkText + ';text-decoration:underline;">' + escapeHtml(b.siteUrl.replace(/^https:\/\/(www\.)?/, '').replace(/\/$/, '')) + '</a>'
    : '';
  const contact = b.adminEmail
    ? '<br/>Questions? <a href="mailto:' + escapeHtml(b.adminEmail) + '" style="color:' + darkText + ';text-decoration:underline;">' + escapeHtml(b.adminEmail) + '</a>'
    : '';

  return '<!DOCTYPE html>' +
    '<html lang="en"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    '<style>@media (max-width:520px){.dp-px{padding-left:20px!important;padding-right:20px!important}.dp-h1{font-size:26px!important}.dp-reader{max-width:200px!important;padding:4px 0 0 0!important}.dp-stack{max-width:100%!important;padding:0 0 10px 0!important}}</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:#efefeb;">' +
      '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#efefeb;">' + escapeHtml(preheader) + '</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#efefeb;">' +
        '<tr><td align="center" style="padding:24px 10px;">' +
          '<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:14px;overflow:hidden;">' +
            // Dark band + accent rule, as on the QR entry guide PDF
            '<tr><td align="center" style="background-color:' + dark + ';padding:30px 32px 26px 32px;">' +
              headerInner +
              '<div style="font-family:' + DP_FONT + ';font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:' + onDarkAccent + ';padding-top:14px;">' + escapeHtml(eyebrow) + '</div>' +
            '</td></tr>' +
            '<tr><td style="height:6px;line-height:6px;font-size:0;background-color:' + accent + ';">&nbsp;</td></tr>' +
            '<tr><td class="dp-px" style="padding:36px 40px 0 40px;font-family:' + DP_FONT + ';">' + heroHtml + '</td></tr>' +
            rows +
            // Footer band
            '<tr><td style="padding:32px 0 0 0;"></td></tr>' +
            '<tr><td align="center" style="background-color:' + dark + ';padding:22px 32px;font-family:' + DP_FONT + ';font-size:12px;line-height:1.7;color:' + darkText + ';">' +
              '<strong>' + safeGym + '</strong>' + siteLink + contact +
              '<br/><span style="opacity:0.7;">Door access &middot; Powered by AccessSync</span>' +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>';
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

  const html = _brandFrame({
    branding: b,
    eyebrow: 'Day pass',
    preheader: 'Your door code is inside. It works until ' + when + '.',
    heroHtml:
      '<div class="dp-h1" style="font-size:30px;font-weight:bold;line-height:1.2;color:' + NEUTRAL_TEXT + ';">' + (first ? 'You&rsquo;re in, ' + escapeHtml(first) + '.' : 'You&rsquo;re in.') + '</div>' +
      '<div style="font-size:16px;line-height:1.6;color:' + DP_MUTED + ';padding-top:10px;">Your ' + safe.gym + ' day pass is ready. Show the code below at ' + safe.door + '. It works until <strong style="color:' + NEUTRAL_TEXT + ';">' + safe.when + '</strong>, ' + safe.duration + ' from when you bought it.</div>',
    rows:
      card +
      _dpSectionHeading('Three steps at the door', accent) +
      stepsRow +
      _dpSectionHeading('Good to know', accent) +
      '<tr><td class="dp-px" style="padding:18px 40px 0 40px;">' + notes + '</td></tr>' +
      _dpSectionHeading('If the reader doesn&rsquo;t catch it', accent) +
      tipsHtml,
  });

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
  renderAccessReady,
  renderAccessRemoved,
  renderAccessSuspended,
  renderAccessRestored,
  renderSubMemberInvite,
  renderDayPassReady,
};
