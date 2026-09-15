/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING / MEMBER-FACING                                │
 * │  Scenario: thank-you-page day-pass API (core/day-pass-api.js)           │
 * │                                                                         │
 * │  A day pass is a bearer credential, so:                                 │
 * │    - POST releases nothing without a valid HMAC (webhook-grade trust)   │
 * │    - states: none / pending / expired / ready                           │
 * │    - the QR rides a 10-minute signed URL; the image handler re-checks   │
 * │      the live row and rejects bad / expired tokens                      │
 * │    - no link URL or image ever reaches a log line                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({ getGroupLink: jest.fn() }));
jest.mock('../../adapters/wix/wix-connector', () => ({ verifySignedRequest: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(() => 'kisi-key') }));
jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const wixConnector    = require('../../adapters/wix/wix-connector');
const { decryptApiKey } = require('../../core/crypto-utils');
const { log }         = require('../../core/logger');
const api             = require('../../core/day-pass-api');

const CLIENT   = 'client-hog-001';
const MEMBER   = 'wix-member-abc';
const ACCESS   = 'ma-uuid-001';
const LINK_ID  = '777';
const LINK_URL = 'https://link.kisi.io/shh-secret';
const FUTURE   = new Date(Date.now() + 20 * 3600_000).toISOString();
const PAST     = new Date(Date.now() - 3600_000).toISOString();

function mockReq({ body = { platformMemberId: MEMBER }, headers = {}, query = {} } = {}) {
  const rawBody = JSON.stringify(body);
  return {
    body, rawBody, query,
    headers: { 'x-accesssync-client-id': CLIENT, 'x-wix-signature': 'sig', ...headers },
    protocol: 'https',
    get: () => 'core.test',
  };
}
function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null, redirectedTo: null };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.type = (t) => { res.headers['Content-Type'] = t; return res; };
  res.redirect = (c, u) => { res.statusCode = c; res.redirectedTo = u; return res; };
  return res;
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env.API_KEY_ENCRYPTION_KEY = 'test-token-secret';
  process.env.CORE_ENGINE_URL = 'https://core.test';
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
  decryptApiKey.mockReturnValue('kisi-key');
  wixConnector.verifySignedRequest.mockResolvedValue(true);
});

const dayPassRow = (over = {}) => ({
  access_id: ACCESS, role_assignment_id: LINK_ID, source_status: 'active',
  effective_start: PAST, valid_until: FUTURE, plan_name: 'Day Pass', door_name: 'Entrance Door Access Group',
  ...over,
});
const hwRow = { hardware_platform: 'kisi', hardware_api_key: 'enc' };

describe('[P2] POST /member/day-pass — auth', () => {
  test('401 when the HMAC does not verify — nothing is looked up', async () => {
    wixConnector.verifySignedRequest.mockResolvedValue(false);
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
    expect(wixConnector.verifySignedRequest).toHaveBeenCalledWith(JSON.stringify({ platformMemberId: MEMBER }), 'sig', CLIENT);
  });

  test('401 with no client header even if a signature is present', async () => {
    const res = mockRes();
    await api.handleLookup(mockReq({ headers: { 'x-accesssync-client-id': '' } }), res);
    expect(res.statusCode).toBe(401);
  });

  test('400 when platformMemberId is missing', async () => {
    const res = mockRes();
    await api.handleLookup(mockReq({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('[P2] POST /member/day-pass — states', () => {
  test("'none' when the member has no day-pass row", async () => {
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body).toEqual({ status: 'none' });
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test("'pending' while the claim row has no link id yet", async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ role_assignment_id: null, source_status: 'pending_hardware' })] });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body.status).toBe('pending');
    expect(res.body.doorName).toBe('Entrance Door Access Group');
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test("'expired' once valid_until has passed — no Kisi call", async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ valid_until: PAST })] });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body.status).toBe('expired');
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test("'ready' returns the unlock link and a signed QR URL that round-trips", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: 'QUJD', qrImageMime: 'image/png' });

    const res = mockRes();
    await api.handleLookup(mockReq(), res);

    expect(res.body.status).toBe('ready');
    expect(res.body.unlockUrl).toBe(LINK_URL);
    expect(res.body.qrAvailable).toBe(true);
    expect(res.body.validUntil).toBe(FUTURE);
    expect(res.body.qrUrl).toMatch(/^https:\/\/core\.test\/member\/day-pass\/qr\.png\?t=/);
    expect(hardwareAdapter.getGroupLink).toHaveBeenCalledWith('kisi', 'kisi-key', LINK_ID);

    const token = decodeURIComponent(res.body.qrUrl.split('?t=')[1]);
    const decoded = api.verifyQrToken(token);
    expect(decoded).toMatchObject({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID });
    expect(decoded.exp).toBeGreaterThan(Date.now());
    expect(decoded.exp).toBeLessThanOrEqual(Date.now() + api.QR_TOKEN_TTL_MS + 1000);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test("'ready' degrades to link-only when Kisi's GET carries no QR image", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: null, qrImageUrl: null });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body).toMatchObject({ status: 'ready', unlockUrl: LINK_URL, qrUrl: null, qrAvailable: false });
  });

  test('never logs the link URL or the QR image', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: 'QUJDREVG', qrImageMime: 'image/png' });
    await api.handleLookup(mockReq(), mockRes());
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(logged).not.toContain('shh-secret');
    expect(logged).not.toContain('QUJDREVG');
  });
});

describe('[P2] GET /member/day-pass/qr.png', () => {
  const validToken = () => api.signQrToken({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID, exp: Date.now() + 60_000 });

  test('401 on a garbage token, a tampered token, and an expired token', async () => {
    for (const t of ['nope', validToken() + 'x', api.signQrToken({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID, exp: Date.now() - 1 })]) {
      const res = mockRes();
      await api.handleQrImage(mockReq({ query: { t } }), res);
      expect(res.statusCode).toBe(401);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('404 when the row the token names is no longer live (revoked / expired)', async () => {
    const res = mockRes();
    await api.handleQrImage(mockReq({ query: { t: validToken() } }), res);
    expect(res.statusCode).toBe(404);
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test('streams the QR bytes with the right content type for a live row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })  // live row check
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, qrImageBase64: Buffer.from('PNGBYTES').toString('base64'), qrImageMime: 'image/png' });
    const res = mockRes();
    await api.handleQrImage(mockReq({ query: { t: validToken() } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/png');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.toString()).toBe('PNGBYTES');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('redirects to a hosted QR when Kisi returns a URL instead of bytes', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, qrImageBase64: null, qrImageUrl: 'https://cdn.kisi.io/qr/777.png' });
    const res = mockRes();
    await api.handleQrImage(mockReq({ query: { t: validToken() } }), res);
    expect(res.statusCode).toBe(302);
    expect(res.redirectedTo).toBe('https://cdn.kisi.io/qr/777.png');
  });
});

describe('[P2] snippet registry — thank_you_day_pass', () => {
  test('is registered with both parts and the signing headers', () => {
    const reg = jest.requireActual('../../core/snippet-registry');
    reg._clearCache();
    const s = reg.getSnippet('thank_you_day_pass');
    expect(s).toBeTruthy();
    expect(s.required_env_vars).toEqual(['CORE_ENGINE_URL']);
    expect(s.template).toContain("import { currentMember } from 'wix-members-backend'");
    expect(s.template).toContain("getSecret('accesssync_webhook_secret')");
    expect(s.template).toContain("'x-wix-signature'");
    expect(s.template).toContain("'/member/day-pass'");
    expect(s.template).toContain("$w('#imgDayPassQr').src = pass.qrUrl");
  });
});
