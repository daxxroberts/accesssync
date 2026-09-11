/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Phase 1 "stop the bleeding" — the reconciliation sweep is    │
 * │  OBSERVATION-ONLY for removals and grants only PAYING plans             │
 * │                                                                         │
 * │  Business consequence: the sweep runs every 6 hours against a real gym  │
 * │  with live paying members. Found 2026-09-10:                            │
 * │    - a Kisi error made getManagedRoleAssignments return [] → Pass 3     │
 * │      would have revoked every active member, ungated                    │
 * │    - 3B revoked with no planId (a silent no-op) and inflated 'revoked'  │
 * │    - Pass 1.5 lapsed the subs of a holder who only left their OWN seat  │
 * │    - the sweep granted ACTIVE orders whose payment was still UNPAID     │
 * │    - boot sweep, cron and manual /sync/run could overlap                │
 * │                                                                         │
 * │  PHASE 1 INVARIANT: _syncClient enqueues ZERO revoke jobs under every   │
 * │  input, and reports revoked = 0. The afterEach below fails ANY test in  │
 * │  this file that lets a 'revoke' reach eventQueue.add.                   │
 * │                                                                         │
 * │  Real modules: core/revoke-policy.js (v3 — wrapped only to read its     │
 * │  inputs), core/wix-order-classification.js, core/event-routing.js.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn() },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks:                  jest.fn(),
  getManagedRoleAssignments: jest.fn(),
  listAllUsers:              jest.fn(),
}));

jest.mock('../../adapters/standard-adapter', () => ({
  releaseStaleLocks:                  jest.fn().mockResolvedValue(0),
  markKisiUserObservation:            jest.fn().mockResolvedValue(),
  rollupAccessStatusByPlatformMember: jest.fn().mockResolvedValue(),
  recordNotPayingObservation:         jest.fn(),
  clearNotPayingObservation:          jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders:      jest.fn(),
  listConfirmedBookings: jest.fn(),
  listOrdersClassified:  jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(enc => `plain-${enc}`) }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: false, reason: 'test' }) }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() })),
}));

// The REAL policy, wrapped in a jest.fn only so tests can read exactly what the
// sweep asked it (proposals, populations, observationOnly).
jest.mock('../../core/revoke-policy', () => {
  const actual = jest.requireActual('../../core/revoke-policy');
  return { ...actual, evaluateRemovals: jest.fn(actual.evaluateRemovals) };
});

let mockTraceSeq = 0;
jest.mock('../../core/trace-context', () => ({
  runWith:     jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => `trace-gate-${++mockTraceSeq}`),
  getTraceId:  jest.fn(() => 'trace-gate-ctx'),
  getActor:    jest.fn(() => ({ type: 'system', id: 'reconciliation-test' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const standardAdapter = require('../../adapters/standard-adapter');
const wixPlansApi     = require('../../adapters/wix/wix-plans-api');
const cryptoUtils     = require('../../core/crypto-utils');
const revokePolicy    = require('../../core/revoke-policy');
const { eventQueue }  = require('../../core/webhook-processor');
const { log }         = require('../../core/logger');
const reconciliation  = require('../../core/reconciliation');

const CLIENT_ID = 'client-gate-001';
const RUN_ID    = 'run-gate-001';
const SWEEP_ID  = 'sweep-trace-gate';
const GROUP_ID  = 'kisi-group-main';
const PLAN_ID   = 'plan-monthly';
const PLAN_B    = 'plan-annual';

// ─── Scenario builder ────────────────────────────────────────────────────────
// One object describes the world; installWorld() answers every query the sweep
// makes by matching SQL text, so a test reads as "what is true" rather than as a
// positional chain of mock return values.

function member(key, overrides = {}) {
  return {
    key,                           // member_master.platform_member_id
    accessId: `ma-${key}`,
    hwUser:   `ku-${key}`,
    plans:    [PLAN_ID],           // ACTIVE member_access_sources.source_plan_id values
    sourceType: 'plan',
    isSub:    false,
    holderKey: null,               // sub-members: the holder's platform_member_id
    inKisiUsers: true,             // present in Kisi's user list (Pass 3)
    hasRole:  true,                // holds its group_basic role on GROUP_ID
    disappearedObservedAt: null,   // OB-249 two-strike marker
    ...overrides,
  };
}

// A classified Wix order, as adapters/wix/wix-plans-api listOrdersClassified returns it.
function order(memberId, planId = PLAN_ID, classification = 'PAYING') {
  const status = { PAYING: 'ACTIVE', PENDING: 'ACTIVE', DECLINED: 'PAUSED', ENDED: 'ENDED', UNKNOWN: 'ACTIVE' }[classification];
  const lastPaymentStatus = { PAYING: 'PAID', PENDING: 'UNPAID', DECLINED: 'FAILED', ENDED: 'PAID', UNKNOWN: 'NOT_APPLICABLE' }[classification];
  return {
    orderId: `ord-${memberId}-${planId}-${classification}`, memberId, planId, classification,
    status, lastPaymentStatus, autoRenewCanceled: false, endDate: null, rawOrder: null,
  };
}
const paying = (keys, planId = PLAN_ID) => keys.map(k => order(k, planId, 'PAYING'));
const reads  = (orders, bookings = []) => ({ orders, bookings });

// Advisory locks modelled like Postgres: one holder at a time, per connection.
const lockTable = { holder: null };
const conns = [];
let connSeq = 0;
function makeConn(behaviour = {}) {
  const conn = {
    id: `conn-${++connSeq}`,
    query: jest.fn(async (sql) => {
      const s = String(sql);
      if (s.includes('pg_try_advisory_lock')) {
        if (behaviour.lockThrows) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        if (lockTable.holder && lockTable.holder !== conn) return { rows: [{ locked: false }] };
        lockTable.holder = conn;
        return { rows: [{ locked: true }] };
      }
      if (s.includes('pg_advisory_unlock')) {
        if (behaviour.unlockThrows) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
        if (lockTable.holder === conn) { lockTable.holder = null; return { rows: [{ unlocked: true }] }; }
        return { rows: [{ unlocked: false }] };
      }
      throw new Error(`unexpected query on the lock connection: ${s}`);
    }),
    release: jest.fn(),
  };
  return conn;
}

const state = { alerts: [], seats: new Map() };

function installWorld(world = {}) {
  const members  = world.members || [];
  const byAccess = new Map(members.map(m => [m.accessId, m]));
  const read1    = world.read1 || reads([]);
  const read2    = world.read2 || read1;
  const unresolved = new Set(world.existingAlerts || []); // `${alert_type}|${hardware_ref}`
  state.alerts = [];
  // Source-row seats Pass 1 may promote: `${platformMemberId}|${planId}` → status.
  state.seats = new Map((world.cancelledSeats || []).map(([key, planId]) => [`${key}|${planId}`, 'cancelled']));

  hardwareAdapter.getManagedRoleAssignments.mockReset();
  if (world.kisiAssignmentsThrow) {
    hardwareAdapter.getManagedRoleAssignments.mockRejectedValue(
      Object.assign(new Error('KISI_PAGE_INTEGRITY: /role_assignments — non_array_page'), { code: 'KISI_PAGE_INTEGRITY' })
    );
  } else {
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue(
      members.filter(m => m.hasRole).map(m => ({ userId: m.hwUser, groupId: GROUP_ID, roleAssignmentId: `ra-${m.key}` }))
    );
  }
  hardwareAdapter.listAllUsers.mockReset();
  if (world.listUsersThrows) {
    hardwareAdapter.listAllUsers.mockRejectedValue(Object.assign(new Error('Kisi 503'), { statusCode: 503 }));
  } else {
    hardwareAdapter.listAllUsers.mockResolvedValue(
      members.filter(m => m.inKisiUsers).map(m => ({ id: m.hwUser, email: null, name: null }))
    );
  }

  // Read 1, then read 2 (the sweep always reads Wix twice).
  wixPlansApi.listOrdersClassified.mockReset();
  wixPlansApi.listConfirmedBookings.mockReset();
  if (world.read1Throws) wixPlansApi.listOrdersClassified.mockRejectedValueOnce(world.read1Throws);
  else                   wixPlansApi.listOrdersClassified.mockResolvedValueOnce(read1.orders);
  if (world.read2Throws) wixPlansApi.listOrdersClassified.mockRejectedValueOnce(world.read2Throws);
  else                   wixPlansApi.listOrdersClassified.mockResolvedValueOnce(read2.orders);
  wixPlansApi.listConfirmedBookings
    .mockResolvedValueOnce(read1.bookings || [])
    .mockResolvedValueOnce(read2.bookings || []);

  db.query.mockImplementation(async (sql, params = []) => {
    const s = String(sql);
    const empty = { rows: [], rowCount: 0 };

    if (s.includes('INSERT INTO reconciliation_run')) return { rows: [{ id: RUN_ID }], rowCount: 1 };
    if (s.includes('SELECT auto_revoke_mode FROM clients')) {
      if (world.modeThrows) throw Object.assign(new Error('column "auto_revoke_mode" does not exist'), { code: '42703' });
      return { rows: [{ auto_revoke_mode: world.mode === undefined ? 'dry_run' : world.mode }], rowCount: 1 };
    }
    // Kisi user id → platform member id bridge (builds kisiMembers)
    if (s.includes('ma.hardware_user_id = ANY($2)')) {
      const ids = params[1] || [];
      const rows = members.filter(m => ids.includes(m.hwUser))
        .map(m => ({ platform_member_id: m.key, sub_master_id: m.isSub ? `mm-${m.holderKey || 'gone'}` : null }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('SELECT DISTINCT hardware_group_id FROM plan_mappings')) {
      return { rows: [{ hardware_group_id: GROUP_ID }], rowCount: 1 };
    }
    // Pass 2 A11 source check — every in-universe assignment is one we manage
    if (s.includes('SELECT mas.id, mas.status')) return { rows: [{ id: 'mas-managed', status: 'active' }], rowCount: 1 };
    // Pass 3 active access rows
    if (s.includes('ma.kisi_user_disappeared_observed_at')) {
      const rows = members.map(m => ({
        access_id: m.accessId, hardware_user_id: m.hwUser,
        kisi_user_disappeared_observed_at: m.disappearedObservedAt,
        platform_member_id: m.key,
        sub_master_id: m.isSub ? `mm-${m.holderKey || 'gone'}` : null,
        holder_platform_member_id: m.isSub ? (m.holderKey || null) : null,
      }));
      return { rows, rowCount: rows.length };
    }
    // Pass 3 (a) — distinct active source plans for one access row
    if (s.includes('SELECT DISTINCT source_plan_id')) {
      const m = byAccess.get(params[0]);
      const rows = m ? m.plans.map(p => ({ source_plan_id: p })) : [];
      return { rows, rowCount: rows.length };
    }
    // Pass 3 (b) — active source rows with their hardware group
    if (s.includes('SELECT id, source_plan_id, hardware_group_id::text')) {
      const m = byAccess.get(params[0]);
      const rows = m ? m.plans.map(p => ({ id: `mas-${m.key}-${p}`, source_plan_id: p, hardware_group_id: GROUP_ID })) : [];
      return { rows, rowCount: rows.length };
    }
    if (s.includes("SET status = 'active'")) {                                  // Pass 1 promotion
      const seat = `${params[1]}|${params[2]}`;
      if (state.seats.get(seat) !== 'cancelled') return empty;
      state.seats.set(seat, 'active');                                           // cancelled → active
      return { rows: [{ id: `mas-${seat}`, access_id: 'ma-promoted' }], rowCount: 1 };
    }
    if (s.includes('COALESCE(pmg.hardware_group_id')) {                         // Pass 1 targets
      return { rows: [{ mapping_id: 'map-1', hardware_group_id: GROUP_ID }], rowCount: 1 };
    }
    if (s.includes('SELECT mb.holder_seated')) {                                // DR-051 flag
      if (world.holderSeatedThrows) throw new Error('member_billing read failed');
      return (world.holderSeatedFalseFor || []).includes(params[1])
        ? { rows: [{ holder_seated: false }], rowCount: 1 }
        : empty;
    }
    if (s.includes("SET status = 'cancelled'")) {                               // DR-051 self-heal
      const seat = `${params[1]}|${params[2]}`;
      if (state.seats.get(seat) === 'active') state.seats.set(seat, 'cancelled');
      return { rows: [{ id: 'mas-healed' }], rowCount: 1 };
    }
    if (s.includes('INSERT INTO member_access_sources')) return empty;        // Pass 1 insert (row exists)
    if (s.includes('SET role_assignment_id')) return empty;                    // Pass 2 backfill
    // Pass 1.5 — one row per (active sub-member, active source plan)
    if (s.includes('FROM member_access sub')) {
      const rows = [];
      for (const m of members.filter(x => x.isSub)) {
        for (const p of m.plans) {
          rows.push({ sub_access_id: m.accessId, platform_member_id: m.key, holder_platform_member_id: m.holderKey || null, source_plan_id: p });
        }
      }
      return { rows, rowCount: rows.length };
    }
    // Active-source census
    if (s.includes('ORDER BY mm.platform_member_id, mas.source_plan_id')) {
      if (world.censusThrows) throw new Error('census read failed');
      const rows = [];
      for (const m of members) {
        for (const p of m.plans) {
          rows.push({
            access_id: m.accessId, platform_member_id: m.key,
            sub_master_id: m.isSub ? `mm-${m.holderKey || 'gone'}` : null,
            source_type: m.sourceType, source_plan_id: p,
          });
        }
      }
      return { rows, rowCount: rows.length };
    }
    // Strike clocks
    if (s.includes('MIN(not_paying_since)')) {
      if (world.strikeColumnsMissing) {
        throw Object.assign(new Error('column "not_paying_since" does not exist'), { code: '42703' });
      }
      if (world.strikeReadThrows) {                  // any failure other than 42703 (fix round 3, R3-4)
        throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      }
      // world.strikes may be a getter (clockStore) — read at query time, i.e.
      // the clocks as the DB holds them when this sweep reads them.
      const rows = (world.strikes || []).map(c => ({
        access_id: c.accessId, source_plan_id: c.planId,
        not_paying_since: c.since, not_paying_observations: c.observations,
      }));
      return { rows, rowCount: rows.length };
    }
    if (s.includes('INSERT INTO config_alert_log')) {
      const literal = s.match(/VALUES \(\$1, '([a-z_]+)'/);
      const type = literal ? literal[1] : params[1];
      const ref  = literal ? params[1] : params[2];
      const dedupe = s.includes('WHERE NOT EXISTS');
      const key = `${type}|${ref}`;
      const inserted = !(dedupe && unresolved.has(key));
      if (inserted) unresolved.add(key);
      state.alerts.push({ type, ref, dedupe, inserted, sql: s, params });
      return { rows: [], rowCount: inserted ? 1 : 0 };
    }
    if (s.includes('INSERT INTO reconciliation_proposal')) {
      if (world.proposalTableMissing) {
        throw Object.assign(new Error('relation "reconciliation_proposal" does not exist'), { code: '42P01' });
      }
      return { rows: [], rowCount: params.length / 12 };
    }
    if (s.includes('UPDATE clients SET last_active_member_count')) return { rows: [], rowCount: 1 };
    if (s.includes('UPDATE reconciliation_run')) return { rows: [], rowCount: 1 };

    // ── runNightlySweep-only queries ──
    if (s.includes('SELECT last_sync_at')) return { rows: [{ last_sync_at: null, interval: 'daily' }], rowCount: 1 };
    if (s.includes('FROM clients c') && s.includes('JOIN connector_subscriptions')) {
      return { rows: [clientRow()], rowCount: 1 };
    }
    if (s.includes('FROM locations l')) return empty;
    if (s.includes("ma.status IN ('recovery_pending', 'pending_identity')")) {
      return { rows: world.actionable || [], rowCount: (world.actionable || []).length };
    }
    if (s.includes('FROM error_queue') && s.includes('WHERE member_id = $1')) {
      const row = (world.errorRows || {})[params[0]];
      if (row instanceof Error) throw row;
      return row ? { rows: [row], rowCount: 1 } : empty;
    }
    if (s.includes('FROM config_alert_log cal')) return empty;                 // digest
    if (s.includes('FROM error_queue eq')) return empty;                       // digest
    if (s.includes('UPDATE clients SET last_sync_at')) return { rows: [], rowCount: 1 };
    return empty;
  });
}

function clientRow() {
  return {
    id: CLIENT_ID, source_site_id: 'wix-site-gate', source_api_key: 'enc-wix',
    hardware_api_key: 'enc-hw', hardware_platform: 'kisi',
    last_active_member_count: 3,
  };
}

function runSync(opts = {}) {
  return reconciliation._syncClient(clientRow(), {
    triggeredBy: 'cron', triggeredByActor: { type: 'system', id: 'reconciliation-test' }, ...opts,
  });
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

const revokeCalls  = () => eventQueue.add.mock.calls.filter(c => c[0] === 'revoke');
const grantCalls   = () => eventQueue.add.mock.calls.filter(c => c[0] === 'grant');
const grantedPairs = () => grantCalls().map(c => `${c[1].standardEvent.platformMemberId}:${c[1].standardEvent.planId}`).sort();
const warnCall     = (name) => log.warn.mock.calls.find(c => c[0] === name);
const warnCalls    = (name) => log.warn.mock.calls.filter(c => c[0] === name);
const sqlCalls     = (fragment) => db.query.mock.calls.filter(c => String(c[0]).includes(fragment));
const alertsOf     = (type) => state.alerts.filter(a => a.type === type);

function lastPolicyArgs() {
  const calls = revokePolicy.evaluateRemovals.mock.calls;
  return calls.length ? calls[calls.length - 1][0] : null;
}

// `${accessId}:${planId}` for each call to an L3 strike primitive, sorted.
const strikeCallPairs = (fn) => fn.mock.calls.map(c => `${c[0]}:${c[1]}`).sort();

/**
 * A stateful not-paying clock store, for scenarios that span several sweeps.
 * It stands in for member_access_sources' strike columns: the two L3 mocks
 * write it with the same semantics as the real SQL (record: COALESCE the start,
 * +1 observation; clear: only a row that carries a clock is written), and a
 * world reads it through `get strikes() { return clocks.rows(); }` — at query
 * time, so each sweep sees the clocks as the previous sweeps left them.
 */
function clockStore(initial = {}) {
  const map = new Map(Object.entries(initial)); // `${accessId}|${planId}` → { since, observations }
  const key = (accessId, planId) => `${accessId}|${planId}`;
  standardAdapter.recordNotPayingObservation.mockImplementation(async (accessId, planId) => {
    const prev = map.get(key(accessId, planId));
    map.set(key(accessId, planId), {
      since:        prev ? prev.since : new Date().toISOString(),   // COALESCE(not_paying_since, NOW())
      observations: (prev ? prev.observations : 0) + 1,
    });
    return { recorded: true, rowCount: 1 };
  });
  standardAdapter.clearNotPayingObservation.mockImplementation(async (accessId, planId) => {
    const had = map.delete(key(accessId, planId));
    return { cleared: true, rowCount: had ? 1 : 0 };
  });
  return {
    get:  (accessId, planId) => map.get(key(accessId, planId)),
    has:  (accessId, planId) => map.has(key(accessId, planId)),
    rows: () => [...map].map(([k, c]) => {
      const [accessId, planId] = k.split('|');
      return { accessId, planId, since: c.since, observations: c.observations };
    }),
  };
}

function runClose() {
  const call = db.query.mock.calls.find(c => String(c[0]).includes('UPDATE reconciliation_run') && (c[1] || []).length === 10);
  if (!call) return null;
  // [status, wix_active_count, kisi_managed_count, grants_queued, revokes_queued,
  //  grants_skipped_optin, sanity_gate_triggered, sanity_gate_resolved, abort_reason, runId]
  const p = call[1];
  return {
    status: p[0], grantsQueued: p[3], revokesQueued: p[4],
    sanityGateTriggered: p[6], sanityGateResolved: p[7], abortReason: p[8], runId: p[9],
  };
}

const PROPOSAL_COLS = [
  'run_id', 'client_id', 'platform_member_id', 'source_plan_id', 'hardware_group_id',
  'kind', 'source', 'data_source', 'classification', 'decision', 'hold_reason', 'evidence',
];
function proposalRows() {
  return sqlCalls('INSERT INTO reconciliation_proposal').flatMap(c => {
    const p = c[1];
    const rows = [];
    for (let i = 0; i < p.length; i += 12) {
      const r = {};
      PROPOSAL_COLS.forEach((k, j) => { r[k] = p[i + j]; });
      r.evidence = r.evidence ? JSON.parse(r.evidence) : null;
      rows.push(r);
    }
    return rows;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.getClient.mockReset();
  eventQueue.add.mockReset();
  eventQueue.add.mockResolvedValue({});
  standardAdapter.recordNotPayingObservation.mockReset();
  standardAdapter.recordNotPayingObservation.mockResolvedValue({ recorded: true, rowCount: 1 });
  standardAdapter.clearNotPayingObservation.mockReset();
  standardAdapter.clearNotPayingObservation.mockResolvedValue({ cleared: true, rowCount: 1 });
  lockTable.holder = null;
  conns.length = 0;
  db.getClient.mockImplementation(async () => { const c = makeConn(); conns.push(c); return c; });
  reconciliation._sweepTraceId = SWEEP_ID;
  reconciliation._doubleReadDelayMs = 0;
  reconciliation._proposalLogMissingWarned = false;
  reconciliation._strikeColumnsMissingWarned = false;
});

// THE PHASE 1 TRIPWIRE — no test in this file may let a revoke reach the queue.
afterEach(() => {
  expect(revokeCalls()).toEqual([]);
});

// ════════════════════════════════════════════════════════════════════════════
// The Phase 1 invariant
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — the sweep never enqueues a revoke', () => {

  test('one genuine cancellation among 3 members → 0 revokes; a held 3B proposal WITH its plan, strike clock advanced after the decision, operator alerted once', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c')],
      read1:   reads([...paying(['a', 'b']), order('c', PLAN_ID, 'ENDED')]),
    });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(result.revoked).toBe(0);
    expect(result.observationOnly).toBe(true);
    expect(result.heldRevokes).toBe(1);
    expect(result.holdReason).toBe('observation_only');
    expect(result.proposalsRecorded).toBe(1);

    // 3B now carries the plan (the old plan-less revoke was a no-op in processRevoke),
    // its classification (P-2) and its unit (P-1)
    const [proposal] = lastPolicyArgs().proposals;
    expect(proposal).toEqual(expect.objectContaining({
      source: 'wix_absence', dataSource: 'wix_orders', memberKey: 'c', unitKey: 'c', planId: PLAN_ID, accessId: 'ma-c',
      classification: 'ENDED',
    }));
    expect(proposal.syntheticEvent).toEqual(expect.objectContaining({ eventType: 'plan.cancelled', planId: PLAN_ID }));

    expect(standardAdapter.recordNotPayingObservation).toHaveBeenCalledTimes(1);
    expect(standardAdapter.recordNotPayingObservation).toHaveBeenCalledWith('ma-c', PLAN_ID);

    const rows = proposalRows();
    expect(rows).toEqual([expect.objectContaining({
      run_id: RUN_ID, client_id: CLIENT_ID, platform_member_id: 'c', source_plan_id: PLAN_ID,
      kind: 'removal_pending', source: 'wix_absence', data_source: 'wix_orders',
      classification: 'ENDED', decision: 'held', hold_reason: 'observation_only',
    })]);
    // Fix round F5: the strike the policy judged is the clock as the DB had it
    // BEFORE this sweep — none had started for c — and this sweep then recorded
    // c's first observation (the sweep was not anomaly-held).
    expect(rows[0].evidence.strike).toBeNull();
    expect(rows[0].evidence.strikeAdvanced).toBe(true);
    expect(rows[0].evidence.unitKey).toBe('c');
    expect(rows[0].evidence.observationOnly).toBe(true);

    expect(alertsOf('sweep_removal_pending')).toEqual([expect.objectContaining({ ref: 'member:c', dedupe: true, inserted: true })]);

    const close = runClose();
    expect(close).toEqual(expect.objectContaining({
      status: 'success', revokesQueued: 0, abortReason: 'observation_only',
      sanityGateTriggered: false, sanityGateResolved: null, runId: RUN_ID,
    }));
    expect(lastPolicyArgs().observationOnly).toBe(true);
    expect(warnCall('reconciliation.revokes_held')[1]).toEqual(expect.objectContaining({
      clientId: CLIENT_ID, reason: 'observation_only', heldCount: 1, bySource: { wix_absence: 1 },
      byDataSource: { wix_orders: 1 }, observationOnly: true, mode: 'dry_run',
    }));
  });

  test("auto_revoke_mode 'on' arms nothing in Phase 1 — still held, still 0 revokes", async () => {
    installWorld({
      mode:    'on',
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b'])),
    });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(result.revoked).toBe(0);
    expect(result.holdReason).toBe('observation_only');
    expect(lastPolicyArgs().mode).toBe('on');
    expect(lastPolicyArgs().observationOnly).toBe(true);
  });

  test("every removal path at once (3B, Kisi user gone, role drift, holder lapse) under mode 'on' → 0 revokes, all recorded and held", async () => {
    const members = [
      ...'abcdef'.split('').map(k => member(k)),
      member('x'),                                                          // 3B only
      member('y', { inKisiUsers: false, hasRole: false, disappearedObservedAt: '2026-09-09T06:00:00Z' }), // user gone
      member('z', { hasRole: false }),                                      // role drift
      member('s', { isSub: true, holderKey: 'a', plans: [PLAN_B] }),        // holder a does not pay PLAN_B
    ];
    installWorld({ mode: 'on', members, read1: reads(paying('abcdef'.split(''))) });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(result.revoked).toBe(0);
    expect(result.holdReason).toBe('observation_only');
    expect(warnCall('reconciliation.revokes_held')[1].bySource).toEqual({
      kisi_user_vanished: 1, role_drift: 1, holder_lapse: 1, wix_absence: 3,
    });
    expect(result.heldRevokes).toBe(6);
    expect(result.proposalsRecorded).toBe(6);
    expect(sqlCalls('INSERT INTO reconciliation_proposal')).toHaveLength(1); // one batched INSERT
    expect(runClose().revokesQueued).toBe(0);
    // the per-source "revoke queued" events only fire on a real enqueue
    expect(warnCall('reconciliation.kisi_user_disappeared_confirmed')).toBeUndefined();
    expect(warnCall('reconciliation.role_assignment_drifted')).toBeUndefined();
    expect(log.info).not.toHaveBeenCalledWith('reconciliation.revoke_queued', expect.anything());
  });

  test('_enqueueApprovedRevoke (kept for Phase 3b) refuses while observation-only', async () => {
    const ok = await reconciliation._enqueueApprovedRevoke(CLIENT_ID, {
      source: 'wix_absence', memberKey: 'c', planId: PLAN_ID,
      syntheticEvent: { eventType: 'plan.cancelled', platformMemberId: 'c', planId: PLAN_ID },
      jobId: 'revoke-test-1',
    });

    expect(ok).toBe(false);
    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.revoke_enqueue_refused_observation_only')[1]).toEqual(expect.objectContaining({
      clientId: CLIENT_ID, source: 'wix_absence', platformMemberId: 'c', sourcePlanId: PLAN_ID,
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Grants — PAYING plans only, union of the two reads
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — grants flow, but only for PAYING plans', () => {

  test('a new PAYING buyer is granted; ACTIVE+UNPAID (PENDING), DECLINED, ENDED and UNKNOWN orders are not', async () => {
    installWorld({
      members: [member('a'), member('b')],
      read1:   reads([
        ...paying(['a', 'b', 'n-pay']),
        order('n-pend', PLAN_ID, 'PENDING'),
        order('n-decl', PLAN_ID, 'DECLINED'),
        order('n-end',  PLAN_ID, 'ENDED'),
        order('n-unk',  PLAN_ID, 'UNKNOWN'),
      ]),
    });

    const result = await runSync();

    expect(grantedPairs()).toEqual([`n-pay:${PLAN_ID}`]);
    expect(result.granted).toBe(1);
    expect(grantCalls()[0][1]).toEqual({
      tenantId: CLIENT_ID,
      standardEvent: expect.objectContaining({
        eventType: 'plan.purchased', platformMemberId: 'n-pay', planId: PLAN_ID, synthetic: true,
        syntheticSource: 'reconciliation.true_source_sync', traceId: SWEEP_ID,
      }),
    });
    // Pass 1 never promotes/inserts a non-paying plan
    const promotedMembers = sqlCalls("SET status = 'active'").map(c => c[1][1]).sort();
    expect(promotedMembers).toEqual(['a', 'b', 'n-pay']);
    expect(runClose().grantsQueued).toBe(1);
  });

  test('PAYING in only ONE of the two reads is still granted (union); the disagreement is reported', async () => {
    installWorld({
      members: [member('a')],
      read1:   reads(paying(['a'])),
      read2:   reads(paying(['a', 'n'])),          // n's payment landed between the reads
    });

    await runSync();

    expect(grantedPairs()).toEqual([`n:${PLAN_ID}`]);
    expect(warnCall('reconciliation.wix_reads_disagreed')[1]).toEqual(expect.objectContaining({
      clientId: CLIENT_ID, readDisagreement: { wix_orders: 1, wix_bookings: 0 },
    }));
    expect(wixPlansApi.listOrdersClassified).toHaveBeenCalledTimes(2);
    expect(wixPlansApi.listConfirmedBookings).toHaveBeenCalledTimes(2);
  });

  test('a member with a PAYING plan and a PENDING plan is granted and promoted for the PAYING plan only', async () => {
    installWorld({
      members: [member('a')],
      read1:   reads([...paying(['a']), order('m', PLAN_ID, 'PAYING'), order('m', PLAN_B, 'PENDING')]),
    });

    await runSync();

    expect(grantedPairs()).toEqual([`m:${PLAN_ID}`]);
    const plansPromotedForM = sqlCalls("SET status = 'active'").filter(c => c[1][1] === 'm').map(c => c[1][2]);
    expect(plansPromotedForM).toEqual([PLAN_ID]);
  });

  test('a CONFIRMED booking counts as paying: its service is granted with the booking contact details', async () => {
    installWorld({
      members: [member('a')],
      read1:   reads(paying(['a']), [{ memberId: 'bk', planId: 'svc-1', email: 'bk@example.test', name: 'B K' }]),
    });

    await runSync();

    expect(grantedPairs()).toEqual(['bk:svc-1']);
    expect(grantCalls()[0][1].standardEvent).toEqual(expect.objectContaining({ email: 'bk@example.test', name: 'B K' }));
  });

  test('the two reads are _doubleReadDelayMs apart (default 15s)', async () => {
    const fresh = new reconciliation.constructor();
    expect(fresh._doubleReadDelayMs).toBe(15000);

    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });
    reconciliation._doubleReadDelayMs = 1234;
    const sleep = jest.spyOn(reconciliation, '_sleep').mockResolvedValue();
    try {
      await runSync();
      expect(sleep).toHaveBeenCalledWith(1234);
      // the sleep sits between read 1 and read 2
      const sleepOrder = sleep.mock.invocationCallOrder[0];
      const [read1Order, read2Order] = wixPlansApi.listOrdersClassified.mock.invocationCallOrder;
      expect(read1Order).toBeLessThan(sleepOrder);
      expect(sleepOrder).toBeLessThan(read2Order);
    } finally {
      sleep.mockRestore();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fail-closed vendor reads
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — a failed vendor read aborts the client, fail-closed', () => {

  test('Kisi role assignments throw while Kisi users succeed → run aborted, kisi_api_unavailable alert, 0 grants, 0 revokes', async () => {
    installWorld({
      kisiAssignmentsThrow: true,
      members: [member('a'), member('b')],
      read1:   reads(paying(['a', 'b', 'new-buyer'])),
    });

    const result = await runSync();

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      aborted: true, reason: 'hardware_api_unavailable', granted: 0, revoked: 0, runId: RUN_ID,
      observationOnly: true, proposalsRecorded: 0,
    }));
    expect(alertsOf('kisi_api_unavailable')).toEqual([expect.objectContaining({ ref: 'status=unknown code=KISI_PAGE_INTEGRITY' })]);
    const abort = sqlCalls("SET status = 'aborted', abort_reason = 'hardware_api_unavailable'");
    expect(abort).toHaveLength(1);
    expect(abort[0][1]).toEqual([RUN_ID]);
    expect(hardwareAdapter.listAllUsers).not.toHaveBeenCalled();   // no Pass 3 on a partial Kisi view
    expect(revokePolicy.evaluateRemovals).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.kisi_fetch_failed')).toBeDefined();
  });

  test('the SECOND Wix read throws (e.g. a malformed {} page) → abort: no grants even for members paying in read 1', async () => {
    installWorld({
      members:     [member('a')],
      read1:       reads(paying(['a', 'new-buyer'])),
      read2Throws: Object.assign(new Error('Wix page integrity: orders page has no orders array'), { code: 'WIX_PAGE_INTEGRITY' }),
    });
    const payingByClient = new Map();

    const result = await runSync({ payingCollector: payingByClient });

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ aborted: true, reason: 'wix_api_unavailable', granted: 0, revoked: 0 }));
    expect(alertsOf('wix_api_unavailable')).toEqual([expect.objectContaining({ ref: 'status=unknown code=WIX_PAGE_INTEGRITY' })]);
    expect(sqlCalls("abort_reason = 'wix_api_unavailable'")).toHaveLength(1);
    expect(log.error).toHaveBeenCalledWith('reconciliation.wix_fetch_failed',
      expect.objectContaining({ clientId: CLIENT_ID, wixCode: 'WIX_PAGE_INTEGRITY', wixRead: 2 }), expect.any(Error));
    expect(payingByClient.has(CLIENT_ID)).toBe(false);            // R6 replay will skip this client
    expect(hardwareAdapter.getManagedRoleAssignments).not.toHaveBeenCalled();
  });

  test('the FIRST Wix read throws → the second is never attempted; abort', async () => {
    installWorld({
      members:     [member('a')],
      read1Throws: Object.assign(new Error('Wix API 503'), { statusCode: 503, code: 'WIX_API_ERROR' }),
    });

    const result = await runSync();

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.reason).toBe('wix_api_unavailable');
    expect(wixPlansApi.listOrdersClassified).toHaveBeenCalledTimes(1);
    expect(alertsOf('wix_api_unavailable')[0].ref).toBe('status=503 code=WIX_API_ERROR');
  });

  test('the Kisi USER list throws → only Pass 3 short-circuits: grants still flow, no Kisi-sourced proposals', async () => {
    installWorld({
      listUsersThrows: true,
      members: [member('a'), member('z', { hasRole: false })],
      read1:   reads(paying(['a', 'z', 'new-buyer'])),
    });

    const result = await runSync();

    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`, `z:${PLAN_ID}`]);
    expect(result.aborted).toBeUndefined();
    expect(warnCall('reconciliation.pass_3_aborted_kisi_unavailable')).toBeDefined();
    expect(lastPolicyArgs().proposals.filter(p => p.dataSource === 'kisi')).toEqual([]);
    expect(lastPolicyArgs().populationByDataSource.kisi).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Pass 3 — paying members are repairs, never removals
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — Pass 3 findings', () => {

  test("a PAYING member's vanished Kisi user (second sighting) → sweep_repair_pending alert + repair_pending record, NOT a removal; 3A still queues the grant", async () => {
    const members = [
      member('a'), member('b'), member('c'),
      member('x', { inKisiUsers: false, hasRole: false, disappearedObservedAt: '2026-09-09T06:00:00Z' }),
    ];
    installWorld({ members, read1: reads(paying(['a', 'b', 'c', 'x'])) });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(result.heldRevokes).toBe(0);
    expect(result.holdReason).toBeNull();
    expect(alertsOf('sweep_repair_pending')).toEqual([expect.objectContaining({ ref: 'member:x', dedupe: true, inserted: true })]);
    expect(proposalRows()).toEqual([expect.objectContaining({
      platform_member_id: 'x', source_plan_id: PLAN_ID, kind: 'repair_pending', source: 'kisi_user_vanished',
      data_source: 'kisi', classification: 'PAYING', decision: 'held', hold_reason: 'observation_only',
    })]);
    expect(grantedPairs()).toEqual([`x:${PLAN_ID}`]);          // paying + no Kisi access → grant (unchanged)
    expect(warnCall('reconciliation.repairs_pending')[1]).toEqual(expect.objectContaining({ repairCount: 1, repairMembers: 1 }));
    expect(log.info).toHaveBeenCalledWith('reconciliation.pass_3_complete',
      expect.objectContaining({ disappearedConfirmed: 1, repairPending: 1 }));
    expect(alertsOf('sweep_removal_pending')).toEqual([]);
  });

  test('a PAYING member with a drifted role → repair_pending + alert, no removal proposal', async () => {
    const members = ['a', 'b', 'c', 'd'].map(k => member(k, { hasRole: k !== 'd' }));
    installWorld({ members, read1: reads(paying(['a', 'b', 'c', 'd'])) });

    const result = await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(result.heldRevokes).toBe(0);
    expect(alertsOf('sweep_repair_pending').map(a => a.ref)).toEqual(['member:d']);
    expect(proposalRows()).toEqual([expect.objectContaining({
      platform_member_id: 'd', kind: 'repair_pending', source: 'role_drift', hardware_group_id: GROUP_ID,
    })]);
  });

  test('a NON-paying member whose Kisi user vanished → held removal proposals (Kisi finding + Wix absence), no repair alert', async () => {
    const members = [
      member('a'), member('b'), member('c'), member('d'),
      member('y', { inKisiUsers: false, hasRole: false, disappearedObservedAt: '2026-09-09T06:00:00Z' }),
    ];
    installWorld({ members, read1: reads(paying(['a', 'b', 'c', 'd'])) });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    const sources = lastPolicyArgs().proposals.map(p => `${p.source}/${p.dataSource}/${p.memberKey}`).sort();
    expect(sources).toEqual(['kisi_user_vanished/kisi/y', 'wix_absence/wix_orders/y']);
    expect(result.holdReason).toBe('observation_only');
    expect(alertsOf('sweep_repair_pending')).toEqual([]);
    expect(alertsOf('sweep_removal_pending').map(a => a.ref)).toEqual(['member:y']);   // one per member
  });

  test('the FIRST sighting only stamps the two-strike marker through L3 — no finding', async () => {
    const members = [member('a'), member('b'), member('x', { inKisiUsers: false, hasRole: false })];
    installWorld({ members, read1: reads(paying(['a', 'b', 'x'])) });

    await runSync();

    expect(standardAdapter.markKisiUserObservation).toHaveBeenCalledWith('ma-x', true);
    expect(alertsOf('sweep_repair_pending')).toEqual([]);
    expect(lastPolicyArgs().proposals).toEqual([]);
  });

  test('repair alerts are de-duplicated: an unresolved one for the member already exists → nothing new is inserted', async () => {
    const members = ['a', 'b', 'c', 'd'].map(k => member(k, { hasRole: k !== 'd' }));
    installWorld({
      members, read1: reads(paying(['a', 'b', 'c', 'd'])),
      existingAlerts: ['sweep_repair_pending|member:d'],
    });

    await runSync();

    const [attempt] = alertsOf('sweep_repair_pending');
    expect(attempt).toEqual(expect.objectContaining({ ref: 'member:d', dedupe: true, inserted: false }));
    expect(attempt.sql).toMatch(/WHERE NOT EXISTS/);
    expect(attempt.sql).toMatch(/resolved_at IS NULL/);
    expect(attempt.params.slice(0, 3)).toEqual([CLIENT_ID, 'sweep_repair_pending', 'member:d']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Pass 1.5 — the holder predicate is Wix PAYING, not DB status
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — Pass 1.5 holder lapse', () => {

  test('a holder who left their OWN seat while still paying → 0 sub proposals (DR-051)', async () => {
    const members = [
      member('a'), member('b'),
      member('h'),                                                    // holder, still paying
      member('s', { isSub: true, holderKey: 'h' }),
    ];
    installWorld({ members, read1: reads(paying(['a', 'b', 'h'])), holderSeatedFalseFor: ['h'] });

    const result = await runSync();

    expect(lastPolicyArgs().proposals.filter(p => p.source === 'holder_lapse')).toEqual([]);
    expect(alertsOf('revoke_holder_lapse_pending')).toEqual([]);
    expect(result.heldRevokes).toBe(0);
    expect(log.info).toHaveBeenCalledWith('reconciliation.pass_1_5_complete',
      expect.objectContaining({ subsExamined: 1, lapsedSubsFound: 0, subMemberRevokesQueued: 0 }));
  });

  test("the holder no longer pays for the sub's plan → HOLDER_LAPSE proposal held + revoke_holder_lapse_pending alert", async () => {
    const members = [
      member('a'), member('b'), member('c'),
      member('h'),                                                    // holder — plan ENDED
      member('s', { isSub: true, holderKey: 'h' }),
    ];
    installWorld({ members, read1: reads([...paying(['a', 'b', 'c']), order('h', PLAN_ID, 'ENDED')]) });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    const lapse = lastPolicyArgs().proposals.filter(p => p.source === 'holder_lapse');
    expect(lapse).toEqual([expect.objectContaining({
      dataSource: 'wix_orders', memberKey: 's', planId: PLAN_ID, accessId: 'ma-s', holderKey: 'h', classification: 'ENDED',
    })]);
    expect(result.holdReason).toBe('observation_only');
    expect(alertsOf('revoke_holder_lapse_pending').map(a => a.ref)).toEqual(['member:s']);
    expect(alertsOf('sweep_removal_pending').map(a => a.ref)).toEqual(['member:h']);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalledWith('ma-s', expect.anything()); // subs carry no clock
  });

  test("a holder paying for a DIFFERENT plan than the sub's → the sub lapses", async () => {
    const members = [
      member('a'), member('b'), member('c'),
      member('h', { plans: [PLAN_B] }),
      member('s', { isSub: true, holderKey: 'h', plans: [PLAN_ID] }),
    ];
    installWorld({ members, read1: reads([...paying(['a', 'b', 'c']), ...paying(['h'], PLAN_B)]) });

    await runSync();

    const lapse = lastPolicyArgs().proposals.filter(p => p.source === 'holder_lapse');
    expect(lapse.map(p => `${p.memberKey}:${p.planId}`)).toEqual([`s:${PLAN_ID}`]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Strike clocks (L3 primitives, migration M3)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — not-paying strike clocks', () => {

  // Fix round F5: proposals carry the clock AS THE DB HAD IT (the policy judges
  // that), and the observation is recorded only after the decision. This used to
  // assert the post-observation clock ({observations: 3}, and a fresh
  // {observations: 1} for PLAN_B).
  test('the clock advances per (member, active source plan) AFTER the decision; each proposal carries the clock as the DB had it before this sweep', async () => {
    const members = [member('a'), member('b'), member('d'), member('c', { plans: [PLAN_ID, PLAN_B] })];
    installWorld({
      members, read1: reads(paying(['a', 'b', 'd'])),
      strikes: [{ accessId: 'ma-c', planId: PLAN_ID, since: new Date('2026-09-08T00:00:00Z'), observations: 2 }],
    });

    await runSync();

    expect(standardAdapter.recordNotPayingObservation.mock.calls).toEqual([['ma-c', PLAN_ID], ['ma-c', PLAN_B]]);
    const byPlan = Object.fromEntries(lastPolicyArgs().proposals.map(p => [p.planId, p.strike]));
    expect(byPlan[PLAN_ID]).toEqual({ since: '2026-09-08T00:00:00.000Z', observations: 2 }); // the DB's clock
    expect(byPlan[PLAN_B]).toBeNull();                                                       // no clock yet
    expect(lastPolicyArgs().strikePolicy).toEqual({ minAgeMs: 48 * 60 * 60 * 1000, minObservations: 3 });
    // the decision comes first; the clock moves after it
    const decidedAt  = revokePolicy.evaluateRemovals.mock.invocationCallOrder[0];
    const recordedAt = standardAdapter.recordNotPayingObservation.mock.invocationCallOrder[0];
    expect(decidedAt).toBeLessThan(recordedAt);
    // the log says which clocks this sweep advanced
    expect(proposalRows().map(r => [r.source_plan_id, r.evidence.strikeAdvanced])).toEqual([[PLAN_ID, true], [PLAN_B, true]]);
  });

  test('a PAYING member who carries a clock has it cleared; members without a clock are not written', async () => {
    installWorld({
      members: [member('a'), member('b')],
      read1:   reads(paying(['a', 'b'])),
      strikes: [{ accessId: 'ma-a', planId: PLAN_ID, since: '2026-09-09T00:00:00Z', observations: 1 }],
    });

    await runSync();

    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-a', PLAN_ID]]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
  });

  test('before the strike migration (42703): no clock is read, started or cleared; proposals carry strike null; warned once per process', async () => {
    const world = {
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b'])),
      strikeColumnsMissing: true,
    };
    installWorld(world);
    await runSync();
    installWorld(world);
    await runSync();

    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(standardAdapter.clearNotPayingObservation).not.toHaveBeenCalled();
    expect(lastPolicyArgs().proposals.map(p => p.strike)).toEqual([null]);
    expect(warnCalls('reconciliation.strike_clock_unavailable')).toHaveLength(1);
    expect(runClose()).not.toBeNull();                              // the sweep still completed
  });

  test('the L3 primitive reports columns_missing → strike null, and no further calls this sweep', async () => {
    standardAdapter.recordNotPayingObservation.mockResolvedValue({ recorded: false, reason: 'columns_missing' });
    installWorld({
      members: ['a', 'b', 'c', 'd', 'e'].map(k => member(k)),
      read1:   reads(paying(['a', 'b', 'c'])),                    // d, e not paying
    });

    await runSync();

    expect(standardAdapter.recordNotPayingObservation).toHaveBeenCalledTimes(1);
    expect(lastPolicyArgs().proposals.map(p => p.strike)).toEqual([null, null]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Anomalies — reported even though everything is held
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — anomalies', () => {

  // Fix round F9: a MASS_REVOKE hold is about volume, so the per-member alerts are
  // KEPT (this used to assert they were suppressed). F5 / fix round 3: an
  // anomaly-held sweep never ADVANCES a strike clock. (Clears still run — R3-3 —
  // but nobody here is paying or held for their payment, so there is none.)
  test('3 managed members + an empty Wix snapshot in BOTH reads → mass_revoke: one anomaly alert, per-member alerts kept, no clock advanced, run aborted', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c')], read1: reads([]),
      strikes: [{ accessId: 'ma-a', planId: PLAN_ID, since: '2026-09-09T00:00:00Z', observations: 1 }],
    });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(result.revoked).toBe(0);
    expect(result.holdReason).toBe('mass_revoke');
    expect(result.sanityGateTriggered).toBe(true);
    expect(result.sanityGateResolved).toBe(false);
    expect(alertsOf('revoke_batch_mass_revoke')).toEqual([expect.objectContaining({ ref: 'mass_revoke:aggregate', dedupe: true })]);
    expect(alertsOf('sweep_removal_pending').map(a => a.ref).sort()).toEqual(['member:a', 'member:b', 'member:c']);
    expect(alertsOf('sweep_removal_pending').every(a => a.dedupe)).toBe(true);
    expect(proposalRows().map(r => r.hold_reason)).toEqual(['mass_revoke', 'mass_revoke', 'mass_revoke']);
    expect(proposalRows().map(r => r.evidence.strikeAdvanced)).toEqual([false, false, false]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(standardAdapter.clearNotPayingObservation).not.toHaveBeenCalled();
    expect(lastPolicyArgs().proposals.find(p => p.memberKey === 'a').strike)
      .toEqual({ since: '2026-09-09T00:00:00Z', observations: 1 });            // judged as the DB had it
    expect(warnCall('reconciliation.revokes_held')[1]).toEqual(expect.objectContaining({
      strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'anomaly_hold',
    }));
    expect(runClose()).toEqual(expect.objectContaining({
      status: 'aborted', abortReason: 'mass_revoke', sanityGateTriggered: true, sanityGateResolved: false, revokesQueued: 0,
    }));
  });

  test('the two Wix reads disagree beyond the threshold → snapshot_unstable hold + wix_snapshot_anomaly alert; per-member alerts suppressed, no clock advanced, a paying member still cleared', async () => {
    const members = 'abcdefgh'.split('').map(k => member(k));
    installWorld({
      members,
      read1: reads(paying(['a', 'b', 'c', 'd', 'e', 'f'])),
      read2: reads(paying(['a', 'b', 'c', 'd'])),             // e, f flipped between reads; g, h in neither
      strikes: [{ accessId: 'ma-a', planId: PLAN_ID, since: '2026-09-09T00:00:00Z', observations: 2 }], // a pays again
    });

    const result = await runSync();

    expect(revokeCalls()).toHaveLength(0);
    expect(lastPolicyArgs().readDisagreement).toEqual({ wix_orders: 2, wix_bookings: 0 });
    expect(result.holdReason).toBe('snapshot_unstable');
    expect(alertsOf('wix_snapshot_anomaly')).toEqual([
      expect.objectContaining({ ref: 'snapshot_unstable:wix_orders:read_disagreement' }),
    ]);
    expect(alertsOf('sweep_removal_pending')).toEqual([]);          // F9: untrustworthy evidence → suppressed
    // The untrusted reads advance no clock (g, h) — but a's reset still runs:
    // clearing only ever delays a removal (fix round 3, R3-3). This used to assert
    // that a's clock was NOT cleared either.
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-a', PLAN_ID]]);
    expect(runClose().status).toBe('aborted');
  });

  test('the anomaly alert is de-duplicated on a stable key (not on counts)', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c')], read1: reads([]),
      existingAlerts: ['revoke_batch_mass_revoke|mass_revoke:aggregate'],
    });

    await runSync();

    expect(alertsOf('revoke_batch_mass_revoke')).toEqual([expect.objectContaining({ inserted: false })]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Proposal log (reconciliation_proposal, migration M2)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — proposal log', () => {

  test('reconciliation_proposal table missing (42P01) → warned once per process; the sweep completes and grants still flow', async () => {
    const world = {
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'new-buyer'])),        // c not paying → a proposal to record
      proposalTableMissing: true,
    };
    installWorld(world);
    const first = await runSync();
    installWorld(world);
    const second = await runSync();

    expect(first.proposalsRecorded).toBe(0);
    expect(second.proposalsRecorded).toBe(0);
    expect(warnCalls('reconciliation.proposal_log_unavailable')).toHaveLength(1);
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`, `new-buyer:${PLAN_ID}`]);
    expect(runClose()).not.toBeNull();
  });

  test('no proposals → no proposal INSERT at all', async () => {
    installWorld({ members: [member('a'), member('b')], read1: reads(paying(['a', 'b'])) });

    const result = await runSync();

    expect(sqlCalls('INSERT INTO reconciliation_proposal')).toHaveLength(0);
    expect(result.proposalsRecorded).toBe(0);
    expect(result.holdReason).toBeNull();
    expect(runClose().abortReason).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Populations — what the policy judges volume against (I-10 item 7)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — populations handed to the removal policy', () => {

  // Fix round F6/F8: populations and proposals are counted in UNITS (P-1). Sub s
  // belongs to holder a's family, so it is unit 'a' everywhere. This used to count
  // members: { wix_orders: 10, wix_bookings: 1, kisi: 11 }, currentManaged 11.
  test("every proposal's unitKey is inside its own data source's unit population, and inside currentManaged", async () => {
    const members = [
      ...'abcdef'.split('').map(k => member(k)),
      member('x'),
      member('y', { inKisiUsers: false, hasRole: false, disappearedObservedAt: '2026-09-09T06:00:00Z' }),
      member('z', { hasRole: false }),
      member('s', { isSub: true, holderKey: 'a', plans: [PLAN_B] }),
      member('bk', { sourceType: 'booking', plans: ['svc-1'] }),
    ];
    installWorld({ members, read1: reads(paying('abcdef'.split(''))) });

    await runSync();

    const args = lastPolicyArgs();
    // wix_orders: 9 primaries with a plan source; sub s adds its holder a (already
    // counted). wix_bookings: bk. kisi: Pass 3's 11 rows collapse to 10 units (s → a).
    expect(args.populationByDataSource).toEqual({ wix_orders: 9, wix_bookings: 1, kisi: 10 });
    expect(args.currentManaged).toBe(10);
    const expected = {
      wix_orders:   new Set('abcdefxyz'.split('')),
      wix_bookings: new Set(['bk']),
      kisi:         new Set([...'abcdefxyz'.split(''), 'bk']),
    };
    const union = new Set([...expected.wix_orders, ...expected.wix_bookings, ...expected.kisi]);
    expect(union.size).toBe(args.currentManaged);
    expect(args.proposals.length).toBeGreaterThan(0);
    for (const p of args.proposals) {
      expect(typeof p.unitKey).toBe('string');                      // every proposal names its unit
      expect(expected[p.dataSource].has(p.unitKey)).toBe(true);
      expect(union.has(p.unitKey)).toBe(true);
    }
    expect(args.proposals.find(p => p.memberKey === 's')).toEqual(expect.objectContaining({
      source: 'holder_lapse', unitKey: 'a', holderKey: 'a',
    }));
    expect(args.proposals.find(p => p.memberKey === 'bk').dataSource).toBe('wix_bookings');
    expect(warnCall('reconciliation.proposal_population_mismatch')).toBeUndefined();
    expect(revokePolicy.evaluateRemovals.mock.results[0].value.reason).toBe('observation_only'); // never invalid_proposal
  });

  test('a source whose type is neither plan nor booking is never a removal candidate', async () => {
    installWorld({
      members: [member('a'), member('b'), member('m', { sourceType: 'manual' })],
      read1:   reads(paying(['a', 'b'])),
    });

    await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete',
      expect.objectContaining({ sourcesSkippedNonWix: 1 }));
  });

  test('census read fails → 3B is skipped (no observation, no proposal) but grants still flow', async () => {
    installWorld({
      members: [member('a'), member('c')],
      read1:   reads(paying(['a', 'new-buyer'])),
      censusThrows: true,
    });

    const result = await runSync();

    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(warnCall('reconciliation.active_source_census_failed')).toBeDefined();
    expect(result.aborted).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// clients.auto_revoke_mode
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — clients.auto_revoke_mode', () => {
  const seatHealCalls  = () => sqlCalls("SET status = 'cancelled'");
  const seatInsertsFor = (key) => sqlCalls('INSERT INTO member_access_sources').filter(c => c[1][5] === key);

  test('auto_revoke_mode is read immediately after the reconciliation_run row is opened', async () => {
    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });
    await runSync();
    const sqls = db.query.mock.calls.map(c => String(c[0]));
    const runIdx  = sqls.findIndex(s => s.includes('INSERT INTO reconciliation_run'));
    const modeIdx = sqls.findIndex(s => s.includes('SELECT auto_revoke_mode FROM clients'));
    expect(runIdx).toBeGreaterThan(-1);
    expect(modeIdx).toBe(runIdx + 1);
    expect(db.query.mock.calls[modeIdx][1]).toEqual([CLIENT_ID]);
  });

  test("the mode read throws (column not migrated) → 'off': logged, grants flow, the run is opened and closed", async () => {
    installWorld({
      modeThrows: true,
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'new-buyer'])),
    });

    const result = await runSync();

    expect(log.error).toHaveBeenCalledWith('reconciliation.kill_switch_read_failed',
      expect.objectContaining({ clientId: CLIENT_ID }), expect.any(Error));
    expect(lastPolicyArgs().mode).toBe('off');
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);
    expect(result.granted).toBe(1);
    expect(runClose()).toEqual(expect.objectContaining({ runId: RUN_ID, status: 'success', grantsQueued: 1 }));
  });

  test("DR-051 self-heal: 'dry_run' → the cancel UPDATE is NOT issued, revoke_held (dry_run); the released seat is still not re-added", async () => {
    installWorld({
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      holderSeatedFalseFor: ['a'],
    });

    await runSync();

    expect(seatHealCalls()).toHaveLength(0);
    expect(seatInsertsFor('a')).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith('reconciliation.revoke_held', expect.objectContaining({
      path: 'holder_seat_release', reason: 'dry_run', clientId: CLIENT_ID, platformMemberId: 'a', sourcePlanId: PLAN_ID,
    }));
  });

  test("DR-051 self-heal: 'off' → held with reason auto_revoke_off", async () => {
    installWorld({
      mode: 'off',
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      holderSeatedFalseFor: ['a'],
    });

    await runSync();

    expect(seatHealCalls()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith('reconciliation.revoke_held', expect.objectContaining({
      path: 'holder_seat_release', reason: 'auto_revoke_off',
    }));
  });

  test("DR-051 self-heal: 'on' → the DB-only cancel UPDATE is issued (still no revoke job)", async () => {
    installWorld({
      mode: 'on',
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      holderSeatedFalseFor: ['a'],
    });

    await runSync();

    expect(seatHealCalls()).toHaveLength(1);
    expect(seatHealCalls()[0][1]).toEqual([CLIENT_ID, 'a', PLAN_ID]);
    expect(seatInsertsFor('a')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Per-client advisory lock (I-10 item 2)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — per-client advisory lock', () => {

  test('two concurrent _syncClient runs for the same client → the second is skipped (locked) and touches nothing', async () => {
    installWorld({ members: [member('a')], read1: reads(paying(['a', 'new-buyer'])) });

    const results = await Promise.all([runSync(), runSync()]);

    const skipped = results.filter(r => r.skipped === 'locked');
    const ran     = results.filter(r => r.skipped !== 'locked');
    expect(skipped).toHaveLength(1);
    expect(ran).toHaveLength(1);
    expect(skipped[0]).toEqual(expect.objectContaining({
      skipped: 'locked', aborted: true, reason: 'locked', runId: null, granted: 0, revoked: 0,
      skippedHolderOptin: 0, heldRevokes: 0, holdReason: null, observationOnly: true, proposalsRecorded: 0,
    }));
    expect(sqlCalls('INSERT INTO reconciliation_run')).toHaveLength(1);   // the skipped run opened no row
    expect(wixPlansApi.listOrdersClassified).toHaveBeenCalledTimes(2);     // one double read
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);             // granted once, not twice
    expect(warnCall('reconciliation.client_sync_skipped_locked')[1]).toEqual(expect.objectContaining({ clientId: CLIENT_ID }));
    expect(lockTable.holder).toBeNull();                                  // released afterwards

    // ...and the next sweep takes the lock again.
    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });
    const later = await runSync();
    expect(later.skipped).toBeUndefined();
  });

  test('lock and unlock run on the SAME dedicated connection, which is then returned to the pool', async () => {
    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });

    await runSync();

    expect(conns).toHaveLength(1);
    const [conn] = conns;
    const sqls = conn.query.mock.calls.map(c => String(c[0]));
    expect(sqls[0]).toMatch(/SELECT pg_try_advisory_lock\(hashtext\('reconcile:' \|\| \$1::text\)\)/);
    expect(sqls[1]).toMatch(/SELECT pg_advisory_unlock\(hashtext\('reconcile:' \|\| \$1::text\)\)/);
    expect(conn.query.mock.calls[0][1]).toEqual([CLIENT_ID]);
    expect(conn.query.mock.calls[1][1]).toEqual([CLIENT_ID]);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.release.mock.calls[0]).toEqual([]);                      // pooled, not destroyed
    // the lock is never taken through the pooled db.query
    expect(sqlCalls('advisory')).toHaveLength(0);
  });

  test('db.getClient throws → client_lock_unavailable; the sync PROCEEDS without the lock (grants flow)', async () => {
    db.getClient.mockReset();
    db.getClient.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    installWorld({ members: [member('a')], read1: reads(paying(['a', 'new-buyer'])) });

    const result = await runSync();

    expect(warnCall('reconciliation.client_lock_unavailable')).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);
  });

  test('the lock query itself throws → the connection is destroyed (release(true)) and the sync proceeds', async () => {
    db.getClient.mockReset();
    db.getClient.mockImplementation(async () => { const c = makeConn({ lockThrows: true }); conns.push(c); return c; });
    installWorld({ members: [member('a')], read1: reads(paying(['a', 'new-buyer'])) });

    const result = await runSync();

    expect(conns[0].release).toHaveBeenCalledWith(true);
    expect(warnCall('reconciliation.client_lock_unavailable')).toBeDefined();
    expect(result.skipped).toBeUndefined();
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);
  });

  test('the unlock fails → the connection is destroyed, and the sync result still returns', async () => {
    db.getClient.mockReset();
    db.getClient.mockImplementation(async () => { const c = makeConn({ unlockThrows: true }); conns.push(c); return c; });
    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });

    const result = await runSync();

    expect(result.runId).toBe(RUN_ID);
    expect(conns[0].release).toHaveBeenCalledWith(true);
    expect(warnCall('reconciliation.client_lock_release_failed')[1]).toEqual(expect.objectContaining({ reason: 'unlock_threw' }));
  });

  test('the sync throws after the lock is taken → the lock is still released (finally), the error propagates', async () => {
    installWorld({ members: [member('a')], read1: reads(paying(['a'])) });
    cryptoUtils.decryptApiKey.mockImplementationOnce(() => { throw new Error('[CryptoUtils] Invalid encrypted key format'); });

    await expect(runSync()).rejects.toThrow('Invalid encrypted key format');

    expect(lockTable.holder).toBeNull();
    expect(conns[0].release).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// R6 — error_queue replay: grant-only, PAYING-only (I-10 item 8)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — error_queue replay (_processRecordTargeted)', () => {
  const RECORD = { member_id: 'ma-r6', client_id: CLIENT_ID, platform_member_id: 'wix-r6' };
  const payingSnapshot = (plansByMember) =>
    new Map([[CLIENT_ID, new Map(Object.entries(plansByMember).map(([k, v]) => [k, new Set(v)]))]]);

  function installErrorRow(eventType, payloadOverride) {
    db.query.mockImplementation(async (sql) => {
      const s = String(sql);
      if (s.includes('FROM error_queue')) {
        const payload = payloadOverride !== undefined
          ? payloadOverride
          : { eventType, sourcePlatform: 'wix', platformMemberId: 'wix-r6', planId: PLAN_ID, traceId: 'trace-orig' };
        return { rows: [{ id: 'eq-0001', event_type: eventType, payload }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  }

  test('plan.started for a member PAYING in this sweep → replayed as a GRANT with a sweep-scoped jobId', async () => {
    installErrorRow('plan.started');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }));

    expect(eventQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = eventQueue.add.mock.calls[0];
    expect(jobName).toBe('grant');
    expect(payload).toEqual({ tenantId: CLIENT_ID, standardEvent: expect.objectContaining({ eventType: 'plan.started', traceId: 'trace-orig' }) });
    expect(opts).toEqual({ jobId: `requeue-eq-0001-${SWEEP_ID}` });
    expect(db.query.mock.calls.some(c => String(c[0]).includes('auto_revoke_mode'))).toBe(false);
  });

  test('a member NOT paying in this sweep → skipped (member_not_paying), nothing queued', async () => {
    installErrorRow('plan.purchased');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'someone-else': [PLAN_ID] }));

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.requeue_skipped_not_paying')[1]).toEqual(expect.objectContaining({
      memberId: 'ma-r6', platformMemberId: 'wix-r6', clientId: CLIENT_ID, reason: 'member_not_paying',
    }));
  });

  test("the event's plan is not paying (the member pays a different plan) → skipped (plan_not_paying)", async () => {
    installErrorRow('plan.purchased');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_B] }));

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.requeue_skipped_not_paying')[1].reason).toBe('plan_not_paying');
  });

  test('plan.cancelled is never replayed — skipped as a revoke; the mode is not even read', async () => {
    installErrorRow('plan.cancelled');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }));

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.requeue_skipped_revoke')[1]).toEqual(expect.objectContaining({
      memberId: 'ma-r6', platformMemberId: 'wix-r6', eventType: 'plan.cancelled',
    }));
    expect(db.query.mock.calls.some(c => String(c[0]).includes('auto_revoke_mode'))).toBe(false);
  });

  test('a grant-labelled row whose payload is a revoke event → skipped, never replayed as either', async () => {
    installErrorRow('plan.purchased', { eventType: 'plan.cancelled', platformMemberId: 'wix-r6', planId: PLAN_ID });

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }));

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.requeue_skipped_revoke')[1]).toEqual(expect.objectContaining({
      eventType: 'plan.purchased', payloadEventType: 'plan.cancelled',
    }));
  });

  test('unknown event type → nothing queued, requeue_skipped_unroutable (never defaulted to a revoke)', async () => {
    installErrorRow('plan.paused');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }));

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('reconciliation.requeue_skipped_unroutable', expect.objectContaining({
      memberId: 'ma-r6', platformMemberId: 'wix-r6', eventType: 'plan.paused',
    }));
  });

  test('no paying snapshot for the client (its sync aborted, or none passed) → skipped (no_wix_read), fail-closed', async () => {
    installErrorRow('plan.purchased');

    await reconciliation._processRecordTargeted(RECORD);                              // none passed
    await reconciliation._processRecordTargeted(RECORD, new Map());                   // client absent

    expect(eventQueue.add).not.toHaveBeenCalled();
    const reasons = warnCalls('reconciliation.requeue_skipped_not_paying').map(c => c[1].reason);
    expect(reasons).toEqual(['no_wix_read', 'no_wix_read']);
  });

  test('a JSON null payload is skipped, not thrown', async () => {
    installErrorRow('plan.purchased', 'null');

    await expect(reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }))).resolves.toBeUndefined();

    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(warnCall('reconciliation.requeue_skipped_unreadable_payload')).toBeDefined();
  });

  test('jobId falls back to "nosweep" when no sweep trace is set', async () => {
    reconciliation._sweepTraceId = null;
    installErrorRow('plan.purchased');

    await reconciliation._processRecordTargeted(RECORD, payingSnapshot({ 'wix-r6': [PLAN_ID] }));

    expect(eventQueue.add.mock.calls[0][2]).toEqual({ jobId: 'requeue-eq-0001-nosweep' });
  });

  test('end to end: the sweep hands its own Wix read to the replay, and one failing record does not stop the rest', async () => {
    installWorld({
      members: [member('p')],
      read1:   reads(paying(['p'])),
      actionable: [
        { id: 'ma-bad', member_id: 'ma-bad', client_id: CLIENT_ID, platform_member_id: 'bad' },
        { id: 'ma-p',   member_id: 'ma-p',   client_id: CLIENT_ID, platform_member_id: 'p' },
      ],
      errorRows: {
        'ma-bad': new Error('error_queue read failed'),
        'ma-p': {
          id: 'eq-p', event_type: 'plan.started',
          payload: { eventType: 'plan.started', sourcePlatform: 'wix', platformMemberId: 'p', planId: PLAN_ID, traceId: 'trace-p' },
        },
      },
    });
    const sleep = jest.spyOn(reconciliation, '_sleep').mockResolvedValue();
    try {
      await reconciliation.runNightlySweep({ triggerSource: 'inprocess' });
    } finally {
      sleep.mockRestore();
    }

    const replays = grantCalls().filter(c => String(c[2].jobId).startsWith('requeue-'));
    expect(replays).toHaveLength(1);
    expect(replays[0][1].standardEvent).toEqual(expect.objectContaining({ eventType: 'plan.started', platformMemberId: 'p' }));
    expect(warnCall('reconciliation.requeue_record_failed')[1]).toEqual(expect.objectContaining({ memberId: 'ma-bad' }));
    expect(sqlCalls('FROM config_alert_log cal')).toHaveLength(1);        // the digest still ran
    expect(sqlCalls('UPDATE clients SET last_sync_at')).toHaveLength(1); // and last_sync_at was stamped
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Return shape & alert plumbing
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Phase 1 — return shape and alert plumbing', () => {

  test('every existing return key is kept; observationOnly, proposalsRecorded and holdReason are added; revoked is 0', async () => {
    installWorld({ members: [member('a'), member('b'), member('c')], read1: reads(paying(['a', 'b'])) });

    const result = await runSync();

    for (const key of ['granted', 'revoked', 'skippedHolderOptin', 'runId', 'sanityGateTriggered',
      'sanityGateResolved', 'heldRevokes', 'holdReason', 'observationOnly', 'proposalsRecorded']) {
      expect(result).toHaveProperty(key);
    }
    expect(result.revoked).toBe(0);
    expect(result.skippedHolderOptin).toBe(0);
    expect(result.observationOnly).toBe(true);
  });

  test('hardware_ref is capped at 255 characters and alert_type is never null', async () => {
    const longKey = `m${'x'.repeat(300)}`;
    installWorld({ members: [member('a'), member('b'), member('c'), member(longKey)], read1: reads(paying(['a', 'b', 'c'])) });

    await runSync();

    const [alert] = alertsOf('sweep_removal_pending');
    expect(alert.ref).toHaveLength(255);
    expect(alert.ref.startsWith('member:m')).toBe(true);

    await reconciliation._insertAlertOnce(CLIENT_ID, null, 'ref');
    expect(state.alerts[state.alerts.length - 1].type).toBe('revoke_unknown');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix round F2 — a declined, pending or unrecognised payment is never a removal
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F2 — declined / pending / unrecognised payments are held, never proposed', () => {

  test.each(['DECLINED', 'PENDING', 'UNKNOWN'])(
    '3B: a %s member → held_payment_state record (no strike), clock cleared, one revoke_held_payment_state alert — no proposal, no removal alert',
    async (classification) => {
      installWorld({
        members: [member('a'), member('b'), member('d')],
        read1:   reads([...paying(['a', 'b']), order('d', PLAN_ID, classification)]),
      });

      const result = await runSync();

      expect(lastPolicyArgs().proposals).toEqual([]);                              // never proposed
      expect(result.heldRevokes).toBe(0);
      expect(result.holdReason).toBeNull();
      expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();    // no clock is started…
      expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-d', PLAN_ID]]); // …and a running one stops
      expect(proposalRows()).toEqual([expect.objectContaining({
        platform_member_id: 'd', source_plan_id: PLAN_ID, kind: 'held_payment_state',
        source: 'wix_absence', data_source: 'wix_orders', classification,
        decision: 'held', hold_reason: 'payment_state_not_removable',
      })]);
      expect(proposalRows()[0].evidence).toEqual(expect.objectContaining({
        strike: null, strikeAdvanced: false, unitKey: 'd', policyDetail: null,
      }));
      expect(result.proposalsRecorded).toBe(1);
      expect(alertsOf('sweep_removal_pending')).toEqual([]);
      expect(alertsOf('revoke_held_payment_state')).toEqual([
        expect.objectContaining({ ref: 'member:d', dedupe: true, inserted: true }),
      ]);
      expect(warnCall('reconciliation.payment_state_held')[1]).toEqual(expect.objectContaining({
        clientId: CLIENT_ID, heldCount: 1, heldUnits: 1, bySource: { wix_absence: 1 },
        byClassification: { [classification]: 1 }, strikeAdvanceFrozen: false,
      }));
      // not at risk → not in the Wix population; still provisioned in Kisi
      expect(lastPolicyArgs().populationByDataSource).toEqual({ wix_orders: 2, wix_bookings: 0, kisi: 3 });
      expect(lastPolicyArgs().currentManaged).toBe(3);
    }
  );

  test('best classification across both reads: DECLINED in one read, ENDED in the other → DECLINED (the more alive state) → held, not proposed', async () => {
    installWorld({
      members: [member('a'), member('b'), member('d')],
      read1:   reads([...paying(['a', 'b']), order('d', PLAN_ID, 'DECLINED')]),
      read2:   reads([...paying(['a', 'b']), order('d', PLAN_ID, 'ENDED')]),
    });

    await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(proposalRows()).toEqual([expect.objectContaining({ kind: 'held_payment_state', classification: 'DECLINED' })]);
  });

  test('held members never pad a Wix population: 2 ENDED of 3 at-risk units is a mass revoke even with 3 unpaid members around', async () => {
    installWorld({
      members: ['a', 'd1', 'd2', 'd3', 'e1', 'e2'].map(k => member(k)),
      read1:   reads([
        ...paying(['a']),
        order('d1', PLAN_ID, 'DECLINED'), order('d2', PLAN_ID, 'PENDING'), order('d3', PLAN_ID, 'UNKNOWN'),
        order('e1', PLAN_ID, 'ENDED'),    order('e2', PLAN_ID, 'ENDED'),
      ]),
    });

    const result = await runSync();

    const args = lastPolicyArgs();
    expect(args.populationByDataSource).toEqual({ wix_orders: 3, wix_bookings: 0, kisi: 6 });   // d1–d3 left out of wix_orders
    expect(args.currentManaged).toBe(6);                                                         // …but still provisioned in Kisi
    expect(args.proposals.map(p => p.memberKey).sort()).toEqual(['e1', 'e2']);
    // Counted against a padded wix_orders population of 6, 2 removals would have
    // looked routine (threshold 4); against the 3 units actually at risk they are
    // more than half.
    expect(result.holdReason).toBe('mass_revoke');
    expect(revokePolicy.evaluateRemovals.mock.results[0].value).toEqual(expect.objectContaining({
      reason: 'mass_revoke', dataSource: 'wix_orders', detail: 'per_data_source',
    }));
    // F9: a volume hold keeps every per-member alert
    expect(alertsOf('sweep_removal_pending').map(a => a.ref).sort()).toEqual(['member:e1', 'member:e2']);
    expect(alertsOf('revoke_held_payment_state').map(a => a.ref).sort()).toEqual(['member:d1', 'member:d2', 'member:d3']);
    // An anomaly hold advances no clock, but the held members' clears still run
    // (fix round 3, R3-3 — this used to assert they were skipped too).
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation))
      .toEqual([`ma-d1:${PLAN_ID}`, `ma-d2:${PLAN_ID}`, `ma-d3:${PLAN_ID}`]);
  });

  test('mixed plans: the ENDED plan is proposed (clock advanced); the DECLINED plan of the same member is held (clock cleared); one unit', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c'), member('m', { plans: [PLAN_ID, PLAN_B] })],
      read1:   reads([...paying(['a', 'b', 'c']), order('m', PLAN_ID, 'ENDED'), order('m', PLAN_B, 'DECLINED')]),
    });

    await runSync();

    const args = lastPolicyArgs();
    expect(args.proposals.map(p => `${p.memberKey}:${p.planId}:${p.classification}`)).toEqual([`m:${PLAN_ID}:ENDED`]);
    expect(standardAdapter.recordNotPayingObservation.mock.calls).toEqual([['ma-m', PLAN_ID]]);
    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-m', PLAN_B]]);
    expect(args.populationByDataSource.wix_orders).toBe(4);                   // m counted once, via its ENDED plan
    expect(proposalRows().map(r => `${r.kind}:${r.source_plan_id}`).sort())
      .toEqual([`held_payment_state:${PLAN_B}`, `removal_pending:${PLAN_ID}`]);
    expect(alertsOf('sweep_removal_pending').map(a => a.ref)).toEqual(['member:m']);
    expect(alertsOf('revoke_held_payment_state').map(a => a.ref)).toEqual(['member:m']);
  });

  test("Pass 1.5: a DECLINED holder's subs are held_payment_state (the HOLDER's classification), never proposed; one alert for the whole family", async () => {
    const members = [
      member('a'), member('b'),
      member('h'),                                                   // holder — payment declined
      member('s1', { isSub: true, holderKey: 'h' }),
      member('s2', { isSub: true, holderKey: 'h' }),
    ];
    installWorld({ members, read1: reads([...paying(['a', 'b']), order('h', PLAN_ID, 'DECLINED')]) });

    const result = await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);                  // neither h (3B) nor its subs (Pass 1.5)
    expect(result.heldRevokes).toBe(0);
    const held = proposalRows().filter(r => r.kind === 'held_payment_state');
    expect(held.map(r => `${r.source}:${r.platform_member_id}:${r.classification}`).sort()).toEqual([
      'holder_lapse:s1:DECLINED', 'holder_lapse:s2:DECLINED', 'wix_absence:h:DECLINED',
    ]);
    expect(held.every(r => r.evidence.unitKey === 'h')).toBe(true);
    expect(alertsOf('revoke_holder_lapse_pending')).toEqual([]);
    expect(alertsOf('sweep_removal_pending')).toEqual([]);
    expect(alertsOf('revoke_held_payment_state').map(a => a.ref)).toEqual(['member:h']);       // one per family
    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-h', PLAN_ID]]); // subs carry no clock
    expect(lastPolicyArgs().populationByDataSource.wix_orders).toBe(2);                       // the held family is not at risk
    expect(log.info).toHaveBeenCalledWith('reconciliation.pass_1_5_complete', expect.objectContaining({
      subsExamined: 2, lapsedSubsFound: 0, subMemberRevokesQueued: 0, subsHeldPaymentState: 2,
    }));
  });

  test('Pass 1.5: a sub whose holder cannot be found is UNKNOWN — held, never proposed (it used to be proposed as ABSENT)', async () => {
    installWorld({
      members: [member('a'), member('b'), member('o', { isSub: true, holderKey: null })],
      read1:   reads(paying(['a', 'b'])),
    });

    await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);
    expect(proposalRows()).toEqual([expect.objectContaining({
      platform_member_id: 'o', kind: 'held_payment_state', source: 'holder_lapse', classification: 'UNKNOWN',
    })]);
    expect(proposalRows()[0].evidence).toEqual(expect.objectContaining({ holderKey: null, unitKey: 'o' }));
    expect(alertsOf('revoke_holder_lapse_pending')).toEqual([]);
    expect(alertsOf('revoke_held_payment_state').map(a => a.ref)).toEqual(['member:o']);
    expect(standardAdapter.clearNotPayingObservation).not.toHaveBeenCalled();  // subs carry no clock
  });

  test('the held-payment alert is de-duplicated: an unresolved one for the unit already exists → nothing new is inserted', async () => {
    installWorld({
      members: [member('a'), member('b'), member('d')],
      read1:   reads([...paying(['a', 'b']), order('d', PLAN_ID, 'DECLINED')]),
      existingAlerts: ['revoke_held_payment_state|member:d'],
    });

    await runSync();

    const [attempt] = alertsOf('revoke_held_payment_state');
    expect(attempt).toEqual(expect.objectContaining({ ref: 'member:d', dedupe: true, inserted: false }));
    expect(attempt.sql).toMatch(/WHERE NOT EXISTS/);
    expect(attempt.sql).toMatch(/resolved_at IS NULL/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix round F5 — strike clocks move only after the decision, never in an anomaly
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F5 — strike clocks ADVANCE only after a non-anomaly decision', () => {

  // Fix round 3 (R3-3) reverses half of F5: an anomaly-held sweep still advances
  // no clock, but it DOES clear — clearing only ever delays a removal. This test
  // used to assert the declined member's clear was skipped ("the clear waits for
  // a sweep that can be trusted"), which let a stale clock outlive the hold.
  test("an anomaly-held sweep advances no clock — but a declined member's clock is still cleared", async () => {
    installWorld({
      members: [member('e1'), member('e2'), member('e3'), member('d')],
      read1:   reads([
        order('e1', PLAN_ID, 'ENDED'), order('e2', PLAN_ID, 'ENDED'), order('e3', PLAN_ID, 'ENDED'),
        order('d', PLAN_ID, 'DECLINED'),
      ]),
      strikes: [{ accessId: 'ma-d', planId: PLAN_ID, since: '2026-09-01T00:00:00Z', observations: 5 }],
    });

    const result = await runSync();

    expect(result.holdReason).toBe('mass_revoke');
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-d', PLAN_ID]]);
    expect(warnCall('reconciliation.payment_state_held')[1]).toEqual(expect.objectContaining({
      strikeAdvanceFrozen: true, clocksCleared: 1,
    }));
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'anomaly_hold',
      notPayingObserved: 0, strikesCleared: 0, heldClocksCleared: 1,
    }));
  });

  test('the same kind of world without an anomaly: the observation is recorded and the declined clock cleared — both after the decision', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c'), member('e1'), member('d')],
      read1:   reads([...paying(['a', 'b', 'c']), order('e1', PLAN_ID, 'ENDED'), order('d', PLAN_ID, 'DECLINED')]),
      strikes: [{ accessId: 'ma-d', planId: PLAN_ID, since: '2026-09-01T00:00:00Z', observations: 5 }],
    });

    const result = await runSync();

    expect(result.holdReason).toBe('observation_only');
    expect(standardAdapter.recordNotPayingObservation.mock.calls).toEqual([['ma-e1', PLAN_ID]]);
    expect(standardAdapter.clearNotPayingObservation.mock.calls).toEqual([['ma-d', PLAN_ID]]);
    const decidedAt = revokePolicy.evaluateRemovals.mock.invocationCallOrder[0];
    expect(standardAdapter.recordNotPayingObservation.mock.invocationCallOrder[0]).toBeGreaterThan(decidedAt);
    expect(standardAdapter.clearNotPayingObservation.mock.invocationCallOrder[0]).toBeGreaterThan(decidedAt);
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      strikeAdvanceFrozen: false, strikeAdvanceFrozenReason: null,
      notPayingObserved: 1, heldClocksCleared: 1, heldPaymentState: 1,
    }));
  });

  test("P-3: a clock whose since is a V8-lenient string ('12') is not laundered by the sweep — invalid_proposal, per-member alerts suppressed, no clock moves", async () => {
    installWorld({
      members: [member('a'), member('b'), member('c'), member('x')],
      read1:   reads(paying(['a', 'b', 'c'])),
      strikes: [{ accessId: 'ma-x', planId: PLAN_ID, since: '12', observations: 9 }],
    });

    const result = await runSync();

    // Date.parse('12') is a date in 2001 — a strike "ripe" for decades. The sweep
    // hands the policy the raw value; the policy refuses it.
    expect(lastPolicyArgs().proposals[0].strike).toEqual({ since: '12', observations: 9 });
    expect(result.holdReason).toBe('invalid_proposal');
    expect(revokePolicy.evaluateRemovals.mock.results[0].value.detail).toBe('invalid_strike_since');
    expect(alertsOf('revoke_invalid_proposal')).toEqual([
      expect.objectContaining({ ref: 'invalid_proposal:invalid_strike_since', dedupe: true }),
    ]);
    expect(alertsOf('sweep_removal_pending')).toEqual([]);                              // F9: suppressed
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();          // F5: no clock advances
    expect(runClose()).toEqual(expect.objectContaining({ status: 'aborted', abortReason: 'invalid_proposal' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix round F6 / F8 — decisions in units (P-1)
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F6/F8 — decisions are made in units: a family is one', () => {

  test('two single members + one family of three: the family lapsing is 1 unit of 3 — held for observation, NOT a mass revoke', async () => {
    const members = [
      member('a'), member('b'),                                      // two single members, paying
      member('h'),                                                   // the holder — plan ENDED
      member('s1', { isSub: true, holderKey: 'h' }),
      member('s2', { isSub: true, holderKey: 'h' }),
    ];
    installWorld({ members, read1: reads([...paying(['a', 'b']), order('h', PLAN_ID, 'ENDED')]) });

    const result = await runSync();

    const args = lastPolicyArgs();
    expect(args.proposals.map(p => `${p.source}:${p.memberKey}:${p.unitKey}:${p.classification}`).sort()).toEqual([
      'holder_lapse:s1:h:ENDED', 'holder_lapse:s2:h:ENDED', 'wix_absence:h:h:ENDED',
    ]);
    expect(args.populationByDataSource).toEqual({ wix_orders: 3, wix_bookings: 0, kisi: 3 });
    expect(args.currentManaged).toBe(3);
    expect(revokePolicy.evaluateRemovals.mock.results[0].value.counts)
      .toEqual(expect.objectContaining({ proposedUnits: 1, proposedMembers: 3 }));
    expect(result.holdReason).toBe('observation_only');
    expect(alertsOf('revoke_batch_mass_revoke')).toEqual([]);

    // Control: the very same proposals counted in MEMBERS — every member its own
    // unit, as the pre-fix sweep counted them — against member-counted
    // populations are 3 of 5: a mass revoke. Fix round 3 (R3-1): a sub's own
    // unit is now spelled as a unit that is not its memberKey (as if each sub had
    // a different holder); merely stripping a HOLDER_LAPSE's unitKey — what this
    // control used to do — is now unit_structure_invalid, asserted below.
    const actualPolicy = jest.requireActual('../../core/revoke-policy');
    const memberCountedPopulations = { currentManaged: 5, populationByDataSource: { wix_orders: 5, wix_bookings: 0, kisi: 5 } };
    const memberCounted = actualPolicy.evaluateRemovals({
      ...args,
      ...memberCountedPopulations,
      proposals: args.proposals.map(({ unitKey: _unit, ...p }) =>
        (p.source === 'holder_lapse' ? { ...p, unitKey: `solo:${p.memberKey}` } : p)),
    });
    expect(memberCounted.reason).toBe('mass_revoke');
    expect(memberCounted.counts.proposedUnits).toBe(3);
    const stripped = actualPolicy.evaluateRemovals({
      ...args,
      ...memberCountedPopulations,
      proposals: args.proposals.map(({ unitKey: _unit, ...p }) => p),
    });
    expect(stripped).toEqual(expect.objectContaining({ reason: 'invalid_proposal', detail: 'unit_structure_invalid' }));
  });

  test("Kisi findings on a family's subs are counted in the family's unit", async () => {
    const members = [
      member('a'), member('b'), member('c'),
      member('h', { plans: [PLAN_B] }),                              // holder pays PLAN_B only
      member('s1', { isSub: true, holderKey: 'h', plans: [PLAN_ID], hasRole: false }),
      member('s2', { isSub: true, holderKey: 'h', plans: [PLAN_ID], hasRole: false }),
    ];
    installWorld({ members, read1: reads([...paying(['a', 'b', 'c']), ...paying(['h'], PLAN_B)]) });

    await runSync();

    const args = lastPolicyArgs();
    expect(args.proposals.filter(p => p.dataSource === 'kisi').map(p => `${p.source}:${p.memberKey}:${p.unitKey}`).sort())
      .toEqual(['role_drift:s1:h', 'role_drift:s2:h']);
    expect(args.populationByDataSource.kisi).toBe(4);                 // a, b, c and h's family
    expect(revokePolicy.evaluateRemovals.mock.results[0].value.counts.proposedUnits).toBe(1);
    expect(warnCall('reconciliation.proposal_population_mismatch')).toBeUndefined();
  });

  test('readDisagreement is in units: a family whose holder flips between the reads counts once', async () => {
    const members = [
      member('a'), member('b'), member('c'),
      member('h'),
      member('s1', { isSub: true, holderKey: 'h' }), member('s2', { isSub: true, holderKey: 'h' }),
    ];
    installWorld({
      members,
      read1: reads(paying(['a', 'b', 'c', 'h'])),
      read2: reads(paying(['a', 'b', 'c'])),                          // h's payment flickers between the reads
    });

    await runSync();

    expect(lastPolicyArgs().readDisagreement).toEqual({ wix_orders: 1, wix_bookings: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix round F12 — DR-051: a released holder seat is never promoted back
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F12 — a seat its holder released is never resurrected by Pass 1', () => {

  test.each(['dry_run', 'off'])("holder_seated=false + a 'cancelled' seat row in %s → the row stays cancelled: no promotion, no re-add, no heal", async (mode) => {
    installWorld({
      mode,
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      holderSeatedFalseFor: ['a'],
      cancelledSeats: [['a', PLAN_ID]],
    });

    await runSync();

    expect(state.seats.get(`a|${PLAN_ID}`)).toBe('cancelled');                                      // exactly as found
    expect(sqlCalls("SET status = 'active'").filter(c => c[1][1] === 'a')).toEqual([]);             // never promoted
    expect(sqlCalls('INSERT INTO member_access_sources').filter(c => c[1][5] === 'a')).toEqual([]); // never re-added
    expect(sqlCalls("SET status = 'cancelled'")).toEqual([]);                                       // the heal is held
    expect(warnCall('reconciliation.revoke_held')[1]).toEqual(expect.objectContaining({
      path: 'holder_seat_release', platformMemberId: 'a', sourcePlanId: PLAN_ID,
    }));
  });

  test('control: WITHOUT the released flag the same cancelled seat IS promoted — and the flag is read before the promotion', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      cancelledSeats: [['a', PLAN_ID]],
    });

    await runSync();

    expect(state.seats.get(`a|${PLAN_ID}`)).toBe('active');
    const calls    = db.query.mock.calls;
    const flagIdx  = calls.findIndex(c => String(c[0]).includes('SELECT mb.holder_seated') && c[1][1] === 'a');
    const promoIdx = calls.findIndex(c => String(c[0]).includes("SET status = 'active'") && c[1][1] === 'a');
    expect(flagIdx).toBeGreaterThan(-1);
    expect(flagIdx).toBeLessThan(promoIdx);
    // one flag read per (member, plan) — the DR-051 branch reuses it
    expect(sqlCalls('SELECT mb.holder_seated').filter(c => c[1][1] === 'a')).toHaveLength(1);
  });

  test("mode 'on': the released seat is not promoted either; only the DB-only self-heal runs (no revoke job)", async () => {
    installWorld({
      mode:    'on',
      members: [member('a'), member('b'), member('c')],
      read1:   reads(paying(['a', 'b', 'c'])),
      holderSeatedFalseFor: ['a'],
      cancelledSeats: [['a', PLAN_ID]],
    });

    await runSync();

    expect(sqlCalls("SET status = 'active'").filter(c => c[1][1] === 'a')).toEqual([]);
    expect(sqlCalls("SET status = 'cancelled'")).toHaveLength(1);
    expect(state.seats.get(`a|${PLAN_ID}`)).toBe('cancelled');
  });

  test('the holder_seated read fails → that plan is left exactly as found (no promotion, no seat INSERT); grants still flow', async () => {
    installWorld({
      members: [member('a')],
      read1:   reads(paying(['a', 'new-buyer'])),
      holderSeatedThrows: true,
      cancelledSeats: [['a', PLAN_ID]],
    });

    await runSync();

    expect(state.seats.get(`a|${PLAN_ID}`)).toBe('cancelled');
    expect(sqlCalls("SET status = 'active'")).toEqual([]);
    expect(sqlCalls('INSERT INTO member_access_sources')).toEqual([]);
    expect(warnCalls('reconciliation.holder_seated_read_failed').map(c => c[1].platformMemberId).sort())
      .toEqual(['a', 'new-buyer']);
    expect(grantedPairs()).toEqual([`new-buyer:${PLAN_ID}`]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix round 3 — the strike-clock rule Phase 3b depends on:
//   an anomaly-held sweep never ADVANCES a clock; clears always run, because
//   clearing only ever delays a removal.
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round 3 — clears always run; only advancing a clock is ever frozen', () => {

  test('R3-3: a MASS_REVOKE-held sweep clears the clock of a member PAYING again — and advances nobody', async () => {
    installWorld({
      members: [member('p'), member('e1'), member('e2'), member('e3')],
      read1:   reads([
        ...paying(['p']),
        order('e1', PLAN_ID, 'ENDED'), order('e2', PLAN_ID, 'ENDED'), order('e3', PLAN_ID, 'ENDED'),
      ]),
      strikes: [
        { accessId: 'ma-p',  planId: PLAN_ID, since: '2026-09-01T00:00:00Z', observations: 4 }, // p pays again
        { accessId: 'ma-e1', planId: PLAN_ID, since: '2026-09-08T00:00:00Z', observations: 1 }, // e1's clock is running
      ],
    });

    const result = await runSync();

    expect(result.holdReason).toBe('mass_revoke');                                    // 3 of 4 units at once
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();         // nobody advances…
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation)).toEqual([`ma-p:${PLAN_ID}`]); // …p resets
    // e1 is judged on its clock exactly as the DB had it — and the clock stays put
    expect(lastPolicyArgs().proposals.find(p => p.memberKey === 'e1').strike)
      .toEqual({ since: '2026-09-08T00:00:00Z', observations: 1 });
    expect(proposalRows().map(r => r.evidence.strikeAdvanced)).toEqual([false, false, false]);
    expect(warnCall('reconciliation.revokes_held')[1]).toEqual(expect.objectContaining({
      reason: 'mass_revoke', strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'anomaly_hold',
    }));
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'anomaly_hold', notPayingObserved: 0, strikesCleared: 1,
    }));
  });

  test("R3-3: the reviewer's stale-clock scenario — a lapsed member resumes paying during a MASS_REVOKE hold → the clock is cleared; when they lapse again the first proposals carry a FRESH clock, never the old ripe one", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const t0 = Date.now();
    // x lapsed a week ago and has been seen not paying on 5 sweeps: a ripe strike.
    const oldClock = { since: new Date(t0 - 7 * DAY).toISOString(), observations: 5 };
    expect(revokePolicy.strikeSatisfied(oldClock, t0, revokePolicy.DEFAULT_STRIKE_POLICY)).toBe(true);
    const clocks = clockStore({ [`ma-x|${PLAN_ID}`]: { ...oldClock } });

    // Sweep 1 — x pays again, in a sweep held for MASS_REVOKE (three others lapse at once).
    installWorld({
      members: [member('x'), member('e1'), member('e2'), member('e3')],
      read1:   reads([
        ...paying(['x']),
        order('e1', PLAN_ID, 'ENDED'), order('e2', PLAN_ID, 'ENDED'), order('e3', PLAN_ID, 'ENDED'),
      ]),
      get strikes() { return clocks.rows(); },
    });
    const held = await runSync();

    expect(held.holdReason).toBe('mass_revoke');
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation)).toEqual([`ma-x:${PLAN_ID}`]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();         // e1–e3 are not advanced
    expect(clocks.has('ma-x', PLAN_ID)).toBe(false);                                   // the old clock is gone
    expect(clocks.rows()).toEqual([]);

    // Sweep 2 — x lapses again (an ordinary, non-anomaly sweep).
    const policyCalls = revokePolicy.evaluateRemovals.mock.calls.length;
    const recordCalls = standardAdapter.recordNotPayingObservation.mock.calls.length;
    installWorld({
      members: [member('a'), member('b'), member('c'), member('x')],
      read1:   reads([...paying(['a', 'b', 'c']), order('x', PLAN_ID, 'ENDED')]),
      get strikes() { return clocks.rows(); },
    });
    const lapsed = await runSync();

    const second = revokePolicy.evaluateRemovals.mock.calls[policyCalls][0];
    const [proposal] = second.proposals;
    expect(proposal).toEqual(expect.objectContaining({ memberKey: 'x', planId: PLAN_ID, classification: 'ENDED' }));
    expect(proposal.strike).toBeNull();                                                // no clock before this sweep
    expect(revokePolicy.evaluateRemovals.mock.results[policyCalls].value.counts.strikeReady).toBe(0);
    expect(lapsed.holdReason).toBe('observation_only');
    expect(standardAdapter.recordNotPayingObservation.mock.calls.slice(recordCalls)).toEqual([['ma-x', PLAN_ID]]);
    const fresh = clocks.get('ma-x', PLAN_ID);
    expect(fresh.observations).toBe(1);                                                // a NEW clock, started now
    expect(Date.parse(fresh.since)).toBeGreaterThanOrEqual(t0);

    // Had the old clock survived sweep 1, this very proposal would have been
    // strike-ready — removable the moment Phase 3b arms removal.
    const actualPolicy = jest.requireActual('../../core/revoke-policy');
    expect(actualPolicy.evaluateRemovals({ ...second, proposals: [{ ...proposal, strike: oldClock }] }).counts.strikeReady)
      .toBe(1);

    // Sweep 3 — still lapsed: the proposal carries the fresh clock, which is not ripe.
    const thirdCall = revokePolicy.evaluateRemovals.mock.calls.length;
    installWorld({
      members: [member('a'), member('b'), member('c'), member('x')],
      read1:   reads([...paying(['a', 'b', 'c']), order('x', PLAN_ID, 'ENDED')]),
      get strikes() { return clocks.rows(); },
    });
    await runSync();

    const third = revokePolicy.evaluateRemovals.mock.calls[thirdCall][0].proposals[0];
    expect(third.strike).toEqual({ since: fresh.since, observations: 1 });
    expect(revokePolicy.strikeSatisfied(third.strike, Date.now(), revokePolicy.DEFAULT_STRIKE_POLICY)).toBe(false);
    expect(revokePolicy.evaluateRemovals.mock.results[thirdCall].value.counts.strikeReady).toBe(0);
    expect(clocks.get('ma-x', PLAN_ID)).toEqual({ since: fresh.since, observations: 2 });
  });

  test('R3-4: the strike-clock READ fails (not 42703) → proposals carry no strike, NO clock advances, and every PAYING (member, plan) plus every held-payment (member, plan) is cleared; one strike_read_failed warn', async () => {
    installWorld({
      members: [
        member('a'), member('b'),
        member('m', { plans: [PLAN_ID, PLAN_B] }),                       // pays PLAN_ID; PLAN_B ENDED
        member('e'),                                                     // ENDED → a removal proposal
        member('d'),                                                     // DECLINED → held_payment_state
        member('s', { isSub: true, holderKey: 'a' }),                    // a sub — never carries a clock
        member('bk', { sourceType: 'booking', plans: ['svc-1'] }),       // a paying booking
      ],
      read1: reads(
        [
          ...paying(['a', 'b', 'm']), order('m', PLAN_B, 'ENDED'),
          order('e', PLAN_ID, 'ENDED'), order('d', PLAN_ID, 'DECLINED'),
        ],
        [{ memberId: 'bk', planId: 'svc-1', email: null, name: null }],
      ),
      strikeReadThrows: true,
    });

    const result = await runSync();

    expect(result.holdReason).toBe('observation_only');                               // not an anomaly…
    expect(lastPolicyArgs().proposals.map(p => [p.memberKey, p.strike])).toEqual([['e', null]]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();         // …yet nothing advances
    // Clears: every PAYING primary (member, plan) in the census — without knowing
    // which carry a clock (the primitive only writes a row that has one) — and the
    // held-payment pair. Not m's ENDED PLAN_B, not e (proposed), not the sub.
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation)).toEqual([
      `ma-a:${PLAN_ID}`, `ma-b:${PLAN_ID}`, 'ma-bk:svc-1', `ma-d:${PLAN_ID}`, `ma-m:${PLAN_ID}`,
    ].sort());
    expect(warnCalls('reconciliation.strike_read_failed')).toHaveLength(1);
    expect(warnCall('reconciliation.strike_read_failed')[1]).toEqual(expect.objectContaining({ clientId: CLIENT_ID, errorCode: '57014' }));
    expect(warnCall('reconciliation.strike_clock_unavailable')).toBeUndefined();       // not the 42703 path
    expect(proposalRows().find(r => r.kind === 'removal_pending').evidence)
      .toEqual(expect.objectContaining({ strike: null, strikeAdvanced: false }));
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'strike_read_failed',
      notPayingObserved: 0, heldClocksCleared: 1,
    }));
  });

  test('R3-5: an EMPTY batch whose two reads disagree beyond the threshold is an anomaly like any other — one de-duplicated wix_snapshot_anomaly alert, run aborted, nothing advanced, clears still run, per-member alerts suppressed', async () => {
    const world = {
      members: [member('a'), member('b'), member('c'), member('d'), member('dd')],
      read1: reads([...paying(['a', 'b', 'c', 'd']), order('dd', PLAN_ID, 'DECLINED')]),
      read2: reads([...paying(['a', 'b']),           order('dd', PLAN_ID, 'DECLINED')]), // c, d flicker
      strikes: [{ accessId: 'ma-a', planId: PLAN_ID, since: '2026-09-09T00:00:00Z', observations: 2 }], // a pays again
    };
    installWorld(world);

    const result = await runSync();

    expect(lastPolicyArgs().proposals).toEqual([]);                                    // nothing to remove…
    expect(lastPolicyArgs().readDisagreement).toEqual({ wix_orders: 2, wix_bookings: 0 });
    expect(revokePolicy.evaluateRemovals.mock.results[0].value).toEqual(expect.objectContaining({
      action: 'hold', reason: 'snapshot_unstable', dataSource: 'wix_orders', detail: 'read_disagreement',
    }));
    expect(result).toEqual(expect.objectContaining({                                  // …but the reads are judged
      holdReason: 'snapshot_unstable', heldRevokes: 0, revoked: 0,
      sanityGateTriggered: true, sanityGateResolved: false,
    }));
    expect(alertsOf('wix_snapshot_anomaly')).toEqual([
      expect.objectContaining({ ref: 'snapshot_unstable:wix_orders:read_disagreement', dedupe: true, inserted: true }),
    ]);
    expect(standardAdapter.recordNotPayingObservation).not.toHaveBeenCalled();
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation)).toEqual([`ma-a:${PLAN_ID}`, `ma-dd:${PLAN_ID}`]);
    expect(alertsOf('revoke_held_payment_state')).toEqual([]);                        // F9: untrusted reads → suppressed
    expect(proposalRows()).toEqual([expect.objectContaining({ platform_member_id: 'dd', kind: 'held_payment_state' })]);
    expect(runClose()).toEqual(expect.objectContaining({
      status: 'aborted', abortReason: 'snapshot_unstable', sanityGateTriggered: true, sanityGateResolved: false, revokesQueued: 0,
    }));
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      holdReason: 'snapshot_unstable', strikeAdvanceFrozen: true, strikeAdvanceFrozenReason: 'anomaly_hold', strikesCleared: 1,
    }));

    // The same condition on the next sweep: the unresolved alert is not raised twice.
    installWorld({ ...world, existingAlerts: ['wix_snapshot_anomaly|snapshot_unstable:wix_orders:read_disagreement'] });
    await runSync();
    expect(alertsOf('wix_snapshot_anomaly')).toEqual([expect.objectContaining({ dedupe: true, inserted: false })]);
  });

  test('R3-5 control: an empty batch whose reads agree is not an anomaly — no alert, run succeeds, holdReason null', async () => {
    installWorld({
      members: [member('a'), member('b'), member('c'), member('d')],
      read1:   reads(paying(['a', 'b', 'c', 'd'])),
      strikes: [{ accessId: 'ma-a', planId: PLAN_ID, since: '2026-09-09T00:00:00Z', observations: 2 }],
    });

    const result = await runSync();

    expect(revokePolicy.evaluateRemovals.mock.results[0].value).toEqual(expect.objectContaining({ action: 'proceed', reason: null }));
    expect(result.holdReason).toBeNull();
    expect(result.sanityGateTriggered).toBe(false);
    expect(state.alerts.filter(a => a.type === 'wix_snapshot_anomaly' || a.type.startsWith('revoke_'))).toEqual([]);
    expect(runClose()).toEqual(expect.objectContaining({ status: 'success', abortReason: null }));
    expect(strikeCallPairs(standardAdapter.clearNotPayingObservation)).toEqual([`ma-a:${PLAN_ID}`]);
    expect(log.info).toHaveBeenCalledWith('reconciliation.client_sync_complete', expect.objectContaining({
      strikeAdvanceFrozen: false, strikeAdvanceFrozenReason: null,
    }));
  });

  test('R3-1: every proposal the sweep builds is one the policy accepts — filed under a data source its source may use, shaped as the unit the policy checks — across every removal path', async () => {
    const members = [
      ...'abcdefg'.split('').map(k => member(k)),
      member('x'),                                                             // 3B on wix_orders
      member('bk', { sourceType: 'booking', plans: ['svc-1'] }),               // 3B on wix_bookings
      member('y', { inKisiUsers: false, hasRole: false, disappearedObservedAt: '2026-09-09T06:00:00Z' }), // Kisi user gone
      member('z', { hasRole: false }),                                         // role drift
      member('hold'),                                                          // a family's holder — plan ENDED
      member('s1', { isSub: true, holderKey: 'hold' }),                        // holder lapse
      member('s2', { isSub: true, holderKey: 'hold', hasRole: false }),        // holder lapse + role drift on a sub
    ];
    installWorld({ members, read1: reads([...paying('abcdefg'.split('')), order('hold', PLAN_ID, 'ENDED')]) });

    await runSync();

    const args = lastPolicyArgs();
    expect(new Set(args.proposals.map(p => p.source)))
      .toEqual(new Set(['wix_absence', 'kisi_user_vanished', 'role_drift', 'holder_lapse']));
    for (const p of args.proposals) {
      expect(revokePolicy.DATA_SOURCES_BY_SOURCE[p.source]).toContain(p.dataSource);
      if (p.source === 'wix_absence') expect(p.unitKey).toBe(p.memberKey);
      if (p.source === 'holder_lapse') {
        expect(p.unitKey).toBe(p.holderKey);
        expect(p.unitKey).not.toBe(p.memberKey);
      }
    }
    expect(args.proposals.find(p => p.memberKey === 'bk').dataSource).toBe('wix_bookings');
    expect(args.proposals.filter(p => p.source === 'holder_lapse').map(p => p.dataSource)).toEqual(['wix_orders', 'wix_orders']);
    expect(revokePolicy.evaluateRemovals.mock.results[0].value.reason).toBe('observation_only'); // never invalid_proposal
  });

  test('R3-1: a sub-member whose holder resolves to ITSELF is never proposed as a HOLDER_LAPSE (unitKey would equal memberKey: unit_structure_invalid, holding the whole batch) — it is held as UNKNOWN', async () => {
    installWorld({
      members: [
        member('a'), member('b'), member('c'),
        member('e'),                                                      // an ordinary lapse
        member('s', { isSub: true, holderKey: 's' }),                     // corrupt: sub_master_id → its own row
      ],
      read1: reads([...paying(['a', 'b', 'c']), order('e', PLAN_ID, 'ENDED')]),
    });

    const result = await runSync();

    expect(lastPolicyArgs().proposals.map(p => `${p.source}:${p.memberKey}`)).toEqual(['wix_absence:e']);
    expect(result.holdReason).toBe('observation_only');                               // not invalid_proposal
    expect(alertsOf('revoke_invalid_proposal')).toEqual([]);
    expect(proposalRows().find(r => r.platform_member_id === 's')).toEqual(expect.objectContaining({
      kind: 'held_payment_state', source: 'holder_lapse', classification: 'UNKNOWN',
    }));
    expect(proposalRows().find(r => r.platform_member_id === 's').evidence)
      .toEqual(expect.objectContaining({ holderKey: null, unitKey: 's' }));
    expect(alertsOf('sweep_removal_pending').map(a => a.ref)).toEqual(['member:e']);  // e's evidence still stands
    expect(standardAdapter.recordNotPayingObservation.mock.calls).toEqual([['ma-e', PLAN_ID]]);
  });
});
