# Step 11 — Full Validation + Performance Benchmark

**Owner:** FELIX (validates) · NOVA (benchmark)
**Estimated time:** 1 hour
**Blocks:** Step 12
**Prerequisite:** Steps 1-10 complete

---

## What this step delivers

The final pre-ship validation pass. FELIX confirms:
1. 100% of test suites passing (P1, P2, P3 tiers)
2. ALS performance overhead within bounds (E4 mitigation)
3. End-to-end smoke test on Railway dev — Daxx's exact disconnect scenario produces a complete trace
4. No breaking changes to existing routes / behaviors
5. KEEPER vault is current

---

## Validation activities

### 1. Test suite — DEPLOY SAFE

```bash
npm run test:deploy
```

Required result: `DEPLOY SAFE — All business-critical scenarios passing`

Expected count: original 90 tests + ~50 new tests across steps 1-10 = ~140 tests. All passing.

### 2. Performance benchmark (E4 mitigation)

NOVA runs a benchmark comparing pre-sprint and post-sprint latency on three representative routes:

| Route | Pre-sprint p95 | Post-sprint p95 | Overhead | Acceptable? |
|---|---|---|---|---|
| GET /admin/errors (read, no DB writes beyond pagination) | <baseline> | <new> | <delta> | <Y/N> |
| PATCH /operator/:c/plan-mappings/:m (single-group add) | <baseline> | <new> | <delta> | <Y/N> |
| Webhook end-to-end (HMAC verify → enqueue → dequeue → grant → log) | <baseline> | <new> | <delta> | <Y/N> |

**Acceptance criteria:** p95 overhead under 10ms per route. If exceeded, NOVA scopes back ALS use to per-request rather than per-await chain (engineering judgment call, SAGE consults).

Benchmark methodology:
- 1000 requests per route
- Sequential requests, single client
- Measure server-side time only (not network)
- Run on a Railway-equivalent environment (use Railway preview deploy)

### 3. End-to-end smoke test — reproduce the original incident

Manually reproduce the bug Daxx reported on 2026-04-27:

1. Open `/plan-mapping?clientId=15962eac-c767-46ad-8056-094f35a4a193`
2. Toggle to New UI
3. Click the X on a Couples wire
4. Capture the `x-trace-id` from the response header

Then query:

```sql
SELECT * FROM v_trace_timeline WHERE trace_id = '<captured-trace-id>' ORDER BY ts;
```

Expected output: an ordered list including:
- `webhook` events if any fired (none expected for a UI-only mutation)
- `activity` events: `mapping.group.removed` with diff
- `diagnostic` events if any warnings fired
- `member_access` events if any members were affected

The query must return at least the `activity` row showing exactly what was clicked, by whom, with what diff.

LENS captures evidence: screenshot of UI action + screenshot of query result + the trace ID linking them.

### 4. Regression sweep

FELIX runs through the full route catalog and verifies:

- [ ] `npm run test:deploy` → DEPLOY SAFE
- [ ] `curl -i https://accesssync-admin.up.railway.app/health` → 200 + `x-trace-id` header
- [ ] Owner login flow works (JWT cookie issued, dashboard loads)
- [ ] Operator dashboard loads at `/dashboard`
- [ ] Plan-mapping page loads at `/plan-mapping?clientId=...`
- [ ] Webhook ingestion still processes (use `migrations/observability-trace-id.sql` test webhook if available, or trigger a Wix sandbox event)
- [ ] Member sync status page loads at `/sync-status?memberId=...`
- [ ] Multi-member endpoints respond
- [ ] Onboarding flow at `/onboard?invite=...` completes through System Check
- [ ] Reconciliation cron runs cleanly (manual trigger via `node core/reconciliation.js` in dev)
- [ ] Hardware health check cron runs cleanly

### 5. KEEPER vault audit

KEEPER confirms:
- [ ] DR-036, DR-037, DR-038 filed with correct status (locked / locked / locked)
- [ ] `Observability_Architecture.md` final version in vault
- [ ] `Logger_Trace_Context.md` final version in vault
- [ ] `Data_Model.md` reflects schema additions and `activity_event` table and `v_trace_timeline` view
- [ ] `STANDARDS.md` has the Logging domain entry
- [ ] `open_items.md` has OB-LOG-01 and OB-LOG-02 entries
- [ ] `KB_FILE_REGISTRY.md` and `VAULT_SUBSTANCE_MAP.md` updated for all new vault files
- [ ] `changelog.md` has the sprint-close entry

---

## FELIX final report — required format

```markdown
# FELIX Validation Report — Logging Foundation Sprint
Date: 2026-MM-DD

## Test Suite
- DEPLOY SAFE: <count>/<count> ✅

## Performance Benchmark
| Route | Pre p95 | Post p95 | Overhead | Pass? |
|---|---|---|---|---|
| ... | ... | ... | ... | ✅ |

Overall: <PASS / FAIL — within 10ms p95 budget>

## End-to-End Smoke
- Reproduction: Daxx's 2026-04-27 disconnect scenario
- Trace ID captured: <uuid>
- v_trace_timeline rows returned: <count>
- Evidence: <link to LENS report>
- Result: ✅ Full story reconstructed via single query

## Regression Sweep
- 11/11 manual checks passing
- No prior functionality broken

## KEEPER Vault
- 8/8 audit items complete

## Recommendation
✅ READY TO SHIP — all acceptance criteria met
```

If any item fails: FELIX writes a deficiency list, NOVA fixes, FELIX re-runs. Step 12 does not begin until the report is fully ✅.

---

## Sign-off format

```
STEP 11 COMPLETE — Full validation report attached
- All test suites: DEPLOY SAFE
- Performance: within p95 budget
- End-to-end smoke: trace reconstructed for original bug scenario
- Regression: clean
- KEEPER vault: current
- READY FOR SAGE SHIP GATE
```

Update `00_SPRINT_PLAN.md`: Step 11 → 🟢
