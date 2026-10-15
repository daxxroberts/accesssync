/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: each gym syncs on its own interval                           │
 * │  (owner hub review 2026-10-15, bug 7 — must hold before client #2)      │
 * │                                                                         │
 * │  The sweep used to read ONE client's last_sync_at and interval, decide  │
 * │  for everyone, then sync every client and stamp every last_sync_at.    │
 * │  Now the gate is per client: only the clients whose own interval has   │
 * │  elapsed are synced and stamped.                                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn(), debug: jest.fn() };
  return { log: l, withTrace: () => l, withClient: (_id, fn) => fn() };
});
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../adapters/standard-adapter', () => ({ releaseStaleLocks: jest.fn().mockResolvedValue(0) }));

const db = require('../../db');
const reconciliation = require('../../core/reconciliation');
const NightlyReconciliation = reconciliation.constructor;

const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();

describe('[P3] NightlyReconciliation.dueClientIds — per-client gate', () => {
  test('never synced → due', () => {
    expect(NightlyReconciliation.dueClientIds([{ id: 'a', last_sync_at: null, interval: 'daily' }])).toEqual(['a']);
  });

  test('two gyms, two intervals: the 6h gym is due, the daily gym is not', () => {
    const rows = [
      { id: 'six', last_sync_at: H(7), interval: '6h' },
      { id: 'day', last_sync_at: H(7), interval: 'daily' },
    ];
    expect(NightlyReconciliation.dueClientIds(rows)).toEqual(['six']);
  });

  test('10% slack (capped at 30 min): a 6h gym synced 5h35m ago is due, 5h20m ago is not', () => {
    const due = NightlyReconciliation.dueClientIds([{ id: 'x', last_sync_at: H(5 + 35 / 60), interval: '6h' }]);
    const notDue = NightlyReconciliation.dueClientIds([{ id: 'x', last_sync_at: H(5 + 20 / 60), interval: '6h' }]);
    expect(due).toEqual(['x']);
    expect(notDue).toEqual([]);
  });

  test('an unknown interval falls back to daily; rows without an id are ignored', () => {
    expect(NightlyReconciliation.dueClientIds([{ id: 'u', last_sync_at: H(23), interval: 'fortnightly' }])).toEqual([]);
    expect(NightlyReconciliation.dueClientIds([{ id: 'u', last_sync_at: H(25), interval: 'fortnightly' }])).toEqual(['u']);
    expect(NightlyReconciliation.dueClientIds([{ last_sync_at: null, interval: 'daily' }])).toEqual([]);
  });
});

describe('[P3] the sweep syncs and stamps only the clients that are due', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reconciliation._syncTrueSources = jest.fn().mockResolvedValue();
    reconciliation._syncDoorLockdownStates = jest.fn().mockResolvedValue();
    reconciliation._fetchActionableRecords = jest.fn().mockResolvedValue([]);
    reconciliation._generateAndSendDigest = jest.fn().mockResolvedValue();
  });

  test('only the due client ids are passed to the Wix sync and stamped in last_sync_at', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: 'six', last_sync_at: H(7), interval: '6h' },
      { id: 'day', last_sync_at: H(7), interval: 'daily' },
    ] });
    db.query.mockResolvedValue({ rows: [] });
    await reconciliation._runNightlySweepBody('trace-1', 'test');
    expect(reconciliation._syncTrueSources).toHaveBeenCalledWith(expect.any(Map), ['six']);
    const stamp = db.query.mock.calls.find(([sql]) => String(sql).includes('SET last_sync_at = NOW()'));
    expect(String(stamp[0])).toMatch(/id = ANY\(\$1::uuid\[\]\)/);
    expect(stamp[1]).toEqual([['six']]);
  });

  test('nobody due → the sweep is skipped and nothing is stamped', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'day', last_sync_at: H(1), interval: 'daily' }] });
    await reconciliation._runNightlySweepBody('trace-2', 'test');
    expect(reconciliation._syncTrueSources).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('SET last_sync_at'))).toBe(false);
  });

  test('the gate reads every active client, not one', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await reconciliation._runNightlySweepBody('trace-3', 'test');
    const gate = String(db.query.mock.calls[0][0]);
    expect(gate).toMatch(/FROM clients WHERE status = 'active'/);
    expect(gate).not.toMatch(/LIMIT 1/);
  });
});
