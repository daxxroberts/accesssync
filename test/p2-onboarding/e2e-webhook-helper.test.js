/**
 * P2 — the e2e suite signs webhooks the way production now requires.
 *
 * CI runs only test:deploy, not e2e, so a change to webhook verification can break the
 * e2e suite without anything turning red. This pins the helper to the real verifier:
 * a webhook built by e2e/helpers/auth.js must name its client and verify with that
 * client's OWN secret — and the helper must never fall back to a committed credential.
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/webhook-processor', () => ({ eventQueue: {}, processIncoming: jest.fn(), logWebhookAttempt: jest.fn() }));
jest.mock('../../core/hmac-monitor', () => ({ recordFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/tenant-resolver', () => ({ registerSiteId: jest.fn() }));
jest.mock('../../core/setup-telemetry', () => ({ recordSnippetTelemetry: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: (s) => String(s).replace(/^ENC\[(.+)\]$/, '$1'), encryptApiKey: (p) => `ENC[${p}]`,
}));

const fs = require('fs');
const path = require('path');
const db = require('../../db');

const HOG_CLIENT = '15962eac-c767-46ad-8056-094f35a4a193';
const SECRET = 'per-client-secret-for-hog-aaaaaaaaaaaaaaaa';
const ENV_KEYS = ['E2E_WEBHOOK_SECRET', 'E2E_CLIENT_ID', 'OWNER_PIN', 'WIX_WEBHOOK_SECRET'];
let saved;
beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])); jest.clearAllMocks(); });
afterEach(() => { ENV_KEYS.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

function helper() { jest.resetModules(); return require('../../e2e/helpers/auth'); }

test('a webhook from the helper names its client and verifies with that client\'s own secret', async () => {
  process.env.E2E_WEBHOOK_SECRET = SECRET;
  process.env.E2E_CLIENT_ID = HOG_CLIENT;
  const body = JSON.stringify({ eventType: 'wixPricingPlans.orderPurchased', data: {} });
  const headers = helper().buildWebhookHeaders(body, { siteId: 'site-hog' });
  expect(headers['x-accesssync-client-id']).toBe(HOG_CLIENT);

  jest.resetModules();
  const db2 = require('../../db');
  db2.query.mockResolvedValueOnce({ rows: [{ wix_webhook_secret: `ENC[${SECRET}]` }] });
  const connector = require('../../adapters/wix/wix-connector');
  expect(await connector._verifySignature(body, headers['x-wix-signature'], headers['x-accesssync-client-id'])).toBe(true);
  expect(db2.query.mock.calls[0][1]).toEqual([HOG_CLIENT]);   // looked up THIS client's secret, nobody else's
});

test('defaults to the House of Gains client the specs target when E2E_CLIENT_ID is unset', () => {
  process.env.E2E_WEBHOOK_SECRET = SECRET;
  delete process.env.E2E_CLIENT_ID;
  const headers = helper().buildWebhookHeaders('{}', { siteId: 'site-hog' });
  expect(headers['x-accesssync-client-id']).toBe(HOG_CLIENT);
});

test('no secret in the environment = a loud error, never a silent default', () => {
  delete process.env.E2E_WEBHOOK_SECRET;
  process.env.WIX_WEBHOOK_SECRET = 'a-platform-secret-that-must-not-be-used';
  expect(() => helper().buildWebhookHeaders('{}', {})).toThrow(/E2E_WEBHOOK_SECRET is not set/);
});

test('no OWNER_PIN in the environment = a loud error', async () => {
  delete process.env.OWNER_PIN;
  await expect(helper().getAdminCookie()).rejects.toThrow(/OWNER_PIN is not set/);
});

test('no credential literals are committed in the e2e setup', () => {
  const files = ['playwright.config.js', 'e2e/helpers/auth.js', 'e2e/api/api-auth-pin.spec.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
    expect(src).not.toMatch(/\|\|\s*'\d{3,8}'/);                      // PIN-shaped fallback
    expect(src).not.toMatch(/\|\|\s*'[0-9a-f]{40,}'/i);               // hex-secret fallback
    expect(src).not.toMatch(/OWNER_PIN[^\n]*\|\|/);
    expect(src).not.toMatch(/WEBHOOK_SECRET[^\n]*\|\|\s*'/);
  }
});
