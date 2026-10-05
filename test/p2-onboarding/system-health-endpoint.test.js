/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: GET /admin/system-health endpoint contract (OB-195)          │
 * │                                                                         │
 * │  Covers admin/routes/system-health.js:                                  │
 * │    - Response shape: generated_at + aggregate + clients[] + db_health   │
 * │    - State enum validation: every state ∈ {green, amber, red}           │
 * │    - Worst-state rollup logic at per-client and aggregate level         │
 * │    - Per-client checks: reconcile_freshness / webhook_ingestion /       │
 * │      error_queue / diagnostic_log                                       │
 * │    - The verdict means "does someone need to act?": open errors are     │
 * │      classified by who must fix them; a client still in setup is        │
 * │      neutral (never red); routine warnings never colour a card          │
 * │                                                                         │
 * │  Auth gate contract: the route is mounted in admin/server.js behind     │
 * │  requireAuth (owner-only). requireAuth middleware behavior is covered   │
 * │  by the existing P1 suite — not re-tested here. Importing the router    │
 * │  directly (as below) deliberately bypasses the mount-time middleware    │
 * │  so we can exercise the handler in isolation.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const request = require('supertest');

// ── Shared mocks ──────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({ query: jest.fn() }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const db = require('../../db');
const systemHealthRouter = require('../../admin/routes/system-health');

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use('/admin/system-health', systemHealthRouter);
  return app;
}

const HOURS = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

/**
 * Query order in admin/routes/system-health.js (Promise.all over 11 queries):
 *   1 SELECT 1 · 2 clients · 3 reconcile per client · 4 reconcile aggregate · 5 webhook last
 *   6 webhook 24h · 7 open error_queue rows · 8 diag errors 24h · 9 diag warns 24h
 *  10 slow queries · 11 setup progress
 * mockResolvedValueOnce queues them in dispatch order.
 */
function mockSystem({
  clients = [{ id: 'c1', name: 'Test Client', last_webhook_at: HOURS(1), status: 'active', created_at: HOURS(24 * 30) }],
  reconcile = [{ client_id: 'c1', last_run_at: HOURS(1) }],
  latestReconcile = HOURS(1),
  webhookLast = [{ client_id: 'c1', last_received_at: HOURS(1) }],
  webhook24h = [{ client_id: 'c1', count_24h: 10 }],
  openErrors = [],
  diagErrors = [],
  diagWarns = [],
  slow = 0,
  setup,                       // default: every listed client fully set up
  fail = [],                   // 1-based query numbers (see the list above) that reject
} = {}) {
  const setupRows = setup || clients.map(c => ({ client_id: c.id, has_hardware_key: true, has_wix_key: true, location_count: 1, has_members: true }));
  const results = [
    { rows: [{ '?column?': 1 }] }, { rows: clients }, { rows: reconcile }, { rows: [{ latest_reconcile_at: latestReconcile }] },
    { rows: webhookLast }, { rows: webhook24h }, { rows: openErrors }, { rows: diagErrors }, { rows: diagWarns },
    { rows: [{ slow_query_24h: slow }] }, { rows: setupRows },
  ];
  results.forEach((r, i) => (fail.includes(i + 1) ? db.query.mockRejectedValueOnce(new Error('query ' + (i + 1) + ' failed')) : db.query.mockResolvedValueOnce(r)));
}

const openErr = (over = {}) => ({
  client_id: 'c1', error_code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY', http_status: 422,
  occurred_count: 1, created_at: HOURS(5), ...over,
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('[P2] OB-195 — GET /admin/system-health endpoint', () => {
  let app;
  const get = () => request(app).get('/admin/system-health');

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    app = makeApp();
  });

  // ── 1. Shape contract ──────────────────────────────────────────────────────
  test('returns 200 with the expected response shape', async () => {
    mockSystem();
    const res = await get();

    expect(res.status).toBe(200);
    expect(typeof res.body.generated_at).toBe('string');
    expect(res.body).toHaveProperty('aggregate');
    expect(res.body).toHaveProperty('clients');
    expect(res.body).toHaveProperty('db_health');
    expect(res.body.platform).toEqual({ error_count_24h: 0, unassigned_open_errors: 0 });
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(['green', 'amber', 'red']).toContain(res.body.aggregate.worst_state);
    expect(['green', 'amber', 'red']).toContain(res.body.db_health.state);
  });

  // ── 2. State enum + per-client checks structure ───────────────────────────
  test('each per-client check has a valid state enum + all four check keys', async () => {
    mockSystem();
    const res = await get();
    const c = res.body.clients[0];

    expect(c).toMatchObject({ client_id: 'c1', client_name: 'Test Client' });
    expect(['green', 'amber', 'red']).toContain(c.worst_state);
    ['reconcile_freshness', 'webhook_ingestion', 'error_queue', 'diagnostic_log'].forEach((key) => {
      expect(['green', 'amber', 'red']).toContain(c.checks[key].state);
    });
  });

  // ── 3. Healthy fixture rolls up to green ──────────────────────────────────
  test('healthy fixture rolls up to client worst_state=green and aggregate=green', async () => {
    mockSystem();
    const res = await get();

    expect(res.body.clients[0].worst_state).toBe('green');
    expect(res.body.aggregate.worst_state).toBe('green');
    expect(res.body.aggregate.clients_needing_attention).toBe(0);
    expect(res.body.db_health.state).toBe('green');
  });

  // ── 4. The Errors check means "someone must act" ──────────────────────────
  describe('error_queue — classified by who must act (core/error-guidance.js)', () => {
    test('an open error the gym must fix → red, with the count and a link to the errors page', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null })] });
      const res = await get();
      const eq = res.body.clients[0].checks.error_queue;

      expect(eq).toMatchObject({ state: 'red', open_count: 1, needs_gym: 1, needs_accesssync: 0, self_clearing: 0 });
      expect(eq.link).toBe('/errors?clientId=c1');
      expect(res.body.clients[0].worst_state).toBe('red');
      expect(res.body.aggregate.worst_state).toBe('red');
    });

    test('a Kisi 422 is AccessSync support\'s from the first occurrence (the gym cannot fix it) → red', async () => {
      mockSystem({ openErrors: [openErr()] });
      expect((await get()).body.clients[0].checks.error_queue).toMatchObject({ state: 'red', needs_gym: 0, needs_accesssync: 1 });
    });

    test('an unclassified error is never ignored: AccessSync owns it → red', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'SOMETHING_NEW', resolution: null, http_status: null })] });
      expect((await get()).body.clients[0].checks.error_queue.state).toBe('red');
    });

    test('only self-clearing errors (a fresh temporary glitch) → amber, not red', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, occurred_count: 1 })] });
      const res = await get();
      expect(res.body.clients[0].checks.error_queue).toMatchObject({ state: 'amber', self_clearing: 1, needs_gym: 0, needs_accesssync: 0 });
      expect(res.body.clients[0].worst_state).toBe('amber');
    });

    test('"clears by itself" expires: a temporary error still open after 24h is counted as AccessSync\'s (red), not amber forever', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, occurred_count: 1, created_at: HOURS(30) })] });
      expect((await get()).body.clients[0].checks.error_queue).toMatchObject({ state: 'red', self_clearing: 0, needs_accesssync: 1 });
    });

    test('a "temporary" error that keeps recurring escalates to red', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, occurred_count: 9 })] });
      expect((await get()).body.clients[0].checks.error_queue).toMatchObject({ state: 'red', needs_accesssync: 1 });
    });

    test('reports how old the oldest open item is', async () => {
      mockSystem({ openErrors: [openErr({ created_at: HOURS(50) }), openErr({ created_at: HOURS(2) })] });
      expect((await get()).body.clients[0].checks.error_queue.oldest_age_hours).toBe(50);
    });

    test('errors for another client never colour this one', async () => {
      mockSystem({ openErrors: [openErr({ client_id: 'someone-else' })] });
      expect((await get()).body.clients[0].checks.error_queue.state).toBe('green');
    });
  });

  // ── 5. Diagnostics: errors in 24h, warnings informational ─────────────────
  describe('diagnostic_log', () => {
    test('routine warnings never colour the card (HOG logs ~230 lifecycle breadcrumbs a day)', async () => {
      mockSystem({ diagWarns: [{ client_id: 'c1', warn_count_24h: 238 }] });
      const res = await get();
      expect(res.body.clients[0].checks.diagnostic_log).toMatchObject({ state: 'green', warn_count_24h: 238 });
      expect(res.body.clients[0].worst_state).toBe('green');
    });

    test('a burst of errors (5+ in 24h) → amber; it is never red by itself', async () => {
      mockSystem({ diagErrors: [{ client_id: 'c1', error_count_24h: 7 }] });
      const d = (await get()).body.clients[0].checks.diagnostic_log;
      expect(d).toMatchObject({ state: 'amber', error_count_24h: 7 });
    });

    test('a couple of errors is baseline, not an alarm', async () => {
      mockSystem({ diagErrors: [{ client_id: 'c1', error_count_24h: 2 }] });
      expect((await get()).body.clients[0].checks.diagnostic_log.state).toBe('green');
    });

    test('if the errors query itself fails the card is RED ("we do not know"), never green', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'Test Client', last_webhook_at: HOURS(1), status: 'active', created_at: HOURS(900) }] })
        .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_run_at: HOURS(1) }] })
        .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: HOURS(1) }] })
        .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_received_at: HOURS(1) }] })
        .mockResolvedValueOnce({ rows: [{ client_id: 'c1', count_24h: 10 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockRejectedValueOnce(new Error('diag down'))
        .mockResolvedValueOnce({ rows: [{ client_id: 'c1', warn_count_24h: 3 }] })
        .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] })
        .mockResolvedValueOnce({ rows: [{ client_id: 'c1', has_hardware_key: true, has_wix_key: true, location_count: 1, has_members: true }] });
      const d = (await get()).body.clients[0].checks.diagnostic_log;
      expect(d.state).toBe('red');
      expect(d._error).toBe('diag down');
    });

    test('errors that belong to no client are reported as platform-level, not lost', async () => {
      mockSystem({ diagErrors: [{ client_id: 'c1', error_count_24h: 1 }, { client_id: null, error_count_24h: 4 }] });
      const res = await get();
      expect(res.body.platform.error_count_24h).toBe(4);
      expect(res.body.clients[0].checks.diagnostic_log.error_count_24h).toBe(1);   // only its own
    });

    test('errors are attributed through trace_context so a connector error is not invisible', async () => {
      mockSystem();
      await get();
      const sql = db.query.mock.calls.map(c => String(c[0])).find(q => q.includes("level = 'error'"));
      expect(sql).toMatch(/LEFT JOIN trace_context/);
      expect(sql).toMatch(/COALESCE\(d\.client_id, CASE WHEN d\.actor_id LIKE 'reconciliation-%' THEN NULL ELSE tc\.client_id END\)/);
      expect(sql).toMatch(/24 hours/);
    });
  });

  // ── 6. Reconcile cadence (runs every 12h) ─────────────────────────────────
  describe('reconcile_freshness', () => {
    test.each([[1, 'green'], [12, 'green'], [14, 'amber'], [25, 'amber'], [27, 'red']])(
      'a run %ih ago → %s (a healthy 12h cron is never amber)', async (h, state) => {
        mockSystem({ reconcile: [{ client_id: 'c1', last_run_at: HOURS(h) }] });
        expect((await get()).body.clients[0].checks.reconcile_freshness.state).toBe(state);
      });

    test('red when an established client has no reconcile_run row', async () => {
      mockSystem({ reconcile: [], latestReconcile: null });
      const res = await get();
      expect(res.body.clients[0].checks.reconcile_freshness).toMatchObject({ state: 'red', last_run_at: null });
      expect(res.body.clients[0].worst_state).toBe('red');
    });
  });

  // ── 7. A client that has not finished setup is not "broken" ───────────────
  describe('setup state', () => {
    const NEW = { id: 'c2', name: 'New Wix site', last_webhook_at: null, status: 'active', created_at: HOURS(2) };
    const setupRow = (over = {}) => ({ client_id: 'c2', has_hardware_key: false, has_wix_key: false, location_count: 0, has_members: false, ...over });
    const HOG = { id: 'c1', name: 'HOG', last_webhook_at: HOURS(1), status: 'active', created_at: HOURS(900) };
    const HOG_SETUP = { client_id: 'c1', has_hardware_key: true, has_wix_key: true, location_count: 1, has_members: true };

    test('a brand-new client with no history reads "setup", not red, and does not turn the page red', async () => {
      mockSystem({
        clients: [HOG, NEW],
        reconcile: [{ client_id: 'c1', last_run_at: HOURS(1) }],
        webhookLast: [{ client_id: 'c1', last_received_at: HOURS(1) }],
        setup: [HOG_SETUP, setupRow()],
      });
      const res = await get();
      const c2 = res.body.clients.find(c => c.client_id === 'c2');

      expect(c2.worst_state).toBe('setup');
      expect(c2.setup).toMatchObject({ stalled: false, missing: ['Kisi API key', 'Wix API key', 'a location'] });
      expect(c2.config_gap).toBeNull();
      expect(c2.checks.reconcile_freshness.state).toBe('idle');
      expect(c2.checks.webhook_ingestion.state).toBe('idle');
      expect(res.body.aggregate.worst_state).toBe('green');
      expect(res.body.aggregate.clients_setting_up).toBe(1);
      expect(res.body.aggregate.clients_needing_attention).toBe(0);
    });

    test('setup that has stalled for 48h+ becomes amber ("nudge them"), still not red', async () => {
      mockSystem({
        clients: [{ ...NEW, created_at: HOURS(72) }],
        reconcile: [], webhookLast: [], webhook24h: [],
        setup: [setupRow({ has_wix_key: true })],
      });
      const res = await get();
      expect(res.body.clients[0]).toMatchObject({ worst_state: 'amber', setup: { stalled: true, missing: ['Kisi API key', 'a location'] } });
      expect(res.body.aggregate.worst_state).toBe('amber');
      expect(res.body.aggregate.clients_needing_attention).toBe(1);
    });

    test('an ESTABLISHED client that loses its Kisi key is a real fault: RED with config_gap, its checks and errors stay visible (never "setup stalled")', async () => {
      mockSystem({
        clients: [HOG],
        reconcile: [{ client_id: 'c1', last_run_at: HOURS(1) }],
        webhookLast: [{ client_id: 'c1', last_received_at: HOURS(1) }],
        openErrors: [openErr({ error_code: 'HARDWARE_KEY_INVALID', resolution: 'ROTATE_API_KEY', http_status: 401 })],
        setup: [{ ...HOG_SETUP, has_hardware_key: false }],
      });
      const c = (await get()).body.clients[0];
      expect(c.setup).toBeNull();
      expect(c.config_gap).toEqual(['Kisi API key']);
      expect(c.worst_state).toBe('red');
      expect(c.checks.error_queue).toMatchObject({ state: 'red', needs_gym: 1 });      // not hidden
    });

    test('history counts even with no members: a client that already received webhooks is not "setting up"', async () => {
      mockSystem({
        clients: [{ ...NEW, created_at: HOURS(100) }],
        reconcile: [], webhookLast: [{ client_id: 'c2', last_received_at: HOURS(1) }], webhook24h: [],
        setup: [setupRow({ has_hardware_key: true, has_wix_key: true, location_count: 0 })],
      });
      const c = (await get()).body.clients[0];
      expect(c.setup).toBeNull();
      expect(c.config_gap).toEqual(['a location']);
      expect(c.worst_state).toBe('red');
    });

    test('once setup is complete the client is judged like any other (no reconcile ever, past the grace period → red)', async () => {
      mockSystem({
        clients: [{ ...NEW, created_at: HOURS(100) }],
        reconcile: [], webhookLast: [], webhook24h: [],
        setup: [setupRow({ has_hardware_key: true, has_wix_key: true, location_count: 1 })],
      });
      const res = await get();
      expect(res.body.clients[0].setup).toBeNull();
      expect(res.body.clients[0].worst_state).toBe('red');
    });

    test('...but a just-finished new client gets a grace period: "waiting for first sale/sync", not red', async () => {
      mockSystem({
        clients: [{ ...NEW, created_at: HOURS(10) }],
        reconcile: [], webhookLast: [], webhook24h: [],
        setup: [setupRow({ has_hardware_key: true, has_wix_key: true, location_count: 1 })],
      });
      const c = (await get()).body.clients[0];
      expect(c.checks.reconcile_freshness.state).toBe('idle');
      expect(c.checks.webhook_ingestion.state).toBe('idle');
      expect(c.worst_state).toBe('green');
    });

    test('grace is only for the FIRST webhook: after 72h of silence a complete client is red', async () => {
      mockSystem({
        clients: [{ ...NEW, created_at: HOURS(80) }],
        reconcile: [{ client_id: 'c2', last_run_at: HOURS(1) }], webhookLast: [], webhook24h: [],
        setup: [setupRow({ has_hardware_key: true, has_wix_key: true, location_count: 1 })],
      });
      expect((await get()).body.clients[0].checks.webhook_ingestion.state).toBe('red');
    });

    test.each(['suspended', 'cancelled'])('a %s client is neutral "inactive": the sweep never runs for it, so no red for "never reconciled"', async (status) => {
      mockSystem({
        clients: [{ ...HOG, status }],
        reconcile: [], webhookLast: [], webhook24h: [],
      });
      const res = await get();
      expect(res.body.clients[0]).toMatchObject({ worst_state: 'inactive', status });
      expect(res.body.aggregate.worst_state).toBe('green');
      expect(res.body.aggregate.clients_needing_attention).toBe(0);
    });

    test('if the setup query itself fails, clients are judged normally (never hidden behind "setup")', async () => {
      db.query
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
        .mockResolvedValueOnce({ rows: [HOG] })
        .mockResolvedValueOnce({ rows: [] })                                    // no reconcile ever
        .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: null }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] })
        .mockRejectedValueOnce(new Error('setup query failed'));
      const res = await get();
      expect(res.body.clients[0].setup).toBeNull();
      expect(res.body.clients[0].worst_state).toBe('red');
    });
  });

  describe('a failed query is never good news (review follow-ups)', () => {
    test('setup query failed on an established client: amber with setup_check_failed, never green', async () => {
      mockSystem({ fail: [11] });
      const c = (await get()).body.clients[0];
      expect(c.setup_check_failed).toBe(true);
      expect(c.worst_state).toBe('amber');
    });

    test('only ONE of the two webhook queries failed: the card says the check failed, not "Active"/"Silent"', async () => {
      mockSystem({ fail: [6] });
      const w = (await get()).body.clients[0].checks.webhook_ingestion;
      expect(w.state).toBe('red');
      expect(w._error).toBeTruthy();
      db.query.mockReset();
      mockSystem({ fail: [5] });
      const w2 = (await get()).body.clients[0].checks.webhook_ingestion;
      expect(w2.state).toBe('red');
      expect(w2._error).toBeTruthy();
    });

    test('the aggregate reconcile query failing is flagged (the page must not print "0 clients need action")', async () => {
      mockSystem({ fail: [4] });
      const res = await get();
      expect(res.body.aggregate._error).toBeTruthy();
      expect(res.body.aggregate.worst_state).toBe('red');
    });

    test('open errors tied to no client are counted and turn the page amber', async () => {
      mockSystem({ openErrors: [openErr({ client_id: null })] });
      const res = await get();
      expect(res.body.platform.unassigned_open_errors).toBe(1);
      expect(res.body.aggregate.worst_state).toBe('amber');
      expect(res.body.clients[0].worst_state).toBe('green');
    });
  });

  // ── 8. db_health ──────────────────────────────────────────────────────────
  test('db_health turns amber when slow_query_24h >= 10', async () => {
    mockSystem({ clients: [], reconcile: [], webhookLast: [], webhook24h: [], slow: 25 });
    const res = await get();
    expect(res.body.db_health).toMatchObject({ state: 'amber', slow_query_24h: 25 });
  });

  test('aggregate.worst_state rolls in db_health alongside per-client states', async () => {
    mockSystem({ slow: 50 });
    const res = await get();
    expect(res.body.clients[0].worst_state).toBe('green');
    expect(res.body.db_health.state).toBe('amber');
    expect(res.body.aggregate.worst_state).toBe('amber');
  });
});
