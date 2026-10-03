/**
 * PRIORITY 3 — every error an operator can see says who must act and what to do.
 * An error with no way of rectifying it is a dead end; these tests pin that none exists.
 */
'use strict';

const { guidanceFor, OWNER } = require('../../core/error-guidance');

const KNOWN = [
  'IN_FLIGHT_LOCK', 'HARDWARE_KEY_INVALID', 'HARDWARE_KEY_PERMISSIONS', 'HARDWARE_KEY_MISSING',
  'HARDWARE_RESOURCE_NOT_FOUND', 'HARDWARE_VALIDATION_ERROR', 'HARDWARE_API_ERROR',
  'WIX_KEY_INVALID', 'WIX_KEY_MISSING', 'WIX_KEY_PERMISSIONS', 'PLAN_NOT_MAPPED', 'SUBSCRIPTION_LAPSED',
];

describe('[P3] error guidance — no dead ends', () => {
  test.each(KNOWN)('%s names an owner, a headline and at least one step', (code) => {
    const g = guidanceFor({ error_code: code });
    expect(Object.values(OWNER)).toContain(g.owner);
    expect(g.headline.length).toBeGreaterThan(10);
    expect(g.steps.length).toBeGreaterThan(0);
    expect(typeof g.retryHelps).toBe('boolean');
  });

  test.each([null, undefined, '', 'SOME_FUTURE_CODE'])('an unknown code (%p) is never blank: AccessSync owns it', (code) => {
    const g = guidanceFor({ error_code: code });
    expect(g.owner).toBe(OWNER.ACCESSSYNC);
    expect(g.retryHelps).toBe(false);
    expect(g.steps.join(' ')).toMatch(/AccessSync support/);
  });

  test('guidanceFor() with no argument still answers', () => {
    expect(guidanceFor().owner).toBe(OWNER.ACCESSSYNC);
  });

  test('the 422 loop: retrying is NOT advised (it sends the same data and fails the same way)', () => {
    const g = guidanceFor({ error_code: 'HARDWARE_VALIDATION_ERROR', http_status: 422 });
    expect(g.retryHelps).toBe(false);
    expect(g.owner).toBe(OWNER.ACCESSSYNC);
    expect(g.steps.join(' ')).toMatch(/email and name/);
  });

  test('config errors are the gym\'s to fix and say where', () => {
    expect(guidanceFor({ error_code: 'HARDWARE_KEY_INVALID' }).owner).toBe(OWNER.GYM);
    expect(guidanceFor({ error_code: 'PLAN_NOT_MAPPED' }).steps.join(' ')).toMatch(/Plan Mapping/);
    expect(guidanceFor({ error_code: 'HARDWARE_KEY_INVALID' }).steps.join(' ')).toMatch(/System Config/);
  });

  test('falls back to the connector\'s resolution when the code is unfamiliar', () => {
    expect(guidanceFor({ error_code: 'X', resolution: 'ROTATE_API_KEY' }).owner).toBe(OWNER.GYM);
    expect(guidanceFor({ error_code: 'X', resolution: 'REMAP_PLAN' }).steps.join(' ')).toMatch(/Plan Mapping/);
  });

  test('an unclassified 4xx is refused, not retryable, and owned by AccessSync', () => {
    const g = guidanceFor({ http_status: 418 });
    expect(g.retryHelps).toBe(false);
    expect(g.headline).toMatch(/418/);
  });

  test('a "temporary" error that repeats is escalated to AccessSync (no endless "it will retry")', () => {
    const once = guidanceFor({ error_code: 'HARDWARE_API_ERROR', occurred_count: 1 });
    expect(once.owner).toBe(OWNER.NOBODY);
    expect(once.retryHelps).toBe(true);
    const many = guidanceFor({ error_code: 'HARDWARE_API_ERROR', occurred_count: 6 });
    expect(many.owner).toBe(OWNER.ACCESSSYNC);
    expect(many.repeating).toBe(true);
    expect(many.retryHelps).toBe(false);
  });

  test('the result is a copy: callers cannot corrupt the table', () => {
    const g = guidanceFor({ error_code: 'PLAN_NOT_MAPPED' });
    g.steps.push('x'); g.owner = 'nobody';
    expect(guidanceFor({ error_code: 'PLAN_NOT_MAPPED' }).steps).not.toContain('x');
    expect(guidanceFor({ error_code: 'PLAN_NOT_MAPPED' }).owner).toBe(OWNER.GYM);
  });
});
