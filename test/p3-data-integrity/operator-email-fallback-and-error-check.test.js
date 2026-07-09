/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                             │
 * │  Operator-alert email fallback + result.error checking                  │
 * │                                                                          │
 * │  2026-07-09: confirmed live against Resend that `accesssync.io` is NOT a │
 * │  verified sending domain (403 "domain is not verified") — and           │
 * │  RESEND_FROM_EMAIL was never set as a Railway env var, so every send on  │
 * │  these 5 pre-existing operator-facing call sites silently 403'd AND      │
 * │  logged an unconditional "sent" success, because none of them checked   │
 * │  `result.error` on the Resend SDK response (Resend resolves with        │
 * │  {data: null, error: {...}} on failure rather than throwing). This is   │
 * │  why first-grant emails, nightly digests, and hardware-key-failure      │
 * │  alerts never actually landed. Fixed to match the core/member-mailer.js │
 * │  (DR-052) pattern: fallback to Resend's onboarding@resend.dev sender    │
 * │  (no domain verification required) and log a distinct failure event     │
 * │  instead of an unconditional success log.                               │
 * │                                                                          │
 * │  What CANNOT regress:                                                    │
 * │    1. Bare fallback (no RESEND_FROM_EMAIL) → onboarding@resend.dev,      │
 * │       never the unverified alerts@accesssync.io                         │
 * │    2. A configured RESEND_FROM_EMAIL still wins over the fallback        │
 * │    3. result.error on the Resend response → logged as a failure, NOT    │
 * │       an unconditional success                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const mockResendSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockResendSend } })),
}));

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
jest.mock('../../core/logger', () => ({
  log: mockLog,
  withTrace: jest.fn(() => mockLog),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-test'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
  runWith:    jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-test'),
  setTraceContext: jest.fn(),
}));

jest.mock('../../core/webhook-processor', () => ({ eventQueue: { add: jest.fn() } }));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(), getGroups: jest.fn(), getManagedRoleAssignments: jest.fn(), listAllUsers: jest.fn(),
}));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => `plain-${k}`) }));
jest.mock('../../adapters/wix/wix-plans-api', () => ({ listPricingPlans: jest.fn() }));

const db = require('../../db');

beforeEach(() => {
  jest.clearAllMocks();
  process.env.RESEND_API_KEY = 'test-key';
  delete process.env.RESEND_FROM_EMAIL;
  mockResendSend.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
});

// ════════════════════════════════════════════════════════════════════════════
// core/retry-engine.js — _notifyOperator (dead-letter job alert)
// ════════════════════════════════════════════════════════════════════════════
describe('[P3] retry-engine._notifyOperator', () => {
  test('falls back to onboarding@resend.dev when RESEND_FROM_EMAIL unset', async () => {
    const retryEngine = require('../../core/retry-engine');
    db.query.mockResolvedValue({ rows: [{ notification_email: 'ops@gym.com' }] });
    await retryEngine._notifyOperator('client-1', new Error('boom'), 'member-1', 'plan.purchased');
    expect(mockResendSend.mock.calls[0][0].from).toBe('onboarding@resend.dev');
  });

  test('honors RESEND_FROM_EMAIL when set', async () => {
    process.env.RESEND_FROM_EMAIL = 'alerts@verified.com';
    const retryEngine = require('../../core/retry-engine');
    db.query.mockResolvedValue({ rows: [{ notification_email: 'ops@gym.com' }] });
    await retryEngine._notifyOperator('client-1', new Error('boom'), 'member-1', 'plan.purchased');
    expect(mockResendSend.mock.calls[0][0].from).toBe('alerts@verified.com');
  });

  test('result.error is treated as a failure, not logged as sent', async () => {
    const retryEngine = require('../../core/retry-engine');
    db.query.mockResolvedValue({ rows: [{ notification_email: 'ops@gym.com' }] });
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });
    await retryEngine._notifyOperator('client-1', new Error('boom'), 'member-1', 'plan.purchased');
    expect(mockLog.info).not.toHaveBeenCalledWith('retry.notify.sent', expect.anything());
    expect(mockLog.error).toHaveBeenCalledWith('retry.notify.send_failed', expect.anything(), expect.anything());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// core/reconciliation.js — _generateAndSendDigest (nightly digest)
// ════════════════════════════════════════════════════════════════════════════
describe('[P3] reconciliation._generateAndSendDigest', () => {
  test('falls back to onboarding@resend.dev when RESEND_FROM_EMAIL unset', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
    const reconciliation = require('../../core/reconciliation');
    db.query.mockImplementation((sql) => {
      if (/config_alert_log/.test(sql)) return Promise.resolve({ rows: [{ client_id: 'c1', alert_type: 'x', hardware_ref: 'r', created_at: new Date() }] });
      return Promise.resolve({ rows: [] });
    });
    await reconciliation._generateAndSendDigest();
    expect(mockResendSend.mock.calls[0][0].from).toBe('onboarding@resend.dev');
    delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  });

  test('result.error is logged as digest_send_failed, not digest_sent', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
    const reconciliation = require('../../core/reconciliation');
    db.query.mockImplementation((sql) => {
      if (/config_alert_log/.test(sql)) return Promise.resolve({ rows: [{ client_id: 'c1', alert_type: 'x', hardware_ref: 'r', created_at: new Date() }] });
      return Promise.resolve({ rows: [] });
    });
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });
    await reconciliation._generateAndSendDigest();
    expect(mockLog.info).not.toHaveBeenCalledWith('reconciliation.digest_sent', expect.anything());
    expect(mockLog.error).toHaveBeenCalledWith('reconciliation.digest_send_failed', expect.objectContaining({ toEmail: 'daxx@accesssync.io' }));
    delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  });
});

// ════════════════════════════════════════════════════════════════════════════
// adapters/standard-adapter.js — _maybeFireFirstGrantEmail (first grant welcome)
// ════════════════════════════════════════════════════════════════════════════
describe('[P3] standard-adapter._maybeFireFirstGrantEmail', () => {
  test('falls back to onboarding@resend.dev when RESEND_FROM_EMAIL unset', async () => {
    const standardAdapter = require('../../adapters/standard-adapter');
    db.query.mockResolvedValue({ rows: [{ name: 'HOG', notification_email: 'chad@hog.com' }] });
    await standardAdapter._maybeFireFirstGrantEmail('client-1', 'access-1');
    expect(mockResendSend.mock.calls[0][0].from).toBe('onboarding@resend.dev');
  });

  test('result.error is logged as first_grant_email_error, not sent', async () => {
    const standardAdapter = require('../../adapters/standard-adapter');
    db.query.mockResolvedValue({ rows: [{ name: 'HOG', notification_email: 'chad@hog.com' }] });
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });
    await standardAdapter._maybeFireFirstGrantEmail('client-1', 'access-1');
    expect(mockLog.info).not.toHaveBeenCalledWith('adapter.first_grant_email_sent', expect.anything());
    expect(mockLog.error).toHaveBeenCalledWith('adapter.first_grant_email_error', expect.objectContaining({ toEmail: 'chad@hog.com' }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// core/hmac-monitor.js — _sendAlert (HMAC failure spike alert)
// ════════════════════════════════════════════════════════════════════════════
describe('[P3] hmac-monitor spike alert', () => {
  function mockRedis(existingCounts = []) {
    const listStore = { failures: existingCounts.map(String) };
    return {
      lpush:  jest.fn((k, v) => { listStore.failures.unshift(String(v)); return Promise.resolve(); }),
      ltrim:  jest.fn(() => Promise.resolve()),
      expire: jest.fn(() => Promise.resolve()),
      lrange: jest.fn(() => Promise.resolve(listStore.failures)),
      get:    jest.fn(() => Promise.resolve(null)),
      set:    jest.fn(() => Promise.resolve()),
    };
  }

  test('falls back to onboarding@resend.dev when RESEND_FROM_EMAIL unset', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
    const now = Math.floor(Date.now() / 1000);
    jest.doMock('../../core/redis-utils', () => ({
      getRedisConnection: jest.fn(() => mockRedis([now, now, now])),
    }));
    const { recordFailure } = require('../../core/hmac-monitor');
    await recordFailure('client-1');
    expect(mockResendSend.mock.calls[0][0].from).toBe('onboarding@resend.dev');
    delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
    jest.dontMock('../../core/redis-utils');
  });

  test('result.error is logged as alert.send_failed, not alert.sent', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
    const now = Math.floor(Date.now() / 1000);
    jest.doMock('../../core/redis-utils', () => ({
      getRedisConnection: jest.fn(() => mockRedis([now, now, now])),
    }));
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });
    const { recordFailure } = require('../../core/hmac-monitor');
    await recordFailure('client-1');
    expect(mockLog.info).not.toHaveBeenCalledWith('hmac.alert.sent', expect.anything());
    expect(mockLog.error).toHaveBeenCalledWith('hmac.alert.send_failed', expect.objectContaining({ toEmail: 'daxx@accesssync.io' }));
    delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
    jest.dontMock('../../core/redis-utils');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// core/hardware-health-check.js — _notifyFailure (key validation failure)
// ════════════════════════════════════════════════════════════════════════════
describe('[P3] hardware-health-check key-failure alert', () => {
  function locationsRow(overrides = {}) {
    return Object.assign({
      location_id: 'loc-1', location_name: 'Main', client_id: 'client-1',
      hardware_api_key: null, hardware_platform: 'kisi', connector_id: 'conn-1',
      notification_email: 'chad@hog.com', client_name: 'HOG',
    }, overrides);
  }

  beforeEach(() => {
    db.query.mockImplementation((sql) => {
      if (/FROM locations l/.test(sql)) return Promise.resolve({ rows: [locationsRow()] });
      if (/UPDATE connector_subscriptions/.test(sql)) return Promise.resolve({ rows: [] });
      if (/FROM clients WHERE id/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });
  });

  test('falls back to onboarding@resend.dev when RESEND_FROM_EMAIL unset (no_key path)', async () => {
    const { runHealthCheck } = require('../../core/hardware-health-check');
    await runHealthCheck();
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    expect(mockResendSend.mock.calls[0][0].from).toBe('onboarding@resend.dev');
  });

  test('result.error is logged as alert_send_failed, not alert_sent', async () => {
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'domain is not verified' } });
    const { runHealthCheck } = require('../../core/hardware-health-check');
    await runHealthCheck();
    expect(mockLog.info).not.toHaveBeenCalledWith('health.alert_sent', expect.anything());
    expect(mockLog.error).toHaveBeenCalledWith('health.alert_send_failed', expect.objectContaining({ toEmail: 'chad@hog.com' }));
  });
});
