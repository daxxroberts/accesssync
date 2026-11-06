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
  email: 'buyer@example.com',
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
    // The branded page tells the buyer which inbox to watch while the pass is set up.
    expect(res.body.email).toBe('buyer@example.com');
    expect(api.verifyViewToken(res.body.pageToken)).toMatchObject({ clientId: CLIENT, accessId: ACCESS });
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test("'expired' once valid_until has passed — no Kisi call", async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ valid_until: PAST })] });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body.status).toBe('expired');
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test("'ready' returns a signed QR URL that round-trips — and never the access link", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: 'QUJD', qrImageMime: 'image/png' });

    const res = mockRes();
    await api.handleLookup(mockReq(), res);

    expect(res.body.status).toBe('ready');
    // QR only: the access link unlocks from anywhere, so it never reaches a web page.
    expect(res.body.unlockUrl).toBeNull();
    expect(res.body.qrAvailable).toBe(true);
    expect(res.body.validUntil).toBe(FUTURE);
    expect(res.body.email).toBe('buyer@example.com');
    expect(api.verifyViewToken(res.body.pageToken)).toMatchObject({ clientId: CLIENT, accessId: ACCESS });
    expect(res.body.qrUrl).toMatch(/^https:\/\/core\.test\/member\/day-pass\/qr\.png\?t=/);
    expect(hardwareAdapter.getGroupLink).toHaveBeenCalledWith('kisi', 'kisi-key', LINK_ID);

    const token = decodeURIComponent(res.body.qrUrl.split('?t=')[1]);
    const decoded = api.verifyQrToken(token);
    expect(decoded).toMatchObject({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID });
    expect(decoded.exp).toBeGreaterThan(Date.now());
    expect(decoded.exp).toBeLessThanOrEqual(Date.now() + api.QR_TOKEN_TTL_MS + 1000);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test("'ready' with no QR image still withholds the access link (the email carries the fallback)", async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: null, qrImageUrl: null });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body).toMatchObject({ status: 'ready', unlockUrl: null, qrUrl: null, qrAvailable: false });
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
    expect(logged).not.toContain('buyer@example.com');
  });

  test("email is null (not missing) when none is cached, so the page can fall back", async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ role_assignment_id: null, source_status: 'pending_hardware', email: null })] });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    expect(res.body.status).toBe('pending');
    expect(res.body.email).toBeNull();
  });

  test("'none' and 'expired' never carry the email", async () => {
    const none = mockRes();
    await api.handleLookup(mockReq(), none);
    expect(none.body).toEqual({ status: 'none' });

    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ valid_until: PAST })] });
    const expired = mockRes();
    await api.handleLookup(mockReq(), expired);
    expect(expired.body.status).toBe('expired');
    expect(expired.body.pageToken).toBeUndefined();
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

describe('[P2] view token vs QR token — one never opens the other', () => {
  const exp = () => Date.now() + 60_000;
  test('a view token does not verify as a QR token, and a QR token does not verify as a view token', () => {
    const view = api.signViewToken({ clientId: CLIENT, accessId: ACCESS, exp: exp() });
    const qr = api.signQrToken({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID, exp: exp() });
    expect(api.verifyViewToken(view)).toMatchObject({ clientId: CLIENT, accessId: ACCESS });
    expect(api.verifyQrToken(view)).toBeNull();
    expect(api.verifyQrToken(qr)).toMatchObject({ linkId: LINK_ID });
    expect(api.verifyViewToken(qr)).toBeNull();
  });

  test('a tampered or expired view token is rejected', () => {
    const view = api.signViewToken({ clientId: CLIENT, accessId: ACCESS, exp: exp() });
    expect(api.verifyViewToken(view + 'x')).toBeNull();
    expect(api.verifyViewToken('garbage')).toBeNull();
    expect(api.verifyViewToken(api.signViewToken({ clientId: CLIENT, accessId: ACCESS, exp: Date.now() - 1 }))).toBeNull();
  });

  test('the view token lasts 15 minutes', async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ role_assignment_id: null, source_status: 'pending_hardware' })] });
    const res = mockRes();
    await api.handleLookup(mockReq(), res);
    const tok = api.verifyViewToken(res.body.pageToken);
    expect(tok.exp).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(tok.exp).toBeLessThanOrEqual(Date.now() + api.VIEW_TOKEN_TTL_MS + 1000);
  });
});

describe('[P2] GET /member/day-pass/info — what the branded page reads', () => {
  const viewToken = () => api.signViewToken({ clientId: CLIENT, accessId: ACCESS, exp: Date.now() + 60_000 });

  test('401 with no token, a garbage token, an expired token, or a QR token — nothing is looked up', async () => {
    const qr = api.signQrToken({ clientId: CLIENT, accessId: ACCESS, linkId: LINK_ID, exp: Date.now() + 60_000 });
    for (const t of [undefined, 'nope', api.signViewToken({ clientId: CLIENT, accessId: ACCESS, exp: Date.now() - 1 }), qr]) {
      const res = mockRes();
      await api.handleInfo(mockReq({ query: { t } }), res);
      expect(res.statusCode).toBe(401);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  test('looks the pass up by the token\'s own access + client, never by anything in the request', async () => {
    await api.handleInfo(mockReq({ query: { t: viewToken(), accessId: 'someone-else', clientId: 'other' } }), mockRes());
    expect(db.query.mock.calls[0][1]).toEqual([ACCESS, CLIENT]);
  });

  test('404 (status none) when the pass is gone — and no email', async () => {
    const res = mockRes();
    await api.handleInfo(mockReq({ query: { t: viewToken() } }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.status).toBe('none');
    expect(res.body.email).toBeUndefined();
  });

  test('pending: the email and no QR yet', async () => {
    db.query.mockResolvedValueOnce({ rows: [dayPassRow({ role_assignment_id: null, source_status: 'pending_hardware' })] });
    const res = mockRes();
    await api.handleInfo(mockReq({ query: { t: viewToken() } }), res);
    expect(res.body).toMatchObject({ status: 'pending', email: 'buyer@example.com', clientId: CLIENT });
    expect(res.body.qrUrl).toBeUndefined();
    expect(hardwareAdapter.getGroupLink).not.toHaveBeenCalled();
  });

  test('ready: a signed QR URL, the expiry and the door — never the access link or a new view token', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: 'QUJD', qrImageMime: 'image/png' });
    const res = mockRes();
    await api.handleInfo(mockReq({ query: { t: viewToken() } }), res);
    expect(res.body).toMatchObject({ status: 'ready', validUntil: FUTURE, doorName: 'Entrance Door Access Group', unlockUrl: null, qrAvailable: true, clientId: CLIENT });
    expect(res.body.qrUrl).toMatch(/^https:\/\/core\.test\/member\/day-pass\/qr\.png\?t=/);
    expect(res.body.pageToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('shh-secret');
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  test('never logs the email, the link URL or the QR image', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [dayPassRow()] })
      .mockResolvedValueOnce({ rows: [hwRow] });
    hardwareAdapter.getGroupLink.mockResolvedValue({ id: 777, linkUrl: LINK_URL, qrImageBase64: 'QUJDREVG', qrImageMime: 'image/png' });
    await api.handleInfo(mockReq({ query: { t: viewToken() } }), mockRes());
    const logged = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    for (const secret of ['shh-secret', 'QUJDREVG', 'buyer@example.com']) expect(logged).not.toContain(secret);
  });
});

describe('[P2] snippet registry — thank_you_day_pass', () => {
  const reg = () => { const r = jest.requireActual('../../core/snippet-registry'); r._clearCache(); return r; };

  test('is registered with both parts, the signing headers, and the admin-hub env var', () => {
    const s = reg().getSnippet('thank_you_day_pass');
    expect(s).toBeTruthy();
    expect(s.required_env_vars).toEqual(['CORE_ENGINE_URL', 'ADMIN_HUB_URL']);
    expect(s.template).toContain("import { currentMember } from 'wix-members-backend'");
    expect(s.template).toContain("getSecret('accesssync_webhook_secret')");
    expect(s.template).toContain("'x-wix-signature'");
    expect(s.template).toContain("'/member/day-pass'");
  });

  // 2026-10-23 (Builder): the QR is not drawn on the Wix page. A Wix page cannot pick up
  // the gym's branding settings; the button opens AccessSync's branded page instead.
  test('one button to the branded page: no QR image on Wix, Get Status hidden for day-pass buyers', () => {
    const s = reg().getSnippet('thank_you_day_pass');
    expect(s.current_version).toBe('v2.0.0');
    expect(s.template).toContain("$w('#btnDayPassQr')");
    expect(s.template).toContain("'/day-pass?t=' + encodeURIComponent(pass.pageToken)");
    expect(s.template).toContain('wixLocation.to(');
    expect(s.template).toContain("$w('#btnViewStatus').hide()");
    expect(s.template).not.toContain('imgDayPassQr');
    expect(s.template).not.toContain('qrUrl');
    expect(s.template).not.toContain('btnDayPassUnlock');
    expect(s.template).not.toMatch(/manage (your )?access|check (your )?access/i);
    expect(s.instructions.join(' ')).toContain('btnDayPassQr');
    expect(s.instructions.join(' ')).toMatch(/Email branding/);
  });

  test('renders with real values and no leftover placeholders', () => {
    process.env.CORE_ENGINE_URL = 'https://core.test';
    process.env.ADMIN_HUB_URL = 'https://admin.test';
    const out = reg().renderSnippet('thank_you_day_pass', { clientId: CLIENT });
    expect(out.body).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(out.body).toContain("const CLIENT_ID = 'client-hog-001'");
    expect(out.body).toContain("const ADMIN_HUB = 'https://admin.test'");
  });

  // Wix runs this text as-is; one stray apostrophe in the copy and the whole page
  // script dies silently, so both parts must parse (checked 2026-10-23).
  test('both the backend part and the page part are valid JavaScript', () => {
    process.env.CORE_ENGINE_URL = 'https://core.test';
    process.env.ADMIN_HUB_URL = 'https://admin.test';
    const out = reg().renderSnippet('thank_you_day_pass', { clientId: CLIENT });
    const [backend, pageRaw] = out.body.split('// ===== PART 2');
    const page = pageRaw.slice(pageRaw.indexOf('\n') + 1); // drop the rest of the PART 2 header line
    const strip = (src) => src.replace(/^import .*$/gm, '').replace('export async function', 'async function');
    expect(() => new Function(strip(backend))).not.toThrow();
    expect(() => new Function('async function f(){' + strip(page) + '}')).not.toThrow();
  });
});
