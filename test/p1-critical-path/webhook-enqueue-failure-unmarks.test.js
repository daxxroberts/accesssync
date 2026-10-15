/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: queuing a purchase fails (Redis down) — the purchase must    │
 * │  not be lost (owner hub review 2026-10-15, bug 2)                       │
 * │                                                                         │
 * │  The webhook is marked processed BEFORE it is queued (crash safety).    │
 * │  If the queue refuses the job, that mark used to stay: Wix retried the  │
 * │  delivery, the retry was rejected as a duplicate, and the purchase      │
 * │  never became a job. Now the mark comes off and the error propagates   │
 * │  so Wix gets a non-2xx and retries.                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/tenant-resolver', () => ({
  resolve: jest.fn().mockResolvedValue('tenant-001'),
  resolveByClientId: jest.fn().mockResolvedValue('tenant-001'),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-1'), getActor: jest.fn(() => ({ type: 'system', id: 'wix-connector' })),
  setTraceContext: jest.fn(), setClientId: jest.fn(),
}));
const mockAdd = jest.fn();
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })) }));

const db = require('../../db');
const processor = require('../../core/webhook-processor');

const event = (type) => ({
  traceId: 'trace-1', eventType: type, platformMemberId: 'wix-m-1', planId: 'plan-1', wixSiteId: 'site-1',
});

function wasQueried(fragment) {
  return db.query.mock.calls.some(([sql]) => String(sql).includes(fragment));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Every query returns "no rows" except where a test overrides it: not a duplicate, inserts succeed.
  db.query.mockResolvedValue({ rows: [] });
  processor.logWebhookAttempt = jest.fn().mockResolvedValue();
});

describe('[P1] a purchase whose enqueue fails is not marked processed', () => {
  test('grant: the queue throws → the processed row is deleted and the error propagates', async () => {
    mockAdd.mockRejectedValueOnce(new Error('ECONNREFUSED redis'));
    await expect(processor.processIncoming('evt-1', event('plan.purchased'), null)).rejects.toThrow('ECONNREFUSED');
    expect(wasQueried('INSERT INTO processed_event_ids')).toBe(true);
    expect(wasQueried('DELETE FROM processed_event_ids')).toBe(true);
    const del = db.query.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM processed_event_ids'));
    expect(del[1]).toEqual(['evt-1']);
  });

  test('revoke: same protection', async () => {
    mockAdd.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(processor.processIncoming('evt-2', event('plan.cancelled'), null)).rejects.toThrow('ECONNRESET');
    expect(wasQueried('DELETE FROM processed_event_ids')).toBe(true);
  });

  test('the next delivery of the same event is queued (the duplicate check no longer sees it)', async () => {
    mockAdd.mockRejectedValueOnce(new Error('ECONNREFUSED redis'));
    await expect(processor.processIncoming('evt-3', event('plan.purchased'), null)).rejects.toThrow();
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });   // row gone → not a duplicate
    mockAdd.mockResolvedValueOnce({ id: 'grant-evt-3' });
    await processor.processIncoming('evt-3', event('plan.purchased'), null);
    expect(mockAdd).toHaveBeenCalledWith('grant', expect.objectContaining({ tenantId: 'tenant-001' }), { jobId: 'grant-evt-3' });
    expect(wasQueried('DELETE FROM processed_event_ids')).toBe(false);
  });

  test('a successful enqueue leaves the processed mark in place', async () => {
    mockAdd.mockResolvedValueOnce({ id: 'grant-evt-4' });
    await processor.processIncoming('evt-4', event('plan.purchased'), null);
    expect(wasQueried('INSERT INTO processed_event_ids')).toBe(true);
    expect(wasQueried('DELETE FROM processed_event_ids')).toBe(false);
  });
});
