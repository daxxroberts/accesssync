# Step 5 — BullMQ Job Handler Context Pass-Through

**Owner:** PARSE (verifies first) · NOVA (writes after PARSE clearance) · FELIX (validates)
**Estimated time:** 1 hour (after PARSE clearance — 24h SLA)
**Blocks:** Step 9 (route wiring depends on this for queue-bound work)
**Prerequisite:** Steps 2, 3 complete · PARSE clearance on AXIOM A1

---

## What this step delivers

A BullMQ job handler wrapper that reads `traceId` from the job payload and runs the job execution inside `runWith({ traceId, actor: { type: 'system', id: 'queue-worker' } }, ...)`. Every log call inside the job execution automatically carries the trace ID — connecting the inbound webhook trace to all downstream provisioning logs.

---

## PARSE pre-step — AXIOM A1 verification

Before NOVA writes a single line of step 5 code, PARSE verifies these three things and produces a finding with VERIFIED / PLAUSIBLE / UNRESOLVED status:

1. **AsyncLocalStorage context survives BullMQ worker process boundaries.** Specifically: when a job is enqueued from web request A (with ALS context X), and a separate worker process picks it up later, does the worker see context X automatically? **Expected answer: NO.** ALS is per-process. Workers are separate processes. PARSE confirms this is correct.

2. **The current AccessSync queue-worker pattern (passing traceId in job payload) is the correct pattern for BullMQ + ALS.** PARSE confirms the canonical pattern: the worker reads `job.data.traceId` and explicitly opens a `runWith` block at the top of the job handler.

3. **No exotic propagation pitfalls in the version of BullMQ AccessSync uses.** PARSE checks the BullMQ version in `package.json` and the changelog for any concurrency or context-related bugs in that version.

PARSE writes findings to `AccessSync/_Tools/parse_bullmq_als_findings.md` (KEEPER files).

If PARSE returns UNRESOLVED on any of the three: SAGE re-gates step 5 before NOVA writes code.

---

## Output files (after PARSE clearance)

- Updated `core/queue-worker.js` — wraps the existing job handler in `runWith`
- Updated `core/webhook-processor.js` — when enqueuing a job, includes `traceId` in payload (already does this; verify)
- Updated `core/retry-engine.js` — when re-enqueuing failed jobs, preserves original `traceId`

---

## Spec — `core/queue-worker.js` changes

### Current pattern (preserved)

The worker already reads `traceId` from job payload via `job.data.standardEvent.traceId`. The existing code creates a trace-scoped logger via `withTrace(traceId)`. Backward-compat preserved.

### New addition

At the top of the job processing function, wrap the existing logic in `runWith`:

```javascript
const { runWith } = require('./trace-context');

// Existing worker setup unchanged...

const worker = new Worker(QUEUE_NAME, async (job) => {
  const traceId = job.data?.standardEvent?.traceId || job.data?.traceId;

  // If somehow no traceId came through (shouldn't happen — webhook always mints one),
  // fail loud — we don't ship traceless jobs in production
  if (!traceId) {
    log.error('queue.job.missing_trace_id', { jobId: job.id, jobName: job.name });
    throw new Error('QUEUE_JOB_MISSING_TRACE_ID');
  }

  // Bind context for the entire job execution
  return runWith(
    { traceId, actor: { type: 'system', id: 'queue-worker' } },
    async () => {
      // EXISTING JOB BODY MOVES INSIDE THIS BLOCK UNCHANGED
      // All log.* calls within now auto-carry traceId
      // The existing withTrace() calls inside the body still work — they explicitly override
      return processJobBody(job);
    }
  );
}, { connection: redis, concurrency: 20 });
```

> **NOTE:** `processJobBody` is a refactor placeholder. The actual existing body of the worker stays — we just wrap it. Minimal-touch refactor.

### Webhook → queue traceId continuity (verify, no code change expected)

`adapters/wix/wix-connector.js` mints traceId for inbound webhook → passes to `webhook-processor` → enqueues in BullMQ payload. `core/webhook-processor.js` should already include `traceId` in `standardEvent`. Step 5 only adds the `runWith` wrapper in the worker; the producer side is verified working.

If the producer side is missing the traceId in payload — fix it here too. AXIOM gate.

### Retry engine — preserve original traceId

`core/retry-engine.js` re-enqueues failed jobs. Verify the re-enqueue includes the original `traceId` in the new job's payload. If not, fix:

```javascript
// In re-enqueue logic
await eventQueue.add(jobName, {
  ...originalJobData,
  traceId: originalJobData.traceId,  // explicit forward — don't lose on retry
  retryAttempt: (originalJobData.retryAttempt || 0) + 1,
}, queueOpts);
```

---

## Test cases — `test/p1-critical-path/queue-worker-trace.test.js`

```javascript
describe('[P1] queue-worker trace propagation', () => {

  test('worker reads traceId from job payload and binds to ALS', async () => {
    // Mock job: { data: { standardEvent: { traceId: 'aaa-...' } } }
    // Run worker handler
    // Inside the handler, getTraceId() should return 'aaa-...'
  });

  test('worker fails loud if traceId missing from payload', async () => {
    // Mock job with no traceId
    // Worker should throw QUEUE_JOB_MISSING_TRACE_ID
  });

  test('downstream log calls in job body inherit traceId', async () => {
    // Mock a job that calls log.info inside the body
    // Capture stdout
    // Assert log line contains the traceId from job payload
  });

  test('retry-engine preserves original traceId on re-enqueue', async () => {
    // Simulate a failed job re-enqueue
    // Verify the new job's payload contains the original traceId, not a new one
  });

  test('actor is system:queue-worker during job execution', async () => {
    // Run a job; assert getActor() returns { type: 'system', id: 'queue-worker' }
  });

  test('webhook → queue traceId continuity end-to-end', async () => {
    // Simulate webhook entry minting traceId X
    // Verify the enqueued job payload contains traceId X
    // Process the job, verify log lines from inside the worker contain traceId X
  });

});
```

---

## FELIX validation checklist

- [ ] PARSE finding `parse_bullmq_als_findings.md` filed and VERIFIED on all three questions
- [ ] `runWith` wraps the entire job body — no log calls inside the body fall outside the context
- [ ] Job fails loud (throws) if traceId missing — no silent system jobs in production
- [ ] Retry engine preserves original traceId
- [ ] All 6 test cases pass
- [ ] Existing P1 critical-path tests still pass (no regression on grant/revoke flow)
- [ ] DEPLOY SAFE: 90+N / 90+N

---

## Sign-off format

```
STEP 05 COMPLETE — BullMQ worker wraps jobs in runWith({ traceId from payload })
- PARSE finding: VERIFIED on all 3 ALS+BullMQ questions
- Worker enforces traceId-required on every job
- Retry engine preserves original traceId
- Webhook → queue continuity verified end-to-end
- 6 new tests passing, all P1 critical-path tests still green
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 5 → 🟢
