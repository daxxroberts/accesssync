/**
 * admin/routes/system-health.js
 * Admin Hub — System Health (OB-195)
 *
 * GET /admin/system-health — Owner-only infrastructure health snapshot across all clients.
 *
 * Returns a typed JSON object with:
 *   - aggregate: latest reconcile run across all clients + worst-state rollup
 *   - clients[]: per-client cards in stable order (name ASC) — UI sorts for display
 *       checks: reconcile_freshness | webhook_ingestion | error_queue | diagnostic_log
 *   - platform: errors in the last 24h that belong to no client (platform-level / unattributable)
 *   - db_health: top-level DB probe latency + slow-query count (global concern, not per-client)
 *
 * The verdict means "does someone need to act?" (2026-10 review):
 *   red    an open error someone must fix, a stale/never-run reconcile on an established client,
 *          or webhook silence
 *   amber  only self-clearing errors, a reconcile 13-26h old, a burst of errors in 24h,
 *          or a client whose setup has stalled
 *   green  nothing to do
 *   setup  (client.worst_state only) a client that has not finished setup AND has no history yet is NOT
 *          unhealthy — it has not started. It never turns the page red and is left out of the rollup until its
 *          setup has stalled (48h), when it becomes amber. A client that HAS history (members, webhooks, a
 *          reconcile) but lost its key or location is a real problem: it is judged normally and shows red.
 *   inactive (client.worst_state only) a client whose status is neither active nor archived (suspended,
 *          cancelled): the sweep does not run for it, so "never reconciled" is expected, not a fault.
 * A newly set-up client gets a grace period before "never received a webhook / never reconciled" is a fault
 * (a quiet new gym is not broken). Open errors that "clear by themselves" stop being self-clearing after 24h
 * (nothing auto-resolves them): they are counted as AccessSync's to look at.
 * Routine lifecycle warnings never drive a colour: they are counted for information only.
 *
 * SAGE-locked design (OB-195):
 *   1. No email alerts this round — pre-launch single-client (HOG). Deferred to OB follow-up.
 *   2. Per-client cards; aggregate "latest cron run across all clients" at top of response.
 *   3. Separate surface, owner-only — mounted under requireAuth in admin/server.js.
 *
 * All checks run in parallel (Promise.all). Each check wrapped in try/catch so one failure
 * doesn't sink the whole response — a failed check returns state:"red" + _error string.
 */

const router = require('express').Router();
const db     = require('../../db');
const { log } = require('../../core/logger');
const { guidanceFor, OWNER, SELF_CLEARING_MAX_H } = require('../../core/error-guidance');

// State priority for "worst-state" rollup. Higher = worse. 'idle' / 'setup' are neutral
// (not yet started) and never contribute.
const STATE_PRIORITY = { green: 0, amber: 1, red: 2 };

// Reconcile runs every 12h in production. Green up to one missed-run grace (13h), amber to 26h.
const RECONCILE_GREEN_H = 13;
const RECONCILE_AMBER_H = 26;
// A client that has not finished setup is "setting up" for this long, then "stalled".
const SETUP_STALLED_H = 48;
// A fully set-up new client is given time before silence is a fault.
const FIRST_WEBHOOK_GRACE_H = 72;
const FIRST_RECONCILE_GRACE_H = 24;
// Errors in 24h before diagnostics turns amber (baseline for one gym is ~2/day).
const DIAG_ERRORS_AMBER = 5;

function worstState(states) {
  let worst = 'green';
  for (const s of states) {
    if (!(s in STATE_PRIORITY)) continue;
    if (STATE_PRIORITY[s] > STATE_PRIORITY[worst]) worst = s;
  }
  return worst;
}

function ageHours(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 3_600_000);
}

const settle = (p) => p.then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

// ── GET /admin/system-health ────────────────────────────────────────
router.get('/', async (req, res) => {
  const generated_at = new Date().toISOString();

  // Kick off all queries in parallel. Each is wrapped to return either a result or an error.
  const dbProbeStart = Date.now();
  const dbProbe = db.query('SELECT 1').then(
    () => ({ ok: true, latency_ms: Date.now() - dbProbeStart }),
    (err) => ({ ok: false, latency_ms: null, error: String(err.message || err) })
  );

  const clientsP = settle(db.query(
    `SELECT id, name, last_webhook_at, status, created_at
       FROM clients
      WHERE status != 'archived'
      ORDER BY name ASC`
  ));

  // Per-client reconcile freshness — latest started_at per client_id
  const reconcileP = settle(db.query(
    `SELECT client_id, MAX(started_at) AS last_run_at
       FROM reconciliation_run
      GROUP BY client_id`
  ));

  // Global latest reconcile across all clients (for aggregate)
  const aggregateReconcileP = db.query(
    `SELECT MAX(started_at) AS latest_reconcile_at FROM reconciliation_run`
  ).then(r => ({ ok: true, row: r.rows[0] || {} }), err => ({ ok: false, error: String(err.message || err) }));

  // Webhook ingestion — last received per client + 24h count
  const webhookLastP = settle(db.query(
    `SELECT client_id, MAX(received_at) AS last_received_at
       FROM webhook_log
      GROUP BY client_id`
  ));

  const webhook24hP = settle(db.query(
    `SELECT client_id, COUNT(*)::int AS count_24h
       FROM webhook_log
      WHERE received_at >= NOW() - INTERVAL '24 hours'
      GROUP BY client_id`
  ));

  // Error queue — every OPEN row (status='failed' = open, see admin/routes/errors.js), so each
  // can be classified by core/error-guidance.js: who must act, and does it clear by itself?
  const errorQueueP = settle(db.query(
    `SELECT client_id, error_code, resolution, http_status, occurred_count, event_type, created_at
       FROM error_queue
      WHERE status = 'failed'`
  ));

  // Diagnostic log — errors in the last 24h per client. Rows logged without a client_id are
  // attributed through trace_context (the same trace_id), so a connector error is not lost
  // just because the call site did not pass the client — EXCEPT rows written by the nightly sweep (actor
  // 'reconciliation-*'): one trace spans every client there, so its trace_context client is only the first job's.
  // What still has no client is platform-level.
  const diagErrorsP = settle(db.query(
    `SELECT COALESCE(d.client_id, CASE WHEN d.actor_id LIKE 'reconciliation-%' THEN NULL ELSE tc.client_id END) AS client_id,
            COUNT(*)::int AS error_count_24h
       FROM diagnostic_log d
       LEFT JOIN trace_context tc ON tc.trace_id = d.trace_id
      WHERE d.level = 'error' AND d.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1`
  ));

  // Warnings are informational only (most are deliberate lifecycle breadcrumbs).
  const diagWarnsP = settle(db.query(
    `SELECT COALESCE(d.client_id, CASE WHEN d.actor_id LIKE 'reconciliation-%' THEN NULL ELSE tc.client_id END) AS client_id,
            COUNT(*)::int AS warn_count_24h
       FROM diagnostic_log d
       LEFT JOIN trace_context tc ON tc.trace_id = d.trace_id
      WHERE d.level = 'warn' AND d.created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY 1`
  ));

  // Slow-query count (global) — error_code = 'DB_SLOW_QUERY' (verified live 2026-05-26).
  const slowQueryP = db.query(
    `SELECT COUNT(*)::int AS slow_query_24h
       FROM diagnostic_log
      WHERE error_code = 'DB_SLOW_QUERY' AND created_at >= NOW() - INTERVAL '24 hours'`
  ).then(r => ({ ok: true, row: r.rows[0] || { slow_query_24h: 0 } }), err => ({ ok: false, error: String(err.message || err) }));

  // Setup progress per client: what is still missing before a client can provision anyone.
  const setupP = settle(db.query(
    `SELECT c.id AS client_id,
            EXISTS (SELECT 1 FROM connector_subscriptions cs
                     WHERE cs.client_id = c.id AND cs.status = 'active' AND cs.hardware_api_key IS NOT NULL) AS has_hardware_key,
            (c.source_api_key IS NOT NULL) AS has_wix_key,
            (SELECT COUNT(*)::int FROM locations l WHERE l.client_id = c.id) AS location_count,
            EXISTS (SELECT 1 FROM member_master mm WHERE mm.client_id = c.id) AS has_members
       FROM clients c
      WHERE c.status != 'archived'`
  ));

  const [
    dbProbeR, clientsR, reconcileR, aggregateReconcileR,
    webhookLastR, webhook24hR, errorQueueR, diagErrorsR, diagWarnsR, slowQueryR, setupR,
  ] = await Promise.all([
    dbProbe, clientsP, reconcileP, aggregateReconcileP,
    webhookLastP, webhook24hP, errorQueueP, diagErrorsP, diagWarnsP, slowQueryP, setupP,
  ]);

  // ── DB health (top-level, global) ─────────────────────────────────
  let db_health;
  if (!dbProbeR.ok) {
    db_health = { state: 'red', probe_latency_ms: null, slow_query_24h: null, _error: dbProbeR.error };
  } else {
    const probe_latency_ms = dbProbeR.latency_ms;
    const slow_query_24h = slowQueryR.ok ? slowQueryR.row.slow_query_24h : 0;
    let state = 'green';
    if (probe_latency_ms >= 100 || slow_query_24h >= 10) state = 'amber';
    // Red only if probe failed entirely (handled above).
    db_health = { state, probe_latency_ms, slow_query_24h };
    if (!slowQueryR.ok) db_health._slow_query_error = slowQueryR.error;
  }

  // ── If clients query failed, return early with what we have ─────
  if (!clientsR.ok) {
    log.error('admin.system_health.clients_query_failed', {}, new Error(clientsR.error));
    return res.status(500).json({
      generated_at,
      error: 'Failed to load clients list',
      _error: clientsR.error,
      db_health,
    });
  }

  // Build lookup maps keyed by client_id
  const rowsOf = (r) => (r.ok ? r.rows : []);
  const reconcileMap = new Map(rowsOf(reconcileR).map(r => [r.client_id, r.last_run_at]));
  const webhookLastMap = new Map(rowsOf(webhookLastR).map(r => [r.client_id, r.last_received_at]));
  const webhook24hMap = new Map(rowsOf(webhook24hR).map(r => [r.client_id, r.count_24h]));
  const diagErrorsMap = new Map(rowsOf(diagErrorsR).map(r => [r.client_id, r.error_count_24h]));
  const diagWarnsMap = new Map(rowsOf(diagWarnsR).map(r => [r.client_id, r.warn_count_24h]));
  const setupMap = new Map(rowsOf(setupR).map(r => [r.client_id, r]));
  const openErrorsByClient = new Map();
  for (const r of rowsOf(errorQueueR)) {
    if (!openErrorsByClient.has(r.client_id)) openErrorsByClient.set(r.client_id, []);
    openErrorsByClient.get(r.client_id).push(r);
  }

  // ── Per-client cards ──────────────────────────────────────────────
  const clients = clientsR.rows.map((c) => {
    // Setup: a client missing its door key, Wix key or any location cannot provision anyone yet.
    // The setup query failing must not hide a client behind "setting up": treat unknown as complete.
    const setupRow = setupR.ok ? setupMap.get(c.id) : null;
    const missing = [];
    if (setupRow) {
      if (!setupRow.has_hardware_key) missing.push('Kisi API key');
      if (!setupRow.has_wix_key) missing.push('Wix API key');
      if (!(setupRow.location_count > 0)) missing.push('a location');
    }
    const setupAgeH = ageHours(c.created_at);
    // History = the client has actually run: members, a webhook, or a reconcile. Missing config on a client WITH history
    // is a fault (key cleared, location deleted), not "setting up" — its errors and stale checks must stay visible.
    const hasHistory = !!(setupRow && setupRow.has_members) || reconcileMap.has(c.id) || webhookLastMap.has(c.id);
    const settingUp = missing.length > 0 && !hasHistory;
    const configGap = missing.length > 0 && hasHistory ? missing : null;
    const inactive = c.status !== 'active';
    // A complete new client that has not had a first webhook / sync yet is waiting, not broken.
    const newClientWaiting = (graceH) => !settingUp && setupAgeH != null && setupAgeH < graceH;

    // reconcile_freshness — green <13h (runs every 12h), amber 13-26h, red >26h or never
    let reconcile_freshness;
    if (!reconcileR.ok) {
      reconcile_freshness = { state: 'red', last_run_at: null, age_hours: null, _error: reconcileR.error };
    } else {
      const last_run_at = reconcileMap.get(c.id) || null;
      const age_hours = ageHours(last_run_at);
      let state;
      if (last_run_at === null) state = (settingUp || inactive || newClientWaiting(FIRST_RECONCILE_GRACE_H)) ? 'idle' : 'red';
      else if (age_hours < RECONCILE_GREEN_H) state = 'green';
      else if (age_hours < RECONCILE_AMBER_H) state = 'amber';
      else state = 'red';
      reconcile_freshness = { state, last_run_at, age_hours };
    }

    // webhook_ingestion — red if >48h silence or never; amber 24-48h; green otherwise
    let webhook_ingestion;
    if (!webhookLastR.ok || !webhook24hR.ok) {
      webhook_ingestion = { state: 'red', last_received_at: null, count_24h: null, _error: webhookLastR.error || webhook24hR.error || 'query failed' };
    } else {
      const last_received_at = webhookLastMap.get(c.id) || null;
      const count_24h = webhook24hMap.get(c.id) || 0;
      const age_h = ageHours(last_received_at);
      let state;
      if (last_received_at === null) state = (settingUp || inactive || newClientWaiting(FIRST_WEBHOOK_GRACE_H)) ? 'idle' : 'red';
      else if (age_h > 48) state = 'red';
      else if (age_h >= 24) state = 'amber';
      else state = 'green';
      webhook_ingestion = { state, last_received_at, count_24h };
    }

    // error_queue — every open row is classified by who must act (core/error-guidance.js).
    // red: something a person must fix (the gym or AccessSync). amber: only things that clear
    // by themselves. green: nothing open.
    let error_queue;
    if (!errorQueueR.ok) {
      error_queue = { state: 'red', open_count: null, _error: errorQueueR.error };
    } else {
      const open = openErrorsByClient.get(c.id) || [];
      // guidanceFor already moves a self-clearing error that has sat open past SELF_CLEARING_MAX_H to AccessSync.
      const owners = open.map(r => guidanceFor(r).owner);
      const needs_gym = owners.filter(o => o === OWNER.GYM).length;
      const needs_accesssync = owners.filter(o => o === OWNER.ACCESSSYNC).length;
      const self_clearing = owners.filter(o => o === OWNER.NOBODY).length;
      const oldest = open.reduce((m, r) => (m == null || new Date(r.created_at) < new Date(m) ? r.created_at : m), null);
      let state = 'green';
      if (needs_gym + needs_accesssync > 0) state = 'red';
      else if (self_clearing > 0) state = 'amber';
      error_queue = {
        state, open_count: open.length, needs_gym, needs_accesssync, self_clearing,
        oldest_age_hours: ageHours(oldest),
        link: `/errors?clientId=${encodeURIComponent(c.id)}`,
      };
    }

    // diagnostic_log — errors in the last 24h (attributed through trace_context). amber at a
    // burst; never red (red comes from error_queue, i.e. something a person can act on).
    // Warnings are shown for information and never colour the card.
    let diagnostic_log;
    if (!diagErrorsR.ok) {
      // The error count is what drives this card: if that query failed we do not know, and must not read green.
      diagnostic_log = { state: 'red', error_count_24h: null, warn_count_24h: null, _error: diagErrorsR.error };
    } else {
      const error_count_24h = diagErrorsMap.get(c.id) || 0;
      const warn_count_24h = diagWarnsMap.get(c.id) || 0;
      diagnostic_log = {
        state: error_count_24h >= DIAG_ERRORS_AMBER ? 'amber' : 'green',
        error_count_24h, warn_count_24h,
      };
    }

    const checks = { reconcile_freshness, webhook_ingestion, error_queue, diagnostic_log };

    // Neutral states first: an inactive client is not swept (so nothing is expected of it); a client still in setup
    // is neutral until its setup has stalled, then amber ("nudge them").
    let worst;
    let setup = null;
    if (inactive) {
      worst = 'inactive';
    } else if (settingUp) {
      const stalled = setupAgeH != null && setupAgeH >= SETUP_STALLED_H;
      setup = { missing, age_hours: setupAgeH, stalled };
      worst = stalled ? 'amber' : 'setup';
    } else {
      worst = worstState([
        reconcile_freshness.state, webhook_ingestion.state,
        error_queue.state, diagnostic_log.state,
        configGap ? 'red' : 'green',
        // Could not read the setup state, so "nothing is missing" is unknown, not good news.
        setupR.ok ? 'green' : 'amber',
      ]);
    }

    return {
      client_id: c.id,
      client_name: c.name,
      worst_state: worst,
      status: c.status,
      setup,
      config_gap: configGap,
      setup_check_failed: !setupR.ok,
      checks,
    };
  });

  // Platform-level: errors that belong to no client even after trace attribution.
  const platform_errors_24h = rowsOf(diagErrorsR).filter(r => r.client_id == null)
    .reduce((n, r) => n + r.error_count_24h, 0);

  // Open errors that belong to no client: no card shows them, so count them here.
  const unassigned_open_errors = errorQueueR.ok ? (openErrorsByClient.get(null) || openErrorsByClient.get(undefined) || []).length : 0;

  // ── Aggregate ─────────────────────────────────────────────────────
  let aggregate;
  if (!aggregateReconcileR.ok) {
    aggregate = { latest_reconcile_run: null, latest_reconcile_age_hours: null, worst_state: 'red', _error: aggregateReconcileR.error };
  } else {
    const latest = aggregateReconcileR.row.latest_reconcile_at || null;
    aggregate = {
      latest_reconcile_run: latest,
      latest_reconcile_age_hours: ageHours(latest),
      worst_state: worstState([
        ...clients.map(c => c.worst_state),
        db_health.state,
        unassigned_open_errors > 0 ? 'amber' : 'green',
      ]),
      clients_needing_attention: clients.filter(c => c.worst_state === 'red' || c.worst_state === 'amber').length,
      clients_setting_up: clients.filter(c => c.worst_state === 'setup').length,
    };
  }

  res.json({
    generated_at,
    aggregate,
    clients,
    platform: { error_count_24h: platform_errors_24h, unassigned_open_errors },
    db_health,
  });
});

module.exports = router;
