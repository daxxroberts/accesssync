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

/**
 * Default healthy mock set — 1 client, fresh reconcile, recent webhook, 0 errors,
 * 0 diagnostic errors, 0 slow queries. Matches the query order in
 * admin/routes/system-health.js (Promise.all over 10 queries):
 *
 *   1. db.query('SELECT 1')                          — dbProbe
 *   2. SELECT id, name, ... FROM clients             — clientsP
 *   3. SELECT client_id, MAX(started_at) ...         — reconcileP
 *   4. SELECT MAX(started_at) AS latest_reconcile... — aggregateReconcileP
 *   5. SELECT client_id, MAX(received_at) ...        — webhookLastP
 *   6. SELECT client_id, COUNT(*) ... INTERVAL '24h' — webhook24hP
 *   7. SELECT client_id, COUNT(*) ... error_queue    — errorQueueP
 *   8. SELECT client_id, COUNT(*) ... level='error'  — diagErrorsP
 *   9. SELECT client_id, COUNT(*) ... level='warn'   — diagWarnsP
 *  10. SELECT COUNT(*) ... DB_SLOW_QUERY             — slowQueryP
 *
 * mockResolvedValueOnce queues these in order; Promise.all resolution order
 * matches dispatch order so the mock-queue mapping is stable.
 */
function mockHealthy({ clientId = 'c1', clientName = 'Test Client' } = {}) {
  const now = new Date();
  const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1 hour ago

  db.query
    .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })                                          // 1. SELECT 1
    .mockResolvedValueOnce({ rows: [{ id: clientId, name: clientName, last_webhook_at: recent, status: 'active', created_at: recent }] }) // 2. clients
    .mockResolvedValueOnce({ rows: [{ client_id: clientId, last_run_at: recent }] })               // 3. reconcile per-client
    .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: recent }] })                            // 4. aggregate reconcile
    .mockResolvedValueOnce({ rows: [{ client_id: clientId, last_received_at: recent }] })          // 5. webhook last
    .mockResolvedValueOnce({ rows: [{ client_id: clientId, count_24h: 10 }] })                     // 6. webhook 24h count
    .mockResolvedValueOnce({ rows: [] })                                                            // 7. error_queue (no open errors)
    .mockResolvedValueOnce({ rows: [] })                                                            // 8. diagErrors (none)
    .mockResolvedValueOnce({ rows: [] })                                                            // 9. diagWarns (none)
    .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] });                                     // 10. slow query
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('[P2] OB-195 — GET /admin/system-health endpoint', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = makeApp();
  });

  // ── 1. Shape contract ──────────────────────────────────────────────────────
  test('returns 200 with the expected response shape', async () => {
    mockHealthy();

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('generated_at');
    expect(typeof res.body.generated_at).toBe('string');
    expect(res.body).toHaveProperty('aggregate');
    expect(res.body).toHaveProperty('clients');
    expect(res.body).toHaveProperty('db_health');
    expect(Array.isArray(res.body.clients)).toBe(true);
    expect(['green', 'amber', 'red']).toContain(res.body.aggregate.worst_state);
    expect(['green', 'amber', 'red']).toContain(res.body.db_health.state);
  });

  // ── 2. State enum + per-client checks structure ───────────────────────────
  test('each per-client check has a valid state enum + all four check keys', async () => {
    mockHealthy();

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients.length).toBeGreaterThan(0);

    const c = res.body.clients[0];
    expect(c).toHaveProperty('client_id');
    expect(c).toHaveProperty('client_name');
    expect(c).toHaveProperty('worst_state');
    expect(c).toHaveProperty('checks');
    expect(['green', 'amber', 'red']).toContain(c.worst_state);

    ['reconcile_freshness', 'webhook_ingestion', 'error_queue', 'diagnostic_log']
      .forEach((key) => {
        expect(c.checks).toHaveProperty(key);
        expect(['green', 'amber', 'red']).toContain(c.checks[key].state);
      });
  });

  // ── 3. Healthy fixture rolls up to green ──────────────────────────────────
  test('healthy fixture rolls up to client worst_state=green and aggregate=green', async () => {
    mockHealthy();

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients[0].worst_state).toBe('green');
    expect(res.body.aggregate.worst_state).toBe('green');
    expect(res.body.db_health.state).toBe('green');
  });

  // ── 4. Worst-state rollup: red error_queue forces client + aggregate red ──
  test('worst-state rollup: 10+ open errors forces client.worst_state=red and aggregate=red', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })                                          // 1. SELECT 1
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'HOG', last_webhook_at: recent, status: 'active', created_at: recent }] }) // 2. clients
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_run_at: recent }] })                  // 3. reconcile per-client (fresh)
      .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: recent }] })                           // 4. aggregate reconcile
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_received_at: recent }] })             // 5. webhook last (fresh)
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', count_24h: 10 }] })                        // 6. webhook 24h
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', open_count: 15 }] })                       // 7. error_queue 15 open → RED
      .mockResolvedValueOnce({ rows: [] })                                                           // 8. diagErrors
      .mockResolvedValueOnce({ rows: [] })                                                           // 9. diagWarns
      .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] });                                    // 10. slow query

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients[0].checks.error_queue.state).toBe('red');
    expect(res.body.clients[0].checks.error_queue.open_count).toBe(15);
    expect(res.body.clients[0].worst_state).toBe('red');
    expect(res.body.aggregate.worst_state).toBe('red');
  });

  // ── 5. Worst-state rollup: amber error_queue → amber client (no red) ─────
  test('worst-state rollup: 1-9 open errors → client.worst_state=amber', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'HOG', last_webhook_at: recent, status: 'active', created_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_run_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_received_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', count_24h: 10 }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', open_count: 3 }] })   // 3 open → AMBER
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] });

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients[0].checks.error_queue.state).toBe('amber');
    expect(res.body.clients[0].worst_state).toBe('amber');
  });

  // ── 6. db_health amber on slow-query threshold ────────────────────────────
  test('db_health turns amber when slow_query_24h >= 10', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [] })                                       // no clients
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: recent }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slow_query_24h: 25 }] });               // breaches amber

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.db_health.state).toBe('amber');
    expect(res.body.db_health.slow_query_24h).toBe(25);
  });

  // ── 7. aggregate worst_state takes db_health into account ────────────────
  test('aggregate.worst_state rolls in db_health alongside per-client states', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    // All clients green, but db_health amber → aggregate must be amber
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'HOG', last_webhook_at: recent, status: 'active', created_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_run_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_received_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', count_24h: 10 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slow_query_24h: 50 }] });               // amber via slow queries

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients[0].worst_state).toBe('green');
    expect(res.body.db_health.state).toBe('amber');
    expect(res.body.aggregate.worst_state).toBe('amber');
  });

  // ── 8. Reconcile freshness red when never run ────────────────────────────
  test('reconcile_freshness=red when client has no reconcile_run row', async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'c1', name: 'HOG', last_webhook_at: recent, status: 'active', created_at: recent }] })
      .mockResolvedValueOnce({ rows: [] })                                       // no reconcile rows for this client
      .mockResolvedValueOnce({ rows: [{ latest_reconcile_at: null }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', last_received_at: recent }] })
      .mockResolvedValueOnce({ rows: [{ client_id: 'c1', count_24h: 10 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ slow_query_24h: 0 }] });

    const res = await request(app).get('/admin/system-health');

    expect(res.status).toBe(200);
    expect(res.body.clients[0].checks.reconcile_freshness.state).toBe('red');
    expect(res.body.clients[0].checks.reconcile_freshness.last_run_at).toBeNull();
    expect(res.body.clients[0].worst_state).toBe('red');
  });
});
