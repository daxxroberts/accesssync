/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: the member's cached Kisi user was deleted — recover by       │
 * │  recreating it once, instead of failing every grant forever             │
 * │                                                                         │
 * │  Business consequence: member_access.hardware_user_id is a cache that   │
 * │  resolveIdentity returns without asking Kisi. Once that Kisi user is    │
 * │  deleted (finalizeRevoke, or the gym in the Kisi dashboard) Kisi        │
 * │  answers POST /role_assignments with 422 {"errors":{"assignee":["must   │
 * │  exist"]}} — NOT a 404 (trace 8c92ad90, 2026-10-15). That 422 was       │
 * │  rethrown as-is, dead-lettered on attempt 1, and reconcile re-queued    │
 * │  the same grant with the same dead id: a paying Couples plan holder     │
 * │  failed 12 grants from 2026-09-30 and never got a door.                 │
 * │                                                                         │
 * │  Fix:                                                                   │
 * │    grant-revoke  — a 422 "assignee must exist" goes through the I-6     │
 * │                    user lookup like a 404: user gone → HARDWARE_USER_   │
 * │                    GONE; user present → recorded, group NEVER flagged.  │
 * │    queue-worker  — on HARDWARE_USER_GONE, resolveIdentity(force:true)   │
 * │                    recreates the user once and processGrant runs once   │
 * │                    more with the new id. Never more than twice a job.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// grant-revoke is the REAL module (its 422 handling is under test). The queue-worker
// suites spy on its processGrant so the coordinator can be driven call by call.

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole:   jest.fn(),
  getUserById:  jest.fn(),
  enableAccess: jest.fn(),
}));

jest.mock('../../adapters/standard-adapter', () => ({
  resolveAndLock:      jest.fn(),
  resolveIdentity:     jest.fn(),
  completeGrant:       jest.fn(),
  completeRevoke:      jest.fn(),
  releaseLock:         jest.fn(),
  parkPendingStart:    jest.fn(),
  parkPendingHardware: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/retry-engine',          () => ({ handleFailure: jest.fn().mockResolvedValue() }));
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn((enc) => `plaintext-${enc}`) }));
jest.mock('../../core/member-mailer', () => ({
  maybeSendGrantEmail:          jest.fn().mockResolvedValue(),
  maybeSendAccessRestoredEmail: jest.fn().mockResolvedValue(),
  maybeSendDayPassEmail:        jest.fn().mockResolvedValue(),
}));
jest.mock('../../core/member-access-log', () => ({
  logMemberAccessEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../core/logger', () => {
  const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
  return { log, withTrace: jest.fn(() => log) };
});

jest.mock('../../core/trace-context', () => ({
  getTraceId:       jest.fn().mockReturnValue('trace-user-gone-recreate'),
  getActor:         jest.fn().mockReturnValue({ type: 'system', id: 'queue-worker' }),
  runWith:          jest.fn((ctx, fn) => fn()),
  registerTrace:    jest.fn(),
  setTraceContext:  jest.fn(),
  mintTraceId:      jest.fn(() => 'trace-minted'),
}));

jest.mock('bullmq', () => ({
  Queue:  jest.fn(() => ({ add: jest.fn(), on: jest.fn() })),
  Worker: jest.fn(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {
    constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
  },
  DelayedError: class DelayedError extends Error {},
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const standardAdapter = require('../../adapters/standard-adapter');
const mappingResolver = require('../../core/plan-mapping-resolver');
const { log }         = require('../../core/logger');
const grantRevoke     = require('../../core/grant-revoke');
const { processJob }  = require('../../core/queue-worker');

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID     = 'client-hog-001';
const MEMBER_ID     = 'member-access-001';
const STALE_HW_ID   = 'kisi-user-dead-4242';
const NEW_HW_ID     = 'kisi-user-new-9001';
const API_KEY       = 'plaintext-key';

const mappingA = { mappingId: 'mapping-a', hardwareGroupId: '838622', hardwarePlatform: 'kisi', apiKey: API_KEY };
const mappingB = { mappingId: 'mapping-b', hardwareGroupId: '999999', hardwarePlatform: 'kisi', apiKey: API_KEY };

const wixEvent = { eventType: 'plan.purchased', planId: 'plan-couples', platformMemberId: 'wix-member-xyz' };

/** The error adapters/kisi/kisi-connector.js throws for Kisi's 422 on a deleted assignee. */
function kisi422AssigneeMissing() {
  const e = new Error('Kisi 422: {"errors":{"assignee":["must exist"]}}');
  Object.assign(e, {
    statusCode: 422, code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY',
    body: { errors: { assignee: ['must exist'] } },
  });
  return e;
}
/** Any other 422 — e.g. a bad valid_until. */
function kisi422Other() {
  const e = new Error('Kisi 422: {"errors":{"valid_until":["is invalid"]}}');
  Object.assign(e, {
    statusCode: 422, code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY',
    body: { errors: { valid_until: ['is invalid'] } },
  });
  return e;
}
function userGoneErr(id = STALE_HW_ID) {
  const e = new Error(`Hardware user ${id} no longer exists on kisi (assignRole 422 on group 838622); group not flagged`);
  Object.assign(e, { code: 'HARDWARE_USER_GONE', statusCode: 422, hardwareUserId: id, hardwarePlatform: 'kisi' });
  return e;
}

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));
const sqlCalls        = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));
const groupFlagWrites = () => sqlCalls(/UPDATE\s+plan_mapping_groups/i);
const groupAlerts     = () => sqlCalls(/INSERT INTO config_alert_log/i).filter(([sql]) => /group_not_found/.test(sql));
const warnEvents      = () => log.warn.mock.calls.map(([event]) => event);

// processGrant pre-checks: no prior source rows → every mapping goes to assignRole.
// getClientApiKey: one encrypted key row.
function defaultDb() {
  db.query.mockImplementation(async (sql) => {
    if (/FROM connector_subscriptions/i.test(sql)) return { rows: [{ hardware_api_key: 'enc' }] };
    if (/^\s*SELECT/i.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  defaultDb();
});

// ═══════════════════════════════════════════════════════════════════════════
// grant-revoke — the 422 is recognised as "user gone"
// ═══════════════════════════════════════════════════════════════════════════

describe('[P1] grant-revoke — Kisi 422 "assignee must exist"', () => {

  test('user lookup null → throws HARDWARE_USER_GONE (status 422, says "assignRole 422"), group NOT flagged, no group_not_found alert', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi422AssigneeMissing());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    expect(thrown).toMatchObject({ code: 'HARDWARE_USER_GONE', statusCode: 422, hardwareUserId: STALE_HW_ID });
    expect(thrown.message).toContain('assignRole 422');
    expect(thrown.cause.body).toEqual({ errors: { assignee: ['must exist'] } });
    expect(hardwareAdapter.getUserById).toHaveBeenCalledWith('kisi', API_KEY, STALE_HW_ID);
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlerts()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.user_gone');
    expect(warnEvents()).not.toContain('grant.group_not_found');
  });

  test('user gone on the 422 → the next mapping on the same door account is not sent to Kisi (same F3 skip as a 404)', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi422AssigneeMissing());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA, mappingB], wixEvent)
    ).rejects.toMatchObject({ code: 'HARDWARE_USER_GONE' });

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getUserById).toHaveBeenCalledTimes(1);
  });

  test('user PRESENT → never flags the group; warns grant.assignee_missing_user_present and throws the 422 when nothing was collected', async () => {
    const original = kisi422AssigneeMissing();
    hardwareAdapter.assignRole.mockRejectedValue(original);
    hardwareAdapter.getUserById.mockResolvedValue({ id: STALE_HW_ID, email: 'x@example.com' });

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    expect(thrown).toBe(original);
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlerts()).toHaveLength(0);
    expect(warnEvents()).not.toContain('grant.group_not_found');
    expect(warnEvents()).not.toContain('grant.user_gone');
    const w = log.warn.mock.calls.find(([e]) => e === 'grant.assignee_missing_user_present');
    expect(w).toBeDefined();
    expect(w[1]).toMatchObject({
      clientId: TENANT_ID, memberId: MEMBER_ID, hardwareUserId: STALE_HW_ID,
      mappingId: 'mapping-a', hardwareGroupId: mappingA.hardwareGroupId,
      stage: 'grant', result: 'failed',
    });
  });

  test('user PRESENT on mapping A, mapping B succeeds → partial success, reason assignee_missing_user_present, nothing flagged', async () => {
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(kisi422AssigneeMissing())
      .mockResolvedValueOnce('kisi-ra-b-1');
    hardwareAdapter.getUserById.mockResolvedValue({ id: STALE_HW_ID });

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA, mappingB], wixEvent);
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-b', roleAssignmentId: 'kisi-ra-b-1' });
    expect(groupFlagWrites()).toHaveLength(0);
    const partial = log.warn.mock.calls.find(([e]) => e === 'grant.partial_failure')[1];
    expect(partial).toMatchObject({ failureReasons: ['assignee_missing_user_present'] });
  });

  test('user lookup throws on the 422 → ambiguous: the original 422 is thrown, group NOT flagged', async () => {
    const original = kisi422AssigneeMissing();
    hardwareAdapter.assignRole.mockRejectedValue(original);
    hardwareAdapter.getUserById.mockRejectedValue(Object.assign(new Error('Kisi 503'), { statusCode: 503 }));

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA], wixEvent)
    ).rejects.toBe(original);
    await flushImmediates();

    expect(groupFlagWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
  });

  test('a 422 WITHOUT the assignee message is unchanged: rethrown immediately, no user lookup, loop stops', async () => {
    const other = kisi422Other();
    hardwareAdapter.assignRole.mockRejectedValue(other);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA, mappingB], wixEvent)
    ).rejects.toBe(other);
    await flushImmediates();

    expect(hardwareAdapter.getUserById).not.toHaveBeenCalled();
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(groupFlagWrites()).toHaveLength(0);
  });

  test('a 422 whose body is missing / malformed never matches (no lookup)', async () => {
    const bare = Object.assign(new Error('Kisi 422: unknown'), { statusCode: 422, code: 'HARDWARE_VALIDATION_ERROR' });
    hardwareAdapter.assignRole.mockRejectedValue(bare);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA], wixEvent)
    ).rejects.toBe(bare);
    expect(hardwareAdapter.getUserById).not.toHaveBeenCalled();
  });

  test('existing 404 user-gone message still says "assignRole 404" (status carried through)', async () => {
    const e404 = Object.assign(new Error('Kisi 404: Not Found'), { statusCode: 404, code: 'HARDWARE_RESOURCE_NOT_FOUND' });
    hardwareAdapter.assignRole.mockRejectedValue(e404);
    hardwareAdapter.getUserById.mockResolvedValue(null);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, STALE_HW_ID, [mappingA], wixEvent)
    ).rejects.toMatchObject({ code: 'HARDWARE_USER_GONE', statusCode: 404, message: expect.stringContaining('assignRole 404') });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// queue-worker — recreate the user once and retry
// ═══════════════════════════════════════════════════════════════════════════

const queueMappings = [{ ...mappingA, accessType: 'group', planName: 'Couples', doorName: 'Front' }];
const SECOND_ASSIGNMENTS = [{ mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-new-1', hardwareGroupId: mappingA.hardwareGroupId }];

function makeJob(eventType = 'plan.purchased') {
  return {
    id: 'job-user-gone', name: 'grant', attemptsMade: 0, opts: { attempts: 3 },
    data: {
      tenantId: TENANT_ID,
      standardEvent: {
        traceId: 'trace-user-gone-recreate', eventId: 'evt-1', eventType,
        platformMemberId: 'wix-member-xyz', planId: 'plan-couples',
        email: 'holder@example.com', name: 'Couples Holder',
      },
    },
  };
}

function setupQueue() {
  mappingResolver.resolve.mockResolvedValue(queueMappings);
  standardAdapter.resolveAndLock.mockResolvedValue({ memberId: MEMBER_ID, hardwareUserId: STALE_HW_ID, hardwarePlatform: 'kisi' });
  standardAdapter.resolveIdentity.mockReset();
  standardAdapter.completeGrant.mockResolvedValue();
  standardAdapter.releaseLock.mockResolvedValue();
}

async function run(job) {
  let thrown;
  try { await processJob(job); } catch (e) { thrown = e; }
  return thrown;
}

describe.each([
  ['main grant path (plan.purchased)', 'plan.purchased'],
  ['plan.started path',                'plan.started'],
])('[P1] queue-worker %s — HARDWARE_USER_GONE recovers by recreating the user once', (_label, eventType) => {

  let processGrant;
  beforeEach(() => {
    setupQueue();
    processGrant = jest.spyOn(grantRevoke, 'processGrant');
  });
  afterEach(() => { processGrant.mockRestore(); });

  test('first processGrant user-gone → resolveIdentity(force:true) → second processGrant with the NEW id → completeGrant gets the second call\'s assignments', async () => {
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)   // cache hit (the dead id)
      .mockResolvedValueOnce(NEW_HW_ID);    // force: recreated
    processGrant
      .mockRejectedValueOnce(userGoneErr())
      .mockResolvedValueOnce(SECOND_ASSIGNMENTS);

    const thrown = await run(makeJob(eventType));

    expect(thrown).toBeUndefined();
    expect(processGrant).toHaveBeenCalledTimes(2);
    expect(processGrant.mock.calls[0][2]).toBe(STALE_HW_ID);
    expect(processGrant.mock.calls[1][2]).toBe(NEW_HW_ID);
    expect(processGrant.mock.calls[1][3]).toBe(queueMappings);

    expect(standardAdapter.resolveIdentity).toHaveBeenCalledTimes(2);
    expect(standardAdapter.resolveIdentity).toHaveBeenLastCalledWith(
      MEMBER_ID, 'holder@example.com', 'Couples Holder', 'kisi', 'plaintext-enc',
      { tenantId: TENANT_ID, platformMemberId: 'wix-member-xyz', force: true }
    );
    // the first resolveIdentity is the ordinary cached one — no force
    expect(standardAdapter.resolveIdentity.mock.calls[0][5].force).toBeUndefined();

    expect(standardAdapter.completeGrant).toHaveBeenCalledTimes(1);
    expect(standardAdapter.completeGrant.mock.calls[0][2]).toBe(SECOND_ASSIGNMENTS);
    expect(standardAdapter.releaseLock).not.toHaveBeenCalled();

    const recreating = log.warn.mock.calls.find(([e]) => e === 'queue.grant.user_gone_recreating');
    expect(recreating[1]).toMatchObject({
      clientId: TENANT_ID, memberId: MEMBER_ID, eventId: 'evt-1', platformMemberId: 'wix-member-xyz',
      staleHardwareUserId: STALE_HW_ID, stage: 'identity', result: 'retry',
    });
    const recreated = log.warn.mock.calls.find(([e]) => e === 'queue.grant.user_recreated');
    expect(recreated[1]).toMatchObject({ staleHardwareUserId: STALE_HW_ID, newHardwareUserId: NEW_HW_ID });
  });

  test('recreate returns the SAME id → the original HARDWARE_USER_GONE is rethrown (dead-letters), processGrant called once', async () => {
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)
      .mockResolvedValueOnce(STALE_HW_ID);
    const original = userGoneErr();
    processGrant.mockRejectedValueOnce(original);

    const thrown = await run(makeJob(eventType));

    expect(processGrant).toHaveBeenCalledTimes(1);
    expect(thrown.name).toBe('UnrecoverableError');
    expect(thrown.original).toBe(original);
    expect(thrown.code).toBe('HARDWARE_USER_GONE');
    expect(standardAdapter.completeGrant).not.toHaveBeenCalled();
    expect(standardAdapter.releaseLock).toHaveBeenCalledWith(MEMBER_ID, TENANT_ID, 'failed');
    expect(warnEvents()).not.toContain('queue.grant.user_recreated');
  });

  test('recreate returns null (parked pending_identity) → no completeGrant, no throw, no second processGrant', async () => {
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)
      .mockResolvedValueOnce(null);
    processGrant.mockRejectedValueOnce(userGoneErr());

    const thrown = await run(makeJob(eventType));

    expect(thrown).toBeUndefined();
    expect(processGrant).toHaveBeenCalledTimes(1);
    expect(standardAdapter.completeGrant).not.toHaveBeenCalled();
    expect(standardAdapter.releaseLock).not.toHaveBeenCalled();
  });

  test('second processGrant fails → that error propagates unchanged; processGrant called exactly twice', async () => {
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)
      .mockResolvedValueOnce(NEW_HW_ID);
    const secondErr = Object.assign(new Error('Kisi 503'), { statusCode: 503 });
    processGrant
      .mockRejectedValueOnce(userGoneErr())
      .mockRejectedValueOnce(secondErr);

    const thrown = await run(makeJob(eventType));

    expect(thrown).toBe(secondErr);           // 5xx: rethrown as-is for BullMQ retry
    expect(processGrant).toHaveBeenCalledTimes(2);
    expect(standardAdapter.completeGrant).not.toHaveBeenCalled();
  });

  test('second processGrant ALSO user-gone → no third attempt; error propagates (dead-letters)', async () => {
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)
      .mockResolvedValueOnce(NEW_HW_ID);
    const secondGone = userGoneErr(NEW_HW_ID);
    processGrant
      .mockRejectedValueOnce(userGoneErr())
      .mockRejectedValueOnce(secondGone);

    const thrown = await run(makeJob(eventType));

    expect(processGrant).toHaveBeenCalledTimes(2);
    expect(standardAdapter.resolveIdentity).toHaveBeenCalledTimes(2);
    expect(thrown.name).toBe('UnrecoverableError');
    expect(thrown.original).toBe(secondGone);
  });

  test('any other first-call error propagates unchanged — no recreate attempted', async () => {
    standardAdapter.resolveIdentity.mockResolvedValueOnce(STALE_HW_ID);
    const e500 = Object.assign(new Error('Kisi 500'), { statusCode: 500 });
    processGrant.mockRejectedValueOnce(e500);

    const thrown = await run(makeJob(eventType));

    expect(thrown).toBe(e500);
    expect(processGrant).toHaveBeenCalledTimes(1);
    expect(standardAdapter.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(warnEvents()).not.toContain('queue.grant.user_gone_recreating');
  });

  test('happy path untouched: processGrant succeeds first time → one call, no recreate', async () => {
    standardAdapter.resolveIdentity.mockResolvedValueOnce(STALE_HW_ID);
    processGrant.mockResolvedValueOnce(SECOND_ASSIGNMENTS);

    const thrown = await run(makeJob(eventType));

    expect(thrown).toBeUndefined();
    expect(processGrant).toHaveBeenCalledTimes(1);
    expect(standardAdapter.resolveIdentity).toHaveBeenCalledTimes(1);
    expect(standardAdapter.completeGrant.mock.calls[0][2]).toBe(SECOND_ASSIGNMENTS);
  });
});

describe('[P1] end to end through the real grant-revoke: 422 assignee → recreate → granted', () => {
  test('stale id 422s, user lookup null, recreated id gets the role → completeGrant records it', async () => {
    setupQueue();
    standardAdapter.resolveIdentity
      .mockResolvedValueOnce(STALE_HW_ID)
      .mockResolvedValueOnce(NEW_HW_ID);
    hardwareAdapter.assignRole.mockImplementation(async (_p, _k, userId) => {
      if (userId === STALE_HW_ID) throw kisi422AssigneeMissing();
      return 'kisi-ra-recreated';
    });
    hardwareAdapter.getUserById.mockResolvedValue(null);

    const thrown = await run(makeJob('plan.purchased'));
    await flushImmediates();

    expect(thrown).toBeUndefined();
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(hardwareAdapter.assignRole).toHaveBeenLastCalledWith('kisi', API_KEY, NEW_HW_ID, mappingA.hardwareGroupId);
    const recorded = standardAdapter.completeGrant.mock.calls[0][2];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ roleAssignmentId: 'kisi-ra-recreated', hardwareCallMade: true });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlerts()).toHaveLength(0);
  });
});
