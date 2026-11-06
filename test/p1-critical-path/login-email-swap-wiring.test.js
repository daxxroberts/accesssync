/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  DR-056 — the plumbing around the login-email swap                      │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    1. A Wix member-updated event becomes an 'email_swap' job — and      │
 * │       never a grant or a revoke (a profile edit must not touch doors    │
 * │       through the grant/revoke paths, and reconcile/Retry must never    │
 * │       replay it).                                                       │
 * │    2. The verified flag is read strictly: only a literal true counts.   │
 * │    3. A deferred swap parks the job without spending a retry; a         │
 * │       blocked swap dead-letters on the first attempt.                   │
 * │    4. Every flag the swap can raise tells the Errors page who acts and  │
 * │       never offers a Retry that cannot help.                            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const mockAdd = jest.fn();

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
  return { log: l, withTrace: jest.fn(() => l) };
});
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/tenant-resolver', () => ({
  resolve: jest.fn().mockResolvedValue(null),
  resolveByClientId: jest.fn().mockResolvedValue('tenant-056'),
}));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../adapters/standard-adapter', () => ({ releaseLock: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({}));
jest.mock('../../core/grant-revoke', () => ({ processGrant: jest.fn(), processRevoke: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine', () => ({ handleFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/login-email-swap', () => ({ runLoginEmailSwap: jest.fn() }));
jest.mock('bullmq', () => {
  class DelayedError extends Error { constructor(m) { super(m || 'delayed'); this.name = 'DelayedError'; } }
  class UnrecoverableError extends Error { constructor(m) { super(m); this.name = 'UnrecoverableError'; } }
  return {
    Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
    Queue: jest.fn().mockImplementation(() => ({ add: mockAdd })),
    UnrecoverableError, DelayedError,
  };
});

const db = require('../../db');
const wixAdapter = require('../../adapters/wix/wix-adapter');
const webhookProcessor = require('../../core/webhook-processor');
const loginEmailSwap = require('../../core/login-email-swap');
const retryEngine = require('../../core/retry-engine');
const standardAdapter = require('../../adapters/standard-adapter');
const { processJob, startWorker } = require('../../core/queue-worker');
const { jobNameForEventType, MEMBER_UPDATE_EVENT_TYPES, GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES } = require('../../core/event-routing');
const { guidanceFor } = require('../../core/error-guidance');
const { mintTraceId } = require('../../core/trace-context');

const memberUpdated = (member) => ({ data: { metadata: { id: 'evt-mu-1' }, entity: member } });

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 a Wix member-updated event is parsed strictly', () => {
  const member = { _id: 'wix-m-1', loginEmail: 'new@x.com', loginEmailVerified: true };

  test.each(['wixMembers.memberUpdated', 'member.updated'])('%s → member.updated with id, login email and verified flag', (type) => {
    const ev = wixAdapter.parseEvent(type, 'site-1', memberUpdated(member));
    expect(ev).toMatchObject({
      eventType: 'member.updated', platformMemberId: 'wix-m-1', email: 'new@x.com',
      loginEmailVerified: true, planId: null,
    });
  });

  test('only a literal true is "verified": false, missing, and the string "true" all fail closed', () => {
    for (const v of [false, undefined, null, 'true', 1]) {
      const ev = wixAdapter.parseEvent('member.updated', 'site-1', memberUpdated({ ...member, loginEmailVerified: v }));
      expect(ev.loginEmailVerified).toBe(false);
    }
  });

  test('the REST member shape (id, not _id) resolves too', () => {
    const ev = wixAdapter.parseEvent('member.updated', 'site-1', memberUpdated({ id: 'wix-m-2', loginEmail: 'a@b.com', loginEmailVerified: true }));
    expect(ev.platformMemberId).toBe('wix-m-2');
  });

  test('a member with no login email carries email null (never a stale order email)', () => {
    const ev = wixAdapter.parseEvent('member.updated', 'site-1', memberUpdated({ _id: 'wix-m-3' }));
    expect(ev.email).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 routing', () => {
  test('member.updated is neither a grant nor a revoke: reconcile and Retry can never replay it', () => {
    expect(jobNameForEventType('member.updated')).toBeNull();
    expect(GRANT_EVENT_TYPES).not.toContain('member.updated');
    expect(REVOKE_EVENT_TYPES).not.toContain('member.updated');
    expect(MEMBER_UPDATE_EVENT_TYPES).toEqual(['member.updated']);
  });

  test('the webhook processor enqueues it as an email_swap job with a per-event job id', async () => {
    db.query.mockImplementation((sql) => Promise.resolve({ rows: /processed_event_ids WHERE/.test(sql) ? [] : [] }));
    const ev = wixAdapter.parseEvent('wixMembers.memberUpdated', 'site-1', memberUpdated({ _id: 'wix-m-1', loginEmail: 'new@x.com', loginEmailVerified: true }));
    ev.platformClientIdHint = 'tenant-056';
    ev.traceId = 'trace-1';
    await webhookProcessor.processIncoming('evt-mu-1', ev, '{}');
    expect(mockAdd).toHaveBeenCalledTimes(1);
    expect(mockAdd.mock.calls[0][0]).toBe('email_swap');
    expect(mockAdd.mock.calls[0][1]).toMatchObject({ tenantId: 'tenant-056', standardEvent: { eventType: 'member.updated' } });
    expect(mockAdd.mock.calls[0][2]).toEqual({ jobId: 'email_swap-evt-mu-1' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 the queue worker runs the email_swap job', () => {
  const makeJob = () => ({
    id: 'job-swap', name: 'email_swap', attemptsMade: 0, opts: { attempts: 3 },
    moveToDelayed: jest.fn().mockResolvedValue(),
    data: { tenantId: 'tenant-056', standardEvent: { traceId: mintTraceId(), eventId: 'evt-mu-1', eventType: 'member.updated', platformMemberId: 'wix-m-1', email: 'new@x.com' } },
  });

  beforeAll(() => { startWorker(); });
  beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ hardware_api_key: 'enc-key' }] });
  });

  test('hands the event and the gym\'s decrypted Kisi key to the swap routine', async () => {
    loginEmailSwap.runLoginEmailSwap.mockResolvedValue({ status: 'swapped' });
    const job = makeJob();
    await processJob(job, 'tok');
    expect(loginEmailSwap.runLoginEmailSwap).toHaveBeenCalledTimes(1);
    const arg = loginEmailSwap.runLoginEmailSwap.mock.calls[0][0];
    expect(arg).toMatchObject({ tenantId: 'tenant-056', eventId: 'evt-mu-1' });
    await expect(arg.getApiKey('tenant-056')).resolves.toBe('enc-key');
    expect(retryEngine.handleFailure).not.toHaveBeenCalled();
  });

  test('a skipped swap is a quiet success, not an error', async () => {
    loginEmailSwap.runLoginEmailSwap.mockResolvedValue({ status: 'skipped', reason: 'unchanged' });
    await expect(processJob(makeJob(), 'tok')).resolves.toBeUndefined();
    expect(retryEngine.handleFailure).not.toHaveBeenCalled();
  });

  test('a deferred swap moves the job to later and throws DelayedError: no failure, no lock release, no retry used', async () => {
    loginEmailSwap.runLoginEmailSwap.mockResolvedValue({ status: 'deferred', reason: 'live_day_pass', delayMs: 3600000 });
    const job = makeJob();
    const before = Date.now();
    await expect(processJob(job, 'tok')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [when, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe('tok');
    expect(when).toBeGreaterThanOrEqual(before + 3600000);
    expect(standardAdapter.releaseLock).not.toHaveBeenCalled();
  });

  test('a blocked swap (409 with a code) is made unrecoverable and keeps its code for the Errors page', async () => {
    const blocked = Object.assign(new Error('Wix has not confirmed'), { code: 'LOGIN_EMAIL_UNVERIFIED', statusCode: 409 });
    loginEmailSwap.runLoginEmailSwap.mockRejectedValue(blocked);
    await expect(processJob(makeJob(), 'tok')).rejects.toMatchObject({ name: 'UnrecoverableError', code: 'LOGIN_EMAIL_UNVERIFIED' });
  });

  test('an email_swap job never goes through the grant or revoke paths', async () => {
    loginEmailSwap.runLoginEmailSwap.mockResolvedValue({ status: 'skipped', reason: 'unchanged' });
    await processJob(makeJob(), 'tok');
    const gr = require('../../core/grant-revoke');
    expect(gr.processGrant).not.toHaveBeenCalled();
    expect(gr.processRevoke).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 every flag says who acts and offers no useless Retry', () => {
  const CODES = [
    'LOGIN_EMAIL_UNVERIFIED', 'LOGIN_EMAIL_IN_USE', 'LOGIN_EMAIL_SHARED_USER',
    'LOGIN_EMAIL_RATE_LIMITED', 'LOGIN_EMAIL_USER_NOT_OURS', 'LOGIN_EMAIL_OLD_USER_NOT_REMOVED',
  ];

  test.each(CODES)('%s: has an owner, a plain headline, at least one step, and no Retry', (code) => {
    const g = guidanceFor({ error_code: code, http_status: 409, event_type: 'member.updated' });
    expect(['gym', 'accesssync']).toContain(g.owner);
    expect(g.retry).toBe('none');
    expect(g.headline.length).toBeGreaterThan(20);
    expect(g.steps.length).toBeGreaterThan(0);
    expect(g.steps.join(' ')).not.toMatch(/press Retry/i);
  });

  test('an unverified email is the gym\'s to chase (the member has to confirm it in Wix)', () => {
    expect(guidanceFor({ error_code: 'LOGIN_EMAIL_UNVERIFIED' }).owner).toBe('gym');
  });
});
