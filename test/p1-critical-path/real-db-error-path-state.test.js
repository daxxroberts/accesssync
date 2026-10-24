/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: a door-system hiccup must never leave the wrong person with  │
 * │  a door — or a paying person without one — and nobody told.             │
 * │                                                                         │
 * │  These run the app's own SQL against a real Postgres engine (PGlite,    │
 * │  production schema snapshot) with only Kisi, Redis and email faked.     │
 * │  The older unit tests script db.query's answers, so a wrong WHERE       │
 * │  clause could not fail them; these can.                                 │
 * │                                                                         │
 * │  2026-10-19 review findings covered:                                    │
 * │   H1  cancel → Kisi times out → the retry found nobody → door stayed    │
 * │   H2  any failed job marked an active member 'inactive' → their later   │
 * │       cancel was skipped (stalled jobs did it too)                      │
 * │   H3  pause → resume: resume found nobody → paying member stayed locked │
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
const { eventQueue }   = require('../../core/webhook-processor');
const { processJob, startWorker } = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const bullmq           = require('bullmq');

const MEMBER   = 'wix-member-dana';
const EMAIL    = 'dana@example.com';
const MONTHLY  = 'plan-monthly';
const YOGA     = 'plan-yoga';
const FRONT    = 'grp-front-door';
const STUDIO   = 'grp-yoga-studio';

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

// The first engine call spawns the worker and boots PostgreSQL (WebAssembly) plus the
// production schema. On a busy CI box that alone can pass Jest's 5 s hook limit, which
// failed the FIRST scenario's beforeEach intermittently. Boot once here with room to
// spare; every beforeEach reset after this is fast. No assertion changes.
beforeAll(() => realDb.reset(), 60000);

beforeEach(async () => {
  logLines = [];
  kisi.reset();
  await realDb.reset();
  const c = await realDb.query(`INSERT INTO clients (name) VALUES ('Test Gym') RETURNING id`);
  tenantId = c.rows[0].id;
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [tenantId]);
  await addPlan(MONTHLY, FRONT, 'Monthly');
});

async function addPlan(planId, groupId, name) {
  await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, door_name, status, access_type)
     VALUES ($1, $2, $3, $4, 'Front door', 'active', 'group')`, [tenantId, planId, groupId, name]);
}

let jobSeq = 0;
function job(name, event, attemptsMade = 0) {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}`, name, attemptsMade, opts: { attempts: 5 },
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

const purchase = (planId = MONTHLY, orderId = 'order-1') =>
  job('grant',  { eventType: 'plan.purchased', planId, wixOrderId: orderId });
const cancel   = (planId = MONTHLY, orderId = 'order-1') =>
  job('revoke', { eventType: 'plan.cancelled', planId, wixOrderId: orderId, rawEventType: 'wixPricingPlans.orderCanceled' });
const pause    = () => job('revoke', { eventType: 'payment.failed',    planId: MONTHLY, rawEventType: 'wixPricingPlans.orderPaused' });
const resume   = () => job('grant',  { eventType: 'payment.recovered', planId: MONTHLY, rawEventType: 'wixPricingPlans.orderResumed' });

async function access() {
  const r = await realDb.query(
    `SELECT ma.id, ma.status, ma.hardware_user_id
       FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [tenantId, MEMBER]);
  return r.rows[0];
}

async function sources() {
  const a = await access();
  const r = await realDb.query(
    `SELECT source_plan_id, hardware_group_id, status FROM member_access_sources WHERE access_id = $1 ORDER BY source_plan_id`,
    [a.id]);
  return r.rows;
}

const logged = (event) => logLines.some(l => l.event === event || l.message === event);

async function grantMonthly() {
  await processJob(purchase());
  const a = await access();
  expect(a.status).toBe('active');
  expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
  return a;
}

// ── Baseline: the happy path works against the real schema ──────────────────

describe('[P1] real DB — baseline: buy, then cancel', () => {
  test('a purchase opens the door; a cancellation closes it and finalizes the member', async () => {
    const a = await grantMonthly();
    expect(await sources()).toEqual([{ source_plan_id: MONTHLY, hardware_group_id: FRONT, status: 'active' }]);

    await processJob(cancel());

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(kisi.state.users.has(String(a.hardware_user_id))).toBe(false); // DR-044 finalize removed the Kisi user
    expect((await access()).status).toBe('deleted');
  });

  test('cancelling one of two plans on the same door keeps the door (the other plan still pays)', async () => {
    await addPlan(YOGA, FRONT, 'Yoga');
    const a = await grantMonthly();
    await processJob(purchase(YOGA, 'order-2'));
    expect((await sources()).map(s => s.source_plan_id)).toEqual([MONTHLY, YOGA]);

    await processJob(cancel(MONTHLY, 'order-1'));

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect(kisi.adapter.removeRole).not.toHaveBeenCalled();
    expect((await sources()).map(s => s.source_plan_id)).toEqual([YOGA]);
    expect((await access()).status).toBe('active');
  });

  test('buy, cancel (finalized), buy again: the re-purchase gets a live Kisi user and the door opens', async () => {
    const first = await grantMonthly();
    await processJob(cancel());
    expect((await access()).status).toBe('deleted');

    await processJob(purchase(MONTHLY, 'order-2'));

    const again = await access();
    expect(again.status).toBe('active');
    expect(again.hardware_user_id).not.toBe(first.hardware_user_id); // the finalized id was dropped (#7)
    expect(kisi.canOpen(again.hardware_user_id, FRONT)).toBe(true);
  });

  test('a member marked "removing" (Member Hub sub-member removal, DR-044) is still found by the cancel', async () => {
    const a = await grantMonthly();
    await realDb.query(`UPDATE member_access SET status = 'removing' WHERE id = $1`, [a.id]);

    await processJob(cancel());

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
  });

  test('a cancel for someone AccessSync never saw is still a quiet skip', async () => {
    await processJob({ ...cancel(), data: { tenantId, standardEvent: { ...cancel().data.standardEvent, platformMemberId: 'wix-stranger' } } });

    expect(logged('queue.revoke.no_identity')).toBe(true);
    expect(kisi.adapter.removeRole).not.toHaveBeenCalled();
  });
});

// ── H1: Kisi hiccup during a cancellation ───────────────────────────────────

describe('[P1] real DB — H1: Kisi times out during a cancellation, then the retry runs', () => {
  test('the retry still removes the door role — the cancelled member cannot get in', async () => {
    const a = await grantMonthly();
    kisi.failNext('removeRole');

    const run = await runWithRetries(cancel());

    expect(run.errors).toHaveLength(1);              // first attempt hit the Kisi 503
    expect(run.exhausted).toBeUndefined();           // a retry then completed
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(logged('queue.revoke.no_identity')).toBe(false);
  });

  test('after the failed attempt the plan\'s source row is still there to retry from', async () => {
    await grantMonthly();
    kisi.failNext('removeRole');

    await expect(processJob(cancel())).rejects.toThrow(/503/);

    expect(await sources()).toEqual([{ source_plan_id: MONTHLY, hardware_group_id: FRONT, status: 'active' }]);
  });
});

// ── H2: a failed job must not mark an active member inactive ────────────────

describe('[P1] real DB — H2: an unrelated failed job, then the member cancels', () => {
  test('a failed second purchase leaves the member active, and their cancellation still closes the door', async () => {
    await addPlan(YOGA, STUDIO, 'Yoga');
    const a = await grantMonthly();
    kisi.failNext('assignRole');

    await expect(processJob(purchase(YOGA, 'order-2'))).rejects.toThrow(/503/);
    expect((await access()).status).toBe('active');   // still paying for Monthly, still has the front door

    await processJob(cancel(MONTHLY, 'order-1'));

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(logged('queue.revoke.no_identity')).toBe(false);
  });

  test('a stalled job (worker killed mid-job) releases the lock without marking the member inactive', async () => {
    const a = await grantMonthly();
    startWorker();
    const stalled = bullmq.__handlers.stalled;
    expect(typeof stalled).toBe('function');

    // A cancel job took the lock (status in_flight) and the worker died before Kisi was called.
    await realDb.query(`UPDATE member_access SET status = 'in_flight' WHERE id = $1`, [a.id]);
    const stalledJob = cancel();
    eventQueue.getJob.mockResolvedValueOnce(stalledJob);
    await stalled(stalledJob.id);

    expect((await access()).status).toBe('active');

    await processJob(cancel()); // BullMQ re-runs the stalled job
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
  });
});

// ── H3: pause then resume ───────────────────────────────────────────────────

describe('[P1] real DB — H3: a paused membership resumes', () => {
  test('pause suspends the member; resume re-enables them and the door opens again', async () => {
    const a = await grantMonthly();

    await processJob(pause());
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(await sources()).toEqual([{ source_plan_id: MONTHLY, hardware_group_id: FRONT, status: 'failed' }]);

    await processJob(resume());

    expect(kisi.adapter.enableAccess).toHaveBeenCalledTimes(1);
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect((await access()).status).toBe('active');
    expect(logged('queue.grant.recovered.no_identity')).toBe(false);
  });

  test('a cancellation while paused still removes the door role', async () => {
    const a = await grantMonthly();
    await processJob(pause());

    await processJob(cancel());

    expect(kisi.adapter.removeRole).toHaveBeenCalledTimes(1);
    const roleLeft = [...kisi.state.roles.values()].some(r => r.groupId === FRONT);
    expect(roleLeft).toBe(false);
    expect(logged('queue.revoke.no_identity')).toBe(false);
  });
});
