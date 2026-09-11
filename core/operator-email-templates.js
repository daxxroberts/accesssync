/**
 * core/operator-email-templates.js
 * Pure, zero-I/O render layer for AccessSync's OWN operator-facing alert emails.
 *
 * Distinct from core/email-templates.js (DR-052), which renders GYM-branded emails to
 * members using each client's three branding inputs. These are AccessSync-to-operator
 * alerts, so branding is fixed to AccessSync's own DR-014 identity and takes no
 * per-client inputs.
 *
 * Builder complaint that drove this (2026-07-25): the old plain-text alerts were
 * "not in any way branded", "very coded and very code-driven", arrived "every morning",
 * and left no clear "action items ... as the House of Gains admin". So every template
 * here obeys three rules:
 *   1. Plain English only. No column names, raw IDs, ISO timestamps, or `null` in the body.
 *   2. An explicit action verdict — "Action needed" or "No action needed" — at the top.
 *   3. A real clickable link to the exact Admin Hub page that fixes it, never prose
 *      navigation instructions ("log in → System Config → ...").
 *
 * Every render returns { subject, html, text }. The text part is always generated —
 * multipart with a plain-text alternative is a deliverability requirement.
 *
 * SECURITY: every interpolated value runs through escapeHtml. Location, plan, and door
 * names originate from Wix/Kisi — treat as hostile.
 */

'use strict';

// DR-014 — AccessSync's own palette. Non-interchangeable with any gym's colors.
const BRAND       = '#4F6EF7'; // indigo
const BRAND_DARK  = '#3D5BD4';
const SAGE        = '#22C55E';
const RED         = '#FF4D6A';
const TEXT        = '#333333';
const MUTED       = '#888888';

const ADMIN_HUB_FALLBACK = 'https://accesssync-admin.up.railway.app';

/** Admin Hub base for deep links. Env override mirrors the CORE_ENGINE_URL pattern. */
function adminHubUrl() {
  const raw = process.env.ADMIN_HUB_URL;
  if (typeof raw === 'string' && /^https?:\/\//.test(raw)) return raw.replace(/\/+$/, '');
  return ADMIN_HUB_FALLBACK;
}

/**
 * Admin Hub deep link. Every operator page under /admin (plan-mapping, locations,
 * errors) reads clientId client-side via URLSearchParams — without it an owner
 * session (which carries no default client scope, unlike a scoped operator session)
 * has nothing to render against and the page falls back to the owner hub. Omit
 * clientId only for genuinely cross-tenant destinations (nightly digest, HMAC spike
 * when no tenant could be resolved).
 */
function hubLink(path, clientId) {
  const base = adminHubUrl() + path;
  if (!clientId) return base;
  const sep = path.includes('?') ? '&' : '?';
  return base + sep + 'clientId=' + encodeURIComponent(clientId);
}

function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "1 member" / "3 members" — "member(s)" reads like a form field, not a sentence. */
function members(n) {
  const count = Number(n) || 0;
  return count + (count === 1 ? ' member' : ' members');
}

/** "July 25, 2026" — never a raw ISO string in operator-facing copy. */
function humanDate(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * The one shared layout. Indigo header band, white body, action verdict chip, single CTA.
 * bodyHtml is composed by the render functions below (which escape all interpolations);
 * callers outside this module must not pass raw user input.
 */
function renderLayout({ heading, bodyHtml, bodyText, actionNeeded, ctaText, ctaUrl, footerNote }) {
  const chipColor = actionNeeded ? RED : SAGE;
  const chipLabel = actionNeeded ? 'Action needed' : 'No action needed';

  const ctaHtml = (ctaText && ctaUrl)
    ? '<tr><td style="padding:8px 32px 28px 32px;">' +
        '<a href="' + escapeHtml(ctaUrl) + '" target="_blank" ' +
          'style="display:inline-block;background-color:' + BRAND + ';color:#ffffff;' +
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
            '<tr><td style="background:linear-gradient(90deg,' + BRAND + ',' + BRAND_DARK + ');background-color:' + BRAND + ';padding:22px 32px;">' +
              '<span style="font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:#ffffff;letter-spacing:0.2px;">AccessSync</span>' +
            '</td></tr>' +
            '<tr><td style="padding:26px 32px 0 32px;">' +
              '<span style="display:inline-block;background-color:' + chipColor + ';color:#ffffff;' +
                'font-family:Arial,Helvetica,sans-serif;font-size:11px;font-weight:bold;text-transform:uppercase;' +
                'letter-spacing:0.6px;padding:5px 10px;border-radius:12px;">' + chipLabel + '</span>' +
            '</td></tr>' +
            '<tr><td style="padding:14px 32px 8px 32px;font-family:Arial,Helvetica,sans-serif;font-size:20px;font-weight:bold;color:' + TEXT + ';">' +
              escapeHtml(heading) +
            '</td></tr>' +
            '<tr><td style="padding:8px 32px 24px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:' + TEXT + ';">' +
              bodyHtml +
            '</td></tr>' +
            ctaHtml +
            '<tr><td style="padding:20px 32px;border-top:1px solid #e8e8e8;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:1.6;color:' + MUTED + ';">' +
              (footerNote ? escapeHtml(footerNote) + '<br/>' : '') +
              'Sent by AccessSync on ' + escapeHtml(humanDate(new Date())) +
            '</td></tr>' +
          '</table>' +
        '</td></tr>' +
      '</table>' +
    '</body></html>';

  const textLines = [
    chipLabel.toUpperCase(),
    '',
    heading,
    '',
    bodyText,
    (ctaText && ctaUrl) ? '\n' + ctaText + ': ' + ctaUrl : '',
    '',
    '--',
    footerNote || '',
    'Sent by AccessSync on ' + humanDate(new Date()),
  ].filter(l => l !== '');

  return { html, text: textLines.join('\n') };
}

/* ------------------------------------------------------------------ *
 * O1 — Hardware key failure (core/hardware-health-check.js)
 * ------------------------------------------------------------------ */

function renderHardwareKeyAlert({ locationName, clientName, platform, diagnosis, errorType, clientId }) {
  const loc  = locationName || 'your location';
  const plat = platform || 'your access hardware';

  const headline = errorType === 'no_key'
    ? 'AccessSync doesn’t have an access key for ' + loc
    : 'AccessSync can’t connect to ' + plat + ' at ' + loc;

  const whereLine = clientName
    ? 'This affects ' + loc + ' (' + clientName + ').'
    : 'This affects ' + loc + '.';

  const consequence = 'Members who already have access keep it. New signups won’t get their door access until this is fixed.';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">' + escapeHtml(whereLine) + '</p>' +
    '<p style="margin:0 0 12px 0;">' + escapeHtml(diagnosis || 'AccessSync could not verify the access key for this location.') + '</p>' +
    '<p style="margin:0;">' + escapeHtml(consequence) + '</p>';

  const bodyText =
    whereLine + '\n\n' +
    (diagnosis || 'AccessSync could not verify the access key for this location.') + '\n\n' +
    consequence;

  const { html, text } = renderLayout({
    heading: headline,
    bodyHtml,
    bodyText,
    actionNeeded: true,
    ctaText: 'Update your access key',
    ctaUrl: hubLink('/locations', clientId),
  });

  const subject = errorType === 'no_key'
    ? '[AccessSync] ' + loc + ' has no access key set'
    : '[AccessSync] Action needed: access key problem at ' + loc;

  return { subject, html, text };
}

/* ------------------------------------------------------------------ *
 * O2 — Orphaned hardware groups (core/hardware-health-check.js)
 * ------------------------------------------------------------------ */

function renderOrphanedGroupsAlert({ locationName, clientName, platform, groups, clientId }) {
  const loc  = locationName || 'your location';
  const plat = platform || 'your access system';
  const list = Array.isArray(groups) ? groups : [];
  const totalAffected = list.reduce((sum, g) => sum + (Number(g.affectedMembers) || 0), 0);

  const itemsHtml = list.map(g => {
    const label = escapeHtml(g.planName || 'An unnamed plan');
    const note  = (Number(g.affectedMembers) || 0) > 0
      ? ' &mdash; ' + escapeHtml(members(g.affectedMembers)) + ' may have lost access'
      : ' &mdash; no members are affected';
    return '<li style="margin-bottom:4px;">' + label + note + '</li>';
  }).join('');

  const itemsText = list.map(g => {
    const note = (Number(g.affectedMembers) || 0) > 0
      ? ' - ' + members(g.affectedMembers) + ' may have lost access'
      : ' - no members are affected';
    return '  • ' + (g.planName || 'An unnamed plan') + note;
  }).join('\n');

  const intro = list.length === 1
    ? 'A door group at ' + loc + ' is set up in AccessSync but no longer exists in ' + plat + '.'
    : list.length + ' door groups at ' + loc + ' are set up in AccessSync but no longer exist in ' + plat + '.';

  const closing = totalAffected > 0
    ? 'Remap these plans to a door group that still exists so those members get their access back. Everything else on those plans keeps working normally.'
    : 'No members are affected right now, but new signups on these plans won’t get door access until you remap them.';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">' + escapeHtml(intro) + '</p>' +
    (itemsHtml ? '<ul style="margin:8px 0 12px 0;padding-left:20px;">' + itemsHtml + '</ul>' : '') +
    '<p style="margin:0;">' + escapeHtml(closing) + '</p>';

  const bodyText = intro + '\n\n' + (itemsText ? itemsText + '\n\n' : '') + closing;

  const { html, text } = renderLayout({
    heading: list.length === 1 ? 'A door group is missing' : list.length + ' door groups are missing',
    bodyHtml,
    bodyText,
    actionNeeded: true,
    ctaText: 'Fix your plan mapping',
    ctaUrl: hubLink('/plan-mapping', clientId),
    footerNote: clientName ? 'Location: ' + loc + ' (' + clientName + ')' : 'Location: ' + loc,
  });

  const subject = list.length === 1
    ? '[AccessSync] Action needed: a door group is missing at ' + loc
    : '[AccessSync] Action needed: ' + list.length + ' door groups are missing at ' + loc;

  return { subject, html, text };
}

/* ------------------------------------------------------------------ *
 * O3 — Archived source plans (core/hardware-health-check.js)
 * Informational by design — the Builder confirmed this one already reads fine.
 * ------------------------------------------------------------------ */

function renderArchivedPlansAlert({ locationName, clientName, plans, clientId }) {
  const loc  = locationName || 'your location';
  const list = Array.isArray(plans) ? plans : [];

  const itemsHtml = list.map(p => {
    const label = escapeHtml(p.planName || 'An unnamed plan');
    const note  = (Number(p.affectedMembers) || 0) > 0
      ? ' &mdash; ' + escapeHtml(members(p.affectedMembers)) + ' still have access'
      : ' &mdash; nobody is on this plan';
    return '<li style="margin-bottom:4px;">' + label + note + '</li>';
  }).join('');

  const itemsText = list.map(p => {
    const note = (Number(p.affectedMembers) || 0) > 0
      ? ' - ' + members(p.affectedMembers) + ' still have access'
      : ' - nobody is on this plan';
    return '  • ' + (p.planName || 'An unnamed plan') + note;
  }).join('\n');

  const intro = (list.length === 1 ? 'A plan' : list.length + ' plans')
    + ' you sell on Wix ' + (list.length === 1 ? 'was' : 'were') + ' archived.';
  const closing = 'Nothing breaks. Anyone already on ' + (list.length === 1 ? 'it' : 'them')
    + ' keeps their door access until their billing ends on its own. You only need to do something if you want to move those members onto a different plan.';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">' + escapeHtml(intro) + '</p>' +
    (itemsHtml ? '<ul style="margin:8px 0 12px 0;padding-left:20px;">' + itemsHtml + '</ul>' : '') +
    '<p style="margin:0;">' + escapeHtml(closing) + '</p>';

  const bodyText = intro + '\n\n' + (itemsText ? itemsText + '\n\n' : '') + closing;

  const { html, text } = renderLayout({
    heading: 'Heads up: archived plans',
    bodyHtml,
    bodyText,
    actionNeeded: false,
    ctaText: 'View your plans',
    ctaUrl: hubLink('/plan-mapping', clientId),
    footerNote: clientName ? 'Location: ' + loc + ' (' + clientName + ')' : 'Location: ' + loc,
  });

  const subject = list.length === 1
    ? '[AccessSync] A plan was archived on Wix'
    : '[AccessSync] ' + list.length + ' plans were archived on Wix';

  return { subject, html, text };
}

/* ------------------------------------------------------------------ *
 * O4 — Blocked suspicious traffic (core/hmac-monitor.js)
 * Audience split: the operator gets the reassurance + escalation path; the
 * technical detail (source, counts, signatures) stays in diagnostic_log.
 * ------------------------------------------------------------------ */

function renderHmacAlert({ clientId } = {}) {
  const bodyHtml =
    '<p style="margin:0 0 12px 0;">AccessSync caught and blocked some suspicious traffic aimed at your account. Nothing got through, and no member access was affected.</p>' +
    '<p style="margin:0;">You don’t need to do anything. If you keep getting this email over the next few days, reply to it and we’ll look into where it’s coming from.</p>';

  const bodyText =
    'AccessSync caught and blocked some suspicious traffic aimed at your account. Nothing got through, and no member access was affected.\n\n' +
    'You don’t need to do anything. If you keep getting this email over the next few days, reply to it and we’ll look into where it’s coming from.';

  const { html, text } = renderLayout({
    heading: 'We blocked some suspicious traffic',
    bodyHtml,
    bodyText,
    actionNeeded: false,
    ctaText: 'View your activity log',
    ctaUrl: hubLink('/errors', clientId),
  });

  return { subject: '[AccessSync] We blocked some suspicious traffic', html, text };
}

/* ------------------------------------------------------------------ *
 * O5 — A single member's access failed (core/retry-engine.js)
 * ------------------------------------------------------------------ */

function renderMemberFailureAlert({ userMessage, actionText, memberName, planName, clientId }) {
  const who  = memberName || 'A member';
  const plan = planName ? ' on ' + planName : '';

  const lead = userMessage || (who + ' didn’t get their door access' + plan + '.');
  const what = actionText || 'Open your dashboard to retry this, or dismiss it if it’s already sorted out.';

  const bodyHtml =
    '<p style="margin:0 0 12px 0;">' + escapeHtml(lead) + '</p>' +
    '<p style="margin:0;">' + escapeHtml(what) + '</p>';

  const bodyText = lead + '\n\n' + what;

  const { html, text } = renderLayout({
    heading: who + ' didn’t get access',
    bodyHtml,
    bodyText,
    actionNeeded: true,
    ctaText: 'Retry or dismiss',
    ctaUrl: hubLink('/errors', clientId),
  });

  return { subject: '[AccessSync] Action needed: ' + who + ' didn’t get access', html, text };
}

/* ------------------------------------------------------------------ *
 * O6 — Nightly digest (core/reconciliation.js)
 *
 * The worst offender in the old design: it dumped raw column values, including
 * literal "null" for rows with no event_type or member. Both maps below fall back
 * loudly-but-readably rather than printing raw values into the operator's inbox.
 * ------------------------------------------------------------------ */

/**
 * Plain-English sentence per config_alert_log.alert_type.
 * Covers every value written anywhere in the codebase; anything new falls through
 * to a generic sentence that names the raw type so the gap is visible, not hidden.
 */
function describeConfigAlert(row) {
  const r        = row || {};
  const location = r.locationName || 'one of your locations';
  const door     = r.doorName || 'A door group';
  const platform = r.platform || 'your access system';
  const affected = Number(r.affectedMembers) || 0;
  const memberNote = affected > 0 ? ' ' + members(affected) + ' may have lost access.' : '';

  // Removal-safety alerts (reconciliation sweep + finalize guards). These NEVER
  // read r.doorName: for these types config_alert_log.hardware_ref carries machine
  // detail (counts like "proposed=12", Kisi user ids), not a door name. Each one
  // says whether anyone lost access and what, if anything, to do.
  // r.memberName is optional — the nightly digest does not pass one today, so
  // every sentence reads naturally without it.
  const person     = r.memberName || null;
  const whoStart   = person || 'A member';                    // sentence start
  const possessive = person ? person + '’s' : 'a member’s';
  const hardware   = r.platform || 'Kisi';
  const pausedNote = 'Automatic removal is paused while AccessSync’s safety checks roll out, '
    + 'so nothing was removed and they can still get in.';

  // Only alert types some code actually writes are cataloged here. The v2 gate's
  // aliases (revoke_batch_would_revoke_all, revoke_revalidation_failed,
  // revoke_mass_revoke, revoke_snapshot_unstable, revoke_auto_revoke_*,
  // revoke_dry_run, revoke_observation_only, revoke_strike_pending) were removed
  // 2026-09-10: nothing writes them (core/reconciliation.js maps each anomaly
  // hold to one of the three types below and raises no alert for mode or
  // observation-only holds), and none ever shipped. A stray one still gets the
  // readable generic sentence from `default`.
  switch (r.alert_type) {
    case 'revoke_batch_mass_revoke':
      return 'AccessSync was about to remove door access for an unusually large number of members at '
        + location + ' at once, so it stopped and removed no one. Nobody lost access. '
        + 'Check that your plans and memberships in Wix look right — if they do, reply to this email and we’ll look into it.';
    case 'wix_snapshot_anomaly':
      return 'Wix gave AccessSync membership numbers for ' + location
        + ' that didn’t add up, so AccessSync paused removals rather than guess. Nobody lost access. '
        + 'No action needed — AccessSync checks again on the next sync.';
    case 'revoke_invalid_proposal':
      return 'AccessSync ran into an internal problem while checking memberships at ' + location
        + ' and stopped before changing anything. Nobody lost access. '
        + 'No action needed on your side — AccessSync tries again on the next sync.';
    case 'finalize_refused_other_assignments':
      return 'AccessSync didn’t delete ' + possessive + ' ' + hardware + ' account because they still have door access at '
        + location + ' that wasn’t added by AccessSync — nothing was removed. '
        + 'If they shouldn’t have that access anymore, remove it in ' + hardware + '.';
    case 'finalize_refused_shared_user':
      return 'AccessSync didn’t delete ' + possessive + ' ' + hardware + ' account because another member at '
        + location + ' uses the same ' + hardware + ' account — nothing was removed. '
        + 'Check in ' + hardware + ' that each person has their own account.';
    case 'sweep_repair_pending':
      return (person
        ? person + ' is a paying member, but their door access at ' + location + ' is missing in ' + hardware + '. '
        : 'A paying member’s door access at ' + location + ' is missing in ' + hardware + '. ')
        + 'AccessSync will restore it once automatic repair is switched on; until then you can re-add it in ' + hardware + '.';
    case 'sweep_removal_pending':
      return whoStart + ' at ' + location + ' no longer shows as paying in Wix. ' + pausedNote + ' '
        + 'Check their membership in Wix — if they really have stopped paying and shouldn’t get in, you can remove their access in '
        + hardware + '.';
    case 'revoke_holder_lapse_pending':
      return whoStart + ' at ' + location + ' is on a shared plan whose main member no longer shows as paying in Wix. '
        + pausedNote + ' Check the main member’s plan in Wix — if it has really ended, you can remove '
        + (person ? possessive : 'their') + ' access in ' + hardware + '.';
    case 'revoke_held_payment_state':
      return (person ? possessive + ' Wix payment' : 'A member’s Wix payment') + ' at ' + location
        + ' is declined, pending or unrecognized — AccessSync is leaving their door access alone. Nobody lost access. '
        + 'Check the payment in Wix — if it doesn’t go through and they shouldn’t get in, you can remove their access in '
        + hardware + '.';

    // A sync couldn't read the door system, so it stopped before changing
    // anything (reconciliation aborts the client's sync). hardware_ref carries
    // "status=… code=…" — never shown.
    case 'kisi_api_unavailable':
      return 'AccessSync couldn’t reach Kisi for ' + location
        + ' during a sync — it stopped and changed nothing. Nobody lost access. '
        + 'This usually clears up on its own; AccessSync tries again on the next sync.';
    case 'hardware_api_unavailable':
      return 'AccessSync couldn’t reach ' + platform + ' for ' + location
        + ' during a sync — it stopped and changed nothing. Nobody lost access. '
        + 'This usually clears up on its own; AccessSync tries again on the next sync.';

    case 'group_not_found':
    case 'missing_group':
      return door + ' at ' + location + ' is no longer in ' + platform + '.' + memberNote;
    case 'api_key_invalid_after_rotation':
      return 'The access key for ' + location + ' stopped working after it was changed.';
    case 'wix_api_unavailable':
      return 'AccessSync couldn’t reach Wix for ' + location + ' during a sync. This usually clears up on its own.';
    case 'lockdown_detected':
      return 'A door at ' + location + ' was in lockdown, so AccessSync skipped it instead of forcing a change.';
    case 'untraceable_hardware_access':
      return 'Someone has door access at ' + location + ' that AccessSync didn’t set up. It was left alone — worth a look if that’s unexpected.';
    case 'member_deleted_review':
      return 'A member was deleted at ' + location + ' and is worth a quick review.';
    case 'notification_delivery_failed':
      return 'AccessSync tried to email you about something and the email didn’t go through.';
    case 'system':
      return 'AccessSync logged an internal issue at ' + location + '.';
    case 'unknown':
      return 'AccessSync logged an issue at ' + location + ' it couldn’t categorize.';
    default:
      return 'AccessSync logged an issue at ' + location
        + (r.alert_type ? ' (' + r.alert_type + ')' : '') + '.';
  }
}

/**
 * Plain-English sentence per failed error_queue row.
 * Prefers the user_message/action_text already written at throw time; only falls
 * back to an event_type map when those are null. A null event_type (real case —
 * QUEUE_JOB_MISSING_TRACE_ID rows carry none) must never render as "[null] member: null".
 */
function describeFailedJob(row) {
  const r    = row || {};
  const who  = r.memberName || null;
  const plan = r.plan_name || null;

  if (r.user_message) {
    return r.user_message + (r.action_text ? ' ' + r.action_text : '');
  }

  const subject = who || 'A member';
  const onPlan  = plan ? ' on ' + plan : '';

  switch (r.event_type) {
    case 'plan.purchased':
    case 'booking.confirmed':
      return subject + ' bought a plan' + onPlan + ' but their door access didn’t get set up.';
    case 'payment.recovered':
      return subject + '’s payment went through, but their door access didn’t come back on.';
    case 'plan.cancelled':
    case 'booking.cancelled':
    case 'plan.expired':
      return subject + '’s plan ended' + onPlan + ' but their door access didn’t get turned off.';
    case 'member.deleted':
      return subject + ' was deleted, but their door access didn’t get cleaned up.';
    default:
      break;
  }

  // No event type at all — a background job failed with no member attached.
  if (!r.event_type) {
    return 'A background job didn’t finish. No member lost access because of it.';
  }

  return 'Something went wrong handling ' + subject + '’s access' + onPlan + '.';
}

function renderNightlyDigest({ configAlerts, failedJobs }) {
  const alerts = Array.isArray(configAlerts) ? configAlerts : [];
  const jobs   = Array.isArray(failedJobs)   ? failedJobs   : [];
  const total  = alerts.length + jobs.length;

  const summary = total === 1
    ? 'One thing needs a look today.'
    : total + ' things need a look today.';

  const sections = [];
  const sectionsText = [];

  if (alerts.length) {
    const items = alerts.map(a => '<li style="margin-bottom:6px;">' + escapeHtml(describeConfigAlert(a)) + '</li>').join('');
    sections.push(
      '<p style="margin:16px 0 6px 0;font-weight:bold;">Setup issues</p>' +
      '<ul style="margin:0 0 8px 0;padding-left:20px;">' + items + '</ul>'
    );
    sectionsText.push('Setup issues\n' + alerts.map(a => '  • ' + describeConfigAlert(a)).join('\n'));
  }

  if (jobs.length) {
    const items = jobs.map(j => '<li style="margin-bottom:6px;">' + escapeHtml(describeFailedJob(j)) + '</li>').join('');
    sections.push(
      '<p style="margin:16px 0 6px 0;font-weight:bold;">Member access that didn’t go through</p>' +
      '<ul style="margin:0 0 8px 0;padding-left:20px;">' + items + '</ul>'
    );
    sectionsText.push('Member access that didn’t go through\n' + jobs.map(j => '  • ' + describeFailedJob(j)).join('\n'));
  }

  const closing = 'Once you’ve handled something, dismiss it in your dashboard and it’ll stop showing up here.';

  const bodyHtml =
    '<p style="margin:0 0 4px 0;">' + escapeHtml(summary) + '</p>' +
    sections.join('') +
    '<p style="margin:16px 0 0 0;">' + escapeHtml(closing) + '</p>';

  const bodyText = summary + '\n\n' + sectionsText.join('\n\n') + '\n\n' + closing;

  const { html, text } = renderLayout({
    heading: 'Your AccessSync summary',
    bodyHtml,
    bodyText,
    actionNeeded: true,
    ctaText: 'Review and dismiss',
    // Cross-tenant by nature (spans every client with an open alert or failed job) —
    // no single clientId applies, so this points at the owner's cross-tenant view
    // instead of the per-client /errors page (which renders nothing without one).
    ctaUrl: hubLink('/admin-errors'),
  });

  const subject = total === 1
    ? '[AccessSync] 1 thing needs a look'
    : '[AccessSync] ' + total + ' things need a look';

  return { subject, html, text };
}

module.exports = {
  escapeHtml,
  humanDate,
  adminHubUrl,
  hubLink,
  renderLayout,
  renderHardwareKeyAlert,
  renderOrphanedGroupsAlert,
  renderArchivedPlansAlert,
  renderHmacAlert,
  renderMemberFailureAlert,
  renderNightlyDigest,
  describeConfigAlert,
  describeFailedJob,
};
