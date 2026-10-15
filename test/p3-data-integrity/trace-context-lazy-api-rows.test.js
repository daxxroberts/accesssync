/**
 * PRIORITY 3 — an admin request's trace_context row is written only when something is logged under it.
 *
 * Every admin HTTP request mints a trace before anything is known about it (per-router auth runs
 * after the middleware), so it lands as entry_point='api' with no client and no member. Written
 * eagerly, those rows held nothing but a timestamp: 260,127 of them by 2026-10-15, 99.9% never
 * referenced by diagnostic_log, activity_event or any other log table — 90 MB, most of the database.
 *
 * Now: the middleware parks the row's fields on the ALS context; db.js writes the row right before
 * the first INSERT into a trace-bearing table. A request that logs nothing leaves nothing behind.
 * Webhook / signed-in entry points are still registered up front — those traces are attributable
 * from the first millisecond and the Logs view relies on the row being there.
 *
 * db.js runs for real here (pg is faked) because the flush lives in its query() path.
 */

'use strict';

const mockPgQuery = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: mockPgQuery, on: jest.fn() })) }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test';

const db = require('../../db');
const { traceContextMiddleware } = require('../../admin/middleware/trace-context');
const tc = require('../../core/trace-context');

const sqlOf = (c) => String(c[0]);
const traceInserts = () => mockPgQuery.mock.calls.filter(c => /INSERT INTO trace_context/.test(sqlOf(c)));
const flush = () => new Promise(r => setImmediate(() => setImmediate(r)));

/** Run `body` inside the middleware's request context (fake req/res, real ALS). */
const inRequest = (req, body) => new Promise((resolve, reject) => {
  traceContextMiddleware(
    { headers: {}, path: '/operator/members', ...req },
    { setHeader: jest.fn() },
    () => Promise.resolve().then(body).then(resolve, reject)
  );
});

beforeEach(() => { mockPgQuery.mockReset(); mockPgQuery.mockResolvedValue({ rows: [] }); });

describe('[P3] trace_context rows for admin requests are lazy', () => {
  test('a request that logs nothing writes NO trace_context row', async () => {
    await inRequest({}, async () => { await db.query('SELECT 1'); });
    await flush();
    expect(traceInserts()).toHaveLength(0);
  });

  test('the first trace-bearing INSERT writes the row first, with the request\'s trace id and entry_point=api', async () => {
    let traceId;
    await inRequest({}, async () => {
      traceId = tc.getTraceId();
      await db.query('INSERT INTO diagnostic_log (trace_id) VALUES ($1)', [traceId]);
    });
    const sqls = mockPgQuery.mock.calls.map(sqlOf);
    const traceAt = sqls.findIndex(s => /INSERT INTO trace_context/.test(s));
    const diagAt  = sqls.findIndex(s => /INSERT INTO diagnostic_log/.test(s));
    expect(traceAt).toBeGreaterThanOrEqual(0);
    expect(traceAt).toBeLessThan(diagAt);
    const params = traceInserts()[0][1];
    expect(params[0]).toBe(traceId);
    expect(params[params.length - 1]).toBe('api');        // entry_point is the last column
  });

  test('a second trace-bearing INSERT in the same request does not register the trace again', async () => {
    await inRequest({}, async () => {
      await db.query('INSERT INTO diagnostic_log (trace_id) VALUES ($1)', ['x']);
      await db.query('INSERT INTO activity_event (trace_id) VALUES ($1)', ['x']);
      await db.query('INSERT INTO member_access_log (trace_id) VALUES ($1)', ['x']);
    });
    expect(traceInserts()).toHaveLength(1);
  });

  test('a withClient() child context shares the pending registration (one row, not two)', async () => {
    await inRequest({}, async () => {
      await tc.withClient('15962eac-c767-46ad-8056-094f35a4a193', async () => {
        await db.query('INSERT INTO diagnostic_log (trace_id) VALUES ($1)', ['x']);
      });
      await db.query('INSERT INTO diagnostic_log (trace_id) VALUES ($1)', ['x']);
    });
    expect(traceInserts()).toHaveLength(1);
  });

  test('setTraceContext() on a lazy trace writes the row before its UPDATE', async () => {
    await inRequest({}, async () => {
      tc.setTraceContext(tc.getTraceId(), { planName: 'Individual' });
    });
    await flush(); await flush();
    const sqls = mockPgQuery.mock.calls.map(sqlOf);
    const traceAt  = sqls.findIndex(s => /INSERT INTO trace_context/.test(s));
    const updateAt = sqls.findIndex(s => /UPDATE trace_context/.test(s));
    expect(traceAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThan(traceAt);
  });

  test('a signed-in admin request (admin_ui) is still registered up front', async () => {
    await inRequest({ admin: { email: 'daxxroberts@gmail.com', role: 'admin' } }, async () => {});
    await flush();
    expect(traceInserts()).toHaveLength(1);
    expect(traceInserts()[0][1].slice(-1)[0]).toBe('admin_ui');
  });

  test('a webhook request is still registered up front', async () => {
    await inRequest({ path: '/webhooks/wix' }, async () => {});
    await flush();
    expect(traceInserts()).toHaveLength(1);
    expect(traceInserts()[0][1].slice(-1)[0]).toBe('webhook');
  });

  test('outside any request context, a trace-bearing INSERT just runs (nothing to flush)', async () => {
    await db.query('INSERT INTO diagnostic_log (trace_id) VALUES ($1)', ['x']);
    expect(traceInserts()).toHaveLength(0);
    expect(mockPgQuery).toHaveBeenCalledTimes(1);
  });
});
