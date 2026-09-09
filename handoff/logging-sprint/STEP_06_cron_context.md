# Step 6 — Cron Starters: Trace Context at Process Start

**Owner:** NOVA (writes) · FELIX (validates)
**Estimated time:** 30 minutes
**Blocks:** Step 11
**Prerequisite:** Steps 2, 3 complete

---

## What this step delivers

The two Railway cron jobs (`reconciliation.js` and `hardware-health-check.js`) mint a fresh trace ID at process start and run their entire body inside a `runWith` block. Every log emitted by the cron run shares one trace ID, so `SELECT * FROM v_trace_timeline WHERE trace_id = X` returns the full nightly sweep as a single ordered story.

---

## Output files

- Updated `core/reconciliation.js`
- Updated `core/hardware-health-check.js`
- `test/p3-data-integrity/cron-trace.test.js`

---

## Spec — `core/reconciliation.js` changes

### Current state

Already uses `withTrace(sweepTraceId)` per existing code. Refactor to use `runWith` so the trace propagates automatically to every downstream log call without explicit `sweepLogger.info(...)` calls.

### Required change

```javascript
const { runWith, mintTraceId } = require('./trace-context');

// At the entry point of the cron body:
async function runReconciliation() {
  const traceId = mintTraceId();
  return runWith(
    { traceId, actor: { type: 'system', id: 'reconciliation-cron' } },
    async () => {
      log.info('reconciliation.start', { traceId });
      // EXISTING BODY UNCHANGED — every log.* automatically carries traceId now
      // ...
      log.info('reconciliation.complete', { duration_ms: Date.now() - startedAt });
    }
  );
}
```

Existing `withTrace` calls inside the body can be removed (auto-context handles it) OR left in place (explicit override still works — backward compat). Per RULE-15 (don't half-finish refactors), NOVA removes them in this step. AXIOM gate.

---

## Spec — `core/hardware-health-check.js` changes

Same pattern. Wrap the cron body in `runWith` with `actor = { type: 'system', id: 'hardware-health-check-cron' }`.

```javascript
const { runWith, mintTraceId } = require('./trace-context');

async function runHealthCheck() {
  const traceId = mintTraceId();
  return runWith(
    { traceId, actor: { type: 'system', id: 'hardware-health-check-cron' } },
    async () => {
      // EXISTING BODY UNCHANGED
    }
  );
}
```

---

## Test cases — `test/p3-data-integrity/cron-trace.test.js`

```javascript
describe('[P3] cron jobs run inside trace context', () => {

  test('reconciliation cron mints traceId and binds actor', async () => {
    // Spy on log.info or stdout
    // Invoke runReconciliation
    // Verify all emitted logs share one traceId and actor=system:reconciliation-cron
  });

  test('hardware-health-check cron mints traceId and binds actor', async () => {
    // Same as above for runHealthCheck
  });

  test('two concurrent cron runs do not share trace IDs', async () => {
    // Run both crons in parallel
    // Verify their log streams have distinct traceIds (no leakage)
  });

  test('cron logs land in diagnostic_log with correct actor', async () => {
    // Trigger a warn/error inside the cron
    // SELECT trace_id, actor_type, actor_id FROM diagnostic_log WHERE trace_id = ...
    // Assert actor_type='system' actor_id='reconciliation-cron' (or 'hardware-health-check-cron')
  });

});
```

---

## FELIX validation checklist

- [ ] Both cron starters wrap their body in `runWith`
- [ ] `actor.id` matches the cron name (used by ops queries to filter)
- [ ] Existing `withTrace` calls inside cron bodies are either removed (preferred) or kept consistently
- [ ] All 4 test cases pass
- [ ] Run the cron once locally / in dev mode and visually inspect stdout — every line shares one traceId
- [ ] DEPLOY SAFE: 90+N / 90+N

---

## Sign-off format

```
STEP 06 COMPLETE — cron starters wrapped in runWith
- reconciliation-cron: actor=system:reconciliation-cron, fresh traceId per run
- hardware-health-check-cron: actor=system:hardware-health-check-cron, fresh traceId per run
- Concurrent isolation verified
- 4 tests passing
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 6 → 🟢

---

## ⚠️ Day-1 Checkpoint trigger

After step 6 completes, REX runs the Day-1 Checkpoint Protocol (see `00_SPRINT_PLAN.md` § Day-1 Checkpoint). Steps 7-12 do not begin until the checkpoint passes.
