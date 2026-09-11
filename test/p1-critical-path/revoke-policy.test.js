/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: the reconciliation sweep's removal policy                    │
 * │  (core/revoke-policy.js, v3) decides whether an automated sweep may     │
 * │  take door access away from real, paying members.                       │
 * │                                                                         │
 * │  Business consequence: a wrong "proceed" locks paying members out of    │
 * │  the gym. The 2026-09-10 safety pass found three production defects in  │
 * │  the old gate (never armed at House of Gains' 3 members; only one of    │
 * │  four revoke paths gated; a confirmed drop revoked members who had      │
 * │  reappeared). v3 replaces the conditional re-fetch with an always-on    │
 * │  double read (done by the caller) and adds observation-only, a          │
 * │  tri-state mode and time-based strikes. This file pins the policy, then │
 * │  attacks it.                                                            │
 * │                                                                         │
 * │  Layout:                                                                │
 * │    1. Spec — constants, normalizeMode, thresholds, strikeSatisfied,     │
 * │       evaluateRemovals (validation → instability → mass cap →          │
 * │       observationOnly → mode → strikes → proceed), plus the fix-round  │
 * │       contracts: P-1 units (a family is one unit), P-2 classification  │
 * │       (only ENDED / ABSENT removable), P-3 strict strike `since`, and   │
 * │       fix round 3: R3-1 unit structure + source→dataSource pairing,     │
 * │       R3-2 an EMPTY batch is still judged for instability.              │
 * │    2. Invariants — deterministic property loops over generated batches  │
 * │       (sizes 0..12 × data-source mixes × key/unit patterns × strike     │
 * │       states; no randomness). Caps are stated in distinct UNITS. Every  │
 * │       generated proposal is well-formed under R3-1 (checked).           │
 * │    3. ADVERSARIAL A1–A11 — inputs that try to make the policy remove    │
 * │       when it should hold. Each asserts the SAFE outcome. A red test    │
 * │       here is a finding about the policy, not a flaky test: do not edit │
 * │       it to match the code — fix the policy or get a SAGE ruling.       │
 * │    4. Adversarial guards.                                               │
 * │                                                                         │
 * │  Most tests run ARMED (observationOnly:false, mode:'on', every strike    │
 * │  ripe) — the most permissive configuration — so a safety check that    │
 * │  holds here holds everywhere.                                           │
 * │                                                                         │
 * │  Pure unit tests: no DB, no queue, no mocks, no clock.                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');

const {
  REVOKE_SOURCE,
  DATA_SOURCE,
  REVOKE_MODE,
  REVOKE_HOLD_REASON,
  ANOMALY_HOLD_REASONS,
  DEFAULT_STRIKE_POLICY,
  REMOVABLE_CLASSIFICATIONS,
  CLASSIFICATION_REQUIRED_SOURCES,
  DATA_SOURCES_BY_SOURCE,
  REVOKE_MIN_ABSOLUTE,
  normalizeMode,
  revalidationThreshold,
  massRevokeThreshold,
  strikeSatisfied,
  evaluateRemovals,
} = require('../../core/revoke-policy');

const { WIX_ABSENCE, ROLE_DRIFT, HOLDER_LAPSE, KISI_USER_VANISHED } = REVOKE_SOURCE;
const { WIX_ORDERS, WIX_BOOKINGS, KISI, DB } = DATA_SOURCE;
const ALL_DATA_SOURCES = [WIX_ORDERS, WIX_BOOKINGS, KISI, DB];
const R = REVOKE_HOLD_REASON;

// ── Fixed clock and strike policy (no Date.now anywhere in this file) ────────

const HOUR  = 60 * 60 * 1000;
const NOW   = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10T12:00:00Z
const iso   = (ms) => new Date(ms).toISOString();
const STRIKE_POLICY = { minAgeMs: 48 * HOUR, minObservations: 3 };

const RIPE      = Object.freeze({ since: iso(NOW - 72 * HOUR), observations: 5 });  // both met
const FRESH     = Object.freeze({ since: iso(NOW - 20 * HOUR), observations: 5 });  // age not met
const FEW       = Object.freeze({ since: iso(NOW - 72 * HOUR), observations: 2 });  // observations not met
const NEITHER   = Object.freeze({ since: iso(NOW - 1 * HOUR),  observations: 1 });  // neither met
const NO_CLOCK  = Object.freeze({ since: null, observations: 0 });                  // clock never started

// ── Helpers ──────────────────────────────────────────────────────────────

const DEFAULT_DS = {
  [WIX_ABSENCE]:        WIX_ORDERS,
  [HOLDER_LAPSE]:       WIX_ORDERS,
  [ROLE_DRIFT]:         KISI,
  [KISI_USER_VANISHED]: KISI,
};

// P-2: Wix-absence sources must say which kind of absence. Kisi sources need none.
const DEFAULT_CLASSIFICATION = {
  [WIX_ABSENCE]:  'ENDED',
  [HOLDER_LAPSE]: 'ENDED',
};

/**
 * One removal proposal, ripe unless overridden. Wix-absence sources carry a
 * removable classification ('ENDED') by default. No unitKey unless given (the
 * member is its own unit). Extra fields ride along untouched.
 */
function prop(memberKey, source = WIX_ABSENCE, extra = {}) {
  const base = { source, memberKey, dataSource: DEFAULT_DS[source] || WIX_ORDERS, strike: RIPE };
  if (DEFAULT_CLASSIFICATION[source]) base.classification = DEFAULT_CLASSIFICATION[source];
  return { ...base, ...extra };
}

/**
 * One family: the holder (WIX_ABSENCE) plus `subs` sub-members (HOLDER_LAPSE),
 * all sharing the holder's key as unitKey. `extra` applies to every proposal.
 */
function family(holderKey, subs = 2, extra = {}) {
  return [
    prop(holderKey, WIX_ABSENCE, { unitKey: holderKey, ...extra }),
    ...Array.from({ length: subs }, (_, i) =>
      prop(`${holderKey}###as${i}`, HOLDER_LAPSE, { unitKey: holderKey, ...extra })),
  ];
}

/**
 * R3-1, stated independently of the module: the data sources each source's
 * evidence may be filed under.
 */
const LEGAL_DATA_SOURCES = {
  [WIX_ABSENCE]:        [WIX_ORDERS, WIX_BOOKINGS],
  [HOLDER_LAPSE]:       [WIX_ORDERS],
  [ROLE_DRIFT]:         [KISI],
  [KISI_USER_VANISHED]: [KISI],
};

/**
 * The same proposals with the family collapse undone — every member its own
 * unit — while staying well-formed under R3-1: a primary or Kisi proposal drops
 * its unitKey; a sub (HOLDER_LAPSE) gets a unit of its own that is not its
 * memberKey, as if each sub had a different holder. What a caller that failed
 * to collapse the family would send. (Merely stripping a sub's unitKey no
 * longer means "its own unit": that is unit_structure_invalid.)
 */
function ungrouped(list) {
  return list.map(({ unitKey: _unit, ...p }) =>
    (p.source === HOLDER_LAPSE ? { ...p, unitKey: `solo:${p.memberKey}` } : p));
}

/** n distinct member keys: m0 … m(n-1). */
function keys(n, prefix = 'm') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`);
}

/** One ripe WIX_ABSENCE (wix_orders) proposal per member key. */
function wixProps(memberKeys, extra = {}) {
  return memberKeys.map(k => prop(k, WIX_ABSENCE, extra));
}

/** Distinct UNITS in a list of proposals (unitKey, defaulting to memberKey). */
function unitSet(list) {
  return new Set(list.map(p => (p.unitKey === undefined ? p.memberKey : p.unitKey)));
}

/**
 * evaluateRemovals ARMED: removal enabled, mode 'on', reads agreed, fixed clock.
 * Every safety check is exercised in the most permissive configuration.
 */
function armed(args) {
  return evaluateRemovals({
    readDisagreement: {},
    mode: 'on',
    observationOnly: false,
    now: NOW,
    strikePolicy: STRIKE_POLICY,
    ...args,
  });
}

/** Run fn; report a throw instead of propagating it. */
function outcome(fn) {
  try {
    return { threw: null, value: fn() };
  } catch (err) {
    return { threw: err, value: null };
  }
}

/**
 * Safe outcome for a hostile input: the policy either refuses it by throwing
 * (no flush list ever reaches the caller, so nothing is removed) or returns a
 * hold with nothing to flush.
 */
function expectFailsClosed(fn) {
  const { threw, value } = outcome(fn);
  if (threw) return;
  expect({ action: value.action, flushed: value.flush.length })
    .toEqual({ action: 'hold', flushed: 0 });
}

/** What the sweep would actually remove; a throw removes nothing. */
function removedBy(args) {
  const { threw, value } = outcome(() => armed(args));
  return threw ? [] : value.flush;
}

function fmt(v) {
  if (typeof v === 'string') return `'${v}'`;
  if (v instanceof Date) return `Date(${v.toISOString()})`;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// ═════════════════════════════════════════════════════════════════════════
// 1. SPEC
// ═════════════════════════════════════════════════════════════════════════

describe('[P1] revoke-policy — exported vocabulary', () => {
  test('REVOKE_SOURCE keeps its v2 names and values', () => {
    expect(REVOKE_SOURCE).toEqual({
      KISI_USER_VANISHED: 'kisi_user_vanished',
      ROLE_DRIFT:         'role_drift',
      HOLDER_LAPSE:       'holder_lapse',
      WIX_ABSENCE:        'wix_absence',
    });
  });

  test('DATA_SOURCE, REVOKE_MODE and REVOKE_HOLD_REASON match the Phase 1 spec', () => {
    expect(DATA_SOURCE).toEqual({ WIX_ORDERS: 'wix_orders', WIX_BOOKINGS: 'wix_bookings', KISI: 'kisi', DB: 'db' });
    expect(REVOKE_MODE).toEqual({ OFF: 'off', DRY_RUN: 'dry_run', ON: 'on' });
    expect(REVOKE_HOLD_REASON).toEqual({
      INVALID_PROPOSAL:  'invalid_proposal',
      SNAPSHOT_UNSTABLE: 'snapshot_unstable',
      MASS_REVOKE:       'mass_revoke',
      AUTO_REVOKE_OFF:   'auto_revoke_off',
      DRY_RUN:           'dry_run',
      STRIKE_PENDING:    'strike_pending',
      OBSERVATION_ONLY:  'observation_only',
    });
  });

  test('ANOMALY_HOLD_REASONS is exactly invalid input, unstable snapshot, mass revoke', () => {
    expect([...ANOMALY_HOLD_REASONS].sort()).toEqual([R.INVALID_PROPOSAL, R.MASS_REVOKE, R.SNAPSHOT_UNSTABLE].sort());
  });

  test.each([
    ['operator mode off',  R.AUTO_REVOKE_OFF],
    ['operator dry run',   R.DRY_RUN],
    ['strike pending',     R.STRIKE_PENDING],
    ['observation only',   R.OBSERVATION_ONLY],
  ])('%s is a choice or a wait, not a data anomaly', (_label, reason) => {
    expect(ANOMALY_HOLD_REASONS).not.toContain(reason);
  });

  test('exported vocabularies are frozen (a caller cannot widen them at runtime)', () => {
    for (const obj of [REVOKE_SOURCE, DATA_SOURCE, REVOKE_MODE, REVOKE_HOLD_REASON, ANOMALY_HOLD_REASONS, DEFAULT_STRIKE_POLICY,
      REMOVABLE_CLASSIFICATIONS, CLASSIFICATION_REQUIRED_SOURCES, DATA_SOURCES_BY_SOURCE, ...Object.values(DATA_SOURCES_BY_SOURCE)]) {
      expect(Object.isFrozen(obj)).toBe(true);
    }
  });

  test('P-2: only ENDED and ABSENT are removable, and only the Wix-absence sources require a classification', () => {
    expect([...REMOVABLE_CLASSIFICATIONS].sort()).toEqual(['ABSENT', 'ENDED']);
    expect([...CLASSIFICATION_REQUIRED_SOURCES].sort()).toEqual([HOLDER_LAPSE, WIX_ABSENCE].sort());
  });

  test("R3-1: each source may be filed only under the read its evidence comes from — and no source under 'db'", () => {
    expect(Object.keys(DATA_SOURCES_BY_SOURCE).sort()).toEqual(Object.values(REVOKE_SOURCE).sort());
    for (const source of Object.values(REVOKE_SOURCE)) {
      expect([...DATA_SOURCES_BY_SOURCE[source]].sort()).toEqual([...LEGAL_DATA_SOURCES[source]].sort());
    }
    expect(Object.values(DATA_SOURCES_BY_SOURCE).flat()).not.toContain(DB);
  });

  test('DEFAULT_STRIKE_POLICY is the approved ~2 days over at least 3 observations', () => {
    expect(DEFAULT_STRIKE_POLICY).toEqual({ minAgeMs: 48 * HOUR, minObservations: 3 });
  });
});

describe('[P1] revoke-policy — purity: no clock, no randomness, no I/O', () => {
  const SOURCE = fs.readFileSync(require.resolve('../../core/revoke-policy'), 'utf8');

  test('the module source never reads the clock or randomness, and requires nothing', () => {
    expect(SOURCE).not.toMatch(/Date\.now/);
    expect(SOURCE).not.toMatch(/new Date\(/);
    expect(SOURCE).not.toMatch(/Math\.random/);
    expect(SOURCE).not.toMatch(/\brequire\(/);
    expect(SOURCE).not.toMatch(/process\.env/);
  });

  test('evaluateRemovals never calls Date.now or Math.random at runtime', () => {
    const nowSpy  = jest.spyOn(Date, 'now').mockImplementation(() => { throw new Error('policy read the clock'); });
    const randSpy = jest.spyOn(Math, 'random').mockImplementation(() => { throw new Error('policy used randomness'); });
    try {
      const proposals = [prop('a'), prop('b', ROLE_DRIFT, { strike: FRESH })];
      const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 300 } });
      expect(d.action).toBe('proceed');
      expect(nowSpy).not.toHaveBeenCalled();
      expect(randSpy).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
      randSpy.mockRestore();
    }
  });

  test('the same input always gives the same decision, and "now" is what moves the strike', () => {
    const proposals = [prop('a', WIX_ABSENCE, { strike: { since: iso(NOW - 47 * HOUR), observations: 3 } })];
    const args = { proposals, currentManaged: 10, populationByDataSource: { wix_orders: 10 } };
    expect(armed(args)).toEqual(armed(args));
    expect(armed(args).reason).toBe(R.STRIKE_PENDING);
    expect(armed({ ...args, now: NOW + 1 * HOUR }).action).toBe('proceed');
  });
});

describe('[P1] revoke-policy — normalizeMode: fail-closed to off', () => {
  test.each([
    ['on', 'on'],
    ['dry_run', 'dry_run'],
    ['off', 'off'],
  ])('%p → %p', (raw, expected) => {
    expect(normalizeMode(raw)).toBe(expected);
  });

  test.each([
    ['null (column read failed)', null],
    ['undefined (migration not applied)', undefined],
    ["'ON' (wrong case)", 'ON'],
    ["' on' (padded)", ' on'],
    ["'on ' (padded)", 'on '],
    ["'DRY_RUN'", 'DRY_RUN'],
    ["'dry-run' (hyphen)", 'dry-run'],
    ["'dryrun'", 'dryrun'],
    ["'true'", 'true'],
    ['true (v2 boolean switch)', true],
    ['false', false],
    ['1', 1],
    ["''", ''],
    ['an empty object', {}],
    ["a boxed String('on')", Object('on')],
    ["['on']", ['on']],
    ["{ toString: () => 'on' }", { toString: () => 'on' }],
  ])('%s → off', (_label, raw) => {
    expect(normalizeMode(raw)).toBe('off');
  });
});

describe('[P1] revoke-policy — revalidationThreshold (instability threshold, v2 semantics)', () => {
  test.each([
    [0,   2],
    [1,   2],
    [3,   2],   // House of Gains today
    [8,   2],
    [9,   3],
    [10,  3],
    [300, 75],
    [303, 76],
  ])('population %p → %p', (population, expected) => {
    expect(revalidationThreshold(population)).toBe(expected);
  });

  test('never below REVOKE_MIN_ABSOLUTE (2) for any population 0…400', () => {
    expect(REVOKE_MIN_ABSOLUTE).toBe(2);
    const violations = [];
    for (let p = 0; p <= 400; p++) {
      const t = revalidationThreshold(p);
      if (!(Number.isInteger(t) && t >= REVOKE_MIN_ABSOLUTE)) violations.push({ p, t });
    }
    expect(violations).toEqual([]);
  });

  test('garbage populations never throw and never produce NaN', () => {
    const bad = [];
    for (const p of [null, undefined, NaN, -1, -300, 0, '', 'abc', '12.5', {}, [], true, false]) {
      const { threw, value: t } = outcome(() => revalidationThreshold(p));
      if (threw) bad.push(`${fmt(p)} threw ${threw.message}`);
      else if (!Number.isInteger(t) || t < REVOKE_MIN_ABSOLUTE) bad.push(`${fmt(p)} → ${t}`);
    }
    expect(bad).toEqual([]);
  });

  test("numeric strings are read as numbers ('300' → 75); negative / NaN fall back to the floor", () => {
    expect(revalidationThreshold('300')).toBe(75);
    expect(revalidationThreshold(-300)).toBe(2);
    expect(revalidationThreshold(NaN)).toBe(2);
  });
});

describe('[P1] revoke-policy — massRevokeThreshold: strictly more than half', () => {
  test.each([
    [0, 1], [1, 1], [2, 2], [3, 2], [4, 3], [5, 3], [10, 6], [300, 151], [301, 151], [303, 152],
  ])('population %p → %p', (population, expected) => {
    expect(massRevokeThreshold(population)).toBe(expected);
  });

  test('is always > population / 2 for 0…400', () => {
    const violations = [];
    for (let p = 0; p <= 400; p++) {
      const t = massRevokeThreshold(p);
      if (!(t > p / 2) || !(t - 1 <= p / 2)) violations.push({ p, t });
    }
    expect(violations).toEqual([]);
  });

  test('garbage never throws and never produces NaN', () => {
    for (const p of [null, undefined, NaN, -5, 'abc', {}, []]) {
      const t = massRevokeThreshold(p);
      expect(Number.isFinite(t)).toBe(true);
    }
  });
});

describe('[P1] revoke-policy — strikeSatisfied: BOTH minAge AND minObservations', () => {
  test.each([
    ['ripe (72h, 5 obs)',                         RIPE,                                                   true],
    ['exactly on both boundaries (48h, 3 obs)',   { since: iso(NOW - 48 * HOUR), observations: 3 },      true],
    ['1 ms short of the age',                     { since: iso(NOW - 48 * HOUR + 1), observations: 3 },  false],
    ['one observation short',                     { since: iso(NOW - 48 * HOUR), observations: 2 },      false],
    ['age met, observations not (FEW)',           FEW,                                                    false],
    ['observations met, age not (FRESH)',         FRESH,                                                  false],
    ['neither met',                               NEITHER,                                                false],
    ['clock never started (since null)',          NO_CLOCK,                                               false],
    ['since null even with many observations',    { since: null, observations: 99 },                     false],
    ['since in the future (clock skew)',          { since: iso(NOW + HOUR), observations: 9 },           false],
    ['a Date object for since (pg timestamptz)',  { since: new Date(NOW - 72 * HOUR), observations: 3 }, true],
    ['no strike at all (undefined)',              undefined,                                              false],
    ['null strike',                               null,                                                   false],
    ['unparseable since',                         { since: 'yesterday-ish', observations: 9 },           false],
    ['observations as a string',                  { since: iso(NOW - 72 * HOUR), observations: '9' },    false],
    ['fractional observations',                   { since: iso(NOW - 72 * HOUR), observations: 3.5 },    false],
  ])('%s → %p', (_label, strike, expected) => {
    expect(strikeSatisfied(strike, NOW, STRIKE_POLICY)).toBe(expected);
  });

  test.each([
    ['undefined policy', undefined],
    ['empty policy', {}],
    ['negative minAgeMs', { minAgeMs: -1, minObservations: 3 }],
    ['NaN minAgeMs', { minAgeMs: NaN, minObservations: 3 }],
    ['string minObservations', { minAgeMs: 0, minObservations: '3' }],
  ])('a garbage policy (%s) never satisfies a strike', (_label, policy) => {
    expect(strikeSatisfied(RIPE, NOW, policy)).toBe(false);
  });

  test.each([undefined, null, NaN, '1757505600000'])('a garbage now (%p) never satisfies a strike', (now) => {
    expect(strikeSatisfied(RIPE, now, STRIKE_POLICY)).toBe(false);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: empty batch', () => {
  test.each([
    ['on', false], ['off', false], ['dry_run', false], [undefined, true], [null, undefined],
  ])('no proposals, reads agreed → proceed with nothing in any bucket (mode %p, observationOnly %p)', (mode, observationOnly) => {
    const d = evaluateRemovals({
      proposals: [], currentManaged: 3, populationByDataSource: { wix_orders: 3 },
      readDisagreement: {}, mode, observationOnly, now: NOW, strikePolicy: STRIKE_POLICY,
    });
    expect(d.action).toBe('proceed');
    expect(d.reason).toBeNull();
    expect([d.flush, d.held, d.strikePending]).toEqual([[], [], []]);
    expect(d.counts.proposals).toBe(0);
  });

  test.each([null, undefined, 'not-a-list', {}])('proposals=%p is a caller bug → hold invalid_proposal, nothing flushed', (proposals) => {
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('proposals_not_array');
    expect(d.flush).toEqual([]);
  });

  test('called with no arguments at all → hold invalid_proposal', () => {
    const d = evaluateRemovals();
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
  });
});

describe('[P1] revoke-policy — R3-2 an EMPTY batch is still judged for instability', () => {
  // Nothing proposed means nothing can be removed — but the caller moves strike
  // clocks after any decision that is not an anomaly. An empty batch used to
  // return 'proceed' before the instability check, so a sweep whose two reads
  // disagreed badly cleared clocks and raised no anomaly.
  function empty(over = {}) {
    return evaluateRemovals({
      proposals: [], currentManaged: 3, populationByDataSource: { wix_orders: 3 },
      readDisagreement: {}, mode: 'on', observationOnly: false, now: NOW, strikePolicy: STRIKE_POLICY,
      ...over,
    });
  }

  test('HOG: nothing proposed, but 2 of 3 orders units flipped between the reads → hold snapshot_unstable (it used to proceed)', () => {
    const proposals = [];
    const d = empty({ proposals, readDisagreement: { wix_orders: 2 } });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.dataSource).toBe(WIX_ORDERS);
    expect(d.detail).toBe('read_disagreement');
    expect([d.flush, d.held, d.strikePending]).toEqual([[], [], []]);
    for (const list of [d.flush, d.held, d.strikePending]) expect(list).not.toBe(proposals);
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('the second read came back empty (OB-85 signature: every paying unit "disagreed"), nothing proposed → snapshot_unstable', () => {
    const d = empty({ readDisagreement: { wix_orders: 3 } });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.flush).toEqual([]);
  });

  // The same table as the non-empty instability tests: one rule for both.
  test.each([
    [3,   0,   false],
    [3,   1,   false],
    [3,   2,   true],
    [3,   3,   true],
    [10,  2,   false],
    [10,  3,   true],
    [300, 74,  false],
    [300, 75,  true],
    [300, 150, true],
  ])('wix_orders population %p, %p units disagreed, nothing proposed → unstable=%p — the same verdict as a non-empty batch', (population, disagreed, unstable) => {
    const args = { currentManaged: population, populationByDataSource: { wix_orders: population }, readDisagreement: { wix_orders: disagreed } };
    const d = empty(args);
    const nonEmpty = armed({ ...args, proposals: [prop('a')] });
    expect(d.reason === R.SNAPSHOT_UNSTABLE).toBe(unstable);
    expect(nonEmpty.reason === R.SNAPSHOT_UNSTABLE).toBe(unstable);
    if (unstable) {
      expect(d.action).toBe('hold');
      expect(d.dataSource).toBe(WIX_ORDERS);
      expect(d.detail).toBe('read_disagreement');
    } else {
      expect(d.action).toBe('proceed');
      expect(d.reason).toBeNull();
      expect(d.dataSource).toBeNull();
      expect(d.detail).toBeNull();
    }
    expect([d.flush, d.held, d.strikePending]).toEqual([[], [], []]);
  });

  test('a disagreement below the threshold → proceed, reason null (unchanged)', () => {
    for (const [population, disagreed] of [[3, 1], [10, 2], [300, 74]]) {
      const d = empty({ currentManaged: population, populationByDataSource: { wix_orders: population }, readDisagreement: { wix_orders: disagreed } });
      expect(d.action).toBe('proceed');
      expect(d.reason).toBeNull();
    }
  });

  test('each data source is judged against ITS OWN population (10 disagreements: noise for 300 orders units, a flap for 12 booking units)', () => {
    const pops = { populationByDataSource: { wix_orders: 300, wix_bookings: 12 } };
    expect(empty({ ...pops, readDisagreement: { wix_orders: 10 } }).action).toBe('proceed');
    const d = empty({ ...pops, readDisagreement: { wix_bookings: 10 } });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.dataSource).toBe(WIX_BOOKINGS);
  });

  test('every data source present in both readDisagreement and the populations is judged, kisi and db included', () => {
    for (const ds of [KISI, DB]) {
      const d = empty({ populationByDataSource: { wix_orders: 3, [ds]: 4 }, readDisagreement: { wix_orders: 0, [ds]: 2 } });
      expect({ ds, reason: d.reason, dataSource: d.dataSource }).toEqual({ ds, reason: R.SNAPSHOT_UNSTABLE, dataSource: ds });
    }
  });

  test('two unstable data sources: the reported one does not depend on the caller\'s key order', () => {
    const d1 = empty({ populationByDataSource: { wix_orders: 10, kisi: 10 }, readDisagreement: { kisi: 5, wix_orders: 5 } });
    const d2 = empty({ populationByDataSource: { kisi: 10, wix_orders: 10 }, readDisagreement: { wix_orders: 5, kisi: 5 } });
    expect(d1.dataSource).toBe(WIX_ORDERS);
    expect(d2).toEqual(d1);
  });

  test.each([
    ['observation only',                 { observationOnly: true }],
    ['mode off',                         { mode: 'off' }],
    ['mode dry_run',                     { mode: 'dry_run' }],
    ['mode unreadable',                  { mode: null }],
    ['fully armed (on, observationOnly false)', { mode: 'on', observationOnly: false }],
  ])('instability is reported whatever the arming (%s): nothing to hold, but the anomaly still counts', (_label, over) => {
    const d = empty({ populationByDataSource: { wix_orders: 10 }, readDisagreement: { wix_orders: 5 }, ...over });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.flush).toEqual([]);
  });

  test('a disagreement with no population to judge it by → hold invalid_proposal (missing_population_for_disagreement)', () => {
    const d = empty({ populationByDataSource: { wix_orders: 3 }, readDisagreement: { wix_bookings: 4 } });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('missing_population_for_disagreement');
    expect([d.flush, d.held, d.strikePending]).toEqual([[], [], []]);
    expect(d.counts.proposedUnits).toBeNull(); // untrusted input is never counted
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('a zero disagreement needs no population (a data source read once reports nothing) → proceed', () => {
    const d = empty({ populationByDataSource: { wix_orders: 3 }, readDisagreement: { wix_bookings: 0, kisi: 0 } });
    expect(d.action).toBe('proceed');
    expect(d.reason).toBeNull();
  });

  test('the counts on an empty-batch hold describe the read that tripped it', () => {
    const d = empty({ currentManaged: 12, populationByDataSource: { wix_orders: 12, kisi: 12 }, readDisagreement: { wix_orders: 3 } });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.counts).toMatchObject({ proposals: 0, proposedUnits: 0, proposedMembers: 0, flush: 0, held: 0, strikePending: 0, strikeReady: 0 });
    expect(d.counts.byDataSource.wix_orders).toEqual({
      proposedUnits: 0, proposedMembers: 0, population: 12, readDisagreement: 3, instabilityThreshold: 3, massThreshold: 7,
    });
    expect(d.counts.byDataSource.kisi).toMatchObject({ population: 12, readDisagreement: 0 });
  });

  // Population / readDisagreement defects: one rule and one detail, whether or
  // not anything is proposed.
  const POPULATION_AND_DISAGREEMENT_DEFECTS = [
    ['populationByDataSource missing',          a => { delete a.populationByDataSource; },                          'invalid_population_by_data_source'],
    ['populationByDataSource null',             a => { a.populationByDataSource = null; },                          'invalid_population_by_data_source'],
    ['populationByDataSource an array',         a => { a.populationByDataSource = [10]; },                          'invalid_population_by_data_source'],
    ['populationByDataSource a Map',            a => { a.populationByDataSource = new Map([['wix_orders', 10]]); }, 'invalid_population_by_data_source'],
    ["population keyed 'wix' (v2 name)",        a => { a.populationByDataSource.wix = 10; },                        'unknown_population_key:wix'],
    ["population '10' (string)",                a => { a.populationByDataSource.wix_orders = '10'; },               'invalid_population:wix_orders'],
    ['population 2.5',                          a => { a.populationByDataSource.wix_orders = 2.5; },                'invalid_population:wix_orders'],
    ['population -1 for another data source',   a => { a.populationByDataSource.db = -1; },                         'invalid_population:db'],
    ['population NaN',                          a => { a.populationByDataSource.kisi = NaN; },                      'invalid_population:kisi'],
    ['readDisagreement missing',                a => { delete a.readDisagreement; },                                'invalid_read_disagreement'],
    ['readDisagreement null',                   a => { a.readDisagreement = null; },                                'invalid_read_disagreement'],
    ['readDisagreement an array',               a => { a.readDisagreement = [5]; },                                 'invalid_read_disagreement'],
    ['readDisagreement a number',               a => { a.readDisagreement = 5; },                                   'invalid_read_disagreement'],
    ['readDisagreement a Map',                  a => { a.readDisagreement = new Map([['wix_orders', 5]]); },        'invalid_read_disagreement'],
    ["readDisagreement keyed 'wix' (v2 name)",  a => { a.readDisagreement = { wix: 5 }; },                          'unknown_read_disagreement_key:wix'],
    ['readDisagreement negative',               a => { a.readDisagreement = { wix_orders: -3 }; },                  'invalid_read_disagreement:wix_orders'],
    ["readDisagreement '5' (string)",           a => { a.readDisagreement = { wix_orders: '5' }; },                 'invalid_read_disagreement:wix_orders'],
    ['readDisagreement 1.5',                    a => { a.readDisagreement = { wix_orders: 1.5 }; },                 'invalid_read_disagreement:wix_orders'],
    ['readDisagreement NaN',                    a => { a.readDisagreement = { wix_orders: NaN }; },                 'invalid_read_disagreement:wix_orders'],
    ['a disagreement with no population',       a => { a.readDisagreement = { wix_bookings: 4 }; },                 'missing_population_for_disagreement'],
  ];

  test.each(POPULATION_AND_DISAGREEMENT_DEFECTS)('%s → hold invalid_proposal (%s), for an empty batch and a non-empty batch alike', (_label, mutate, detail) => {
    for (const proposals of [[], [prop('a')]]) {
      const args = {
        proposals, currentManaged: 10, populationByDataSource: { wix_orders: 10 },
        readDisagreement: {}, mode: 'on', observationOnly: false, now: NOW, strikePolicy: STRIKE_POLICY,
      };
      expect(evaluateRemovals(args).action).toBe('proceed'); // control: the unmutated input proceeds
      mutate(args);
      const d = evaluateRemovals(args);
      expect({ proposed: proposals.length, action: d.action, reason: d.reason, detail: d.detail })
        .toEqual({ proposed: proposals.length, action: 'hold', reason: R.INVALID_PROPOSAL, detail });
      expect(d.flush).toEqual([]);
      expect(d.strikePending).toEqual([]);
      expect(d.held).toHaveLength(proposals.length);
      d.held.forEach((h, i) => expect(h).toBe(proposals[i]));
      expect(d.counts.proposedUnits).toBeNull();
    }
  });
});

describe('[P1] revoke-policy — evaluateRemovals: validation (invalid_proposal holds the WHOLE batch)', () => {
  const GOOD = () => ({
    proposals: [prop('a'), prop('b', ROLE_DRIFT)],
    currentManaged: 300,
    populationByDataSource: { wix_orders: 300, kisi: 300 },
  });

  // Each case mutates a well-formed, otherwise-proceeding input in one way.
  test.each([
    ['memberKey missing',                    a => { delete a.proposals[0].memberKey; },                  'missing_member_key'],
    ['memberKey null',                       a => { a.proposals[0].memberKey = null; },                  'missing_member_key'],
    ["memberKey ''",                         a => { a.proposals[0].memberKey = ''; },                    'missing_member_key'],
    ["memberKey '   ' (whitespace only)",    a => { a.proposals[0].memberKey = '   '; },                 'missing_member_key'],
    ['memberKey a number',                   a => { a.proposals[0].memberKey = 42; },                    'missing_member_key'],
    ["memberKey ' a' (left-padded)",         a => { a.proposals[0].memberKey = ' a'; },                  'padded_member_key'],
    ["memberKey 'a ' (right-padded)",        a => { a.proposals[0].memberKey = 'a '; },                  'padded_member_key'],
    ["memberKey '\\ta' (tab)",               a => { a.proposals[0].memberKey = '\ta'; },                 'padded_member_key'],
    ["memberKey 'a\\n' (newline)",           a => { a.proposals[0].memberKey = 'a\n'; },                 'padded_member_key'],
    ['a null proposal',                      a => { a.proposals.push(null); },                           'proposal_not_object'],
    ['an array as a proposal',               a => { a.proposals.push(['a']); },                          'proposal_not_object'],
    ["source 'wix-absence' (typo)",          a => { a.proposals[0].source = 'wix-absence'; },            'unknown_source'],
    ["source 'WIX_ABSENCE' (the key, not the value)", a => { a.proposals[0].source = 'WIX_ABSENCE'; },   'unknown_source'],
    ['source undefined',                     a => { delete a.proposals[0].source; },                     'unknown_source'],
    ["dataSource 'wix' (the v2 name)",       a => { a.proposals[0].dataSource = 'wix'; },                'unknown_data_source'],
    ['dataSource missing',                   a => { delete a.proposals[0].dataSource; },                 'unknown_data_source'],
    ["dataSource 'kisi' on a WIX_ABSENCE (R3-1)", a => { a.proposals[0].dataSource = 'kisi'; },          'data_source_mismatch'],
    ["dataSource 'db' on a WIX_ABSENCE (R3-1)",   a => { a.proposals[0].dataSource = 'db'; },            'data_source_mismatch'],
    ["dataSource 'wix_orders' on a ROLE_DRIFT (R3-1)", a => { a.proposals[1].dataSource = 'wix_orders'; }, 'data_source_mismatch'],
    ["a WIX_ABSENCE in another member's unit (R3-1)",  a => { a.proposals[0].unitKey = 'b'; },           'unit_structure_invalid'],
    ['strike an array',                      a => { a.proposals[0].strike = [RIPE]; },                   'invalid_strike'],
    ['strike a string',                      a => { a.proposals[0].strike = 'ripe'; },                   'invalid_strike'],
    ['strike since unparseable',             a => { a.proposals[0].strike = { since: 'soon', observations: 3 }; }, 'invalid_strike_since'],
    ['strike since missing',                 a => { a.proposals[0].strike = { observations: 3 }; },      'invalid_strike_since'],
    ['strike since a number',                a => { a.proposals[0].strike = { since: NOW - 72 * HOUR, observations: 3 }; }, 'invalid_strike_since'],
    ['strike observations negative',         a => { a.proposals[0].strike = { since: RIPE.since, observations: -1 }; }, 'invalid_strike_observations'],
    ["strike observations '5'",              a => { a.proposals[0].strike = { since: RIPE.since, observations: '5' }; }, 'invalid_strike_observations'],
    ['currentManaged undefined',             a => { delete a.currentManaged; },                          'invalid_current_managed'],
    ["currentManaged '300'",                 a => { a.currentManaged = '300'; },                         'invalid_current_managed'],
    ['currentManaged 2.5',                   a => { a.currentManaged = 2.5; },                           'invalid_current_managed'],
    ['currentManaged -1',                    a => { a.currentManaged = -1; },                            'invalid_current_managed'],
    ['currentManaged NaN',                   a => { a.currentManaged = NaN; },                           'invalid_current_managed'],
    ['currentManaged below distinct members',a => { a.currentManaged = 1; },                             'proposals_exceed_population'],
    ['populationByDataSource missing',       a => { delete a.populationByDataSource; },                  'invalid_population_by_data_source'],
    ['populationByDataSource an array',      a => { a.populationByDataSource = [300, 300]; },            'invalid_population_by_data_source'],
    ['population missing for a proposed data source', a => { delete a.populationByDataSource.kisi; },   'missing_population:kisi'],
    ["population keyed 'wix' (v2 name)",     a => { a.populationByDataSource.wix = 300; },               'unknown_population_key:wix'],
    ["population '300' (string)",            a => { a.populationByDataSource.wix_orders = '300'; },      'invalid_population:wix_orders'],
    ['population -1 for an unproposed source', a => { a.populationByDataSource.db = -1; },               'invalid_population:db'],
    ['population below its proposals',       a => { a.populationByDataSource.kisi = 0; },                'proposals_exceed_population:kisi'],
    ['readDisagreement missing',             a => { a.readDisagreement = undefined; },                   'invalid_read_disagreement'],
    ['readDisagreement null',                a => { a.readDisagreement = null; },                        'invalid_read_disagreement'],
    ['readDisagreement an array',            a => { a.readDisagreement = [5]; },                         'invalid_read_disagreement'],
    ['readDisagreement a number',            a => { a.readDisagreement = 5; },                           'invalid_read_disagreement'],
    ["readDisagreement keyed 'wix' (v2 name)", a => { a.readDisagreement = { wix: 150 }; },              'unknown_read_disagreement_key:wix'],
    ['readDisagreement negative',            a => { a.readDisagreement = { wix_orders: -3 }; },          'invalid_read_disagreement:wix_orders'],
    ["readDisagreement '150'",               a => { a.readDisagreement = { wix_orders: '150' }; },       'invalid_read_disagreement:wix_orders'],
    ['readDisagreement 1.5',                 a => { a.readDisagreement = { wix_orders: 1.5 }; },         'invalid_read_disagreement:wix_orders'],
    ['a disagreement with no population to judge it by', a => { a.readDisagreement = { wix_bookings: 4 }; }, 'missing_population_for_disagreement'],
    ['now missing',                          a => { a.now = undefined; },                                'invalid_now'],
    ['now NaN',                              a => { a.now = NaN; },                                      'invalid_now'],
    ['now a numeric string',                 a => { a.now = String(NOW); },                              'invalid_now'],
    ['now a Date object',                    a => { a.now = new Date(NOW); },                            'invalid_now'],
    ['strikePolicy missing',                 a => { a.strikePolicy = undefined; },                       'invalid_strike_policy'],
    ['strikePolicy with the wrong key names',a => { a.strikePolicy = { minAge: 1, minObs: 3 }; },       'invalid_strike_policy:min_age_ms'],
    ['strikePolicy minAgeMs negative',       a => { a.strikePolicy = { minAgeMs: -1, minObservations: 3 }; }, 'invalid_strike_policy:min_age_ms'],
    ["strikePolicy minObservations '3'",     a => { a.strikePolicy = { minAgeMs: 0, minObservations: '3' }; }, 'invalid_strike_policy:min_observations'],
  ])('%s → hold invalid_proposal (%s), every proposal held, nothing flushed', (_label, mutate, detail) => {
    const args = { readDisagreement: {}, mode: 'on', observationOnly: false, now: NOW, strikePolicy: STRIKE_POLICY, ...GOOD() };
    // Control: the unmutated input proceeds, so the mutation alone causes the hold.
    expect(evaluateRemovals(args).action).toBe('proceed');
    mutate(args);
    const d = evaluateRemovals(args);
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe(detail);
    expect(d.flush).toEqual([]);
    expect(d.strikePending).toEqual([]);
    expect(d.held).toHaveLength(args.proposals.length);
    d.held.forEach((h, i) => expect(h).toBe(args.proposals[i]));
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('a strike that is absent or null is NOT invalid — it just is not ripe', () => {
    for (const strike of [undefined, null, NO_CLOCK]) {
      const d = armed({
        proposals: [prop('a', WIX_ABSENCE, { strike })],
        currentManaged: 10, populationByDataSource: { wix_orders: 10 },
      });
      expect(d.reason).toBe(R.STRIKE_PENDING);
    }
  });

  test('a zero disagreement needs no population (a data source read once reports nothing)', () => {
    const d = armed({
      proposals: [prop('a')], currentManaged: 10, populationByDataSource: { wix_orders: 10 },
      readDisagreement: { wix_bookings: 0, kisi: 0 },
    });
    expect(d.action).toBe('proceed');
  });

  test('invalid input is reported even when removal is not armed (observationOnly, mode off)', () => {
    const d = evaluateRemovals({
      proposals: [prop('a'), prop('b')], currentManaged: 1, populationByDataSource: { wix_orders: 300 },
      readDisagreement: {}, mode: 'off', observationOnly: true, now: NOW, strikePolicy: STRIKE_POLICY,
    });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: snapshot instability, per data source', () => {
  test.each([
    // population, disagreement, unstable?
    [3,   0,   false],
    [3,   1,   false],   // one member renewing between the reads at HOG is not a flap
    [3,   2,   true],
    [3,   3,   true],    // the second read came back empty (OB-85 signature)
    [10,  2,   false],
    [10,  3,   true],
    [300, 74,  false],
    [300, 75,  true],
    [300, 150, true],
  ])('wix_orders population %p, %p members disagreed between reads → unstable=%p', (population, disagreed, unstable) => {
    const proposals = [prop('a')];
    const d = armed({
      proposals, currentManaged: population, populationByDataSource: { wix_orders: population },
      readDisagreement: { wix_orders: disagreed },
    });
    if (unstable) {
      expect(d.action).toBe('hold');
      expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
      expect(d.dataSource).toBe(WIX_ORDERS);
      expect(d.held).toEqual(proposals);
      expect(d.flush).toEqual([]);
      expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
    } else {
      expect(d.action).toBe('proceed');
    }
  });

  test('each data source is judged against ITS OWN population, not the aggregate', () => {
    // 10 disagreements is noise against 300 orders members, a flap against 12 booking members.
    const base = {
      proposals: [prop('a')], currentManaged: 312,
      populationByDataSource: { wix_orders: 300, wix_bookings: 12 },
    };
    expect(armed({ ...base, readDisagreement: { wix_orders: 10 } }).action).toBe('proceed');
    const d = armed({ ...base, readDisagreement: { wix_bookings: 10 } });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.dataSource).toBe(WIX_BOOKINGS);
  });

  test('an unstable data source holds the WHOLE batch, including proposals from other data sources', () => {
    const orders = prop('a'), kisi = prop('b', ROLE_DRIFT);
    const d = armed({
      proposals: [orders, kisi], currentManaged: 300,
      populationByDataSource: { wix_orders: 300, wix_bookings: 8, kisi: 300 },
      readDisagreement: { wix_bookings: 2 },
    });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.dataSource).toBe(WIX_BOOKINGS);
    expect(d.held).toEqual([orders, kisi]);
    expect(d.flush).toEqual([]);
  });

  test('two unstable data sources: the reported one does not depend on the caller\'s key order', () => {
    const base = { proposals: [prop('a')], currentManaged: 10 };
    const d1 = armed({ ...base, populationByDataSource: { wix_orders: 10, kisi: 10 }, readDisagreement: { kisi: 5, wix_orders: 5 } });
    const d2 = armed({ ...base, populationByDataSource: { kisi: 10, wix_orders: 10 }, readDisagreement: { wix_orders: 5, kisi: 5 } });
    expect(d1.dataSource).toBe(WIX_ORDERS);
    expect(d2).toEqual(d1);
  });

  test('instability is checked BEFORE the mass cap (both tripped → snapshot_unstable)', () => {
    const d = armed({
      proposals: wixProps(['a', 'b', 'c']), currentManaged: 3, populationByDataSource: { wix_orders: 3 },
      readDisagreement: { wix_orders: 3 },
    });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
  });

  test.each([
    ['observation only',  { observationOnly: true }],
    ['mode off',          { mode: 'off' }],
    ['mode dry_run',      { mode: 'dry_run' }],
    ['mode unreadable',   { mode: null }],
    ['every strike fresh',{ proposals: wixProps(['a'], { strike: FRESH }) }],
  ])('instability is reported before %s — a paused client still learns its data looks broken', (_label, over) => {
    const d = armed({
      proposals: [prop('a')], currentManaged: 10, populationByDataSource: { wix_orders: 10 },
      readDisagreement: { wix_orders: 5 }, ...over,
    });
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
    expect(d.flush).toEqual([]);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: mass cap (House of Gains: 3 managed)', () => {
  const HOG = { currentManaged: 3, populationByDataSource: { wix_orders: 3, kisi: 3 } };

  test('F1 production case: all 3 members proposed → hold mass_revoke, every proposal held', () => {
    const proposals = wixProps(['a', 'b', 'c']);
    const d = armed({ ...HOG, proposals });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.held).toEqual(proposals);
    expect(d.flush).toEqual([]);
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('F1 across revoke paths (defect 2): 3 members via 3 different sources is still a mass revoke (aggregate)', () => {
    const d = armed({
      currentManaged: 3, populationByDataSource: { wix_orders: 3, kisi: 3 },
      proposals: [prop('a', WIX_ABSENCE), prop('b', ROLE_DRIFT), prop('c', KISI_USER_VANISHED)],
    });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBeNull(); // aggregate
    expect(d.detail).toBe('aggregate');
  });

  test('2 of 3 is more than half → hold mass_revoke', () => {
    const d = armed({ ...HOG, proposals: wixProps(['a', 'b']) });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.flush).toEqual([]);
  });

  test('1 of 3 → proceed, that very proposal flushed', () => {
    const only = prop('a');
    const d = armed({ ...HOG, proposals: [only] });
    expect(d.action).toBe('proceed');
    expect(d.reason).toBeNull();
    expect(d.flush).toEqual([only]);
    expect(d.flush[0]).toBe(only);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: mass cap boundaries (300 managed, threshold 151)', () => {
  test.each([
    [5,   'proceed'],
    [150, 'proceed'],
    [151, 'hold'],
    [299, 'hold'],
    [300, 'hold'],
  ])('%p distinct members proposed → %s', (n, action) => {
    const proposals = wixProps(keys(n));
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } });
    expect(d.counts.massThreshold).toBe(151);
    expect(d.action).toBe(action);
    if (action === 'proceed') { expect(d.reason).toBeNull(); expect(d.flush).toEqual(proposals); }
    if (action === 'hold')    { expect(d.reason).toBe(R.MASS_REVOKE); expect(d.held).toEqual(proposals); }
  });
});

describe('[P1] revoke-policy — evaluateRemovals: mass cap per data source', () => {
  test('A8 shape: 3 orders members + 1 member orders can never propose (currentManaged 4) → all 3 orders members is a per-source mass revoke', () => {
    // Aggregate: 3 of 4 ≥ 3 would trip too; use a bigger aggregate to isolate the per-source rule.
    const d = armed({
      proposals: wixProps(['a', 'b', 'c']), currentManaged: 10,
      populationByDataSource: { wix_orders: 3, wix_bookings: 7 },
    });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBe(WIX_ORDERS);
    expect(d.detail).toBe('per_data_source');
  });

  test('bookings population: more than half of the booking members → hold, dataSource wix_bookings', () => {
    const proposals = keys(3).map(k => prop(k, WIX_ABSENCE, { dataSource: WIX_BOOKINGS }));
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 295, wix_bookings: 5 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBe(WIX_BOOKINGS);
  });

  test('kisi population: 2 of 3 Kisi-checked members vanished → hold even though the aggregate is 300', () => {
    const proposals = [prop('a', KISI_USER_VANISHED), prop('b', ROLE_DRIFT)];
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 3 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBe(KISI);
  });

  test('HOLDER_LAPSE is judged against wix_orders, in units: a family\'s 2 sub lapses are 1 unit of 20', () => {
    // One family (holder h1 + 2 subs) among 20 orders units. The subs share the
    // holder's unitKey, so the batch is 1 of 20 → proceed.
    const proposals = [prop('sub1', HOLDER_LAPSE, { unitKey: 'h1' }), prop('sub2', HOLDER_LAPSE, { unitKey: 'h1' })];
    const d = armed({ proposals, currentManaged: 20, populationByDataSource: { wix_orders: 20 } });
    expect(d.action).toBe('proceed');
    expect(d.counts.proposedUnits).toBe(1);
    expect(d.counts.proposedMembers).toBe(2);
  });

  test('a per-source population of 1 is exempt (one ordinary cancellation), the aggregate still applies', () => {
    const only = prop('solo', WIX_ABSENCE, { dataSource: WIX_BOOKINGS });
    expect(armed({ proposals: [only], currentManaged: 50, populationByDataSource: { wix_bookings: 1 } }).action).toBe('proceed');
    // The same member at an aggregate of 1 is exempt too.
    expect(armed({ proposals: [only], currentManaged: 1, populationByDataSource: { wix_bookings: 1 } }).action).toBe('proceed');
  });

  test.each([
    // population, proposed members, holds?
    [2, 1, false], [2, 2, true], [4, 2, false], [4, 3, true], [5, 2, false], [5, 3, true],
  ])('per-source boundary: population %p, %p proposed → hold=%p', (population, n, holds) => {
    const proposals = keys(n).map(k => prop(k, ROLE_DRIFT));
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { kisi: population } });
    expect(d.action).toBe(holds ? 'hold' : 'proceed');
    if (holds) expect(d.reason).toBe(R.MASS_REVOKE);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: a single-member client is never blocked forever', () => {
  test('currentManaged 1: its one cancellation proceeds', () => {
    const only = prop('solo');
    const d = armed({ proposals: [only], currentManaged: 1, populationByDataSource: { wix_orders: 1 } });
    expect(d.action).toBe('proceed');
    expect(d.flush).toEqual([only]);
  });

  test('…including when that one member has several plans and sources at once', () => {
    const proposals = [
      prop('solo', WIX_ABSENCE, { planId: 'p1' }),
      prop('solo', WIX_ABSENCE, { planId: 'p2' }),
      prop('solo', ROLE_DRIFT,  { planId: 'p3' }),
    ];
    const d = armed({ proposals, currentManaged: 1, populationByDataSource: { wix_orders: 1, kisi: 1 } });
    expect(d.counts.proposedMembers).toBe(1);
    expect(d.action).toBe('proceed');
    expect(d.flush).toEqual(proposals);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: counts distinct MEMBERS, not proposals', () => {
  const fourPlans = (memberKey) => ['p1', 'p2', 'p3', 'p4'].map(planId => prop(memberKey, WIX_ABSENCE, { planId }));

  test('HOG: one member cancelling 4 plans is ONE member → proceed (counting proposals would wrongly hold: 4 ≥ 2)', () => {
    const proposals = fourPlans('a');
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.counts.proposedMembers).toBe(1);
    expect(d.action).toBe('proceed');
    expect(d.flush).toEqual(proposals);
  });

  // R3-1: a person is either a primary (WIX_ABSENCE, their own unit) or a sub
  // (HOLDER_LAPSE, their holder's unit) — never both — so "all four sources on
  // one member" is split into the sources that can reach each.
  test('a primary member hit by every source that can reach a primary (Wix absence on orders AND bookings, both Kisi sources) is ONE member, ONE unit', () => {
    const proposals = [
      prop('a', WIX_ABSENCE), prop('a', WIX_ABSENCE, { dataSource: WIX_BOOKINGS }),
      prop('a', ROLE_DRIFT),  prop('a', KISI_USER_VANISHED),
    ];
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3, wix_bookings: 3, kisi: 3 } });
    expect(d.counts).toMatchObject({ proposedMembers: 1, proposedUnits: 1 });
    expect(d.action).toBe('proceed');
  });

  test('a sub-member hit by every source that can reach a sub (holder lapse, both Kisi sources — all in its holder\'s unit) is ONE member, ONE unit', () => {
    const proposals = [HOLDER_LAPSE, ROLE_DRIFT, KISI_USER_VANISHED].map(s => prop('s', s, { unitKey: 'h' }));
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3, kisi: 3 } });
    expect(d.counts).toMatchObject({ proposedMembers: 1, proposedUnits: 1 });
    expect(d.action).toBe('proceed');
  });

  test('300 managed: 150 members producing 160 proposals is judged as 150 → proceed', () => {
    const proposals = [...wixProps(keys(150)), ...keys(10).map(k => prop(k, ROLE_DRIFT))];
    expect(proposals).toHaveLength(160);
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 300 } });
    expect(d.counts.proposedMembers).toBe(150);
    expect(d.action).toBe('proceed');
  });

  test('the cap is member-based too: all 3 HOG members with 2 plans each (6 proposals) → mass_revoke', () => {
    const proposals = ['a', 'b', 'c'].flatMap(k => [prop(k, WIX_ABSENCE, { planId: 'p1' }), prop(k, WIX_ABSENCE, { planId: 'p2' })]);
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.counts.proposedMembers).toBe(3);
    expect(d.reason).toBe(R.MASS_REVOKE);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: observationOnly (Phase 1) holds everything', () => {
  const INPUT = () => ({
    proposals: [prop('a'), prop('b', ROLE_DRIFT)],
    currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 300 },
  });

  test.each(['on', 'dry_run', 'off', null])('observationOnly true, mode %p → hold observation_only, every proposal held', (mode) => {
    const input = INPUT();
    const d = armed({ ...input, observationOnly: true, mode });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.OBSERVATION_ONLY);
    expect(d.flush).toEqual([]);
    expect(d.strikePending).toEqual([]);
    expect(d.held).toHaveLength(2);
    d.held.forEach((h, i) => expect(h).toBe(input.proposals[i]));
  });

  test.each([
    ['undefined (caller forgot it)', undefined],
    ['null', null],
    ["'false' (string)", 'false'],
    ['0', 0],
    ["''", ''],
  ])('observationOnly %s is not an explicit false → still held (fail-closed)', (_label, observationOnly) => {
    const d = armed({ ...INPUT(), observationOnly });
    expect(d.reason).toBe(R.OBSERVATION_ONLY);
    expect(d.flush).toEqual([]);
  });

  test('only an explicit false arms removal', () => {
    expect(armed({ ...INPUT(), observationOnly: false }).action).toBe('proceed');
  });

  test('observationOnly is checked BEFORE the mode (observationOnly + mode off → observation_only)', () => {
    expect(armed({ ...INPUT(), observationOnly: true, mode: 'off' }).reason).toBe(R.OBSERVATION_ONLY);
  });

  test.each([
    ['snapshot_unstable', { readDisagreement: { wix_orders: 200 } },                                 R.SNAPSHOT_UNSTABLE],
    ['mass_revoke',       { proposals: wixProps(keys(151)) },                                        R.MASS_REVOKE],
    ['invalid_proposal',  { proposals: [prop(' a')] },                                               R.INVALID_PROPOSAL],
  ])('still reports %s as the reason when observation-only (anomalies first)', (_label, over, reason) => {
    const d = armed({ ...INPUT(), observationOnly: true, ...over });
    expect(d.reason).toBe(reason);
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
    expect(d.flush).toEqual([]);
  });

  test('the counts preview what "on" would do: strikeReady is reported even while observation-only', () => {
    const proposals = [prop('a'), prop('b', WIX_ABSENCE, { strike: FRESH }), prop('c', WIX_ABSENCE, { strike: NO_CLOCK })];
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 }, observationOnly: true });
    expect(d.reason).toBe(R.OBSERVATION_ONLY);
    expect(d.counts).toMatchObject({ proposals: 3, proposedMembers: 3, flush: 0, held: 3, strikePending: 0, strikeReady: 1 });
    expect(d.counts.byDataSource.wix_orders).toMatchObject({ proposedMembers: 3, population: 300, readDisagreement: 0, massThreshold: 151, instabilityThreshold: 75 });
  });
});

describe('[P1] revoke-policy — evaluateRemovals: mode off / dry_run / on', () => {
  const INPUT = () => ({
    proposals: [prop('a'), prop('b', HOLDER_LAPSE, { unitKey: 'h' }), prop('c', ROLE_DRIFT)],
    currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 300 },
  });

  test("mode 'off' → hold auto_revoke_off, every proposal held", () => {
    const input = INPUT();
    const d = armed({ ...input, mode: 'off' });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.AUTO_REVOKE_OFF);
    expect(d.flush).toEqual([]);
    expect(d.held).toEqual(input.proposals);
    d.held.forEach((h, i) => expect(h).toBe(input.proposals[i]));
  });

  test("mode 'dry_run' → hold dry_run, every proposal held", () => {
    const input = INPUT();
    const d = armed({ ...input, mode: 'dry_run' });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.DRY_RUN);
    expect(d.flush).toEqual([]);
    expect(d.held).toEqual(input.proposals);
  });

  test("mode 'on' → proceed, every ripe proposal flushed", () => {
    const input = INPUT();
    const d = armed({ ...input, mode: 'on' });
    expect(d.action).toBe('proceed');
    expect(d.reason).toBeNull();
    expect(d.flush).toEqual(input.proposals);
    expect(d.held).toEqual([]);
  });

  test.each([
    ['null (read failed)', null], ['undefined', undefined], ["'ON'", 'ON'], ["' on'", ' on'], ['true', true], ["'enabled'", 'enabled'],
  ])('mode %s is unreadable → treated as off, nothing flushed', (_label, mode) => {
    const d = armed({ ...INPUT(), mode });
    expect(d.reason).toBe(R.AUTO_REVOKE_OFF);
    expect(d.flush).toEqual([]);
  });

  test('holds even a single ordinary cancellation when off or dry_run', () => {
    for (const [mode, reason] of [['off', R.AUTO_REVOKE_OFF], ['dry_run', R.DRY_RUN]]) {
      const only = prop('a');
      const d = armed({ proposals: [only], currentManaged: 300, populationByDataSource: { wix_orders: 300 }, mode });
      expect(d.reason).toBe(reason);
      expect(d.held).toEqual([only]);
    }
  });

  test('ANOMALY BEFORE MODE: a would-remove-everyone batch with mode off reports mass_revoke, not auto_revoke_off', () => {
    const proposals = wixProps(['a', 'b', 'c']);
    const args = { proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } };
    const off = armed({ ...args, mode: 'off' });
    expect(off.reason).toBe(R.MASS_REVOKE);
    expect(off.held).toEqual(proposals);
    expect(armed({ ...args, mode: 'dry_run' }).reason).toBe(R.MASS_REVOKE);
  });

  test('mode is checked BEFORE strikes: mode off with only unripe strikes → auto_revoke_off, not strike_pending', () => {
    const d = armed({ proposals: wixProps(['a'], { strike: FRESH }), currentManaged: 10, populationByDataSource: { wix_orders: 10 }, mode: 'off' });
    expect(d.reason).toBe(R.AUTO_REVOKE_OFF);
    expect(d.strikePending).toEqual([]);
    expect(d.held).toHaveLength(1);
  });
});

describe('[P1] revoke-policy — evaluateRemovals: strike gating (minAge AND minObservations)', () => {
  const POP = { currentManaged: 300, populationByDataSource: { wix_orders: 300 } };

  test.each([
    ['FRESH (age not met)',                     FRESH],
    ['FEW (observations not met)',              FEW],
    ['NEITHER',                                 NEITHER],
    ['NO_CLOCK (since null)',                   NO_CLOCK],
    ['no strike attached',                      undefined],
    ['since in the future',                     { since: iso(NOW + HOUR), observations: 9 }],
  ])('a single %s proposal → hold strike_pending, in strikePending not flush', (_label, strike) => {
    const p = prop('a', WIX_ABSENCE, { strike });
    const d = armed({ ...POP, proposals: [p] });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.STRIKE_PENDING);
    expect(d.flush).toEqual([]);
    expect(d.held).toEqual([]);
    expect(d.strikePending).toEqual([p]);
    expect(d.strikePending[0]).toBe(p);
  });

  test('both conditions exactly on the boundary → flushed', () => {
    const p = prop('a', WIX_ABSENCE, { strike: { since: iso(NOW - 48 * HOUR), observations: 3 } });
    expect(armed({ ...POP, proposals: [p] }).flush).toEqual([p]);
  });

  test('mixed batch: ripe proposals flush, the rest wait in strikePending, reason null (something flushed)', () => {
    const ripeA = prop('a'), freshB = prop('b', WIX_ABSENCE, { strike: FRESH });
    const ripeC = prop('c'), fewD = prop('d', WIX_ABSENCE, { strike: FEW });
    const d = armed({ ...POP, proposals: [ripeA, freshB, ripeC, fewD] });
    expect(d.action).toBe('proceed');
    expect(d.reason).toBeNull();
    expect(d.flush).toEqual([ripeA, ripeC]);
    expect(d.strikePending).toEqual([freshB, fewD]);
    expect(d.held).toEqual([]);
    expect(d.counts).toMatchObject({ flush: 2, strikePending: 2, held: 0, strikeReady: 2 });
  });

  test('the strike is per proposal: one member with a ripe plan and a fresh plan flushes only the ripe plan', () => {
    const ripePlan  = prop('a', WIX_ABSENCE, { planId: 'p1' });
    const freshPlan = prop('a', WIX_ABSENCE, { planId: 'p2', strike: FRESH });
    const d = armed({ ...POP, proposals: [ripePlan, freshPlan] });
    expect(d.flush).toEqual([ripePlan]);
    expect(d.strikePending).toEqual([freshPlan]);
  });

  test('a pg Date for since is honoured the same as its ISO string', () => {
    const p = prop('a', WIX_ABSENCE, { strike: { since: new Date(NOW - 72 * HOUR), observations: 3 } });
    expect(armed({ ...POP, proposals: [p] }).flush).toEqual([p]);
  });

  test('the strike policy is the caller\'s: minAge 0 / minObservations 0 still refuses a clock that never started', () => {
    const d = armed({ ...POP, proposals: [prop('a', WIX_ABSENCE, { strike: NO_CLOCK })], strikePolicy: { minAgeMs: 0, minObservations: 0 } });
    expect(d.reason).toBe(R.STRIKE_PENDING);
    expect(d.flush).toEqual([]);
  });

  test('ripe strikes never override the mass cap: 151 ripe of 300 → mass_revoke', () => {
    const d = armed({ ...POP, proposals: wixProps(keys(151)) });
    expect(d.reason).toBe(R.MASS_REVOKE);
  });

  test('unripe proposals still count toward the mass cap (the cap judges the whole batch)', () => {
    const proposals = [...wixProps(keys(1)), ...wixProps(keys(150, 'x'), { strike: FRESH })];
    const d = armed({ ...POP, proposals });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.flush).toEqual([]);
  });
});

describe('[P1] revoke-policy — proposals pass through untouched', () => {
  function richProposals() {
    return [
      prop('a', WIX_ABSENCE, {
        planId: 'plan-gold', accessId: 'acc-a',
        syntheticEvent: { eventType: 'plan.cancelled', platformMemberId: 'a', planId: 'plan-gold', synthetic: true },
      }),
      prop('b', HOLDER_LAPSE, {
        unitKey: 'h', planId: 'plan-family', accessId: 'acc-b', strike: FRESH,
        syntheticEvent: { eventType: 'plan.cancelled', platformMemberId: 'b', planId: 'plan-family', synthetic: true },
      }),
      prop('c', WIX_ABSENCE, {
        planId: 'plan-silver', accessId: 'acc-c',
        syntheticEvent: { eventType: 'plan.cancelled', platformMemberId: 'c', planId: 'plan-silver', synthetic: true },
      }),
    ];
  }
  const POP = { currentManaged: 300, populationByDataSource: { wix_orders: 300 } };

  function expectSameObjects(actual, expected) {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((a, i) => {
      expect(a).toBe(expected[i]);
      expect(a.syntheticEvent).toBe(expected[i].syntheticEvent);
    });
  }

  test('proceed: flush and strikePending hold the very same objects, in input order, unmodified', () => {
    const proposals = richProposals();
    const [a, b, c] = proposals;
    const before = JSON.parse(JSON.stringify(proposals));
    const d = armed({ ...POP, proposals });
    expect(d.action).toBe('proceed');
    expectSameObjects(d.flush, [a, c]);
    expectSameObjects(d.strikePending, [b]);
    expect(proposals).toEqual(before);
    expect(proposals).toHaveLength(3);
  });

  test.each([
    ['observation only', { observationOnly: true },                                        R.OBSERVATION_ONLY],
    ['mode off',         { mode: 'off' },                                                  R.AUTO_REVOKE_OFF],
    ['dry run',          { mode: 'dry_run' },                                              R.DRY_RUN],
    ['mass revoke',      { currentManaged: 3, populationByDataSource: { wix_orders: 3 } }, R.MASS_REVOKE],
    ['unstable',         { readDisagreement: { wix_orders: 200 } },                        R.SNAPSHOT_UNSTABLE],
  ])('hold (%s): held holds the very same objects, unmodified', (_label, over, reason) => {
    const proposals = richProposals();
    const before = JSON.parse(JSON.stringify(proposals));
    const d = armed({ ...POP, proposals, ...over });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(reason); // held for THIS reason — not, say, as invalid input
    expectSameObjects(d.held, proposals);
    expect(proposals).toEqual(before);
  });

  test('the returned lists are never the caller\'s own array (mutating them cannot corrupt the input)', () => {
    const proposals = richProposals();
    for (const over of [{}, { mode: 'off' }, { currentManaged: 'x' }]) {
      const d = armed({ ...POP, proposals, ...over });
      for (const list of [d.flush, d.held, d.strikePending]) expect(list).not.toBe(proposals);
    }
  });
});

describe('[P1] revoke-policy — every hold carries a non-null reason', () => {
  test.each([
    ['invalid',       { proposals: [prop('a')], currentManaged: 'x',  populationByDataSource: { wix_orders: 3 } }],
    ['unstable',      { proposals: [prop('a')], currentManaged: 10,   populationByDataSource: { wix_orders: 10 }, readDisagreement: { wix_orders: 9 } }],
    ['mass',          { proposals: wixProps(['a', 'b']), currentManaged: 3, populationByDataSource: { wix_orders: 3 } }],
    ['observation',   { proposals: [prop('a')], currentManaged: 10,   populationByDataSource: { wix_orders: 10 }, observationOnly: true }],
    ['off',           { proposals: [prop('a')], currentManaged: 10,   populationByDataSource: { wix_orders: 10 }, mode: 'off' }],
    ['dry_run',       { proposals: [prop('a')], currentManaged: 10,   populationByDataSource: { wix_orders: 10 }, mode: 'dry_run' }],
    ['strike',        { proposals: wixProps(['a'], { strike: FRESH }), currentManaged: 10, populationByDataSource: { wix_orders: 10 } }],
    ['empty, unstable (R3-2)', { proposals: [], currentManaged: 10, populationByDataSource: { wix_orders: 10 }, readDisagreement: { wix_orders: 9 } }],
    ['empty, invalid (R3-2)',  { proposals: [], currentManaged: 10, populationByDataSource: { wix_orders: 10 }, readDisagreement: { wix_bookings: 9 } }],
    ['unit structure (R3-1)',  { proposals: [prop('a'), prop('b', WIX_ABSENCE, { unitKey: 'a' })], currentManaged: 10, populationByDataSource: { wix_orders: 10 } }],
    ['data source (R3-1)',     { proposals: [prop('a', ROLE_DRIFT, { dataSource: WIX_ORDERS })], currentManaged: 10, populationByDataSource: { wix_orders: 10 } }],
  ])('%s', (_label, args) => {
    const d = armed(args);
    expect(d.action).toBe('hold');
    expect(Object.values(REVOKE_HOLD_REASON)).toContain(d.reason);
    expect(d.flush).toEqual([]);
  });
});

/**
 * Fix-round validation helper: the unmutated input proceeds (control), the
 * mutated one holds the WHOLE batch as invalid_proposal with `detail`.
 */
function expectInvalidAfter(makeArgs, mutate, detail) {
  const args = { readDisagreement: {}, mode: 'on', observationOnly: false, now: NOW, strikePolicy: STRIKE_POLICY, ...makeArgs() };
  expect(evaluateRemovals(args).action).toBe('proceed');
  mutate(args);
  const d = evaluateRemovals(args);
  expect(d.action).toBe('hold');
  expect(d.reason).toBe(R.INVALID_PROPOSAL);
  expect(d.detail).toBe(detail);
  expect(d.flush).toEqual([]);
  expect(d.strikePending).toEqual([]);
  expect(d.held).toHaveLength(args.proposals.length);
  d.held.forEach((h, i) => expect(h).toBe(args.proposals[i]));
  expect(d.counts.proposedUnits).toBeNull(); // untrusted input is never counted
}

describe('[P1] revoke-policy — P-1 units: a family is ONE unit for caps, validation and counts', () => {
  // A gym of 3 units: two single members (s1, s2) and one family (holder h + 2 subs).
  const GYM = { currentManaged: 3, populationByDataSource: { wix_orders: 3 } };

  test('a family lapsing (holder WIX_ABSENCE + 2 HOLDER_LAPSE subs sharing unitKey) is 1 unit of 3 → proceed', () => {
    const proposals = family('h');
    expect(proposals.map(p => p.source)).toEqual([WIX_ABSENCE, HOLDER_LAPSE, HOLDER_LAPSE]);
    const d = armed({ ...GYM, proposals });
    expect(d.action).toBe('proceed');
    expect(d.flush).toEqual(proposals);
    expect(d.counts).toMatchObject({ proposals: 3, proposedUnits: 1, proposedMembers: 3 });
    expect(d.counts.byDataSource.wix_orders).toMatchObject({ proposedUnits: 1, proposedMembers: 3, population: 3 });
  });

  test('control: the same 3 members each in their OWN unit (the family not collapsed) are 3 units of 3 → mass_revoke', () => {
    const proposals = ungrouped(family('h'));
    expect(unitSet(proposals).size).toBe(3);
    const d = armed({ ...GYM, proposals });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.flush).toEqual([]);
    // R3-1: merely stripping the unitKeys is not "own units" — a sub with no
    // holder unit is malformed, and still nothing is flushed.
    const stripped = armed({ ...GYM, proposals: family('h').map(({ unitKey: _unit, ...rest }) => rest) });
    expect(stripped.reason).toBe(R.INVALID_PROPOSAL);
    expect(stripped.detail).toBe('unit_structure_invalid');
    expect(stripped.flush).toEqual([]);
  });

  test('the family is 1 unit for VALIDATION: currentManaged 1 accepts a family of 3 (a one-family client)', () => {
    const proposals = family('h');
    const d = armed({ proposals, currentManaged: 1, populationByDataSource: { wix_orders: 1 } });
    expect(d.action).toBe('proceed');
    // Counted as members (each its own unit), the same input is provably inconsistent.
    const byMembers = armed({ proposals: ungrouped(proposals), currentManaged: 1, populationByDataSource: { wix_orders: 1 } });
    expect(byMembers.detail).toBe('proposals_exceed_population');
  });

  test('the family is 1 unit for PER-DATA-SOURCE validation too (wix_orders population 1 of an aggregate 5)', () => {
    const proposals = family('h');
    expect(armed({ proposals, currentManaged: 5, populationByDataSource: { wix_orders: 1 } }).action).toBe('proceed');
    const byMembers = armed({ proposals: ungrouped(proposals), currentManaged: 5, populationByDataSource: { wix_orders: 1 } });
    expect(byMembers.detail).toBe('proposals_exceed_population:wix_orders');
  });

  test('a unit spans data sources: holder via wix_orders, a sub via kisi — 1 unit in aggregate and 1 unit in each source', () => {
    const proposals = [
      prop('h', WIX_ABSENCE, { unitKey: 'h' }),
      prop('h###as0', ROLE_DRIFT, { unitKey: 'h' }),
    ];
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3, kisi: 3 } });
    expect(d.action).toBe('proceed');
    expect(d.counts.proposedUnits).toBe(1);
    expect(d.counts.byDataSource.wix_orders.proposedUnits).toBe(1);
    expect(d.counts.byDataSource.kisi.proposedUnits).toBe(1);
  });

  test('an explicit unitKey equal to memberKey, or explicitly undefined, is the member\'s own unit', () => {
    const own = [prop('a', WIX_ABSENCE, { unitKey: 'a' }), prop('b', WIX_ABSENCE, { unitKey: undefined })];
    const d = armed({ proposals: own, currentManaged: 10, populationByDataSource: { wix_orders: 10 } });
    expect(d.action).toBe('proceed');
    expect(d.counts.proposedUnits).toBe(2);
  });

  test('empty batch reports 0 units; an invalid batch reports null (never counted)', () => {
    const empty = armed({ proposals: [], currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(empty.counts.proposedUnits).toBe(0);
    const invalid = armed({ proposals: [prop('a')], currentManaged: 'x', populationByDataSource: { wix_orders: 3 } });
    expect(invalid.counts.proposedUnits).toBeNull();
  });
});

describe('[P1] revoke-policy — P-1 units: a real mass event, counted in units, still holds', () => {
  test('HOG-sized: 3 units (2 families + 1 single) and BOTH families lapse (6 members, 2 units) → mass_revoke', () => {
    const proposals = [...family('h1'), ...family('h2')];
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.counts).toMatchObject({ proposedUnits: 2, proposedMembers: 6 });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.held).toEqual(proposals);
    expect(d.flush).toEqual([]);
  });

  test('every unit lapses: 3 families of 3 at a 3-unit gym → mass_revoke (aggregate)', () => {
    const proposals = ['h1', 'h2', 'h3'].flatMap(h => family(h));
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBeNull();
  });

  test.each([
    [150, 'proceed'],
    [151, 'hold'],
    [300, 'hold'],
  ])('300 units: %p families of 3 lapse → %s', (families, action) => {
    const proposals = keys(families, 'h').flatMap(h => family(h));
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } });
    expect(d.counts.proposedUnits).toBe(families);
    expect(d.counts.massThreshold).toBe(151);
    expect(d.action).toBe(action);
    if (action === 'hold') { expect(d.reason).toBe(R.MASS_REVOKE); expect(d.flush).toEqual([]); }
  });

  test('per data source in units: 2 of 3 Kisi units vanish (each a family with several Kisi rows) → hold, dataSource kisi', () => {
    const kisiFamily = (h) => [0, 1, 2].map(i => prop(`${h}###as${i}`, KISI_USER_VANISHED, { unitKey: h }));
    const proposals = [...kisiFamily('h1'), ...kisiFamily('h2')];
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 297, kisi: 3 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBe(KISI);
    expect(d.detail).toBe('per_data_source');
  });

  test('unripe family members still count toward the unit cap', () => {
    const proposals = [...family('h1', 2, { strike: FRESH }), ...family('h2', 2, { strike: NO_CLOCK })];
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
  });

  test('observation-only / mode off still REPORT a unit mass event first (anomaly before mode)', () => {
    const proposals = [...family('h1'), ...family('h2')];
    for (const over of [{ observationOnly: true }, { mode: 'off' }, { mode: 'dry_run' }]) {
      const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 }, ...over });
      expect(d.reason).toBe(R.MASS_REVOKE);
      expect(d.flush).toEqual([]);
    }
  });
});

describe('[P1] revoke-policy — P-1 unitKey validation (invalid_proposal holds the WHOLE batch)', () => {
  const GOOD = () => ({
    proposals: [...family('h'), prop('a')],
    currentManaged: 300,
    populationByDataSource: { wix_orders: 300 },
  });

  test.each([
    ['null',                         null,               'invalid_unit_key'],
    ["'' (empty)",                   '',                 'invalid_unit_key'],
    ["'   ' (whitespace only)",      '   ',              'invalid_unit_key'],
    ['a number',                     42,                 'invalid_unit_key'],
    ['an object',                    { id: 'h' },        'invalid_unit_key'],
    ['an array',                     ['h'],              'invalid_unit_key'],
    ["a boxed String('h')",          Object('h'),        'invalid_unit_key'],
    ["'undefined' (stringified)",    'undefined',        'invalid_unit_key'],
    ["'null' (stringified)",         'null',             'invalid_unit_key'],
    ["'NaN' (stringified)",          'NaN',              'invalid_unit_key'],
    ["'[object Object]'",            '[object Object]',  'invalid_unit_key'],
    ["' h' (left-padded)",           ' h',               'padded_unit_key'],
    ["'h ' (right-padded)",          'h ',               'padded_unit_key'],
    ["'\\th' (tab)",                 '\th',              'padded_unit_key'],
    ["'h\\n' (newline)",             'h\n',              'padded_unit_key'],
  ])('unitKey %s on one proposal → hold invalid_proposal (%s)', (_label, unitKey, detail) => {
    expectInvalidAfter(GOOD, a => { a.proposals[1].unitKey = unitKey; }, detail);
  });

  test.each([
    ["'undefined'", 'undefined'], ["'null'", 'null'], ["'NaN'", 'NaN'], ["'[object Object]'", '[object Object]'],
  ])('a stringified-nothing memberKey %s is a missing key', (_label, memberKey) => {
    expectInvalidAfter(GOOD, a => { a.proposals[3].memberKey = memberKey; }, 'missing_member_key');
  });
});

describe('[P1] revoke-policy — P-2 classification: only ENDED / ABSENT may be removed', () => {
  const GOOD = () => ({
    proposals: [prop('a', WIX_ABSENCE), prop('b', HOLDER_LAPSE, { unitKey: 'h' }), prop('c', ROLE_DRIFT)],
    currentManaged: 300,
    populationByDataSource: { wix_orders: 300, kisi: 300 },
  });
  const NOT_REMOVABLE = [
    ['missing',                   undefined,         true],
    ['null',                      null,              false],
    ["'DECLINED'",                'DECLINED',        false],
    ["'PENDING'",                 'PENDING',         false],
    ["'UNKNOWN'",                 'UNKNOWN',         false],
    ["'PAYING'",                  'PAYING',          false],
    ["'ended' (wrong case)",      'ended',           false],
    ["'Absent' (wrong case)",     'Absent',          false],
    ["' ENDED' (padded)",         ' ENDED',          false],
    ["'ENDED ' (padded)",         'ENDED ',          false],
    ["'CANCELED' (a Wix status, not a class)", 'CANCELED', false],
    ["''",                        '',                false],
    ['42',                        42,                false],
    ['true',                      true,              false],
    ["['ENDED']",                 ['ENDED'],         false],
    ["a boxed String('ENDED')",   Object('ENDED'),   false],
    ["{ toString: () => 'ENDED' }", { toString: () => 'ENDED' }, false],
  ];

  describe.each([
    ['WIX_ABSENCE', 0],
    ['HOLDER_LAPSE', 1],
  ])('%s', (_source, index) => {
    test.each(NOT_REMOVABLE)('classification %s → hold invalid_proposal (classification_not_removable)', (_label, classification, deleteIt) => {
      expectInvalidAfter(GOOD, a => {
        if (deleteIt) delete a.proposals[index].classification;
        else a.proposals[index].classification = classification;
      }, 'classification_not_removable');
    });

    test.each(['ENDED', 'ABSENT'])('classification %p is removable → proceed', (classification) => {
      const args = GOOD();
      args.proposals[index].classification = classification;
      expect(armed(args).action).toBe('proceed');
    });
  });

  test.each([ROLE_DRIFT, KISI_USER_VANISHED])('%s proposals need no classification', (source) => {
    const p = prop('k', source);
    expect(p).not.toHaveProperty('classification');
    const d = armed({ proposals: [p], currentManaged: 300, populationByDataSource: { kisi: 300 } });
    expect(d.action).toBe('proceed');
    expect(d.flush).toEqual([p]);
  });

  test('a declined holder\'s family is never removable — the whole batch holds, the other members too', () => {
    const declined = family('h', 2, { classification: 'DECLINED' });
    const other = prop('a');
    const d = armed({ proposals: [other, ...declined], currentManaged: 300, populationByDataSource: { wix_orders: 300 } });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('classification_not_removable');
    expect(d.held).toEqual([other, ...declined]);
    expect(d.flush).toEqual([]);
  });

  test.each([
    ['observation only', { observationOnly: true }],
    ['mode off',         { mode: 'off' }],
    ['mode dry_run',     { mode: 'dry_run' }],
  ])('a non-removable classification is reported as an anomaly even when %s', (_label, over) => {
    const d = armed({
      proposals: [prop('a', WIX_ABSENCE, { classification: 'PENDING' })],
      currentManaged: 300, populationByDataSource: { wix_orders: 300 }, ...over,
    });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('classification_not_removable');
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });
});

describe('[P1] revoke-policy — P-3 strict strike since (a Date, or strict ISO-8601 with Z / ±HH:MM)', () => {
  const GOOD = () => ({
    proposals: [prop('a'), prop('b', ROLE_DRIFT)],
    currentManaged: 300,
    populationByDataSource: { wix_orders: 300, kisi: 300 },
  });

  // Every one of these V8's Date.parse either accepts leniently or reads in
  // the server's local zone; none may reach the strike clock.
  const INVALID_SINCE = [
    // The V8-lenient strings named by the fix spec.
    ["'0' (V8: 2000-01-01 local)",                 '0'],
    ["'12' (V8: 2001-12-01 local)",                '12'],
    ["'1/1' (V8: 2001-01-01 local)",               '1/1'],
    ["'x 1' (V8: 2001-01-01 local)",               'x 1'],
    ["'2026-09-08T12:00:00' (no zone: local time)", '2026-09-08T12:00:00'],
    // Other non-strict shapes.
    ["'2026-09-08' (date only)",                   '2026-09-08'],
    ["'2026-09-08T12:00Z' (no seconds)",           '2026-09-08T12:00Z'],
    ["'2026-09-08 12:00:00Z' (space separator)",   '2026-09-08 12:00:00Z'],
    ["'2026-09-08T12:00:00+0000' (offset without colon)", '2026-09-08T12:00:00+0000'],
    ["'2026-09-08T12:00:00+00' (hours-only offset)",     '2026-09-08T12:00:00+00'],
    ["'2026-09-08 12:00:00.000+00' (pg text form)",      '2026-09-08 12:00:00.000+00'],
    ["'Tue, 08 Sep 2026 12:00:00 GMT' (RFC 2822)", 'Tue, 08 Sep 2026 12:00:00 GMT'],
    ["'2026-09-08t12:00:00z' (lower case)",        '2026-09-08t12:00:00z'],
    ["' 2026-09-08T12:00:00Z' (padded)",           ' 2026-09-08T12:00:00Z'],
    ["'2026-09-08T12:00:00Z ' (padded)",           '2026-09-08T12:00:00Z '],
    ["'2026-09-08T12:00:00Z\\n' (trailing newline)", '2026-09-08T12:00:00Z\n'],
    ["'+002026-09-08T12:00:00.000Z' (expanded year)", '+002026-09-08T12:00:00.000Z'],
    ["'2026-09-08T12:00:00.Z' (empty fraction)",   '2026-09-08T12:00:00.Z'],
    ["'2026-09-08T12:00:00.1234567890Z' (10-digit fraction)", '2026-09-08T12:00:00.1234567890Z'],
    // Impossible calendar values V8 rolls over instead of refusing.
    ["'2026-02-29T00:00:00Z' (not a leap year)",   '2026-02-29T00:00:00Z'],
    ["'2026-02-31T00:00:00Z' (V8: 3 March)",       '2026-02-31T00:00:00Z'],
    ["'2026-04-31T00:00:00Z'",                     '2026-04-31T00:00:00Z'],
    ["'2026-13-01T00:00:00Z' (month 13)",          '2026-13-01T00:00:00Z'],
    ["'2026-00-10T00:00:00Z' (month 0)",           '2026-00-10T00:00:00Z'],
    ["'2026-09-00T00:00:00Z' (day 0)",             '2026-09-00T00:00:00Z'],
    ["'2026-09-08T24:00:00Z' (V8: next midnight)", '2026-09-08T24:00:00Z'],
    ["'2026-09-08T12:60:00Z'",                     '2026-09-08T12:60:00Z'],
    ["'2026-09-08T12:00:60Z' (leap second)",       '2026-09-08T12:00:60Z'],
    ["'2026-09-08T12:00:00+24:00'",                '2026-09-08T12:00:00+24:00'],
    ["'2026-09-08T12:00:00+05:60'",                '2026-09-08T12:00:00+05:60'],
    // Before any real strike clock.
    ["'1969-12-31T23:59:59Z'",                     '1969-12-31T23:59:59Z'],
    ["'0026-09-08T12:00:00Z' (Date.UTC would read 1926)", '0026-09-08T12:00:00Z'],
    ["'0070-09-08T12:00:00Z' (Date.UTC would read 1970)", '0070-09-08T12:00:00Z'],
    ["'1970-01-01T00:30:00+01:00' (before the epoch)", '1970-01-01T00:30:00+01:00'],
    // Not strings.
    ["''",                                          ''],
    ["'   '",                                       '   '],
    ['a ms-epoch number',                          NOW - 72 * HOUR],
    ['0',                                          0],
    ['NaN',                                        NaN],
    ['true',                                       true],
    ['{}',                                         {}],
    ['[]',                                         []],
    ["a boxed String('2026-09-08T12:00:00Z')",     Object('2026-09-08T12:00:00Z')],
    ['an Invalid Date',                            new Date(NaN)],
    ['a Date before 1970',                         new Date(-1)],
    ['a forged Date (inherits Date.prototype, no Date slot)', Object.create(Date.prototype)],
  ];

  test.each(INVALID_SINCE)('since %s → hold invalid_proposal (invalid_strike_since)', (_label, since) => {
    expectInvalidAfter(GOOD, a => { a.proposals[0].strike = { since, observations: 99 }; }, 'invalid_strike_since');
  });

  test.each(INVALID_SINCE)('strikeSatisfied never treats since %s as a running clock', (_label, since) => {
    expect(strikeSatisfied({ since, observations: 99 }, NOW, STRIKE_POLICY)).toBe(false);
  });

  // 2026-09-08T12:00:00Z is exactly 48h before NOW: ripe with 3 observations.
  const BOUNDARY_MS = NOW - 48 * HOUR;
  test.each([
    ['toISOString form',              '2026-09-08T12:00:00.000Z',        BOUNDARY_MS],
    ['no fraction',                   '2026-09-08T12:00:00Z',            BOUNDARY_MS],
    ['microseconds (truncated to ms)','2026-09-08T12:00:00.000999Z',     BOUNDARY_MS],
    ['one-digit fraction',            '2026-09-08T11:59:59.5Z',          BOUNDARY_MS - 500],
    ['negative offset -07:00',        '2026-09-08T05:00:00-07:00',       BOUNDARY_MS],
    ['positive offset +05:30',        '2026-09-08T17:30:00+05:30',       BOUNDARY_MS],
    ['+00:00',                        '2026-09-08T12:00:00+00:00',       BOUNDARY_MS],
    ['-00:00',                        '2026-09-08T12:00:00-00:00',       BOUNDARY_MS],
    ['a Date object',                 new Date(BOUNDARY_MS),             BOUNDARY_MS],
  ])('%s is accepted and read as the exact instant', (_label, since, ms) => {
    const ripeOnBoundary = ms <= BOUNDARY_MS;
    expect(strikeSatisfied({ since, observations: 3 }, NOW, STRIKE_POLICY)).toBe(ripeOnBoundary);
    // 1 ms earlier on the clock → not yet 48h → not ripe (the offset is honoured, not local time).
    expect(strikeSatisfied({ since, observations: 3 }, ms + 48 * HOUR - 1, STRIKE_POLICY)).toBe(false);
    expect(strikeSatisfied({ since, observations: 3 }, ms + 48 * HOUR, STRIKE_POLICY)).toBe(true);
    const d = armed({ ...GOOD(), proposals: [prop('a', WIX_ABSENCE, { strike: { since, observations: 3 } })] });
    expect(d.reason === R.INVALID_PROPOSAL).toBe(false);
  });

  test('a leap day and the epoch itself are real instants', () => {
    for (const since of ['2028-02-29T00:00:00Z', '2000-02-29T23:59:59Z', '1970-01-01T00:00:00Z']) {
      const d = armed({ ...GOOD(), proposals: [prop('a', WIX_ABSENCE, { strike: { since, observations: 3 } })] });
      expect(d.detail).not.toBe('invalid_strike_since');
    }
  });

  test('since null (clock never started) is still valid — pending, never ripe', () => {
    const d = armed({ ...GOOD(), proposals: [prop('a', WIX_ABSENCE, { strike: { since: null, observations: 9 } })] });
    expect(d.reason).toBe(R.STRIKE_PENDING);
  });

  test('evaluateRemovals never throws on a forged Date: it refuses it', () => {
    const forged = Object.create(Date.prototype);
    const { threw, value } = outcome(() => armed({ ...GOOD(), proposals: [prop('a', WIX_ABSENCE, { strike: { since: forged, observations: 9 } })] }));
    expect(threw).toBeNull();
    expect(value.detail).toBe('invalid_strike_since');
  });
});

// A realistic well-formed batch for the R3-1 tests: a family (holder h + 2
// subs), a single member, a booking member, and one of each Kisi source — the
// ROLE_DRIFT on one of the family's subs, in the holder's unit.
const R3_BATCH = () => ({
  proposals: [
    ...family('h'),                                            // 0 holder (WIX_ABSENCE), 1–2 subs (HOLDER_LAPSE)
    prop('a'),                                                 // 3 primary, wix_orders
    prop('bk', WIX_ABSENCE, { dataSource: WIX_BOOKINGS }),     // 4 primary, wix_bookings
    prop('h###as0', ROLE_DRIFT, { unitKey: 'h' }),             // 5 Kisi finding on a sub
    prop('kv', KISI_USER_VANISHED),                            // 6 Kisi finding on a primary
  ],
  currentManaged: 300,
  populationByDataSource: { wix_orders: 300, wix_bookings: 300, kisi: 300, db: 300 },
});

describe('[P1] revoke-policy — R3-1 unit structure: a WIX_ABSENCE is its own unit, a HOLDER_LAPSE is its holder\'s', () => {
  test('control: the realistic batch is well-formed and proceeds, the family (and its sub\'s Kisi finding) counted as one unit', () => {
    const d = armed(R3_BATCH());
    expect(d.action).toBe('proceed');
    expect(d.counts).toMatchObject({ proposals: 7, proposedUnits: 4, proposedMembers: 6 });
  });

  test.each([
    ["the family's holder filed in another member's unit",       0, 'a'],
    ["a single member filed into the family's unit",              3, 'h'],
    ["a booking member (wix_bookings) filed into the family's unit", 4, 'h'],
    ['a WIX_ABSENCE in a unit named after nobody in the batch',   3, 'unit-x'],
  ])('WIX_ABSENCE: %s → hold invalid_proposal (unit_structure_invalid)', (_label, index, unitKey) => {
    expectInvalidAfter(R3_BATCH, a => { a.proposals[index].unitKey = unitKey; }, 'unit_structure_invalid');
  });

  test.each([
    ['no unitKey at all',                  a => { delete a.proposals[1].unitKey; }],
    ['unitKey explicitly undefined',       a => { a.proposals[1].unitKey = undefined; }],
    ['unitKey equal to its own memberKey', a => { a.proposals[1].unitKey = a.proposals[1].memberKey; }],
  ])("HOLDER_LAPSE with %s → hold invalid_proposal (unit_structure_invalid): a sub's unit is its holder", (_label, mutate) => {
    expectInvalidAfter(R3_BATCH, mutate, 'unit_structure_invalid');
  });

  test('a WIX_ABSENCE whose unitKey is its own memberKey, or absent, is well-formed (a holder names its own unit)', () => {
    const own = [
      prop('x', WIX_ABSENCE, { unitKey: 'x' }),
      prop('y', WIX_ABSENCE),
      prop('z', WIX_ABSENCE, { dataSource: WIX_BOOKINGS, unitKey: 'z' }),
    ];
    const d = armed({ proposals: own, currentManaged: 10, populationByDataSource: { wix_orders: 10, wix_bookings: 10 } });
    expect(d.action).toBe('proceed');
    expect(d.counts.proposedUnits).toBe(3);
  });

  test("Kisi proposals may carry any valid unitKey — the holder's for a sub, their own, or none (not checkable here)", () => {
    for (const source of [ROLE_DRIFT, KISI_USER_VANISHED]) {
      for (const unitKey of [undefined, 'k', 'some-holder']) {
        const p = prop('k', source, unitKey === undefined ? {} : { unitKey });
        const d = armed({ proposals: [p], currentManaged: 10, populationByDataSource: { kisi: 10 } });
        expect({ source, unitKey, action: d.action }).toEqual({ source, unitKey, action: 'proceed' });
      }
    }
  });

  test('a malformed unitKey is still reported as a KEY problem first, before structure', () => {
    expectInvalidAfter(R3_BATCH, a => { a.proposals[1].unitKey = null; }, 'invalid_unit_key');
    expectInvalidAfter(R3_BATCH, a => { a.proposals[0].unitKey = 'h '; }, 'padded_unit_key');
  });

  test.each([
    ['observation only', { observationOnly: true }],
    ['mode off',         { mode: 'off' }],
    ['mode dry_run',     { mode: 'dry_run' }],
  ])('a unit-structure defect is reported as an anomaly even when %s', (_label, over) => {
    const d = armed({ ...R3_BATCH(), ...over, proposals: [prop('a'), prop('b', WIX_ABSENCE, { unitKey: 'a' })] });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('unit_structure_invalid');
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
    expect(d.flush).toEqual([]);
  });

  test('REGRESSION: a real mass event split across WIX_ABSENCE members sharing one unitKey is refused — the looser structure counted it as 1 unit and let it proceed', () => {
    // HOG: all 3 members lapse, and a caller unit bug stamps one unitKey on all three.
    const proposals = ['a', 'b', 'c'].map(k => prop(k, WIX_ABSENCE, { unitKey: 'a' }));
    // What the looser structure counted: 1 unit — under the cap (2) for 3 units.
    expect(unitSet(proposals).size).toBe(1);
    expect(unitSet(proposals).size).toBeLessThan(massRevokeThreshold(3));
    const d = armed({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(d.action).toBe('hold');
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('unit_structure_invalid');
    expect(d.flush).toEqual([]);
    expect(d.held).toEqual(proposals);
    // Keyed honestly, the same event is exactly what it is: a mass revoke.
    const honest = armed({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 3, populationByDataSource: { wix_orders: 3 } });
    expect(honest.reason).toBe(R.MASS_REVOKE);
  });
});

describe('[P1] revoke-policy — R3-1 data sources: a proposal is filed under the read its evidence comes from', () => {
  // Index of one proposal of each source in R3_BATCH.
  const INDEX_OF = { [WIX_ABSENCE]: 3, [HOLDER_LAPSE]: 1, [ROLE_DRIFT]: 5, [KISI_USER_VANISHED]: 6 };
  const ILLEGAL = [];
  const LEGAL   = [];
  for (const source of Object.values(REVOKE_SOURCE)) {
    for (const ds of ALL_DATA_SOURCES) (LEGAL_DATA_SOURCES[source].includes(ds) ? LEGAL : ILLEGAL).push([source, ds]);
  }

  test('the grid: 5 legal and 11 illegal (source, data source) pairings', () => {
    expect(LEGAL).toHaveLength(5);
    expect(ILLEGAL).toHaveLength(11);
  });

  test.each(ILLEGAL)('%s filed under %s → hold invalid_proposal (data_source_mismatch)', (source, ds) => {
    expectInvalidAfter(R3_BATCH, a => { a.proposals[INDEX_OF[source]].dataSource = ds; }, 'data_source_mismatch');
  });

  test.each(LEGAL)('%s filed under %s is well-formed', (source, ds) => {
    const args = R3_BATCH();
    args.proposals[INDEX_OF[source]].dataSource = ds;
    expect(armed(args).action).toBe('proceed');
  });

  test("'db' is still a valid population and readDisagreement key — it just never carries a proposal", () => {
    const d = armed({ proposals: [prop('a')], currentManaged: 10, populationByDataSource: { wix_orders: 10, db: 10 }, readDisagreement: { db: 1 } });
    expect(d.action).toBe('proceed');
    expect(d.counts.byDataSource.db).toMatchObject({ population: 10, readDisagreement: 1, proposedUnits: 0 });
  });

  test('an unknown data source is still unknown_data_source; only a known-but-wrong one is a mismatch', () => {
    expectInvalidAfter(R3_BATCH, a => { a.proposals[3].dataSource = 'wix'; },  'unknown_data_source');
    expectInvalidAfter(R3_BATCH, a => { a.proposals[3].dataSource = 'kisi'; }, 'data_source_mismatch');
  });

  test('precedence within one proposal: the data-source pairing, then the unit structure, then the classification', () => {
    // A HOLDER_LAPSE on kisi with no unitKey and no classification → the pairing is reported.
    expectInvalidAfter(R3_BATCH, a => {
      const p = a.proposals[1];
      p.dataSource = KISI; delete p.unitKey; delete p.classification;
    }, 'data_source_mismatch');
    // A WIX_ABSENCE in another unit with a DECLINED classification → the unit structure is reported.
    expectInvalidAfter(R3_BATCH, a => {
      const p = a.proposals[3];
      p.unitKey = 'h'; p.classification = 'DECLINED';
    }, 'unit_structure_invalid');
  });

  test.each([
    ['observation only', { observationOnly: true }],
    ['mode off',         { mode: 'off' }],
    ['mode dry_run',     { mode: 'dry_run' }],
  ])('a data-source mismatch is reported as an anomaly even when %s', (_label, over) => {
    const d = armed({ ...R3_BATCH(), ...over, proposals: [prop('a', WIX_ABSENCE, { dataSource: KISI })] });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
    expect(d.detail).toBe('data_source_mismatch');
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
    expect(d.flush).toEqual([]);
  });

  test('REGRESSION: a per-source mass event filed under another data source is refused — the looser pairing let it dodge its cap', () => {
    // Every orders member (3 of 3) lapses, but the proposals are filed under a
    // data source with a big population, and the aggregate (303) is big too.
    for (const ds of [KISI, DB]) {
      const proposals = ['a', 'b', 'c'].map(k => prop(k, WIX_ABSENCE, { dataSource: ds }));
      const d = armed({ proposals, currentManaged: 303, populationByDataSource: { wix_orders: 3, [ds]: 300 } });
      expect({ ds, action: d.action, reason: d.reason, detail: d.detail, flushed: d.flush.length })
        .toEqual({ ds, action: 'hold', reason: R.INVALID_PROPOSAL, detail: 'data_source_mismatch', flushed: 0 });
    }
    // Filed honestly, the same event trips the wix_orders cap.
    const honest = armed({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 303, populationByDataSource: { wix_orders: 3, kisi: 300 } });
    expect(honest.reason).toBe(R.MASS_REVOKE);
    expect(honest.dataSource).toBe(WIX_ORDERS);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 2. INVARIANTS — deterministic property loops (no Math.random)
// ═════════════════════════════════════════════════════════════════════════

describe('[P1] revoke-policy — invariants over generated inputs', () => {
  // The data sources a proposal may be filed under (R3-1: none under 'db',
  // which still appears below as a population key).
  const PROPOSABLE_DATA_SOURCES = [WIX_ORDERS, WIX_BOOKINGS, KISI];
  const DS_MIXES = {
    allOrders:      ()  => WIX_ORDERS,
    ordersBookings: (i) => (i % 2 === 0 ? WIX_ORDERS : WIX_BOOKINGS),
    roundRobin:     (i) => PROPOSABLE_DATA_SOURCES[i % PROPOSABLE_DATA_SOURCES.length],
    kisiOnly:       ()  => KISI,
  };
  const KEY_PATTERNS = {
    distinct:   (i) => `m${i}`,
    pairs:      (i) => `m${Math.floor(i / 2)}`,          // every member has two plans
    upTo3:      (i) => `m${i % 3}`,                      // at most 3 members, many plans each
    oneMember:  ()  => 'm0',
    someRepeat: (i) => (i % 4 === 3 ? `m${i - 1}` : `m${i}`),
    families:   (i) => `m${i}`,                          // distinct members, grouped into units below
  };
  // Who each member is (P-1 / R3-1) — a property of the MEMBER, never of one
  // proposal, so one person is never both a primary and a sub:
  //   - 'families': families of 3 — m(3j) is the holder, a primary naming its
  //     own unit; m(3j+1) and m(3j+2) are its subs, in the holder's unit;
  //   - every other pattern: m<k> with k % 3 === 2 is a lone sub whose holder
  //     h<k> is not in the batch (released their seat, or never had one); the
  //     rest are primaries, each their own unit. Units stay 1:1 with members.
  function roleOf(keyName, i, memberKey) {
    if (keyName === 'families') {
      return i % 3 === 0 ? { holder: null, namesOwnUnit: true } : { holder: `m${i - (i % 3)}`, namesOwnUnit: false };
    }
    const k = Number(memberKey.slice(1));
    return k % 3 === 2 ? { holder: `h${k}`, namesOwnUnit: false } : { holder: null, namesOwnUnit: false };
  }
  // The source a proposal gets and the data source it is filed under (R3-1):
  //   drawn on kisi       → ROLE_DRIFT / KISI_USER_VANISHED, for anyone, in their unit;
  //   drawn on Wix, a sub → HOLDER_LAPSE, always under wix_orders (a sub's
  //                         evidence is its holder's ORDER, so a sub drawn on
  //                         wix_bookings is filed under wix_orders);
  //   drawn on Wix, a primary → WIX_ABSENCE, under the drawn Wix data source.
  function shapeOf(drawn, holder, i) {
    if (drawn === KISI) return { source: i % 2 === 0 ? ROLE_DRIFT : KISI_USER_VANISHED, dataSource: KISI };
    if (holder)         return { source: HOLDER_LAPSE, dataSource: WIX_ORDERS };
    return { source: WIX_ABSENCE, dataSource: drawn };
  }
  const STRIKE_PATTERNS = {
    allRipe:  () => RIPE,
    allFresh: () => FRESH,
    mixed:    (i) => [RIPE, FRESH, FEW, NO_CLOCK, undefined][i % 5],
  };
  const CLASSIFICATION_FOR = (i) => (i % 2 === 0 ? 'ENDED' : 'ABSENT');

  const BATCHES = [];
  for (let n = 0; n <= 12; n++) {
    for (const [dsName, dsFor] of Object.entries(DS_MIXES)) {
      for (const [keyName, keyFor] of Object.entries(KEY_PATTERNS)) {
        for (const [strikeName, strikeFor] of Object.entries(STRIKE_PATTERNS)) {
          BATCHES.push({
            label: `n=${n} ds=${dsName} keys=${keyName} strikes=${strikeName}`,
            proposals: Array.from({ length: n }, (_, i) => {
              const memberKey = keyFor(i);
              const { holder, namesOwnUnit } = roleOf(keyName, i, memberKey);
              const { source, dataSource } = shapeOf(dsFor(i), holder, i);
              const p = { source, memberKey, dataSource, tag: `#${i}` };
              if (holder) p.unitKey = holder;                // a sub: its holder's unit
              else if (namesOwnUnit) p.unitKey = memberKey;  // a family's holder names its own unit
              if (source === WIX_ABSENCE || source === HOLDER_LAPSE) p.classification = CLASSIFICATION_FOR(i);
              const strike = strikeFor(i);
              if (strike !== undefined) p.strike = strike;
              return p;
            }),
          });
        }
      }
    }
  }

  // Distinct UNITS (P-1), overall or within one data source.
  function distinctIn(list, ds) {
    return unitSet(ds ? list.filter(p => p.dataSource === ds) : list).size;
  }

  // Populations relative to the batch. 'under' is deliberately invalid.
  const CM_VARIANTS = {
    exact:  (d) => d,
    plus1:  (d) => d + 1,
    big:    ()  => 300,
    under:  (d) => d - 1,
  };
  const POP_VARIANTS = {
    exact:  (d) => d,
    double: (d) => d * 2,
    big:    ()  => 300,
  };
  const DISAGREEMENT_VARIANTS = {
    none:      ()     => ({}),
    one:       ()     => ({ wix_orders: 1 }),
    heavy:     (pops) => ({ wix_orders: pops.wix_orders, wix_bookings: pops.wix_bookings }),
  };
  // Fully armed, dry run, an unreadable mode ('ON' → off), and a caller that
  // forgot observationOnly. ('off' and observationOnly:true have unit tests above.)
  const ARMING = [
    { mode: 'on',      observationOnly: false },
    { mode: 'dry_run', observationOnly: false },
    { mode: 'ON',      observationOnly: false },
    { mode: 'on',      observationOnly: undefined },
  ];
  const MAX_REPORTED = 15;

  function note(violations, where, problem) {
    if (violations.length < MAX_REPORTED) violations.push(`${where}: ${problem}`);
  }

  // Independent statements of the spec's rules (not calls into the module).
  const instabilityAt = (pop) => Math.max(2, Math.ceil(pop / 4));
  const moreThanHalf  = (pop) => Math.floor(pop / 2) + 1;
  const ripe = (strike) => !!strike && strike.since !== null
    && (NOW - Date.parse(strike.since)) >= STRIKE_POLICY.minAgeMs
    && strike.observations >= STRIKE_POLICY.minObservations;

  function* cases() {
    for (const { label, proposals } of BATCHES) {
      const total = distinctIn(proposals);
      for (const [cmName, cmFor] of Object.entries(CM_VARIANTS)) {
        if (cmName === 'under' && total === 0) continue;
        for (const [popName, popFor] of Object.entries(POP_VARIANTS)) {
          const pops = {};
          for (const ds of ALL_DATA_SOURCES) pops[ds] = popFor(distinctIn(proposals, ds));
          for (const [disName, disFor] of Object.entries(DISAGREEMENT_VARIANTS)) {
            for (const arming of ARMING) {
              yield {
                where: `${label} cm=${cmName} pop=${popName} dis=${disName} mode=${arming.mode} obs=${arming.observationOnly}`,
                proposals,
                invalidByConstruction: cmName === 'under',
                args: {
                  proposals,
                  currentManaged: cmFor(total),
                  populationByDataSource: pops,
                  readDisagreement: disFor(pops),
                  now: NOW,
                  strikePolicy: STRIKE_POLICY,
                  ...arming,
                },
              };
            }
          }
        }
      }
    }
  }

  // Every generated case evaluated ONCE and shared by the invariant tests below
  // (only the fields they read are kept).
  let DECIDED = null;
  function decided() {
    if (!DECIDED) {
      DECIDED = [];
      for (const c of cases()) {
        const { action, reason, flush, held, strikePending } = evaluateRemovals(c.args);
        DECIDED.push({ ...c, d: { action, reason, flush, held, strikePending } });
      }
    }
    return DECIDED;
  }

  test('generator covers sizes 0..12, every data-source mix, key pattern (incl. unit families) and strike pattern', () => {
    expect(BATCHES).toHaveLength(13 * 4 * 6 * 3);
    // The families pattern genuinely collapses members into units: the holder
    // is the WIX_ABSENCE proposal naming its own unit, the subs are
    // HOLDER_LAPSE in the holder's unit (R3-1).
    const fam = BATCHES.find(b => b.label === 'n=12 ds=allOrders keys=families strikes=allRipe');
    expect(new Set(fam.proposals.map(p => p.memberKey)).size).toBe(12);
    expect(unitSet(fam.proposals).size).toBe(4);
    expect(fam.proposals.slice(0, 6).map(p => `${p.source}:${p.memberKey}:${p.unitKey}`)).toEqual([
      `${WIX_ABSENCE}:m0:m0`, `${HOLDER_LAPSE}:m1:m0`, `${HOLDER_LAPSE}:m2:m0`,
      `${WIX_ABSENCE}:m3:m3`, `${HOLDER_LAPSE}:m4:m3`, `${HOLDER_LAPSE}:m5:m3`,
    ]);
    expect([...new Set(BATCHES.map(b => b.proposals.length))]).toEqual(keys(13).map((_, i) => i));
  });

  test('R3-1: every generated proposal is well-formed (legal data source; a WIX_ABSENCE in its own unit; a HOLDER_LAPSE in a holder\'s) and no member is in two units', () => {
    const bad = [];
    const pairsSeen = new Set();
    for (const { label, proposals } of BATCHES) {
      const unitOfMember = new Map();
      for (const p of proposals) {
        const unit = p.unitKey === undefined ? p.memberKey : p.unitKey;
        pairsSeen.add(`${p.source}@${p.dataSource}`);
        if (!LEGAL_DATA_SOURCES[p.source].includes(p.dataSource)) bad.push(`${label} ${p.tag}: ${p.source} under ${p.dataSource}`);
        if (p.source === WIX_ABSENCE && unit !== p.memberKey) bad.push(`${label} ${p.tag}: WIX_ABSENCE in unit ${unit}`);
        if (p.source === HOLDER_LAPSE && (p.unitKey === undefined || p.unitKey === p.memberKey)) bad.push(`${label} ${p.tag}: HOLDER_LAPSE without a holder's unit`);
        if (unitOfMember.has(p.memberKey) && unitOfMember.get(p.memberKey) !== unit) bad.push(`${label} ${p.tag}: ${p.memberKey} in two units`);
        unitOfMember.set(p.memberKey, unit);
      }
    }
    expect(bad.slice(0, 15)).toEqual([]);
    // Every legal pairing is exercised, and HOLDER_LAPSE appears both in
    // families and as lone subs in the other key patterns.
    const legalPairs = Object.entries(LEGAL_DATA_SOURCES).flatMap(([s, list]) => list.map(ds => `${s}@${ds}`));
    expect([...pairsSeen].sort()).toEqual(legalPairs.sort());
    const lapsePatterns = new Set(BATCHES
      .filter(b => b.proposals.some(p => p.source === HOLDER_LAPSE))
      .map(b => /keys=(\w+)/.exec(b.label)[1]));
    expect([...lapsePatterns].sort()).toEqual(['distinct', 'families', 'pairs', 'someRepeat', 'upTo3']);
  });

  test('R3-1: one malformed proposal anywhere in any generated batch holds the WHOLE batch as invalid_proposal (a caller unit bug never partially proceeds)', () => {
    const base = { strike: RIPE };
    const INJECTIONS = [
      ["a WIX_ABSENCE in another member's unit",         () => ({ ...base, source: WIX_ABSENCE,  memberKey: 'x1', unitKey: 'm0', dataSource: WIX_ORDERS,   classification: 'ENDED' }),  'unit_structure_invalid'],
      ["a booking WIX_ABSENCE in another member's unit", () => ({ ...base, source: WIX_ABSENCE,  memberKey: 'x1', unitKey: 'm0', dataSource: WIX_BOOKINGS, classification: 'ABSENT' }), 'unit_structure_invalid'],
      ['a HOLDER_LAPSE with no unitKey',                () => ({ ...base, source: HOLDER_LAPSE, memberKey: 'x1',                dataSource: WIX_ORDERS,   classification: 'ENDED' }),  'unit_structure_invalid'],
      ['a HOLDER_LAPSE in its own unit',                () => ({ ...base, source: HOLDER_LAPSE, memberKey: 'x1', unitKey: 'x1', dataSource: WIX_ORDERS,   classification: 'ENDED' }),  'unit_structure_invalid'],
      ['a WIX_ABSENCE filed under kisi',                () => ({ ...base, source: WIX_ABSENCE,  memberKey: 'x1',                dataSource: KISI,         classification: 'ENDED' }),  'data_source_mismatch'],
      ['a HOLDER_LAPSE filed under wix_bookings',       () => ({ ...base, source: HOLDER_LAPSE, memberKey: 'x1', unitKey: 'm0', dataSource: WIX_BOOKINGS, classification: 'ENDED' }),  'data_source_mismatch'],
      ['a ROLE_DRIFT filed under wix_orders',           () => ({ ...base, source: ROLE_DRIFT,   memberKey: 'x1',                dataSource: WIX_ORDERS }),                             'data_source_mismatch'],
      ["a KISI_USER_VANISHED filed under 'db'",         () => ({ ...base, source: KISI_USER_VANISHED, memberKey: 'x1',          dataSource: DB }),                                     'data_source_mismatch'],
    ];
    const populationByDataSource = { wix_orders: 300, wix_bookings: 300, kisi: 300, db: 300 };
    const violations = [];
    let checked = 0;
    BATCHES.forEach(({ label, proposals }, b) => {
      INJECTIONS.forEach(([name, make, detail], j) => {
        const at = (b + j) % (proposals.length + 1); // a deterministic spread of positions 0..n
        const batch = [...proposals.slice(0, at), make(), ...proposals.slice(at)];
        const d = armed({ proposals: batch, currentManaged: 300, populationByDataSource });
        checked++;
        const wrong = d.action !== 'hold' || d.reason !== R.INVALID_PROPOSAL || d.detail !== detail
          || d.flush.length !== 0 || d.strikePending.length !== 0
          || d.held.length !== batch.length || d.held.some((h, i) => h !== batch[i]);
        if (wrong) note(violations, `${label} + ${name} at ${at}`, `${d.action}/${d.reason}/${d.detail}`);
      });
    });
    expect(violations).toEqual([]);
    expect(checked).toBe(BATCHES.length * INJECTIONS.length);
  });

  test('flush / held / strikePending are disjoint, every proposal lands in exactly one, every hold has a reason', () => {
    const violations = [];
    let seen = { proceed: 0, hold: 0 };
    for (const { where, proposals, args, d } of decided()) {
      if (!['proceed', 'hold'].includes(d.action)) { note(violations, where, `unknown action ${d.action}`); continue; }
      seen[d.action]++;
      const placed = new Map();
      for (const bucket of ['flush', 'held', 'strikePending']) {
        const list = d[bucket];
        if (!Array.isArray(list)) { note(violations, where, `${bucket} is not an array`); continue; }
        for (const item of list) {
          if (!proposals.includes(item)) note(violations, where, `${bucket} contains an object that is not an input proposal`);
          if (placed.has(item)) note(violations, where, `proposal ${item.tag} is in both ${placed.get(item)} and ${bucket}`);
          placed.set(item, bucket);
        }
      }
      for (const p of proposals) {
        if (!placed.has(p)) note(violations, where, `proposal ${p.tag} is in none of flush/held/strikePending`);
      }
      if (d.action === 'hold' && d.flush.length) note(violations, where, 'a hold flushed something');
      if (d.action === 'proceed' && proposals.length && !d.flush.length) note(violations, where, 'proceed with nothing flushed');
      if ((d.action === 'hold' || d.held.length || (d.strikePending.length && !d.flush.length))
          && !Object.values(REVOKE_HOLD_REASON).includes(d.reason)) {
        note(violations, where, `hold without a valid reason (${d.reason})`);
      }
      if (d.action === 'proceed' && d.reason !== null) note(violations, where, `proceed with reason ${d.reason}`);
    }
    expect(violations).toEqual([]);
    expect(seen.proceed).toBeGreaterThan(0); // both outcomes genuinely exercised
    expect(seen.hold).toBeGreaterThan(0);
  });

  test('nothing is ever flushed unless observationOnly === false AND mode is exactly "on"', () => {
    const violations = [];
    for (const { where, args, d } of decided()) {
      if (d.flush.length && !(args.observationOnly === false && args.mode === 'on')) {
        note(violations, where, `flushed ${d.flush.length}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('nothing is ever flushed whose strike is not ripe (BOTH ≥ 48h AND ≥ 3 observations)', () => {
    const violations = [];
    for (const { where, args, d } of decided()) {
      for (const p of d.flush) if (!ripe(p.strike)) note(violations, where, `flushed ${p.tag} with an unripe strike`);
    }
    expect(violations).toEqual([]);
  });

  test('never flushes when the batch is more than half of the aggregate (cm ≥ 2) or of any data source (pop ≥ 2)', () => {
    const violations = [];
    for (const { where, proposals, args, d } of decided()) {
      if (!d.flush.length) continue;
      const cm = args.currentManaged;
      if (cm >= 2 && distinctIn(proposals) >= moreThanHalf(cm)) note(violations, where, 'flushed an aggregate mass revoke');
      for (const ds of ALL_DATA_SOURCES) {
        const pop = args.populationByDataSource[ds];
        if (pop >= 2 && distinctIn(proposals, ds) >= moreThanHalf(pop)) note(violations, where, `flushed a ${ds} mass revoke`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('never flushes while any data source is unstable', () => {
    const violations = [];
    for (const { where, args, d } of decided()) {
      if (!d.flush.length) continue;
      for (const [ds, disagreed] of Object.entries(args.readDisagreement)) {
        if (disagreed > 0 && disagreed >= instabilityAt(args.populationByDataSource[ds])) note(violations, where, `flushed while ${ds} unstable`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('anomaly precedence: invalid, then unstable, then mass are reported whatever the mode or observationOnly — empty batches included (R3-2)', () => {
    const violations = [];
    let emptyUnstable = 0;
    for (const { where, proposals, args, invalidByConstruction, d } of decided()) {
      const unstable = Object.entries(args.readDisagreement)
        .some(([ds, n]) => n > 0 && n >= instabilityAt(args.populationByDataSource[ds]));
      const mass = (args.currentManaged >= 2 && distinctIn(proposals) >= moreThanHalf(args.currentManaged))
        || ALL_DATA_SOURCES.some(ds => args.populationByDataSource[ds] >= 2 && distinctIn(proposals, ds) >= moreThanHalf(args.populationByDataSource[ds]));
      let expected = null;
      if (invalidByConstruction) expected = R.INVALID_PROPOSAL;
      else if (unstable)         expected = R.SNAPSHOT_UNSTABLE;
      else if (mass)             expected = R.MASS_REVOKE;
      if (expected && d.reason !== expected) note(violations, where, `expected ${expected}, got ${d.reason}`);
      if (!expected && ANOMALY_HOLD_REASONS.includes(d.reason)) note(violations, where, `spurious anomaly ${d.reason}`);
      if (proposals.length === 0 && expected === R.SNAPSHOT_UNSTABLE) emptyUnstable++;
    }
    expect(violations).toEqual([]);
    expect(emptyUnstable).toBeGreaterThan(0); // the empty-batch instability path is genuinely exercised
  });

  test('with no anomaly, the non-anomaly reason follows the spec order: observation → mode → strikes (an empty batch simply proceeds)', () => {
    const violations = [];
    for (const { where, proposals, args, d } of decided()) {
      if (ANOMALY_HOLD_REASONS.includes(d.reason)) continue;
      if (proposals.length === 0) {
        if (d.action !== 'proceed' || d.reason !== null) note(violations, where, `empty batch without an anomaly: ${d.action}/${d.reason}`);
        continue;
      }
      let expected;
      if (args.observationOnly !== false)  expected = R.OBSERVATION_ONLY;
      else if (args.mode === 'dry_run')    expected = R.DRY_RUN;
      else if (args.mode !== 'on')         expected = R.AUTO_REVOKE_OFF;
      else if (!proposals.some(p => ripe(p.strike))) expected = R.STRIKE_PENDING;
      else expected = null;
      if (d.reason !== expected) note(violations, where, `expected ${expected}, got ${d.reason}`);
      if (expected === null) {
        const wantFlush = proposals.filter(p => ripe(p.strike));
        const wantWait  = proposals.filter(p => !ripe(p.strike));
        if (d.flush.length !== wantFlush.length || d.flush.some((p, i) => p !== wantFlush[i])) note(violations, where, 'flush is not exactly the ripe proposals in input order');
        if (d.strikePending.length !== wantWait.length || d.strikePending.some((p, i) => p !== wantWait[i])) note(violations, where, 'strikePending is not exactly the unripe proposals in input order');
      }
    }
    expect(violations).toEqual([]);
  });

  test('deterministic and key-order independent: reversing the population / disagreement key order changes nothing', () => {
    const violations = [];
    let i = 0;
    let sampled = 0;
    for (const { where, args } of cases()) {
      if (i++ % 5 !== 0) continue; // a fixed, deterministic sample
      sampled++;
      const reversed = {
        ...args,
        populationByDataSource: Object.fromEntries(Object.entries(args.populationByDataSource).reverse()),
        readDisagreement: Object.fromEntries(Object.entries(args.readDisagreement).reverse()),
      };
      const a = JSON.stringify(evaluateRemovals(args));
      const b = JSON.stringify(evaluateRemovals(args));
      const c = JSON.stringify(evaluateRemovals(reversed));
      if (b !== a || c !== a) note(violations, where, 'decision changed between identical / reordered calls');
    }
    expect(violations).toEqual([]);
    expect(sampled).toBeGreaterThan(1000);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 3. ADVERSARIAL — inputs that try to make the policy remove when it should hold
//
// Every test here asserts the SAFE outcome, with removal fully ARMED (mode 'on',
// observationOnly false, every strike ripe). A red test is a finding about
// core/revoke-policy.js. Do not edit these tests to match the code.
// ═════════════════════════════════════════════════════════════════════════

describe('[P1] revoke-policy ADVERSARIAL A1 — a missing or padded memberKey must not collapse or split the member count', () => {
  // If memberKey were counted as-is, every proposal whose key is undefined / null
  // / '' would collapse into ONE "member": 300 proposals count as 1 — below every
  // threshold, straight to 'proceed'. A padded key (' m1') splits one member into
  // two and never matches a DB row. Safe: refuse (throw) or hold.
  const HOG = { currentManaged: 3, populationByDataSource: { wix_orders: 3 } };

  test.each([
    ['absent (caller used platformMemberId)', (i) => ({ source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: `m${i}` })],
    ['null',                                  (i) => ({ source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: `m${i}`, memberKey: null })],
    ["'' (empty string)",                     (i) => ({ source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: `m${i}`, memberKey: '' })],
    ["padded (' m0', ' m1', ' m2')",          (i) => ({ source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, memberKey: ` m${i}` })],
  ])('HOG F1 batch (all 3 of 3) with memberKey %s → must not flush', (_label, make) => {
    const proposals = [0, 1, 2].map(make);
    expectFailsClosed(() => armed({ ...HOG, proposals }));
  });

  test('300 managed: 300 keyless proposals (every member) → must not flush', () => {
    const proposals = keys(300).map(k => ({ source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: k }));
    expectFailsClosed(() => armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } }));
  });

  test('HOG: 1 keyed + 2 keyless proposals → nobody removed', () => {
    const proposals = [
      prop('a'),
      { source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: 'b' },
      { source: WIX_ABSENCE, dataSource: WIX_ORDERS, strike: RIPE, platformMemberId: 'c' },
    ];
    expect(removedBy({ ...HOG, proposals })).toHaveLength(0);
  });

  test("padding cannot dodge the cap: 'a' and 'a ' as one member plus 'b' at HOG → nobody removed", () => {
    expect(removedBy({ ...HOG, proposals: [prop('a'), prop('a '), prop('b')] })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A2 — the mass cap must survive a missing or undercounted currentManaged', () => {
  // A failed count query, or a count of status='active' taken while two members
  // are momentarily 'in_flight', must not switch the cap off. A batch naming
  // more distinct members than currentManaged says exist is provably wrong input.

  test.each([
    ['undefined (not passed / query failed)', undefined],
    ['null', null],
    ['NaN', NaN],
    ['0', 0],
    ['1 (undercount: two members momentarily in_flight)', 1],
    ["'3' (numeric string)", '3'],
    ['2.5 (fractional)', 2.5],
  ])('HOG F1: currentManaged %s, all 3 proposed → nobody removed', (_label, currentManaged) => {
    expect(removedBy({ proposals: wixProps(['a', 'b', 'c']), currentManaged, populationByDataSource: { wix_orders: 3 } })).toHaveLength(0);
  });

  test('a batch naming more distinct members (3) than currentManaged says exist (1) → hold', () => {
    expectFailsClosed(() => armed({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 1, populationByDataSource: { wix_orders: 3 } }));
  });

  test('currentManaged undercounted but still ≥ 2 (true population 3, caller says 2) → hold', () => {
    const d = armed({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 2, populationByDataSource: { wix_orders: 3 } });
    expect(d.action).toBe('hold');
    expect(d.flush).toEqual([]);
  });

  test('bulk scale: currentManaged 1 (undercount), all 300 proposed → nobody removed', () => {
    expect(removedBy({ proposals: wixProps(keys(300)), currentManaged: 1, populationByDataSource: { wix_orders: 300 } })).toHaveLength(0);
  });

  test.each([
    ['undefined', undefined], ['null', null], ['NaN', NaN], ["'3'", '3'], ['0', 0],
  ])('the per-source population %s cannot switch the per-source cap off → nobody removed', (_label, population) => {
    expect(removedBy({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 100, populationByDataSource: { wix_orders: population } })).toHaveLength(0);
  });

  test('omitting the per-source population entirely cannot switch the per-source cap off → nobody removed', () => {
    expect(removedBy({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 100, populationByDataSource: {} })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A3 — a mass drop both reads agree on is still a mass revoke', () => {
  // The double read cannot tell a persistent partial failure from real
  // cancellations — it agrees with itself. The cap is what stops it.

  test('bulk import: 300 imported members with no Wix order (currentManaged 303) → nobody removed', () => {
    expect(removedBy({
      proposals: wixProps(keys(300, 'imported-')), currentManaged: 303, populationByDataSource: { wix_orders: 303 },
    })).toHaveLength(0);
  });

  test('pagination truncation: Wix returns only the first 50 of 300 members, identically on both reads (no disagreement) → the other 250 are not removed', () => {
    expect(removedBy({
      proposals: wixProps(keys(300).slice(50)), currentManaged: 300, populationByDataSource: { wix_orders: 300 },
      readDisagreement: { wix_orders: 0 },
    })).toHaveLength(0);
  });

  test('splitting a mass drop across data sources does not dodge the aggregate cap (100 orders + 51 kisi of 300)', () => {
    const proposals = [...wixProps(keys(100, 'o')), ...keys(51, 'k').map(k => prop(k, ROLE_DRIFT))];
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300, kisi: 300 } });
    expect(d.reason).toBe(R.MASS_REVOKE);
    expect(d.dataSource).toBeNull();
    expect(d.flush).toEqual([]);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A4 — large swings between the two reads hold as an anomaly', () => {
  test('300 managed: 150 members flipped between the two reads → hold as an anomaly even though only a few are proposed', () => {
    const d = armed({
      proposals: wixProps(keys(10)), currentManaged: 300, populationByDataSource: { wix_orders: 300 },
      readDisagreement: { wix_orders: 150 },
    });
    expect({ action: d.action, flushed: d.flush.length }).toEqual({ action: 'hold', flushed: 0 });
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('10 managed: 4 members flipped between the reads → hold as an anomaly', () => {
    const d = armed({
      proposals: wixProps(keys(2)), currentManaged: 10, populationByDataSource: { wix_orders: 10 },
      readDisagreement: { wix_orders: 4 },
    });
    expect({ action: d.action, flushed: d.flush.length }).toEqual({ action: 'hold', flushed: 0 });
    expect(ANOMALY_HOLD_REASONS).toContain(d.reason);
  });

  test('control: a single member renewing between the reads does not block the rest', () => {
    const d = armed({
      proposals: wixProps(keys(2)), currentManaged: 10, populationByDataSource: { wix_orders: 10 },
      readDisagreement: { wix_orders: 1 },
    });
    expect(d.action).toBe('proceed');
  });
});

describe('[P1] revoke-policy ADVERSARIAL A5 — a near-total batch of door members is never removed on one pass', () => {
  // v1 took max(currentManaged, Wix baseline) and a large Wix baseline switched
  // the re-check off. v3 has no baseline input: every limit is judged against
  // the at-risk populations only.
  test('50 door members: a glitch hides 49 of them → nobody removed', () => {
    expect(removedBy({ proposals: wixProps(keys(49)), currentManaged: 50, populationByDataSource: { wix_orders: 50 } })).toHaveLength(0);
  });

  test('HOG-sized: a glitch hides 2 of 3 door members → nobody removed', () => {
    expect(removedBy({ proposals: wixProps(['a', 'b']), currentManaged: 3, populationByDataSource: { wix_orders: 3 } })).toHaveLength(0);
  });

  test('an unknown extra population key (e.g. a stale Wix baseline) is refused, not used', () => {
    const d = armed({ proposals: wixProps(['a', 'b']), currentManaged: 3, populationByDataSource: { wix_orders: 3, baseline: 300 } });
    expect(d.reason).toBe(R.INVALID_PROPOSAL);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A6 — the instability check must not trust a missing or invalid readDisagreement', () => {
  // One wrong variable in the caller (readDisagreement read off the wrong
  // object, or still keyed with v2's 'wix') must not silently switch the
  // instability check off while 150 members are flapping.
  const base = { proposals: wixProps(keys(10)), currentManaged: 300, populationByDataSource: { wix_orders: 300 } };

  test('control: 150 flapping orders members are held as snapshot_unstable', () => {
    expect(armed({ ...base, readDisagreement: { wix_orders: 150 } }).reason).toBe(R.SNAPSHOT_UNSTABLE);
  });

  test.each([
    ['undefined (caller forgot to pass it)', undefined],
    ['null', null],
    ["keyed by v2's 'wix'", { wix: 150 }],
    ["keyed 'orders'", { orders: 150 }],
    ['a Map', new Map([['wix_orders', 150]])],
    ["the count as a string '150'", { wix_orders: '150' }],
    ['NaN', { wix_orders: NaN }],
  ])('readDisagreement %s → must not flush', (_label, readDisagreement) => {
    expectFailsClosed(() => armed({ ...base, readDisagreement }));
  });
});

describe('[P1] revoke-policy ADVERSARIAL A7 — an EMPTY second read cannot confirm a removal', () => {
  // An HTTP 200 that parses as zero orders (the OB-85 signature) on the second
  // read means every member paying in the first read "disagreed". The caller
  // unions the reads (so nobody is proposed from it), and the policy holds the
  // batch as unstable in case anything else was proposed.
  test('HOG: every paying member flipped between reads (second read empty) → nobody removed', () => {
    expect(removedBy({
      proposals: wixProps(['a']), currentManaged: 3, populationByDataSource: { wix_orders: 3 },
      readDisagreement: { wix_orders: 3 },
    })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A8 — members a source can never propose must not dilute its cap', () => {
  // currentManaged includes members the orders endpoint can never propose —
  // sub-members and booking-only members. One such member and "every orders
  // member is gone" is N of N+1. The per-data-source cap is what catches it.
  test.each([
    ['one sub-member (never a Wix-absence candidate)',               { wix_orders: 3 }],
    ['one booking member (still visible via the bookings endpoint)', { wix_orders: 3, wix_bookings: 1 }],
  ])('HOG: 3 orders members + %s; orders parse empty on both reads → nobody removed', (_label, populationByDataSource) => {
    expect(removedBy({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 4, populationByDataSource })).toHaveLength(0);
  });

  test('bigger gym: 20 orders members all proposed, 200 booking members fine (aggregate 220) → nobody removed', () => {
    expect(removedBy({
      proposals: wixProps(keys(20)), currentManaged: 220, populationByDataSource: { wix_orders: 20, wix_bookings: 200 },
    })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A9 — a caller unit bug must not hide a mass event inside one unit', () => {
  // Units are what every cap counts (P-1). If lapsed primary members could share
  // a unitKey, one wrong join in the caller would collapse a whole-gym lapse
  // into "1 unit" — below every threshold, straight to 'proceed'.
  test('HOG: all 3 members lapse, stamped with one shared unitKey → nobody removed', () => {
    const proposals = ['a', 'b', 'c'].map(k => prop(k, WIX_ABSENCE, { unitKey: 'u' }));
    expect(removedBy({ proposals, currentManaged: 3, populationByDataSource: { wix_orders: 3 } })).toHaveLength(0);
  });

  test("300 managed: 200 lapsed members stamped with one member's key → nobody removed", () => {
    const proposals = keys(200).map(k => prop(k, WIX_ABSENCE, { unitKey: 'm0' }));
    expect(removedBy({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } })).toHaveLength(0);
  });

  test("hidden inside a genuine family's unit: a real family plus 150 primaries stamped with the holder's key → nobody removed", () => {
    const proposals = [...family('h'), ...keys(150).map(k => prop(k, WIX_ABSENCE, { unitKey: 'h' }))];
    expect(removedBy({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } })).toHaveLength(0);
  });

  test('split across both Wix reads: every orders AND booking member lapses under one shared unitKey → nobody removed', () => {
    const proposals = [
      ...keys(2, 'o').map(k => prop(k, WIX_ABSENCE, { unitKey: 'u' })),
      ...keys(2, 'b').map(k => prop(k, WIX_ABSENCE, { unitKey: 'u', dataSource: WIX_BOOKINGS })),
    ];
    expect(removedBy({ proposals, currentManaged: 4, populationByDataSource: { wix_orders: 2, wix_bookings: 2 } })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A10 — filing proposals under the wrong data source must not dodge a per-source cap', () => {
  // Each per-source cap judges a proposal against its own dataSource's
  // population. Filed under a data source with a big population, a whole
  // source's lapse looks routine.
  test('every orders member (3 of 3) lapses, filed under kisi (population 300) → nobody removed', () => {
    const proposals = ['a', 'b', 'c'].map(k => prop(k, WIX_ABSENCE, { dataSource: KISI }));
    expect(removedBy({ proposals, currentManaged: 303, populationByDataSource: { wix_orders: 3, kisi: 300 } })).toHaveLength(0);
  });

  test('every Kisi-checked member (3 of 3) vanishes, filed under wix_orders (population 300) → nobody removed', () => {
    const proposals = ['a', 'b', 'c'].map(k => prop(k, KISI_USER_VANISHED, { dataSource: WIX_ORDERS }));
    expect(removedBy({ proposals, currentManaged: 303, populationByDataSource: { wix_orders: 300, kisi: 3 } })).toHaveLength(0);
  });

  test("a lapse filed under 'db' (population 300) → nobody removed", () => {
    const proposals = ['a', 'b', 'c'].map(k => prop(k, HOLDER_LAPSE, { dataSource: DB, unitKey: `h-${k}` }));
    expect(removedBy({ proposals, currentManaged: 303, populationByDataSource: { wix_orders: 3, db: 300 } })).toHaveLength(0);
  });
});

describe('[P1] revoke-policy ADVERSARIAL A11 — a sweep that proposes nothing cannot launder a flapping read', () => {
  // The caller moves strike clocks after any decision that is not an anomaly.
  // For an EMPTY batch the unsafe outcome is therefore a clean 'proceed' on
  // reads that disagreed badly — or that could not be judged at all: clocks are
  // cleared and nobody is told. Safe: hold as an anomaly (nothing to flush).
  const base = { proposals: [], currentManaged: 300, populationByDataSource: { wix_orders: 300 } };

  function expectAnomalyHold(d) {
    expect({ action: d.action, anomaly: ANOMALY_HOLD_REASONS.includes(d.reason), flushed: d.flush.length })
      .toEqual({ action: 'hold', anomaly: true, flushed: 0 });
  }

  test('150 of 300 orders units flipped between the reads, nothing proposed → held as snapshot_unstable', () => {
    const d = armed({ ...base, readDisagreement: { wix_orders: 150 } });
    expectAnomalyHold(d);
    expect(d.reason).toBe(R.SNAPSHOT_UNSTABLE);
  });

  test('HOG: the second read came back empty (all 3 flipped), nothing proposed → held as an anomaly', () => {
    expectAnomalyHold(armed({ proposals: [], currentManaged: 3, populationByDataSource: { wix_orders: 3 }, readDisagreement: { wix_orders: 3 } }));
  });

  test.each([
    ['undefined (caller forgot to pass it)', undefined],
    ['null', null],
    ["keyed by v2's 'wix'", { wix: 150 }],
    ["keyed 'orders'", { orders: 150 }],
    ['a Map', new Map([['wix_orders', 150]])],
    ["the count as a string '150'", { wix_orders: '150' }],
    ['NaN', { wix_orders: NaN }],
    ['a flap with no population to judge it by', { wix_bookings: 150 }],
  ])('readDisagreement %s, nothing proposed → held as an anomaly, never proceed', (_label, readDisagreement) => {
    expectAnomalyHold(armed({ ...base, readDisagreement }));
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a Map', new Map([['wix_orders', 300]])],
    ["'300' (string)", { wix_orders: '300' }],
    ["keyed by v2's 'wix'", { wix: 300 }],
  ])('populationByDataSource %s with a flapping read, nothing proposed → held as an anomaly, never proceed', (_label, populationByDataSource) => {
    expectAnomalyHold(armed({ ...base, populationByDataSource, readDisagreement: { wix_orders: 150 } }));
  });
});

// ═════════════════════════════════════════════════════════════════════════
// 4. ADVERSARIAL GUARDS
// ═════════════════════════════════════════════════════════════════════════

describe('[P1] revoke-policy ADVERSARIAL — guards', () => {
  test('mistyped or unknown sources are never flushed', () => {
    const proposals = [
      { source: 'wix-absence', memberKey: 'a', dataSource: WIX_ORDERS, strike: RIPE },
      { source: 'WIX_ABSENCE', memberKey: 'b', dataSource: WIX_ORDERS, strike: RIPE },
      { source: undefined,     memberKey: 'c', dataSource: WIX_ORDERS, strike: RIPE },
    ];
    const d = armed({ proposals, currentManaged: 300, populationByDataSource: { wix_orders: 300 } });
    expect(d.flush).toEqual([]);
    expect(d.held).toEqual(proposals);
  });

  test('a null entry in proposals → refused rather than flushing', () => {
    expectFailsClosed(() => armed({ proposals: [prop('a'), null], currentManaged: 300, populationByDataSource: { wix_orders: 300 } }));
  });

  test('populations passed as a Map or Set (no own entries — would read as "empty") are refused', () => {
    for (const populationByDataSource of [new Map([['wix_orders', 3]]), new Set([3])]) {
      expectFailsClosed(() => armed({ proposals: wixProps(['a', 'b', 'c']), currentManaged: 100, populationByDataSource }));
    }
  });

  test('mass non-Wix batch (299 Kisi-vanished of 300) is never removed', () => {
    expect(removedBy({
      proposals: keys(299).map(k => prop(k, KISI_USER_VANISHED)),
      currentManaged: 300, populationByDataSource: { kisi: 300 },
    })).toHaveLength(0);
  });

  test('a strike cannot be forged ripe with a numeric since or string observations → refused', () => {
    for (const strike of [{ since: NOW - 999 * HOUR, observations: 99 }, { since: RIPE.since, observations: '99' }]) {
      expectFailsClosed(() => armed({ proposals: [prop('a', WIX_ABSENCE, { strike })], currentManaged: 300, populationByDataSource: { wix_orders: 300 } }));
    }
  });

  test('a garbage strikePolicy cannot flush a batch whose strikes are not ripe', () => {
    for (const strikePolicy of [undefined, null, {}, { minAgeMs: NaN, minObservations: NaN }, { minAgeMs: '0', minObservations: '0' }]) {
      expectFailsClosed(() => armed({
        proposals: wixProps(['a'], { strike: FRESH }), currentManaged: 300, populationByDataSource: { wix_orders: 300 }, strikePolicy,
      }));
    }
  });

  test('a garbage now cannot age a strike into ripeness', () => {
    for (const now of [undefined, null, NaN, Infinity, String(NOW + 999 * HOUR), new Date(NOW + 999 * HOUR)]) {
      expectFailsClosed(() => armed({
        proposals: wixProps(['a'], { strike: FRESH }), currentManaged: 300, populationByDataSource: { wix_orders: 300 }, now,
      }));
    }
  });
});
