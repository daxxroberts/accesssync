# DB_POOL_MAX: recommended Railway values (2026-10-19)

**Status:** recommendation only. Nothing in this PR changes an env var. Daxx sets these in Railway.

## The limit

Supabase's session-mode pooler (port 5432, which every service uses) allows **15 clients in total**
across every process. Each Railway service opens its own pool, sized by `DB_POOL_MAX`
(`db.js`, default **10** when unset). Two services left at the default can fill the pooler by
themselves, and then queries fail with `EMAXCONNSESSION` (seen 2026-10-05, SAGE decision D27).

Two things make the real peak higher than "one pool per service":

1. **Deploy overlap.** A push to `main` redeploys Core Engine and Admin Hub together. Railway starts
   the new copy and only stops the old one once `/health` passes, so for a short while each service
   has **two** pools open.
2. **Crons.** Each Railway cron run is its own process with its own pool. They are short, but they
   can coincide with each other or with a deploy.

Idle connections are handed back after 5 s (`idleTimeoutMillis`, D28), so a quiet service holds few
slots. The limits below are for the worst case, when every pool is busy.

## Recommended values

| Railway service | Start command | `DB_POOL_MAX` | Why this size |
|---|---|---|---|
| Core Engine | `node server.js` | **4** | Webhooks + the BullMQ worker. Queries are short, so 20 concurrent jobs share 4 connections with sub-second waits. |
| Admin Hub | `node admin/server.js` | **3** | Dashboard pages, plus the in-process nightly reconcile and 15-min day-pass sweep. Reconcile holds one connection for its advisory lock and needs at least one more for queries. |
| Reconciliation cron (if it exists as its own service) | `node core/reconciliation.js` | **2** | Advisory-lock connection + one for queries. |
| Hardware health check cron | `node core/hardware-health-check.js` | **2** | Short run every 6 h. |
| Source retry probe cron (if deployed) | `node core/source-retry-probe.js` | **1** | Small, frequent, sequential. |
| Day-pass sweep cron (only if it runs as a separate cron, not just in Admin Hub) | `node core/day-pass-sweep.js` | **1** | Small, sequential. |

## How it adds up (limit 15)

| Situation | Slots in use (worst case) |
|---|---|
| Normal running (Core + Admin) | 4 + 3 = **7** |
| Normal + every cron at the same moment | 7 + 2 + 2 + 1 + 1 = **13** |
| A push to `main` (old and new Core + Admin both up) | 2 × 7 = **14** |
| Push + a cron mid-run | 15 to 16. This is rare and brief, and the pool-full retry in `db.js` (150/400/900 ms) covers it. |

That leaves 1–2 slots for ad-hoc scripts (`scripts/trace.js` and the like) in normal running.
The Supabase MCP / SQL editor use the management connection, not the pooler, so they don't count.

## Setting them

In Railway, for each service: **Variables → New Variable → `DB_POOL_MAX`** = the value above,
then let it redeploy. A typo or `0` falls back to 10 (`db.js` only accepts a positive integer).
Afterwards, a quick check: `db.pool_exhausted_recovered` warnings in diagnostic_log should stay rare.

## If it still gets tight

These numbers buy room for House of Gains and one or two more gyms. The lasting fix is already
logged as SAGE L15 / OB-189: move everyday queries to Supabase transaction mode (port 6543), or
upgrade to Supabase Pro, which raises the limit. Both need their own reviewed change.
