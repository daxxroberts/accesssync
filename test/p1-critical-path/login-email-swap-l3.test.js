/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  DR-056 — Layer 3 owns the writes of the login-email swap (DR-023)      │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    1. The source rows, the cached Kisi user id, the stored email and    │
 * │       the audit row commit together — or none of them does. A swap      │
 * │       that half-wrote would point a member at a Kisi user with no       │
 * │       doors, or at a deleted one.                                       │
 * │    2. Every statement is scoped to the client (tenant isolation).       │
 * │    3. The connection is always handed back, success or failure.         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-l3'),
  getActor: jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
  setTraceContext: jest.fn(),
}));
jest.mock('../../adapters/hardware-adapter', () => ({}));

const db = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');

const ARGS = {
  accessId: 'acc-1', memberMasterId: 'mm-1', tenantId: 'client-1',
  newEmail: 'New@X.com', newHardwareUserId: 222, auditEventType: 'login_email_swapped',
  sourceMoves: [
    { sourceIds: ['s1', 's2'], roleAssignmentId: 'ra-new-1' },
    { sourceIds: ['s3'], roleAssignmentId: 'ra-new-2' },
  ],
};

let client;
beforeEach(() => {
  jest.clearAllMocks();
  client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  db.getClient.mockResolvedValue(client);
});

describe('[P1] DR-056 completeLoginEmailSwap: one transaction', () => {
  test('BEGIN → source rows → access → master → audit → COMMIT, all scoped to the client', async () => {
    await standardAdapter.completeLoginEmailSwap(ARGS);
    const sqls = client.query.mock.calls.map(c => c[0].trim().split(/\s+/).slice(0, 3).join(' '));
    expect(sqls).toEqual([
      'BEGIN',
      'UPDATE member_access_sources SET',
      'UPDATE member_access_sources SET',
      'UPDATE member_access SET',
      'UPDATE member_master SET',
      'INSERT INTO member_access_log',
      'COMMIT',
    ]);
    const calls = client.query.mock.calls;
    expect(calls[1][1]).toEqual(['ra-new-1', ['s1', 's2'], 'client-1']);
    expect(calls[2][1]).toEqual(['ra-new-2', ['s3'], 'client-1']);
    expect(calls[3][1]).toEqual(['222', 'acc-1', 'client-1']);
    expect(calls[4][1]).toEqual(['New@X.com', 'mm-1', 'client-1']);
    expect(calls[5][1]).toEqual(['acc-1', 'client-1', 'login_email_swapped', 'trace-l3', 'system', 'queue-worker']);
    for (const i of [1, 2, 3, 4]) expect(calls[i][0]).toMatch(/client_id = \$\d/);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('any statement failing → ROLLBACK, never COMMIT, connection released, original error thrown', async () => {
    client.query.mockImplementation((sql) => (/UPDATE member_master/.test(sql) ? Promise.reject(new Error('disk full')) : Promise.resolve({ rows: [] })));
    await expect(standardAdapter.completeLoginEmailSwap(ARGS)).rejects.toThrow('disk full');
    const sqls = client.query.mock.calls.map(c => c[0].trim());
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('the audit row is written inside the transaction (it is what the 30-day limit reads)', async () => {
    client.query.mockImplementation((sql) => (/INSERT INTO member_access_log/.test(sql) ? Promise.reject(new Error('log boom')) : Promise.resolve({ rows: [] })));
    await expect(standardAdapter.completeLoginEmailSwap(ARGS)).rejects.toThrow('log boom');
    expect(client.query.mock.calls.map(c => c[0].trim())).toContain('ROLLBACK');
  });

  test('a member with no moved doors still switches the Kisi user, email and audit row', async () => {
    await standardAdapter.completeLoginEmailSwap({ ...ARGS, sourceMoves: [] });
    const sqls = client.query.mock.calls.map(c => c[0].trim().split(/\s+/).slice(0, 3).join(' '));
    expect(sqls).toEqual(['BEGIN', 'UPDATE member_access SET', 'UPDATE member_master SET', 'INSERT INTO member_access_log', 'COMMIT']);
  });
});

describe('[P1] DR-056 storeLoginEmail', () => {
  test('updates only the stored email, scoped to the client', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await standardAdapter.storeLoginEmail('mm-1', 'client-1', 'New@X.com');
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/UPDATE member_master SET email = \$1.*client_id = \$3/s);
    expect(db.query.mock.calls[0][1]).toEqual(['New@X.com', 'mm-1', 'client-1']);
  });
});
