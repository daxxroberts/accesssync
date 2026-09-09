# Step 7 — `admin/middleware/activity.js` Universal Activity Logger

**Owner:** NOVA (writes) · AXIOM (reviews redaction & schema)
**Estimated time:** 2 hours
**Blocks:** Step 9 (route wiring depends on this helper)
**Prerequisite:** Steps 1-6 complete · Day-1 checkpoint passed

---

## What this step delivers

A single helper function `recordActivity()` that any mutation route calls to write a row to `activity_event`. Reads trace + actor from ALS automatically. Applies redaction. Fire-and-forget — never blocks the user-facing route. This is the API every operator/admin/member-portal mutation will use in step 9.

---

## Output files

- `admin/middleware/activity.js` — new module
- `test/p3-data-integrity/activity-recorder.test.js`

---

## Spec — `admin/middleware/activity.js`

```javascript
/**
 * @file activity.js
 * @layer admin/middleware
 * @role audit-recording
 * @writes activity_event
 * @reads ALS trace context
 * @calls core/trace-context, core/log-redaction
 * @dr DR-036, DR-038
 *
 * Universal activity logger.
 *
 * Every mutation route in admin/operator/member-portal calls recordActivity()
 * to leave an audit trail in activity_event. Reads trace + actor from ALS,
 * applies redaction to the diff, fire-and-forget DB write.
 *
 * Usage:
 *   await recordActivity(req, 'mapping.group.removed', {
 *     targetType: 'plan_mapping',
 *     targetId: mappingId,
 *     diff: { before: { groupIds: oldIds }, after: { groupIds: newIds } },
 *     result: 'success',
 *   });
 *
 * Failure mode: never throws to caller. Failure to record is logged via log.warn
 * but does not fail the user's action.
 */

'use strict';

const db = require('../../db');
const { log } = require('../../core/logger');
const { getTraceId, getActor } = require('../../core/trace-context');
const { redact } = require('../../core/log-redaction');

/**
 * @param {Object} req - Express request (used for client_id derivation + request_meta)
 * @param {string} action - dot-namespaced event name (must be in EVENT_REGISTRY.md)
 * @param {Object} options
 * @param {string} options.targetType - 'plan_mapping' | 'member' | 'location' | 'client' | etc.
 * @param {string} [options.targetId]
 * @param {Object} [options.diff] - { before, after } — both fields run through redact()
 * @param {string} [options.result] - 'success' | 'failure' | 'rejected' (default 'success')
 * @param {string} [options.clientId] - explicit override; defaults to req-derived
 */
async function recordActivity(req, action, options = {}) {
  const traceId = getTraceId();
  const actor = getActor();

  if (!traceId || !actor) {
    // Means the trace middleware didn't run — programmer error
    log.warn('activity.no_context', { action, hasTraceId: !!traceId, hasActor: !!actor });
    return;
  }

  const clientId = options.clientId
    || req.params?.clientId
    || req.admin?.clientId
    || req.body?.clientId
    || null;

  const requestMeta = {
    method: req.method,
    path: req.originalUrl || req.path,
    ip: req.ip,
    user_agent: req.headers['user-agent'] || null,
  };

  const safeDiff = options.diff ? redact(options.diff) : null;

  // Fire-and-forget — never block the request
  setImmediate(() => {
    db.query(
      `INSERT INTO activity_event
       (trace_id, client_id, actor_type, actor_id, action, target_type, target_id, result, diff, request_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        traceId,
        clientId,
        actor.type,
        actor.id,
        action,
        options.targetType || null,
        options.targetId || null,
        options.result || 'success',
        safeDiff ? JSON.stringify(safeDiff) : null,
        JSON.stringify(requestMeta),
      ]
    ).catch((err) => {
      log.warn('activity.write_failed', { action, traceId }, err);
    });
  });
}

module.exports = { recordActivity };
```

---

## Test cases

```javascript
describe('[P3] activity recorder', () => {

  test('writes row with trace + actor from ALS', async () => {
    // runWith({ traceId: 'X', actor: ... }, async () => {
    //   await recordActivity(mockReq, 'test.event', { targetType: 't', targetId: 'id' });
    // })
    // Wait for setImmediate flush
    // SELECT * FROM activity_event WHERE trace_id = 'X' → row exists with actor populated
  });

  test('redacts sensitive fields in diff', async () => {
    // recordActivity(req, 'config.api_key.rotated', {
    //   diff: { before: { hardware_api_key: 'real' }, after: { hardware_api_key: 'new' } }
    // })
    // Verify stored diff contains '[REDACTED]'
  });

  test('does not throw when no ALS context active', async () => {
    // Call recordActivity outside runWith → returns silently, emits log.warn
  });

  test('does not block caller on DB failure', async () => {
    // Mock db.query to reject
    // Caller awaits recordActivity → completes immediately
    // log.warn 'activity.write_failed' eventually fires
  });

  test('captures request metadata', async () => {
    // Verify request_meta contains method, path, ip, user_agent
  });

  test('clientId derivation order: explicit → params → admin → body', async () => {
    // Test each fallback layer
  });

  test('result defaults to success', async () => {
    // recordActivity without result → row has result='success'
  });

  test('accepts result=failure for failed mutations', async () => {
    // Test the failure-result path used by error handlers
  });

});
```

---

## AXIOM review checklist

AXIOM gates step 7 before NOVA marks complete. Specifically:

- [ ] Every field in `request_meta` is reviewed for PII risk. `user_agent` can be considered ephemeral; `ip` is borderline-PII per GDPR but operationally necessary for audit. AXIOM rules: include both, document in DR-038 that IP is captured for audit purposes only.
- [ ] `diff` redaction runs on both `before` and `after` halves
- [ ] `clientId` derivation order is documented and matches actual route patterns in the codebase
- [ ] Action names used in tests match the format pattern `domain.subject.verb` (e.g. `mapping.group.removed`, `member.access.granted`) — locks taxonomy for step 8

---

## FELIX validation checklist

- [ ] Module exports `recordActivity`
- [ ] All 8 tests pass
- [ ] Front matter complete with `@dr DR-036, DR-038`
- [ ] No raw `console.*`
- [ ] DEPLOY SAFE: 90+N / 90+N
- [ ] Manual test: trigger one operator mutation route in dev → verify row appears in `activity_event` with all expected fields

---

## Sign-off format

```
STEP 07 COMPLETE — admin/middleware/activity.js + recordActivity helper
- AXIOM gate: passed (PII redaction reviewed, IP capture documented in DR-038)
- 8 tests passing
- Fire-and-forget pattern verified — never blocks caller
- Manual smoke test against Railway dev: <link to evidence>
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 7 → 🟢
