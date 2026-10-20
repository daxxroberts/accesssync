/**
 * PRIORITY 3 — reliability fixes from the BOT review 2026-10-19.
 *
 *  A. hardware-health-check _reconcileWixPlans asked Wix for pricing plans with the app-INSTALL
 *     id (clients.platform_instance_id). The Wix REST API is addressed by SITE id
 *     (clients.source_site_id), so it 404'd every 6 hours. It now sends the site id, and skips
 *     the check when a client has none.
 *  B. kisi-connector fetch had no timeout: a Kisi call that never answered hung its job past the
 *     120s per-member Redis lock. Each call now gives up after REQUEST_TIMEOUT_MS.
 *  C. A malformed id on the Member Hub routes reached Postgres (22P02 error row, 500). They now
 *     answer 400, using the same isUuid check as core/member-sync-api.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(() => 'wix-api-key'), encryptApiKey: jest.fn() }));
jest.mock('../../adapters/wix/wix-plans-api', () => ({ listPricingPlans: jest.fn().mockResolvedValue([]) }));
jest.mock('../../core/webhook-processor', () => ({ eventQueue: { add: jest.fn() } }));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));

const db = require('../../db');
const { log } = require('../../core/logger');
const wixPlansApi = require('../../adapters/wix/wix-plans-api');

beforeEach(() => jest.clearAllMocks());

// ── A ────────────────────────────────────────────────────────────────────────
describe('[P3] health check asks Wix for plans by SITE id, not app-install id', () => {
  const { _reconcileWixPlans } = require('../../core/hardware-health-check');
  const loc = { client_id: '00000000-0000-4000-8000-0000000000c1' };

  test('listPricingPlans gets clients.source_site_id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ source_api_key: 'enc', source_site_id: 'wix-site-123' }] });
    await _reconcileWixPlans(loc);
    expect(db.query.mock.calls[0][0]).toMatch(/source_site_id/);
    expect(db.query.mock.calls[0][0]).not.toMatch(/platform_instance_id/);
    expect(wixPlansApi.listPricingPlans).toHaveBeenCalledWith('wix-api-key', 'wix-site-123');
  });

  test('a client with no site id is skipped, never called with undefined', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ source_api_key: 'enc', source_site_id: null }] });
    await _reconcileWixPlans(loc);
    expect(wixPlansApi.listPricingPlans).not.toHaveBeenCalled();
  });
});

// ── B ────────────────────────────────────────────────────────────────────────
describe('[P3] a Kisi call that never answers is abandoned, not left hanging', () => {
  const kisi = require('../../adapters/kisi/kisi-connector');
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('every request carries an abort signal, and the timeout sits well inside the 120s job lock', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
    await kisi.makeRequest('/groups?limit=1', { method: 'GET' }, 'key');
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(kisi.REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(kisi.REQUEST_TIMEOUT_MS * 4).toBeLessThan(120 * 1000);   // a job makes several calls under one lock
  });

  test('when the signal times out the call fails as HARDWARE_API_ERROR (so BullMQ retries) and is logged', async () => {
    global.fetch = jest.fn(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')));
    await expect(kisi.makeRequest('/users', { method: 'POST', body: '{}' }, 'key'))
      .rejects.toMatchObject({ code: 'HARDWARE_API_ERROR', message: expect.stringMatching(/did not answer within 15s/) });
    expect(log.error).toHaveBeenCalledWith('kisi.request.timeout', expect.objectContaining({ endpoint: '/users', timeoutMs: kisi.REQUEST_TIMEOUT_MS }), expect.any(Error));
  });

  test('the abort really fires: a fetch that waits on its signal rejects instead of hanging', async () => {
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = () => realTimeout.call(AbortSignal, 20);   // shrink 15s to 20ms for the test
    try {
      global.fetch = jest.fn((url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(opts.signal.reason));
      }));
      await expect(kisi.makeRequest('/locks', { method: 'GET' }, 'key')).rejects.toMatchObject({ code: 'HARDWARE_API_ERROR' });
    } finally {
      AbortSignal.timeout = realTimeout;
    }
  });
});

// ── C ────────────────────────────────────────────────────────────────────────
describe('[P3] Member Hub routes answer 400 to a malformed id instead of reaching Postgres', () => {
  const { isUuid } = require('../../core/member-sync-api');
  const GOOD = '00000000-0000-4000-8000-0000000000c1';
  const BAD = '41377ole-U477-0000-0000-000000000000';   // the 2026-10-12 shape that made 22P02 rows

  function app() {
    const a = express();
    a.use(express.json());
    a.use('/', require('../../admin/routes/multi-member'));
    return a;
  }

  test('isUuid is the shared check', () => {
    expect(isUuid(GOOD)).toBe(true);
    expect(isUuid(BAD)).toBe(false);
    expect(isUuid(undefined)).toBe(false);
  });

  test.each([
    ['GET widget-data, bad clientId', (r) => r.get('/member/wix-member-1/widget-data').query({ clientId: BAD })],
    ['POST members, bad clientId', (r) => r.post('/api/multi-member/members').send({ holderId: GOOD, clientId: BAD, firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1', planMappingId: GOOD })],
    ['POST members, bad holderId', (r) => r.post('/api/multi-member/members').send({ holderId: 'holder-1', clientId: GOOD, firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1', planMappingId: GOOD })],
    ['POST submit, bad clientId', (r) => r.post('/api/multi-member/submit').send({ holderId: GOOD, clientId: BAD })],
    ['POST holder-claim-slot, bad planMappingId', (r) => r.post('/api/multi-member/holder-claim-slot').send({ holderId: GOOD, clientId: GOOD, planMappingId: 'pm-1' })],
    ['POST holder-release-slot, bad clientId', (r) => r.post('/api/multi-member/holder-release-slot').send({ holderId: GOOD, clientId: BAD, planMappingId: GOOD })],
    ['PUT member, bad subId', (r) => r.put('/api/multi-member/members/sub-1').send({ firstName: 'A', lastName: 'B', email: 'a@b.c', phone: '1' })],
    ['DELETE member, bad subId', (r) => r.delete('/api/multi-member/members/sub-1')],
  ])('%s → 400, no query', async (_label, call) => {
    const res = await call(request(app()));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be a UUID/);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('widget-data keeps accepting a Wix member id (not a uuid) in the path', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/member/1a2b-wix-member/widget-data').query({ clientId: GOOD });
    expect(res.status).not.toBe(400);
    expect(db.query).toHaveBeenCalled();   // reached the holder lookup
  });

  test('/member-hub (admin/server.js) checks clientId with the same isUuid before its query', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../admin/server.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/member-hub'"), src.indexOf("res.render('pages/member-hub'"));
    expect(route).toMatch(/require\('\.\.\/core\/member-sync-api'\)/);
    const guard = route.indexOf('!isUuid(req.query.clientId)');
    expect(guard).toBeGreaterThan(-1);
    expect(route.slice(guard, guard + 200)).toMatch(/status\(400\)/);
    expect(guard).toBeLessThan(route.indexOf('db.query('));
  });
});
