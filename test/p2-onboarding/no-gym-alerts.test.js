/**
 * P2 — alerts tied to no gym (2026-10-31).
 *
 * A Wix update AccessSync couldn't route is logged as a config_alert_log row with client_id NULL.
 * No page listed those rows and the gym dismiss route can't match a null client, so the owner's
 * digest repeated one such alert after every sweep — four emails a day — with "Review and dismiss"
 * opening a page with nothing to dismiss. These tests pin the owner-side list + dismiss, the plain
 * wording, and the digest's once-a-day rule for the owner's copy.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
  mintTraceId: jest.fn(() => 'trace-minted'),
  setTraceContext: jest.fn(),
  runWith: jest.fn((ctx, fn) => fn()),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));

const db = require('../../db');
const { recordActivity } = require('../../admin/middleware/activity');
const errorsRouter = require('../../admin/routes/errors');
const T = require('../../core/operator-email-templates');

const ALERT_ID = '6f1c1b1e-1111-4a4a-9c9c-0123456789ab';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/admin/errors', errorsRouter);
  return a;
}

beforeEach(() => jest.clearAllMocks());

describe('[P2] GET /admin/errors/alerts — alerts tied to no gym', () => {
  test('lists only open rows with no client, each with the digest\'s own plain sentence', async () => {
    db.query.mockResolvedValueOnce({ rows: [
      { id: ALERT_ID, alert_type: 'malformed_payload', created_at: '2026-10-27T13:12:07Z', last_seen_at: null },
    ] });
    const res = await request(app()).get('/admin/errors/alerts');
    expect(res.status).toBe(200);
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toMatch(/client_id IS NULL/);
    expect(sql).toMatch(/resolved_at IS NULL/);
    expect(res.body.alerts).toEqual([expect.objectContaining({
      id: ALERT_ID, alert_type: 'malformed_payload',
      message: T.describeConfigAlert({ alert_type: 'malformed_payload' }),
    })]);
    expect(res.body.alerts[0].message).not.toMatch(/malformed_payload/);
  });

  test('"alerts" is never read as an error id by GET /:id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await request(app()).get('/admin/errors/alerts');
    expect(String(db.query.mock.calls[0][0])).toMatch(/FROM config_alert_log/);
  });
});

describe('[P2] POST /admin/errors/alerts/:id/dismiss', () => {
  test('marks a no-gym alert handled, only when it has no client, and records who did it', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: ALERT_ID, resolved_at: '2026-10-31T12:00:00Z' }] });
    const res = await request(app()).post(`/admin/errors/alerts/${ALERT_ID}/dismiss`);
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toMatch(/SET resolved_at = NOW\(\)/);
    expect(String(sql)).toMatch(/client_id IS NULL/);
    expect(params).toEqual([ALERT_ID]);
    expect(recordActivity).toHaveBeenCalledWith(expect.anything(), 'alert.dismissed', { clientId: null, alertId: ALERT_ID });
  });

  test('a gym\'s alert (or an unknown id) is 404 here — gyms dismiss on their own Errors page', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).post(`/admin/errors/alerts/${ALERT_ID}/dismiss`);
    expect(res.status).toBe(404);
  });

  test('a malformed id is 404 without touching the database', async () => {
    const res = await request(app()).post('/admin/errors/alerts/not-a-uuid/dismiss');
    expect(res.status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('[P2] plain sentences for Wix updates AccessSync could not route', () => {
  test.each(['malformed_payload', 'events_js_outdated', 'unknown_site_id', 'unknown_client_id', 'tenant_mismatch'])(
    '%s reads as a sentence, never the raw code, and says nobody\'s access changed', (alertType) => {
      const s = T.describeConfigAlert({ alert_type: alertType });
      expect(s).not.toContain(alertType);
      expect(s).toMatch(/Nobody’s door access changed/);
    });
});
