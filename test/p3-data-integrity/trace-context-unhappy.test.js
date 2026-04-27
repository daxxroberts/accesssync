/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: trace-context unhappy paths and validation enforcement       │
 * │                                                                         │
 * │  Business consequence: Misconfigured actors or missing traceIds on any  │
 * │  entry point produce traceless logs. The provisioning lifecycle becomes │
 * │  unqueryable. Every entry point must be forced to pass valid context.   │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const {
  runWith, setActor, getContext, getTraceId, getActor, mintTraceId,
} = require('../../core/trace-context');

// ── runWith input validation ──────────────────────────────────────────────────

describe('[P3] trace-context: runWith validation rejects bad input', () => {

  test('throws if ctx is null', () => {
    expect(() => runWith(null, () => {})).toThrow('runWith: ctx.traceId is required');
  });

  test('throws if ctx is undefined', () => {
    expect(() => runWith(undefined, () => {})).toThrow('runWith: ctx.traceId is required');
  });

  test('throws if traceId is missing from ctx', () => {
    expect(() => runWith({ actor: { type: 'system', id: 'test' } }, () => {}))
      .toThrow('runWith: ctx.traceId is required');
  });

  test('throws if actor is missing from ctx', () => {
    const traceId = mintTraceId();
    expect(() => runWith({ traceId }, () => {}))
      .toThrow('runWith: ctx.actor.{type,id} is required');
  });

  test('throws if actor.type is missing', () => {
    const traceId = mintTraceId();
    expect(() => runWith({ traceId, actor: { id: 'user-1' } }, () => {}))
      .toThrow('runWith: ctx.actor.{type,id} is required');
  });

  test('throws if actor.id is missing', () => {
    const traceId = mintTraceId();
    expect(() => runWith({ traceId, actor: { type: 'operator' } }, () => {}))
      .toThrow('runWith: ctx.actor.{type,id} is required');
  });

  test('throws if actor.type is an invalid string', () => {
    const traceId = mintTraceId();
    expect(() => runWith({ traceId, actor: { type: 'admin', id: 'user-1' } }, () => {}))
      .toThrow(/actor.type must be one of/);
  });

  test('throws if actor.type is empty string', () => {
    const traceId = mintTraceId();
    expect(() => runWith({ traceId, actor: { type: '', id: 'user-1' } }, () => {}))
      .toThrow('runWith: ctx.actor.{type,id} is required');
  });

  test('accepts all five valid actor types without throwing', async () => {
    const traceId = mintTraceId();
    const types = ['owner', 'operator', 'member', 'system', 'webhook'];
    for (const type of types) {
      await expect(runWith({ traceId, actor: { type, id: 'test' } }, async () => {}))
        .resolves.toBeUndefined();
    }
  });

});

// ── Context isolation and nesting ─────────────────────────────────────────────

describe('[P3] trace-context: context isolation and nesting', () => {

  test('nested runWith replaces parent context entirely', async () => {
    const outer = mintTraceId();
    const inner = mintTraceId();
    let seenInner;

    await runWith({ traceId: outer, actor: { type: 'system', id: 'outer' } }, async () => {
      await runWith({ traceId: inner, actor: { type: 'operator', id: 'inner' } }, async () => {
        seenInner = getTraceId();
      });
    });

    expect(seenInner).toBe(inner);
    expect(seenInner).not.toBe(outer);
  });

  test('after nested runWith exits, outer context is restored', async () => {
    const outer = mintTraceId();
    const inner = mintTraceId();
    let seenAfter;

    await runWith({ traceId: outer, actor: { type: 'system', id: 'outer' } }, async () => {
      await runWith({ traceId: inner, actor: { type: 'system', id: 'inner' } }, async () => {});
      seenAfter = getTraceId();
    });

    expect(seenAfter).toBe(outer);
  });

  test('sibling runWith calls share nothing', async () => {
    const traceA = mintTraceId();
    const traceB = mintTraceId();
    let seenA, seenB;

    await runWith({ traceId: traceA, actor: { type: 'system', id: 'a' } }, async () => {
      seenA = getTraceId();
    });
    await runWith({ traceId: traceB, actor: { type: 'system', id: 'b' } }, async () => {
      seenB = getTraceId();
    });

    expect(seenA).toBe(traceA);
    expect(seenB).toBe(traceB);
  });

  test('getContext returns full object including traceId and actor', async () => {
    const traceId = mintTraceId();
    let ctx;
    await runWith({ traceId, actor: { type: 'operator', id: 'op-1' } }, async () => {
      ctx = getContext();
    });
    expect(ctx.traceId).toBe(traceId);
    expect(ctx.actor.type).toBe('operator');
    expect(ctx.actor.id).toBe('op-1');
  });

  test('getContext returns undefined outside any runWith', () => {
    // This test runs outside any runWith at the describe level
    expect(getContext()).toBeUndefined();
  });

});

// ── setActor mid-flight ───────────────────────────────────────────────────────

describe('[P3] trace-context: setActor mid-flight', () => {

  test('setActor updates actor without changing traceId', async () => {
    const traceId = mintTraceId();
    let beforeActor, afterActor, traceAfter;

    await runWith({ traceId, actor: { type: 'system', id: 'anonymous' } }, async () => {
      beforeActor = getActor();
      setActor({ type: 'operator', id: 'resolved-operator' });
      afterActor = getActor();
      traceAfter = getTraceId();
    });

    expect(beforeActor.id).toBe('anonymous');
    expect(afterActor.id).toBe('resolved-operator');
    expect(afterActor.type).toBe('operator');
    expect(traceAfter).toBe(traceId);
  });

  test('setActor outside runWith is a no-op (does not throw)', () => {
    expect(() => setActor({ type: 'system', id: 'test' })).not.toThrow();
  });

  test('setActor change is visible to async continuations', async () => {
    const traceId = mintTraceId();
    let seenActor;

    await runWith({ traceId, actor: { type: 'system', id: 'pre-auth' } }, async () => {
      setActor({ type: 'member', id: 'member-resolved-001' });
      await Promise.resolve(); // yield
      seenActor = getActor();
    });

    expect(seenActor.type).toBe('member');
    expect(seenActor.id).toBe('member-resolved-001');
  });

});

// ── mintTraceId ───────────────────────────────────────────────────────────────

describe('[P3] trace-context: mintTraceId uniqueness', () => {

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  test('every call produces a unique value (50 samples)', () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintTraceId()));
    expect(ids.size).toBe(50);
  });

  test('all minted IDs match UUID v4 format', () => {
    for (let i = 0; i < 20; i++) {
      expect(mintTraceId()).toMatch(UUID_V4);
    }
  });

});
