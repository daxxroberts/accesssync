/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: a member who leaves must end with no door, no Kisi account   │
 * │  AccessSync made, and no personal details — or the operator is told.    │
 * │                                                                         │
 * │  Same harness as real-db-error-path-state.test.js: the app's own SQL    │
 * │  against a real Postgres engine (PGlite, production schema snapshot),   │
 * │  with only Kisi, Redis and email faked.                                 │
 * │                                                                         │
 * │  2026-10-26 audit findings covered:                                     │
 * │   F1  cancel → finalize (Kisi user delete / Guard D lookup) hits a Kisi │
 * │       hiccup → the member rolled up to 'inactive' → the retry found     │
 * │       nobody → Kisi user and PII kept, no alert                         │
 * │   F2  member.deleted → deleteUser with no removeRole first → a DR-045   │
 * │       refusal had no statusCode → retried, dead-lettered with generic   │
 * │       copy, member rolled back to 'active' with the door open; on       │
 * │       success the finalize was skipped and the PII kept                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                         () => require('../helpers/real-db/pglite-db'));
jest.mock('../../adapters/hardware-adapter',  () => require('../helpers/real-db/fake-kisi').adapter);
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/retry-engine',          () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/member-mailer',         () => ({
  maybeSendGrantEmail:            jest.fn(async () => {}),
  captureAccessRemovedContext:    jest.fn(async () => null),
  maybeSendAccessRemovedEmail:    jest.fn(async () => {}),
  maybeSendAccessSuspendedEmail:  jest.fn(async () => {}),
  maybeSendAccessRestoredEmail:   jest.fn(async () => {}),
}));
jest.mock('bullmq', () => {
  const handlers = {};
  return {
    __handlers: handlers,
    Worker: jest.fn().mockImplementation(() => ({ on: (evt, fn) => { handlers[evt] = fn; } })),
    UnrecoverableError: class UnrecoverableError extends Error {
      constructor(msg) { super(msg); this.name = 'UnrecoverableError'; }
    },
    DelayedError: class DelayedError extends Error {},
    Queue: jest.fn(),
  };
});

const realDb           = require('../helpers/real-db/pglite-db');
const kisi             = require('../helpers/real-db/fake-kisi');
const retryEngine      = require('../../core/retry-engine');
const { processJob, startWorker } = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const bullmq           = require('bullmq');

const MEMBER   = 'wix-member-dana';
const EMAIL    = 'dana@example.com';
const MONTHLY  = 'plan-monthly';
const FRONT    = 'grp-front-door';

let tenantId;
let logLines = [];
let originalWrite;

beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      try { logLines.push(JSON.parse(chunk.trim())); } catch (_) { /* not a log line */ }
    }
    return true;
  };
});

afterAll(async () => {
  process.stdout.write = originalWrite;
  await realDb.close();
});

// First engine call boots PostgreSQL (WebAssembly) + the schema — give it room once.
beforeAll(() => realDb.reset(), 60000);

beforeEach(async () => {
  logLines = [];
  kisi.reset();
  retryEngine.handleFailure.mockClear();
  await realDb.reset();
  const c = await realDb.query(`INSERT INTO clients (name) VALUES ('Test Gym') RETURNING id`);
  tenantId = c.rows[0].id;
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [tenantId]);
  await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, door_name, status, access_type)
     VALUES ($1, $2, $3, 'Monthly', 'Front door', 'active', 'group')`, [tenantId, MONTHLY, FRONT]);
});

let jobSeq = 0;
function job(name, event) {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}`, name, attemptsMade: 0, opts: { attempts: 3 },
    data: {
      tenantId,
      standardEvent: {
        traceId: mintTraceId(), eventId: `evt-${jobSeq}`,
        platformMemberId: MEMBER, sourcePlatform: 'wix',
        email: EMAIL, name: 'Dana Example',
        ...event,
      },
    },
  };
}

/** Runs a job the way BullMQ does: on a throw it is retried, up to `attempts` times. */
async function runWithRetries(j, attempts = 3) {
  const errors = [];
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await processJob({ ...j, attemptsMade: attempt });
      return { errors };
    } catch (err) {
      errors.push(err);
    }
  }
  return { errors, exhausted: true };
}

const purchase      = () => job('grant',  { eventType: 'plan.purchased', planId: MONTHLY, wixOrderId: 'order-1' });
const cancel        = () => job('revoke', { eventType: 'plan.cancelled', planId: MONTHLY, wixOrderId: 'order-1', rawEventType: 'wixPricingPlans.orderCanceled' });
const memberDeleted = () => job('revoke', { eventType: 'member.deleted', rawEventType: 'wixMembers.memberDeleted' });

async function access() {
  const r = await realDb.query(
    `SELECT ma.id, ma.status, ma.hardware_user_id, ma.member_master_id, mm.email, mm.display_name
       FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [tenantId, MEMBER]);
  return r.rows[0];
}

async function sourceCount(accessId) {
  const r = await realDb.query(`SELECT COUNT(*)::int AS n FROM member_access_sources WHERE access_id = $1`, [accessId]);
  return r.rows[0].n;
}

async function alertTypes() {
  const r = await realDb.query(`SELECT alert_type FROM config_alert_log WHERE client_id = $1`, [tenantId]);
  return r.rows.map(x => x.alert_type);
}

const logged = (event) => logLines.some(l => l.event === event || l.message === event);
const kisiUserExists = (id) => kisi.state.users.has(String(id));

async function grantMonthly() {
  await processJob(purchase());
  const a = await access();
  expect(a.status).toBe('active');
  expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
  return a;
}

/** Fully finalized (DR-044): door shut, Kisi user gone, PII purged, access 'deleted'. */
async function expectFinalized(a) {
  expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
  expect(kisiUserExists(a.hardware_user_id)).toBe(false);
  const now = await access();
  expect(now.status).toBe('deleted');
  expect(now.email).toBeNull();
  expect(now.display_name).toBeNull();
}

// ── F1: the finalize hits a Kisi hiccup, then BullMQ retries ────────────────

describe('[P1] real DB — F1: a cancellation\'s finalize fails once, then the retry runs', () => {
  test('the Kisi user delete times out: the retry finds the member and finishes the finalize', async () => {
    const a = await grantMonthly();
    kisi.failNext('deleteUser');

    const run = await runWithRetries(cancel());

    expect(run.errors).toHaveLength(1);        // first attempt hit the Kisi 503
    expect(run.exhausted).toBeUndefined();     // the retry completed
    await expectFinalized(a);
    expect(logged('queue.revoke.no_identity')).toBe(false);   // the old silent outcome
  });

  test('between attempts the member is parked "removing" (findable) — door already shut, account and PII still there', async () => {
    const a = await grantMonthly();
    kisi.failNext('deleteUser');

    await expect(processJob(cancel())).rejects.toThrow(/503/);

    const now = await access();
    expect(now.status).toBe('removing');       // was 'inactive', which the retry's lookup skips
    expect(await sourceCount(a.id)).toBe(0);
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(kisiUserExists(a.hardware_user_id)).toBe(true);
    expect(now.email).toBe(EMAIL);
  });

  test('Guard D\'s role lookup fails once: no longer a quiet give-up — the retry deletes the user', async () => {
    const a = await grantMonthly();
    kisi.failNext('getRoleAssignmentsForUser');

    const run = await runWithRetries(cancel());

    expect(run.errors).toHaveLength(1);
    expect(logged('adapter.finalize_revoke.assignment_check_failed')).toBe(true);
    await expectFinalized(a);
  });

  test('Kisi stays down for every attempt: the job dead-letters (Errors page + email), the member stays "removing", and a later run still finishes it', async () => {
    const a = await grantMonthly();
    for (let i = 0; i < 3; i++) kisi.failNext('deleteUser');
    const j = cancel();

    const run = await runWithRetries(j);

    expect(run.exhausted).toBe(true);
    expect((await access()).status).toBe('removing');

    // BullMQ hands the exhausted job to the worker's 'failed' handler → retry-engine dead-letter.
    startWorker();
    await bullmq.__handlers.failed({ ...j, attemptsMade: 3 }, run.errors[2]);
    expect(retryEngine.handleFailure).toHaveBeenCalledTimes(1);

    // Kisi is back: the next run for this member (the cancel replayed) is found and finishes.
    await processJob(cancel());
    await expectFinalized(a);
  });

  test('a Member Hub sub-member removal (already "removing") whose finalize hiccups is finished by the retry too', async () => {
    const a = await grantMonthly();
    await realDb.query(`UPDATE member_access SET status = 'removing' WHERE id = $1`, [a.id]);
    kisi.failNext('deleteUser');

    const run = await runWithRetries(cancel());

    expect(run.errors).toHaveLength(1);
    await expectFinalized(a);
  });
});

// ── F2: member.deleted ──────────────────────────────────────────────────────

describe('[P1] real DB — F2: a member deleted in Wix', () => {
  test('baseline: the door is removed first, then the Kisi user is deleted and the PII purged', async () => {
    const a = await grantMonthly();

    await processJob(memberDeleted());

    await expectFinalized(a);
    expect(await sourceCount(a.id)).toBe(0);
    expect(kisi.adapter.removeRole).toHaveBeenCalledTimes(1);
    expect(kisi.adapter.removeRole.mock.invocationCallOrder[0])
      .toBeLessThan(kisi.adapter.deleteUser.mock.invocationCallOrder[0]);
    expect(await alertTypes()).toContain('member_deleted_review');
  });

  test.each([
    ['UNOWNED_USER',           'finalize_revoke_refused_unowned_user'],
    ['CLIENT_MISMATCH',        'finalize_revoke_refused_client_mismatch'],
    ['ELEVATED_ROLE_ATTACHED', 'finalize_revoke_refused_elevated_role'],
  ])('the DR-045 guard refuses the delete (%s): door still shut, one attempt (no retry loop), operator alerted, not rolled back to active', async (code, alertType) => {
    const a = await grantMonthly();
    kisi.failNext('deleteUser', Object.assign(new Error(`Kisi user refused (${code})`), { code }));

    const run = await runWithRetries(memberDeleted());

    expect(run.errors).toHaveLength(0);                       // completed on the first attempt
    expect(kisi.adapter.deleteUser).toHaveBeenCalledTimes(1);
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(kisiUserExists(a.hardware_user_id)).toBe(true);    // the account is left alone
    expect((await access()).status).toBe('inactive');         // was rolled back to 'active'
    expect(await sourceCount(a.id)).toBe(0);
    expect(await alertTypes()).toEqual(expect.arrayContaining([alertType, 'member_deleted_review']));
    expect(retryEngine.handleFailure).not.toHaveBeenCalled(); // no dead-letter with generic copy
  });

  test('a Kisi timeout removing the door: the retry still shuts it and finishes the delete', async () => {
    const a = await grantMonthly();
    kisi.failNext('removeRole');

    const run = await runWithRetries(memberDeleted());

    expect(run.errors).toHaveLength(1);
    await expectFinalized(a);
  });

  test('the Kisi user delete times out: the retry finds the member ("removing") and finishes', async () => {
    const a = await grantMonthly();
    kisi.failNext('deleteUser');

    const run = await runWithRetries(memberDeleted());

    expect(run.errors).toHaveLength(1);
    await expectFinalized(a);
    expect(logged('queue.revoke.no_identity')).toBe(false);
  });

  test('a Kisi account AccessSync did not create (OB-125 source_tag): the door is shut, the account kept, no delete attempted', async () => {
    const a = await grantMonthly();
    await realDb.query(`UPDATE member_master SET source_tag = 'manual' WHERE id = $1`, [a.member_master_id]);

    await processJob(memberDeleted());

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(kisi.adapter.deleteUser).not.toHaveBeenCalled();
    expect(kisiUserExists(a.hardware_user_id)).toBe(true);
    expect((await access()).status).toBe('inactive');
  });
});
