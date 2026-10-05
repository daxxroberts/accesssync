/**
 * PRIORITY 3 — every error an operator can see says who must act and what to do.
 * An error with no way of rectifying it is a dead end; these tests pin that none exists, and that the answer
 * is true (e.g. a 4xx is never called "temporary", a removal is never told to press a Retry the server refuses).
 */
'use strict';

const { guidanceFor, dismissRefusal, OWNER, RETRY } = require('../../core/error-guidance');

const KNOWN = [
  'IN_FLIGHT_LOCK', 'HARDWARE_KEY_INVALID', 'HARDWARE_KEY_PERMISSIONS', 'HARDWARE_KEY_MISSING',
  'HARDWARE_RESOURCE_NOT_FOUND', 'HARDWARE_VALIDATION_ERROR', 'HARDWARE_API_ERROR',
  'KISI_ROLE_CONFLICT_UNRESOLVED', 'HARDWARE_USER_GONE', 'INVALID_HARDWARE_REQUEST',
  'WIX_KEY_INVALID', 'WIX_KEY_MISSING', 'WIX_KEY_PERMISSIONS', 'PLAN_NOT_MAPPED', 'SUBSCRIPTION_LAPSED',
];
const steps = (g) => g.steps.join(' ');

describe('[P3] error guidance — no dead ends', () => {
  test.each(KNOWN)('%s names an owner, a retry stance, a headline and at least one step', (code) => {
    const g = guidanceFor({ error_code: code });
    expect(Object.values(OWNER)).toContain(g.owner);
    expect(Object.values(RETRY)).toContain(g.retry);
    expect(g.retryHelps).toBe(g.retry === RETRY.NOW);
    expect(g.headline.length).toBeGreaterThan(10);
    expect(g.steps.length).toBeGreaterThan(0);
  });

  test.each([null, undefined, '', 'SOME_FUTURE_CODE'])('an unknown code (%p) is never blank: AccessSync owns it, and one Retry is offered (it may be a one-off)', (code) => {
    const g = guidanceFor({ error_code: code });
    expect(g.owner).toBe(OWNER.ACCESSSYNC);
    expect(g.retry).toBe(RETRY.NOW);
    expect(steps(g)).toMatch(/press Retry once/);
    expect(steps(g)).toMatch(/AccessSync support/);
  });

  test('...but an unknown error that keeps failing stops offering Retry and is left with AccessSync support', () => {
    const g = guidanceFor({ error_code: 'SOME_FUTURE_CODE', occurred_count: 5 });
    expect(g).toMatchObject({ owner: OWNER.ACCESSSYNC, retry: RETRY.NONE, repeating: true });
    expect(steps(g)).not.toMatch(/press Retry/i);
  });

  test('guidanceFor() with no argument, or null, still answers', () => {
    expect(guidanceFor().owner).toBe(OWNER.ACCESSSYNC);
    expect(guidanceFor(null).owner).toBe(OWNER.ACCESSSYNC);
  });

  describe('Kisi 422 "unknown" (the live case)', () => {
    test('is AccessSync support\'s from the first occurrence; the gym is NOT sent to check a profile (AccessSync never sends Kisi a name)', () => {
      const g = guidanceFor({ error_code: 'HARDWARE_VALIDATION_ERROR', http_status: 422, occurred_count: 1 });
      expect(g.owner).toBe(OWNER.ACCESSSYNC);
      expect(g.retry).toBe(RETRY.NONE);
      expect(steps(g)).not.toMatch(/email and a name|Wix profile|press Retry/i);
      expect(steps(g)).toMatch(/AccessSync support can see this/);
      expect(steps(g)).toMatch(/cannot get in/);          // what to do if the member complains
    });
  });

  describe('gym-fixable configuration errors', () => {
    test.each([
      ['HARDWARE_KEY_INVALID', /System Config/], ['HARDWARE_KEY_PERMISSIONS', /System Config/],
      ['HARDWARE_KEY_MISSING', /System Config/], ['PLAN_NOT_MAPPED', /Plan Mapping/],
      ['HARDWARE_RESOURCE_NOT_FOUND', /Plan Mapping/],
    ])('%s is the gym\'s, says where, and Retry is the LAST step (after the fix)', (code, where) => {
      const g = guidanceFor({ error_code: code, event_type: 'plan.purchased' });
      expect(g.owner).toBe(OWNER.GYM);
      expect(g.retry).toBe(RETRY.AFTER_FIX);
      expect(steps(g)).toMatch(where);
      expect(g.steps[g.steps.length - 1]).toMatch(/Retry/);
    });

    test('falls back to the connector\'s resolution when the code is unfamiliar', () => {
      expect(guidanceFor({ error_code: 'X', resolution: 'ROTATE_API_KEY' }).owner).toBe(OWNER.GYM);
      expect(steps(guidanceFor({ error_code: 'X', resolution: 'REMAP_PLAN' }))).toMatch(/Plan Mapping/);
    });
  });

  describe('HTTP status decides what is temporary — a refused request never is', () => {
    test('HARDWARE_API_ERROR with a 4xx (the connector files 400/405/409 here) is NOT temporary and is not retried', () => {
      for (const s of [400, 405, 409]) {
        const g = guidanceFor({ error_code: 'HARDWARE_API_ERROR', http_status: s, occurred_count: 1 });
        expect(g.owner).toBe(OWNER.ACCESSSYNC);
        expect(g.retry).toBe(RETRY.NONE);
        expect(g.headline).toMatch(new RegExp(`HTTP ${s}`));
        expect(g.headline).not.toMatch(/temporary/i);
      }
    });

    test.each([500, 502, 503, 429])('HARDWARE_API_ERROR / an unclassified %i is temporary: nobody acts, Retry works', (s) => {
      expect(guidanceFor({ error_code: 'HARDWARE_API_ERROR', http_status: s })).toMatchObject({ owner: OWNER.NOBODY, retry: RETRY.NOW });
      expect(guidanceFor({ http_status: s })).toMatchObject({ owner: OWNER.NOBODY, retry: RETRY.NOW });
    });

    test.each(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'])('network error %s is temporary', (code) => {
      expect(guidanceFor({ error_code: code })).toMatchObject({ owner: OWNER.NOBODY, retry: RETRY.NOW });
    });

    test('an unclassified 4xx is refused, not retryable, and owned by AccessSync — and it names the right system', () => {
      const kisi = guidanceFor({ http_status: 418 });

      expect(kisi).toMatchObject({ owner: OWNER.ACCESSSYNC, retry: RETRY.NONE });
      expect(kisi.headline).toMatch(/418/);
      const wix = guidanceFor({ error_code: 'WIX_MEMBER_NOT_FOUND', http_status: 404 });
      expect(wix.headline).toMatch(/^Wix refused/);
      expect(wix.headline).not.toMatch(/door system/i);
    });

    test('a "temporary" error that keeps recurring is escalated to AccessSync (no endless "it will retry")', () => {
      const once = guidanceFor({ error_code: 'HARDWARE_API_ERROR', http_status: 503, occurred_count: 1 });
      expect(once).toMatchObject({ owner: OWNER.NOBODY, retryHelps: true });
      const many = guidanceFor({ error_code: 'HARDWARE_API_ERROR', http_status: 503, occurred_count: 6 });
      expect(many).toMatchObject({ owner: OWNER.ACCESSSYNC, retry: RETRY.NONE, repeating: true });
    });

    test('a lock collision that repeats is not "clears by itself" any more', () => {
      expect(guidanceFor({ error_code: 'IN_FLIGHT_LOCK', occurred_count: 1 }).owner).toBe(OWNER.NOBODY);
      expect(guidanceFor({ error_code: 'IN_FLIGHT_LOCK', occurred_count: 5 }).owner).toBe(OWNER.ACCESSSYNC);
    });
  });

  describe('what kind of job failed changes the advice', () => {
    test('a 404 on a payment suspend/enable or a removal is about the member\'s door account, NOT a deleted door group', () => {
      for (const event_type of ['payment.failed', 'payment.recovered', 'plan.cancelled']) {
        const g = guidanceFor({ error_code: 'HARDWARE_RESOURCE_NOT_FOUND', http_status: 404, event_type });
        expect(g.owner).toBe(OWNER.ACCESSSYNC);
        expect(g.headline).toMatch(/door account/);
        expect(steps(g)).not.toMatch(/Plan Mapping/);
      }
      // the same code on a grant is still the door-group case
      expect(steps(guidanceFor({ error_code: 'HARDWARE_RESOURCE_NOT_FOUND', http_status: 404, event_type: 'plan.purchased' }))).toMatch(/Plan Mapping/);
    });

    test('removals are never told to press Retry (the server refuses it) and are never offered one', () => {
      const g = guidanceFor({ error_code: 'HARDWARE_KEY_INVALID', event_type: 'plan.cancelled' });
      expect(g.removal).toBe(true);
      expect(g.retry).toBe(RETRY.NONE);
      expect(steps(g)).not.toMatch(/press Retry/i);
      expect(g.owner).toBe(OWNER.GYM);                       // the key is still the gym's to fix
      expect(steps(g)).toMatch(/AccessSync support will complete this removal/);
      expect(guidanceFor({ error_code: 'HARDWARE_KEY_INVALID', event_type: 'plan.purchased' }).removal).toBe(false);
    });
  });

  test('the result is a copy: callers cannot corrupt the table', () => {
    const g = guidanceFor({ error_code: 'PLAN_NOT_MAPPED' });
    g.steps.push('x'); g.owner = 'nobody';
    expect(guidanceFor({ error_code: 'PLAN_NOT_MAPPED' }).steps).not.toContain('x');
    expect(guidanceFor({ error_code: 'PLAN_NOT_MAPPED' }).owner).toBe(OWNER.GYM);
  });
});

describe('review follow-ups', () => {
  test('"door account gone" can be closed by the gym (the advice says so, so the server must allow it)', () => {
    for (const row of [
      { error_code: 'HARDWARE_USER_GONE' },
      { error_code: 'HARDWARE_RESOURCE_NOT_FOUND', http_status: 404, event_type: 'plan.cancelled' },
      { error_code: 'HARDWARE_RESOURCE_NOT_FOUND', http_status: 404, event_type: 'payment.failed' },
    ]) {
      const g = guidanceFor(row);
      expect(g.owner).toBe('accesssync');
      expect(g.steps.join(' ')).toMatch(/mark this resolved/);
      expect(g.gymMayDismiss).toBe(true);
      expect(dismissRefusal(row, 'operator')).toBeNull();
    }
  });

  test('other AccessSync-owned errors still cannot be closed by the gym', () => {
    expect(guidanceFor({ error_code: 'HARDWARE_VALIDATION_ERROR' }).gymMayDismiss).toBe(false);
    expect(dismissRefusal({ error_code: 'HARDWARE_VALIDATION_ERROR' }, 'operator')).not.toBeNull();
  });

  test('source_retry_exhausted rows (not a queue job) are AccessSync\'s and offer no Retry', () => {
    const row = { error_code: 'SOURCE_RETRY_EXHAUSTED', event_type: 'source_retry_exhausted' };
    const g = guidanceFor(row);
    expect(g).toMatchObject({ owner: 'accesssync', retry: 'none', retryHelps: false });
    expect(g.steps.join(' ')).not.toMatch(/press Retry/i);
  });

  test('an unknown error on an event type that cannot be replayed never offers Retry', () => {
    const g = guidanceFor({ error_code: null, event_type: 'some.other_event' });
    expect(g.retry).toBe('none');
    expect(g.steps.join(' ')).not.toMatch(/press Retry/i);
    expect(g.steps.length).toBeGreaterThan(0);
  });

  test('a self-clearing error open for 24h+ is AccessSync\'s on EVERY screen, not just the panel', () => {
    const old = new Date(Date.now() - 30 * 3_600_000).toISOString();
    const fresh = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const row = { error_code: 'HARDWARE_API_ERROR', http_status: 503 };
    expect(guidanceFor({ ...row, created_at: fresh }).owner).toBe('nobody');
    const g = guidanceFor({ ...row, created_at: old });
    expect(g.owner).toBe('accesssync');
    expect(g.steps.join(' ')).toMatch(/AccessSync support/);
  });
});
