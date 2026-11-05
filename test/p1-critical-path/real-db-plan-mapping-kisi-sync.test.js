/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: a plan's doors change in Plan Mapping — every member on the  │
 * │  plan must end up matching it in Kisi, or the gym is told.              │
 * │                                                                         │
 * │  Daxx, 2026-11-03: when a plan's doors change (add, remove, remap),     │
 * │  "all those users need to be updated in Kisi and need to be in sync     │
 * │  with their plan mappings." Traced on main d6dab07:                     │
 * │   2. Adding a door: a Kisi failure was a log.warn — no row, no alert,   │
 * │      the member silently never got the new door.                        │
 * │   3. Turning a plan back on granted nobody: the switch-off deletes the  │
 * │      members' rows, and switch-on only looked at those rows.            │
 * │   4. Remap removed the old door before adding the new one (a failed add │
 * │      left the member with no door, reported only in the response), and  │
 * │      skipped C-4: two plans on one door share ONE Kisi role assignment, │
 * │      so the other plan's door went too.                                 │
 * │   1. The confirmation count (GET …/door-change-impact) must match what  │
 * │      the save does: C-4 members and day passes don't lose the door.     │
 * │                                                                         │
 * │  App SQL on PGlite (production schema snapshot); members are created    │
 * │  through the real purchase path (processJob). Only Kisi, Redis, auth   │
 * │  and email are faked. The sync runs after the response, so each test    │
 * │  waits for its end state before asserting.                              │
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
jest.mock('bullmq', () => ({
  Worker: jest.fn().mockImplementation(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {},
  DelayedError: class DelayedError extends Error {},
  Queue: jest.fn(),
}));
jest.mock('../../admin/middleware/activity',  () => ({ recordActivity: jest.fn() }));
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth:                (_req, _res, next) => next(),
  requireAuthPage:            (_req, _res, next) => next(),
  requireAuthPageOrOperator:  (_req, _res, next) => next(),
  requireAuthOrOperator:      (_req, _res, next) => next(),
  requireInviteToken:         (_req, _res, next) => next(),
  signToken:                  jest.fn(() => 'mock-token'),
  signOperatorToken:          jest.fn(() => 'mock-op-token'),
}));

const express          = require('express');
const request          = require('supertest');
const realDb           = require('../helpers/real-db/pglite-db');
const kisi             = require('../helpers/real-db/fake-kisi');
const { eventQueue }   = require('../../core/webhook-processor');
const { processJob }   = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');

const MONTHLY = 'plan-monthly';
const YOGA    = 'plan-yoga';
const FRONT   = 'grp-front-door';
const POOL    = 'grp-pool';
const STUDIO  = 'grp-yoga-studio';

let app;
let clientId;
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
  const operatorRouter = require('../../admin/routes/operator');
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { role: 'admin', userId: 'owner' }; next(); });
  app.use('/operator', operatorRouter);
});

afterAll(async () => {
  process.stdout.write = originalWrite;
  await realDb.close();
});

beforeAll(() => realDb.reset(), 60000);

beforeEach(async () => {
  logLines = [];
  kisi.reset();
  eventQueue.add.mockClear();
  await realDb.reset();
  clientId = (await realDb.query(`INSERT INTO clients (name) VALUES ('Test Gym') RETURNING id`)).rows[0].id;
  const loc = (await realDb.query(
    `INSERT INTO locations (client_id, name) VALUES ($1, 'House of Gains - Roland') RETURNING id`, [clientId])).rows[0].id;
  // A location's plans only grant while its AccessSync billing is active (DR-027).
  await realDb.query(`INSERT INTO billing_subscriptions (client_id, location_id, status) VALUES ($1, $2, 'active')`, [clientId, loc]);
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [clientId]);
  locationId = loc;
});
let locationId;

// ── fixtures ────────────────────────────────────────────────────────────────

/** A live plan mapping with its doors, as Plan Mapping leaves it. */
async function addPlan(planId, doors) {
  const id = (await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, location_id, status, access_type)
     VALUES ($1, $2, $3, $2, $4, 'active', 'group') RETURNING id`,
    [clientId, planId, doors[0], locationId])).rows[0].id;
  for (const d of doors) await realDb.query(`INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2)`, [id, d]);
  return id;
}

/** A member who buys the plan through the real purchase path (Wix webhook → grant job). */
let seq = 0;
async function buy(first, planId, orderId = `order-${++seq}`) {
  await processJob({
    id: `job-${++seq}`, name: 'grant', attemptsMade: 0, opts: { attempts: 5 },
    data: { tenantId: clientId, standardEvent: {
      traceId: mintTraceId(), eventId: `evt-${seq}`, sourcePlatform: 'wix',
      platformMemberId: `wix-${first.toLowerCase()}`, email: `${first.toLowerCase()}@example.com`, name: `${first} Example`,
      eventType: 'plan.purchased', planId, wixOrderId: orderId,
    } },
  });
  const a = (await realDb.query(
    `SELECT ma.id, ma.hardware_user_id FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [clientId, `wix-${first.toLowerCase()}`])).rows[0];
  return { accessId: a.id, userId: a.hardware_user_id, first, orderId };
}

const patch = (mappingId, body) => request(app).patch(`/operator/${clientId}/plan-mappings/${mappingId}`).send(body);
const impact = (mappingId, query) => request(app).get(`/operator/${clientId}/plan-mappings/${mappingId}/door-change-impact`).query(query);

async function rows(mappingId) {
  return (await realDb.query(
    `SELECT access_id, hardware_group_id, source_type FROM member_access_sources WHERE mapping_id = $1
      ORDER BY hardware_group_id, access_id`, [mappingId])).rows;
}
async function alerts() {
  return (await realDb.query(
    `SELECT alert_type, hardware_ref FROM config_alert_log WHERE client_id = $1 ORDER BY created_at, hardware_ref`, [clientId])).rows;
}
const restoreJobs = () => eventQueue.add.mock.calls
  .filter(([name, data]) => name === 'grant' && data.standardEvent.syntheticSource === 'operator.plan_mapping.restore');

async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 15));
  }
}
const hasRow = (mappingId, memberAccessId, groupId) => async () =>
  (await rows(mappingId)).some(r => r.access_id === memberAccessId && r.hardware_group_id === groupId);
const noRowOn = (mappingId, groupId) => async () => !(await rows(mappingId)).some(r => r.hardware_group_id === groupId);
const alertCount = n => async () => (await alerts()).length >= n;
const logged = (event) => logLines.filter(l => (l.event || l.message) === event);

/** Fail Kisi assignRole for one member only (whichever door), until restored. */
function failAssignFor(userId) {
  const fake = kisi.adapter.assignRole.getMockImplementation();
  kisi.adapter.assignRole.mockImplementation(async (p, k, uid, gid) => {
    if (String(uid) === String(userId)) throw Object.assign(new Error('Kisi assignRole 503'), { statusCode: 503 });
    return fake(p, k, uid, gid);
  });
  return () => kisi.adapter.assignRole.mockImplementation(fake);
}

// ── 2. Adding a door ────────────────────────────────────────────────────────

describe('[P1] real DB — adding a door to a plan gives it to every member in Kisi, or the gym is told', () => {
  test('every member on the plan gets the new door', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);

    await patch(plan, { addGroupId: POOL });
    await waitFor(async () => (await hasRow(plan, dana.accessId, POOL)()) && (await hasRow(plan, eli.accessId, POOL)()), 'pool rows');

    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(await alerts()).toEqual([]);
    expect(restoreJobs()).toHaveLength(0); // the plan was already live — no restore
  });

  test('Kisi fails for one member: they get a door_grant_failed alert; the others still get the door', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);
    const restore = failAssignFor(dana.userId);
    try {
      await patch(plan, { addGroupId: POOL });
      await waitFor(alertCount(1), 'the alert');
      await waitFor(hasRow(plan, eli.accessId, POOL), 'eli pool row');
    } finally { restore(); }

    expect(kisi.canOpen(dana.userId, POOL)).toBe(false);
    expect(await hasRow(plan, dana.accessId, POOL)()).toBe(false); // no row claims a door Kisi never gave
    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);           // nothing else touched
    expect(await alerts()).toEqual([{ alert_type: 'door_grant_failed', hardware_ref: `member_id=${dana.accessId} group_id=${POOL}` }]);

    const res = await request(app).get(`/operator/${clientId}/alerts`);
    expect(res.body.alerts[0].message).toBe(
      'Dana Example at House of Gains - Roland is missing a door their plan now includes — '
      + 'AccessSync couldn’t add it in Kisi. Add that door to their account in Kisi.');
  });
});

// ── 3. Turning a plan off and back on ───────────────────────────────────────

describe('[P1] real DB — a plan switched off and back on gives its paying members their doors back', () => {
  test('switch-off takes the doors; switch-on queues every paying member and the grant engine restores them', async () => {
    const plan = await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);

    await patch(plan, { status: 'inactive' });
    await waitFor(async () => (await rows(plan)).length === 0, 'rows removed');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);

    const res = await patch(plan, { status: 'active' });
    expect(res.status).toBe(200);
    await waitFor(() => restoreJobs().length === 2, 'two restore grants queued');

    const queued = restoreJobs().map(([, data]) => data.standardEvent);
    expect(queued.map(e => e.platformMemberId).sort()).toEqual(['wix-dana', 'wix-eli']);
    expect(queued.every(e => e.eventType === 'plan.purchased' && e.planId === MONTHLY && e.synthetic)).toBe(true);
    expect(queued.find(e => e.platformMemberId === 'wix-dana').seatOrderIds).toEqual([dana.orderId]);

    for (const [name, data, opts] of restoreJobs()) {
      await processJob({ id: opts.jobId, name, data, attemptsMade: 0, opts: { attempts: 5 } });
    }
    for (const m of [dana, eli]) {
      expect(kisi.canOpen(m.userId, FRONT)).toBe(true);
      expect(kisi.canOpen(m.userId, POOL)).toBe(true);
    }
    expect((await rows(plan)).length).toBe(4);
    expect(logged('operator.sync.restore_queued')[0]).toMatchObject({ queued: 2 });
  });

  test('only members paying now: a cancelled plan and a released seat (DR-051) are not restored', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);
    const fay  = await buy('Fay', MONTHLY);
    await realDb.query(`UPDATE member_billing SET status = 'cancelled' WHERE wix_order_id = $1`, [eli.orderId]);
    await realDb.query(`UPDATE member_billing SET holder_seated = false WHERE wix_order_id = $1`, [fay.orderId]);

    await patch(plan, { status: 'inactive' });
    await waitFor(async () => (await rows(plan)).length === 0, 'rows removed');
    await patch(plan, { status: 'active' });
    await waitFor(() => restoreJobs().length >= 1, 'restore queued');

    expect(restoreJobs().map(([, d]) => d.standardEvent.platformMemberId)).toEqual(['wix-dana']);
    expect(dana.userId).toBeTruthy();
  });

  test('taking off every door, then adding one back (Plan Mapping wire view), also restores', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);

    await patch(plan, { removeGroupId: FRONT });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);

    await patch(plan, { addGroupId: POOL });
    await waitFor(() => restoreJobs().length === 1, 'restore queued');
    for (const [name, data, opts] of restoreJobs()) {
      await processJob({ id: opts.jobId, name, data, attemptsMade: 0, opts: { attempts: 5 } });
    }
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
  });
});

// ── 4. Remap ────────────────────────────────────────────────────────────────

describe('[P1] real DB — remap adds the new door before it removes the old one', () => {
  const remap = (plan, oldGroupIds, newGroupIds) =>
    request(app).post(`/operator/${clientId}/plan-mappings/${plan}/remap`).send({ oldGroupIds, newGroupIds });

  test('members move from the old door to the new one — the new door lands first', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const order = [];
    kisi.adapter.assignRole.mock.calls.length = 0;
    const fakeAssign = kisi.adapter.assignRole.getMockImplementation();
    const fakeRemove = kisi.adapter.removeRole.getMockImplementation();
    kisi.adapter.assignRole.mockImplementation(async (...a) => { order.push('assign'); return fakeAssign(...a); });
    kisi.adapter.removeRole.mockImplementation(async (...a) => { order.push('remove'); return fakeRemove(...a); });
    let res;
    try {
      await realDb.query(`UPDATE plan_mapping_groups SET hardware_group_id = $2 WHERE mapping_id = $1`, [plan, POOL]);
      res = await remap(plan, [FRONT], [POOL]);
    } finally {
      kisi.adapter.assignRole.mockImplementation(fakeAssign);
      kisi.adapter.removeRole.mockImplementation(fakeRemove);
    }

    expect(res.body).toEqual({ moved: 1, failed: [] });
    expect(order).toEqual(['assign', 'remove']);
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect((await rows(plan)).map(r => r.hardware_group_id)).toEqual([POOL]);
  });

  test('the new door fails: the member keeps the old one (never left with none) and the gym gets door_swap_held', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);
    await realDb.query(`UPDATE plan_mapping_groups SET hardware_group_id = $2 WHERE mapping_id = $1`, [plan, POOL]);
    const restore = failAssignFor(dana.userId);
    let res;
    try { res = await remap(plan, [FRONT], [POOL]); } finally { restore(); }

    expect(res.body.moved).toBe(1);
    expect(res.body.failed).toEqual([{ memberId: dana.accessId, error: 'grant_failed' }]);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);     // kept the old door
    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(kisi.canOpen(eli.userId, FRONT)).toBe(false);
    expect(await alerts()).toEqual([{ alert_type: 'door_swap_held', hardware_ref: `member_id=${dana.accessId} group_id=${POOL}` }]);
    expect(logged('operator.sync.revoke_held')).toHaveLength(1);
  });

  test('C-4: a door another plan shares (one Kisi role assignment) stays open; only this plan moves', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT]);
    await addPlan(YOGA, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    await buy('Dana', YOGA, 'order-yoga');
    const raIds = (await realDb.query(
      `SELECT DISTINCT role_assignment_id FROM member_access_sources WHERE access_id = $1 AND hardware_group_id = $2`,
      [dana.accessId, FRONT])).rows;
    expect(raIds).toHaveLength(1); // the two plans share one Kisi role assignment

    await realDb.query(`UPDATE plan_mapping_groups SET hardware_group_id = $2 WHERE mapping_id = $1`, [monthly, POOL]);
    const res = await remap(monthly, [FRONT], [POOL]);

    expect(res.body).toEqual({ moved: 1, failed: [] });
    expect(kisi.adapter.removeRole).not.toHaveBeenCalled();
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
  });

  test('a swap saved from the classic page (groups replaced) follows the same rule', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana', MONTHLY);
    const restore = failAssignFor(dana.userId);
    try {
      await patch(plan, { groups: [{ hardware_group_id: POOL }] });
      await waitFor(alertCount(1), 'the alert');
      await waitFor(() => logged('operator.sync.revoke_held').length === 1, 'the hold');
    } finally { restore(); }

    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);
    expect((await alerts()).map(a => a.alert_type)).toEqual(['door_swap_held']);
  });
});

// ── 1. The confirmation count ───────────────────────────────────────────────

describe('[P1] real DB — the confirmation count matches what the save does', () => {
  test('removing a door: C-4 members keep it, day passes and members Kisi never saw are not counted', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT, POOL]);
    await addPlan(YOGA, [POOL]);
    const dana = await buy('Dana', MONTHLY);
    const eli  = await buy('Eli', MONTHLY);
    const gus  = await buy('Gus', MONTHLY);
    await buy('Eli', YOGA, 'order-yoga');                      // Eli keeps Pool through Yoga
    await realDb.query(                                        // a day pass on Pool
      `INSERT INTO member_access_sources (client_id, access_id, source_type, source_plan_id, mapping_id, hardware_group_id, role_assignment_id, status)
       VALUES ($1, $2, 'day_pass', 'plan-monthly#order-9#1', $3, $4, 'group-link-1', 'active')`, [clientId, gus.accessId, monthly, POOL]);
    await realDb.query(                                        // Gus's own Pool row never reached Kisi
      `UPDATE member_access_sources SET role_assignment_id = NULL, status = 'pending_hardware'
        WHERE access_id = $1 AND hardware_group_id = $2 AND source_type = 'plan'`, [gus.accessId, POOL]);

    const res = await impact(monthly, { remove: POOL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ losing: 1, keeping: 1, gaining: 0, doors: [{ groupId: POOL, losing: 1, keeping: 1 }] });

    kisi.adapter.removeRole.mockClear();
    await patch(monthly, { removeGroupId: POOL });
    await waitFor(async () => !(await rows(monthly)).some(r => r.hardware_group_id === POOL && r.source_type === 'plan'), 'pool rows removed');
    expect(kisi.adapter.removeRole).toHaveBeenCalledTimes(res.body.losing); // the save did what the count said
    expect(kisi.canOpen(dana.userId, POOL)).toBe(false);
    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
  });

  test('switching the plan off counts each member once across all its doors', async () => {
    const plan = await addPlan(MONTHLY, [FRONT, POOL]);
    await buy('Dana', MONTHLY);
    await buy('Eli', MONTHLY);

    const res = await impact(plan, { off: '1' });
    expect(res.body.losing).toBe(2);
    expect(res.body.doors.map(d => [d.groupId, d.losing]).sort()).toEqual([[FRONT, 2], [POOL, 2]]);
  });

  test('adding a door: the members on the plan — or, for a plan coming back, everyone paying for it', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    await buy('Dana', MONTHLY);
    await buy('Eli', MONTHLY);
    expect((await impact(plan, { add: POOL })).body.gaining).toBe(2);

    await patch(plan, { status: 'inactive' });
    await waitFor(async () => (await rows(plan)).length === 0, 'rows removed');
    // No rows are left — the count comes from billing, the same people the restore queues.
    expect((await impact(plan, { add: POOL })).body.gaining).toBe(2);
  });

  test('a mapping of another gym is not found', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const other = (await realDb.query(`INSERT INTO clients (name) VALUES ('Other Gym') RETURNING id`)).rows[0].id;
    const res = await request(app).get(`/operator/${other}/plan-mappings/${plan}/door-change-impact`).query({ remove: FRONT });
    expect(res.status).toBe(404);
  });
});
