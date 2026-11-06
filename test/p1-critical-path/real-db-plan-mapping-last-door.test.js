/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: the LAST door is taken off a plan in Plan Mapping — nobody   │
 * │  is given that door any more, not new buyers, not the sweep.            │
 * │                                                                         │
 * │  Daxx, 2026-11-05: members stay in sync with their plan mappings — a    │
 * │  door taken off a plan leaves everyone on it. Found in the SAGE review  │
 * │  of the sweep resync: removing a plan's last door deleted its           │
 * │  plan_mapping_groups row but left plan_mappings.hardware_group_id on    │
 * │  the removed door. The grant resolver and the sweep's Pass 1(b) both    │
 * │  fall back to that column when a plan has no door rows (COALESCE), so   │
 * │  every new buyer got the removed door, and the sweep put a row for it   │
 * │  back. The same column was left behind by a classic-page save with no   │
 * │  doors, and a later switch-on brought the door back.                    │
 * │                                                                         │
 * │  Same harness as real-db-plan-mapping-kisi-sync.test.js: app SQL on     │
 * │  PGlite (production schema snapshot), members created through the real  │
 * │  purchase path, Kisi faked with real state, the save run through its    │
 * │  route, the sweep run as the dashboard's Sync now runs it.              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                         () => require('../helpers/real-db/pglite-db'));
jest.mock('../../adapters/hardware-adapter',  () => require('../helpers/real-db/fake-kisi').adapter);
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/retry-engine',          () => ({ handleFailure: jest.fn() }));
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
const FRONT   = 'grp-front-door';
const POOL    = 'grp-pool';

let app;
let clientId;
let locationId;
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
  reconciliation._doubleReadDelayMs = 0;
  reconciliation._sweepTraceId = 'last-door-test';
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

// ── fixtures ────────────────────────────────────────────────────────────────

/** A live plan mapping with its doors, as Plan Mapping leaves it (the one-door column = its first). */
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
/** A member who buys the plan through the real purchase path (Wix webhook → grant job). */
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

/** A classified Wix order, as wix-plans-api listOrdersClassified returns it. */
const paying = (members, planId = MONTHLY) => members.map(m => ({
  orderId: `order-${m.first.toLowerCase()}-${planId}`, memberId: m.key, planId, classification: 'PAYING',
  status: 'ACTIVE', lastPaymentStatus: 'PAID', autoRenewCanceled: false, endDate: null, rawOrder: null,
}));

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
async function legacyDoor(mappingId) {
  return (await realDb.query(`SELECT hardware_group_id, status FROM plan_mappings WHERE id = $1`, [mappingId])).rows[0];
}
async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 15));
  }
}
const noRowOn = (mappingId, groupId) => async () => !(await rows(mappingId)).some(r => r.hardware_group_id === groupId);
const logged = (event) => logLines.filter(l => (l.event || l.message) === event);
const assignedTo = (groupId) => kisi.adapter.assignRole.mock.calls.filter(([, , , gid]) => String(gid) === groupId);
/** Grants queued (eventQueue is mocked) by one path, e.g. the save's restore or the sweep's 3A. */
const queuedGrants = (syntheticSource) => eventQueue.add.mock.calls
  .filter(([name, data]) => name === 'grant' && data.standardEvent.syntheticSource === syntheticSource);
async function runAll(jobs) {
  for (const [name, data, opts] of jobs) await processJob({ id: opts.jobId, name, data, attemptsMade: 0, opts: { attempts: 5 } });
}
async function kisiUserOf(member) {
  return (await realDb.query(`SELECT hardware_user_id FROM member_access WHERE id = $1`, [member.accessId])).rows[0].hardware_user_id;
}

// ── The last door taken off ─────────────────────────────────────────────────

describe('[P1] real DB — a plan whose last door was taken off gives that door to nobody', () => {
  test('wire view: a new buyer gets no door, and the sweep puts no row back for anyone', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);

    await patch(plan, { removeGroupId: FRONT });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    // Still on, now with no doors (not live) — and the one-door column no longer names the removed door.
    expect(await legacyDoor(plan)).toEqual({ hardware_group_id: null, status: 'active' });

    // A new purchase: the plan is recognised but has no door — parked, no Kisi account, no door.
    kisi.adapter.assignRole.mockClear();
    const gus = await buy('Gus');
    expect(gus.userId).toBeNull();
    expect(assignedTo(FRONT)).toHaveLength(0);
    expect(await rows(plan)).toEqual([]);
    expect(logged('queue.grant.parked.no_mapping')).toHaveLength(1);

    // The sweep: Wix says both are paying for the plan; Pass 1(b) inserts nothing for the removed door.
    const result = await sweep(paying([dana, gus]));
    expect(await rows(plan)).toEqual([]);
    expect(logged('reconciliation.source_inserted_from_wix')).toHaveLength(0);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect(assignedTo(FRONT)).toHaveLength(0);
    expect(result).toEqual(expect.objectContaining({ doorsAdded: 0, doorsRemoved: 0 }));
  });

  test('classic page: a save with no doors, then the plan switched on — new buyers still get nothing', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');

    await patch(plan, { groups: [], status: 'active' });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');
    expect(await legacyDoor(plan)).toEqual({ hardware_group_id: null, status: 'inactive' });

    const on = await patch(plan, { status: 'active' });
    expect(on.status).toBe(200);
    expect(on.body.hardware_group_id).toBeNull();

    kisi.adapter.assignRole.mockClear();
    const gus = await buy('Gus');
    expect(gus.userId).toBeNull();
    expect(assignedTo(FRONT)).toHaveLength(0);
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect(await rows(plan)).toEqual([]);
  });
});

// ── A door added back ───────────────────────────────────────────────────────

describe('[P1] real DB — a door added back reaches everyone paying, including who bought while it had none', () => {
  test('the save restores members from billing; the next sync gives the door to the buyer who was parked', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    const dana = await buy('Dana');
    await patch(plan, { removeGroupId: FRONT });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');

    // Gus buys while the plan has no door: parked, no Kisi account. His billing row is written
    // only when a grant completes, so the save's restore (which reads billing) cannot see him.
    const gus = await buy('Gus');
    expect(gus.userId).toBeNull();

    await patch(plan, { addGroupId: POOL });
    await waitFor(() => queuedGrants('operator.plan_mapping.restore').length === 1, 'restore queued');
    expect(queuedGrants('operator.plan_mapping.restore').map(([, d]) => d.standardEvent.platformMemberId)).toEqual([dana.key]);
    await runAll(queuedGrants('operator.plan_mapping.restore'));
    expect(kisi.canOpen(dana.userId, POOL)).toBe(true);

    // Sync now: Wix says Gus is paying and he is not in Kisi, so the sweep (3A) queues his grant.
    eventQueue.add.mockClear();
    await sweep(paying([dana, gus]));
    expect(queuedGrants('reconciliation.true_source_sync').map(([, d]) => d.standardEvent.platformMemberId)).toEqual([gus.key]);
    await runAll(queuedGrants('reconciliation.true_source_sync'));

    const gusUser = await kisiUserOf(gus);
    expect(gusUser).toBeTruthy();
    expect(kisi.canOpen(gusUser, POOL)).toBe(true);
    expect(kisi.canOpen(gusUser, FRONT)).toBe(false);
    expect((await rows(plan)).map(r => r.hardware_group_id)).toEqual([POOL, POOL]);
  });
});

// ── The one-door column follows the plan's doors ────────────────────────────

describe('[P1] real DB — the one-door column always names one of the plan\'s doors', () => {
  test('the first of two doors taken off: the column moves to the door that is left, which buyers get', async () => {
    const plan = await addPlan(MONTHLY, [FRONT, POOL]);
    await buy('Dana');

    await patch(plan, { removeGroupId: FRONT });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');
    expect((await legacyDoor(plan)).hardware_group_id).toBe(POOL);

    const gus = await buy('Gus');
    expect(kisi.canOpen(gus.userId, POOL)).toBe(true);
    expect(kisi.canOpen(gus.userId, FRONT)).toBe(false);
  });

  test('a door added to a plan with none: the column names it, so the sweep\'s managed-door list (A12) sees it', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    await buy('Dana');
    await patch(plan, { removeGroupId: FRONT });
    await waitFor(noRowOn(plan, FRONT), 'front row removed');

    await patch(plan, { addGroupId: POOL });
    expect((await legacyDoor(plan)).hardware_group_id).toBe(POOL);

    const res = await patch(plan, { groups: [{ hardware_group_id: FRONT, door_name: 'Front Door' }] });
    expect(res.body).toEqual(expect.objectContaining({ hardware_group_id: FRONT, door_name: 'Front Door' }));
  });

  test('a true legacy mapping (the column, never any door rows) still grants through the column', async () => {
    const plan = await addPlan(MONTHLY, [FRONT]);
    await realDb.query(`DELETE FROM plan_mapping_groups WHERE mapping_id = $1`, [plan]);   // hardware_group_id still FRONT

    const dana = await buy('Dana');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(true);
  });
});
