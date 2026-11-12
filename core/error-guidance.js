/**
 * core/error-guidance.js — "what needs to happen?" for every error an operator can see.
 *
 * An error with no way of rectifying it is a dead end: the gym owner (or the AccessSync owner) sees
 * red and cannot tell whether to retry, fix a setting, wait, or call someone. This module is the single
 * place that answers, for any error_queue row, in plain words:
 *
 *   owner   WHO has to act   'gym'        the gym operator can fix it inside AccessSync
 *                            'accesssync' only AccessSync support can (it is on the AccessSync owner's panel)
 *                            'nobody'     it resolves itself; nothing to do
 *   retry   the Retry button 'now'        pressing Retry can succeed as things stand
 *                            'after_fix'  the gym's fix comes first; Retry is the LAST step
 *                            'none'       Retry cannot help (same request fails the same way) or the server
 *                                         refuses it (removals): the button is not offered
 *   steps   the concrete next steps, in order
 *
 * Pure function, no I/O. Never returns an empty answer: an unknown error gets the 'accesssync' fallback, so no
 * error is ever shown without an owner and a next step. The Kisi connector already maps HTTP status →
 * code/userMessage/action/resolution (adapters/kisi/kisi-connector.js); this layers who-acts / retry on top and
 * corrects the places where the connector's own advice is wrong ("try retrying" for a refused request; calling
 * every unlisted status, including 4xx, "temporary").
 *
 * Everything on screen and in the email takes its cue from here (errors page, incident drawer, operator email,
 * owner panel, server-side retry/dismiss guards) so they cannot contradict each other.
 */

'use strict';

const { jobNameForEventType } = require('./event-routing');

const OWNER = Object.freeze({ GYM: 'gym', ACCESSSYNC: 'accesssync', NOBODY: 'nobody' });
const RETRY = Object.freeze({ NOW: 'now', AFTER_FIX: 'after_fix', NONE: 'none' });

// "Clears by itself" only holds for a while: nothing auto-resolves an error row, so past this age it is AccessSync's.
const SELF_CLEARING_MAX_H = 24;
const SUPPORT_LINE = 'Nothing for you to do. AccessSync support can see this and will look into it.';
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);

// Every entry reads the same way on the Errors page and in the alert email: headline = the problem (one sentence),
// why = what caused it (one short sentence, optional), steps = what to do (short, in order).
const accessSyncOwned = (headline, why, steps = [SUPPORT_LINE], extra = {}) =>
  ({ owner: OWNER.ACCESSSYNC, retry: RETRY.NONE, headline, why, steps, ...extra });
// "Their door account is gone": only the gym knows whether it was deleted on purpose, so the gym may close the row.
const GONE_STEPS = [SUPPORT_LINE, 'If you removed them in Kisi on purpose, mark this resolved.'];
const gymFix = (headline, why, steps) => ({ owner: OWNER.GYM, retry: RETRY.AFTER_FIX, headline, why, steps });
const RETRY_AFFECTED = 'Then press Retry on the affected members.';

/** code → guidance. `resolution` (set by the connector) is the fallback key. */
const BY_CODE = {
  IN_FLIGHT_LOCK: {
    owner: OWNER.NOBODY, retry: RETRY.NONE,
    headline: 'Two updates for this member arrived at once.',
    why: 'AccessSync handled the first and retries this one itself.',
    steps: ['Nothing to do. If they still lack access after the next sync, contact AccessSync support.'],
  },
  HARDWARE_KEY_INVALID: gymFix(
    'Kisi rejected the saved API key.',
    'It was changed, deleted or expired, so nobody can be added or removed.',
    ['Replace the Kisi API Key in System Config and press Test.', RETRY_AFFECTED]),
  HARDWARE_KEY_PERMISSIONS: gymFix(
    'The Kisi API key is not allowed to manage users.',
    'The key works but lacks that permission (it can depend on the Kisi plan).',
    ['Create a Kisi key that can manage users, save it in System Config and press Test.', RETRY_AFFECTED]),
  HARDWARE_KEY_MISSING: gymFix(
    'No Kisi API key is saved.',
    'Without it nobody can be given door access.',
    ['Add the Kisi API Key in System Config.', RETRY_AFFECTED]),
  HARDWARE_RESOURCE_NOT_FOUND: gymFix(
    'A door group for this plan no longer exists in Kisi.',
    'It was probably deleted or renamed there.',
    ['Choose a door group that still exists in Plan Mapping.', RETRY_AFFECTED]),
  // Kisi answered 422 "unknown" to the role assignment: no reason is given and the cause has not been established
  // (the old advice — "check the member's email and name" — was wrong: the live 422s are on POST /role_assignments,
  // which carries no member details; names are only sent when the Kisi user is created, since 2026-10-14).
  HARDWARE_VALIDATION_ERROR: accessSyncOwned(
    'Kisi refused this request and gave no reason.',
    'Retrying sends the same request, so it fails the same way.',
    [SUPPORT_LINE, 'If the member says they cannot get in, tell AccessSync support.']),
  HARDWARE_API_ERROR: {
    owner: OWNER.NOBODY, retry: RETRY.NOW,
    headline: 'Kisi had a temporary problem.',
    why: 'AccessSync tries again on the next sync.',
    steps: ['Nothing to do yet. If it is still here after a few hours, contact AccessSync support.'],
  },
  KISI_ROLE_CONFLICT_UNRESOLVED: accessSyncOwned(
    'Kisi reported a conflict assigning this member to a door group.',
    'AccessSync could not resolve it automatically.'),
  HARDWARE_USER_GONE: accessSyncOwned(
    'This member\'s Kisi account no longer exists.',
    'It was probably deleted in Kisi.',
    GONE_STEPS, { gymMayDismiss: true }),
  // DR-045 delete guard (adapters/kisi/kisi-adapter.js): Kisi answers the same way every time, so Retry cannot help.
  // A member removal no longer fails on these (finalizeRevoke takes the doors away first and leaves the account with a
  // config alert), so a row here is an older one, or a day-pass door link on another client's marker.
  UNOWNED_USER: accessSyncOwned(
    'This Kisi account has no AccessSync ownership label.',
    'AccessSync only deletes accounts it created.',
    [SUPPORT_LINE, 'If it is meant to stay in Kisi, mark this resolved.'],
    { gymMayDismiss: true }),
  ELEVATED_ROLE_ATTACHED: accessSyncOwned(
    'This Kisi account has admin, manager or owner rights.',
    'AccessSync never deletes those.',
    [SUPPORT_LINE, 'If they are staff, mark this resolved.'],
    { gymMayDismiss: true }),
  CLIENT_MISMATCH: accessSyncOwned(
    'This Kisi record belongs to a different AccessSync account.',
    'AccessSync will not change or delete it.'),
  // DR-056 — login-email swap. Each is a deliberate stop: the member's door login was left exactly as it was.
  // Retry cannot help (the same event would stop in the same place), so none offers it.
  LOGIN_EMAIL_UNVERIFIED: {
    owner: OWNER.GYM, retry: RETRY.NONE,
    headline: 'Wix has not confirmed this member\'s new login email.',
    why: 'They have not clicked the confirmation link Wix sent. Their door login stays on the old address.',
    steps: ['Ask them to confirm the new email. This closes itself once they do.'],
  },
  LOGIN_EMAIL_IN_USE: accessSyncOwned(
    'The new login email already belongs to a different Kisi user.',
    'Nothing was changed and their door access still works.',
    [SUPPORT_LINE, 'If the address is theirs on another Kisi account, support will decide which to keep.']),
  LOGIN_EMAIL_SHARED_USER: accessSyncOwned(
    'Other members share this member\'s Kisi login.',
    'Swapping it would change their login too, so it was not swapped.',
    [SUPPORT_LINE]),
  LOGIN_EMAIL_RATE_LIMITED: accessSyncOwned(
    'This member\'s door login was already swapped in the last 30 days.',
    'A second change is not applied automatically.',
    [SUPPORT_LINE, 'If this was not them, contact the member.']),
  LOGIN_EMAIL_USER_NOT_OURS: accessSyncOwned(
    'This member\'s Kisi user was not created by AccessSync, or has an admin role.',
    'AccessSync only swaps accounts it created.',
    [SUPPORT_LINE]),
  LOGIN_EMAIL_OLD_USER_NOT_REMOVED: accessSyncOwned(
    'This member moved to a new Kisi login, but the old Kisi user was not deleted.',
    'Kisi refused or failed the delete.',
    [SUPPORT_LINE, 'They can already get in. Support will remove the old user.']),
  // Written by core/source-retry-probe.js when its automatic retries ran out; not a queue job, so Retry cannot replay it.
  SOURCE_RETRY_EXHAUSTED: accessSyncOwned(
    'A door assignment kept failing.',
    'AccessSync retried several times without success, so pressing Retry would not change that.'),
  INVALID_HARDWARE_REQUEST: accessSyncOwned(
    'AccessSync could not build a valid door-system request for this member.',
    'A required detail is missing.'),
  WIX_KEY_INVALID: gymFix(
    'Wix rejected the saved API key.',
    'New purchases cannot be read until it is replaced.',
    ['Replace the Wix API key in System Config.', RETRY_AFFECTED]),
  WIX_KEY_MISSING: gymFix(
    'No Wix API key is saved.',
    'AccessSync cannot read Wix purchases without it.',
    ['Add the Wix API key in System Config.']),
  WIX_KEY_PERMISSIONS: gymFix(
    'The Wix API key cannot read Pricing Plans or Bookings.',
    'Those permissions are missing.',
    ['Create a Wix API key with them and save it in System Config.']),
  PLAN_NOT_MAPPED: gymFix(
    'This member bought a Wix plan that has no door group.',
    'They have paid and are waiting.',
    ['Link the plan to a door group in Plan Mapping.', 'Then press Retry on the waiting members.']),
  SUBSCRIPTION_LAPSED: accessSyncOwned(
    'AccessSync is not active for this location.',
    'Changes are paused.',
    ['Contact AccessSync to reactivate it.']),
};

// Login-email stops are not "didn't get access" problems: the alert names them for what they are.
for (const code of Object.keys(BY_CODE)) {
  if (code.startsWith('LOGIN_EMAIL_')) BY_CODE[code].title = 'login email change didn\u2019t go through';
}
BY_CODE.LOGIN_EMAIL_UNVERIFIED.title = 'new login email isn\u2019t confirmed';

const BY_RESOLUTION = {
  ROTATE_API_KEY: 'HARDWARE_KEY_INVALID',
  CHECK_PERMISSIONS: 'HARDWARE_KEY_PERMISSIONS',
  REMAP_PLAN: 'HARDWARE_RESOURCE_NOT_FOUND',
};

const temporary = (headline, why = 'AccessSync tries again on the next sync.') => ({
  owner: OWNER.NOBODY, retry: RETRY.NOW, headline, why,
  steps: ['Nothing to do yet. If it is still here after a few hours, contact AccessSync support.'],
});

const is4xx = (s) => !!s && s >= 400 && s < 500 && s !== 429;
const isTransient = (s) => !!s && (s >= 500 || s === 429);

/**
 * An error nothing recognises (no code, and no refused HTTP status): the cause is unknown, so AccessSync support owns
 * it — but a retry is harmless and may well work (a one-off), so it is offered once. Repeats escalate (see below).
 */
const unknownError = () => ({
  owner: OWNER.ACCESSSYNC, retry: RETRY.NOW,
  headline: 'Something went wrong that AccessSync does not recognise yet.',
  why: 'The cause is not known yet.',
  steps: ['You can press Retry once. If it fails again, AccessSync support will pick it up.'],
});

const COPY = (g) => ({
  owner: g.owner, retry: g.retry, headline: g.headline, why: g.why || null, title: g.title || null, steps: g.steps.slice(), gymMayDismiss: !!g.gymMayDismiss,
});

/**
 * @param {{ error_code?: string|null, errorCode?: string|null, code?: string|null, resolution?: string|null,
 *           http_status?: number|null, statusCode?: number|null, occurred_count?: number|null,
 *           event_type?: string|null, eventType?: string|null }} row
 *        an error_queue row (snake_case) or a thrown error (camelCase)
 * @returns {{ owner: 'gym'|'accesssync'|'nobody', retry: 'now'|'after_fix'|'none', retryHelps: boolean, gymMayDismiss: boolean,
 *             headline: string, why: string|null, steps: string[], repeating: boolean, removal: boolean }}
 */
function guidanceFor(row) {
  row = row || {};
  const code = row.error_code || row.errorCode || row.code || null;
  const resolution = row.resolution || null;
  const status = Number(row.http_status || row.statusCode) || null;
  const count = row.occurred_count || 1;
  const eventType = row.event_type || row.eventType || null;
  const removal = !!eventType && jobNameForEventType(eventType) === 'revoke';

  let g = (code && BY_CODE[code]) || (resolution && BY_CODE[BY_RESOLUTION[resolution]]) || null;

  if (g === BY_CODE.HARDWARE_API_ERROR || (!g && !code)) {
    // The connector files every status it does not list — 400, 405, 409, ... — under HARDWARE_API_ERROR. Only
    // server-side trouble is temporary; a refused (4xx) request fails the same way every time.
    if (is4xx(status)) {
      g = accessSyncOwned(`Kisi refused this request (HTTP ${status}).`, 'Retrying sends the same request again.');
    } else if (isTransient(status)) {
      g = temporary('Kisi had a temporary problem.');
    }
  }

  if (!g && code && NETWORK_CODES.has(code)) {
    g = temporary('AccessSync could not reach Kisi for a moment.');
  }
  if (!g && isTransient(status)) {
    g = temporary('A connected service had a temporary problem.');
  }
  if (!g && is4xx(status)) {
    const who = String(code || '').startsWith('WIX_') ? 'Wix' : 'A connected service';
    g = accessSyncOwned(`${who} refused a request (HTTP ${status}).`, 'Retrying sends the same request again.');
  }

  // A 404 is "door group deleted" for a grant, but for a suspend / enable / removal the thing that is missing is
  // the member's own door account — sending the gym to Plan Mapping would be wrong.
  if (code === 'HARDWARE_RESOURCE_NOT_FOUND' && (removal || (eventType && eventType.startsWith('payment.')))) {
    g = accessSyncOwned(
      'This member\'s door account is missing in Kisi.',
      'It was probably deleted there.',
      GONE_STEPS, { gymMayDismiss: true });
  }

  const out = COPY(g || unknownError());

  // Removals (revokes) cannot be retried from the UI: the server refuses it. Never offer it or tell anyone to press it.
  if (removal) {
    if (out.retry !== RETRY.NONE) out.retry = RETRY.NONE;
    out.steps = out.steps.filter((s) => !/press Retry/i.test(s));
    if (out.owner === OWNER.GYM) out.steps.push('AccessSync support will complete this removal once that is fixed.');
  }

  // Retry only replays a grant or a revoke job. A row whose event type is neither (e.g. source_retry_exhausted) is
  // refused by the retry route, so never offer it.
  if (eventType && !jobNameForEventType(eventType) && out.retry === RETRY.NOW) {
    out.retry = RETRY.NONE;
    out.steps = out.steps.filter((s) => !/press Retry/i.test(s));
    if (!out.steps.length) out.steps = [SUPPORT_LINE];
  }

  // An error that was meant to clear by itself but has sat open for a day is no longer waiting on anything: the owner
  // panel counts it as AccessSync's, so every screen must say the same (else the panel is red and the page says
  // "nobody needs to act").
  const ageH = row.created_at ? (Date.now() - new Date(row.created_at).getTime()) / 3_600_000 : null;
  if (out.owner === OWNER.NOBODY && ageH != null && ageH >= SELF_CLEARING_MAX_H) {
    out.owner = OWNER.ACCESSSYNC;
    out.headline = 'This was meant to clear by itself but is still open after a day.';
    out.why = null;
    out.steps = [SUPPORT_LINE];
  }

  // A "temporary" or "unknown" error that keeps coming back is no longer a one-off — someone must look.
  const repeating = count >= 5;
  if (repeating && out.retry === RETRY.NOW && out.owner === OWNER.ACCESSSYNC) {
    out.retry = RETRY.NONE;
    out.headline = `This keeps failing (${count} times).`;
    out.why = 'Retrying is not the answer.';
    out.steps = [SUPPORT_LINE];
  } else if (repeating && out.owner === OWNER.NOBODY && code !== 'IN_FLIGHT_LOCK') {
    out.owner = OWNER.ACCESSSYNC;
    out.retry = RETRY.NONE;
    out.headline = `This keeps happening (${count} times).`;
    out.why = 'It is not a temporary glitch.';
    out.steps = [SUPPORT_LINE];
  } else if (repeating && code === 'IN_FLIGHT_LOCK') {
    out.owner = OWNER.ACCESSSYNC;
    out.headline = `This member has been locked ${count} times.`;
    out.why = 'It is not a one-off collision.';
    out.steps = [SUPPORT_LINE];
  }

  out.retryHelps = out.retry === RETRY.NOW;
  out.repeating = repeating;
  out.removal = removal;
  return out;
}

/**
 * Server-side guard for "Retry": null when pressing it is allowed, otherwise why not. A retry that cannot
 * succeed sends the same request again — it fails the same way, re-alerts, and (the old behaviour) marked the row
 * resolved so it also disappeared from the panel while the member was still without access.
 * Removals are refused separately by the routes (revoke retry is paused in Phase 1).
 */
function retryRefusal(row) {
  const g = guidanceFor(row);
  if (g.retry !== RETRY.NONE || g.removal) return null;
  return {
    reason: 'retry_wont_help',
    error: g.owner === OWNER.NOBODY
      ? 'This one clears by itself, so there is nothing to retry. Nothing was queued and the error is still open.'
      : 'Retrying would send the same request and fail the same way. AccessSync support can see this and is looking into it. '
        + 'Nothing was queued and the error is still open.',
  };
}

/**
 * Server-side guard for "Mark resolved". An operator (the gym) cannot dismiss an error only AccessSync can fix:
 * doing so turned the AccessSync owner's panel green while the member was still locked out. The owner (role
 * 'admin') can dismiss anything.
 */
function dismissRefusal(row, role) {
  if (role === 'admin') return null;
  const g = guidanceFor(row);
  if (g.owner !== OWNER.ACCESSSYNC || g.gymMayDismiss) return null;
  return {
    reason: 'owned_by_accesssync',
    error: 'AccessSync support is looking into this one, so it can\'t be marked resolved from here. It clears once AccessSync has dealt with it.',
  };
}

module.exports = { SELF_CLEARING_MAX_H, guidanceFor, retryRefusal, dismissRefusal, OWNER, RETRY };
