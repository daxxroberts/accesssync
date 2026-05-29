/**
 * P2 — OB-238 per-client wix_webhook_secret.
 * Covers: wix-connector HMAC verification flow (per-client → env fallback),
 * rotate endpoint, setup-state hmacSource field.
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/webhook-processor', () => ({
  eventQueue: {},
  processIncoming: jest.fn().mockResolvedValue(),
  logWebhookAttempt: jest.fn().mockResolvedValue(),
}));
jest.mock('../../core/hmac-monitor', () => ({ recordFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/tenant-resolver', () => ({ registerSiteId: jest.fn().mockResolvedValue() }));
jest.mock('../../core/setup-telemetry', () => ({ recordSnippetTelemetry: jest.fn().mockResolvedValue() }));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth: (req, res, next) => next(),
  requireAuthOrOperator: (req, res, next) => next(),
  signOperatorToken: jest.fn(),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));

// Mock crypto-utils so we control encrypt/decrypt deterministically without
// needing API_KEY_ENCRYPTION_KEY in the test env.
jest.mock('../../core/crypto-utils', () => ({
  encryptApiKey: (plaintext) => 'ENC[' + plaintext + ']',
  decryptApiKey: (stored)    => stored.replace(/^ENC\[(.+)\]$/, '$1'),
}));

const db = require('../../db');
const crypto = require('crypto');

describe('wix-connector — _verifySignature per-client flow (OB-238)', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear the connector singleton so it picks up our env changes
    delete require.cache[require.resolve('../../adapters/wix/wix-connector')];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  function sign(secret, body) {
    return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  }

  test('returns false when no signature provided', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    const connector = require('../../adapters/wix/wix-connector');
    const result = await connector._verifySignature('body', null, 'client-1');
    expect(result).toBe(false);
  });

  test('uses per-client secret when clients.wix_webhook_secret is set', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    const perClient = 'per-client-secret-abc';
    db.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: 'ENC[' + perClient + ']' }] });

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign(perClient, body);
    const result = await connector._verifySignature(body, sig, 'client-1');
    expect(result).toBe(true);
  });

  test('per-client secret does NOT validate when signature was made with platform secret', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    const perClient = 'per-client-secret-abc';
    db.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: 'ENC[' + perClient + ']' }] });

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign('platform-secret', body); // signed with WRONG (platform) secret
    const result = await connector._verifySignature(body, sig, 'client-1');
    expect(result).toBe(false);  // per-client takes precedence; env fallback NOT tried
  });

  test('falls back to platform env secret when per-client secret not set', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    db.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: null }] });

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign('platform-secret', body);
    const result = await connector._verifySignature(body, sig, 'client-1');
    expect(result).toBe(true);
  });

  test('falls back to env when client row not found', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    db.query.mockResolvedValueOnce({ rows: [] });

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign('platform-secret', body);
    const result = await connector._verifySignature(body, sig, 'unknown-client');
    expect(result).toBe(true);
  });

  test('falls back to env when clientIdHint is null (legacy webhook without header)', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign('platform-secret', body);
    const result = await connector._verifySignature(body, sig, null);
    expect(result).toBe(true);
    expect(db.query).not.toHaveBeenCalled();  // no DB lookup when no hint
  });

  test('falls back to env when DB lookup throws (DR-037 never-throws)', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    db.query.mockRejectedValueOnce(new Error('db down'));

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const sig = sign('platform-secret', body);
    const result = await connector._verifySignature(body, sig, 'client-1');
    expect(result).toBe(true);  // fell back to env
  });

  test('returns false when neither per-client nor env secret available', async () => {
    delete process.env.WIX_WEBHOOK_SECRET;
    db.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: null }] });

    const connector = require('../../adapters/wix/wix-connector');
    const result = await connector._verifySignature('body', 'sig', 'client-1');
    expect(result).toBe(false);
  });

  test('uses timing-safe equality (rejects same-length wrong sig)', async () => {
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
    db.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: null }] });

    const connector = require('../../adapters/wix/wix-connector');
    const body = '{"test":1}';
    const correctSig = sign('platform-secret', body);
    // Flip one character — same length, wrong content
    const wrongSig = correctSig.slice(0, -1) + (correctSig.endsWith('A') ? 'B' : 'A');
    const result = await connector._verifySignature(body, wrongSig, 'client-1');
    expect(result).toBe(false);
  });
});

describe('POST /operator/:clientId/wix-webhook-secret/rotate', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('generates + stores encrypted secret and returns plaintext once', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })  // client exists
      .mockResolvedValueOnce({ rowCount: 1 });                // UPDATE

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/rotate');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.secret).toBeDefined();
    expect(res.body.secret.length).toBeGreaterThan(30);  // 32 bytes base64 ≈ 44 chars
    // Update call: encrypted form goes to DB, NOT plaintext
    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE clients SET wix_webhook_secret');
    expect(updateCall[1][0]).toContain('ENC[');  // our mock encryption prefix
    expect(updateCall[1][0]).not.toBe(res.body.secret);  // stored != returned
  });

  test('returns 404 when client not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/rotate');
    const req = { params: { clientId: 'unknown' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });

  test('generated secrets are unique across calls', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] }).mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'c1' }] }).mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/rotate');
    const res1 = mockRes(); await handler({ params: { clientId: 'c1' } }, res1);
    const res2 = mockRes(); await handler({ params: { clientId: 'c1' } }, res2);

    expect(res1.body.secret).not.toBe(res2.body.secret);
  });
});

describe('GET /operator/:clientId/setup-state — hmacSource field (OB-238)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CORE_ENGINE_URL = 'https://core.example.com';
    process.env.ADMIN_HUB_URL = 'https://admin.example.com';
    process.env.WIX_WEBHOOK_SECRET = 'platform-secret';
  });

  test('hmacSource = per_client when clients.wix_webhook_secret is set (no auto-gen)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: 'ENC[my-per-client-secret]' }] })
      .mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.hmacSource).toBe('per_client');
    expect(res.body.hmacSecret).toBe('my-per-client-secret');
  });

  test('auto-generates per-client secret on first visit when NULL (followup)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: null }] })  // SELECT client
      .mockResolvedValueOnce({ rows: [] })                                              // SELECT state
      .mockResolvedValueOnce({ rows: [{ wix_webhook_secret: 'ENC[autogen-newvalue]' }], rowCount: 1 });  // UPDATE auto-gen

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.hmacSource).toBe('per_client');
    expect(res.body.hmacSecret).toBe('autogen-newvalue');
    // Confirm the auto-gen UPDATE was guarded by WHERE ... IS NULL
    const updateCall = db.query.mock.calls[2];
    expect(updateCall[0]).toContain('wix_webhook_secret IS NULL');
  });

  test('auto-gen race: re-reads existing value when UPDATE returns 0 rows', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1', wix_webhook_secret: null }] })  // SELECT client
      .mockResolvedValueOnce({ rows: [] })                                              // SELECT state
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                 // UPDATE lost race
      .mockResolvedValueOnce({ rows: [{ wix_webhook_secret: 'ENC[winner-value]' }] }); // re-read

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'get', '/:clientId/setup-state');
    const req = { params: { clientId: 'client-1' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.hmacSource).toBe('per_client');
    expect(res.body.hmacSecret).toBe('winner-value');
  });
});

describe('POST /operator/:clientId/wix-webhook-secret/set (OB-238 followup)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('accepts a 32+ char secret and stores it encrypted', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })  // client exists
      .mockResolvedValueOnce({ rowCount: 1 });                // UPDATE

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const validSecret = 'a'.repeat(40);  // 40 chars, well above min 32
    const req = { params: { clientId: 'client-1' }, body: { secret: validSecret } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
    expect(res.body.secret).toBeUndefined();  // server does not echo back
    const updateCall = db.query.mock.calls[1];
    expect(updateCall[0]).toContain('UPDATE clients SET wix_webhook_secret');
    expect(updateCall[1][0]).toContain('ENC[');  // encrypted form stored, not plaintext
  });

  test('rejects short secrets (< 32 chars)', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const req = { params: { clientId: 'client-1' }, body: { secret: 'too-short' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('32');
  });

  test('rejects missing secret', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const req = { params: { clientId: 'client-1' }, body: {} };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('rejects non-string secret', async () => {
    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const req = { params: { clientId: 'client-1' }, body: { secret: 12345 } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(400);
  });

  test('trims whitespace before length check', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'client-1' }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const req = { params: { clientId: 'client-1' }, body: { secret: '  ' + 'x'.repeat(40) + '  ' } };
    const res = mockRes();
    await handler(req, res);

    expect(res.body.ok).toBe(true);
  });

  test('404 when client not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    const router = require('../../admin/routes/operator');
    const handler = findRouteHandler(router, 'post', '/:clientId/wix-webhook-secret/set');
    const req = { params: { clientId: 'unknown' }, body: { secret: 'a'.repeat(40) } };
    const res = mockRes();
    await handler(req, res);

    expect(res.statusCode).toBe(404);
  });
});

function findRouteHandler(router, method, pathPattern) {
  const layer = router.stack.find(l => l.route &&
    l.route.path === pathPattern &&
    l.route.methods[method]);
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${pathPattern}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}
