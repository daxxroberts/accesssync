/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: the Owner Hub and the Errors tab must agree.                 │
 * │                                                                         │
 * │  2026-10-16: the Hub said "2 members can't get in: AccessSync must      │
 * │  fix" while the Errors tab said "No errors found". The Hub counts       │
 * │  error_queue rows PLUS members stuck in an in-between state             │
 * │  (core/owner-health.js); the Errors tab listed only error_queue rows,   │
 * │  and the Hub's Open button led to a page that could not show them.      │
 * │                                                                         │
 * │  Contract: the "stuck" rule exists once (STUCK_ACCESS_WHERE /           │
 * │  STUCK_SOURCE_WHERE). computeOwnerHealth counts with it, listStuckMembers│
 * │  lists with it, GET /admin/errors returns that list, and the Hub's      │
 * │  "AccessSync must fix" row opens the Errors tab.                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })) }));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 't'), getActor: jest.fn(() => ({})), mintTraceId: jest.fn(() => 't'),
}));

const db = require('../../db');
const { computeOwnerHealth, listStuckMembers, thresholds } = require('../../core/owner-health');
const errorsRouter = require('../../admin/routes/errors');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// The two conditions as they appear in SQL, whitespace-insensitive.
const norm = (s) => String(s).replace(/\s+/g, ' ');
const ACCESS_RULE = norm("ma.status IN ('pending_identity', 'recovery_pending', 'in_flight') AND ma.updated_at < NOW() - make_interval(hours => $1)");
const SOURCE_RULE = norm("(mas.status = 'failed' OR (mas.status = 'pending_hardware' AND COALESCE(mas.updated_at, mas.created_at) < NOW() - make_interval(hours => $1)) OR (mas.status = 'pending_start' AND mas.scheduled_start_date < NOW() - make_interval(hours => $1)))");

const STUCK_ROWS = [
  { client_id: 'c1', client_name: 'House of Gains', access_id: 'a1', kind: 'plan', status: 'failed', since: '2026-05-16T02:31:50Z', plan_name: 'Individual', member_name: 'Old Test', member_email: 't@example.com', is_sub_member: false },
  { client_id: 'c1', client_name: 'House of Gains', access_id: 'a2', kind: 'access', status: 'pending_identity', since: '2026-10-05T18:49:31Z', plan_name: null, member_name: null, member_email: 'p@example.com', is_sub_member: true },
];

beforeEach(() => { db.query.mockReset(); });

describe('[P2] one definition of "stuck" for the Hub count and the Errors list', () => {
  test('the Hub\'s stuck query is built from the shared conditions', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await computeOwnerHealth().catch(() => {});
    const hubSql = db.query.mock.calls.map(c => norm(c[0])).find(s => s.includes('SUM(n)::int AS stuck'));
    expect(hubSql).toBeDefined();
    expect(hubSql).toContain(ACCESS_RULE);
    expect(hubSql).toContain(SOURCE_RULE);
  });

  test('listStuckMembers uses the same two conditions and the same hours threshold', async () => {
    db.query.mockResolvedValueOnce({ rows: STUCK_ROWS });
    const rows = await listStuckMembers();
    const [sql, params] = db.query.mock.calls[0];
    expect(norm(sql)).toContain(ACCESS_RULE);
    expect(norm(sql)).toContain(SOURCE_RULE);
    expect(params).toEqual([thresholds.STUCK_H]);
    expect(rows).toEqual(STUCK_ROWS);
  });

  test('a clientId scopes the list to that gym', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await listStuckMembers({ clientId: 'c1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(norm(sql)).toContain('WHERE x.client_id = $2');
    expect(params).toEqual([thresholds.STUCK_H, 'c1']);
  });

  test('the stuck rule is written once in core/owner-health.js, not copied into the route or panel', () => {
    const health = read('core/owner-health.js');
    expect(health.match(/ma\.status IN \('pending_identity', 'recovery_pending', 'in_flight'\)/g)).toHaveLength(1);
    expect(health.match(/mas\.status = 'failed'/g)).toHaveLength(1);
    expect(read('admin/routes/errors.js')).not.toMatch(/pending_identity|pending_hardware/);
    expect(read('admin/svelte/panels/ErrorQueuePanel.svelte')).not.toMatch(/pending_hardware|recovery_pending/);
  });
});

describe('[P2] GET /admin/errors returns the stuck members the Hub counts', () => {
  const app = express();
  app.use('/admin/errors', errorsRouter);

  // Route order: list query, count query, then (open view only) the stuck-member query.
  function mockRoute() {
    db.query.mockImplementation(async (sql) => {
      if (/SUM\(n\)|FROM \(/.test(String(sql)) && /member_access_sources mas/.test(String(sql))) return { rows: STUCK_ROWS };
      if (/SELECT COUNT\(\*\) FROM error_queue/.test(String(sql))) return { rows: [{ count: '0' }] };
      return { rows: [] };
    });
  }

  test('open view: empty error_queue still returns the stuck members, and total stays the error_queue count', async () => {
    mockRoute();
    const res = await request(app).get('/admin/errors?status=failed');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.stuck).toHaveLength(2);
    expect(res.body.stuck.map(s => s.access_id)).toEqual(['a1', 'a2']);
  });

  test('the gym filter reaches the stuck list', async () => {
    mockRoute();
    await request(app).get('/admin/errors?status=failed&client_id=c1');
    const stuckCall = db.query.mock.calls.find(c => /member_access_sources mas/.test(String(c[0])));
    expect(stuckCall[1]).toEqual([thresholds.STUCK_H, 'c1']);
  });

  test('resolved and all views never list stuck members (they have no resolved state)', async () => {
    mockRoute();
    for (const status of ['resolved', 'all']) {
      const res = await request(app).get(`/admin/errors?status=${status}`);
      expect(res.body.stuck).toEqual([]);
    }
    expect(db.query.mock.calls.some(c => /member_access_sources mas/.test(String(c[0])))).toBe(false);
  });
});

describe('[P2] the Hub opens onto what it counted', () => {
  const hub = read('admin/svelte/panels/HubPanel.svelte');
  const panel = read('admin/svelte/panels/ErrorQueuePanel.svelte');

  test('an "AccessSync must fix" row opens the owner Errors tab; other rows keep their link', () => {
    expect(hub).toMatch(/p\.kind === 'errors_you' \? '\/OwnerDashboard\?panel=errors' : p\.link/);
    expect(hub).toMatch(/href=\{rowLink\(p\)\}/);
  });

  test('the Hub queue row opens onto the failed jobs, listed by the existing endpoint with no new queue code', () => {
    expect(panel).toMatch(/\/admin\/queue\/jobs\?state=failed/);
    expect(panel).toMatch(/queueFailed = \(json\.data \|\| \[\]\)/);
    expect(panel).toMatch(/rows\.length === 0 && stuck\.length === 0 && queueFailed\.length === 0/);
    // The list comes from admin/routes/queue.js; the errors route must not grow its own copy of the queue read.
    expect(read('admin/routes/errors.js')).not.toMatch(/getJobs|getJobCounts|adminQueue/);
    expect(read('admin/routes/queue.js')).toMatch(/router\.get\('\/jobs'/);
  });

  test('the Errors tab shows the stuck list and never claims "No errors found" while it has members', () => {
    expect(panel).toMatch(/stuck = json\.stuck \|\| \[\]/);
    expect(panel).toMatch(/rows\.length === 0 && stuck\.length === 0/);
    expect(panel).toMatch(/updateNavBadge\(total \+ stuck\.length\)/);
  });
});
