# Step 10 — Legacy Backfill: Add `setContext` to `core/` and `adapters/` Log Emitters

**Owner:** NOVA (writes) · FELIX (validates)
**Estimated time:** 1 hour
**Blocks:** Step 11
**Prerequisite:** Steps 2, 3 complete (can run anytime after step 3, parallel with 7-9)

---

## What this step delivers

Audit every `log.*()` call in `core/` and `adapters/` and confirm the calling code path opens an ALS context (`runWith` block) somewhere upstream. For paths that don't (currently very few — most are reachable only via webhook or queue, which already have context), add appropriate `runWith` wrapper at the entry point with `actor: { type: 'system', id: '<module-name>' }`.

This is mostly a verification step. By design (post step 4), every web request and queue job already opens a context. This step exists to catch the corner cases.

---

## Output: Inventory file

`handoff/logging-sprint/legacy-emitter-audit.md`

NOVA produces an audit table:

```markdown
# Legacy Emitter Audit

For every file in core/ and adapters/ that imports `log` from logger.js,
trace the call paths backward and document which entry point opens the ALS context.

| File | Function | Entry Point | Context Source | Action Required |
|------|----------|-------------|----------------|-----------------|
| core/grant-revoke.js | processGrant() | queue-worker.js | runWith in worker (step 5) | None — covered |
| core/grant-revoke.js | processRevoke() | queue-worker.js | runWith in worker (step 5) | None — covered |
| core/standard-adapter.js | resolveAndLock() | queue-worker.js | runWith in worker (step 5) | None — covered |
| core/reconciliation.js | * | cron starter | runWith in cron (step 6) | None — covered |
| core/hardware-health-check.js | * | cron starter | runWith in cron (step 6) | None — covered |
| core/hmac-monitor.js | recordFailure() | wix-connector | runWith via Express middleware (step 4) | None — covered |
| core/tenant-resolver.js | registerSiteId() | wix-connector | runWith via Express middleware (step 4) | None — covered |
| core/wix-plans-api.js | * | admin/routes/* OR cron | runWith via Express middleware OR cron starter | None — covered |
| adapters/kisi/kisi-connector.js | * | called from kisi-adapter | inherits caller context | None — covered |
| adapters/wix/wix-members-api.js | * | called from member-sync-api / standard-adapter | inherits caller context | None — covered |
| ... continue for every file ... |
```

If any row says `Action Required: yes` → NOVA adds the appropriate fix in step 10.

---

## Common edge cases to check

1. **Module load-time logs** — `log.info('module.loaded', ...)` at the top of a file runs outside any context. ACCEPTABLE — these are infrastructure events, not request events. Mark in audit as `Action Required: none — load-time event`.

2. **Promise/setTimeout escapes that aren't awaited** — `setTimeout(() => log.info(...), 1000)` outside `runWith` will lose context. Audit grep for `setTimeout`/`setInterval`/`setImmediate` outside test files. Fix any found.

3. **Process-level handlers** — `process.on('uncaughtException', err => log.critical(...))` runs outside any request context. ACCEPTABLE — these are by definition system-level events. Open a fresh `runWith({ traceId: mintTraceId(), actor: { type: 'system', id: 'process-error-handler' } })` inside the handler so the trace is at least self-contained.

4. **Background workers spawned manually** — none currently exist in AccessSync (only Express + BullMQ + cron). Verify nothing has been added since this audit.

---

## Specific fix needed: process-level error handlers

In `server.js` and `admin/server.js`:

```javascript
// CURRENT
process.on('uncaughtException', (err) => {
  log.critical('admin.uncaught_exception', {}, err);
});
process.on('unhandledRejection', (reason) => {
  log.critical('admin.unhandled_rejection', { reason: String(reason) });
});

// AFTER STEP 10
const { runWith, mintTraceId } = require('./core/trace-context');

process.on('uncaughtException', (err) => {
  runWith(
    { traceId: mintTraceId(), actor: { type: 'system', id: 'process-error-handler' } },
    () => log.critical('admin.uncaught_exception', {}, err)
  );
});
process.on('unhandledRejection', (reason) => {
  runWith(
    { traceId: mintTraceId(), actor: { type: 'system', id: 'process-error-handler' } },
    () => log.critical('admin.unhandled_rejection', { reason: String(reason) })
  );
});
```

The fresh trace ID is fine — there's no upstream trace to inherit at this point because the error already escaped the request context.

---

## Test cases

```javascript
describe('[P3] legacy emitter context coverage', () => {

  test('every log.* call in core/ runs inside ALS context (smoke test)', async () => {
    // Import all core/ modules
    // For each function exported, verify it's either:
    //   (a) only called from a known context-opening entry point, OR
    //   (b) has its own internal runWith wrapper
    // This is enforced by the audit table — test checks audit completeness
  });

  test('uncaughtException handler opens fresh runWith', async () => {
    // Spawn a child process
    // Throw an uncaught exception
    // Read stdout
    // Assert log line has trace_id and actor_type='system' actor_id='process-error-handler'
  });

  test('unhandledRejection handler opens fresh runWith', async () => {
    // Same as above for unhandledRejection
  });

  test('audit file is complete', () => {
    // Read legacy-emitter-audit.md
    // Verify every file in core/ and adapters/ that imports `log` has a row in the audit
    // Use grep to enumerate logger imports
  });

});
```

---

## FELIX validation checklist

- [ ] `legacy-emitter-audit.md` complete — every file in core/ and adapters/ with a logger import is documented
- [ ] All rows marked `Action Required: yes` are actually fixed (verify by grep — every file mentioned has the fix applied)
- [ ] `uncaughtException` and `unhandledRejection` handlers wrapped in `runWith` on both `server.js` and `admin/server.js`
- [ ] No `setTimeout`/`setInterval` calls in production code that emit logs without context
- [ ] All 4 test cases pass
- [ ] DEPLOY SAFE: 90+N / 90+N

---

## Sign-off format

```
STEP 10 COMPLETE — Legacy emitter audit + fixes
- Audit file: <file count> files documented, <fix count> fixes applied
- Process-level error handlers wrapped in runWith on both servers
- 4 new tests passing
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 10 → 🟢
