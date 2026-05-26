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
 *   - db_health: top-level DB probe latency + slow-query count (global concern, not per-client)
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

// State priority for "worst-state" rollup. Higher = worse.
const STATE_PRIORITY = { green: 0, amber: 1, red: 2 };

function worstState(states) {
  if (!states.length) return 'green';
  let worst = 'green';
  for (const s of states) {
    if ((STATE_PRIORITY[s] ?? 0) > (STATE_PRIORITY[worst] ?? 0)) worst = s;
  }
  return worst;
}

function ageHours(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 3_600_000);
}

// ── GET /admin/system-health ────────────────────────────────────────
router.get('/', async (req, res) => {
  const generated_at = new Date().toISOString();

  // Kick off all queries in parallel. Each is wrapped to return either a result or an error.
  const dbProbeStart = Date.now();
  const dbProbe = db.query('SELECT 1').then(
    () => ({ ok: true, latency_ms: Date.now() - dbProbeStart }),
    (err) => ({ ok: false, latency_ms: null, error: String(err.message || err) })
  );

  const clientsP = db.query(
    `SELECT id, name, last_webhook_at, status, created_at
       FROM clients
      WHERE status != 'archived'
      ORDER BY name ASC`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  // Per-client reconcile freshness — latest started_at per client_id
  const reconcileP = db.query(
    `SELECT client_id, MAX(started_at) AS last_run_at
       FROM reconciliation_run
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  // Global latest reconcile across all clients (for aggregate)
  const aggregateReconcileP = db.query(
    `SELECT MAX(started_at) AS latest_reconcile_at FROM reconciliation_run`
  ).then(r => ({ ok: true, row: r.rows[0] || {} }), err => ({ ok: false, error: String(err.message || err) }));

  // Webhook ingestion — last received per client + 24h count
  const webhookLastP = db.query(
    `SELECT client_id, MAX(received_at) AS last_received_at
       FROM webhook_log
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  const webhook24hP = db.query(
    `SELECT client_id, COUNT(*)::int AS count_24h
       FROM webhook_log
      WHERE received_at >= NOW() - INTERVAL '24 hours'
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  // Error queue — open count per client. Convention: status='failed' = open (see admin/routes/errors.js).
  const errorQueueP = db.query(
    `SELECT client_id, COUNT(*)::int AS open_count
       FROM error_queue
      WHERE status = 'failed'
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  // Diagnostic log — error_count_1h + warn_count_24h per client.
  const diagErrorsP = db.query(
    `SELECT client_id, COUNT(*)::int AS error_count_1h
       FROM diagnostic_log
      WHERE level = 'error' AND created_at >= NOW() - INTERVAL '1 hour'
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  const diagWarnsP = db.query(
    `SELECT client_id, COUNT(*)::int AS warn_count_24h
       FROM diagnostic_log
      WHERE level = 'warn' AND created_at >= NOW() - INTERVAL '24 hours'
      GROUP BY client_id`
  ).then(r => ({ ok: true, rows: r.rows }), err => ({ ok: false, error: String(err.message || err) }));

  // Slow-query count (global) — error_code = 'DB_SLOW_QUERY' (verified live 2026-05-26).
  const slowQueryP = db.query(
    `SELECT COUNT(*)::int AS slow_query_24h
       FROM diagnostic_log
      WHERE error_code = 'DB_SLOW_QUERY' AND created_at >= NOW() - INTERVAL '24 hours'`
  ).then(r => ({ ok: true, row: r.rows[0] || { slow_query_24h: 0 } }), err => ({ ok: false, error: String(err.message || err) }));

  const [
    dbProbeR, clientsR, reconcileR, aggregateReconcileR,
    webhookLastR, webhook24hR, errorQueueR, diagErrorsR, diagWarnsR, slowQueryR,
  ] = await Promise.all([
    dbProbe, clientsP, reconcileP, aggregateReconcileP,
    webhookLastP, webhook24hP, errorQueueP, diagErrorsP, diagWarnsP, slowQueryP,
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
  const reconcileMap = new Map((reconcileR.ok ? reconcileR.rows : []).map(r => [r.client_id, r.last_run_at]));
  const webhookLastMap = new Map((webhookLastR.ok ? webhookLastR.rows : []).map(r => [r.client_id, r.last_received_at]));
  const webhook24hMap = new Map((webhook24hR.ok ? webhook24hR.rows : []).map(r => [r.client_id, r.count_24h]));
  const errorQueueMap = new Map((errorQueueR.ok ? errorQueueR.rows : []).map(r => [r.client_id, r.open_count]));
  const diagErrorsMap = new Map((diagErrorsR.ok ? diagErrorsR.rows : []).map(r => [r.client_id, r.error_count_1h]));
  const diagWarnsMap = new Map((diagWarnsR.ok ? diagWarnsR.rows : []).map(r => [r.client_id, r.warn_count_24h]));

  // ── Per-client cards ──────────────────────────────────────────────
  const clients = clientsR.rows.map((c) => {
    // reconcile_freshness — green <6h, amber 6-24h, red >24h or never
    let reconcile_freshness;
    if (!reconcileR.ok) {
      reconcile_freshness = { state: 'red', last_run_at: null, age_hours: null, _error: reconcileR.error };
    } else {
      const last_run_at = reconcileMap.get(c.id) || null;
      const age_hours = ageHours(last_run_at);
      let state;
      if (last_run_at === null) state = 'red';
      else if (age_hours < 6) state = 'green';
      else if (age_hours < 24) state = 'amber';
      else state = 'red';
      reconcile_freshness = { state, last_run_at, age_hours };
    }

    // webhook_ingestion — red if >48h silence or never; amber 24-48h; green otherwise
    let webhook_ingestion;
    if (!webhookLastR.ok && !webhook24hR.ok) {
      webhook_ingestion = { state: 'red', last_received_at: null, count_24h: null, _error: webhookLastR.error || webhook24hR.error };
    } else {
      const last_received_at = webhookLastMap.get(c.id) || null;
      const count_24h = webhook24hMap.get(c.id) || 0;
      const age_h = ageHours(last_received_at);
      let state;
      if (last_received_at === null) state = 'red';
      else if (age_h > 48) state = 'red';
      else if (age_h >= 24) state = 'amber';
      else state = 'green';
      webhook_ingestion = { state, last_received_at, count_24h };
    }

    // error_queue — green if 0, amber 1-9, red 10+
    let error_queue;
    if (!errorQueueR.ok) {
      error_queue = { state: 'red', open_count: null, _error: errorQueueR.error };
    } else {
      const open_count = errorQueueMap.get(c.id) || 0;
      let state;
      if (open_count === 0) state = 'green';
      else if (open_count < 10) state = 'amber';
      else state = 'red';
      error_queue = { state, open_count };
    }

    // diagnostic_log — red if error_count_1h > 0, amber if warn_count_24h > 50, green otherwise
    let diagnostic_log;
    if (!diagErrorsR.ok && !diagWarnsR.ok) {
      diagnostic_log = { state: 'red', error_count_1h: null, warn_count_24h: null, _error: diagErrorsR.error || diagWarnsR.error };
    } else {
      const error_count_1h = diagErrorsMap.get(c.id) || 0;
      const warn_count_24h = diagWarnsMap.get(c.id) || 0;
      let state;
      if (error_count_1h > 0) state = 'red';
      else if (warn_count_24h > 50) state = 'amber';
      else state = 'green';
      diagnostic_log = { state, error_count_1h, warn_count_24h };
    }

    const checks = { reconcile_freshness, webhook_ingestion, error_queue, diagnostic_log };
    const worst = worstState([
      reconcile_freshness.state, webhook_ingestion.state,
      error_queue.state, diagnostic_log.state,
    ]);

    return {
      client_id: c.id,
      client_name: c.name,
      worst_state: worst,
      checks,
    };
  });

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
      ]),
    };
  }

  res.json({
    generated_at,
    aggregate,
    clients,
    db_health,
  });
});

module.exports = router;
