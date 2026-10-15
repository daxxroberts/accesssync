/**
 * admin/routes/system-health.js
 * Admin Hub — System Health (OB-195, trimmed 2026-10-15 owner-hub consolidation)
 *
 * GET /admin/system-health — Owner-only snapshot across all clients.
 *
 * The response answers one question: does someone need to act, and on what?
 *
 *   verdict       'green' | 'amber' | 'red' — page-level colour
 *   check_failed  null, or one sentence when any health query failed (the page shows one banner;
 *                 nothing below it is coloured red because a query failed)
 *   status        the strip at the top: reconcile age, webhook recency, DB probe, open errors
 *   actions[]     one row per thing a person must do or decide, with who (gym / accesssync),
 *                 what, and where to do it. Empty = nothing to do.
 *   clients[]     one row per non-archived client with its own state and the facts the card shows
 *
 * Rules (kept from the 2026-10 review rounds):
 *   - Open errors are classified by core/error-guidance.js: who must act, and does it clear itself.
 *     A self-clearing error that has sat open past SELF_CLEARING_MAX_H is AccessSync's.
 *   - A client that has never run (no members, no webhook, no reconcile) and is missing config is
 *     "setting up": an amber row with a setup-link action, never red.
 *   - A client WITH history that lost a key or location is a real fault: a red row.
 *   - A suspended/cancelled client is 'inactive': nothing is expected of it, no rows.
 *   - "Never received a webhook" is not a fault by itself (a quiet gym is not broken). Webhook
 *     silence is a row only after previous activity stops for WEBHOOK_SILENT_H.
 *   - "Never reconciled" is a row only once the client has history to reconcile.
 *
 * Dropped on the 2026-10-15 consolidation (gated on client #2, same as OB-181): the diagnostic
 * error-burst and warning counts, the slow-query count, and the grace-period / stalled-setup timers.
 */

const router = require('express').Router();
const db     = require('../../db');
const { log } = require('../../core/logger');
const { guidanceFor, OWNER } = require('../../core/error-guidance');

// Reconcile runs every 12h in production. Green up to one missed-run grace (13h), amber to 26h.
const RECONCILE_GREEN_H = 13;
const RECONCILE_AMBER_H = 26;
// A client that was receiving webhooks and then goes quiet this long needs a look.
const WEBHOOK_SILENT_H = 48;

const STATE_PRIORITY = { green: 0, amber: 1, red: 2 };

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

/** Reconcile colour from age in hours; null age (never run) is the caller's call. */
function reconcileState(age) {
  if (age == null) return 'red';
  if (age < RECONCILE_GREEN_H) return 'green';
  if (age < RECONCILE_AMBER_H) return 'amber';
  return 'red';
}

// A query helper that throws synchronously (or returns nothing) must become a failed check,
// never an exception that leaves the request hanging with no response.
const settle = (p) => Promise.resolve().then(() => p)
  .then(r => ({ ok: true, rows: r.rows }))
  .catch(err => ({ ok: false, error: String((err && err.message) || err) }));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ── GET /admin/system-health ────────────────────────────────────────
router.get('/', async (req, res) => {
  const generated_at = new Date().toISOString();

  const dbProbeStart = Date.now();
  const dbProbe = db.query('SELECT 1').then(
    () => ({ ok: true, latency_ms: Date.now() - dbProbeStart }),
    (err) => ({ ok: false, latency_ms: null, error: String(err.message || err) })
  );

  const clientsP = settle(db.query(
    `SELECT id, name, status, created_at
       FROM clients
      WHERE status != 'archived'
      ORDER BY name ASC`
  ));

  const reconcileP = settle(db.query(
    `SELECT client_id, MAX(started_at) AS last_run_at
       FROM reconciliation_run
      GROUP BY client_id`
  ));

  const webhooksP = settle(db.query(
    `SELECT client_id,
            MAX(received_at) AS last_received_at,
            COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::int AS count_24h
       FROM webhook_log
      GROUP BY client_id`
  ));

  // Every OPEN row (status='failed' = open, see admin/routes/errors.js), classified below.
  const errorQueueP = settle(db.query(
    `SELECT client_id, error_code, resolution, http_status, occurred_count, event_type, created_at
       FROM error_queue
      WHERE status = 'failed'`
  ));

  // What is still missing before a client can provision anyone, and whether it has ever run.
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

  // Open alerts from the nightly sweep: removals held for the gym to decide. Sent in the daily digest.
  const alertsP = settle(db.query(
    `SELECT client_id, COUNT(*)::int AS open_count,
            COUNT(*) FILTER (WHERE alert_type IN ('sweep_removal_pending','revoke_holder_lapse_pending','revoke_held_payment_state'))::int AS removals_held
       FROM config_alert_log
      WHERE resolved_at IS NULL
      GROUP BY client_id`
  ));

  const [dbProbeR, clientsR, reconcileR, webhooksR, errorQueueR, setupR, alertsR] =
    await Promise.all([dbProbe, clientsP, reconcileP, webhooksP, errorQueueP, setupP, alertsP]);

  if (!clientsR.ok) {
    log.error('admin.system_health.clients_query_failed', {}, new Error(clientsR.error));
    return res.status(500).json({ generated_at, error: 'Failed to load clients list', _error: clientsR.error });
  }

  // One banner for every failed query. A failed check never colours a client; it says so once.
  const failed = [
    ['reconcile', reconcileR], ['webhooks', webhooksR], ['open errors', errorQueueR],
    ['setup', setupR], ['sync alerts', alertsR],
  ].filter(([, r]) => !r.ok);
  if (!dbProbeR.ok) failed.unshift(['database probe', { error: dbProbeR.error }]);
  const check_failed = failed.length
    ? `Health check could not run ${failed.map(([n]) => n).join(', ')}: ${failed[0][1].error}`
    : null;
  if (failed.length) log.warn('admin.system_health.partial', { failed: failed.map(([n, r]) => ({ check: n, error: r.error })) });

  const rowsOf = (r) => (r.ok ? r.rows : []);
  const reconcileMap = new Map(rowsOf(reconcileR).map(r => [r.client_id, r.last_run_at]));
  const webhookMap   = new Map(rowsOf(webhooksR).map(r => [r.client_id, r]));
  const setupMap     = new Map(rowsOf(setupR).map(r => [r.client_id, r]));
  const alertsMap    = new Map(rowsOf(alertsR).map(r => [r.client_id, r]));
  const openByClient = new Map();
  for (const r of rowsOf(errorQueueR)) {
    const key = r.client_id || null;
    if (!openByClient.has(key)) openByClient.set(key, []);
    openByClient.get(key).push(r);
  }

  const classify = (rows) => {
    const owners = rows.map(r => guidanceFor(r).owner);
    return {
      total:            rows.length,
      needs_gym:        owners.filter(o => o === OWNER.GYM).length,
      needs_accesssync: owners.filter(o => o === OWNER.ACCESSSYNC).length,
      self_clearing:    owners.filter(o => o === OWNER.NOBODY).length,
    };
  };

  const actions = [];
  const clients = clientsR.rows.map((c) => {
    const inactive = c.status !== 'active';
    const setupRow = setupMap.get(c.id) || null;
    const missing = [];
    if (setupRow) {
      if (!setupRow.has_hardware_key) missing.push('Kisi API key');
      if (!setupRow.has_wix_key) missing.push('Wix API key');
      if (!(setupRow.location_count > 0)) missing.push('a location');
    }
    const wh = webhookMap.get(c.id) || null;
    const lastReconcile = reconcileMap.get(c.id) || null;
    const hasHistory = !!(setupRow && setupRow.has_members) || !!lastReconcile || !!(wh && wh.last_received_at);
    const settingUp = missing.length > 0 && !hasHistory;
    const configGap = missing.length > 0 && hasHistory;

    const errors = classify(openByClient.get(c.id) || []);
    const alerts = alertsMap.get(c.id) || { open_count: 0, removals_held: 0 };
    const reconcileAge = ageHours(lastReconcile);
    const webhookAge = ageHours(wh && wh.last_received_at);

    const states = [];
    const push = (owner, kind, text, extra = {}) => {
      actions.push({ client_id: c.id, client_name: c.name, owner, kind, text, ...extra });
    };

    if (inactive) {
      // Nothing is expected of a suspended or cancelled client.
    } else {
      if (settingUp) {
        states.push('amber');
        push(OWNER.GYM, 'setup', `Setup not finished: missing ${missing.join(', ')}`, { action: 'invite' });
      }
      if (configGap) {
        states.push('red');
        push(OWNER.GYM, 'config_gap', `Was working, now missing ${missing.join(', ')}`, { link: `/locations?clientId=${encodeURIComponent(c.id)}` });
      }
      if (errorQueueR.ok) {
        const link = `/errors?clientId=${encodeURIComponent(c.id)}`;
        if (errors.needs_gym) {
          states.push('red');
          push(OWNER.GYM, 'error', `${plural(errors.needs_gym, 'open error')} the gym must fix`, { link });
        }
        if (errors.needs_accesssync) {
          states.push('red');
          push(OWNER.ACCESSSYNC, 'error', `${plural(errors.needs_accesssync, 'open error')} for AccessSync support`, { link });
        }
        if (errors.self_clearing && !errors.needs_gym && !errors.needs_accesssync) states.push('amber');
      }
      if (reconcileR.ok && !settingUp) {
        if (!lastReconcile && hasHistory) {
          states.push('red');
          push(OWNER.ACCESSSYNC, 'reconcile', 'Reconcile has never run for this client', { link: `/logs?clientId=${encodeURIComponent(c.id)}` });
        } else if (lastReconcile) {
          const st = reconcileState(reconcileAge);
          states.push(st);
          if (st === 'red') push(OWNER.ACCESSSYNC, 'reconcile', `Reconcile has not run for ${reconcileAge}h`, { link: `/logs?clientId=${encodeURIComponent(c.id)}` });
        }
      }
      if (webhooksR.ok && webhookAge != null && webhookAge >= WEBHOOK_SILENT_H) {
        states.push('red');
        push(OWNER.ACCESSSYNC, 'webhook', `No webhook from Wix for ${webhookAge}h (was active before)`, { link: `/logs?clientId=${encodeURIComponent(c.id)}` });
      }
      if (alertsR.ok && alerts.removals_held) {
        states.push('amber');
        push(OWNER.GYM, 'removal_held', `${plural(alerts.removals_held, 'removal')} waiting for the gym to decide (in the daily digest)`);
      } else if (alertsR.ok && alerts.open_count) {
        states.push('amber');
        push(OWNER.ACCESSSYNC, 'alert', `${plural(alerts.open_count, 'open sync alert')} (in the daily digest)`);
      }
    }

    return {
      client_id: c.id,
      client_name: c.name,
      status: c.status,
      state: inactive ? 'inactive' : (settingUp ? 'setup' : worstState(states)),
      missing,
      has_history: hasHistory,
      last_reconcile_at: lastReconcile,
      reconcile_age_hours: reconcileAge,
      last_webhook_at: wh ? wh.last_received_at : null,
      webhook_age_hours: webhookAge,
      webhooks_24h: wh ? wh.count_24h : 0,
      open_errors: errors,
      open_alerts: alertsR.ok ? { open_count: alerts.open_count, removals_held: alerts.removals_held } : null,
    };
  });

  // Open errors that belong to no client: no card shows them, so they are a row of their own.
  const unassigned = classify(openByClient.get(null) || []);
  if (unassigned.total) {
    actions.push({
      client_id: null, client_name: null, owner: OWNER.ACCESSSYNC, kind: 'error',
      text: `${plural(unassigned.total, 'open error')} not tied to any client`,
      link: '/admin-errors',
    });
  }

  // ── Status strip ──────────────────────────────────────────────────
  const activeClients = clients.filter(c => c.state !== 'inactive');
  const latestReconcile = [...reconcileMap.values()].reduce((m, t) => (!m || new Date(t) > new Date(m) ? t : m), null);
  const latestWebhook = [...webhookMap.values()].reduce((m, r) => (!m || new Date(r.last_received_at) > new Date(m) ? r.last_received_at : m), null);
  const webhooks24h = [...webhookMap.values()].reduce((n, r) => n + (r.count_24h || 0), 0);
  const allOpen = classify(rowsOf(errorQueueR));

  const reconcileAgeAll = ageHours(latestReconcile);
  const status = {
    reconcile: {
      last_run_at: latestReconcile,
      age_hours: reconcileAgeAll,
      state: !reconcileR.ok ? 'unknown' : (latestReconcile ? reconcileState(reconcileAgeAll) : (activeClients.some(c => c.has_history) ? 'red' : 'idle')),
    },
    webhooks: {
      last_received_at: latestWebhook,
      age_hours: ageHours(latestWebhook),
      count_24h: webhooks24h,
      state: !webhooksR.ok ? 'unknown' : (latestWebhook ? (ageHours(latestWebhook) >= WEBHOOK_SILENT_H ? 'red' : 'green') : 'idle'),
    },
    db: { ok: dbProbeR.ok, latency_ms: dbProbeR.latency_ms },
    open_errors: errorQueueR.ok ? allOpen : null,
  };

  const verdict = worstState([
    ...clients.map(c => (c.state === 'setup' ? 'amber' : c.state)),
    dbProbeR.ok ? 'green' : 'red',
    unassigned.total ? 'red' : 'green',
  ]);

  res.json({ generated_at, verdict, check_failed, status, actions, clients });
});

module.exports = router;
module.exports.RECONCILE_GREEN_H = RECONCILE_GREEN_H;
module.exports.RECONCILE_AMBER_H = RECONCILE_AMBER_H;
module.exports.reconcileState = reconcileState;
