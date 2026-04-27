/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: trace context propagates through every async boundary        │
 * │                                                                         │
 * │  Business consequence: If AsyncLocalStorage context leaks, drops, or   │
 * │  crosses between concurrent requests, trace IDs in log rows are wrong  │
 * │  or missing. Debugging a production incident becomes impossible.        │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                      │
 * │  This file is the C1 mitigation gate per FAULT/STEEL review.           │
 * │  If any test here fails, Step 2 is NOT complete.                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const {
  runWith,
  setActor,
  getContext,
  getTraceId,
  getActor,
  mintTraceId,
} = require('../../core/trace-context');

const ACTOR_SYSTEM = { type: 'system', id: 'test-harness' };
const ACTOR_OPERATOR = { type: 'operator', id: 'operator@test.com' };
const ACTOR_ANON = { type: 'webhook', id: 'anon' };

// ─── UUID v4 regex ───────────────────────────────────────────────────────────
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('[P3] trace-context: propagation across every async boundary AccessSync uses', () => {

  // ── Basic propagation ──────────────────────────────────────────────────────

  test('survives await/Promise chain', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_SYSTEM }, async () => {
      await Promise.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(getTraceId()).toBe(traceId);
      expect(getActor()).toEqual(ACTOR_SYSTEM);
    });
  });

  test('survives setImmediate', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_SYSTEM }, () => {
      return new Promise(resolve => {
        setImmediate(() => {
          expect(getTraceId()).toBe(traceId);
          resolve();
        });
      });
    });
  });

  test('survives setTimeout (zero ms)', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_SYSTEM }, () => {
      return new Promise(resolve => {
        setTimeout(() => {
          expect(getTraceId()).toBe(traceId);
          resolve();
        }, 0);
      });
    });
  });

  test('survives Promise.all — both branches see the same traceId', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_SYSTEM }, async () => {
      const results = await Promise.all([
        Promise.resolve().then(() => getTraceId()),
        new Promise(resolve => setImmediate(() => resolve(getTraceId()))),
      ]);
      expect(results[0]).toBe(traceId);
      expect(results[1]).toBe(traceId);
    });
  });

  test('survives async iteration (for-await-of)', async () => {
    const traceId = mintTraceId();

    async function* makeAsyncGen() {
      yield 1;
      await Promise.resolve();
      yield 2;
    }

    await runWith({ traceId, actor: ACTOR_SYSTEM }, async () => {
      for await (const _ of makeAsyncGen()) {
        expect(getTraceId()).toBe(traceId);
      }
    });
  });

  // ── pg-pool boundaries ─────────────────────────────────────────────────────

  test('survives pg-pool query callback (callback-style mock)', async () => {
    const traceId = mintTraceId();

    const mockPool = {
      query: (sql, cb) => {
        setImmediate(() => cb(null, { rows: [] }));
      },
    };

    await runWith({ traceId, actor: ACTOR_SYSTEM }, () => {
      return new Promise((resolve, reject) => {
        mockPool.query('SELECT 1', (err) => {
          try {
            expect(getTraceId()).toBe(traceId);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });

  test('survives pg-pool query Promise', async () => {
    const traceId = mintTraceId();

    const mockPool = {
      query: () => Promise.resolve({ rows: [] }),
    };

    await runWith({ traceId, actor: ACTOR_SYSTEM }, async () => {
      await mockPool.query('SELECT 1');
      expect(getTraceId()).toBe(traceId);
    });
  });

  // ── Nested contexts ────────────────────────────────────────────────────────

  test('nested runWith: child context replaces parent mid-scope', async () => {
    const outerTraceId = mintTraceId();
    const innerTraceId = mintTraceId();

    await runWith({ traceId: outerTraceId, actor: ACTOR_SYSTEM }, async () => {
      expect(getTraceId()).toBe(outerTraceId);

      await runWith({ traceId: innerTraceId, actor: ACTOR_OPERATOR }, async () => {
        expect(getTraceId()).toBe(innerTraceId);
        expect(getActor()).toEqual(ACTOR_OPERATOR);
      });

      // After inner exits, outer context is restored
      expect(getTraceId()).toBe(outerTraceId);
      expect(getActor()).toEqual(ACTOR_SYSTEM);
    });
  });

  // ── Absent outside context ─────────────────────────────────────────────────

  test('getTraceId returns undefined when no context is active', () => {
    // This test runs outside any runWith, so ALS store should be empty
    expect(getTraceId()).toBeUndefined();
  });

  test('getActor returns undefined when no context is active', () => {
    expect(getActor()).toBeUndefined();
  });

  test('getContext returns undefined when no context is active', () => {
    expect(getContext()).toBeUndefined();
  });

  // ── mintTraceId ────────────────────────────────────────────────────────────

  test('mintTraceId returns RFC 4122 UUID v4', () => {
    const id = mintTraceId();
    expect(id).toMatch(UUID_V4);
  });

  test('mintTraceId returns a new ID on every call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => mintTraceId()));
    expect(ids.size).toBe(100);
  });

  // ── Input validation ───────────────────────────────────────────────────────

  test('runWith throws when traceId is missing', () => {
    expect(() => runWith({ actor: ACTOR_SYSTEM }, () => {})).toThrow('ctx.traceId is required');
  });

  test('runWith throws when actor is missing', () => {
    expect(() => runWith({ traceId: mintTraceId() }, () => {})).toThrow('ctx.actor');
  });

  test('runWith throws when actor.type is invalid', () => {
    expect(() =>
      runWith({ traceId: mintTraceId(), actor: { type: 'admin', id: 'x' } }, () => {})
    ).toThrow('actor.type must be one of');
  });

  test('runWith accepts all valid actor types', () => {
    const validTypes = ['owner', 'operator', 'member', 'system', 'webhook'];
    for (const type of validTypes) {
      expect(() =>
        runWith({ traceId: mintTraceId(), actor: { type, id: 'test' } }, () => {})
      ).not.toThrow();
    }
  });

  // ── setActor ───────────────────────────────────────────────────────────────

  test('setActor updates actor mid-flight while traceId stays the same', async () => {
    const traceId = mintTraceId();

    await runWith({ traceId, actor: ACTOR_ANON }, async () => {
      expect(getActor()).toEqual(ACTOR_ANON);

      setActor(ACTOR_OPERATOR);

      expect(getTraceId()).toBe(traceId);           // traceId unchanged
      expect(getActor()).toEqual(ACTOR_OPERATOR);   // actor updated
    });
  });

  test('setActor is a no-op when no context is active', () => {
    expect(() => setActor(ACTOR_OPERATOR)).not.toThrow();
    expect(getActor()).toBeUndefined();
  });

  // ── Express-style middleware chain ─────────────────────────────────────────

  test('Express-style middleware chain: middleware mints context, handler reads it', async () => {
    const traceId = mintTraceId();
    let handlerTraceId;

    // Simulate Express: middleware calls runWith, then next(), handler runs inside
    await new Promise(resolve => {
      runWith({ traceId, actor: ACTOR_OPERATOR }, () => {
        // Simulate next() → handler executes
        setImmediate(() => {
          handlerTraceId = getTraceId();
          resolve();
        });
      });
    });

    expect(handlerTraceId).toBe(traceId);
  });

  // ── BullMQ-style job handler ───────────────────────────────────────────────

  test('BullMQ-style job handler: traceId passed in payload, worker restores context', async () => {
    // BullMQ crosses a process boundary — ALS does NOT propagate.
    // Pattern: enqueue job with payload.traceId; worker calls runWith to restore.
    const originalTraceId = mintTraceId();

    // Simulate the queue payload
    const jobPayload = {
      traceId: originalTraceId,
      memberId: 'abc-123',
      eventType: 'plan.purchased',
    };

    // Simulate the BullMQ worker handler
    let workerTraceId;
    await runWith(
      { traceId: jobPayload.traceId, actor: { type: 'system', id: 'queue-worker' } },
      async () => {
        // Worker does its async work
        await Promise.resolve();
        workerTraceId = getTraceId();
      }
    );

    expect(workerTraceId).toBe(originalTraceId);
  });

  // ── Concurrency isolation ─────────────────────────────────────────────────

  test('100 concurrent runWith calls do not leak context between each other', async () => {
    const CONCURRENCY = 100;

    const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
      const traceId = `trace-${i.toString().padStart(4, '0')}-${mintTraceId()}`;
      return runWith({ traceId, actor: { type: 'system', id: `worker-${i}` } }, async () => {
        // Yield to other tasks
        await new Promise(resolve => setImmediate(resolve));
        await Promise.resolve();
        const seen = getTraceId();
        if (seen !== traceId) {
          throw new Error(`Context leak! Expected ${traceId}, got ${seen}`);
        }
        return seen;
      });
    });

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(CONCURRENCY);
    results.forEach((seen, i) => {
      expect(seen).toContain(`trace-${i.toString().padStart(4, '0')}`);
    });
  });

});
