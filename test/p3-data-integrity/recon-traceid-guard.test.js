/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: reconciliation never enqueues a job without a traceId        │
 * │                                                                         │
 * │  Business consequence: queue-worker.js:77 throws QUEUE_JOB_MISSING_     │
 * │  TRACE_ID before runWith() executes, so BullMQ marks the job exhausted  │
 * │  on attempt 1. A traceId-less recon revoke = a member who should have   │
 * │  lost access keeps it. Surfaced in Railway 2026-04-29.                  │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn().mockResolvedValue({}) },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(),
  getManagedRoleAssignments: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders: jest.fn(),
  listConfirmedBookings: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k) }));

const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const recon = require('../../core/reconciliation');

beforeEach(() => {
  db.query.mockReset();
  eventQueue.add.mockClear();
  recon._sweepTraceId = null;
});

describe('[P3] reconciliation: re-queue guards against missing traceId', () => {

  test('mints a traceId when error_queue payload lacks one', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{
        event_type: 'plan.cancelled',
        payload: JSON.stringify({
          eventType: 'plan.cancelled',
          sourcePlatform: 'wix',
          platformMemberId: 'member-1',
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm1',
      client_id: 'c1',
      platform_member_id: 'member-1',
    });

    expect(eventQueue.add).toHaveBeenCalledTimes(1);
    const [, payload] = eventQueue.add.mock.calls[0];
    expect(payload.standardEvent.traceId).toEqual(expect.any(String));
    expect(payload.standardEvent.traceId.length).toBeGreaterThan(0);
  });

  test('preserves existing traceId from error_queue payload', async () => {
    const originalTrace = '11111111-2222-3333-4444-555555555555';
    db.query.mockResolvedValueOnce({
      rows: [{
        event_type: 'plan.purchased',
        payload: JSON.stringify({
          eventType: 'plan.purchased',
          sourcePlatform: 'wix',
          platformMemberId: 'member-2',
          traceId: originalTrace,
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm2',
      client_id: 'c2',
      platform_member_id: 'member-2',
    });

    const [, payload] = eventQueue.add.mock.calls[0];
    expect(payload.standardEvent.traceId).toBe(originalTrace);
  });

  test('uses sweep traceId when available, mints new when both missing', async () => {
    recon._sweepTraceId = 'sweep-trace-abc';
    db.query.mockResolvedValueOnce({
      rows: [{
        event_type: 'booking.cancelled',
        payload: JSON.stringify({
          eventType: 'booking.cancelled',
          sourcePlatform: 'wix',
          platformMemberId: 'member-3',
        }),
      }],
    });

    await recon._processRecordTargeted({
      member_id: 'm3',
      client_id: 'c3',
      platform_member_id: 'member-3',
    });

    const [, payload] = eventQueue.add.mock.calls[0];
    expect(payload.standardEvent.traceId).toBe('sweep-trace-abc');
  });
});
