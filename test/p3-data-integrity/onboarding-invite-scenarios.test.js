/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: onboarding a second gym next to House of Gains               │
 * │                                                                         │
 * │  Real routers + REAL auth middleware + real invite module. Only the     │
 * │  database, Kisi/hardware clients and the queue are faked.               │
 * │                                                                         │
 * │  A. The old holes stay closed (header bypass, public token, takeover).  │
 * │  B. Invite lifecycle — the "what if it doesn't work" scenarios:         │
 * │     never arrives · scanner opens it first · expires · tampered ·       │
 * │     revoked · second device · double click · forwarded · no secret.     │
 * │  C. Owner issuance — owner-only, never depends on email, never logs it. │
 * │  D. Sessions and the wizard — lost session, resume, owner-assisted.     │
 * │  E. House of Gains is untouched.                                        │
 * │                                                                         │
 * │  Rate limits are exercised separately (onboarding-rate-limits.test.js)  │
 * │  with the real limiter; here it is a pass-through so tests don't share  │
 * │  one budget.                                                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

process.env.ADMIN_JWT_SECRET = 'test-admin-jwt-secret';
process.env.OPERATOR_INVITE_TOKEN = 'legacy-shared-token-must-never-work';
process.env.ADMIN_HUB_URL = 'https://admin.example.test';
delete process.env.INVITE_SIGNING_SECRET;
delete process.env.INVITE_TTL_HOURS;

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
const mockLogCalls = [];
jest.mock('../../core/logger', () => {
  const rec = (level) => (...a) => { mockLogCalls.push([level, ...a]); };
  return { log: { info: rec('info'), warn: rec('warn'), error: rec('error'), critical: rec('critical') } };
});
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(v => String(v).replace(/^ENC\[(.+)\]$/, '$1')),
  encryptApiKey: jest.fn(v => `ENC[${v}]`),
}));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../core/diagnostics', () => ({ diagnoseMember: jest.fn(), getTimeline: jest.fn() }));
jest.mock('../../core/reconciliation', () => ({ reconcileMember: jest.fn() }));
jest.mock('../../core/location-lapse', () => ({ suspendLocationMembers: jest.fn(), reactivateLocationMembers: jest.fn() }));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ getGroups: jest.fn().mockResolvedValue([]), getLocks: jest.fn(), makeRequest: jest.fn().mockResolvedValue({}) }));
jest.mock('../../adapters/hardware-adapter', () => ({ getLocks: jest.fn(), getGroups: jest.fn().mockResolvedValue([]), findUserByEmail: jest.fn(), createUser: jest.fn(), assignRole: jest.fn(), removeRole: jest.fn() }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-test'), getActor: jest.fn(() => ({ type: 'system', id: 'test' })),
  setTraceContext: jest.fn(), runWith: jest.fn((c, fn) => fn()), mintTraceId: jest.fn(() => 'trace-test'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));
jest.mock('../../admin/middleware/audit', () => ({ logAdminAction: jest.fn() }));
const mockResendSend = jest.fn().mockResolvedValue({ data: { id: 'r1' } });
jest.mock('resend', () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockResendSend } })) }));

const db = require('../../db');
const { recordActivity } = require('../../admin/middleware/activity');
const { signToken, signOperatorToken, requireAuth } = require('../../admin/middleware/auth');
const { signInvite, verifyInvite } = require('../../core/invite-token');

const HOG    = '11111111-1111-4111-8111-111111111111';
const GYM_B  = '22222222-2222-4222-8222-222222222222';
const GONE   = '33333333-3333-4333-8333-333333333333';   // archived
const SECRET = process.env.ADMIN_JWT_SECRET;

// ── tiny fake database ──────────────────────────────────────────────────────
let clients;
function resetDb() {
  clients = {
    [HOG]:   { id: HOG,   name: 'House of Gains', status: 'active',   notification_email: 'chad@hog.test', source_site_id: 'site-hog', source_site_name: 'HOG', has_wix_key: true },
    [GYM_B]: { id: GYM_B, name: 'Gym B',          status: 'active',   notification_email: 'b@gymb.test',   source_site_id: null,       source_site_name: null,  has_wix_key: false },
    [GONE]:  { id: GONE,  name: 'Old Gym',        status: 'archived', notification_email: 'x@old.test',    source_site_id: null,       source_site_name: null,  has_wix_key: false },
  };
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params = []) => {
    if (/UPDATE clients SET wix_webhook_secret/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT id FROM clients WHERE source_site_id/.test(sql)) {
      const hit = Object.values(clients).find(c => c.source_site_id === params[0]);
      return { rows: hit ? [{ id: hit.id }] : [] };
    }
    if (/FROM clients WHERE id = \$1/.test(sql)) {
      const c = clients[params[0]];
      return { rows: c ? [c] : [] };
    }
    if (/UPDATE clients\s+SET name/.test(sql)) return { rows: [{ id: params[0], name: params[1], status: 'active' }] };
    if (/FROM connector_subscriptions/.test(sql)) return { rows: [] };
    if (/FROM locations l/.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
}

const ownerCookie    = () => `adminToken=${signToken()}`;
const operatorCookie = (cid) => `operatorToken=${signOperatorToken(cid, null)}`;
const expiredOperatorCookie = (cid) =>
  `operatorToken=${jwt.sign({ role: 'operator', clientId: cid, instanceId: null }, SECRET, { expiresIn: -60 })}`;
const tokenFromUrl = (url) => decodeURIComponent(new URL(url).searchParams.get('invite'));
const bootOf = (html) => JSON.parse(html.match(/const BOOT = (\{.*?\});\n/s)[1].replace(/\\u003c/g, '<').replace(/\\u003e/g, '>').replace(/\\u0026/g, '&'));

let app;
beforeAll(() => {
  app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../../admin/views'));
  app.use(express.json());
  app.use(cookieParser());
  app.use('/onboard', require('../../admin/routes/onboarding'));
  app.use('/operator', require('../../admin/routes/operator'));
  app.use('/admin/clients', requireAuth, require('../../admin/routes/clients'));
});
beforeEach(() => { resetDb(); mockLogCalls.length = 0; mockResendSend.mockClear(); recordActivity.mockClear(); });

// ═══ A. The old holes stay closed ═══════════════════════════════════════════
describe('[P3] A. onboarding holes stay closed', () => {
  const formerlyExempt = [
    ['get',  `/operator/${HOG}/locations`],
    ['get',  `/operator/${HOG}/locations/loc-1/mappings`],
    ['get',  `/operator/clients/${HOG}/kisi-groups`],
    ['get',  `/operator/clients/${HOG}/api-key/status`],
    ['get',  `/operator/clients/${HOG}/api-key/test`],
    ['get',  `/operator/site-id/verify?siteId=${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`],
    ['post', `/operator/clients/${HOG}/api-key`],
    ['post', `/operator/clients/${HOG}/locations`],
    ['post', `/operator/clients/${HOG}/locations/loc-1/activate`],
    ['post', '/operator/issue-session'],
    ['post', '/operator/clients'],
    ['post', '/operator/verify-bypass'],
  ];

  test.each(formerlyExempt)('anonymous %s %s is refused whatever header is sent', async (method, url) => {
    for (const headers of [{}, { 'x-invite-token': 'x' }, { 'x-invite-token': process.env.OPERATOR_INVITE_TOKEN }]) {
      const res = await request(app)[method](url).set(headers).send({});
      expect(res.status).toBe(401);
    }
    expect(db.query).not.toHaveBeenCalled();   // refused before touching data
  });

  test('a gym cannot create clients, nor take over an existing one, via the old upsert', async () => {
    const res = await request(app).post('/operator/clients').set('Cookie', operatorCookie(GYM_B))
      .send({ name: 'Takeover', source_site_id: 'site-hog', platform_instance_id: 'attacker' });
    expect(res.status).toBe(404);   // route no longer exists
    expect(db.query.mock.calls.some(([sql]) => /INSERT INTO clients|platform_instance_id/.test(sql))).toBe(false);
  });

  test('the public /onboard page never contains a shared token or header name, in any state', async () => {
    const valid = signInvite({ clientId: GYM_B }).token;
    const pages = [
      await request(app).get('/onboard'),
      await request(app).get(`/onboard?invite=${encodeURIComponent(valid)}`),
      await request(app).get('/onboard?invite=garbage'),
      await request(app).get('/onboard').set('Cookie', operatorCookie(GYM_B)),
    ];
    for (const res of pages) {
      expect(res.text).not.toContain(process.env.OPERATOR_INVITE_TOKEN);
      expect(res.text).not.toMatch(/X-Invite-Token/i);
      expect(res.text).not.toMatch(/inviteToken/);
    }
  });

  test('the legacy shared token has no power anywhere', async () => {
    const asInvite = await request(app).post('/onboard/redeem').send({ token: process.env.OPERATOR_INVITE_TOKEN });
    expect(asInvite.status).toBe(400);
    const asHeader = await request(app).get(`/operator/${HOG}/members`).set('x-invite-token', process.env.OPERATOR_INVITE_TOKEN);
    expect(asHeader.status).toBe(401);
  });
});

// ═══ B. Invite lifecycle ════════════════════════════════════════════════════
describe('[P3] B. invite lifecycle — the "what if it doesn\'t work" scenarios', () => {
  const issue = async (clientId = GYM_B) => {
    const res = await request(app).post(`/admin/clients/${clientId}/invite`).set('Cookie', ownerCookie());
    expect(res.status).toBe(200);
    return { url: res.body.url, token: tokenFromUrl(res.body.url), body: res.body };
  };

  test('happy path: owner issues → gym opens → Start setup → scoped session → wizard', async () => {
    const { url } = await issue();
    expect(url.startsWith('https://admin.example.test/onboard?invite=')).toBe(true);

    const page = await request(app).get(new URL(url).pathname + new URL(url).search);
    expect(bootOf(page.text)).toMatchObject({ mode: 'invite', clientName: 'Gym B' });
    expect(page.headers['set-cookie']).toBeUndefined();            // opening the link changes nothing

    const redeem = await request(app).post('/onboard/redeem').send({ token: tokenFromUrl(url) });
    expect(redeem.status).toBe(200);
    expect(redeem.body).toMatchObject({ ok: true, clientId: GYM_B });
    const cookie = redeem.headers['set-cookie'][0];
    expect(cookie).toMatch(/operatorToken=/);
    expect(cookie).toMatch(/HttpOnly/i);

    const mine   = await request(app).get(`/operator/${GYM_B}/onboarding-status`).set('Cookie', cookie.split(';')[0]);
    const theirs = await request(app).get(`/operator/${HOG}/onboarding-status`).set('Cookie', cookie.split(';')[0]);
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(403);                               // scoped to ONE client
  });

  test('the person who never gets the invite: the owner just makes another, and nothing breaks', async () => {
    const first  = await issue();
    const second = await issue();
    expect(second.token).not.toBe(first.token);
    for (const t of [first.token, second.token]) {
      const r = await request(app).post('/onboard/redeem').send({ token: t });
      expect(r.status).toBe(200);
    }
  });

  test('email delivery is not on the critical path: issuing works with email unconfigured and sends nothing', async () => {
    delete process.env.RESEND_API_KEY;
    const { body } = await issue();
    expect(body.ok).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  test('an email link scanner opening the link first does not burn it', async () => {
    const { url } = await issue();
    const path_ = new URL(url).pathname + new URL(url).search;
    for (let i = 0; i < 5; i++) {
      const scan = await request(app).get(path_).set('User-Agent', 'SafeLinks-Scanner');
      expect(scan.status).toBe(200);
      expect(scan.headers['set-cookie']).toBeUndefined();
    }
    const human = await request(app).post('/onboard/redeem').send({ token: tokenFromUrl(url) });
    expect(human.status).toBe(200);
  });

  test('opened on a second device / browser, or double-clicked: every redeem works', async () => {
    const { token } = await issue();
    const results = await Promise.all([1, 2, 3].map(() => request(app).post('/onboard/redeem').send({ token })));
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    const clientIds = new Set(results.map(r => r.body.clientId));
    expect([...clientIds]).toEqual([GYM_B]);
  });

  test('expired link: friendly "expired" screen, no session, and a fresh link fixes it', async () => {
    const old = signInvite({ clientId: GYM_B, now: Date.now() - 4 * 24 * 3_600_000 });
    expect(verifyInvite(old.token)).toEqual({ ok: false, reason: 'expired' });

    const page = await request(app).get(`/onboard?invite=${encodeURIComponent(old.token)}`);
    expect(bootOf(page.text)).toMatchObject({ mode: 'blocked', reason: 'invite_expired' });

    const redeem = await request(app).post('/onboard/redeem').send({ token: old.token });
    expect(redeem.status).toBe(410);
    expect(redeem.body.error).toBe('invite_expired');
    expect(redeem.headers['set-cookie']).toBeUndefined();

    const fresh = await issue();
    expect((await request(app).post('/onboard/redeem').send({ token: fresh.token })).status).toBe(200);
  });

  test.each([
    ['empty string',        () => ''],
    ['not a string',        () => ({ evil: true })],
    ['no dot',              () => 'abcdef'],
    ['oversized',           () => 'a'.repeat(5000) + '.' + 'b'.repeat(50)],
    ['truncated copy',      () => signInvite({ clientId: GYM_B }).token.slice(0, -6)],
    ['signature swapped',   () => signInvite({ clientId: GYM_B }).token.split('.')[0] + '.' + signInvite({ clientId: HOG }).token.split('.')[1]],
    ['a session JWT',       () => signOperatorToken(GYM_B, null)],
    ['a different purpose', () => {
      const payload = Buffer.from(JSON.stringify({ p: 'day-pass-qr', c: GYM_B, e: Date.now() + 1e6 })).toString('base64url');
      const key = crypto.createHmac('sha256', SECRET).update('accesssync/invite-signing/v1').digest();
      return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
    }],
  ])('%s is rejected without a session or a data lookup', async (_label, make) => {
    const token = make();
    const res = await request(app).post('/onboard/redeem').send({ token });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invite_invalid');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a link for one gym cannot be edited into a link for another (House of Gains)', async () => {
    const { token } = await issue(GYM_B);
    const [payload, sig] = token.split('.');
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    data.c = HOG;
    const forged = Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + sig;
    const res = await request(app).post('/onboard/redeem').send({ token: forged });
    expect(res.status).toBe(400);
  });

  test('a forwarded link only ever opens its own gym — never another gym, never the owner', async () => {
    const { token } = await issue(GYM_B);
    const redeem = await request(app).post('/onboard/redeem').send({ token });
    const cookie = redeem.headers['set-cookie'][0].split(';')[0];
    for (const url of [`/operator/${HOG}/members`, `/operator/${HOG}/locations`, `/operator/${HOG}/onboarding-status`]) {
      expect((await request(app).get(url).set('Cookie', cookie)).status).toBe(403);
    }
    // …nor can that session pose as the owner on the owner routes.
    const asOwner = await request(app).post(`/admin/clients/${HOG}/invite`).set('Cookie', cookie.replace('operatorToken', 'adminToken'));
    expect(asOwner.status).toBe(403);
    const direct = await request(app).post(`/admin/clients/${HOG}/invite`).set('Cookie', cookie);
    expect(direct.status).toBe(401);
  });

  test('revoked by archiving the client: link and page both say so, no session is issued', async () => {
    const stale = signInvite({ clientId: GONE });
    const page = await request(app).get(`/onboard?invite=${encodeURIComponent(stale.token)}`);
    expect(bootOf(page.text)).toMatchObject({ mode: 'blocked', reason: 'invite_revoked' });
    const redeem = await request(app).post('/onboard/redeem').send({ token: stale.token });
    expect(redeem.status).toBe(410);
    expect(redeem.body.error).toBe('invite_revoked');
    expect(redeem.headers['set-cookie']).toBeUndefined();
  });

  test('a deleted client behaves like an archived one', async () => {
    const ghost = signInvite({ clientId: '44444444-4444-4444-8444-444444444444' });
    const redeem = await request(app).post('/onboard/redeem').send({ token: ghost.token });
    expect(redeem.status).toBe(410);
  });

  test('server misconfigured (no signing secret): nothing is accepted and it says "unavailable", not "invalid"', async () => {
    const jwtSecret = process.env.ADMIN_JWT_SECRET;
    const { token } = await issue();
    delete process.env.ADMIN_JWT_SECRET;
    try {
      const redeem = await request(app).post('/onboard/redeem').send({ token });
      expect(redeem.status).toBe(503);
      expect(redeem.body.error).toBe('unavailable');
      const page = await request(app).get(`/onboard?invite=${encodeURIComponent(token)}`);
      expect(bootOf(page.text)).toMatchObject({ mode: 'blocked', reason: 'unavailable' });
      expect(() => signInvite({ clientId: GYM_B })).toThrow(/INVITE_SIGNING_SECRET|ADMIN_JWT_SECRET/);
    } finally { process.env.ADMIN_JWT_SECRET = jwtSecret; }
  });

  test('rotating the signing secret invalidates every outstanding link at once', async () => {
    const { token } = await issue();
    process.env.INVITE_SIGNING_SECRET = 'rotated-secret';
    try {
      expect(verifyInvite(token)).toEqual({ ok: false, reason: 'bad_signature' });
      const fresh = signInvite({ clientId: GYM_B });
      expect(verifyInvite(fresh.token).ok).toBe(true);
    } finally { delete process.env.INVITE_SIGNING_SECRET; }
  });

  test('lifetime: default 72h, configurable but clamped to 1h–168h', () => {
    const lifetime = (env) => {
      if (env === undefined) delete process.env.INVITE_TTL_HOURS; else process.env.INVITE_TTL_HOURS = env;
      const now = 1_000_000;
      return (signInvite({ clientId: GYM_B, now }).expiresAt - now) / 3_600_000;
    };
    try {
      expect(lifetime(undefined)).toBe(72);
      expect(lifetime('0')).toBe(1);
      expect(lifetime('99999')).toBe(168);
      expect(lifetime('not-a-number')).toBe(72);
    } finally { delete process.env.INVITE_TTL_HOURS; }
  });

  test('the bearer link never reaches the logs or the audit row', async () => {
    const { token } = await issue();
    await request(app).post('/onboard/redeem').send({ token });
    await request(app).post('/onboard/redeem').send({ token: token.slice(0, -4) });
    const audit = recordActivity.mock.calls.map(([, event, ctx]) => [event, ctx]);   // drop the req object
    const everything = JSON.stringify([mockLogCalls, audit]);
    expect(everything).not.toContain(token);
    expect(everything).not.toContain(token.split('.')[1]);
    expect(recordActivity.mock.calls.map(c => c[1])).toEqual(expect.arrayContaining(['client.invite_issued', 'client.invite_redeemed']));
  });
});

// ═══ C. Owner issuance ═══════════════════════════════════════════════════════
describe('[P3] C. only the owner can issue a setup link', () => {
  test('no session → 401; a gym\'s own session → 401; a gym token replayed as the owner cookie → 403; owner → 200', async () => {
    const url = `/admin/clients/${GYM_B}/invite`;
    expect((await request(app).post(url)).status).toBe(401);
    expect((await request(app).post(url).set('Cookie', operatorCookie(GYM_B))).status).toBe(401);
    const replay = operatorCookie(GYM_B).replace('operatorToken', 'adminToken');
    expect((await request(app).post(url).set('Cookie', replay)).status).toBe(403);
    expect((await request(app).post(url).set('Cookie', ownerCookie())).status).toBe(200);
  });

  test('a gym cannot mint a link for itself or anyone else, however it presents its token', async () => {
    for (const id of [GYM_B, HOG]) {
      const asOperator = await request(app).post(`/admin/clients/${id}/invite`).set('Cookie', operatorCookie(GYM_B));
      const asReplay   = await request(app).post(`/admin/clients/${id}/invite`).set('Cookie', operatorCookie(GYM_B).replace('operatorToken', 'adminToken'));
      expect([asOperator.status, asReplay.status]).toEqual([401, 403]);
    }
    expect(recordActivity).not.toHaveBeenCalled();
  });

  test('archived clients get a clear refusal; unknown clients 404', async () => {
    const archived = await request(app).post(`/admin/clients/${GONE}/invite`).set('Cookie', ownerCookie());
    expect(archived.status).toBe(409);
    expect(archived.body.error).toMatch(/restore/i);
    const unknown = await request(app).post('/admin/clients/55555555-5555-4555-8555-555555555555/invite').set('Cookie', ownerCookie());
    expect(unknown.status).toBe(404);
  });

  test('the response carries what the owner needs to send it by hand', async () => {
    const res = await request(app).post(`/admin/clients/${GYM_B}/invite`).set('Cookie', ownerCookie());
    expect(res.body).toMatchObject({ ok: true, ttlHours: 72, clientName: 'Gym B', notificationEmail: 'b@gymb.test' });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

// ═══ D. Sessions and the wizard ══════════════════════════════════════════════
describe('[P3] D. sessions and the wizard', () => {
  test('no invite and no session: a "you need a link" screen, never the wizard', async () => {
    const res = await request(app).get('/onboard');
    expect(bootOf(res.text)).toMatchObject({ mode: 'blocked', reason: 'no_access' });
  });

  test('session expired mid-wizard: API calls 401, the page falls back to "need a link"', async () => {
    const stale = expiredOperatorCookie(GYM_B);
    expect((await request(app).get(`/operator/${GYM_B}/onboarding-status`).set('Cookie', stale)).status).toBe(401);
    expect(bootOf((await request(app).get('/onboard').set('Cookie', stale)).text)).toMatchObject({ mode: 'blocked', reason: 'no_access' });
  });

  test('session expired but the invite is still valid: re-opening it resumes where they left off', async () => {
    const { token } = signInvite({ clientId: GYM_B });
    const redeem = await request(app).post('/onboard/redeem').send({ token });
    expect(redeem.status).toBe(200);
    const status = await request(app).get(`/operator/${GYM_B}/onboarding-status`).set('Cookie', redeem.headers['set-cookie'][0].split(';')[0]);
    expect(status.body).toMatchObject({ clientId: GYM_B, name: 'Gym B', hasHardwareKey: false, locations: [] });
  });

  test('a gym without the Wix dashboard extension is not stranded: a new owner-issued link is the way back in', async () => {
    expect(bootOf((await request(app).get('/onboard').set('Cookie', expiredOperatorCookie(GYM_B))).text).reason).toBe('no_access');
    const fresh = await request(app).post(`/admin/clients/${GYM_B}/invite`).set('Cookie', ownerCookie());
    const redeem = await request(app).post('/onboard/redeem').send({ token: tokenFromUrl(fresh.body.url) });
    expect(redeem.status).toBe(200);
  });

  test('a gym session ignores ?clientId= — it always sees its own wizard', async () => {
    const res = await request(app).get(`/onboard?clientId=${HOG}`).set('Cookie', operatorCookie(GYM_B));
    expect(bootOf(res.text)).toMatchObject({ mode: 'wizard', clientId: GYM_B });
  });

  test('owner-assisted setup: wizard for the named client; without one, a pointer to the Owner panel', async () => {
    const named = await request(app).get(`/onboard?clientId=${GYM_B}`).set('Cookie', ownerCookie());
    expect(bootOf(named.text)).toMatchObject({ mode: 'wizard', clientId: GYM_B });
    const bare = await request(app).get('/onboard').set('Cookie', ownerCookie());
    expect(bootOf(bare.text)).toMatchObject({ mode: 'blocked', reason: 'owner_no_client' });
  });

  test('the page is never cached and never reflects HTML from data', async () => {
    clients[GYM_B].name = 'Evil </script><img src=x onerror=alert(1)>';
    const { token } = signInvite({ clientId: GYM_B });
    const res = await request(app).get(`/onboard?invite=${encodeURIComponent(token)}`);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.text).not.toContain('</script><img');
    expect(bootOf(res.text).clientName).toBe(clients[GYM_B].name);   // round-trips intact, inert
  });

  test('the profile step edits only the session client and cannot set an installation id', async () => {
    const cookie = operatorCookie(GYM_B);
    const other = await request(app).post(`/operator/${HOG}/onboarding/profile`).set('Cookie', cookie).send({ name: 'x' });
    expect(other.status).toBe(403);

    const mine = await request(app).post(`/operator/${GYM_B}/onboarding/profile`).set('Cookie', cookie)
      .send({ name: 'Gym B', platform_instance_id: 'attacker-instance', tier: 'Connect' });
    expect(mine.status).toBe(200);
    const sqls = db.query.mock.calls.map(c => c[0]).join('\n');
    expect(sqls).not.toMatch(/platform_instance_id/);
  });

  test('a client already linked to a Wix site cannot be repointed at another', async () => {
    const res = await request(app).post(`/operator/${HOG}/onboarding/profile`).set('Cookie', operatorCookie(HOG))
      .send({ name: 'House of Gains', source_site_id: 'some-other-site' });
    expect(res.status).toBe(409);
  });

  test('claiming a Wix site that belongs to another account is refused (unique violation → 409)', async () => {
    const base = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (/UPDATE clients\s+SET name/.test(sql)) { const e = new Error('dup'); e.code = '23505'; throw e; }
      return base(sql, params);
    });
    const res = await request(app).post(`/operator/${GYM_B}/onboarding/profile`).set('Cookie', operatorCookie(GYM_B))
      .send({ name: 'Gym B', source_site_id: 'site-hog' });
    expect(res.status).toBe(409);
  });

  test('site-id check says only valid / in use — it no longer describes the owning account', async () => {
    const siteId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    clients[HOG].source_site_id = siteId;
    const res = await request(app).get(`/operator/site-id/verify?siteId=${siteId}`).set('Cookie', operatorCookie(GYM_B));
    expect(res.body).toEqual({ valid: false, inUse: true, error: expect.stringMatching(/already connected/i) });
    expect(JSON.stringify(res.body)).not.toMatch(/House of Gains|chad@|11111111/);
    const own = await request(app).get(`/operator/site-id/verify?siteId=${siteId}`).set('Cookie', operatorCookie(HOG));
    expect(own.body.valid).toBe(true);
  });

  test('owner PIN endpoint: session required, constant-time compare, wrong PIN refused', async () => {
    process.env.OWNER_PIN = 'a-long-owner-pin-123';
    try {
      const cookie = operatorCookie(GYM_B);
      expect((await request(app).post('/operator/verify-bypass').send({ pin: 'a-long-owner-pin-123' })).status).toBe(401);
      expect((await request(app).post('/operator/verify-bypass').set('Cookie', cookie).send({ pin: 'wrong' })).status).toBe(403);
      expect((await request(app).post('/operator/verify-bypass').set('Cookie', cookie).send({ pin: 'a-long-owner-pin-124' })).status).toBe(403);
      expect((await request(app).post('/operator/verify-bypass').set('Cookie', cookie).send({ pin: 'a-long-owner-pin-123' })).status).toBe(200);
    } finally { delete process.env.OWNER_PIN; }
  });
});

// ═══ E. House of Gains is untouched ══════════════════════════════════════════
describe('[P3] E. House of Gains regression', () => {
  test('HOG\'s existing operator session (issued by the Wix portal) still works on every HOG route', async () => {
    const portalCookie = `operatorToken=${signOperatorToken(HOG, 'wix-instance-123')}`;   // exactly what /operator-portal issues
    for (const url of [`/operator/${HOG}/onboarding-status`, `/operator/clients/${HOG}/api-key/status`]) {
      expect((await request(app).get(url).set('Cookie', portalCookie)).status).toBe(200);
    }
  });

  test('HOG is never offered the wizard\'s "create" paths, and never needs an invite to keep operating', async () => {
    const res = await request(app).get('/onboard').set('Cookie', `operatorToken=${signOperatorToken(HOG, null)}`);
    expect(bootOf(res.text)).toMatchObject({ mode: 'wizard', clientId: HOG });
  });

  test('issuing a link for gym B leaves HOG\'s data and secrets alone', async () => {
    await request(app).post(`/admin/clients/${GYM_B}/invite`).set('Cookie', ownerCookie());
    await request(app).post('/onboard/redeem').send({ token: signInvite({ clientId: GYM_B }).token });
    const writes = db.query.mock.calls.filter(([sql]) => /^\s*(UPDATE|INSERT|DELETE)/i.test(sql));
    expect(writes).toEqual([]);   // issuing and redeeming write nothing but the audit row (mocked)
  });
});
