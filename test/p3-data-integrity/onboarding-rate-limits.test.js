/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Brute-force limits on the three credentials a guess can reach:         │
 * │    · POST /auth/pin        owner login (every client's data)            │
 * │    · POST /onboard/redeem  invite → gym session                         │
 * │    · POST /operator/verify-bypass  owner PIN inside the wizard          │
 * │                                                                         │
 * │  Before: /auth/pin had no limit anywhere in the admin app, and the      │
 * │  owner PIN is short by nature. Real express-rate-limit here, a fresh    │
 * │  module graph per test so each gets its own budget.                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.OWNER_PIN = 'correct-owner-pin';

const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), getClient: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: v => v, encryptApiKey: v => v }));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../core/diagnostics', () => ({ diagnoseMember: jest.fn(), getTimeline: jest.fn() }));
jest.mock('../../core/reconciliation', () => ({ reconcileMember: jest.fn() }));
jest.mock('../../core/location-lapse', () => ({ suspendLocationMembers: jest.fn(), reactivateLocationMembers: jest.fn() }));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ getGroups: jest.fn(), getLocks: jest.fn(), makeRequest: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({ getLocks: jest.fn() }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(), getActor: jest.fn(() => ({})), setTraceContext: jest.fn(),
  runWith: jest.fn((c, fn) => fn()), mintTraceId: jest.fn(() => 't'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));

/** Fresh limiter state: re-require the routers inside an isolated module registry. */
function freshApp() {
  let app;
  jest.isolateModules(() => {
    const { signOperatorToken } = require('../../admin/middleware/auth');
    app = express();
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, '../../admin/views'));
    app.use(express.json());
    app.use(cookieParser());
    app.use('/auth', require('../../admin/routes/auth'));
    app.use('/onboard', require('../../admin/routes/onboarding'));
    app.use('/operator', require('../../admin/routes/operator'));
    app.operatorCookie = (cid) => `operatorToken=${signOperatorToken(cid, null)}`;
  });
  return app;
}

const pin = (app, p) => request(app).post('/auth/pin').send({ pin: p });

describe('[P3] /auth/pin — owner login cannot be brute-forced', () => {
  test('10 wrong PINs are answered 401, the 11th is 429 and no cookie is ever set', async () => {
    const app = freshApp();
    for (let i = 0; i < 10; i++) expect((await pin(app, `wrong-${i}`)).status).toBe(401);
    const blocked = await pin(app, 'wrong-11');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatch(/too many/i);
    expect(blocked.headers['set-cookie']).toBeUndefined();
  });

  test('once locked out, even the CORRECT pin from that address is refused until the window passes', async () => {
    const app = freshApp();
    for (let i = 0; i < 10; i++) await pin(app, `wrong-${i}`);
    const res = await pin(app, process.env.OWNER_PIN);
    expect(res.status).toBe(429);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('successful logins do not spend the failure budget (the owner is not locked out by their own use)', async () => {
    const app = freshApp();
    for (let i = 0; i < 25; i++) expect((await pin(app, process.env.OWNER_PIN)).status).toBe(200);
    expect((await pin(app, 'wrong')).status).toBe(401);
  });

  test('the Google sign-in POST is limited the same way', async () => {
    const app = freshApp();
    process.env.ADMIN_ALLOWED_EMAIL = 'owner@example.test';
    const attempt = () => request(app).post('/auth/google').send({ credential: 'forged' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).not.toBe(429);
    expect((await attempt()).status).toBe(429);
  });
});

describe('[P3] /onboard/redeem — guessing links is throttled', () => {
  test('10 bad tokens per minute per address, then 429 with a message the page can show', async () => {
    const app = freshApp();
    for (let i = 0; i < 10; i++) expect((await request(app).post('/onboard/redeem').send({ token: `bad.${i}` })).status).toBe(400);
    const res = await request(app).post('/onboard/redeem').send({ token: 'bad.11' });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'rate_limited' });
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('[P3] /operator/verify-bypass — the in-wizard PIN is throttled too', () => {
  test('10 wrong PINs → 403 each, then 429', async () => {
    const app = freshApp();
    const cookie = app.operatorCookie('22222222-2222-4222-8222-222222222222');
    const attempt = (p) => request(app).post('/operator/verify-bypass').set('Cookie', cookie).send({ pin: p });
    for (let i = 0; i < 10; i++) expect((await attempt(`nope-${i}`)).status).toBe(403);
    expect((await attempt('nope-11')).status).toBe(429);
  });
});
