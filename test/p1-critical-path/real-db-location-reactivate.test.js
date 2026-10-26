/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: a gym's location subscription lapses, then is turned back    │
 * │  on. Every member the lapse locked out must be able to open the door    │
 * │  again — and nobody else.                                               │
 * │                                                                         │
 * │  Bug (audit 2026-10-26): the lapse suspends each member's Kisi user     │
 * │  and moves their rows to 'failed'/'inactive'. Reactivation only re-     │
 * │  granted members still 'active', so the suspended ones were never       │
 * │  turned back on — locked out, no alert.                                 │
 * │                                                                         │
 * │  These drive the real activate/suspend routes (operator portal and      │
 * │  owner hub) and the queue worker against a real Postgres engine         │
 * │  (PGlite, production schema snapshot). Only Kisi, Redis, email and      │
 * │  auth are faked.                                                        │
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
  Worker: jest.fn().mockImplementation(() => ({ on: () => {} })),
  UnrecoverableError: class UnrecoverableError extends Error {},
  DelayedError: class DelayedError extends Error {},
  Queue: jest.fn(),
}));
// auth.js throws at require-time without ADMIN_JWT_SECRET; the routes are what's under test.
jest.mock('../../admin/middleware/auth', () => ({
  requireAuth:               (_req, _res, next) => next(),
  requireAuthPage:           (_req, _res, next) => next(),
  requireAuthPageOrOperator: (_req, _res, next) => next(),
  requireAuthOrOperator:     (_req, _res, next) => next(),
  requireInviteToken:        (_req, _res, next) => next(),
  signToken:                 jest.fn(() => 'mock-token'),
  signOperatorToken:         jest.fn(() => 'mock-op-token'),
}));
jest.mock('../../admin/middleware/activity', () => ({ recordActivity: jest.fn() }));
jest.mock('../../admin/middleware/audit',    () => ({ logAdminAction: jest.fn() }));

const express          = require('express');
const request          = require('supertest');
const realDb           = require('../helpers/real-db/pglite-db');
const kisi             = require('../helpers/real-db/fake-kisi');
const { processJob }   = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const { reactivateLocationMembers } = require('../../core/location-lapse');
const { describeConfigAlert } = require('../../core/operator-email-templates');

const MONTHLY = 'plan-monthly';
const UPTOWN  = 'plan-uptown';
const FRONT   = 'grp-front-door';
const UPTOWN_DOOR = 'grp-uptown-door';

let tenantId;
let locationId;
let logLines = [];
let originalWrite;
let app;

beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      try { logLines.push(JSON.parse(chunk.trim())); } catch (_) { /* not a log line */ }
    }
    return true;
  };

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.admin = { role: 'admin', userId: 'test-owner' }; next(); });
  app.use('/operator', require('../../admin/routes/operator'));
  app.use('/admin/clients', require('../../admin/routes/clients'));
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
  await realDb.reset();
  const c = await realDb.query(`INSERT INTO clients (name) VALUES ('Test Gym') RETURNING id`);
  tenantId = c.rows[0].id;
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [tenantId]);
  locationId = await addLocation('Main St');
  await addPlan(MONTHLY, FRONT, 'Monthly', locationId);
});

async function addLocation(name) {
  const l = await realDb.query(
    `INSERT INTO locations (client_id, name) VALUES ($1, $2) RETURNING id`, [tenantId, name]);
  await realDb.query(
    `INSERT INTO billing_subscriptions (client_id, location_id, status, subscribed_at)
     VALUES ($1, $2, 'active', NOW())`, [tenantId, l.rows[0].id]);
  return l.rows[0].id;
}

async function addPlan(planId, groupId, name, locId) {
  const pm = await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, door_name, status, access_type, location_id)
     VALUES ($1, $2, $3, $4, 'Front door', 'active', 'group', $5) RETURNING id`,
    [tenantId, planId, groupId, name, locId]);
  await realDb.query(
    `INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id, door_name) VALUES ($1, $2, 'Front door')`,
    [pm.rows[0].id, groupId]);
}

let jobSeq = 0;
function job(member, name, event) {
  jobSeq += 1;
  return {
    id: `job-${jobSeq}`, name, attemptsMade: 0, opts: { attempts: 5 },
    data: {
      tenantId,
      standardEvent: {
        traceId: mintTraceId(), eventId: `evt-${jobSeq}`,
        platformMemberId: member, sourcePlatform: 'wix',
        email: `${member}@example.com`, name: `${member} Example`,
        ...event,
      },
    },
  };
}
const purchase = (member, planId = MONTHLY) =>
  job(member, 'grant',  { eventType: 'plan.purchased', planId, wixOrderId: `order-${member}-${planId}` });
const pause   = (member) =>
  job(member, 'revoke', { eventType: 'payment.failed', planId: MONTHLY, rawEventType: 'wixPricingPlans.orderPaused' });
const resume  = (member) =>
  job(member, 'grant',  { eventType: 'payment.recovered', planId: MONTHLY, rawEventType: 'wixPricingPlans.orderResumed' });

async function access(member) {
  const r = await realDb.query(
    `SELECT ma.id, ma.status, ma.hardware_user_id
       FROM member_access ma JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [tenantId, member]);
  return r.rows[0];
}

async function sources(member) {
  const a = await access(member);
  const r = await realDb.query(
    `SELECT source_plan_id, status, failure_reason FROM member_access_sources
      WHERE access_id = $1 ORDER BY source_plan_id`, [a.id]);
  return r.rows;
}

async function join(member, planId = MONTHLY) {
  await processJob(purchase(member, planId));
  const a = await access(member);
  expect(a.status).toBe('active');
  return a;
}

async function alerts() {
  const r = await realDb.query(
    `SELECT alert_type, hardware_ref FROM config_alert_log WHERE client_id = $1 ORDER BY created_at`, [tenantId]);
  return r.rows;
}

const logged = (event) => logLines.find(l => l.event === event || l.message === event);

/** The activate routes answer first and re-enable members after (fire-and-forget). */
async function settled() {
  for (let i = 0; i < 200; i++) {
    if (logged('location.reactivate_complete') || logged('location.reactivate_failed')) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('reactivation never finished');
}

// ── The bug, end to end through the operator portal ─────────────────────────

describe('[P1] real DB — lapse then reactivate (operator portal)', () => {
  test('a member locked out by the lapse can open the door again after reactivation', async () => {
    const a = await join('dana');
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);

    const lapse = await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    expect(lapse.body.suspended).toBe(1);
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect((await access('dana')).status).toBe('inactive');
    expect(await sources('dana')).toEqual([{ source_plan_id: MONTHLY, status: 'failed', failure_reason: 'location_lapse' }]);

    const res = await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    expect(res.status).toBe(200);
    await settled();

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect(kisi.adapter.enableAccess).toHaveBeenCalledWith('kisi', 'test-kisi-key', a.hardware_user_id, { clientId: tenantId });
    expect((await access('dana')).status).toBe('active');
    expect(await sources('dana')).toEqual([{ source_plan_id: MONTHLY, status: 'active', failure_reason: null }]);
    expect(logged('location.reactivate_complete')).toMatchObject({ restored: 1, held: 0, errors: 0 });
    const hist = await realDb.query(
      `SELECT event_type FROM member_access_log WHERE member_id = $1 ORDER BY created_at`, [a.id]);
    expect(hist.rows.map(r => r.event_type)).toEqual(expect.arrayContaining(['location_suspended', 'location_reactivated']));
    expect(await alerts()).toEqual([]);
  });

  test('everyone the lapse suspended comes back, not just one', async () => {
    const people = ['ana', 'ben', 'cy'];
    const users = [];
    for (const p of people) users.push((await join(p)).hardware_user_id);

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    expect(users.some(u => kisi.canOpen(u, FRONT))).toBe(false);

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect(users.every(u => kisi.canOpen(u, FRONT))).toBe(true);
    for (const p of people) expect((await access(p)).status).toBe('active');
  });

  test('no role is re-created: the lapse kept the door roles, reactivation only re-enables the user', async () => {
    const a = await join('dana');
    const rolesBefore = [...kisi.state.roles.keys()];

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect([...kisi.state.roles.keys()]).toEqual(rolesBefore);
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
  });
});

// ── Same through the owner hub (one shared function) ────────────────────────

describe('[P1] real DB — lapse then reactivate (owner hub)', () => {
  test('the owner hub activate turns the member back on too', async () => {
    const a = await join('dana');

    await request(app).post(`/admin/clients/${tenantId}/locations/${locationId}/suspend`).send({ status: 'suspended' });
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);

    const res = await request(app).post(`/admin/clients/${tenantId}/locations/${locationId}/activate`);
    expect(res.status).toBe(200);
    await settled();

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect((await access('dana')).status).toBe('active');
  });
});

// ── Exactly the lapse's members — nobody else ───────────────────────────────

describe('[P1] real DB — reactivation restores only what the lapse turned off', () => {
  test('a member already paused for non-payment before the lapse stays locked out', async () => {
    const paying = await join('dana');
    const paused = await join('eli');
    await processJob(pause('eli'));
    expect(kisi.canOpen(paused.hardware_user_id, FRONT)).toBe(false);

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect(kisi.canOpen(paying.hardware_user_id, FRONT)).toBe(true);
    expect(kisi.canOpen(paused.hardware_user_id, FRONT)).toBe(false);
    expect(kisi.adapter.enableAccess).not.toHaveBeenCalledWith('kisi', 'test-kisi-key', paused.hardware_user_id, expect.anything());
    expect(await sources('eli')).toEqual([{ source_plan_id: MONTHLY, status: 'failed', failure_reason: null }]);
    expect((await access('eli')).status).toBe('inactive');
  });

  test('a member whose Wix payment failed while the location was off stays off; their recovery lets them in', async () => {
    const a = await join('dana');
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await new Promise(r => setTimeout(r, 5)); // the payment failure is logged after the lapse
    await processJob(pause('dana'));

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(logged('location.reactivate_complete')).toMatchObject({ restored: 0, held: 1 });
    expect(logged('location.reactivate_member_held')).toMatchObject({ memberId: a.id });

    await processJob(resume('dana'));
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect((await access('dana')).status).toBe('active');
    expect(await sources('dana')).toEqual([{ source_plan_id: MONTHLY, status: 'active', failure_reason: null }]);
  });

  test('reactivating a different location does not turn on members of the lapsed one', async () => {
    const uptown = await addLocation('Uptown');
    await addPlan(UPTOWN, UPTOWN_DOOR, 'Uptown', uptown);
    const a = await join('dana'); // Main St member
    await join('uma', UPTOWN);    // Uptown member

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await request(app).post(`/operator/${tenantId}/locations/${uptown}/activate`);
    await settled();
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(await sources('dana')).toEqual([{ source_plan_id: MONTHLY, status: 'failed', failure_reason: 'location_lapse' }]);

    logLines = [];
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
  });

  test('a member on plans at two locations keeps the other location\'s rows untouched', async () => {
    const uptown = await addLocation('Uptown');
    await addPlan(UPTOWN, UPTOWN_DOOR, 'Uptown', uptown);
    const a = await join('dana');
    await processJob(purchase('dana', UPTOWN));

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    expect(await sources('dana')).toEqual([
      { source_plan_id: MONTHLY, status: 'failed', failure_reason: 'location_lapse' },
      { source_plan_id: UPTOWN,  status: 'active', failure_reason: null },
    ]);
    expect((await access('dana')).status).toBe('active'); // still paying at Uptown

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect(kisi.canOpen(a.hardware_user_id, UPTOWN_DOOR)).toBe(true);
    expect(await sources('dana')).toEqual([
      { source_plan_id: MONTHLY, status: 'active', failure_reason: null },
      { source_plan_id: UPTOWN,  status: 'active', failure_reason: null },
    ]);
  });
});

// ── Failures alert ──────────────────────────────────────────────────────────

describe('[P1] real DB — a failed re-enable is never silent', () => {
  test('Kisi fails: the member is alerted as still locked out, and a retry turns them back on', async () => {
    const a = await join('dana');
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    kisi.failNext('enableAccess');

    await request(app).post(`/operator/${tenantId}/locations/${locationId}/activate`);
    await settled();

    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(false);
    expect(logged('location.reactivate_complete')).toMatchObject({ restored: 0, errors: 1 });
    // Rows stay marked, so the retry below can find the member again.
    expect(await sources('dana')).toEqual([{ source_plan_id: MONTHLY, status: 'failed', failure_reason: 'location_lapse' }]);
    const [alert] = await alerts();
    expect(alert.alert_type).toBe('location_reactivate_failed');
    expect(alert.hardware_ref).toBe(`member_id=${a.id} kisi_user_id=${a.hardware_user_id} location_id=${locationId}`);

    // The same failure again does not stack a second unresolved alert.
    kisi.failNext('enableAccess');
    await reactivateLocationMembers(locationId, tenantId);
    expect(await alerts()).toHaveLength(1);

    const retry = await reactivateLocationMembers(locationId, tenantId);
    expect(retry).toMatchObject({ restored: 1, errors: [] });
    expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
    expect((await access('dana')).status).toBe('active');
  });

  test('no API key: the whole run alerts instead of failing quietly', async () => {
    await join('dana');
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await realDb.query(`UPDATE connector_subscriptions SET hardware_api_key = NULL WHERE client_id = $1`, [tenantId]);

    await expect(reactivateLocationMembers(locationId, tenantId)).rejects.toThrow(/No API key/);

    expect(await alerts()).toEqual([
      { alert_type: 'location_reactivate_failed', hardware_ref: `location_id=${locationId} reason=no_hardware_context` },
    ]);
  });

  test('a member mid-job (in_flight) is left alone and alerted, not overwritten', async () => {
    const a = await join('dana');
    await request(app).post(`/operator/${tenantId}/locations/${locationId}/suspend`);
    await realDb.query(`UPDATE member_access SET status = 'in_flight' WHERE id = $1`, [a.id]);

    const result = await reactivateLocationMembers(locationId, tenantId);

    expect(result.errors).toHaveLength(1);
    expect((await access('dana')).status).toBe('in_flight');
    expect(kisi.adapter.enableAccess).not.toHaveBeenCalled();
    expect((await alerts()).map(r => r.alert_type)).toEqual(['location_reactivate_failed']);
  });

  test('the alert reads as a plain sentence naming the member and the place', () => {
    const s = describeConfigAlert({
      alert_type: 'location_reactivate_failed', memberName: 'Dana Example', locationName: 'Main St', platform: 'Kisi',
    });
    expect(s).toMatch(/^Dana Example is still locked out at Main St/);
    expect(s).toMatch(/turn their access back on in Kisi/);
    expect(s).not.toMatch(/location_reactivate_failed|member_id=/);
  });
});
