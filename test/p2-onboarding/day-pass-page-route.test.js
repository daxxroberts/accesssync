/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING / MEMBER-FACING                                │
 * │  Scenario: admin GET /day-pass and /day-pass/data (the branded page)    │
 * │                                                                         │
 * │    - the page is branded from the gym's own clients row                 │
 * │    - an expired link still wears the gym's brand but releases nothing   │
 * │    - a core outage never crashes the page                               │
 * │    - nothing is cached, and the client id never reaches the page data   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const db = require('../../db');

const CLIENT = '11111111-2222-4333-8444-555555555555';
const HOG_ROW = {
  name: 'House of Gains',
  email_logo_url: 'https://cdn.example.com/hog.png',
  email_primary_color: '#333333',
  email_secondary_color: '#ffdb29',
  source_site_url: 'https://www.houseofgainsthegym.com',
  status: 'active',
  archived_at: null,
  qr_guide_url: 'https://cdn.example.com/guide.pdf',
};
// A real-shaped token: base64url payload + signature. The admin app never verifies it
// (core does); it only reads the client id out of the payload for branding.
const tokenFor = (c) => Buffer.from(JSON.stringify({ k: 'v', c, a: 'acc', e: Date.now() + 60_000 })).toString('base64url') + '.sig';

let app;
beforeAll(() => {
  process.env.CORE_ENGINE_URL = 'https://core.test';
  app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../../admin/views'));
  app.use('/day-pass', require('../../admin/routes/day-pass-page'));
});

const upstream = (status, body) => jest.fn().mockResolvedValue({ status, text: async () => JSON.stringify(body) });

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockResolvedValue({ rows: [HOG_ROW] });
  global.fetch = upstream(200, { status: 'pending', email: 'buyer@example.com', clientId: CLIENT });
});

describe('[P2] GET /day-pass', () => {
  test('a live pass: House of Gains branding, the buyer email in the page data, no client id', async () => {
    const t = tokenFor(CLIENT);
    const res = await request(app).get('/day-pass').query({ t });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.text).toContain('src="https://cdn.example.com/hog.png"');
    expect(res.text).toContain('--gym-primary:#333333');
    expect(res.text).toContain('Back to House of Gains');
    expect(res.text).toContain('buyer@example.com');
    expect(res.text).not.toContain(CLIENT);
    expect(global.fetch).toHaveBeenCalledWith(`https://core.test/member/day-pass/info?t=${encodeURIComponent(t)}`);
    expect(db.query.mock.calls[0][1]).toEqual([CLIENT]);
  });

  test('the how-to guide link comes only from the gym\'s own active row', async () => {
    const res = await request(app).get('/day-pass').query({ t: tokenFor(CLIENT) });
    expect(res.text).toContain('https://cdn.example.com/guide.pdf');

    db.query.mockResolvedValue({ rows: [{ ...HOG_ROW, status: 'suspended' }] });
    const res2 = await request(app).get('/day-pass').query({ t: tokenFor(CLIENT) });
    expect(res2.text).not.toContain('https://cdn.example.com/guide.pdf');
  });

  test('a timed-out link: still the gym\'s brand, but nothing about the pass', async () => {
    global.fetch = upstream(401, { error: 'Unauthorized' });
    const res = await request(app).get('/day-pass').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('src="https://cdn.example.com/hog.png"');
    expect(res.text).not.toContain('buyer@example.com');
    expect(res.text).toContain('const BOOT = {"status":"none"}');
  });

  test('a hint that is not a UUID never reaches the database', async () => {
    global.fetch = upstream(401, {});
    const res = await request(app).get('/day-pass').query({ t: tokenFor("x' OR 1=1 --") });
    expect(res.status).toBe(200);
    expect(db.query).not.toHaveBeenCalled();
    expect(res.text).toContain('class="as-only"');
  });

  test('core is down: the page still renders (the buyer is told to check their email)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).get('/day-pass').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Check your email for your QR code');
  });

  test('no token: a plain AccessSync page, no lookups at all', async () => {
    const res = await request(app).get('/day-pass');
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(res.text).toContain('class="as-only"');
  });

  test('a branding lookup failure never blocks the pass', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    const res = await request(app).get('/day-pass').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(200);
    expect(res.text).toContain('buyer@example.com');
  });

  test('an oversized token is ignored, not forwarded', async () => {
    const res = await request(app).get('/day-pass').query({ t: 'a'.repeat(2001) });
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('[P2] GET /day-pass/data', () => {
  test('passes the live answer through, uncached', async () => {
    global.fetch = upstream(200, { status: 'ready', qrUrl: 'https://core.test/member/day-pass/qr.png?t=z', email: 'buyer@example.com', clientId: CLIENT });
    const res = await request(app).get('/day-pass/data').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({ status: 'ready', qrUrl: 'https://core.test/member/day-pass/qr.png?t=z' });
  });

  test('any non-200 from core becomes a quiet "none" — no error text leaks', async () => {
    global.fetch = upstream(401, { error: 'Unauthorized: secret detail' });
    const res = await request(app).get('/day-pass/data').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ status: 'none' });
  });

  test('400 with no token, 502 when core is unreachable', async () => {
    expect((await request(app).get('/day-pass/data')).status).toBe(400);
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    const res = await request(app).get('/day-pass/data').query({ t: tokenFor(CLIENT) });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ status: 'none' });
  });
});
