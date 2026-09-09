# Step 2 — `core/trace-context.js` AsyncLocalStorage Wrapper

**Owner:** NOVA (writes) · FELIX (validates)
**Estimated time:** 1 hour
**Blocks:** Steps 3-12
**Prerequisite:** Step 1 complete

---

## What this step delivers

A small, well-tested module that wraps Node's built-in `AsyncLocalStorage` to expose a simple API for setting and getting the trace context. Plus a propagation test harness that proves trace IDs survive every entry-point pattern AccessSync uses.

This module is the load-bearing primitive of the entire sprint. Everything else builds on it.

---

## Output files

- `core/trace-context.js` — the module
- `test/p3-data-integrity/trace-context.test.js` — unit + propagation tests
- `test/p3-data-integrity/trace-propagation.test.js` — integration tests across Express, BullMQ-style async boundaries, pg-pool callbacks

---

## Spec — `core/trace-context.js`

```javascript
/**
 * @file trace-context.js
 * @layer core/shared
 * @role logging-context
 * @exports runWith, setContext, getContext, getTraceId, getActor, mintTraceId
 * @dr DR-036
 *
 * Universal trace + actor context via AsyncLocalStorage.
 *
 * Set the context once at every entry point (Express middleware, BullMQ handler,
 * cron starter, internal API caller). It propagates automatically through every
 * `await` to every downstream `log.*()` call. Zero call-site changes required.
 *
 * Usage at entry point:
 *   const { runWith, mintTraceId } = require('./trace-context');
 *   runWith({ traceId: mintTraceId(), actor: { type: 'operator', id: req.admin.email } }, () => {
 *     // every log.* call inside this function (and any awaited descendants)
 *     // automatically picks up traceId + actor from the context
 *   });
 *
 * Usage at log call site:
 *   No change required. logger.js reads context internally.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const als = new AsyncLocalStorage();

/**
 * Run callback inside a new context. Any async descendants inherit it.
 * Nested runWith calls REPLACE the parent context (not merge).
 *
 * @param {Object} ctx
 * @param {string} ctx.traceId  - UUID v4 string
 * @param {Object} ctx.actor    - { type, id }
 * @param {Function} fn         - sync or async function to run inside the context
 * @returns whatever fn returns (Promise or value)
 */
function runWith(ctx, fn) {
  if (!ctx || !ctx.traceId) {
    throw new Error('runWith: ctx.traceId is required');
  }
  if (!ctx.actor || !ctx.actor.type || !ctx.actor.id) {
    throw new Error('runWith: ctx.actor.{type,id} is required');
  }
  // Validate actor.type is from allowlist
  const validActors = ['owner', 'operator', 'member', 'system', 'webhook'];
  if (!validActors.includes(ctx.actor.type)) {
    throw new Error(`runWith: actor.type must be one of ${validActors.join(', ')}, got ${ctx.actor.type}`);
  }
  return als.run({ traceId: ctx.traceId, actor: ctx.actor }, fn);
}

/**
 * Update the actor portion of the current context.
 * Trace ID is immutable once set — actor can change (e.g., after auth resolves).
 * No-op if no context is active.
 */
function setActor(actor) {
  const ctx = als.getStore();
  if (!ctx) return;
  ctx.actor = { type: actor.type, id: actor.id };
}

/**
 * Returns the full context object or undefined if none is active.
 */
function getContext() {
  return als.getStore();
}

/**
 * Returns the trace ID from the current context, or undefined.
 */
function getTraceId() {
  const ctx = als.getStore();
  return ctx ? ctx.traceId : undefined;
}

/**
 * Returns the actor from the current context, or undefined.
 */
function getActor() {
  const ctx = als.getStore();
  return ctx ? ctx.actor : undefined;
}

/**
 * Generate a new UUID v4 trace ID. Use this at every entry point.
 */
function mintTraceId() {
  return crypto.randomUUID();
}

module.exports = {
  runWith,
  setActor,
  getContext,
  getTraceId,
  getActor,
  mintTraceId,
};
```

---

## Spec — propagation test harness

`test/p3-data-integrity/trace-propagation.test.js`

The test harness verifies trace ID survives through every async boundary AccessSync uses. Per FAULT/STEEL C1 — this is the canary that catches ALS propagation breaks before they ship.

### Required test cases

```javascript
describe('[P3] Trace context propagates through every async boundary', () => {

  test('survives await/Promise chain', async () => {
    // runWith → await → await → getTraceId() === expected
  });

  test('survives setImmediate', async () => {
    // runWith → setImmediate(() => assert)
  });

  test('survives setTimeout (zero ms)', async () => {
    // runWith → setTimeout(..., 0) → assert
  });

  test('survives Promise.all', async () => {
    // runWith → Promise.all([fn1, fn2]) — both fns see traceId
  });

  test('survives async iteration (for-await-of)', async () => {
    // runWith → for await (...) → assert in body
  });

  test('survives pg-pool query callback', async () => {
    // Mock pg.Pool with a callback-style query
    // runWith → pool.query(sql, (err, res) => assertContextPresent)
  });

  test('survives pg-pool query Promise', async () => {
    // runWith → await pool.query(...) → assertContextPresent
  });

  test('survives nested runWith (child context replaces parent)', async () => {
    // runWith({A}) → runWith({B}, async () => assert getTraceId() === B.traceId)
    // → after inner returns, outer still sees A
  });

  test('absent outside runWith', async () => {
    // getTraceId() === undefined when no context active
  });

  test('mintTraceId returns valid UUID v4', () => {
    const id = mintTraceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  test('runWith rejects missing traceId', () => {
    expect(() => runWith({}, () => {})).toThrow();
  });

  test('runWith rejects invalid actor.type', () => {
    expect(() => runWith({ traceId: 'x', actor: { type: 'admin', id: 'y' } }, () => {})).toThrow();
  });

  test('setActor updates context mid-flight', async () => {
    // runWith({ actor: anonymous }) → setActor(authed) → getActor() reflects update
  });

  test('Express-style middleware chain preserves context', async () => {
    // Simulate: middleware mints context → next() → handler reads context
    // Use a mock Express request flow
  });

  test('BullMQ-style job handler reads passed traceId', async () => {
    // Simulate: enqueue job with payload.traceId → worker function reads payload.traceId
    //   → calls runWith({ traceId: payload.traceId, ... }, async () => { ... });
    // Verify trace propagates through the worker's async work
  });

});
```

These tests are NON-OPTIONAL. They are the C1 mitigation gate. If any test fails, NOVA fixes before declaring step 2 complete.

---

## FELIX validation checklist

- [ ] `core/trace-context.js` exports all six functions (`runWith`, `setActor`, `getContext`, `getTraceId`, `getActor`, `mintTraceId`)
- [ ] Front matter complete per protocol (`@file`, `@layer`, `@role`, `@exports`, `@dr`)
- [ ] All 14+ test cases pass
- [ ] No raw `console.*` calls (will be enforced by existing P3 test)
- [ ] `mintTraceId` returns RFC 4122 v4 UUID
- [ ] `runWith` validates inputs (traceId required, actor.type from allowlist)
- [ ] `actor.type` allowlist matches values in DR-036: `owner`, `operator`, `member`, `system`, `webhook`
- [ ] Context isolation verified — concurrent `runWith` calls don't leak between each other (run a 100x parallel test)

---

## Sign-off format

```
STEP 02 COMPLETE — core/trace-context.js + propagation test harness
- 14 test cases passing (Express, BullMQ, pg-pool, setImmediate, setTimeout, Promise.all, async iteration, nested context, isolation)
- Module exports verified
- Front matter complete
- DEPLOY SAFE: <90+N>/<90+N> (test count grew by N)
```

Update `00_SPRINT_PLAN.md`: Step 2 → 🟢
