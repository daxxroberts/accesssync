/**
 * @file owner-health.js
 * @layer core/layer4
 * @role owner-hub-health
 * @reads clients, connector_subscriptions, reconciliation_run, webhook_log, error_queue, member_access,
 *        member_access_sources, plan_mappings, plan_mapping_groups, locations, billing_subscriptions,
 *        config_alert_log, diagnostic_log
 * @writes nothing
 * @exports computeOwnerHealth, SINCE_H, thresholds
 *
 * The one question the Owner Hub answers: "Is AccessSync working for every gym, and is there anything only
 * I can fix?" (handoff/OWNER_HUB_PROPOSAL_2026-10-15.md §2, combined with the Owner dashboard review).
 *
 * Output (also the contract of GET /admin/system-health and the owner daily email):
 *   verdict       'green' | 'amber' | 'red'
 *   check_failed  null, or one sentence naming the health queries that failed (one banner, never a red gym)
 *   summary       counts: gyms total / ok / need you / waiting on the gym / setting up / inactive
 *   problems[]    one row per thing a person must do. { client_id, client_name, kind, owner: 'you'|'gym',
 *                 severity: 'red'|'amber', text, since, link?, action? }  Rows that need you first, then oldest.
 *   platform[]    rows that belong to no gym: database down, background jobs stopped, errors tied to no gym.
 *                 Only present when something is wrong.
 *   healthy[]     gyms with no rows: { client_id, client_name, last_webhook_at, last_success_at }
 *   clients[]     every non-archived gym with the facts the Manage-gyms cards show.
 *
 * The only reasons a gym can show up (proposal §2.2):
 *   key           Kisi rejected the door key (gym), or the key has not been checked (you)
 *   sync          the last sync aborted, or no SUCCESSFUL sync in RECONCILE_RED_H (you); never synced with history
 *   webhooks      purchases stopped arriving after previous activity (you)
 *   errors_you    members who cannot get in and AccessSync must fix it: error_queue owner accesssync + members
 *                 stuck in an in-between state for STUCK_H
 *   errors_gym    members who cannot get in and the gym must fix it (waiting on the gym; escalates after
 *                 GYM_IGNORED_H)
 *   config_gap    an established gym lost its key or location (gym)
 *   setup         a new gym has not finished setup; which step it is on (you, with a setup-link action)
 *
 * Removed on purpose: removals held for the gym (the gym's Errors page), the diagnostics row, the cross-gym
 * "latest reconcile" age, the always-on status strip.
 */

'use strict';

const db = require('../db');
const { log } = require('./logger');
const { guidanceFor, OWNER } = require('./error-guidance');

// Reconcile runs every 12h in production. Green up to one missed-run grace (13h), amber to 26h.
const RECONCILE_AMBER_H = 13;
const RECONCILE_RED_H = 26;
// A gym that was receiving purchases and then goes quiet this long needs a look.
const WEBHOOK_SILENT_H = 48;
// A member stuck in an in-between state this long is a member who cannot get in.
const STUCK_H = 24;
// A gym-owned problem nobody has acted on for this long is escalated in the text (the gym is nudged).
const GYM_IGNORED_H = 48;
// The Kisi key check runs every 6h; a key not verified in this long means the check is not running.
const KEY_CHECK_STALE_H = 24;
// Errors in diagnostic_log that belong to no gym: a burst above this in 24h is a platform row.
const PLATFORM_ERROR_BURST = 10;

const thresholds = Object.freeze({ RECONCILE_AMBER_H, RECONCILE_RED_H, WEBHOOK_SILENT_H, STUCK_H, GYM_IGNORED_H, KEY_CHECK_STALE_H, PLATFORM_ERROR_BURST });

// One definition of "stuck", shared by the Hub's can't-get-in count (computeOwnerHealth) and the member list the
// Errors tab shows (listStuckMembers), so the two cannot disagree. $1 = STUCK_H. A delayed-start plan waiting for
// its own start date is not stuck.
const STUCK_ACCESS_WHERE = `ma.status IN ('pending_identity', 'recovery_pending', 'in_flight')
          AND ma.updated_at < NOW() - make_interval(hours => $1)`;
const STUCK_SOURCE_WHERE = `(mas.status = 'failed'
               OR (mas.status = 'pending_hardware' AND COALESCE(mas.updated_at, mas.created_at) < NOW() - make_interval(hours => $1))
               OR (mas.status = 'pending_start' AND mas.scheduled_start_date < NOW() - make_interval(hours => $1)))`;

const SEV = { green: 0, amber: 1, red: 2 };
const worst = (a, b) => (SEV[b] > SEV[a] ? b : a);

function ageHours(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - new Date(ts).getTime()) / 3_600_000);
}

/** Reconcile colour from the age of the last SUCCESSFUL run; null = never. */
function reconcileState(age) {
  if (age == null) return 'red';
  if (age < RECONCILE_AMBER_H) return 'green';
  if (age < RECONCILE_RED_H) return 'amber';
  return 'red';
}

const settle = (p) => Promise.resolve().then(() => p)
  .then(r => ({ ok: true, rows: (r && r.rows) || [] }))
  .catch(err => ({ ok: false, rows: [], error: String((err && err.message) || err) }));

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const hoursText = (h) => (h == null ? '' : h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`);

const ABORT_TEXT = {
  wix_api_unavailable: "Wix couldn't be read during the last sync",
  hardware_api_unavailable: "Kisi didn't respond during the last sync",
};

async function computeOwnerHealth() {
  const generated_at = new Date().toISOString();
  const dbProbeStart = Date.now();
  const dbProbe = db.query('SELECT 1').then(
    () => ({ ok: true, latency_ms: Date.now() - dbProbeStart }),
    (err) => ({ ok: false, latency_ms: null, error: String(err.message || err) })
  );

  const clientsP = settle(db.query(
    `SELECT c.id, c.name, c.status, c.created_at, c.last_webhook_at,
            cs.key_last_verified, cs.key_last_error, cs.key_first_failed_at,
            (cs.hardware_api_key IS NOT NULL) AS has_hardware_key,
            (c.source_api_key IS NOT NULL) AS has_wix_key
       FROM clients c
       LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
      WHERE c.status != 'archived'
      ORDER BY c.name ASC`
  ));

  // Latest run (any status) and last SUCCESSFUL run per gym. A sync that aborted must not read as fresh
  // (proposal bug 1).
  const runsP = settle(db.query(
    `SELECT r.client_id,
            MAX(r.started_at) FILTER (WHERE r.status = 'success') AS last_success_at,
            (ARRAY_AGG(r.status ORDER BY r.started_at DESC))[1]       AS latest_status,
            (ARRAY_AGG(r.abort_reason ORDER BY r.started_at DESC))[1] AS latest_abort_reason,
            MAX(r.started_at)                                          AS latest_started_at
       FROM reconciliation_run r
      GROUP BY r.client_id`
  ));

  const webhooksP = settle(db.query(
    `SELECT client_id, MIN(received_at) AS first_received_at, MAX(received_at) AS last_received_at,
            COUNT(*) FILTER (WHERE received_at >= NOW() - INTERVAL '24 hours')::int AS count_24h
       FROM webhook_log
      GROUP BY client_id`
  ));

  // Every OPEN row (status='failed' = open, see admin/routes/errors.js), classified by who must act.
  const errorsP = settle(db.query(
    `SELECT client_id, error_code, resolution, http_status, occurred_count, event_type, created_at
       FROM error_queue
      WHERE status = 'failed'`
  ));

  // Members stuck in an in-between state for STUCK_H (proposal bug 5). A delayed-start plan waiting for its
  // own start date is not stuck.
  const stuckP = settle(db.query(
    `SELECT client_id, SUM(n)::int AS stuck, MIN(since) AS oldest FROM (
       SELECT ma.client_id, COUNT(*) AS n, MIN(ma.updated_at) AS since
         FROM member_access ma
        WHERE ${STUCK_ACCESS_WHERE}
        GROUP BY ma.client_id
       UNION ALL
       SELECT mas.client_id, COUNT(*) AS n, MIN(COALESCE(mas.updated_at, mas.created_at)) AS since
         FROM member_access_sources mas
        WHERE ${STUCK_SOURCE_WHERE}
        GROUP BY mas.client_id
     ) s GROUP BY client_id`,
    [STUCK_H]
  ));

  // Setup steps: installed → key verified → plans mapped → first sale → first door.
  const setupP = settle(db.query(
    `SELECT c.id AS client_id,
            (SELECT COUNT(*)::int FROM locations l WHERE l.client_id = c.id) AS location_count,
            (SELECT COUNT(*)::int FROM plan_mappings pm WHERE pm.client_id = c.id AND pm.status = 'active') AS plans,
            (SELECT COUNT(*)::int FROM plan_mappings pm WHERE pm.client_id = c.id AND pm.status = 'active'
               AND (COALESCE(pm.hardware_group_id, '') <> '' OR EXISTS (SELECT 1 FROM plan_mapping_groups g WHERE g.mapping_id = pm.id))) AS plans_with_door,
            (SELECT MIN(ma.provisioned_at) FROM member_access ma WHERE ma.client_id = c.id AND ma.provisioned_at IS NOT NULL) AS first_door_at,
            EXISTS (SELECT 1 FROM member_master mm WHERE mm.client_id = c.id) AS has_members
       FROM clients c
      WHERE c.status != 'archived'`
  ));

  // Errors in diagnostic_log that belong to no gym even after trace attribution (platform-level).
  const platformErrorsP = settle(db.query(
    `SELECT COUNT(*)::int AS n
       FROM diagnostic_log d
       LEFT JOIN trace_context tc ON tc.trace_id = d.trace_id
      WHERE d.level = 'error' AND d.created_at >= NOW() - INTERVAL '24 hours'
        AND COALESCE(d.client_id, CASE WHEN d.actor_id LIKE 'reconciliation-%' THEN NULL ELSE tc.client_id END) IS NULL`
  ));

  const [dbR, clientsR, runsR, webhooksR, errorsR, stuckR, setupR, platformErrorsR] =
    await Promise.all([dbProbe, clientsP, runsP, webhooksP, errorsP, stuckP, setupP, platformErrorsP]);

  if (!clientsR.ok) {
    log.error('owner_health.clients_query_failed', {}, new Error(clientsR.error));
    const err = new Error('Failed to load clients list');
    err.detail = clientsR.error;
    throw err;
  }

  const failed = [
    ['sync runs', runsR], ['webhooks', webhooksR], ['open errors', errorsR],
    ['stuck members', stuckR], ['setup', setupR], ['platform errors', platformErrorsR],
  ].filter(([, r]) => !r.ok);
  if (!dbR.ok) failed.unshift(['database probe', { error: dbR.error }]);
  const check_failed = failed.length
    ? `Health check could not run ${failed.map(([n]) => n).join(', ')}: ${failed[0][1].error}`
    : null;
  if (failed.length) log.warn('owner_health.partial', { failed: failed.map(([n, r]) => ({ check: n, error: r.error })) });

  const byClient = (r, key = 'client_id') => new Map(r.rows.map(x => [x[key], x]));
  const runsMap = byClient(runsR);
  const webhookMap = byClient(webhooksR);
  const stuckMap = byClient(stuckR);
  const setupMap = byClient(setupR);
  const openByClient = new Map();
  for (const r of errorsR.rows) {
    const key = r.client_id || null;
    if (!openByClient.has(key)) openByClient.set(key, []);
    openByClient.get(key).push(r);
  }
  const classify = (rows) => {
    const out = { total: rows.length, you: 0, gym: 0, self_clearing: 0, oldest_gym: null, oldest_you: null };
    for (const r of rows) {
      const owner = guidanceFor(r).owner;
      if (owner === OWNER.GYM) { out.gym++; if (!out.oldest_gym || new Date(r.created_at) < new Date(out.oldest_gym)) out.oldest_gym = r.created_at; }
      else if (owner === OWNER.ACCESSSYNC) { out.you++; if (!out.oldest_you || new Date(r.created_at) < new Date(out.oldest_you)) out.oldest_you = r.created_at; }
      else out.self_clearing++;
    }
    return out;
  };

  const problems = [];
  const anyKeyEverChecked = clientsR.rows.some(c => c.key_last_verified);

  const clients = clientsR.rows.map((c) => {
    const inactive = c.status !== 'active';
    const runs = runsMap.get(c.id) || null;
    const wh = webhookMap.get(c.id) || null;
    const setup = setupMap.get(c.id) || null;
    const stuck = stuckMap.get(c.id) || null;
    const errors = classify(openByClient.get(c.id) || []);
    const lastSuccess = runs ? runs.last_success_at : null;
    const successAge = ageHours(lastSuccess);
    const lastWebhook = (wh && wh.last_received_at) || c.last_webhook_at || null;
    const webhookAge = ageHours(lastWebhook);
    const hasHistory = !!(setup && setup.has_members) || !!(runs && runs.latest_started_at) || !!lastWebhook;

    const missing = [];
    if (!c.has_hardware_key) missing.push('Kisi API key');
    if (!c.has_wix_key) missing.push('Wix API key');
    if (setup && !(setup.location_count > 0)) missing.push('a location');
    const plansWithDoor = setup ? setup.plans_with_door : null;
    // Setup step the gym is on (proposal §2.2): installed → key verified → plans mapped → first sale → first door
    let setupStep = null;
    if (!hasHistory || missing.length || (setup && plansWithDoor === 0)) {
      if (missing.length) setupStep = `missing ${missing.join(', ')}`;
      else if (c.has_hardware_key && !c.key_last_verified) setupStep = 'key not verified yet';
      else if (setup && plansWithDoor === 0) setupStep = 'no plan mapped to a door yet';
      else if (!lastWebhook) setupStep = 'waiting for the first sale';
      else if (setup && !setup.first_door_at) setupStep = 'first sale received, no door granted yet';
    }
    const settingUp = !inactive && !hasHistory && !!setupStep;
    const configGap = !inactive && hasHistory && missing.length > 0;

    let state = 'green';
    const rows = [];
    const push = (kind, owner, severity, text, extra = {}) => {
      rows.push({ client_id: c.id, client_name: c.name, kind, owner, severity, text, ...extra });
      state = worst(state, severity);
    };

    if (!inactive) {
      if (settingUp) {
        push('setup', 'you', 'amber', `Setup not finished: ${setupStep}`, {
          since: c.created_at, action: missing.length ? 'invite' : undefined,
          link: !missing.length && setup && plansWithDoor === 0 ? `/plan-mapping?clientId=${encodeURIComponent(c.id)}` : undefined,
        });
      } else {
        if (configGap) {
          push('config_gap', 'gym', 'red', `Was working, now missing ${missing.join(', ')}`, { since: null, link: `/locations?clientId=${encodeURIComponent(c.id)}` });
        }
        // Door key
        if (c.key_last_error) {
          push('key', 'gym', 'red', `Door key rejected by Kisi: ${c.key_last_error}`, { since: c.key_first_failed_at || c.key_last_verified, link: `/locations?clientId=${encodeURIComponent(c.id)}` });
        } else if (c.has_hardware_key && anyKeyEverChecked && (ageHours(c.key_last_verified) == null || ageHours(c.key_last_verified) >= KEY_CHECK_STALE_H)) {
          push('key', 'you', 'amber', c.key_last_verified ? `Door key not checked for ${hoursText(ageHours(c.key_last_verified))}` : 'Door key has never been checked', { since: c.key_last_verified });
        }
        // Sync
        if (runsR.ok) {
          if (runs && runs.latest_status === 'aborted') {
            push('sync', 'you', successAge != null && successAge < RECONCILE_RED_H ? 'amber' : 'red',
              `${ABORT_TEXT[runs.latest_abort_reason] || 'The last sync aborted (' + (runs.latest_abort_reason || 'unknown') + ')'}${lastSuccess ? '; last good sync ' + hoursText(successAge) + ' ago' : ''}`,
              { since: runs.latest_started_at, link: `/logs?clientId=${encodeURIComponent(c.id)}` });
          } else if (!lastSuccess && hasHistory) {
            push('sync', 'you', 'red', 'Sync with Wix has never completed for this gym', { since: c.created_at, link: `/logs?clientId=${encodeURIComponent(c.id)}` });
          } else if (lastSuccess) {
            const st = reconcileState(successAge);
            if (st !== 'green') push('sync', 'you', st, `No successful sync with Wix for ${hoursText(successAge)}`, { since: lastSuccess, link: `/logs?clientId=${encodeURIComponent(c.id)}` });
          }
        }
        // Purchases stopped
        if (webhooksR.ok && webhookAge != null && webhookAge >= WEBHOOK_SILENT_H) {
          push('webhooks', 'you', 'amber', `No purchases from Wix for ${hoursText(webhookAge)} (was active before)`, { since: lastWebhook, link: `/logs?clientId=${encodeURIComponent(c.id)}` });
        }
        // Members who cannot get in
        const stuckN = stuck ? stuck.stuck : 0;
        const youN = errors.you + stuckN;
        if (errorsR.ok && stuckR.ok && youN > 0) {
          const oldest = [errors.oldest_you, stuck && stuck.oldest].filter(Boolean).sort()[0] || null;
          push('errors_you', 'you', 'red', `${plural(youN, 'member')} can't get in: AccessSync must fix`, { since: oldest, link: `/errors?clientId=${encodeURIComponent(c.id)}`, count: youN });
        }
        if (errorsR.ok && errors.gym > 0) {
          const ignoredH = ageHours(errors.oldest_gym);
          push('errors_gym', 'gym', 'amber',
            `${plural(errors.gym, 'member')} can't get in: the gym must fix${ignoredH != null && ignoredH >= GYM_IGNORED_H ? ` (not acted on for ${hoursText(ignoredH)})` : ''}`,
            { since: errors.oldest_gym, link: `/errors?clientId=${encodeURIComponent(c.id)}`, count: errors.gym });
        }
      }
    }
    problems.push(...rows);

    return {
      client_id: c.id, client_name: c.name, status: c.status,
      state: inactive ? 'inactive' : settingUp ? 'setup' : state,
      setup_step: setupStep, missing, has_history: hasHistory,
      last_success_at: lastSuccess, success_age_hours: successAge,
      latest_run_status: runs ? runs.latest_status : null, latest_abort_reason: runs ? runs.latest_abort_reason : null,
      last_webhook_at: lastWebhook, webhook_age_hours: webhookAge, webhooks_24h: wh ? wh.count_24h : 0,
      key_last_verified: c.key_last_verified, key_last_error: c.key_last_error,
      open_errors: { total: errors.total, you: errors.you, gym: errors.gym, self_clearing: errors.self_clearing },
      stuck_members: stuck ? stuck.stuck : 0,
      problem_count: rows.length,
    };
  });

  // Platform rows: only when something is wrong.
  const platform = [];
  if (!dbR.ok) platform.push({ kind: 'db', owner: 'you', severity: 'red', text: 'The database is not responding', since: null });
  const unassigned = classify(openByClient.get(null) || []);
  if (unassigned.total) platform.push({ kind: 'errors_unassigned', owner: 'you', severity: 'red', text: `${plural(unassigned.total, 'open error')} tied to no gym`, since: unassigned.oldest_you || unassigned.oldest_gym, link: '/OwnerDashboard?panel=errors', count: unassigned.total });
  const platformErrors = platformErrorsR.ok ? (platformErrorsR.rows[0] || {}).n || 0 : 0;
  if (platformErrors >= PLATFORM_ERROR_BURST) platform.push({ kind: 'error_burst', owner: 'you', severity: 'amber', text: `${platformErrors} errors in 24h tied to no gym`, since: null, link: '/OwnerDashboard?panel=logs' });
  const keyedActive = clientsR.rows.filter(c => c.status === 'active' && c.has_hardware_key);
  if (keyedActive.length && !anyKeyEverChecked) platform.push({ kind: 'key_check', owner: 'you', severity: 'amber', text: 'The 6-hourly Kisi key check has never run', since: null });
  const activeWithHistory = clients.filter(c => c.state !== 'inactive' && c.has_history);
  if (runsR.ok && activeWithHistory.length && runsR.rows.length === 0) platform.push({ kind: 'sync_job', owner: 'you', severity: 'red', text: 'The nightly sync has never run', since: null });

  // Order: rows that need you first, red before amber, then oldest first.
  const ownerRank = { you: 0, gym: 1 };
  problems.sort((a, b) =>
    (ownerRank[a.owner] - ownerRank[b.owner]) || (SEV[b.severity] - SEV[a.severity]) ||
    ((a.since ? new Date(a.since).getTime() : Infinity) - (b.since ? new Date(b.since).getTime() : Infinity)));

  const active = clients.filter(c => c.state !== 'inactive');
  const needYou = new Set(problems.filter(p => p.owner === 'you').map(p => p.client_id)).size;
  const needGym = new Set(problems.filter(p => p.owner === 'gym' && !problems.some(q => q.client_id === p.client_id && q.owner === 'you')).map(p => p.client_id)).size;
  const summary = {
    gyms_total: active.length,
    gyms_ok: active.filter(c => c.problem_count === 0 && c.state !== 'setup').length,
    gyms_need_you: needYou,
    gyms_need_gym: needGym,
    gyms_setting_up: active.filter(c => c.state === 'setup').length,
    gyms_inactive: clients.length - active.length,
  };
  const healthy = active.filter(c => c.problem_count === 0).map(c => ({
    client_id: c.client_id, client_name: c.client_name, last_webhook_at: c.last_webhook_at, last_success_at: c.last_success_at,
  }));

  const verdict = [...problems, ...platform].reduce((v, r) => worst(v, r.severity), 'green');

  return { generated_at, verdict, check_failed, summary, problems, platform, healthy, clients, db: { ok: dbR.ok, latency_ms: dbR.latency_ms } };
}

/**
 * The members behind the Hub's "can't get in: AccessSync must fix" count that are not error_queue rows: one row per
 * stuck access row or stuck plan row, the same units computeOwnerHealth counts. The Errors tab lists these next to
 * the error_queue rows, so a red Hub row always opens onto what it counted. Pass clientId to scope to one gym.
 */
async function listStuckMembers({ clientId = null } = {}) {
  const params = [STUCK_H];
  if (clientId) params.push(clientId);
  const result = await db.query(
    `SELECT x.client_id, c.name AS client_name, x.access_id, x.kind, x.status, x.since, pm.plan_name,
            mm.display_name AS member_name, mm.email AS member_email, (ma.sub_master_id IS NOT NULL) AS is_sub_member
       FROM (
         SELECT ma.client_id, ma.id AS access_id, 'access'::text AS kind, ma.status::text AS status,
                NULL::uuid AS mapping_id, ma.updated_at AS since
           FROM member_access ma
          WHERE ${STUCK_ACCESS_WHERE}
         UNION ALL
         SELECT mas.client_id, mas.access_id, 'plan'::text, mas.status::text,
                mas.mapping_id, COALESCE(mas.updated_at, mas.created_at)
           FROM member_access_sources mas
          WHERE ${STUCK_SOURCE_WHERE}
       ) x
       JOIN member_access ma ON ma.id = x.access_id
       JOIN member_master mm ON mm.id = ma.member_master_id
       LEFT JOIN clients c ON c.id = x.client_id
       LEFT JOIN plan_mappings pm ON pm.id = x.mapping_id
      ${clientId ? 'WHERE x.client_id = $2' : ''}
      ORDER BY x.since ASC`,
    params
  );
  return result.rows;
}

/** Subject-line verdict: "All 3 gyms OK" / "1 of 3 gyms needs you · 1 waiting on the gym". */
function verdictLine(h) {
  const s = h.summary;
  const n = s.gyms_total;
  if (h.verdict === 'green' && !h.platform.length) return n === 1 ? 'Your 1 gym is OK' : `All ${n} gyms OK`;
  const parts = [];
  if (s.gyms_need_you) parts.push(`${s.gyms_need_you} of ${n} gym${n === 1 ? '' : 's'} need${s.gyms_need_you === 1 ? 's' : ''} you`);
  if (s.gyms_need_gym) parts.push(`${s.gyms_need_gym} waiting on the gym`);
  if (s.gyms_setting_up) parts.push(`${s.gyms_setting_up} setting up`);
  if (h.platform.length) parts.push(`${plural(h.platform.length, 'platform problem')}`);
  return parts.join(' · ') || 'Needs a look';
}

module.exports = { computeOwnerHealth, listStuckMembers, verdictLine, reconcileState, thresholds, ageHours };
