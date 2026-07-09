/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  DR-052 — email-branding operator routes (admin/routes/operator.js)     │
 * │                                                                         │
 * │  Route-level unit tests (mock db, mock auth, mock member-mailer, stub   │
 * │  fetch for the Supabase Storage upload). Guards the "Set up logo" API:  │
 * │  GET/PUT branding, logo upload (mime/size/service-key), the live        │
 * │  preview (real template render), and the test-send (admin contact       │
 * │  only, bypasses the ship-dark gate).                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const express = require('express');
const request = require('supertest');

// ── Shared mocks (per admin-routes-new-schema.test.js precedent) ─────────────

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(v => `dec-${v}`),
  encryptApiKey: jest.fn(v => `enc-${v}`),
}));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({ host: 'localhost', port: 6379 })),
}));
jest.mock('bullmq', () => ({
  Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })),
}));
jest.mock('../../core/diagnostics', () => ({ diagnoseMember: jest.fn(), getTimeline: jest.fn() }));
jest.mock('../../core/reconciliation', () => ({ reconcileMember: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../core/location-lapse', () => ({
  suspendLocationMembers: jest.fn(), reactivateLocationMembers: jest.fn(),
}));
jest.mock('../../admin/middleware/audit', () => ({ logAdminAction: jest.fn() }));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ getGroups: jest.fn(), getLocks: jest.fn() }));
jest.mock('../../adapters/kisi/kisi-adapter', () => ({}));
jest.mock('../../adapters/standard-adapter', () => ({}));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(), findUserByEmail: jest.fn(), createUser: jest.fn(),
  assignRole: jest.fn(), removeRole: jest.fn(),
}));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth:               (_req, _res, next) => next(),
  requireAuthPage:           (_req, _res, next) => next(),
  requireAuthPageOrOperator: (_req, _res, next) => next(),
  requireAuthOrOperator:     (_req, _res, next) => next(),
  requireInviteToken:        (_req, _res, next) => next(),
  signToken:                 jest.fn(() => 'mock-token'),
  signOperatorToken:         jest.fn(() => 'mock-op-token'),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-dr052-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(),
  runWith: jest.fn((_ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-dr052-mint'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));
jest.mock('../../core/member-mailer', () => ({ sendMemberEmail: jest.fn() }));

const db = require('../../db');
const memberMailer = require('../../core/member-mailer');

const CLIENT = 'client-uuid-052';
let app;

beforeAll(() => {
  process.env.SUPABASE_SECRET_KEY = 'test-service-key';
  const operatorRouter = require('../../admin/routes/operator');
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { clientId: CLIENT, role: 'admin' }; next(); });
  app.use('/operator', operatorRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  global.fetch = jest.fn();
});

const BRANDING_ROW = {
  email_logo_url: 'https://x.supabase.co/storage/v1/object/public/email-assets/c/logo.png?v=1',
  email_primary_color: '#112233',
  email_secondary_color: '#445566',
  member_emails_enabled: false,
};

describe('[P2] DR-052 GET /operator/clients/:id/email-branding', () => {
  test('returns the branding shape', async () => {
    db.query.mockResolvedValueOnce({ rows: [BRANDING_ROW] });
    const res = await request(app).get(`/operator/clients/${CLIENT}/email-branding`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      logoUrl: BRANDING_ROW.email_logo_url,
      primaryColor: '#112233',
      secondaryColor: '#445566',
      enabled: false,
    });
  });
  test('404 when client missing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/operator/clients/${CLIENT}/email-branding`);
    expect(res.status).toBe(404);
  });
});

describe('[P2] DR-052 PUT /operator/clients/:id/email-branding', () => {
  test('rejects non-hex colors', async () => {
    const res = await request(app).put(`/operator/clients/${CLIENT}/email-branding`)
      .send({ primaryColor: 'red', secondaryColor: '#445566' });
    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
  test('rejects non-boolean enabled', async () => {
    const res = await request(app).put(`/operator/clients/${CLIENT}/email-branding`)
      .send({ primaryColor: '#112233', secondaryColor: '#445566', enabled: 'yes' });
    expect(res.status).toBe(400);
  });
  test('saves valid colors + toggle', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: CLIENT }] });
    const res = await request(app).put(`/operator/clients/${CLIENT}/email-branding`)
      .send({ primaryColor: '#112233', secondaryColor: '#445566', enabled: true });
    expect(res.status).toBe(200);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('UPDATE clients');
    expect(sql).toContain('member_emails_enabled');
    expect(params).toEqual(['#112233', '#445566', true, CLIENT]);
  });
});

describe('[P2] DR-052 POST /operator/clients/:id/email-branding/logo', () => {
  test('503 with clear message when service key missing', async () => {
    const saved = process.env.SUPABASE_SECRET_KEY;
    delete process.env.SUPABASE_SECRET_KEY;
    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/logo`)
      .attach('logo', Buffer.from([0x89, 0x50]), { filename: 'l.png', contentType: 'image/png' });
    process.env.SUPABASE_SECRET_KEY = saved;
    expect(res.status).toBe(503);
  });
  test('400 on non-image mime', async () => {
    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/logo`)
      .attach('logo', Buffer.from('GIF89a'), { filename: 'l.gif', contentType: 'image/gif' });
    expect(res.status).toBe(400);
  });
  test('400 when file exceeds 1MB (multer limit)', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 1);
    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/logo`)
      .attach('logo', big, { filename: 'l.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 MB/);
  });
  test('happy path: uploads to Supabase Storage with x-upsert, stores versioned public URL', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: CLIENT }] })  // client exists
      .mockResolvedValueOnce({ rows: [] });               // UPDATE clients
    global.fetch.mockResolvedValueOnce({ ok: true, text: async () => '' });

    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/logo`)
      .attach('logo', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'l.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.logoUrl).toMatch(/\/storage\/v1\/object\/public\/email-assets\/.+\/logo\.png\?v=\d+/);

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toContain(`/storage/v1/object/email-assets/${CLIENT}/logo.png`);
    expect(opts.headers['x-upsert']).toBe('true');
    // 2026 Supabase secret keys go on `apikey` only — Authorization must be absent,
    // or the platform tries to parse the opaque sb_secret_ value as a JWT and 401s.
    expect(opts.headers['apikey']).toBe('test-service-key');
    expect(opts.headers['Authorization']).toBeUndefined();

    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain('email_logo_url');
  });
});

describe('[P2] DR-052 GET /operator/clients/:id/email-branding/preview', () => {
  const BASE_ROW = { name: 'House of Gains', notification_email: 'chad@hog.com', email_logo_url: null, email_primary_color: '#000000', email_secondary_color: '#000000' };

  test('renders the REAL template as text/html with query overrides applied', async () => {
    db.query.mockResolvedValueOnce({ rows: [BASE_ROW] });
    const res = await request(app)
      .get(`/operator/clients/${CLIENT}/email-branding/preview`)
      .query({ primary: '#aabbcc', secondary: '#ddeeff' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('background-color:#aabbcc');   // unsaved override applied
    expect(res.text).toContain('House of Gains');
    expect(res.text).toContain('Powered by AccessSync');
  });

  test('defaults to the access-ready demo when no type is given', async () => {
    db.query.mockResolvedValueOnce({ rows: [BASE_ROW] });
    const res = await request(app).get(`/operator/clients/${CLIENT}/email-branding/preview`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/access is ready/i);
  });

  test('type=access_removed renders the access-removed demo', async () => {
    db.query.mockResolvedValueOnce({ rows: [BASE_ROW] });
    const res = await request(app)
      .get(`/operator/clients/${CLIENT}/email-branding/preview`)
      .query({ type: 'access_removed' });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/access has ended/i);
  });

  test('type=sub_member_invite renders the sub-member-invite demo with sample holder name', async () => {
    db.query.mockResolvedValueOnce({ rows: [BASE_ROW] });
    const res = await request(app)
      .get(`/operator/clients/${CLIENT}/email-branding/preview`)
      .query({ type: 'sub_member_invite' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Daxx Roberts');
    expect(res.text).toContain('Family Plan');
  });

  test('unknown type falls back to the access-ready demo rather than erroring', async () => {
    db.query.mockResolvedValueOnce({ rows: [BASE_ROW] });
    const res = await request(app)
      .get(`/operator/clients/${CLIENT}/email-branding/preview`)
      .query({ type: 'not_a_real_type' });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/access is ready/i);
  });
});

describe('[P2] DR-052 POST /operator/clients/:id/email-branding/test-send', () => {
  test('400 when no notification email is set', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ notification_email: null }] });
    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/test-send`);
    expect(res.status).toBe(400);
    expect(memberMailer.sendMemberEmail).not.toHaveBeenCalled();
  });
  test('sends via the real mailer to the ADMIN CONTACT ONLY, bypassing the ship-dark gate', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ notification_email: 'chad@hog.com' }] });
    memberMailer.sendMemberEmail.mockResolvedValueOnce({ sent: true });
    const res = await request(app).post(`/operator/clients/${CLIENT}/email-branding/test-send`)
      .send({ to: 'attacker@evil.com' }); // body-supplied address must be ignored
    expect(res.status).toBe(200);
    const arg = memberMailer.sendMemberEmail.mock.calls[0][0];
    expect(arg.recipient).toBe('chad@hog.com');
    expect(arg.bypassEnabledGate).toBe(true);
    expect(arg.emailType).toBe('test');
  });
});
