# SAGE decision log — fix round after the full BOT review (2026-10-05)

Daxx gave SAGE standing authority for this round: decide, implement, keep moving; anything that needs Daxx's answer is
**parked below** and work continues on something else. Hard limits SAGE kept: nothing merged, nothing deployed, no
production data written (Tier 4), no subagent commits (main session is the sole committer, RULE-19).

Branch: `claude/error-visibility-actions`. Review that produced this list: see the SAGE ruling in chat and
`handoff/OWNER_PANEL_REVIEW_2026-10-03.md`.

## Decisions made (SAGE)

| # | Decision | Why |
|---|---|---|
| D1 | A Kisi 422 "unknown" is **AccessSync support's** from the first occurrence. The gym is no longer told to check the member's email/name. | AXIOM verified AccessSync never sends Kisi a name; the live 422s are on `POST /role_assignments` with no reason given. Telling the gym to fix a profile was a false claim. |
| D2 | `core/error-guidance.js` returns `retry: now / after_fix / none` (plus `retryHelps`). Server guards, page, drawer, email and panel all use it. | One source of truth, so the page, email and panel cannot contradict each other. |
| D3 | HTTP status decides "temporary": 5xx/429/network = temporary (nobody acts, Retry works); any 4xx = refused, AccessSync-owned, no Retry. | The connector files every unlisted status (400/405/409) under `HARDWARE_API_ERROR`, which the old guidance called "temporary" and "will retry" — false, a 4xx is dead-lettered on attempt 1. |
| D4 | Removals (revoke jobs) are never offered Retry and never told to press it. | The server refuses revoke retries (`admin/routes/errors.js`), so the button was a dead end. |
| D5 | A 404 on a payment suspend/enable or a removal means "the member's door account is missing", not "door group deleted". | Sending the gym to Plan Mapping for a deleted Kisi user was wrong. |
| D6 | Repeat failure of the same (client, member, code) **never re-emails** and a row resolved in the last 24h is **re-opened** instead of duplicated. | `handleFailure` emailed on every dedupe hit (the "skip duplicate email" return only exited the row write); Mark-resolved / Retry then re-alerted every sweep. |
| D7 | Email throttle: at most one alert email per (client, error cause) per hour. | One rotated Kisi key would otherwise send one email per affected member. |
| D8 | AccessSync-owned errors also email the AccessSync owner (`ACCESSSYNC_OWNER_NOTIFICATION_EMAIL`) when it differs from the client's contact. | The gym's email says "AccessSync support will look into it" but only the gym was being told; the owner only found out by opening the panel. |
| D9 | An operator cannot "Mark resolved" an AccessSync-owned error; only the owner can. | Chad dismissing it turned Daxx's panel green while the member was still locked out. |
| D10 | "Retry all active" retries only rows where Retry can help or the gym's fix is done; it reports how many it left alone and never marks them resolved. | It silently closed rows that fail again. |

| D11 | The seat-release flag (DR-051) is read **per Wix order**, in both reconcile Pass 1 and step 3A. A re-purchase (new order, no billing row yet) starts seated. | FELIX: reading the newest row across all of a plan's orders applied an old order's "released" flag to a new purchase and could lock out someone who paid. Order ids are the same id space for webhook and REST-backfilled billing rows. Without an order id (bookings) it falls back to the plan-wide read. |
| D12 | An **unrecognised** error (no code, no refused HTTP status) is AccessSync-owned but offers Retry **once**; repeats (5+) stop offering it. | Refusing Retry on every unknown error blocked exactly the one-offs where Retry works (LENS). Known refused classes (4xx, Kisi 422) still refuse. |
| D13 | The unverified `x-accesssync-client-id` header of a webhook whose signature FAILED is never stored as a log row's client (hmac events carry it only as free text `clientHint`); the owner alert email no longer links to it. | NOVA: anyone could put warnings on another gym's log and trigger spike alerts for it. |
| D14 | The nightly sweep's own trace (actor `reconciliation-*`) never falls back to `trace_context` for its client. | One sweep trace spans every client; its trace_context client is whichever job registered it first → wrong-tenant stamp once there are two clients. |
| D15 | Owner-panel verdict rules: "setting up" only for a client with **no history**; an established client missing key/location is **red** with its checks shown; suspended/cancelled clients are neutral "inactive"; a complete new client gets 72h (first sale) / 24h (first sync) grace; "clears by itself" errors older than 24h count as AccessSync's; a failed diagnostics query is red, not green. | FELIX/FAULT/LENS: the old rule hid real errors behind "setup stalled", showed quiet new gyms red, and left self-clearing items amber forever. |
| D16 | `POST /users` 409 ("user already exists") is logged at warn (recoverable), like the role-assignment 409. | ~18 a day recovered by the adapter were ERROR rows that kept House of Gains' Diagnostics card amber from day one (AXIOM/FAULT). |
| D17 | New clients (Wix install and owner-created) are created with `reconciliation_interval='6h'`. | The column default `'daily'` plus a gate that reads the most recently synced client's interval could stretch every client's sync to 24h and trip the reconcile thresholds (AXIOM). |
| D18 | `errors.ejs` accepts only a uuid `clientId` from the address bar; the "who needs to act" label says "The gym needs to act" when the AccessSync owner is viewing. | Existing XSS via an unescaped single quote (NOVA); the owner is not "you, the gym" (LENS). |
| D19 | The incident drawer, the errors page and the operator email all take Retry / Mark resolved / "Action needed" from the guidance. Operator-side Retry and dismiss are guarded on the server (nothing queued / 409), not only hidden in the UI. | LENS: three screens contradicted each other; UI-only hiding can be bypassed. |

### Process note
SAGE did **not** merge or deploy, wrote nothing to production, and made no change to House of Gains data. Tests: the new
retry-engine test (`test/p1-critical-path/retry-engine-dead-letter.test.js`) fails on the old engine (10 of 19), as do the
4xx dead-letter, seat-per-order, sweep-trace and forged-header tests.

## Parked — needs Daxx (work continued without them)

| # | Question / action | Why it needs Daxx | SAGE's default meanwhile |
|---|---|---|---|
| P1 | Is `ACCESSSYNC_OWNER_NOTIFICATION_EMAIL` set in Railway (Core Engine **and** Admin Hub)? | Env vars are not visible from the sandbox. If unset, the owner copy of AccessSync-owned alerts and the nightly digest are silently skipped. | Code skips quietly when unset; the panel still shows the error. |
| P2 | House of Gains' `notification_email` is **Daxx's** address, not Chad's. Should Chad also get failure emails? | Business choice; also a data change on the client row (Tier 4). | Unchanged: Daxx gets them. |
| P3 | Customer #2 onboarding: do you pre-create the client in the owner panel before installing the app, or only install? | Decides whether to build "unclaimed install / duplicate client" protection. | Install path creates the client itself (works either way); pre-creating can produce two clients for one gym. |
| P4 | Should a later successful grant **auto-resolve** the member's open error row? | It writes `error_queue` automatically in the grant path (behaviour change on the critical path). | Not built. Self-clearing rows count as AccessSync's after 24h so they cannot sit amber forever. |
| P5 | Pre-merge: confirm the deploy plan — merge, Admin Hub first (or both together), then the post-deploy check below. | Merging deploys. | Nothing merged. |

**Post-deploy check (for whoever merges):** after the first sweep (about 5 minutes after Admin Hub boots), `SELECT count(*) FROM error_queue WHERE status='failed'` should be **0**. One row means the known stuck member: do not Retry or dismiss it repeatedly.

## Problems detected and logged for next time

| # | Finding | Severity | Notes |
|---|---|---|---|
| L1 | `error_queue` rows with a NULL `client_id` appear on no client's card. | nit | Count them as "not tied to a client" on the panel. |
| L2 | Handlers on BullMQ `failed` run outside the async context, so `error_queue.trace_id` / `actor` are NULL on dead-lettered rows. | nit | Wrap `handleFailure` in `runWith` with the job's trace and client. |
| L3 | An owner viewing a uuid-shaped but non-existent `/operator/:clientId` makes every client-less log row in that request fail the INSERT (FK). | nit | Bind the client only after confirming it exists, or ignore FK errors. |
| L4 | The admin trace middleware honours an inbound `x-trace-id` on unauthenticated requests. | low | Ignore it without a session / signed internal call (a stranger who knew a victim's trace id could attribute client-less rows to that client). |
| L5 | The dedupe row keeps the FIRST event's payload/plan: a second plan failing for the same member and code only counts up (no email; Retry replays the first event; the nightly 3A backfills the second). | low | Delayed access, not lost access. |
| L6 | `IN_FLIGHT_LOCK` still dead-letters (with an email) after 3 attempts although the code comment says it does not. | nit | The email now says "no action needed"; fix the comment or the behaviour. |
| L7 | `Retry all active` posts to `/admin/errors/bulk-retry` (owner-only); an operator session would get 403. | should | Pre-existing; add an operator bulk route or hide the button for operators. |
| L8 | 4 unresolved `config_alert_log` rows (`revoke_holder_lapse_pending`) are in the digest but in no panel verdict. | watch | Decide whether they belong on the owner panel. |
| L9 | `DB_SLOW_QUERY` sits at the amber threshold (10 in 24h); at ~350k log rows/year the 24h diagnostic query will want an index on `(level, created_at)`. | watch | Pre-existing. |
| L10 | The reconcile cadence is 12h only because a 6h timer lands a few seconds short of the 6h gate. | watch | Make the gate tolerant (e.g. interval − 1 min) or run the timer at 12h on purpose. |
| L11 | Docs to update when this ships (KEEPER): repo + vault `CLAUDE.md` (error-guidance, log client stamping, 4xx dead-letter, panel verdict rules), `docs/feature-map.html` (client health), `docs/operations.html` (reconcile cadence), `docs/OPERATOR_FAQ.md`, `docs/endpoints.html` (`guidance` field), vault `open_items.md` (OB items for L4, L7, L10). | docs | Not edited here: CLAUDE.md says KEEPER syncs both copies at session close. |
| L12 | Dark mode: the client-card "ACTIVE" badge and some muted text on the Errors page are still low contrast (pre-existing `--muted`). | nit | Fix the token in `operator-styles.css`. |
