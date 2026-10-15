/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: GET /admin/system-health endpoint contract (owner hub)       │
 * │                                                                         │
 * │  Covers admin/routes/system-health.js (trimmed 2026-10-15):             │
 * │    - Response shape: verdict + check_failed + status + actions[] +      │
 * │      clients[]                                                          │
 * │    - "Needs action" rows: who must act (gym / accesssync), what, where  │
 * │    - Open errors classified by core/error-guidance.js                   │
 * │    - Setup vs config gap vs inactive clients                            │
 * │    - Reconcile and webhook thresholds                                   │
 * │    - A failed query is one banner, never a red client                   │
 * │                                                                         │
 * │  Auth gate contract: the route is mounted in admin/server.js behind     │
 * │  requireAuth (owner-only). Importing the router directly bypasses the   │
 * │  mount-time middleware so the handler is exercised in isolation.        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const db = require('../../db');
const systemHealthRouter = require('../../admin/routes/system-health');

function makeApp() {
  const app = express();
  app.use('/admin/system-health', systemHealthRouter);
  return app;
}

const HOURS = (h) => new Date(Date.now() - h * 3_600_000).toISOString();

/**
 * Query order in admin/routes/system-health.js (Promise.all over 7 queries):
 *   1 SELECT 1 · 2 clients · 3 reconcile per client · 4 webhooks per client (last + 24h)
 *   5 open error_queue rows · 6 setup progress · 7 open sync alerts (config_alert_log)
 */
function mockSystem({
  clients = [{ id: 'c1', name: 'Test Client', status: 'active', created_at: HOURS(24 * 30) }],
  reconcile = [{ client_id: 'c1', last_run_at: HOURS(1) }],
  webhooks = [{ client_id: 'c1', last_received_at: HOURS(1), count_24h: 10 }],
  openErrors = [],
  setup,                       // default: every listed client fully set up
  alerts = [],
  fail = [],                   // 1-based query numbers that reject
} = {}) {
  const setupRows = setup || clients.map(c => ({ client_id: c.id, has_hardware_key: true, has_wix_key: true, location_count: 1, has_members: true }));
  const results = [
    { rows: [{ '?column?': 1 }] }, { rows: clients }, { rows: reconcile }, { rows: webhooks },
    { rows: openErrors }, { rows: setupRows }, { rows: alerts },
  ];
  results.forEach((r, i) => (fail.includes(i + 1) ? db.query.mockRejectedValueOnce(new Error('query ' + (i + 1) + ' failed')) : db.query.mockResolvedValueOnce(r)));
}

const openErr = (over = {}) => ({
  client_id: 'c1', error_code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY', http_status: 422,
  occurred_count: 1, created_at: HOURS(5), ...over,
});

const NEW = { id: 'c2', name: 'New Wix site', status: 'active', created_at: HOURS(2) };
const setupRow = (over = {}) => ({ client_id: 'c2', has_hardware_key: false, has_wix_key: false, location_count: 0, has_members: false, ...over });
const HOG = { id: 'c1', name: 'HOG', status: 'active', created_at: HOURS(900) };
const HOG_SETUP = { client_id: 'c1', has_hardware_key: true, has_wix_key: true, location_count: 1, has_members: true };

describe('[P2] GET /admin/system-health — owner hub contract', () => {
  let app;
  const get = () => request(app).get('/admin/system-health');

  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockReset();
    app = makeApp();
  });

  // ── 1. Shape ───────────────────────────────────────────────────────────────
  test('returns 200 with verdict, check_failed, status, actions, clients', async () => {
    mockSystem();
    const res = await get();
    expect(res.status).toBe(200);
    expect(typeof res.body.generated_at).toBe('string');
    expect(['green', 'amber', 'red']).toContain(res.body.verdict);
    expect(res.body.check_failed).toBeNull();
    expect(res.body.status).toMatchObject({
      reconcile: { state: 'green', age_hours: 1 },
      webhooks:  { state: 'green', count_24h: 10 },
      db:        { ok: true },
      open_errors: { total: 0, needs_gym: 0, needs_accesssync: 0, self_clearing: 0 },
    });
    expect(typeof res.body.status.db.latency_ms).toBe('number');
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(res.body.clients[0]).toMatchObject({ client_id: 'c1', client_name: 'Test Client', state: 'green', missing: [], has_history: true });
  });

  test('a healthy fixture is green with no actions', async () => {
    mockSystem();
    const res = await get();
    expect(res.body.verdict).toBe('green');
    expect(res.body.actions).toEqual([]);
  });

  test('exactly seven queries run', async () => {
    mockSystem();
    await get();
    expect(db.query).toHaveBeenCalledTimes(7);
  });

  // ── 2. Open errors: who must act ──────────────────────────────────────────
  describe('open errors (core/error-guidance.js decides who acts)', () => {
    test('an error the gym must fix → red, one gym row linking to that client\'s errors page', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null })] });
      const res = await get();
      expect(res.body.verdict).toBe('red');
      expect(res.body.clients[0]).toMatchObject({ state: 'red', open_errors: { total: 1, needs_gym: 1 } });
      expect(res.body.actions).toEqual([
        expect.objectContaining({ client_id: 'c1', owner: 'gym', kind: 'error', text: '1 open error the gym must fix', link: '/errors?clientId=c1' }),
      ]);
    });

    test('a Kisi 422 is AccessSync support\'s from the first occurrence → red accesssync row', async () => {
      mockSystem({ openErrors: [openErr()] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'error', text: '1 open error for AccessSync support' })]);
      expect(res.body.verdict).toBe('red');
    });

    test('an unclassified error is never ignored: AccessSync owns it', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'SOMETHING_NEW', resolution: null, http_status: null })] });
      expect((await get()).body.actions[0].owner).toBe('accesssync');
    });

    test('only self-clearing errors → amber, no row (nothing for a person to do yet)', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, occurred_count: 1 })] });
      const res = await get();
      expect(res.body.verdict).toBe('amber');
      expect(res.body.actions).toEqual([]);
      expect(res.body.status.open_errors).toMatchObject({ total: 1, self_clearing: 1 });
    });

    test('"clears by itself" expires: a temporary error still open after 24h becomes AccessSync\'s row', async () => {
      mockSystem({ openErrors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, occurred_count: 1, created_at: HOURS(30) })] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'error' })]);
      expect(res.body.verdict).toBe('red');
    });

    test('rows for the gym and for AccessSync are counted separately', async () => {
      mockSystem({ openErrors: [
        openErr({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null }),
        openErr({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null }),
        openErr(),
      ] });
      const texts = (await get()).body.actions.map(a => a.text);
      expect(texts).toEqual(['2 open errors the gym must fix', '1 open error for AccessSync support']);
    });

    test('errors for another client never colour this one', async () => {
      mockSystem({ openErrors: [openErr({ client_id: 'someone-else' })] });
      expect((await get()).body.clients[0].state).toBe('green');
    });

    test('open errors tied to no client get their own row and turn the page red', async () => {
      mockSystem({ openErrors: [openErr({ client_id: null })] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ client_id: null, owner: 'accesssync', text: '1 open error not tied to any client', link: '/admin-errors' })]);
      expect(res.body.verdict).toBe('red');
      expect(res.body.clients[0].state).toBe('green');
    });
  });

  // ── 3. Reconcile ──────────────────────────────────────────────────────────
  describe('reconcile (runs every 12h)', () => {
    test.each([[1, 'green'], [12, 'green'], [14, 'amber'], [25, 'amber'], [27, 'red']])(
      'a run %ih ago → %s', async (h, state) => {
        mockSystem({ reconcile: [{ client_id: 'c1', last_run_at: HOURS(h) }] });
        const res = await get();
        expect(res.body.clients[0].state).toBe(state);
        expect(res.body.status.reconcile.state).toBe(state);
      });

    test('a stale run (>26h) is an AccessSync row', async () => {
      mockSystem({ reconcile: [{ client_id: 'c1', last_run_at: HOURS(30) }] });
      expect((await get()).body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'reconcile', text: 'Reconcile has not run for 30h' })]);
    });

    test('never reconciled with history to reconcile → red AccessSync row', async () => {
      mockSystem({ reconcile: [] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'reconcile', text: 'Reconcile has never run for this client' })]);
      expect(res.body.verdict).toBe('red');
      expect(res.body.status.reconcile).toMatchObject({ state: 'red', last_run_at: null });
    });

    test('never reconciled with nothing to reconcile yet (no members, no webhooks) → idle, no row', async () => {
      mockSystem({ reconcile: [], webhooks: [], setup: [{ ...HOG_SETUP, has_members: false }] });
      const res = await get();
      expect(res.body.actions).toEqual([]);
      expect(res.body.verdict).toBe('green');
      expect(res.body.status.reconcile.state).toBe('idle');
    });

    test('reconcile ages are never amber/red when the reconcile query failed (banner instead)', async () => {
      mockSystem({ fail: [3] });
      const res = await get();
      expect(res.body.check_failed).toMatch(/reconcile/);
      expect(res.body.status.reconcile.state).toBe('unknown');
      expect(res.body.clients[0].state).toBe('green');
    });
  });

  // ── 4. Webhooks ───────────────────────────────────────────────────────────
  describe('webhooks', () => {
    test('silence after previous activity (48h+) → red AccessSync row', async () => {
      mockSystem({ webhooks: [{ client_id: 'c1', last_received_at: HOURS(50), count_24h: 0 }] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'webhook', text: 'No webhook from Wix for 50h (was active before)' })]);
      expect(res.body.status.webhooks.state).toBe('red');
    });

    test('a quiet day is not silence', async () => {
      mockSystem({ webhooks: [{ client_id: 'c1', last_received_at: HOURS(30), count_24h: 0 }] });
      const res = await get();
      expect(res.body.actions).toEqual([]);
      expect(res.body.clients[0].state).toBe('green');
    });

    test('never received a webhook is not a fault: idle, no row', async () => {
      mockSystem({ webhooks: [] });
      const res = await get();
      expect(res.body.actions).toEqual([]);
      expect(res.body.status.webhooks).toMatchObject({ state: 'idle', last_received_at: null, count_24h: 0 });
    });
  });

  // ── 5. Setup, config gap, inactive ────────────────────────────────────────
  describe('setup state', () => {
    test('a brand-new client missing config and with no history is "setup": amber row with a setup-link action, never red', async () => {
      mockSystem({
        clients: [HOG, NEW],
        reconcile: [{ client_id: 'c1', last_run_at: HOURS(1) }],
        webhooks: [{ client_id: 'c1', last_received_at: HOURS(1), count_24h: 3 }],
        setup: [HOG_SETUP, setupRow()],
      });
      const res = await get();
      const c2 = res.body.clients.find(c => c.client_id === 'c2');
      expect(c2).toMatchObject({ state: 'setup', missing: ['Kisi API key', 'Wix API key', 'a location'], has_history: false });
      expect(res.body.actions).toEqual([expect.objectContaining({
        client_id: 'c2', owner: 'gym', kind: 'setup', action: 'invite',
        text: 'Setup not finished: missing Kisi API key, Wix API key, a location',
      })]);
      expect(res.body.verdict).toBe('amber');
    });

    test('a client in setup gets no reconcile or webhook rows', async () => {
      mockSystem({ clients: [NEW], reconcile: [], webhooks: [], setup: [setupRow({ has_wix_key: true })] });
      const kinds = (await get()).body.actions.map(a => a.kind);
      expect(kinds).toEqual(['setup']);
    });

    test('an ESTABLISHED client that loses its Kisi key is a real fault: red config-gap row, its errors still listed', async () => {
      mockSystem({
        clients: [HOG],
        openErrors: [openErr({ error_code: 'HARDWARE_KEY_INVALID', resolution: 'ROTATE_API_KEY', http_status: 401 })],
        setup: [{ ...HOG_SETUP, has_hardware_key: false }],
      });
      const res = await get();
      expect(res.body.clients[0]).toMatchObject({ state: 'red', missing: ['Kisi API key'], has_history: true });
      expect(res.body.actions.map(a => a.kind)).toEqual(['config_gap', 'error']);
      expect(res.body.actions[0]).toMatchObject({ owner: 'gym', text: 'Was working, now missing Kisi API key', link: '/locations?clientId=c1' });
    });

    test('history counts even with no members: a client that already received webhooks is not "setting up"', async () => {
      mockSystem({
        clients: [NEW], reconcile: [],
        webhooks: [{ client_id: 'c2', last_received_at: HOURS(1), count_24h: 1 }],
        setup: [setupRow({ has_hardware_key: true, has_wix_key: true, location_count: 0 })],
      });
      const c = (await get()).body.clients[0];
      expect(c.state).toBe('red');
      expect(c.missing).toEqual(['a location']);
    });

    test.each(['suspended', 'cancelled'])('a %s client is inactive: no rows, never colours the page', async (status) => {
      mockSystem({ clients: [{ ...HOG, status }], reconcile: [], webhooks: [] });
      const res = await get();
      expect(res.body.clients[0]).toMatchObject({ state: 'inactive', status });
      expect(res.body.actions).toEqual([]);
      expect(res.body.verdict).toBe('green');
    });
  });

  // ── 6. Held removals / sync alerts ────────────────────────────────────────
  describe('open sync alerts', () => {
    test('removals held for the gym → amber gym row (no link: they arrive in the daily digest)', async () => {
      mockSystem({ alerts: [{ client_id: 'c1', open_count: 4, removals_held: 4 }] });
      const res = await get();
      expect(res.body.actions).toEqual([expect.objectContaining({ owner: 'gym', kind: 'removal_held', text: '4 removals waiting for the gym to decide (in the daily digest)' })]);
      expect(res.body.actions[0].link).toBeUndefined();
      expect(res.body.verdict).toBe('amber');
      expect(res.body.clients[0].open_alerts).toEqual({ open_count: 4, removals_held: 4 });
    });

    test('other open alerts → amber AccessSync row', async () => {
      mockSystem({ alerts: [{ client_id: 'c1', open_count: 2, removals_held: 0 }] });
      expect((await get()).body.actions).toEqual([expect.objectContaining({ owner: 'accesssync', kind: 'alert', text: '2 open sync alerts (in the daily digest)' })]);
    });
  });

  // ── 7. A failed query is one banner, never a red client ───────────────────
  describe('failed queries', () => {
    test('the open-errors query failing: banner set, errors null in the strip, client stays green, no error rows', async () => {
      mockSystem({ fail: [5] });
      const res = await get();
      expect(res.body.status).toHaveProperty('open_errors', null);
      expect(res.body.check_failed).toMatch(/could not run open errors/);
      expect(res.body.clients[0].state).toBe('green');
      expect(res.body.actions).toEqual([]);
    });

    test('several failures are named in one banner', async () => {
      mockSystem({ fail: [4, 7] });
      expect((await get()).body.check_failed).toMatch(/webhooks, sync alerts/);
    });

    test('the DB probe failing is the one failure that is a verdict: red', async () => {
      mockSystem({ fail: [1] });
      const res = await get();
      expect(res.body.status.db).toMatchObject({ ok: false, latency_ms: null });
      expect(res.body.verdict).toBe('red');
      expect(res.body.check_failed).toMatch(/database probe/);
    });

    test('the clients query failing is a 500', async () => {
      mockSystem({ fail: [2] });
      const res = await get();
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to load clients list');
    });

    test('the setup query failing judges clients as complete (never hidden behind "setup")', async () => {
      mockSystem({ fail: [6] });
      const res = await get();
      expect(res.body.clients[0]).toMatchObject({ state: 'green', missing: [] });
      expect(res.body.check_failed).toMatch(/setup/);
    });
  });

  // ── 8. Status strip aggregates across clients ─────────────────────────────
  test('the strip reports the latest reconcile and webhook across all clients and sums 24h counts', async () => {
    mockSystem({
      clients: [HOG, { ...NEW, created_at: HOURS(100) }],
      reconcile: [{ client_id: 'c1', last_run_at: HOURS(5) }, { client_id: 'c2', last_run_at: HOURS(2) }],
      webhooks: [{ client_id: 'c1', last_received_at: HOURS(3), count_24h: 7 }, { client_id: 'c2', last_received_at: HOURS(1), count_24h: 2 }],
      setup: [HOG_SETUP, { ...HOG_SETUP, client_id: 'c2' }],
    });
    const s = (await get()).body.status;
    expect(s.reconcile).toMatchObject({ age_hours: 2, state: 'green' });
    expect(s.webhooks).toMatchObject({ age_hours: 1, count_24h: 9, state: 'green' });
  });

  test('exports the reconcile thresholds used by /health', () => {
    expect(systemHealthRouter.RECONCILE_GREEN_H).toBe(13);
    expect(systemHealthRouter.RECONCILE_AMBER_H).toBe(26);
    expect(systemHealthRouter.reconcileState(1)).toBe('green');
    expect(systemHealthRouter.reconcileState(20)).toBe('amber');
    expect(systemHealthRouter.reconcileState(40)).toBe('red');
  });
});
