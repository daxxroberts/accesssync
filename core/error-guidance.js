/**
 * core/error-guidance.js — "what needs to happen?" for every error an operator can see.
 *
 * An error with no way of rectifying it is a dead end: the gym owner (or the
 * AccessSync owner) sees red and cannot tell whether to retry, fix a setting,
 * wait, or call someone. This module is the single place that answers, for any
 * error_queue row, three questions in plain words:
 *
 *   owner       WHO has to act     'gym'        the gym operator can fix it in AccessSync
 *                                  'accesssync' only AccessSync support can (it is already
 *                                               visible on the AccessSync owner's panel)
 *                                  'nobody'     it resolves itself; nothing to do
 *   retryHelps  would "Retry now" change the outcome?  (false = it will fail the same way)
 *   steps       the concrete next steps, in order
 *
 * Pure function, no I/O. Never returns an empty answer: an unknown error gets the
 * 'accesssync' fallback, so no error is ever shown without an owner and a next step.
 * The Kisi connector already maps HTTP status → code/userMessage/action/resolution
 * (adapters/kisi/kisi-connector.js); this layers who-acts / retry-helps on top and
 * fixes the one case where the connector's own advice ("try retrying") is wrong.
 */

'use strict';

const OWNER = Object.freeze({ GYM: 'gym', ACCESSSYNC: 'accesssync', NOBODY: 'nobody' });

/** code → guidance. `resolution` (set by the connector) is the fallback key. */
const BY_CODE = {
  IN_FLIGHT_LOCK: {
    owner: OWNER.NOBODY, retryHelps: false,
    headline: 'Two updates for the same member arrived at once. AccessSync handled the first and will handle this one automatically.',
    steps: ['Nothing to do. This clears by itself.'],
  },
  HARDWARE_KEY_INVALID: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'The door system rejected the saved Kisi API key, so no one can be added or removed.',
    steps: ['Open System Config and replace the Kisi API Key (create a new key in Kisi if needed).', 'Press "Test key" to confirm it works.', 'Then press Retry on the affected members.'],
  },
  HARDWARE_KEY_PERMISSIONS: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'The Kisi API key works but is not allowed to manage users.',
    steps: ['In Kisi, create a key with permission to manage users (this can depend on the Kisi plan).', 'Replace the key in System Config and press "Test key".', 'Then press Retry on the affected members.'],
  },
  HARDWARE_KEY_MISSING: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'No Kisi API key has been saved yet, so nobody can be given door access.',
    steps: ['Open System Config and add the Kisi API Key.', 'Then press Retry on the affected members.'],
  },
  HARDWARE_RESOURCE_NOT_FOUND: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'A door group this plan points to no longer exists in Kisi.',
    steps: ['Open Plan Mapping and choose a door group that still exists for this plan.', 'Then press Retry on the affected members.'],
  },
  HARDWARE_VALIDATION_ERROR: {
    // The connector says "Try retrying" — wrong: Kisi rejected the SAME data and will again.
    owner: OWNER.ACCESSSYNC, retryHelps: false,
    headline: 'Kisi refused to create or update this person. Retrying sends the same data and fails the same way.',
    steps: [
      'Check this person has an email and name on their Wix profile; ask them to add one if not, then press Retry.',
      'If they do, nothing more is needed from you: AccessSync support can see this on their own panel and will look into it.',
    ],
  },
  HARDWARE_API_ERROR: {
    owner: OWNER.NOBODY, retryHelps: true,
    headline: 'The door system had a temporary problem. AccessSync keeps retrying on its own.',
    steps: ['Nothing to do yet. If it is still here after a few hours, contact AccessSync support.'],
  },
  WIX_KEY_INVALID: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'Wix rejected the saved Wix API key, so new purchases cannot be read.',
    steps: ['Open System Config and replace the Wix API key.', 'Then press Retry on the affected members.'],
  },
  WIX_KEY_MISSING: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'No Wix API key has been saved yet.',
    steps: ['Open System Config and add the Wix API key.'],
  },
  WIX_KEY_PERMISSIONS: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'The Wix API key is missing the Pricing Plans / Bookings read permissions.',
    steps: ['Create a new Wix API key with those permissions and save it in System Config.'],
  },
  PLAN_NOT_MAPPED: {
    owner: OWNER.GYM, retryHelps: false,
    headline: 'A member bought a Wix plan that is not linked to a door group yet. They have paid and are waiting.',
    steps: ['Open Plan Mapping and link the plan to a door group.', 'Then press Retry on the waiting members.'],
  },
  SUBSCRIPTION_LAPSED: {
    owner: OWNER.ACCESSSYNC, retryHelps: false,
    headline: 'AccessSync is not active for this location, so changes are paused.',
    steps: ['Contact AccessSync to reactivate the location.'],
  },
};

const BY_RESOLUTION = {
  ROTATE_API_KEY: 'HARDWARE_KEY_INVALID',
  CHECK_PERMISSIONS: 'HARDWARE_KEY_PERMISSIONS',
  REMAP_PLAN: 'HARDWARE_RESOURCE_NOT_FOUND',
};

/** Never-empty fallback: someone always owns an error nobody has classified yet. */
const FALLBACK = Object.freeze({
  owner: OWNER.ACCESSSYNC, retryHelps: false,
  headline: 'Something went wrong that AccessSync does not recognise yet.',
  steps: ['Nothing for you to fix. AccessSync support can see this on their own panel and will look into it.'],
});

const COPY = (g) => ({ owner: g.owner, retryHelps: g.retryHelps, headline: g.headline, steps: g.steps.slice() });

/**
 * @param {{ error_code?: string|null, errorCode?: string|null, resolution?: string|null,
 *           http_status?: number|null, statusCode?: number|null, occurred_count?: number|null }} row
 *        an error_queue row (snake_case) or a thrown error (camelCase)
 * @returns {{ owner: 'gym'|'accesssync'|'nobody', retryHelps: boolean, headline: string,
 *             steps: string[], repeating: boolean }}
 */
function guidanceFor(row = {}) {
  const code = row.error_code || row.errorCode || null;
  const resolution = row.resolution || null;
  const status = row.http_status || row.statusCode || null;
  const count = row.occurred_count || 1;

  let g = (code && BY_CODE[code]) || (resolution && BY_CODE[BY_RESOLUTION[resolution]]) || null;
  if (!g && status && status >= 400 && status < 500 && status !== 429) {
    // A 4xx the connector did not classify: the request was refused, repeating it will not change that.
    g = { ...FALLBACK, headline: `The door system refused a request (HTTP ${status}).` };
  }
  const out = COPY(g || FALLBACK);

  // A "temporary" error that keeps coming back is no longer temporary — someone must look.
  const repeating = count >= 5;
  if (repeating && out.owner === OWNER.NOBODY) {
    out.owner = OWNER.ACCESSSYNC;
    out.retryHelps = false;
    out.headline = `This keeps happening (${count} times), so it is not a temporary glitch.`;
    out.steps = ['Nothing for you to fix. AccessSync support can see this on their own panel and will look into it.'];
  }
  out.repeating = repeating;
  return out;
}

module.exports = { guidanceFor, OWNER };
