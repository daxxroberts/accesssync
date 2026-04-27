/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: cron jobs run inside trace context                           │
 * │                                                                         │
 * │  Business consequence: Without runWith at cron entry, all logs from    │
 * │  the nightly sweep have no traceId — the full reconciliation run is    │
 * │  unqueryable from v_trace_timeline.                                     │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { runWith, mintTraceId, getTraceId, getActor } = require('../../core/trace-context');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── Verify runWith API directly (foundation for cron pattern) ─────────────────

describe('[P3] cron trace context: runWith pattern used by both crons', () => {

  test('runWith mints a fresh UUID v4 and binds it as traceId', async () => {
    const traceId = mintTraceId();
    expect(traceId).toMatch(UUID_V4);

    let seen;
    await runWith({ traceId, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
      seen = getTraceId();
    });
    expect(seen).toBe(traceId);
  });

  test('reconciliation-cron actor is bound correctly', async () => {
    const traceId = mintTraceId();
    let seen;
    await runWith({ traceId, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
      seen = getActor();
    });
    expect(seen).toEqual({ type: 'system', id: 'reconciliation-cron' });
  });

  test('hardware-health-check-cron actor is bound correctly', async () => {
    const traceId = mintTraceId();
    let seen;
    await runWith({ traceId, actor: { type: 'system', id: 'hardware-health-check-cron' } }, async () => {
      seen = getActor();
    });
    expect(seen).toEqual({ type: 'system', id: 'hardware-health-check-cron' });
  });

  test('two concurrent cron runs do not share trace IDs', async () => {
    const traceA = mintTraceId();
    const traceB = mintTraceId();

    const [seenA, seenB] = await Promise.all([
      runWith({ traceId: traceA, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
        await Promise.resolve();
        return getTraceId();
      }),
      runWith({ traceId: traceB, actor: { type: 'system', id: 'hardware-health-check-cron' } }, async () => {
        await Promise.resolve();
        return getTraceId();
      }),
    ]);

    expect(seenA).toBe(traceA);
    expect(seenB).toBe(traceB);
    expect(seenA).not.toBe(seenB);
  });

  test('cron logs carry actor_type=system and actor_id matching cron name', async () => {
    // This test verifies the logger integration — simulate the cron log pattern
    let stdoutLines = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
        try { stdoutLines.push(JSON.parse(chunk.trim())); } catch {}
      }
      return true;
    };

    const { log } = require('../../core/logger');
    const traceId = mintTraceId();

    await runWith({ traceId, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
      log.info('reconciliation.sweep_start', { stage: 'cron', result: 'start' });
    });

    process.stdout.write = originalWrite;

    const cronLog = stdoutLines.find(l => l.event === 'reconciliation.sweep_start');
    expect(cronLog).toBeDefined();
    expect(cronLog.traceId).toBe(traceId);
    expect(cronLog.actor_type).toBe('system');
    expect(cronLog.actor_id).toBe('reconciliation-cron');
  });

});
