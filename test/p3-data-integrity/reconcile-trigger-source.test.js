/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: reconcile entry points propagate distinct triggerSource     │
 * │  into the bound actor.id                                                │
 * │                                                                         │
 * │  Business consequence (OB-227): when both in-process scheduler and     │
 * │  Railway cron bind triggered_by_actor_id='reconciliation-cron', we     │
 * │  cannot tell which path fired the sweep — reconcile-frequency tuning   │
 * │  at client #2 becomes guesswork.                                        │
 * │                                                                         │
 * │  Tests verify:                                                          │
 * │    1. runNightlySweep({ triggerSource: 'inprocess' })   → actor.id     │
 * │       'reconciliation-inprocess'                                        │
 * │    2. runNightlySweep({ triggerSource: 'cli' })         → actor.id     │
 * │       'reconciliation-cli'                                              │
 * │    3. runNightlySweep({ triggerSource: 'railway-cron' })→ actor.id     │
 * │       'reconciliation-railway-cron'                                     │
 * │    4. runNightlySweep() with no opts                    → actor.id     │
 * │       'reconciliation-unknown' (legacy 'reconciliation-cron' retired)  │
 * │    5. Per-client _syncClient inherits the sweep's discriminating actor │
 * │       via opts.triggeredByActor                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// Mock trace-context to capture the actor passed into runWith
const capturedActors = [];
jest.mock('../../core/trace-context', () => ({
  runWith: jest.fn((ctx, fn) => {
    capturedActors.push(ctx.actor);
    return fn();
  }),
  mintTraceId: jest.fn(() => 'trace-ob227-test'),
  getTraceId: jest.fn(() => 'trace-ob227-test'),
  getActor: jest.fn(() => ({ type: 'system', id: 'mock' })),
}));

// Mock everything _runNightlySweepBody touches so we don't hit the DB / Wix / Kisi.
// We only care that runWith was called with the right actor.id, and that _syncClient
// inherits the discriminating actor when invoked.
jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn() },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn().mockResolvedValue([]),
  getManagedRoleAssignments: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../adapters/standard-adapter', () => ({
  releaseStaleLocks: jest.fn().mockResolvedValue(0),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders: jest.fn().mockResolvedValue([]),
  listConfirmedBookings: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({
  resolve: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(k => `plain-${k}`),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() })),
}));

const reconciliation = require('../../core/reconciliation');

beforeEach(() => {
  capturedActors.length = 0;
  jest.clearAllMocks();
});

describe('[P3] OB-227 — reconcile trigger source propagates to actor.id', () => {

  test('runNightlySweep with triggerSource=inprocess binds actor id reconciliation-inprocess', async () => {
    await reconciliation.runNightlySweep({ triggerSource: 'inprocess' });
    expect(capturedActors).toHaveLength(1);
    expect(capturedActors[0]).toEqual({ type: 'system', id: 'reconciliation-inprocess' });
  });

  test('runNightlySweep with triggerSource=cli binds actor id reconciliation-cli', async () => {
    await reconciliation.runNightlySweep({ triggerSource: 'cli' });
    expect(capturedActors[0]).toEqual({ type: 'system', id: 'reconciliation-cli' });
  });

  test('runNightlySweep with triggerSource=railway-cron binds actor id reconciliation-railway-cron', async () => {
    await reconciliation.runNightlySweep({ triggerSource: 'railway-cron' });
    expect(capturedActors[0]).toEqual({ type: 'system', id: 'reconciliation-railway-cron' });
  });

  test('runNightlySweep with no opts defaults to reconciliation-unknown (legacy reconciliation-cron retired)', async () => {
    await reconciliation.runNightlySweep();
    expect(capturedActors[0]).toEqual({ type: 'system', id: 'reconciliation-unknown' });
    // Belt-and-suspenders: legacy literal must not be emitted as the default anymore
    expect(capturedActors[0].id).not.toBe('reconciliation-cron');
  });

  test('two consecutive sweeps with different trigger sources emit distinct actors', async () => {
    await reconciliation.runNightlySweep({ triggerSource: 'inprocess' });
    await reconciliation.runNightlySweep({ triggerSource: 'cli' });
    expect(capturedActors).toHaveLength(2);
    expect(capturedActors[0].id).toBe('reconciliation-inprocess');
    expect(capturedActors[1].id).toBe('reconciliation-cli');
    expect(capturedActors[0].id).not.toBe(capturedActors[1].id);
  });

  test('per-client _syncClient default actor falls back to reconciliation-unknown (not reconciliation-cron)', async () => {
    // Drive _syncClient directly with no triggeredByActor — exercises the
    // OB-227 default-string fix at the second binding site (was line 169).
    const db = require('../../db');
    // Audit-row INSERT must return an id so the close path doesn't crash
    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-1' }] }) // INSERT reconciliation_run
            .mockResolvedValue({ rows: [], rowCount: 0 });      // everything else

    // Provide a minimal client object; Wix fetch will return [] from mocks,
    // so the sweep enters and exits cleanly without hardware/DB writes.
    const client = {
      id: 'client-ob227', source_site_id: 'site-x', source_api_key: 'enc',
      hardware_api_key: 'enc-hw', hardware_platform: 'kisi',
      last_active_member_count: 0,
    };

    await reconciliation._syncClient(client, {}); // no triggeredByActor passed

    // The audit-row INSERT is the first db.query call; its 5th param is actor_id
    const insertCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO reconciliation_run')
    );
    expect(insertCall).toBeDefined();
    // Params: [client_id, trace_id, triggered_by, triggered_by_actor_type, triggered_by_actor_id, ...]
    const actorId = insertCall[1][4];
    expect(actorId).toBe('reconciliation-unknown');
    expect(actorId).not.toBe('reconciliation-cron');
  });

  test('per-client _syncClient with explicit operator actor preserves operator identity (not downgraded)', async () => {
    const db = require('../../db');
    db.query.mockResolvedValueOnce({ rows: [{ id: 'run-2' }] })
            .mockResolvedValue({ rows: [], rowCount: 0 });

    const client = {
      id: 'client-ob227', source_site_id: 'site-x', source_api_key: 'enc',
      hardware_api_key: 'enc-hw', hardware_platform: 'kisi',
      last_active_member_count: 0,
    };

    await reconciliation._syncClient(client, {
      triggeredBy: 'manual',
      triggeredByActor: { type: 'operator', id: 'daxxroberts@gmail.com' },
    });

    const insertCall = db.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO reconciliation_run')
    );
    expect(insertCall).toBeDefined();
    const actorType = insertCall[1][3];
    const actorId   = insertCall[1][4];
    expect(actorType).toBe('operator');
    expect(actorId).toBe('daxxroberts@gmail.com');
  });

});
