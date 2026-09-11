/**
 * @file revoke-policy.js
 * @layer core/layer4
 * @role pure-policy
 * @reads none
 * @writes none
 * @exports REVOKE_SOURCE, DATA_SOURCE, REVOKE_MODE, REVOKE_HOLD_REASON, ANOMALY_HOLD_REASONS,
 *          DEFAULT_STRIKE_POLICY, REMOVABLE_CLASSIFICATIONS, CLASSIFICATION_REQUIRED_SOURCES,
 *          DATA_SOURCES_BY_SOURCE,
 *          normalizeMode, revalidationThreshold, massRevokeThreshold, strikeSatisfied,
 *          evaluateRemovals
 *
 * revoke-policy.js — v3
 * Core Engine (Layer 4)
 *
 * Decides what happens to the removals the reconciliation sweep wants to make.
 *
 * Pure by design: no DB, no queue, no clock, no network. Every function takes
 * plain data and returns plain data. The caller (core/reconciliation.js) does
 * the I/O — reading clients.auto_revoke_mode, reading Wix twice, reading Kisi,
 * recording proposals — and asks this module for one decision per sweep. "Now"
 * is injected; the module never reads the clock.
 *
 * ── Why it exists (reconciliation safety pass, 2026-09-10) ───────────────────
 * Verified against production:
 *  1. The old mass-revoke gate only armed when last_active_member_count > 5.
 *     House of Gains sat at 3, so across 244 production sweeps it never fired
 *     once. It switched itself off precisely when losing a member hurts most.
 *  2. Only one of the sweep's revoke paths (3B, Wix absence) went through the
 *     gate at all.
 *  3. When the re-fetch confirmed a drop, 3B revoked the FIRST snapshot's list —
 *     including members who had reappeared in the second.
 *
 * ── v3 (Phase 1 of the reconciliation plan) ──────────────────────────────────
 * v2's conditional "revalidate → re-fetch → resolve" two-step is gone. The
 * sweep now ALWAYS reads Wix twice and treats a member as paying if EITHER read
 * says so (union). What reaches this module is therefore already the
 * intersection of two absences; the only question left about the vendor data is
 * whether the two reads disagreed so much that neither can be trusted. That is
 * `readDisagreement`, judged per data source.
 *
 * Phase 1 passes `observationOnly: true`: every proposal is recorded and held,
 * whatever the mode. Phase 3b arms removal by passing `false`; from then on the
 * mode and the strike clock decide.
 *
 * ── The sweep is a backstop ───────────────────────────────────────────────────
 * A member who cancels in Wix is removed in real time by the webhook path
 * (core/webhook-processor.js), which this module never touches. The sweep's
 * removals exist to catch what the webhooks missed. So a removal this policy
 * holds back is delayed, not lost — and the bias is deliberately towards
 * holding: a wrongly removed member is locked out of the building; a wrongly
 * retained one is a revenue leak an operator is alerted to.
 *
 * ── The model ─────────────────────────────────────────────────────────────────
 * A "proposal" is one removal the sweep wants to make:
 *   { source, memberKey, unitKey?, dataSource, classification?, planId?,
 *     strike?: { since, observations }, ... }
 * The policy reads source, memberKey, unitKey, dataSource, classification and
 * strike; callers may attach any other fields (accessId, a prepared job
 * payload) and get the very same objects back, unmodified, in input order.
 *
 * ── Units (fix round, 2026-09-10) ─────────────────────────────────────────────
 * Every count this policy judges is a count of distinct UNITS, not members. A
 * unit is one paying relationship: a primary member, or a family — the plan
 * holder plus that holder's sub-members, all sharing the holder's
 * platform_member_id as their `unitKey`. `unitKey` is optional and defaults to
 * `memberKey`; when present it must be a non-empty, unpadded string.
 *
 * Why: one family's plan lapsing proposes the holder (WIX_ABSENCE) and every
 * sub (HOLDER_LAPSE) at once. Counted as members, a gym of two single members
 * and one family of three sees one ordinary family cancellation as 3 of 5 — a
 * "mass revoke" — while the populations themselves were padded by subs that
 * can only ever leave together with their holder. Counted as units it is 1 of
 * 3. The unit count is what the aggregate cap, the per-data-source caps, the
 * proposals ⊆ population check and `counts.proposedUnits` all use.
 *
 * The caller's side of that contract (it cannot be checked here beyond ⊆):
 *   - `currentManaged` and every `populationByDataSource` entry are counts of
 *     distinct units at risk, under the same collapse rule;
 *   - `readDisagreement` is counted in units too: a family whose holder's
 *     PAYING status differs between the two reads counts once.
 * A unit count is only honest if the populations collapse the same way the
 * proposals do; mixing member-counted populations with unit-keyed proposals
 * makes every cap looser than intended.
 *
 * ── Unit structure (fix round 3, 2026-09-10) ──────────────────────────────────
 * Units are what every cap counts, so a unit bug in the caller is a cap bug:
 * three lapsed primary members stamped with one shared unitKey would count as
 * 1 unit of 3 — a mass event sailing under every cap. The policy cannot see
 * the family tree, but it refuses the two shapes the sweep never builds:
 *   - WIX_ABSENCE is a primary member's own absence (a family's holder is its
 *     own family's unit key): its unitKey, when present, must equal memberKey.
 *   - HOLDER_LAPSE is a sub-member's, and a sub's unit is its holder: its
 *     unitKey is required and must differ from memberKey.
 * Anything else holds the whole batch as INVALID_PROPOSAL
 * (`unit_structure_invalid`). Kisi proposals (KISI_USER_VANISHED / ROLE_DRIFT)
 * carry the holder's key for a sub and the member's own key otherwise; which is
 * right cannot be seen here, so their unitKey is only checked as a key.
 *
 * ── Data sources (fix round 3, 2026-09-10) ────────────────────────────────────
 * Each source's evidence comes from one kind of read, and a proposal must be
 * filed under it (DATA_SOURCES_BY_SOURCE):
 *   WIX_ABSENCE                    → wix_orders or wix_bookings
 *   HOLDER_LAPSE                   → wix_orders (it is the holder's ORDER that lapsed)
 *   KISI_USER_VANISHED, ROLE_DRIFT → kisi
 * Anything else holds the whole batch as INVALID_PROPOSAL
 * (`data_source_mismatch`). A proposal filed under the wrong data source is
 * judged against the wrong population: three of three orders members filed
 * under 'kisi' (population 300) would slip past the wix_orders cap. 'db' stays
 * in the vocabulary as a population / readDisagreement key, but no source
 * proposes from it.
 *
 * ── Classification (fix round, 2026-09-10) ────────────────────────────────────
 * WIX_ABSENCE and HOLDER_LAPSE proposals MUST carry `classification` — the
 * member's Wix order classification for that plan (for HOLDER_LAPSE, the
 * holder's), best across both reads — and it must be exactly 'ENDED' or
 * 'ABSENT' (no order or booking in either read). Anything else — missing,
 * null, 'DECLINED', 'PENDING', 'UNKNOWN', 'PAYING', wrong case, padded — holds
 * the whole batch as INVALID_PROPOSAL (detail `classification_not_removable`).
 * A declined or pending payment is not a cancellation: those members are left
 * alone here and handled by suspension (Phase 4), never removal. The caller
 * must never propose them; this check is defence in depth.
 * KISI_USER_VANISHED / ROLE_DRIFT proposals do not need a classification and
 * it is not checked on them.
 *
 * ── Strike `since` ────────────────────────────────────────────────────────────
 * Accepted only as a valid Date object, or a strict ISO-8601 instant string —
 * `YYYY-MM-DDTHH:MM:SS`, optional fraction, then `Z` or an explicit `±HH:MM`
 * offset — checked field by field (real calendar date, hours 00–23, …) BEFORE
 * any parsing, and not earlier than 1970-01-01T00:00:00Z. V8's Date.parse is
 * lenient: it reads '12', '1/1', 'x 1', '0' as dates in 2000/2001 (a strike
 * "ripe" by decades) and a timezone-less ISO string in the server's local
 * zone. Anything outside the strict form is INVALID_PROPOSAL
 * (`invalid_strike_since`). `since: null` means the clock never started: valid,
 * never ripe.
 *
 * evaluateRemovals() checks, in this order:
 *   1. invalid input       → hold INVALID_PROPOSAL   (a caller bug never partially proceeds)
 *   2. snapshot unstable   → hold SNAPSHOT_UNSTABLE  (the two reads disagree too much)
 *   3. mass removal        → hold MASS_REVOKE        (more than half of a population at once)
 *   4. observation only    → hold OBSERVATION_ONLY   (Phase 1: record, never remove)
 *   5. mode off / dry_run  → hold AUTO_REVOKE_OFF / DRY_RUN
 *   6. strike clock        → proposals whose strike is not yet met → strikePending
 *   7. otherwise           → proceed with the rest
 * Anomalies (1–3) are checked BEFORE observation and mode, so a client whose
 * removals are paused still learns its data looks broken.
 *
 * Every hold (1–5) holds the WHOLE batch: a snapshot that is wrong for one
 * source of evidence is not trusted to be right for the rest this sweep.
 *
 * ── An empty batch is still judged (fix round 3, 2026-09-10) ──────────────────
 * With nothing proposed there is nothing to cap, observe or age (3–6), but the
 * two reads are still judged: populationByDataSource and readDisagreement are
 * validated by the same rules as a non-empty batch (1), and a data source whose
 * reads disagreed by at least its threshold holds the (empty) batch as
 * SNAPSHOT_UNSTABLE (2) — flush and held both empty, dataSource and detail set.
 * A disagreement with no population to judge it by is INVALID_PROPOSAL
 * (`missing_population_for_disagreement`, the same detail as in a non-empty
 * batch). Why: the caller moves strike clocks only after a non-anomaly
 * decision. An empty batch that came back 'proceed' let a sweep whose reads
 * disagreed badly clear clocks and raise no anomaly. currentManaged, now and
 * strikePolicy are not consulted for an empty batch, so they are not validated
 * there (as before).
 *
 * ── Two limits, two failure modes ─────────────────────────────────────────────
 * The double read catches TRANSIENT failures: a blip that is gone seconds later.
 * It cannot catch a PERSISTENT one — a Wix API change that parses as empty (the
 * OB-85 failure mode) or a pagination bug returns the same wrong answer twice
 * and the reads agree. The mass-revoke cap is what stops those: no automatic
 * sweep removes more than half of any population in one run, no matter how
 * many times the data agrees with itself.
 *
 * ── Populations ───────────────────────────────────────────────────────────────
 * Every limit is judged against the population actually at risk — units
 * AccessSync currently treats as provisioned, measured from the DB and Kisi.
 * Yesterday's Wix member count is deliberately NOT an input: a larger baseline
 * pushes thresholds UP, which is the unsafe direction.
 *
 * Proposals are judged in aggregate (`currentManaged`) AND against their own
 * data source's population (`populationByDataSource`). Without the per-source
 * check, units a source can never propose (booking-only members, say) padded
 * the denominator: "every orders unit is gone" looked like 3 of 4 rather than
 * 3 of 3.
 */

'use strict';

// Instability starts at a quarter of the population — the ratio the old gate
// used for its "suspicious volume" band.
const REVOKE_RATIO_THRESHOLD = 0.25;

// A disagreement smaller than this is never "unstable" on count alone. Without
// an absolute floor, one member renewing between the two reads at a 3-member
// client (1/3 = 33%) would hold every removal.
const REVOKE_MIN_ABSOLUTE = 2;

// The mass-revoke cap does not apply to a population of one: for a 1-member
// client, "more than half" is one ordinary cancellation.
const MASS_REVOKE_MIN_POPULATION = 2;

const REVOKE_SOURCE = Object.freeze({
  KISI_USER_VANISHED: 'kisi_user_vanished', // Pass 3 (a) — Kisi user deleted out-of-band
  ROLE_DRIFT:         'role_drift',         // Pass 3 (b) — expected Kisi role assignment missing
  HOLDER_LAPSE:       'holder_lapse',       // Pass 1.5  — sub-member's plan holder no longer paying
  WIX_ABSENCE:        'wix_absence',        // 3B        — provisioned, paying in neither Wix read
});

// Which read a proposal's evidence came from. Each proposal carries its own
// dataSource; its population must be supplied, and the mass cap and the
// instability check are applied per data source.
const DATA_SOURCE = Object.freeze({
  WIX_ORDERS:   'wix_orders',
  WIX_BOOKINGS: 'wix_bookings',
  KISI:         'kisi',
  DB:           'db',   // a population / readDisagreement key only — no source proposes from it
});

// The data sources each source's evidence may be filed under (see "Data
// sources" above). A proposal filed under any other is data_source_mismatch.
const DATA_SOURCES_BY_SOURCE = Object.freeze({
  [REVOKE_SOURCE.WIX_ABSENCE]:        Object.freeze([DATA_SOURCE.WIX_ORDERS, DATA_SOURCE.WIX_BOOKINGS]),
  [REVOKE_SOURCE.HOLDER_LAPSE]:       Object.freeze([DATA_SOURCE.WIX_ORDERS]),
  [REVOKE_SOURCE.KISI_USER_VANISHED]: Object.freeze([DATA_SOURCE.KISI]),
  [REVOKE_SOURCE.ROLE_DRIFT]:         Object.freeze([DATA_SOURCE.KISI]),
});

// clients.auto_revoke_mode. See normalizeMode().
const REVOKE_MODE = Object.freeze({
  OFF:     'off',
  DRY_RUN: 'dry_run',
  ON:      'on',
});

const REVOKE_HOLD_REASON = Object.freeze({
  INVALID_PROPOSAL:  'invalid_proposal',  // malformed input — a caller bug
  SNAPSHOT_UNSTABLE: 'snapshot_unstable', // the two reads of one data source disagreed too much
  MASS_REVOKE:       'mass_revoke',       // more than half of a population at once
  AUTO_REVOKE_OFF:   'auto_revoke_off',   // operator mode 'off' (or unreadable) — intentional
  DRY_RUN:           'dry_run',           // operator mode 'dry_run' — record, don't remove
  STRIKE_PENDING:    'strike_pending',    // not paying, but not for long enough / often enough yet
  OBSERVATION_ONLY:  'observation_only',  // the caller has not armed removal (Phase 1)
});

// Hold reasons that mean something needs a human, as opposed to an operator's
// deliberate choice or the policy simply waiting. reconciliation.js raises an
// operator alert for these.
const ANOMALY_HOLD_REASONS = Object.freeze([
  REVOKE_HOLD_REASON.INVALID_PROPOSAL,
  REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE,
  REVOKE_HOLD_REASON.MASS_REVOKE,
]);

// The approved strike: not paying for at least ~2 days, seen on at least 3
// sweeps. Exported for the caller's convenience; evaluateRemovals still
// requires strikePolicy to be passed explicitly.
const DEFAULT_STRIKE_POLICY = Object.freeze({
  minAgeMs:        48 * 60 * 60 * 1000,
  minObservations: 3,
});

// The only Wix classifications a removal may rest on: the order ended
// (ENDED — core/wix-order-classification.js) or neither read had any order or
// booking for that (member, plan) at all (ABSENT — core/reconciliation.js).
// DECLINED / PENDING / UNKNOWN / PAYING are never removable.
const REMOVABLE_CLASSIFICATIONS = Object.freeze(['ENDED', 'ABSENT']);

// Sources whose evidence is a Wix absence, so the proposal must say WHICH kind
// of absence (see "Classification" above). Kisi sources are not checked.
const CLASSIFICATION_REQUIRED_SOURCES = Object.freeze([
  REVOKE_SOURCE.WIX_ABSENCE,
  REVOKE_SOURCE.HOLDER_LAPSE,
]);

const _KNOWN_SOURCES      = Object.values(REVOKE_SOURCE);
// Fixed iteration order: decisions never depend on the caller's key order.
const _DATA_SOURCE_ORDER  = Object.freeze(Object.values(DATA_SOURCE));

// What a stringified missing value looks like (`${undefined}`, String(null),
// String({})). A key like that would collapse every such proposal into one
// "member" or "unit" — the A1 undercount — so it is treated as missing.
const _STRINGIFIED_NOTHING = Object.freeze(['undefined', 'null', 'NaN', '[object Object]']);

/**
 * clients.auto_revoke_mode, fail-closed. Only the exact strings 'dry_run' and
 * 'on' are honoured; anything else — null because the read failed, undefined
 * because the migration has not been applied, 'ON', ' on', true — is 'off'.
 *
 * @param {*} raw
 * @returns {'off'|'dry_run'|'on'}
 */
function normalizeMode(raw) {
  if (raw === REVOKE_MODE.ON) return REVOKE_MODE.ON;
  if (raw === REVOKE_MODE.DRY_RUN) return REVOKE_MODE.DRY_RUN;
  return REVOKE_MODE.OFF;
}

/**
 * How many members may disagree between the two reads of one data source
 * before that data source is considered unstable.
 *
 * @param {number} population  members currently provisioned (the population at risk)
 * @returns {number}
 */
function revalidationThreshold(population) {
  return Math.max(REVOKE_MIN_ABSOLUTE, Math.ceil((Number(population) || 0) * REVOKE_RATIO_THRESHOLD));
}

/**
 * The fewest distinct members that count as a mass revoke: strictly more than
 * half the population.
 *
 * @param {number} population
 * @returns {number}
 */
function massRevokeThreshold(population) {
  return Math.floor((Number(population) || 0) / 2) + 1;
}

function _isCount(n) {
  return Number.isInteger(n) && n >= 0;
}

// Proposals and strikes: any non-array object (callers build them as literals;
// the fields read are checked individually).
function _isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// The keyed maps (populations, disagreements, strike policy) must be plain
// objects: a Map, Set or class instance has no own enumerable entries, so it
// would read as "empty" and silently switch a check off.
function _isPlainObject(v) {
  if (!_isRecord(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// 'missing' | 'padded' | null for a memberKey / unitKey.
function _keyProblem(key) {
  if (typeof key !== 'string' || key.trim() === '' || _STRINGIFIED_NOTHING.includes(key)) return 'missing';
  // A padded key is a different Set entry from the same key unpadded, so
  // ' m1' and 'm1' would count twice — and never match a DB row.
  if (key !== key.trim()) return 'padded';
  return null;
}

// The unit a proposal belongs to (see "Units" above). Absent → its own member.
function _unitOf(p) {
  return p.unitKey === undefined ? p.memberKey : p.unitKey;
}

// See "Unit structure" above. Called only once memberKey, unitKey and source
// have been validated.
function _unitStructureValid(p) {
  // A primary member's own absence: its own unit, never someone else's.
  if (p.source === REVOKE_SOURCE.WIX_ABSENCE)  return p.unitKey === undefined || p.unitKey === p.memberKey;
  // A sub-member's unit is its holder: named, and not the sub itself.
  if (p.source === REVOKE_SOURCE.HOLDER_LAPSE) return p.unitKey !== undefined && p.unitKey !== p.memberKey;
  return true; // Kisi sources: the caller's unit, not checkable here
}

// Only ever called on validated proposals, where every memberKey and unitKey
// is a non-empty, unpadded string — so a Set gives an honest distinct count.
function _distinctMembers(proposals) {
  return new Set(proposals.map(p => p.memberKey)).size;
}

function _distinctUnits(proposals) {
  return new Set(proposals.map(_unitOf)).size;
}

function _fromDataSource(proposals, dataSource) {
  return proposals.filter(p => p.dataSource === dataSource);
}

// Strict ISO-8601 instant (see "Strike `since`" above). Fields are captured and
// range-checked below; V8's Date.parse is never consulted.
const _ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const _MIN_SINCE_YEAR = 1970;

function _daysInMonth(year, month) {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

// ms epoch of a strict ISO-8601 instant string, or null.
function _isoInstantMs(s) {
  const m = _ISO_INSTANT.exec(s);
  if (!m) return null;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  // Below 1970 is never a real strike clock — and Date.UTC maps years 0–99 to 19xx.
  if (year < _MIN_SINCE_YEAR) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > _daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  if (m[8] !== 'Z') {
    const offH = Number(m[10]), offM = Number(m[11]);
    if (offH > 23 || offM > 59) return null;
    offsetMinutes = (offH * 60 + offM) * (m[9] === '-' ? -1 : 1);
  }
  const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const t = Date.UTC(year, month - 1, day, hour, minute, second, millis) - offsetMinutes * 60 * 1000;
  return Number.isFinite(t) && t >= 0 ? t : null;
}

// ms epoch of a strike's `since`, or null when it is absent or not strictly
// valid. A Date is recognised by its internal slot (getTime throws on anything
// else, including an object merely inheriting Date.prototype), so a forged
// "Date" is refused rather than thrown from here.
function _sinceMs(since) {
  if (typeof since === 'string') return _isoInstantMs(since);
  if (since !== null && typeof since === 'object') {
    let t;
    try {
      t = Date.prototype.getTime.call(since);
    } catch (_) {
      return null;
    }
    return Number.isFinite(t) && t >= 0 ? t : null;
  }
  return null;
}

function _strikeProblem(strike) {
  if (strike === undefined || strike === null) return null; // no clock yet → pending, not invalid
  if (!_isRecord(strike)) return 'invalid_strike';
  if (strike.since !== null && _sinceMs(strike.since) === null) return 'invalid_strike_since';
  if (!_isCount(strike.observations)) return 'invalid_strike_observations';
  return null;
}

/**
 * Has this proposal been not-paying long enough, and often enough, to act on?
 * BOTH conditions must hold. A missing strike, or a clock that never started
 * (`since: null` — e.g. the strike columns are not migrated yet), never
 * qualifies. Pure: `now` is passed in.
 *
 * @param {{since: string|Date|null, observations: number}|null|undefined} strike
 * @param {number} now  ms epoch
 * @param {{minAgeMs: number, minObservations: number}} strikePolicy
 * @returns {boolean}
 */
function strikeSatisfied(strike, now, strikePolicy) {
  if (!_isRecord(strike) || !_isPlainObject(strikePolicy)) return false;
  if (!Number.isFinite(now)) return false;
  const { minAgeMs, minObservations } = strikePolicy;
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) return false;
  if (!_isCount(minObservations)) return false;
  const since = _sinceMs(strike.since);
  if (since === null) return false;
  if (!_isCount(strike.observations)) return false;
  return (now - since) >= minAgeMs && strike.observations >= minObservations;
}

// populationByDataSource: a plain object of known data-source keys, each a
// count of units. Shared by empty and non-empty batches (one rule, one detail).
function _populationProblem(populationByDataSource) {
  if (!_isPlainObject(populationByDataSource)) return 'invalid_population_by_data_source';
  for (const [dataSource, population] of Object.entries(populationByDataSource)) {
    if (!_DATA_SOURCE_ORDER.includes(dataSource)) return `unknown_population_key:${dataSource}`;
    if (!_isCount(population)) return `invalid_population:${dataSource}`;
  }
  return null;
}

// readDisagreement: a plain object of known data-source keys, each a count of
// units, and every non-zero one judged against a supplied population. Shared
// by empty and non-empty batches. The double read is a core protection: a
// missing readDisagreement must not silently switch the instability check off
// (pass {} when the reads agreed).
function _readDisagreementProblem(readDisagreement, populationByDataSource) {
  if (!_isPlainObject(readDisagreement)) return 'invalid_read_disagreement';
  for (const [dataSource, disagreed] of Object.entries(readDisagreement)) {
    if (!_DATA_SOURCE_ORDER.includes(dataSource)) return `unknown_read_disagreement_key:${dataSource}`;
    if (!_isCount(disagreed)) return `invalid_read_disagreement:${dataSource}`;
    // A disagreement cannot be judged without the population it is judged against.
    if (disagreed > 0 && !Object.prototype.hasOwnProperty.call(populationByDataSource, dataSource)) {
      return 'missing_population_for_disagreement';
    }
  }
  return null;
}

/**
 * Returns null when the input is well-formed, otherwise a short machine-readable
 * detail. The policy refuses to reason about input it cannot trust — a proposal
 * with no member key would silently collapse into one "member" and undercount
 * the batch; a population smaller than the proposals means the caller's
 * arithmetic is wrong; an unknown data-source key (e.g. v2's 'wix') would
 * silently switch a check off.
 */
function _validate({ proposals, currentManaged, populationByDataSource, readDisagreement, now, strikePolicy }) {
  if (!Array.isArray(proposals)) return 'proposals_not_array';
  for (const p of proposals) {
    if (!_isRecord(p)) return 'proposal_not_object';
    const memberKeyProblem = _keyProblem(p.memberKey);
    if (memberKeyProblem === 'missing') return 'missing_member_key';
    if (memberKeyProblem === 'padded') return 'padded_member_key';
    // unitKey is optional (absent = the member's own unit), but a present one
    // must be as trustworthy as a memberKey: a null / '' / 'undefined' unitKey
    // shared by many proposals would collapse them into ONE unit.
    if (p.unitKey !== undefined) {
      const unitKeyProblem = _keyProblem(p.unitKey);
      if (unitKeyProblem === 'missing') return 'invalid_unit_key';
      if (unitKeyProblem === 'padded') return 'padded_unit_key';
    }
    if (!_KNOWN_SOURCES.includes(p.source)) return 'unknown_source';
    if (!_DATA_SOURCE_ORDER.includes(p.dataSource)) return 'unknown_data_source';
    // Filed under the read its evidence comes from (see "Data sources").
    if (!DATA_SOURCES_BY_SOURCE[p.source].includes(p.dataSource)) return 'data_source_mismatch';
    // A unit shaped the way the sweep builds one (see "Unit structure").
    if (!_unitStructureValid(p)) return 'unit_structure_invalid';
    // A Wix-absence removal must rest on an ENDED order or no order at all —
    // never a declined, pending or unrecognised payment.
    if (CLASSIFICATION_REQUIRED_SOURCES.includes(p.source)
        && !(typeof p.classification === 'string' && REMOVABLE_CLASSIFICATIONS.includes(p.classification))) {
      return 'classification_not_removable';
    }
    const strikeProblem = _strikeProblem(p.strike);
    if (strikeProblem) return strikeProblem;
  }

  // Populations are counts of distinct UNITS (see "Units" above).
  if (!_isCount(currentManaged)) return 'invalid_current_managed';
  if (_distinctUnits(proposals) > currentManaged) return 'proposals_exceed_population';

  const populationProblem = _populationProblem(populationByDataSource);
  if (populationProblem) return populationProblem;
  for (const dataSource of _DATA_SOURCE_ORDER) {
    const fromSource = _fromDataSource(proposals, dataSource);
    if (fromSource.length === 0) continue;
    if (!Object.prototype.hasOwnProperty.call(populationByDataSource, dataSource)) {
      return `missing_population:${dataSource}`;
    }
    if (_distinctUnits(fromSource) > populationByDataSource[dataSource]) {
      return `proposals_exceed_population:${dataSource}`;
    }
  }

  const disagreementProblem = _readDisagreementProblem(readDisagreement, populationByDataSource);
  if (disagreementProblem) return disagreementProblem;

  if (typeof now !== 'number' || !Number.isFinite(now) || now < 0) return 'invalid_now';
  if (!_isPlainObject(strikePolicy)) return 'invalid_strike_policy';
  if (typeof strikePolicy.minAgeMs !== 'number' || !Number.isFinite(strikePolicy.minAgeMs) || strikePolicy.minAgeMs < 0) {
    return 'invalid_strike_policy:min_age_ms';
  }
  if (!_isCount(strikePolicy.minObservations)) return 'invalid_strike_policy:min_observations';
  return null;
}

/** First data source whose two reads disagreed by at least its threshold, or null. */
function _unstableDataSource(populationByDataSource, readDisagreement) {
  for (const dataSource of _DATA_SOURCE_ORDER) {
    const disagreed = readDisagreement[dataSource] || 0;
    if (disagreed === 0) continue;
    if (disagreed >= revalidationThreshold(populationByDataSource[dataSource])) return dataSource;
  }
  return null;
}

/**
 * Checks the mass-revoke cap in aggregate and per data source, in distinct
 * UNITS against unit-counted populations.
 * @returns {null | {dataSource: string|null}}  dataSource null = aggregate
 */
function _massRevoke(proposals, currentManaged, populationByDataSource) {
  if (currentManaged >= MASS_REVOKE_MIN_POPULATION
      && _distinctUnits(proposals) >= massRevokeThreshold(currentManaged)) {
    return { dataSource: null };
  }
  for (const dataSource of _DATA_SOURCE_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(populationByDataSource, dataSource)) continue;
    const population = populationByDataSource[dataSource];
    if (population < MASS_REVOKE_MIN_POPULATION) continue;
    if (_distinctUnits(_fromDataSource(proposals, dataSource)) >= massRevokeThreshold(population)) {
      return { dataSource };
    }
  }
  return null;
}

function _counts(proposals, { flush, held, strikePending, strikeReady = null, currentManaged = null }) {
  const valid = Array.isArray(proposals);
  return {
    proposals:          valid ? proposals.length : 0,
    // Distinct units — what every cap and population check counts.
    proposedUnits:      null,
    // Distinct members — informational (a family is 1 unit, several members).
    proposedMembers:    null,
    flush:              flush.length,
    held:               held.length,
    strikePending:      strikePending.length,
    // How many proposals would clear the strike clock if nothing else held
    // them — what 'on' would do. Lets a dry_run / observation-only sweep log
    // an honest preview. null when the input could not be trusted.
    strikeReady,
    currentManaged,
    massThreshold:      currentManaged === null ? null : massRevokeThreshold(currentManaged),
    byDataSource:       {},
  };
}

function _decision(action, reason, { proposals, flush = [], held = [], strikePending = [], detail = null, dataSource = null, counts }) {
  return {
    action, reason, detail, dataSource, flush, held, strikePending,
    counts: counts || _counts(proposals, { flush, held, strikePending }),
  };
}

// counts.byDataSource for trusted input: every data source with a population
// or a proposal, in the fixed order.
function _byDataSource(proposals, populationByDataSource, readDisagreement) {
  const byDataSource = {};
  for (const dataSource of _DATA_SOURCE_ORDER) {
    const present = Object.prototype.hasOwnProperty.call(populationByDataSource, dataSource);
    const fromSource = _fromDataSource(proposals, dataSource);
    if (!present && fromSource.length === 0) continue;
    const population = present ? populationByDataSource[dataSource] : null;
    byDataSource[dataSource] = {
      proposedUnits:         _distinctUnits(fromSource),
      proposedMembers:       _distinctMembers(fromSource),
      population,
      readDisagreement:      readDisagreement[dataSource] || 0,
      instabilityThreshold:  population === null ? null : revalidationThreshold(population),
      massThreshold:         population === null ? null : massRevokeThreshold(population),
    };
  }
  return byDataSource;
}

/**
 * An empty batch (see "An empty batch is still judged" above): nothing to cap,
 * observe or age, but the two reads are judged exactly as for a non-empty
 * batch. Flush, held and strikePending are always empty.
 */
function _evaluateEmptyBatch(populationByDataSource, readDisagreement) {
  const invalid = _populationProblem(populationByDataSource)
    || _readDisagreementProblem(readDisagreement, populationByDataSource);
  if (invalid) {
    return _decision('hold', REVOKE_HOLD_REASON.INVALID_PROPOSAL, { proposals: [], detail: invalid });
  }
  const counts = {
    ..._counts([], { flush: [], held: [], strikePending: [], strikeReady: 0 }),
    proposedUnits:   0,
    proposedMembers: 0,
    byDataSource:    _byDataSource([], populationByDataSource, readDisagreement),
  };
  const unstable = _unstableDataSource(populationByDataSource, readDisagreement);
  if (unstable) {
    return _decision('hold', REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE, {
      proposals: [], dataSource: unstable, detail: 'read_disagreement', counts,
    });
  }
  return _decision('proceed', null, { proposals: [], counts });
}

/**
 * The single decision over every removal the sweep wants to make.
 *
 * @param {Object} args
 * @param {Array<{source: string, memberKey: string, unitKey?: string, dataSource: string,
 *                classification?: string,
 *                strike?: {since: string|Date|null, observations: number}}>} args.proposals
 *   `unitKey` defaults to memberKey — on WIX_ABSENCE it may only BE memberKey,
 *   on HOLDER_LAPSE it is required and must differ from it (the holder).
 *   `dataSource` must be one DATA_SOURCES_BY_SOURCE allows for `source`.
 *   `classification` ('ENDED'|'ABSENT') is REQUIRED on WIX_ABSENCE and
 *   HOLDER_LAPSE proposals. An empty array is still judged for instability.
 * @param {number} args.currentManaged  distinct UNITS AccessSync currently treats
 *   as provisioned for this client — the population at risk. Every proposal's
 *   unit must be part of it. (Not consulted for an empty batch.)
 * @param {Object<string, number>} args.populationByDataSource  distinct units each
 *   data source could propose from, keyed by DATA_SOURCE value. REQUIRED for
 *   every dataSource that appears in proposals, and for every data source with
 *   a non-zero readDisagreement.
 * @param {Object<string, number>} args.readDisagreement  per data source, units
 *   whose paying status differed between the two reads. Missing entry = 0; the
 *   object itself is required ({} when the reads agreed), empty batch included.
 * @param {*} args.mode  raw clients.auto_revoke_mode — see normalizeMode()
 * @param {boolean} args.observationOnly  anything but an explicit `false` holds
 *   everything (Phase 1 passes true)
 * @param {number} args.now  ms epoch, injected
 * @param {{minAgeMs: number, minObservations: number}} args.strikePolicy
 * @returns {{action: 'proceed'|'hold', reason: string|null, detail: string|null,
 *            dataSource: string|null, flush: Array, held: Array,
 *            strikePending: Array, counts: Object}}
 */
function evaluateRemovals(args = {}) {
  const {
    proposals, currentManaged, populationByDataSource, readDisagreement,
    mode, observationOnly, now, strikePolicy,
  } = (args && typeof args === 'object') ? args : {};

  // Nothing proposed: nothing to cap, observe or age — but the two reads are
  // still judged (fix round 3). A clean 'proceed' here would let the caller
  // move strike clocks on reads that disagreed badly.
  if (Array.isArray(proposals) && proposals.length === 0) {
    return _evaluateEmptyBatch(populationByDataSource, readDisagreement);
  }

  const invalid = _validate({ proposals, currentManaged, populationByDataSource, readDisagreement, now, strikePolicy });
  if (invalid) {
    const held = Array.isArray(proposals) ? proposals.slice() : [];
    return _decision('hold', REVOKE_HOLD_REASON.INVALID_PROPOSAL, { proposals, held, detail: invalid });
  }

  // ── From here the input is trusted. ──
  const all = proposals.slice();
  const ready   = all.filter(p => strikeSatisfied(p.strike, now, strikePolicy));
  const waiting = all.filter(p => !strikeSatisfied(p.strike, now, strikePolicy));

  const byDataSource = _byDataSource(all, populationByDataSource, readDisagreement);
  const countsFor = (flush, held, strikePending) => ({
    ..._counts(all, { flush, held, strikePending, strikeReady: ready.length, currentManaged }),
    proposedUnits:   _distinctUnits(all),
    proposedMembers: _distinctMembers(all),
    byDataSource,
  });
  const holdAll = (reason, extra = {}) =>
    _decision('hold', reason, { proposals: all, held: all, ...extra, counts: countsFor([], all, []) });

  // 2. Anomaly: the two reads of one data source disagree too much.
  const unstable = _unstableDataSource(populationByDataSource, readDisagreement);
  if (unstable) {
    return holdAll(REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE, { dataSource: unstable, detail: 'read_disagreement' });
  }

  // 3. Anomaly: more than half of a population at once.
  const mass = _massRevoke(all, currentManaged, populationByDataSource);
  if (mass) {
    return holdAll(REVOKE_HOLD_REASON.MASS_REVOKE, {
      dataSource: mass.dataSource, detail: mass.dataSource === null ? 'aggregate' : 'per_data_source',
    });
  }

  // 4. The caller has not armed removal. Fail-closed: only an explicit false arms.
  if (observationOnly !== false) return holdAll(REVOKE_HOLD_REASON.OBSERVATION_ONLY);

  // 5. Operator mode.
  const normalized = normalizeMode(mode);
  if (normalized === REVOKE_MODE.OFF)     return holdAll(REVOKE_HOLD_REASON.AUTO_REVOKE_OFF);
  if (normalized === REVOKE_MODE.DRY_RUN) return holdAll(REVOKE_HOLD_REASON.DRY_RUN);

  // 6. Strike clock.
  if (ready.length === 0) {
    return _decision('hold', REVOKE_HOLD_REASON.STRIKE_PENDING, {
      proposals: all, strikePending: waiting, counts: countsFor([], [], waiting),
    });
  }

  // 7. Proceed with the proposals whose strike is met; the rest keep waiting.
  return _decision('proceed', null, {
    proposals: all, flush: ready, strikePending: waiting, counts: countsFor(ready, [], waiting),
  });
}

module.exports = {
  REVOKE_SOURCE,
  DATA_SOURCE,
  REVOKE_MODE,
  REVOKE_HOLD_REASON,
  ANOMALY_HOLD_REASONS,
  DEFAULT_STRIKE_POLICY,
  REMOVABLE_CLASSIFICATIONS,
  CLASSIFICATION_REQUIRED_SOURCES,
  DATA_SOURCES_BY_SOURCE,
  REVOKE_RATIO_THRESHOLD,
  REVOKE_MIN_ABSOLUTE,
  MASS_REVOKE_MIN_POPULATION,
  normalizeMode,
  revalidationThreshold,
  massRevokeThreshold,
  strikeSatisfied,
  evaluateRemovals,
};
