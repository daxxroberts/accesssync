/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: the reconcile sweep (every 6 hours, and the dashboard's      │
 * │  "Sync now") finishes what a Plan Mapping save or a removal left        │
 * │  half-done.                                                             │
 * │                                                                         │
 * │  Daxx, 2026-11-05: members stay in sync with their plan mappings — a    │
 * │  door added to a plan reaches everyone on it, a door taken off leaves   │
 * │  everyone on it — and "if for some reason the delete fails, the sweep   │
 * │  catches that that person should have been deleted". A door change      │
 * │  never deletes the user; an owner / administrator and a door staff gave │
 * │  by hand in Kisi are never touched; a payment that is only declined or  │
 * │  pending is never a removal.                                            │
 * │                                                                         │
 * │  Same harness as real-db-plan-mapping-kisi-sync.test.js: app SQL on     │
 * │  PGlite (production schema snapshot), members created through the real  │
 * │  purchase path, Kisi faked with real state, the Plan Mapping save run   │
 * │  through its route. Wix is the two classified order reads the sweep     │
 * │  makes; the queue is faked, so a job the sweep queues is run here by    │
 * │  hand through the real worker.                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                         () => require('../helpers/real-db/pglite-db'));
jest.mock('../../adapters/hardware-adapter',  () => require('../helpers/real-db/fake-kisi').adapter);
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/retry-engine',          () => ({ handleFailure: jest.fn(), resolveFinishedRemoval: jest.fn(async () => 0) }));
jest.mock('../../core/operator-mailer',       () => ({ sendOperatorEmail: jest.fn(async () => ({ sent: false, reason: 'test' })) }));
jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listOrdersClassified:  jest.fn(),
  listConfirmedBookings: jest.fn(),
  listActiveOrders:      jest.fn(),
}));
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
const wix              = require('../../adapters/wix/wix-plans-api');
const { eventQueue }   = require('../../core/webhook-processor');
const { processJob }   = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const reconciliation   = require('../../core/reconciliation');

const MONTHLY = 'plan-monthly';
const YOGA    = 'plan-yoga';
const FRONT   = 'grp-front-door';
const POOL    = 'grp-pool';
const STUDIO  = 'grp-yoga-studio';
const STAFF   = 'grp-staff-room';     // a door AccessSync never maps

let app;
let clientId;
let locationId;
let logLines = [];
let originalWrite;
const restores = [];

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
  reconciliation._doubleReadDelayMs = 0;
  reconciliation._sweepTraceId = 'sweep-resync-test';
  await realDb.reset();
  clientId = (await realDb.query(
    `INSERT INTO clients (name, source_site_id, source_api_key, auto_revoke_mode)
     VALUES ('Test Gym', 'wix-site', 'wix-key', 'on') RETURNING id`)).rows[0].id;
  locationId = (await realDb.query(
    `INSERT INTO locations (client_id, name) VALUES ($1, 'House of Gains - Roland') RETURNING id`, [clientId])).rows[0].id;
  await realDb.query(`INSERT INTO billing_subscriptions (client_id, location_id, status) VALUES ($1, $2, 'active')`, [clientId, locationId]);
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [clientId]);
});

afterEach(() => {
  while (restores.length) restores.pop()();
  for (const k of ['RECONCILE_DOOR_REPAIR', 'RECONCILE_DOOR_REMOVAL', 'RECONCILE_WIX_ABSENCE_REMOVAL', 'RECONCILE_FINISH_REMOVAL']) {
    delete process.env[k];
  }
});

// ── fixtures ────────────────────────────────────────────────────────────────

async function addPlan(planId, doors) {
  const id = (await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, location_id, status, access_type)
     VALUES ($1, $2, $3, $2, $4, 'active', 'group') RETURNING id`,
    [clientId, planId, doors[0], locationId])).rows[0].id;
  for (const d of doors) await realDb.query(`INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2)`, [id, d]);
  return id;
}

let seq = 0;
const wixId = (first) => `wix-${first.toLowerCase()}`;
async function buy(first, planId = MONTHLY) {
  const orderId = `order-${first.toLowerCase()}-${planId}`;
  await processJob({
    id: `job-${++seq}`, name: 'grant', attemptsMade: 0, opts: { attempts: 5 },
    data: { tenantId: clientId, standardEvent: {
      traceId: mintTraceId(), eventId: `evt-${seq}`, sourcePlatform: 'wix',
      platformMemberId: wixId(first), email: `${first.toLowerCase()}@example.com`, name: `${first} Example`,
      eventType: 'plan.purchased', planId, wixOrderId: orderId,
    } },
  });
  const a = (await realDb.query(
    `SELECT ma.id, ma.hardware_user_id FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [clientId, wixId(first)])).rows[0];
  return { accessId: a.id, userId: a.hardware_user_id, first, key: wixId(first) };
}

/** The member's own Wix cancellation, through the real revoke path, run the way BullMQ runs it. */
async function cancel(m, planId = MONTHLY) {
  const j = {
    id: `job-${++seq}`, name: 'revoke', opts: { attempts: 3 },
    data: { tenantId: clientId, standardEvent: {
      traceId: mintTraceId(), eventId: `evt-${seq}`, sourcePlatform: 'wix', platformMemberId: m.key,
      eventType: 'plan.cancelled', planId, wixOrderId: `order-${m.first.toLowerCase()}-${planId}`,
      rawEventType: 'wixPricingPlans.orderCanceled',
    } },
  };
  return runQueued(j);
}

/** Runs a job through the real worker with BullMQ's retries; returns whether it ever completed. */
async function runQueued(j, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await processJob({ ...j, attemptsMade: attempt }); return true; } catch (_) { /* retried */ }
  }
  return false;
}

/** A classified Wix order, as wix-plans-api listOrdersClassified returns it. */
function order(m, planId = MONTHLY, classification = 'PAYING') {
  return {
    orderId: `order-${m.first.toLowerCase()}-${planId}`, memberId: m.key, planId, classification,
    status: classification === 'ENDED' ? 'ENDED' : 'ACTIVE', lastPaymentStatus: 'PAID',
    autoRenewCanceled: false, endDate: null, rawOrder: null,
  };
}
const paying = (members, planId = MONTHLY) => members.map(m => order(m, planId));

/** One sync, exactly as the dashboard's Sync now runs it (POST /operator/sync/run → _syncClient). */
async function sweep(orders) {
  wix.listOrdersClassified.mockResolvedValue(orders);
  wix.listConfirmedBookings.mockResolvedValue([]);
  const res = await request(app).post('/operator/sync/run').send({ clientId });
  expect(res.status).toBe(200);
  return res.body;
}

const patch = (mappingId, body) => request(app).patch(`/operator/${clientId}/plan-mappings/${mappingId}`).send(body);

async function rows(mappingId) {
  return (await realDb.query(
    `SELECT access_id, hardware_group_id FROM member_access_sources WHERE mapping_id = $1
      ORDER BY hardware_group_id, access_id`, [mappingId])).rows;
}
async function openAlerts() {
  return (await realDb.query(
    `SELECT alert_type, hardware_ref FROM config_alert_log WHERE client_id = $1 AND resolved_at IS NULL
      ORDER BY alert_type, hardware_ref`, [clientId])).rows;
}
async function accessOf(m) {
  return (await realDb.query(
    `SELECT ma.status, mm.email FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE ma.id = $1`, [m.accessId])).rows[0];
}
async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 15));
  }
}
const hasOpenAlert = (type) => async () => (await openAlerts()).some(a => a.alert_type === type);
const logged = (event) => logLines.filter(l => (l.event || l.message) === event);
const kisiUserExists = (id) => kisi.state.users.has(String(id));
const queuedRevokes = () => eventQueue.add.mock.calls.filter(([name]) => name === 'revoke');

/** Kisi fails one member's calls of `method` (assignRole / removeRole) until the test ends. */
function failFor(method, userId) {
  const fake = kisi.adapter[method].getMockImplementation();
  kisi.adapter[method].mockImplementation(async (p, k, arg, ...rest) => {
    const uid = method === 'removeRole' ? (kisi.state.roles.get(String(arg)) || {}).userId : String(arg);
    if (uid === String(userId)) throw Object.assign(new Error(`Kisi ${method} 503`), { statusCode: 503 });
    return fake(p, k, arg, ...rest);
  });
  const restore = () => kisi.adapter[method].mockImplementation(fake);
  restores.push(restore);
  return restore;
}

/** Takes a member's role on one door away in Kisi, the way staff would in the Kisi dashboard. */
function dropRoleInKisi(m, groupId) {
  for (const [id, r] of kisi.state.roles) if (r.userId === String(m.userId) && r.groupId === groupId) kisi.state.roles.delete(id);
}

// ── A door added to a plan ──────────────────────────────────────────────────

describe('[P1] real DB sweep — a door added to a plan reaches everyone on it', () => {
  test('Kisi failed for one member when the door was added: the next sync gives it to them and closes the save\'s alert', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    const eli  = await buy('Eli');
    const restore = failFor('assignRole', eli.userId);
    await patch(plan, { addGroupId: POOL });
    await waitFor(hasOpenAlert('door_grant_failed'), 'the save\'s door_grant_failed alert');
    restore();
    expect(kisi.canOpen(eli.userId, POOL)).toBe(false);

    const result = await sweep(paying([dana, eli]));

    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
    expect(kisi.canOpen(eli.userId, FRONT)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsAdded: 1, doorsRemoved: 0, doorRemovalsHeld: false }));
    expect((await rows(plan)).filter(r => r.hardware_group_id === POOL).map(r => r.access_id).sort())
      .toEqual([dana.accessId, eli.accessId].sort());
    expect(await openAlerts()).toEqual([]);                                   // fixed → nothing left for the gym
    const [done] = logged('reconciliation.door_check_complete');
    expect(done).toEqual(expect.objectContaining({ missing: 1, doorsAdded: 1, repairFailed: 0 }));
  });

  test('a door staff took away from a paying member in Kisi is put back — Plan Mapping decides their doors', async () => {
    await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana');
    dropRoleInKisi(dana, POOL);

    const result = await sweep(paying([dana]));

    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
    expect(result.doorsAdded).toBe(1);
  });

  test('Kisi still refuses: nothing given, and the gym gets one sweep_repair_pending alert for that member', async () => {
    await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana');
    dropRoleInKisi(dana, POOL);
    failFor('assignRole', dana.userId);

    const result = await sweep(paying([dana]));

    expect(kisi.canOpen(dana.userId, POOL)).toBe(false);
    expect(result.doorsAdded).toBe(0);
    expect(await openAlerts()).toEqual([{ alert_type: 'sweep_repair_pending', hardware_ref: `member:${dana.key}` }]);
  });

  test('never given: an owner / administrator (they open every door already), a member Wix no longer shows as paying, or with repair switched off', async () => {
    await addPlan(MONTHLY, [FRONT, POOL]);
    const owner  = await buy('Olive');
    const lapsed = await buy('Lars');
    const third  = await buy('Tia');
    for (const m of [owner, lapsed, third]) dropRoleInKisi(m, POOL);
    kisi.state.elevated.set(String(owner.userId), [{ id: 'ra-admin', role_id: 'administrator', scope: 'organization' }]);

    process.env.RECONCILE_DOOR_REPAIR = 'off';
    let result = await sweep([...paying([owner, third]), order(lapsed, MONTHLY, 'DECLINED')]);
    expect(result.doorsAdded).toBe(0);
    expect(kisi.canOpen(third.userId, POOL)).toBe(false);                     // switched off: nobody

    delete process.env.RECONCILE_DOOR_REPAIR;
    result = await sweep([...paying([owner, third]), order(lapsed, MONTHLY, 'DECLINED')]);
    expect(result.doorsAdded).toBe(1);                                         // only the paying member
    expect(kisi.canOpen(third.userId, POOL)).toBe(true);
    expect(kisi.canOpen(owner.userId, POOL)).toBe(false);                      // no group role for an administrator
    expect(kisi.canOpen(lapsed.userId, POOL)).toBe(false);                     // declined payment: left as it is
    expect(kisi.canOpen(lapsed.userId, FRONT)).toBe(true);                     // …and nothing taken either
  });
});

// ── A door taken off a plan ─────────────────────────────────────────────────

describe('[P1] real DB sweep — a door taken off a plan leaves everyone on it, and only that door goes', () => {
  async function threeOnTwoDoors() {
    const plan = await addPlan(MONTHLY, [FRONT, POOL]);
    const members = [await buy('Dana'), await buy('Eli'), await buy('Fay')];
    return { plan, members };
  }

  test('Kisi failed for one member when the door was taken off: the next sync takes it off; their other door and account stay', async () => {
    const { plan, members: [dana, eli, fay] } = await threeOnTwoDoors();
    const restore = failFor('removeRole', eli.userId);
    await patch(plan, { removeGroupId: POOL });
    await waitFor(hasOpenAlert('door_removal_failed'), 'the save\'s door_removal_failed alert');
    restore();
    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);

    const result = await sweep(paying([dana, eli, fay]));

    expect(kisi.canOpen(eli.userId, POOL)).toBe(false);
    expect(kisi.canOpen(eli.userId, FRONT)).toBe(true);
    expect(kisiUserExists(eli.userId)).toBe(true);                             // a door change never deletes the user
    expect((await accessOf(eli)).status).toBe('active');
    expect(result).toEqual(expect.objectContaining({ doorsRemoved: 1, doorsAdded: 0, doorRemovalsHeld: false }));
    expect((await rows(plan)).some(r => r.hardware_group_id === POOL)).toBe(false);
    expect(await openAlerts()).toEqual([]);                                    // the save's alert is answered
  });

  test('a plan switched off whose removal failed for one member: the next sync takes that plan\'s doors off, keeps the account', async () => {
    const { plan, members: [dana, eli, fay] } = await threeOnTwoDoors();
    const restore = failFor('removeRole', eli.userId);
    await patch(plan, { status: 'inactive' });
    await waitFor(hasOpenAlert('door_removal_failed'), 'the save\'s door_removal_failed alert');
    restore();

    const result = await sweep(paying([dana, eli, fay]));

    expect(kisi.canOpen(eli.userId, FRONT)).toBe(false);
    expect(kisi.canOpen(eli.userId, POOL)).toBe(false);
    expect(kisiUserExists(eli.userId)).toBe(true);
    expect(result.doorsRemoved).toBe(2);
  });

  test('another plan still gives the same door (C-4): only the old plan\'s record goes, the door stays open', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT, POOL]);
    await addPlan(YOGA, [POOL]);
    await addPlan('plan-basic', [FRONT]);
    const dana = await buy('Dana');
    await buy('Dana', YOGA);
    const eli = await buy('Eli', 'plan-basic');
    const fay = await buy('Fay', 'plan-basic');
    // Leave Dana's Monthly-Pool record behind as a failed save would (the door is shared with Yoga).
    await realDb.query(`DELETE FROM plan_mapping_groups WHERE mapping_id = $1 AND hardware_group_id = $2`, [monthly, POOL]);

    const result = await sweep([order(dana), order(dana, YOGA), ...paying([eli, fay], 'plan-basic')]);

    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);                        // Yoga still gives it
    expect((await rows(monthly)).some(r => r.hardware_group_id === POOL)).toBe(false);
    expect(result.doorsRemoved).toBe(0);
  });

  test("held when automatic removal is not 'on' — the door stays, the sweep says why", async () => {
    const { plan, members: [dana, eli, fay] } = await threeOnTwoDoors();
    await realDb.query(`UPDATE clients SET auto_revoke_mode = 'dry_run' WHERE id = $1`, [clientId]);
    failFor('removeRole', eli.userId);
    await patch(plan, { removeGroupId: POOL });
    await waitFor(hasOpenAlert('door_removal_failed'), 'door_removal_failed');
    restores.pop()();

    const result = await sweep(paying([dana, eli, fay]));

    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(result.doorsRemoved).toBe(0);
    expect(logged('reconciliation.door_check_complete')[0]).toEqual(expect.objectContaining({
      leftover: 1, doorsRemoved: 0, removalHoldReason: 'dry_run',
    }));
  });

  test('more than half the members at once: none removed, nobody locked out, the gym alerted once', async () => {
    const { plan, members: [dana, eli, fay] } = await threeOnTwoDoors();
    failFor('removeRole', eli.userId);
    failFor('removeRole', fay.userId);
    await patch(plan, { removeGroupId: POOL });
    await waitFor(async () => (await openAlerts()).filter(a => a.alert_type === 'door_removal_failed').length === 2, 'two failures');
    while (restores.length) restores.pop()();

    const result = await sweep(paying([dana, eli, fay]));

    expect(kisi.canOpen(eli.userId, POOL)).toBe(true);
    expect(kisi.canOpen(fay.userId, POOL)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsRemoved: 0, doorRemovalsHeld: true }));
    expect((await openAlerts()).filter(a => a.alert_type === 'sweep_door_removal_held'))
      .toEqual([{ alert_type: 'sweep_door_removal_held', hardware_ref: 'door_removal:mass' }]);
  });

  test('a door staff gave by hand in Kisi — no AccessSync record — is never touched', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await kisi.adapter.assignRole('kisi', 'test-kisi-key', dana.userId, STAFF);

    const result = await sweep(paying([dana]));

    expect(kisi.canOpen(dana.userId, STAFF)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsAdded: 0, doorsRemoved: 0 }));
  });

  test('a remap still in progress (the new door not on yet) never strips the old one', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await buy('Eli');
    await buy('Fay');
    // The save has written the new door but not yet given it: Dana holds only FRONT, the plan says POOL.
    await realDb.query(`DELETE FROM plan_mapping_groups WHERE mapping_id = $1`, [plan]);
    await realDb.query(`INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2)`, [plan, POOL]);
    failFor('assignRole', dana.userId);                                        // and her new door can't land yet

    await sweep(paying([dana]));

    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);                      // kept until she holds a current door
  });
});

// ── A removal that did not finish ───────────────────────────────────────────

describe('[P1] real DB sweep — a removal Wix ended, which never finished, is finished', () => {
  test('the Kisi account delete failed after the door came off: an hour later the sync re-runs it — account and details gone', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    for (let i = 0; i < 3; i++) kisi.failNext('deleteUser');
    expect(await cancel(dana)).toBe(false);                                    // every retry failed
    expect((await accessOf(dana)).status).toBe('removing');
    expect(kisiUserExists(dana.userId)).toBe(true);

    await sweep([order(dana, MONTHLY, 'ENDED')]);
    expect(queuedRevokes()).toHaveLength(0);                                   // too fresh: a retry may still be running

    await realDb.query(`UPDATE member_access SET updated_at = NOW() - interval '2 hours' WHERE id = $1`, [dana.accessId]);
    const result = await sweep([order(dana, MONTHLY, 'ENDED')]);

    expect(queuedRevokes()).toHaveLength(1);
    const [, data, opts] = queuedRevokes()[0];
    expect(data.standardEvent).toEqual(expect.objectContaining({
      eventType: 'plan.cancelled', platformMemberId: dana.key, planId: null,
      synthetic: true, syntheticSource: 'reconciliation.finish_removal',
    }));
    expect(result.revoked).toBe(1);

    expect(await runQueued({ id: opts.jobId, name: 'revoke', opts: { attempts: 3 }, data })).toBe(true);
    expect(kisiUserExists(dana.userId)).toBe(false);
    const now = await accessOf(dana);
    expect(now.status).toBe('deleted');
    expect(now.email).toBeNull();
  });

  test('the door removal itself failed: once Wix has shown the plan ended on 3 sweeps over 2 days, the sync removes them', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    const eli  = await buy('Eli');
    const fay  = await buy('Fay');
    failFor('removeRole', dana.userId);
    expect(await cancel(dana)).toBe(false);
    restores.pop()();
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);                      // the webhook could not finish
    const wixNow = [order(dana, MONTHLY, 'ENDED'), ...paying([eli, fay])];

    await sweep(wixNow);                                                       // first sighting: a clock starts
    expect(queuedRevokes()).toHaveLength(0);
    // Two more sweeps' worth of sightings, spread over two days.
    await realDb.query(
      `UPDATE member_access_sources SET not_paying_since = NOW() - interval '3 days', not_paying_observations = 3
        WHERE access_id = $1`, [dana.accessId]);
    const result = await sweep(wixNow);

    expect(queuedRevokes()).toHaveLength(1);
    const [, data, opts] = queuedRevokes()[0];
    expect(data.standardEvent).toEqual(expect.objectContaining({
      eventType: 'plan.cancelled', platformMemberId: dana.key, planId: MONTHLY, syntheticSource: 'reconciliation.wix_not_paying',
    }));
    expect(result.revoked).toBe(1);
    expect(await runQueued({ id: opts.jobId, name: 'revoke', opts: { attempts: 3 }, data })).toBe(true);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect(kisiUserExists(dana.userId)).toBe(false);
    expect((await accessOf(dana)).status).toBe('deleted');
    expect(kisi.canOpen(eli.userId, FRONT)).toBe(true);                       // nobody else touched
  });

  test('one plan of two ended and its removal failed: that plan\'s door goes, the other plan and the account stay', async () => {
    await addPlan(MONTHLY, [FRONT]);
    await addPlan(YOGA, [STUDIO]);
    const dana = await buy('Dana');
    await buy('Dana', YOGA);
    const eli = await buy('Eli');
    const fay = await buy('Fay');
    failFor('removeRole', dana.userId);
    expect(await cancel(dana, YOGA)).toBe(false);
    restores.pop()();
    await realDb.query(
      `UPDATE member_access_sources SET not_paying_since = NOW() - interval '3 days', not_paying_observations = 3
        WHERE access_id = $1 AND source_plan_id = $2`, [dana.accessId, YOGA]);

    await sweep([...paying([dana, eli, fay]), order(dana, YOGA, 'ENDED')]);

    expect(queuedRevokes()).toHaveLength(1);
    const [, data, opts] = queuedRevokes()[0];
    expect(data.standardEvent.planId).toBe(YOGA);
    expect(await runQueued({ id: opts.jobId, name: 'revoke', opts: { attempts: 3 }, data })).toBe(true);
    expect(kisi.canOpen(dana.userId, STUDIO)).toBe(false);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);
    expect(kisiUserExists(dana.userId)).toBe(true);
    expect((await accessOf(dana)).status).toBe('active');
  });

  test('a declined payment is never a removal, however long it lasts', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await realDb.query(
      `UPDATE member_access_sources SET not_paying_since = NOW() - interval '9 days', not_paying_observations = 30
        WHERE access_id = $1`, [dana.accessId]);

    await sweep([order(dana, MONTHLY, 'DECLINED')]);

    expect(queuedRevokes()).toHaveLength(0);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);
  });
});

// ── SAGE gate review (2026-11-05): each finding, as the situation that would have gone wrong ──

/** A family seat under `holder`, as the Member Hub leaves it: its own Kisi user, rows on the plan's doors. */
async function addSeat(holder, first, planId, mappingId, doors) {
  const holderMm = (await realDb.query(`SELECT member_master_id FROM member_access WHERE id = $1`, [holder.accessId])).rows[0].member_master_id;
  const key = `${holder.key}###as${first.toLowerCase()}`;
  const email = `${first.toLowerCase()}@example.com`;
  const mm = (await realDb.query(
    `INSERT INTO member_master (client_id, source_platform, platform_member_id, email, first_name, source_tag)
     VALUES ($1, 'wix', $2, $3, $4, 'accesssync') RETURNING id`, [clientId, key, email, first])).rows[0].id;
  const userId = await kisi.adapter.createUser('kisi', 'test-kisi-key', email, first);
  const accessId = (await realDb.query(
    `INSERT INTO member_access (member_master_id, client_id, hardware_platform, hardware_user_id, source_platform,
                                platform_member_id, status, sub_master_id)
     VALUES ($1, $2, 'kisi', $3, 'wix', $4, 'active', $5) RETURNING id`, [mm, clientId, userId, key, holderMm])).rows[0].id;
  for (const d of doors) {
    const ra = await kisi.adapter.assignRole('kisi', 'test-kisi-key', userId, d);
    await realDb.query(
      `INSERT INTO member_access_sources (client_id, access_id, source_type, source_plan_id, mapping_id, hardware_group_id,
                                          role_assignment_id, status)
       VALUES ($1, $2, 'plan', $3, $4, $5, $6, 'active')`, [clientId, accessId, planId, mappingId, d, String(ra)]);
  }
  return { accessId, userId, key, first };
}

async function parkRemoving(m) {
  for (let i = 0; i < 3; i++) kisi.failNext('deleteUser');
  expect(await cancel(m)).toBe(false);
  expect((await accessOf(m)).status).toBe('removing');
  await realDb.query(`UPDATE member_access SET updated_at = NOW() - interval '2 hours' WHERE id = $1`, [m.accessId]);
}

describe('[P1] real DB sweep — SAGE gate review findings', () => {
  test('1/3: a plan that is on but has no door rows (a legacy mapping, a save mid-rewrite) is left alone — no door taken, none given', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const members = [await buy('Dana'), await buy('Eli'), await buy('Fay')];
    await realDb.query(`DELETE FROM plan_mapping_groups WHERE mapping_id = $1`, [plan]);   // hardware_group_id still FRONT

    const result = await sweep(paying(members));

    for (const m of members) expect(kisi.canOpen(m.userId, FRONT)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsAdded: 0, doorsRemoved: 0, doorRemovalsHeld: false }));
    expect(logged('reconciliation.door_check_complete')[0]).toEqual(expect.objectContaining({ leftover: 0, plansWithoutDoors: 1 }));
  });

  test('2: two plans losing the same door are one door lost — removed, and counted once', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT]);
    const yoga    = await addPlan(YOGA, [FRONT]);
    await addPlan('plan-basic', [FRONT]);
    const dana = await buy('Dana');
    await buy('Dana', YOGA);
    const eli = await buy('Eli', 'plan-basic');
    const fay = await buy('Fay', 'plan-basic');
    await realDb.query(`UPDATE plan_mappings SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[monthly, yoga]]);

    const result = await sweep([order(dana), order(dana, YOGA), ...paying([eli, fay], 'plan-basic')]);

    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect(kisiUserExists(dana.userId)).toBe(true);
    expect(kisi.canOpen(eli.userId, FRONT)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsRemoved: 1, doorRemovalsHeld: false }));
    expect(logged('reconciliation.door_check_complete')[0]).toEqual(expect.objectContaining({ leftoverMembers: 1 }));
  });

  test('2: …and when that door is lost by more than half the members, every removal is held', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT]);
    const yoga    = await addPlan(YOGA, [FRONT]);
    const members = [];
    for (const first of ['Dana', 'Eli', 'Fay']) { members.push(await buy(first)); await buy(first, YOGA); }
    await realDb.query(`UPDATE plan_mappings SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[monthly, yoga]]);

    const result = await sweep([...paying(members), ...paying(members, YOGA)]);

    for (const m of members) expect(kisi.canOpen(m.userId, FRONT)).toBe(true);
    expect(result).toEqual(expect.objectContaining({ doorsRemoved: 0, doorRemovalsHeld: true }));
  });

  test('4: a family seat whose remap the save held back (door_swap_held) is finished in one sync — new door on, then old door off', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const hana = await buy('Hana');
    const seat = await addSeat(hana, 'Sid', MONTHLY, plan, [FRONT]);
    const eli  = await buy('Eli');
    const restore = failFor('assignRole', seat.userId);
    await patch(plan, { groups: [{ hardware_group_id: POOL }] });             // remap FRONT → POOL
    await waitFor(hasOpenAlert('door_swap_held'), 'the save holding the seat on its old door');
    restore();
    expect(kisi.canOpen(seat.userId, FRONT)).toBe(true);
    expect(kisi.canOpen(seat.userId, POOL)).toBe(false);

    const result = await sweep(paying([hana, eli]));                         // the seat pays through Hana

    expect(kisi.canOpen(seat.userId, POOL)).toBe(true);
    expect(kisi.canOpen(seat.userId, FRONT)).toBe(false);
    expect(result).toEqual(expect.objectContaining({ doorsAdded: 1, doorsRemoved: 1 }));
    expect(await openAlerts()).toEqual([]);
  });

  test('5: an owner / administrator check Kisi cannot answer means no door this sync (fail closed)', async () => {
    await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana');
    dropRoleInKisi(dana, POOL);
    kisi.failNext('findElevatedAssignmentsForUser');

    const result = await sweep(paying([dana]));

    expect(kisi.canOpen(dana.userId, POOL)).toBe(false);
    expect(result.doorsAdded).toBe(0);
  });

  test('6: never given — a door the health check marked gone from Kisi, or a plan whose location\'s AccessSync billing lapsed (DR-027)', async () => {
    const plan = await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana');
    dropRoleInKisi(dana, POOL);
    await realDb.query(`UPDATE plan_mapping_groups SET health_status = 'not_found' WHERE mapping_id = $1 AND hardware_group_id = $2`, [plan, POOL]);
    kisi.adapter.assignRole.mockClear();                                       // the purchase's own grant
    expect((await sweep(paying([dana]))).doorsAdded).toBe(0);
    expect(kisi.adapter.assignRole).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), dana.userId, POOL);

    await realDb.query(`UPDATE plan_mapping_groups SET health_status = 'ok' WHERE mapping_id = $1`, [plan]);
    await realDb.query(`DELETE FROM billing_subscriptions WHERE client_id = $1`, [clientId]);
    expect((await sweep(paying([dana]))).doorsAdded).toBe(0);
    expect(kisi.canOpen(dana.userId, POOL)).toBe(false);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);                       // and nothing taken either
  });

  test("7: a paying member's other plan that is declined has its removal clock cleared, so it can't fire the moment that plan reads ended", async () => {
    await addPlan(MONTHLY, [FRONT]);
    await addPlan(YOGA, [STUDIO]);
    const dana = await buy('Dana');
    await buy('Dana', YOGA);
    await realDb.query(
      `UPDATE member_access_sources SET not_paying_since = NOW() - interval '9 days', not_paying_observations = 30
        WHERE access_id = $1 AND source_plan_id = $2`, [dana.accessId, YOGA]);

    await sweep([order(dana), order(dana, YOGA, 'DECLINED')]);

    const clock = (await realDb.query(
      `SELECT not_paying_since, COALESCE(not_paying_observations, 0) AS n FROM member_access_sources
        WHERE access_id = $1 AND source_plan_id = $2`, [dana.accessId, YOGA])).rows[0];
    expect(clock.not_paying_since).toBeNull();
    expect(Number(clock.n)).toBe(0);
    expect(queuedRevokes()).toHaveLength(0);
  });

  test('8: a stuck Kisi account delete is restarted at most 3 times, then left on the Errors page for a person', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await parkRemoving(dana);
    for (let i = 0; i < 3; i++) {
      await realDb.query(
        `INSERT INTO diagnostic_log (client_id, service, level, error_code, message, context)
         VALUES ($1, 'core', 'info', 'none', 'reconciliation.removal_restarted', jsonb_build_object('accessId', $2::text))`,
        [clientId, dana.accessId]);
    }

    await sweep([order(dana, MONTHLY, 'ENDED')]);

    expect(queuedRevokes()).toHaveLength(0);
    expect((await accessOf(dana)).status).toBe('removing');
  });

  test('8: the restart writes no second "cancelled" row into the member\'s history', async () => {
    await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await parkRemoving(dana);
    const before = (await realDb.query(`SELECT event_type FROM member_access_log WHERE member_id = $1`, [dana.accessId])).rows;

    await sweep([order(dana, MONTHLY, 'ENDED')]);
    const [, data, opts] = queuedRevokes()[0];
    expect(await runQueued({ id: opts.jobId, name: 'revoke', opts: { attempts: 3 }, data })).toBe(true);

    const after = (await realDb.query(`SELECT event_type FROM member_access_log WHERE member_id = $1`, [dana.accessId])).rows;
    expect(after.filter(r => /^cancelled/.test(r.event_type))).toEqual(before.filter(r => /^cancelled/.test(r.event_type)));
    expect((await accessOf(dana)).status).toBe('deleted');
  });

  test('9: a door given back closes its alert; a queued removal leaves the gym\'s "still has access" alert open (a resolved one would stay quiet for 30 days)', async () => {
    await addPlan(MONTHLY, [FRONT, POOL]);
    const dana = await buy('Dana');
    const eli  = await buy('Eli');
    const fay  = await buy('Fay');
    dropRoleInKisi(dana, POOL);
    const restore = failFor('assignRole', dana.userId);
    await sweep(paying([dana, eli, fay]));
    expect((await openAlerts()).map(a => a.alert_type)).toEqual(['sweep_repair_pending']);
    restore();
    await sweep(paying([dana, eli, fay]));
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);
    expect(await openAlerts()).toEqual([]);

    // Eli's plan ended and the webhook could not take the door: first held (gym alerted), then queued.
    failFor('removeRole', eli.userId);
    expect(await cancel(eli)).toBe(false);
    restores.pop()();
    const wixNow = [...paying([dana, fay]), order(eli, MONTHLY, 'ENDED')];
    await sweep(wixNow);
    expect((await openAlerts()).map(a => a.alert_type)).toEqual(['sweep_removal_pending']);
    await realDb.query(
      `UPDATE member_access_sources SET not_paying_since = NOW() - interval '3 days', not_paying_observations = 3
        WHERE access_id = $1`, [eli.accessId]);
    await sweep(wixNow);
    expect(queuedRevokes()).toHaveLength(1);
    expect((await openAlerts()).map(a => a.alert_type)).toEqual(['sweep_removal_pending']);
  });

  test('2: a mass hold is answered by the next sync that is under the cap', async () => {
    const monthly = await addPlan(MONTHLY, [FRONT]);
    const yoga    = await addPlan(YOGA, [FRONT]);
    const members = [];
    for (const first of ['Dana', 'Eli', 'Fay']) { members.push(await buy(first)); await buy(first, YOGA); }
    await realDb.query(`UPDATE plan_mappings SET status = 'inactive' WHERE id = ANY($1::uuid[])`, [[monthly, yoga]]);
    const wixNow = [...paying(members), ...paying(members, YOGA)];
    await sweep(wixNow);
    expect((await openAlerts()).map(a => a.alert_type)).toEqual(['sweep_door_removal_held']);

    await realDb.query(`UPDATE plan_mappings SET status = 'active' WHERE id = ANY($1::uuid[])`, [[monthly, yoga]]);   // the gym undid it
    const result = await sweep(wixNow);

    expect(result.doorRemovalsHeld).toBe(false);
    expect(await openAlerts()).toEqual([]);
    for (const m of members) expect(kisi.canOpen(m.userId, FRONT)).toBe(true);
  });
});
