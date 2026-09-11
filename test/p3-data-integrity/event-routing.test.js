/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: one answer to "is this event type a grant or a revoke?"      │
 * │  (core/event-routing.js)                                                │
 * │                                                                         │
 * │  Business consequence: the reconciliation copy of the routing list was  │
 * │  missing plan.started and sent everything it did not recognise to       │
 * │  'revoke'. A delayed-start member whose grant crashed mid-flight had    │
 * │  the failed plan.started replayed as a REVOKE — on the day their access │
 * │  was due to begin (found 2026-09-10, reconciliation safety pass).       │
 * │                                                                         │
 * │  Guards:                                                                │
 * │    1. jobNameForEventType routes every known type correctly and never   │
 * │       promotes an unknown type to 'revoke'.                             │
 * │    2. The two lists are frozen, exact and disjoint.                     │
 * │    3. Drift guard (source text): callers carry no inline copy of either │
 * │       list and no `? 'grant' : 'revoke'` default, so a copy-paste       │
 * │       cannot reintroduce the drift.                                     │
 * │                                                                         │
 * │  Runtime impact: a few file reads + regex. Zero production impact.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const { GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES, jobNameForEventType } = require('../../core/event-routing');

const REPO_ROOT = path.join(__dirname, '..', '..');

const EXPECTED_GRANT  = ['plan.purchased', 'plan.started', 'payment.recovered', 'booking.confirmed'];
const EXPECTED_REVOKE = ['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'];

describe('[P3] event-routing — jobNameForEventType', () => {
  test.each(EXPECTED_GRANT)("'%s' → 'grant'", (eventType) => {
    expect(jobNameForEventType(eventType)).toBe('grant');
  });

  test.each(EXPECTED_REVOKE)("'%s' → 'revoke'", (eventType) => {
    expect(jobNameForEventType(eventType)).toBe('revoke');
  });

  test("REGRESSION: 'plan.started' → 'grant', never 'revoke'", () => {
    // The old reconciliation.js copy (_processRecordTargeted) listed grants as
    // [plan.purchased, payment.recovered, booking.confirmed] and sent everything
    // else to 'revoke' — so it classified plan.started as a REVOKE.
    expect(jobNameForEventType('plan.started')).toBe('grant');
  });

  test.each([
    ['an unknown type',                  'plan.renewed'],
    ['another unknown type',             'order.paused'],
    ['the empty string',                 ''],
    ['null',                             null],
    ['undefined',                        undefined],
    ["wrong case 'PLAN.CANCELLED'",      'PLAN.CANCELLED'],
    ["trailing space 'plan.cancelled '", 'plan.cancelled '],
    ["leading space ' plan.cancelled'",  ' plan.cancelled'],
    ['a raw Wix event name',             'wixPricingPlans.orderCanceled'],
    ['a number',                         42],
    ['an object carrying a revoke type', { eventType: 'plan.cancelled' }],
    ['an array holding a revoke type',   ['plan.cancelled']],
    ['a boxed String of a revoke type',  Object('plan.cancelled')],
  ])('%s → null (caller skips it), never a job', (_label, eventType) => {
    expect(jobNameForEventType(eventType)).toBeNull();
  });

  test("near-miss spellings of every known type are routed nowhere — least of all 'revoke'", () => {
    const misrouted = [];
    for (const t of [...EXPECTED_GRANT, ...EXPECTED_REVOKE]) {
      const variants = [
        t.toUpperCase(), ` ${t}`, `${t} `, `${t}\n`,
        t.replace('.', '_'), t.replace('.', ''), `${t}s`, t.split('.').reverse().join('.'),
      ];
      for (const v of variants) {
        const job = jobNameForEventType(v);
        if (job !== null) misrouted.push({ eventType: v, job });
      }
    }
    expect(misrouted).toEqual([]);
  });
});

describe('[P3] event-routing — the two lists', () => {
  test('the grant list is exactly the four grant types', () => {
    expect([...GRANT_EVENT_TYPES].sort()).toEqual([...EXPECTED_GRANT].sort());
  });

  test('the revoke list is exactly the four revoke types', () => {
    expect([...REVOKE_EVENT_TYPES].sort()).toEqual([...EXPECTED_REVOKE].sort());
  });

  test('both lists are frozen — a caller cannot push to, overwrite or truncate them', () => {
    expect(Object.isFrozen(GRANT_EVENT_TYPES)).toBe(true);
    expect(Object.isFrozen(REVOKE_EVENT_TYPES)).toBe(true);
    expect(() => GRANT_EVENT_TYPES.push('plan.cancelled')).toThrow(TypeError);
    expect(() => REVOKE_EVENT_TYPES.push('plan.started')).toThrow(TypeError);
    try { REVOKE_EVENT_TYPES[0] = 'plan.started'; } catch (_) { /* throws in strict mode */ }
    try { GRANT_EVENT_TYPES.length = 0; } catch (_) { /* throws in strict mode */ }
    expect([...GRANT_EVENT_TYPES].sort()).toEqual([...EXPECTED_GRANT].sort());
    expect([...REVOKE_EVENT_TYPES].sort()).toEqual([...EXPECTED_REVOKE].sort());
    expect(jobNameForEventType('plan.started')).toBe('grant');
  });

  test('the lists are disjoint — no type is both a grant and a revoke', () => {
    expect(GRANT_EVENT_TYPES.filter(t => REVOKE_EVENT_TYPES.includes(t))).toEqual([]);
  });

  test('neither list contains duplicates', () => {
    expect(new Set(GRANT_EVENT_TYPES).size).toBe(GRANT_EVENT_TYPES.length);
    expect(new Set(REVOKE_EVENT_TYPES).size).toBe(REVOKE_EVENT_TYPES.length);
  });
});

// ── Drift guard (source text) ────────────────────────────────────────────

/** Strip comments, so a comment quoting the old list cannot trip the guard. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
}

/** Every array literal whose elements are ALL quoted dotted event-type strings. */
function eventTypeArrays(code) {
  const found = [];
  for (const m of code.matchAll(/\[([^[\]]*)\]/g)) {
    const parts = m[1].split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) continue;
    const types = [];
    for (const part of parts) {
      const lit = /^(['"`])([a-z_]+\.[a-z_]+)\1$/.exec(part);
      if (!lit) { types.length = 0; break; }
      types.push(lit[2]);
    }
    if (types.length) found.push({ literal: m[0].replace(/\s+/g, ' '), types });
  }
  return found;
}

/**
 * Inline routing lists: two or more grant types and no revoke types, or the
 * reverse. A mixed list such as webhook-processor's _validateStructure
 * ['plan.purchased', 'plan.cancelled'] (which plan events need a planId) is not
 * a routing list and is allowed.
 */
function inlineRoutingLists(src) {
  return eventTypeArrays(stripComments(src))
    .filter(({ types }) => {
      const grants  = types.filter(t => GRANT_EVENT_TYPES.includes(t)).length;
      const revokes = types.filter(t => REVOKE_EVENT_TYPES.includes(t)).length;
      return (grants >= 2 && revokes === 0) || (revokes >= 2 && grants === 0);
    })
    .map(a => a.literal);
}

/** `? 'grant' : 'revoke'` (either order): an inline default for unrecognised types. */
const INLINE_JOB_DEFAULT = /\?\s*(['"`])(grant|revoke)\1\s*:\s*(['"`])(grant|revoke)\3/;

const IMPORTS_EVENT_ROUTING = /require\(\s*(['"`])[^'"`]*event-routing(?:\.js)?\1\s*\)/;

function readSource(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function inlineJobDefault(src) {
  const m = INLINE_JOB_DEFAULT.exec(stripComments(src));
  return m ? m[0].replace(/\s+/g, ' ') : null;
}

describe('[P3] event-routing — drift guard scanner self-check', () => {
  test('catches the historical reconciliation copy: inline grant list + default to revoke', () => {
    const old = `
      const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
        ? 'grant'
        : 'revoke';`;
    expect(inlineRoutingLists(old)).toHaveLength(1);
    expect(inlineJobDefault(old)).not.toBeNull();
  });

  test('catches the historical webhook-processor copies: full grant and revoke lists, either quote style', () => {
    const old = `
      if (["plan.purchased", "plan.started", "payment.recovered", "booking.confirmed"].includes(t)) {}
      else if (['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'].includes(t)) {}`;
    expect(inlineRoutingLists(old)).toHaveLength(2);
  });

  test('ignores the mixed _validateStructure list and comments that quote the old list', () => {
    const ok = `
      if (['plan.purchased', 'plan.cancelled'].includes(event.eventType)) {}
      // was: ['plan.purchased', 'payment.recovered', 'booking.confirmed'] ? 'grant' : 'revoke'
      /* also was ['plan.cancelled', 'payment.failed'] */
      const url = 'https://example.com/a'; // ['plan.purchased', 'plan.started']`;
    expect(inlineRoutingLists(ok)).toEqual([]);
    expect(inlineJobDefault(ok)).toBeNull();
  });

  test('recognises both import spellings of event-routing', () => {
    expect(IMPORTS_EVENT_ROUTING.test("const { jobNameForEventType } = require('./event-routing');")).toBe(true);
    expect(IMPORTS_EVENT_ROUTING.test("require('../../core/event-routing.js')")).toBe(true);
    expect(IMPORTS_EVENT_ROUTING.test("require('./revoke-policy')")).toBe(false);
  });
});

describe('[P3] event-routing — drift guard: core callers route through event-routing.js', () => {
  // NOTE: both files are being migrated to event-routing.js in a parallel change.
  // Until reconciliation.js (_processRecordTargeted) drops its own grant list and
  // its `? 'grant' : 'revoke'` default, the reconciliation rows here are EXPECTED
  // to be red. Re-run after that change lands; this asserts the end state.
  const CORE_CALLERS = ['core/webhook-processor.js', 'core/reconciliation.js'];

  test.each(CORE_CALLERS)('%s carries no inline grant/revoke routing list', (rel) => {
    expect(inlineRoutingLists(readSource(rel))).toEqual([]);
  });

  test.each(CORE_CALLERS)("%s never defaults an unrecognised type to a job (no `? 'grant' : 'revoke'`)", (rel) => {
    expect(inlineJobDefault(readSource(rel))).toBeNull();
  });

  test.each(CORE_CALLERS)('%s imports core/event-routing.js', (rel) => {
    expect(IMPORTS_EVENT_ROUTING.test(readSource(rel))).toBe(true);
  });
});

describe('[P3] event-routing — drift guard: admin Retry handlers (SAME BUG, outside the core migration)', () => {
  // Found while building the guard above. Three admin "retry" handlers carry the
  // exact drifted copy — grant = [plan.purchased, payment.recovered,
  // booking.confirmed], everything else → 'revoke':
  //   admin/routes/errors.js   POST /admin/errors/:id/retry
  //   admin/routes/errors.js   POST /admin/errors/bulk-retry
  //   admin/routes/members.js  POST /admin/members/:id/retry
  // Each replays a failed error_queue row. An operator pressing Retry (or Bulk
  // retry) on a failed plan.started grant therefore enqueues a REVOKE for that
  // member. Not part of the in-flight core change: these stay red until fixed.
  const ADMIN_REPLAY_ROUTES = ['admin/routes/errors.js', 'admin/routes/members.js'];

  test.each(ADMIN_REPLAY_ROUTES)('%s carries no inline grant/revoke routing list', (rel) => {
    expect(inlineRoutingLists(readSource(rel))).toEqual([]);
  });

  test.each(ADMIN_REPLAY_ROUTES)("%s never defaults an unrecognised type to a job (no `? 'grant' : 'revoke'`)", (rel) => {
    expect(inlineJobDefault(readSource(rel))).toBeNull();
  });
});
