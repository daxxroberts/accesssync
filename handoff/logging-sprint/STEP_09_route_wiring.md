# Step 9 — Wire `recordActivity()` Into All Mutation Routes

**Owner:** NOVA (writes) · FELIX (validates)
**Estimated time:** 2 hours
**Blocks:** Steps 11, 12
**Prerequisite:** Steps 1-8 complete

---

## What this step delivers

Every POST/PATCH/DELETE route in `admin/routes/*.js` calls `recordActivity()` with the appropriate event name from EVENT_REGISTRY.md. Read routes (GET) get the auto-trace from middleware but do NOT write to activity_event (read-volume would dominate the table; reads are tracked in `webhook_log` / `diagnostic_log` if needed).

**Scope discipline:** Operator + admin mutation routes only in this step. Member-facing mutation routes (`admin/routes/multi-member.js`, sub-member portal endpoints) are scoped IN. Pure read endpoints, public health checks, and webhook endpoints are scoped OUT.

---

## Output files

Updated route files (no new files):
- `admin/routes/operator.js` — biggest file, ~30 mutation routes
- `admin/routes/clients.js` — ~10 routes (already partially uses `logAdminAction`, refactor to `recordActivity`)
- `admin/routes/auth.js` — login, logout, session events
- `admin/routes/members.js` — debug center retry actions
- `admin/routes/errors.js` — error queue mutations (dismiss, retry)
- `admin/routes/multi-member.js` — sub-member CRUD
- `admin/routes/portal.js` — Wix portal session events
- `admin/routes/queue.js` — queue mutation actions
- `admin/routes/webhooks.js` — webhook inspector mutations (if any)

Plus new tests:
- `test/p2-onboarding/route-activity.test.js`

---

## Wiring pattern

Every mutation route follows this template:

```javascript
const { recordActivity } = require('../middleware/activity');

router.patch('/:clientId/plan-mappings/:mappingId', async (req, res) => {
  const { clientId, mappingId } = req.params;
  const { removeGroupId } = req.body;
  try {
    // ... existing logic ...

    if (removeGroupId) {
      // Existing DB writes
      // ...

      // NEW — log the activity
      await recordActivity(req, 'mapping.group.removed', {
        targetType: 'plan_mapping',
        targetId: mappingId,
        clientId,
        diff: {
          before: { groupIds: oldGroupIds },
          after: { groupIds: newGroupIds },
        },
        result: 'success',
      });

      return res.json({ ok: true });
    }
    // ... rest of handler ...
  } catch (err) {
    // NEW — log the failure
    await recordActivity(req, 'mapping.update', {
      targetType: 'plan_mapping',
      targetId: mappingId,
      clientId,
      result: 'failure',
      diff: { error: err.message },  // err.message will be redacted if it contains a secret
    });
    log.error('operator.mapping.patch_failed', { clientId, mappingId }, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

Key rules:
1. **Action name MUST exist in EVENT_REGISTRY.md.** If the route emits a new action, AXIOM-gated PR adds it to the registry first.
2. **Failure paths log too** — every catch block that returns 4xx/5xx writes a `result: 'failure'` activity row.
3. **`diff.before` and `diff.after`** for every mutation. For deletes, `diff.before` = the deleted record summary (NO PII), `diff.after` = null.
4. **Never await blocking** — `recordActivity` is fire-and-forget internally; don't wrap it in a try/catch that depends on completion.

---

## Route-by-route inventory (NOVA produces this list while wiring)

NOVA produces a checklist as part of step 9 — every route file scanned, every mutation handler tagged with its event name. Format:

```markdown
# Route Activity Wiring Inventory

## admin/routes/operator.js

| Method | Path | Event Name | Status |
|--------|------|------------|--------|
| PATCH  | /:clientId/plan-mappings/:mappingId (removeGroupId branch) | mapping.group.removed | ✅ |
| PATCH  | /:clientId/plan-mappings/:mappingId (addGroupId branch) | mapping.group.added | ✅ |
| PATCH  | /:clientId/plan-mappings/:mappingId (status change) | mapping.activated / mapping.deactivated | ✅ |
| POST   | /:clientId/plan-mappings/:mappingId/remap | mapping.members.remapped | ✅ |
| POST   | /:clientId/sync | client.sync.triggered | ✅ |
| POST   | /:clientId/errors/:errorId/dismiss | error.dismissed | ✅ |
| POST   | /:clientId/locations | location.created | ✅ |
| PATCH  | /:clientId/locations/:locationId | location.updated | ✅ |
| POST   | /:clientId/locations/:locationId/suspend | location.suspended | ✅ |
| POST   | /:clientId/locations/:locationId/activate | location.activated | ✅ |
| ...continue for all routes...
```

This inventory is filed at `handoff/logging-sprint/route-wiring-inventory.md` so future audits can verify completeness.

---

## Test cases — `test/p2-onboarding/route-activity.test.js`

```javascript
describe('[P2] Route activity wiring', () => {

  test('PATCH /plan-mappings (removeGroupId) writes mapping.group.removed', async () => {
    // Authenticate as operator
    // Make a real PATCH request
    // SELECT * FROM activity_event WHERE trace_id = res.headers['x-trace-id']
    // Assert one row with action='mapping.group.removed', diff has before.groupIds and after.groupIds
  });

  test('Failed mutations write activity_event with result=failure', async () => {
    // Force a route to fail (invalid input)
    // Verify activity_event row with result='failure'
  });

  test('Read routes do NOT write activity_event', async () => {
    // GET request → activity_event count unchanged
  });

  test('Diff redaction works end-to-end', async () => {
    // PATCH a route that touches an api_key field
    // Verify stored diff has '[REDACTED]'
  });

  test('Two parallel mutations get distinct trace IDs', async () => {
    // Promise.all([req1, req2]) → activity_event has 2 rows with different trace_ids
  });

  test('All routes in route-wiring-inventory.md are exercised', async () => {
    // Meta-test: read inventory, assert every row has at least one corresponding test in the suite
    // Mark this as DR-036 acceptance criteria
  });

});
```

---

## FELIX validation checklist

- [ ] `route-wiring-inventory.md` produced and reviewed
- [ ] Every mutation handler in scope has a `recordActivity()` call (verify by grep — every `router.post`, `router.patch`, `router.delete` in scoped files has at least one `recordActivity` call in its body)
- [ ] Every event name used in route handlers exists in `EVENT_REGISTRY.md`
- [ ] Failure paths log too — verify by inspection that every `catch` block in mutation routes has a `recordActivity` with `result: 'failure'`
- [ ] No PII or secrets leak into `diff` payloads (verify with a grep + manual review of diff construction patterns)
- [ ] All 6 test cases pass
- [ ] DEPLOY SAFE: 90+N / 90+N
- [ ] Manual smoke: trigger Daxx's exact disconnect-wire scenario from the original session → verify `SELECT * FROM v_trace_timeline WHERE trace_id = X` returns the full ordered story including the activity_event row

---

## Sign-off format

```
STEP 09 COMPLETE — All operator/admin/member-portal mutation routes wired
- N routes wired across 9 files (see route-wiring-inventory.md)
- All event names match EVENT_REGISTRY.md
- Success + failure paths both write activity rows
- Daxx's original disconnect scenario reproduced — full v_trace_timeline story verified
- 6 new tests passing
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 9 → 🟢
