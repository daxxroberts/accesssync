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
const SUPPORT_LINE = 'Nothing for you to fix. AccessSync support can see this on their own panel and will look into it.';
const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT']);

const accessSyncOwned = (headline, steps = [SUPPORT_LINE], extra = {}) =>
  ({ owner: OWNER.ACCESSSYNC, retry: RETRY.NONE, headline, steps, ...extra });
// "Their door account is gone": only the gym knows whether it was deleted on purpose, so the gym may close the row.
const GONE_STEPS = [SUPPORT_LINE, 'If you removed them in Kisi on purpose, you can mark this resolved.'];
const gymFix = (headline, steps) => ({ owner: OWNER.GYM, retry: RETRY.AFTER_FIX, headline, steps });

/** code → guidance. `resolution` (set by the connector) is the fallback key. */
const BY_CODE = {
  IN_FLIGHT_LOCK: {
    owner: OWNER.NOBODY, retry: RETRY.NONE,
    headline: 'Two updates for the same member arrived at once. AccessSync handled the first and will handle this one automatically.',
    steps: ['Nothing to do. If this member is still without access after the next sync, contact AccessSync support.'],
  },
  HARDWARE_KEY_INVALID: gymFix(
    'The door system rejected the saved Kisi API key, so no one can be added or removed.',
    ['Open System Config and replace the Kisi API Key (create a new key in Kisi if needed).', 'Press "Test" to confirm it works.', 'Then press Retry on the affected members.']),
  HARDWARE_KEY_PERMISSIONS: gymFix(
    'The Kisi API key works but is not allowed to manage users.',
    ['In Kisi, create a key with permission to manage users (this can depend on the Kisi plan).', 'Replace the key in System Config and press "Test".', 'Then press Retry on the affected members.']),
  HARDWARE_KEY_MISSING: gymFix(
    'No Kisi API key has been saved yet, so nobody can be given door access.',
    ['Open System Config and add the Kisi API Key.', 'Then press Retry on the affected members.']),
  HARDWARE_RESOURCE_NOT_FOUND: gymFix(
    'A door group this plan points to no longer exists in Kisi.',
    ['Open Plan Mapping and choose a door group that still exists for this plan.', 'Then press Retry on the affected members.']),
  // Kisi answered 422 "unknown" to the role assignment: no reason is given and the cause has not been established
  // (the old advice — "check the member's email and name" — was wrong: AccessSync never sends a name to Kisi).
  HARDWARE_VALIDATION_ERROR: accessSyncOwned(
    'Kisi refused this request and gave no reason. Retrying sends the same request again and fails the same way.',
    [SUPPORT_LINE, 'If this member tells you they cannot get in, contact AccessSync support and mention this error.']),
  HARDWARE_API_ERROR: {
    owner: OWNER.NOBODY, retry: RETRY.NOW,
    headline: 'The door system had a temporary problem. AccessSync tries again on the next sync.',
    steps: ['Nothing to do yet. If it is still here after a few hours, contact AccessSync support.'],
  },
  KISI_ROLE_CONFLICT_UNRESOLVED: accessSyncOwned(
    'Kisi reported a conflict assigning this member to a door group and AccessSync could not resolve it.'),
  HARDWARE_USER_GONE: accessSyncOwned(
    'This member\'s door account no longer exists in Kisi (it may have been deleted there).',
    GONE_STEPS, { gymMayDismiss: true }),
  // Written by core/source-retry-probe.js when its automatic retries ran out; not a queue job, so Retry cannot replay it.
  SOURCE_RETRY_EXHAUSTED: accessSyncOwned(
    'AccessSync tried several times to finish this door assignment and could not. Pressing Retry would not change that.'),
  INVALID_HARDWARE_REQUEST: accessSyncOwned(
    'AccessSync could not build a valid request for the door system for this member (a required detail is missing).'),
  WIX_KEY_INVALID: gymFix(
    'Wix rejected the saved Wix API key, so new purchases cannot be read.',
    ['Open System Config and replace the Wix API key.', 'Then press Retry on the affected members.']),
  WIX_KEY_MISSING: gymFix('No Wix API key has been saved yet.', ['Open System Config and add the Wix API key.']),
  WIX_KEY_PERMISSIONS: gymFix(
    'The Wix API key is missing the Pricing Plans / Bookings read permissions.',
    ['Create a new Wix API key with those permissions and save it in System Config.']),
  PLAN_NOT_MAPPED: gymFix(
    'A member bought a Wix plan that is not linked to a door group yet. They have paid and are waiting.',
    ['Open Plan Mapping and link the plan to a door group.', 'Then press Retry on the waiting members.']),
  SUBSCRIPTION_LAPSED: accessSyncOwned(
    'AccessSync is not active for this location, so changes are paused.',
    ['Contact AccessSync to reactivate the location.']),
};

const BY_RESOLUTION = {
  ROTATE_API_KEY: 'HARDWARE_KEY_INVALID',
  CHECK_PERMISSIONS: 'HARDWARE_KEY_PERMISSIONS',
  REMAP_PLAN: 'HARDWARE_RESOURCE_NOT_FOUND',
};

const temporary = (headline) => ({
  owner: OWNER.NOBODY, retry: RETRY.NOW, headline,
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
  steps: ['You can press Retry once. If it fails again, leave it with AccessSync support: they can see this on their own panel and will look into it.'],
});

const COPY = (g) => ({
  owner: g.owner, retry: g.retry, headline: g.headline, steps: g.steps.slice(), gymMayDismiss: !!g.gymMayDismiss,
});

/**
 * @param {{ error_code?: string|null, errorCode?: string|null, code?: string|null, resolution?: string|null,
 *           http_status?: number|null, statusCode?: number|null, occurred_count?: number|null,
 *           event_type?: string|null, eventType?: string|null }} row
 *        an error_queue row (snake_case) or a thrown error (camelCase)
 * @returns {{ owner: 'gym'|'accesssync'|'nobody', retry: 'now'|'after_fix'|'none', retryHelps: boolean, gymMayDismiss: boolean,
 *             headline: string, steps: string[], repeating: boolean, removal: boolean }}
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
      g = accessSyncOwned(`The door system refused this request (HTTP ${status}). Retrying sends the same request again.`);
    } else if (isTransient(status)) {
      g = temporary('The door system had a temporary problem. AccessSync tries again on the next sync.');
    }
  }

  if (!g && code && NETWORK_CODES.has(code)) {
    g = temporary('AccessSync could not reach the door system for a moment. It tries again on the next sync.');
  }
  if (!g && isTransient(status)) {
    g = temporary('A connected service had a temporary problem. AccessSync tries again on the next sync.');
  }
  if (!g && is4xx(status)) {
    const who = String(code || '').startsWith('WIX_') ? 'Wix' : 'A connected service';
    g = accessSyncOwned(`${who} refused a request (HTTP ${status}). Retrying sends the same request again.`);
  }

  // A 404 is "door group deleted" for a grant, but for a suspend / enable / removal the thing that is missing is
  // the member's own door account — sending the gym to Plan Mapping would be wrong.
  if (code === 'HARDWARE_RESOURCE_NOT_FOUND' && (removal || (eventType && eventType.startsWith('payment.')))) {
    g = accessSyncOwned(
      'AccessSync could not find this member\'s door account in Kisi (it may have been deleted there).',
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
    out.headline = 'This was expected to clear by itself but has been open for over a day.';
    out.steps = [SUPPORT_LINE];
  }

  // A "temporary" or "unknown" error that keeps coming back is no longer a one-off — someone must look.
  const repeating = count >= 5;
  if (repeating && out.retry === RETRY.NOW && out.owner === OWNER.ACCESSSYNC) {
    out.retry = RETRY.NONE;
    out.headline = `This keeps failing (${count} times), so retrying is not the answer.`;
    out.steps = [SUPPORT_LINE];
  } else if (repeating && out.owner === OWNER.NOBODY && code !== 'IN_FLIGHT_LOCK') {
    out.owner = OWNER.ACCESSSYNC;
    out.retry = RETRY.NONE;
    out.headline = `This keeps happening (${count} times), so it is not a temporary glitch.`;
    out.steps = [SUPPORT_LINE];
  } else if (repeating && code === 'IN_FLIGHT_LOCK') {
    out.owner = OWNER.ACCESSSYNC;
    out.headline = `This member has been locked ${count} times, so it is not a one-off collision.`;
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
