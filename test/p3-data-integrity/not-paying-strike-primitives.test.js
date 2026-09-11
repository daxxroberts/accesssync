/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  L3 strike-clock primitives (Phase 1 / 3B):                             │
 * │    recordNotPayingObservation, clearNotPayingObservation                │
 * │                                                                         │
 * │  Observational only. They write the three M3 columns on                 │
 * │  member_access_sources and nothing else — never status, never           │
 * │  updated_at, never member_access. They must work BEFORE migration M3    │
 * │  is applied (42703 → columns_missing, warned once per process) and      │
 * │  must NEVER throw — the sweep calls them inline for every member.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  deleteUser: jest.fn(),
  getRoleAssignmentsForUser: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId:      jest.fn().mockReturnValue(null),
  setTraceContext: jest.fn(),
  getActor:        jest.fn().mockReturnValue(null),
}));

jest.mock('../../adapters/wix/wix-members-api', () => ({ getMemberById: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

const db      = require('../../db');
const { log } = require('../../core/logger');
const adapter = require('../../adapters/standard-adapter');

const ACCESS_ID = 'access-uuid-001';
const PLAN_ID   = 'wix-plan-001';

function pgError(code, message = 'pg error') {
  const e = new Error(message);
  e.code = code;
  return e;
}

function setClause(sql) {
  // Text between SET and WHERE — the columns this statement writes.
  const m = sql.match(/\bSET\b([\s\S]*?)\bWHERE\b/);
  return m ? m[1] : '';
}

function warnCount(event) {
  return log.warn.mock.calls.filter(c => c[0] === event).length;
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  adapter._notPayingColumnsMissingWarned = false; // per-process flag — reset per test
});

// ─────────────────────────────────────────────────────────────────────────────
// recordNotPayingObservation
// ─────────────────────────────────────────────────────────────────────────────
describe('[P3] recordNotPayingObservation', () => {
  test('single UPDATE on member_access_sources: starts the clock once, stamps last-seen, increments count', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });

    const result = await adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID);

    expect(result).toEqual({ recorded: true, rowCount: 2 });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE member_access_sources\b/);
    expect(sql).toMatch(/not_paying_since\s*=\s*COALESCE\(not_paying_since, NOW\(\)\)/);
    expect(sql).toMatch(/not_paying_last_seen_at\s*=\s*NOW\(\)/);
    expect(sql).toMatch(/not_paying_observations\s*=\s*COALESCE\(not_paying_observations, 0\) \+ 1/);
    expect(sql).toMatch(/access_id = \$1/);
    expect(sql).toMatch(/source_plan_id = \$2/);
    expect(sql).toMatch(/status = 'active'/); // only ACTIVE sources accrue strikes
    expect(params).toEqual([ACCESS_ID, PLAN_ID]);
  });

  test('never writes status or updated_at (observation, not a state change)', async () => {
    await adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID);

    const set = setClause(db.query.mock.calls[0][0]);
    expect(set).not.toMatch(/\bstatus\b/);
    expect(set).not.toMatch(/updated_at/);
  });

  test('rowCount defaults to 0 when the driver omits it', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await expect(adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ recorded: true, rowCount: 0 });
  });

  test('42703 (M3 not applied) → { recorded:false, reason:columns_missing }, no throw', async () => {
    db.query.mockRejectedValueOnce(pgError('42703', 'column "not_paying_since" does not exist'));

    await expect(adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ recorded: false, reason: 'columns_missing' });
    expect(warnCount('adapter.not_paying.columns_missing')).toBe(1);
  });

  test('other DB error → warn + { recorded:false }, no throw', async () => {
    db.query.mockRejectedValueOnce(pgError('57P01', 'terminating connection'));

    await expect(adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ recorded: false });
    expect(warnCount('adapter.not_paying.record_failed')).toBe(1);
    expect(warnCount('adapter.not_paying.columns_missing')).toBe(0);
  });

  test('synchronous throw from the driver is still swallowed', async () => {
    db.query.mockImplementationOnce(() => { throw new Error('pool destroyed'); });

    await expect(adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ recorded: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// clearNotPayingObservation
// ─────────────────────────────────────────────────────────────────────────────
describe('[P3] clearNotPayingObservation', () => {
  test('resets the three columns to NULL / NULL / 0 for that (access, plan)', async () => {
    db.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID);

    expect(result).toEqual({ cleared: true, rowCount: 1 });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/^\s*UPDATE member_access_sources\b/);
    const set = setClause(sql);
    expect(set).toMatch(/not_paying_since\s*=\s*NULL/);
    expect(set).toMatch(/not_paying_last_seen_at\s*=\s*NULL/);
    expect(set).toMatch(/not_paying_observations\s*=\s*0/);
    expect(sql).toMatch(/access_id = \$1/);
    expect(sql).toMatch(/source_plan_id = \$2/);
    expect(params).toEqual([ACCESS_ID, PLAN_ID]);
  });

  test('never writes status or updated_at', async () => {
    await adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID);

    const set = setClause(db.query.mock.calls[0][0]);
    expect(set).not.toMatch(/\bstatus\b/);
    expect(set).not.toMatch(/updated_at/);
  });

  test('only touches rows that actually carry a clock (no no-op write per paying member)', async () => {
    await adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID);

    const where = db.query.mock.calls[0][0].split(/\bWHERE\b/)[1];
    expect(where).toMatch(/not_paying_since IS NOT NULL/);
  });

  test('42703 → { cleared:false, reason:columns_missing }, no throw', async () => {
    db.query.mockRejectedValueOnce(pgError('42703'));

    await expect(adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ cleared: false, reason: 'columns_missing' });
  });

  test('other DB error → warn + { cleared:false }, no throw', async () => {
    db.query.mockRejectedValueOnce(pgError('08006'));

    await expect(adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID))
      .resolves.toEqual({ cleared: false });
    expect(warnCount('adapter.not_paying.clear_failed')).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared contract
// ─────────────────────────────────────────────────────────────────────────────
describe('[P3] strike primitives — shared contract', () => {
  test('columns_missing warns ONCE per process across many record + clear calls', async () => {
    db.query.mockRejectedValue(pgError('42703'));

    for (let i = 0; i < 5; i++) {
      await adapter.recordNotPayingObservation(`access-${i}`, PLAN_ID);
      await adapter.clearNotPayingObservation(`access-${i}`, PLAN_ID);
    }

    expect(warnCount('adapter.not_paying.columns_missing')).toBe(1);
  });

  test('neither primitive writes member_access, member_master, or any other table (DR-023)', async () => {
    await adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID);
    await adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID);

    for (const [sql] of db.query.mock.calls) {
      const writes = sql.match(/(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g) || [];
      expect(writes).toEqual(['UPDATE member_access_sources']);
    }
  });

  test('nothing is ever removed, cancelled, or downgraded', async () => {
    await adapter.recordNotPayingObservation(ACCESS_ID, PLAN_ID);
    await adapter.clearNotPayingObservation(ACCESS_ID, PLAN_ID);

    for (const [sql] of db.query.mock.calls) {
      expect(sql).not.toMatch(/DELETE/);
      expect(sql).not.toMatch(/'cancelled'|'revoked'|'failed'|'inactive'/);
    }
  });
});
