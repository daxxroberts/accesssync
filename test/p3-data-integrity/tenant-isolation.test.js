/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: a second gym is onboarded next to House of Gains             │
 * │                                                                         │
 * │  Every boundary where one tenant could reach another, pinned:           │
 * │    1. Owner-only routes refuse operator tokens (same JWT secret).       │
 * │    2. An operator session only reaches its own /operator/:clientId.     │
 * │    3. A webhook signed for gym A can never be routed to gym B by an     │
 * │       unsigned site-id header.                                          │
 * │    4. An unknown Wix site is dropped — never defaulted onto a real gym. │
 * │    5. A member email for gym A only resolves gym-A members.             │
 * │    6. The unsigned Wix authorizationCode cannot re-point an already-    │
 * │       wired gym at a different Wix installation.                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret';
process.env.WIX_APP_SECRET   = process.env.WIX_APP_SECRET   || 'test-wix-app-secret';

const crypto       = require('crypto');
const express      = require('express');
const cookieParser = require('cookie-parser');
const request      = require('supertest');
const jwt          = require('jsonwebtoken');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(v => `dec-${v}`),
  encryptApiKey: jest.fn(v => `enc-${v}`),
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
const mockQueueAdd = jest.fn().mockResolvedValue();
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: mockQueueAdd })),
}));
jest.mock('../../core/diagnostics', () => ({ diagnoseMember: jest.fn(), getTimeline: jest.fn() }));
jest.mock('../../core/reconciliation', () => ({ reconcileMember: jest.fn() }));
jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers: jest.fn(), reactivateLocationMembers: jest.fn(),
}));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ getGroups: jest.fn(), getLocks: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(), findUserByEmail: jest.fn(), createUser: jest.fn(),
  assignRole: jest.fn(), removeRole: jest.fn(),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
  runWith: jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-test'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));
const mockSend = jest.fn().mockResolvedValue({ data: { id: 'resend-1' } });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend } })) }));

const db = require('../../db');

const HOG   = '11111111-1111-4111-8111-111111111111';
const GYM_B = '22222222-2222-4222-8222-222222222222';
const SECRET = process.env.ADMIN_JWT_SECRET;

const adminToken    = () => jwt.sign({ role: 'admin' }, SECRET);
const operatorToken = (clientId) => jwt.sign({ role: 'operator', clientId, instanceId: null }, SECRET);

beforeEach(() => {
  db.query.mockReset();
  mockQueueAdd.mockClear();
  mockSend.mockClear();
});

// ── 1. Owner-only middleware ────────────────────────────────────────────────
describe('[P3] tenant isolation — owner-only routes refuse operator tokens', () => {
  const { requireAuth, requireAuthPage } = require('../../admin/middleware/auth');

  function app() {
    const a = express();
    a.use(cookieParser());
    a.get('/api', requireAuth, (req, res) => res.json({ ok: true }));
    a.get('/page', requireAuthPage, (req, res) => res.send('owner page'));
    return a;
  }

  test('owner token passes requireAuth', async () => {
    const res = await request(app()).get('/api').set('Cookie', `adminToken=${adminToken()}`);
    expect(res.status).toBe(200);
  });

  test('operator token replayed as adminToken is refused by requireAuth', async () => {
    const res = await request(app()).get('/api').set('Cookie', `adminToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(403);
  });

  test('operator token replayed as adminToken is bounced by requireAuthPage', async () => {
    const res = await request(app()).get('/page').set('Cookie', `adminToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/OwnerDashboard');
  });
});

// ── 2. Operator API client scope ────────────────────────────────────────────
describe('[P3] tenant isolation — operator API is pinned to the session client', () => {
  let app;
  beforeAll(() => {
    const operatorRouter = require('../../admin/routes/operator');
    app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/operator', operatorRouter);
  });

  test("gym B's operator cannot touch House of Gains' data", async () => {
    const res = await request(app)
      .post(`/operator/${HOG}/alerts/alert-1/dismiss`)
      .set('Cookie', `operatorToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test("gym B's operator cannot read House of Gains' members", async () => {
    const res = await request(app)
      .get(`/operator/${HOG}/members`)
      .set('Cookie', `operatorToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('/clients/:clientId routes are scoped too', async () => {
    const res = await request(app)
      .put(`/operator/clients/${HOG}/notification-email`)
      .send({ notification_email: 'attacker@example.com' })
      .set('Cookie', `operatorToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(403);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('an operator reaches its own client', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'alert-1', resolved_at: '2026-10-01T00:00:00.000Z' }] });
    const res = await request(app)
      .post(`/operator/${GYM_B}/alerts/alert-1/dismiss`)
      .set('Cookie', `operatorToken=${operatorToken(GYM_B)}`);
    expect(res.status).toBe(200);
    expect(db.query.mock.calls[0][1]).toContain(GYM_B);
  });

  test('the owner reaches any client', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'alert-1', resolved_at: '2026-10-01T00:00:00.000Z' }] });
    const res = await request(app)
      .post(`/operator/${HOG}/alerts/alert-1/dismiss`)
      .set('Cookie', `adminToken=${adminToken()}`);
    expect(res.status).toBe(200);
  });

  test('POST /sync/run ignores a body clientId from an operator', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // client lookup → 404, enough to see which id was used
    await request(app)
      .post('/operator/sync/run')
      .send({ clientId: HOG })
      .set('Cookie', `operatorToken=${operatorToken(GYM_B)}`);
    expect(db.query.mock.calls[0][1]).toEqual([GYM_B]);
  });
});

// ── 3 + 4. Webhook tenant routing ───────────────────────────────────────────
describe('[P3] tenant isolation — webhook routing is bound to the signing client', () => {
  let processor;
  let tenantResolver;

  beforeAll(() => {
    tenantResolver = require('../../core/tenant-resolver');
    processor = require('../../core/webhook-processor');
  });

  beforeEach(() => {
    tenantResolver.clearCache();
    // Default DB: no duplicates, clients table lookups answered per test via SQL text.
    db.query.mockImplementation(async (sql, params) => {
      if (/FROM processed_event_ids/.test(sql)) return { rows: [] };
      if (/FROM clients WHERE source_site_id/.test(sql)) {
        return params[0] === 'site-hog' ? { rows: [{ id: HOG }] }
             : params[0] === 'site-b'   ? { rows: [{ id: GYM_B }] }
             : { rows: [] };
      }
      if (/FROM clients WHERE id = \$1 AND status = 'active'/.test(sql)) {
        return [HOG, GYM_B].includes(params[0]) ? { rows: [{ id: params[0] }] } : { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  const event = (extra) => ({
    eventType: 'plan.purchased', platformMemberId: 'm-1', planId: 'p-1', traceId: 't-1', ...extra,
  });

  test("gym B's signed event naming House of Gains' site is rejected, not routed", async () => {
    await processor.processIncoming('evt-x', event({ platformClientIdHint: GYM_B, wixSiteId: 'site-hog' }), '{}');
    expect(mockQueueAdd).not.toHaveBeenCalled();
    const alert = db.query.mock.calls.find(([sql]) => /INSERT INTO config_alert_log/.test(sql));
    expect(alert[1][0]).toBe(GYM_B);
    expect(alert[1][1]).toBe('tenant_mismatch');
  });

  test('client id + matching site routes to that client', async () => {
    await processor.processIncoming('evt-y', event({ platformClientIdHint: GYM_B, wixSiteId: 'site-b' }), '{}');
    expect(mockQueueAdd).toHaveBeenCalledWith('grant', expect.objectContaining({ tenantId: GYM_B }), expect.anything());
  });

  test('Velo path (client id, no site id) routes to the client id', async () => {
    await processor.processIncoming('evt-z', event({ platformClientIdHint: HOG }), '{}');
    expect(mockQueueAdd).toHaveBeenCalledWith('grant', expect.objectContaining({ tenantId: HOG }), expect.anything());
  });

  test('REST path (site id only) routes by site', async () => {
    await processor.processIncoming('evt-w', event({ wixSiteId: 'site-hog' }), '{}');
    expect(mockQueueAdd).toHaveBeenCalledWith('grant', expect.objectContaining({ tenantId: HOG }), expect.anything());
  });

  test('unknown site is dropped even with DEFAULT_TENANT_ID set — never lands on House of Gains', async () => {
    const prev = process.env.DEFAULT_TENANT_ID;
    process.env.DEFAULT_TENANT_ID = HOG;
    try {
      await processor.processIncoming('evt-u', event({ wixSiteId: 'site-unknown' }), '{}');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_TENANT_ID; else process.env.DEFAULT_TENANT_ID = prev;
    }
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(([sql]) => /UPDATE clients SET source_site_id/.test(sql))).toBe(false);
    const alert = db.query.mock.calls.find(([sql]) => /INSERT INTO config_alert_log/.test(sql));
    expect(alert[1][0]).toBeNull();
  });
});

// ── 5. Member email recipient scope ─────────────────────────────────────────
describe('[P3] tenant isolation — member emails only resolve members of the sending gym', () => {
  const mailer = require('../../core/member-mailer');

  test('grant email recipient lookup is scoped by client_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // access row not in this client → no recipient
    const r = await mailer.maybeSendGrantEmail({
      clientId: GYM_B, accessId: 'access-of-a-hog-member', standardEvent: { eventType: 'plan.purchased' }, assignments: [],
    });
    expect(r).toEqual({ sent: false, reason: 'no_recipient' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/ma\.client_id = \$2/);
    expect(params).toEqual(['access-of-a-hog-member', GYM_B]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each([
    ['captureAccessRemovedContext', { standardEvent: { eventType: 'plan.cancelled' } }],
    ['maybeSendAccessSuspendedEmail', { standardEvent: { eventType: 'payment.failed' } }],
    ['maybeSendAccessRestoredEmail', { standardEvent: { eventType: 'payment.recovered' } }],
    ['maybeSendDayPassEmail', { standardEvent: { eventType: 'plan.purchased' }, links: [{ mappingId: null }] }],
  ])('%s scopes its recipient lookup by client_id', async (fn, args) => {
    db.query.mockResolvedValue({ rows: [] });
    await mailer[fn]({ clientId: GYM_B, accessId: 'acc-1', ...args });
    const lookup = db.query.mock.calls.find(([sql]) => /FROM member_access ma JOIN member_master/.test(sql));
    expect(lookup[0]).toMatch(/ma\.client_id = \$2/);
    expect(lookup[1]).toEqual(['acc-1', GYM_B]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ── 6. Wix dashboard instance wiring ────────────────────────────────────────
describe('[P3] tenant isolation — forged authorizationCode cannot claim a wired gym', () => {
  const { requireWixInstance } = require('../../admin/middleware/wix-instance');

  function signedInstance(payload) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', process.env.WIX_APP_SECRET).update(data).digest('base64url');
    return `${sig}.${data}`;
  }
  function forgedAuthCode(siteId) {
    const body = Buffer.from(JSON.stringify({ data: JSON.stringify({ decodedToken: { siteId } }) })).toString('base64url');
    return `x.${body}.y`;
  }
  function run(siteId) {
    const req = {
      query: {
        instance: signedInstance({ instanceId: 'attacker-instance', uid: 'u1', siteOwnerId: 'u1' }),
        authorizationCode: forgedAuthCode(siteId),
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn(), redirect: jest.fn() };
    const next = jest.fn();
    return requireWixInstance(req, res, next).then(() => ({ res, next }));
  }

  test('Path B only considers clients with no platform_instance_id yet', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })  // Path A: unknown instance
      .mockResolvedValueOnce({ rows: [] }); // Path B: HOG is already wired → not claimable
    const { res, next } = await run('site-hog');
    expect(next).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalled();
    expect(db.query.mock.calls[1][0]).toMatch(/platform_instance_id IS NULL/);
    expect(db.query.mock.calls.some(([sql]) => /UPDATE clients SET platform_instance_id/.test(sql))).toBe(false);
  });

  test('a lost race on the wiring UPDATE is refused, not granted', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: HOG, source_site_id: 'site-hog' }] })
      .mockResolvedValueOnce({ rows: [] }); // UPDATE ... WHERE platform_instance_id IS NULL matched nothing
    const { res, next } = await run('site-hog');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});
