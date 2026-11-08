/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: a member's removal took the door off, but deleting their     │
 * │  Kisi account failed on every attempt. What does the gym see, and does  │
 * │  it go away once AccessSync finishes the job?                           │
 * │                                                                         │
 * │  Same harness as real-db-sweep-resync.test.js: the app's own SQL        │
 * │  against a real Postgres engine (PGlite, production schema snapshot),   │
 * │  with only Kisi, Wix, Redis and email faked. Unlike that file, the      │
 * │  retry-engine is REAL here, so the error_queue row is the one the       │
 * │  dead-letter path really writes.                                        │
 * │                                                                         │
 * │  Found 2026-11-08 (SAGE check of the DR-057 follow-up):                 │
 * │   1  the Errors page and email said "AccessSync tries again on the     │
 * │      next sync" — true only when the gym's automatic removals are on,   │
 * │      at most 3 times, and silent that the door was already off;         │
 * │   2  when the 6-hour sweep did finish it, nothing closed the row: a day │
 * │      later it read "expected to clear by itself" + a support line.      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                         () => require('../helpers/real-db/pglite-db'));
jest.mock('../../adapters/hardware-adapter',  () => require('../helpers/real-db/fake-kisi').adapter);
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/operator-mailer',       () => ({ sendOperatorEmail: jest.fn(async () => ({ sent: true })) }));
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
const bullmq           = require('bullmq');
const { eventQueue }   = require('../../core/webhook-processor');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const { processJob, startWorker } = require('../../core/queue-worker');
const { mintTraceId }  = require('../../core/trace-context');
const reconciliation   = require('../../core/reconciliation');
const retryEngine      = require('../../core/retry-engine');
const { FINALIZE_PENDING_MESSAGE } = require('../../core/error-guidance');

const MONTHLY = 'plan-monthly';
const FRONT   = 'grp-front-door';

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
  startWorker();                          // registers the 'failed' (dead-letter) handler on the mocked Worker
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
  sendOperatorEmail.mockClear();
  reconciliation._doubleReadDelayMs = 0;
  reconciliation._sweepTraceId = 'finish-removal-errors-test';
  await realDb.reset();
  clientId = (await realDb.query(
    `INSERT INTO clients (name, source_site_id, source_api_key, auto_revoke_mode, notification_email)
     VALUES ('Test Gym', 'wix-site', 'wix-key', 'on', 'gym@example.com') RETURNING id`)).rows[0].id;
  locationId = (await realDb.query(
    `INSERT INTO locations (client_id, name) VALUES ($1, 'House of Gains - Roland') RETURNING id`, [clientId])).rows[0].id;
  await realDb.query(`INSERT INTO billing_subscriptions (client_id, location_id, status) VALUES ($1, $2, 'active')`, [clientId, locationId]);
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [clientId]);
  const plan = (await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, location_id, status, access_type)
     VALUES ($1, $2, $3, 'Monthly', $4, 'active', 'group') RETURNING id`,
    [clientId, MONTHLY, FRONT, locationId])).rows[0].id;
  await realDb.query(`INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2)`, [plan, FRONT]);
});

// ── fixtures ────────────────────────────────────────────────────────────────

let seq = 0;
const wixId = (first) => `wix-${first.toLowerCase()}`;

async function buy(first) {
  await processJob({
    id: `job-${++seq}`, name: 'grant', attemptsMade: 0, opts: { attempts: 5 },
    data: { tenantId: clientId, standardEvent: {
      traceId: mintTraceId(), eventId: `evt-${seq}`, sourcePlatform: 'wix',
      platformMemberId: wixId(first), email: `${first.toLowerCase()}@example.com`, name: `${first} Example`,
      eventType: 'plan.purchased', planId: MONTHLY, wixOrderId: `order-${first.toLowerCase()}`,
    } },
  });
  const a = (await realDb.query(
    `SELECT ma.id, ma.hardware_user_id, ma.member_master_id FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE mm.client_id = $1 AND mm.platform_member_id = $2`, [clientId, wixId(first)])).rows[0];
  expect(kisi.canOpen(a.hardware_user_id, FRONT)).toBe(true);
  return { accessId: a.id, masterId: a.member_master_id, userId: a.hardware_user_id, first, key: wixId(first) };
}

/** Kisi answers the account delete with a 503 `times` times in a row, the way the Kisi connector reports one. */
function kisiDeleteDown(times) {
  for (let i = 0; i < times; i++) {
    kisi.failNext('deleteUser', Object.assign(new Error('Kisi deleteUser 503'), {
      statusCode: 503, code: 'HARDWARE_API_ERROR', userMessage: 'Kisi is temporarily unavailable.',
    }));
  }
}

/**
 * Runs a job the way BullMQ does — up to 3 attempts — and, when every attempt fails, hands it to the worker's own
 * 'failed' handler, which dead-letters it through the real retry-engine (error_queue + operator email).
 */
async function runLikeBullmq(j) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await processJob({ ...j, attemptsMade: attempt }); return true; } catch (err) { lastErr = err; }
  }
  await bullmq.__handlers.failed({ ...j, attemptsMade: 3 }, lastErr);
  return false;
}

/** The member's own Wix cancellation, through the real revoke path. */
function cancelJob(m) {
  return {
    id: `job-${++seq}`, name: 'revoke', opts: { attempts: 3 },
    data: { tenantId: clientId, standardEvent: {
      traceId: mintTraceId(), eventId: `evt-${seq}`, sourcePlatform: 'wix', platformMemberId: m.key,
      eventType: 'plan.cancelled', planId: MONTHLY, wixOrderId: `order-${m.first.toLowerCase()}`,
      rawEventType: 'wixPricingPlans.orderCanceled',
    } },
  };
}

/** One sync, exactly as the dashboard's Sync now runs it; Wix says the member's plan ENDED. */
async function sweep(members) {
  wix.listOrdersClassified.mockResolvedValue(members.map(m => ({
    orderId: `order-${m.first.toLowerCase()}`, memberId: m.key, planId: MONTHLY, classification: 'ENDED',
    status: 'ENDED', lastPaymentStatus: 'PAID', autoRenewCanceled: false, endDate: null, rawOrder: null,
  })));
  wix.listConfirmedBookings.mockResolvedValue([]);
  const res = await request(app).post('/operator/sync/run').send({ clientId });
  expect(res.status).toBe(200);
  return res.body;
}

/** The parked member is past the sweep's one-hour wait (FINISH_REMOVAL_AFTER_MINUTES). */
const ageParked = (m) =>
  realDb.query(`UPDATE member_access SET updated_at = NOW() - interval '2 hours' WHERE id = $1`, [m.accessId]);

const queuedRevokes = () => eventQueue.add.mock.calls.filter(([name]) => name === 'revoke');

/** Runs the revoke the sweep queued, as the worker would. */
async function runQueuedRestart() {
  const restarts = queuedRevokes();
  expect(restarts).toHaveLength(1);
  const [, data, opts] = restarts[0];
  expect(data.standardEvent.syntheticSource).toBe('reconciliation.finish_removal');
  eventQueue.add.mockClear();
  return runLikeBullmq({ id: opts.jobId, name: 'revoke', opts: { attempts: 3 }, data });
}

async function errorRows() {
  return (await realDb.query(
    `SELECT id, status, event_type, user_message, dismissed_by, resolved_at, occurred_count
       FROM error_queue WHERE client_id = $1 ORDER BY created_at, id`, [clientId])).rows;
}

/** What the gym's Errors list shows (GET /operator/:clientId/errors — open rows, with their guidance). */
async function errorsPage() {
  const res = await request(app).get(`/operator/${clientId}/errors`);
  expect(res.status).toBe(200);
  return res.body.errors;
}

async function accessStatus(m) {
  return (await realDb.query(`SELECT status FROM member_access WHERE id = $1`, [m.accessId])).rows[0].status;
}

const logged = (event) => logLines.filter(l => (l.event || l.message) === event);

// ── 1 + 2: the words, then the row closes once the sweep finishes it ────────

describe('[P1] real DB — a removal whose Kisi account delete failed on every attempt', () => {
  test('the Errors page says the door is off and nothing is owed, not "tries again on the next sync"', async () => {
    const dana = await buy('Dana');
    kisiDeleteDown(3);

    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);

    expect(await accessStatus(dana)).toBe('removing');
    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);                 // the door is off
    const [row] = await errorRows();
    expect(row.status).toBe('failed');
    expect(row.user_message.startsWith(FINALIZE_PENDING_MESSAGE)).toBe(true);

    const [shown] = await errorsPage();
    expect(shown.guidance.headline).toMatch(/door access is off/);
    expect(shown.guidance.headline).not.toMatch(/next sync/i);
    expect(shown.guidance.steps.join(' ')).toMatch(/They can no longer get in/);
    expect(shown.guidance.steps.join(' ')).toMatch(/clears once it is done/);
    expect(shown.guidance.retry).toBe('none');
    expect(shown.guidance.cleanupPending).toBe(true);                   // the card title: "access was removed"

    // The gym's email carries the same words as the page (both come from core/error-guidance.js).
    const gymEmail = sendOperatorEmail.mock.calls.find(([a]) => a.toEmail === 'gym@example.com');
    expect(gymEmail).toBeDefined();
    expect(gymEmail[0].renderArgs.userMessage).toBe(shown.guidance.headline);
    expect(gymEmail[0].renderArgs.userMessage).not.toMatch(/next sync/i);
  });

  test('the 6-hour sweep finishes it, and the error closes by itself', async () => {
    const dana = await buy('Dana');
    kisiDeleteDown(3);
    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);
    expect(await errorsPage()).toHaveLength(1);
    await ageParked(dana);

    await sweep([dana]);
    expect(await runQueuedRestart()).toBe(true);                           // Kisi is back

    expect(await accessStatus(dana)).toBe('deleted');
    expect(kisi.state.users.has(String(dana.userId))).toBe(false);
    const [row] = await errorRows();
    expect(row.status).toBe('resolved');
    expect(row.dismissed_by).toBe('removal-finished');
    expect(row.resolved_at).not.toBeNull();
    expect(await errorsPage()).toEqual([]);                                // nothing left to age into "contact support"
    expect(logged('retry.removal_finished.errors_resolved')).toHaveLength(1);
  });

  test('a restart that fails too adds its own row; when a later one finishes, every row closes', async () => {
    const dana = await buy('Dana');
    kisiDeleteDown(3);
    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);
    await ageParked(dana);

    kisiDeleteDown(3);                                                     // still down at the first restart
    await sweep([dana]);
    expect(await runQueuedRestart()).toBe(false);
    expect(await accessStatus(dana)).toBe('removing');
    const open = await errorsPage();
    expect(open.length).toBeGreaterThanOrEqual(1);
    for (const e of open) expect(e.guidance.headline).toMatch(/door access is off/);

    await ageParked(dana);
    await sweep([dana]);
    expect(await runQueuedRestart()).toBe(true);

    expect(await accessStatus(dana)).toBe('deleted');
    expect((await errorRows()).every(r => r.status === 'resolved' && r.dismissed_by === 'removal-finished')).toBe(true);
    expect(await errorsPage()).toEqual([]);
  });
});

// ── what it must never close ────────────────────────────────────────────────

describe('[P1] real DB — closing a finished removal\'s errors touches nothing else', () => {
  async function insertError(m, eventType, status = 'failed') {
    return (await realDb.query(
      `INSERT INTO error_queue (client_id, member_id, event_type, payload, error_reason, error_code, status, occurred_count)
       VALUES ($1, $2, $3, $4, 'test', 'HARDWARE_API_ERROR', $5, 1) RETURNING id`,
      [clientId, m.masterId, eventType, JSON.stringify({ platformMemberId: m.key }), status])).rows[0].id;
  }

  test("another member's removal error and the same member's grant error stay open", async () => {
    const dana = await buy('Dana');
    const eli  = await buy('Eli');
    const elisRemoval = await insertError(eli, 'plan.cancelled');
    const danasGrant  = await insertError(dana, 'plan.purchased');
    kisiDeleteDown(3);
    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);
    await ageParked(dana);

    await sweep([dana]);
    expect(await runQueuedRestart()).toBe(true);

    const byId = new Map((await errorRows()).map(r => [r.id, r]));
    expect(byId.get(elisRemoval).status).toBe('failed');
    expect(byId.get(danasGrant).status).toBe('failed');
    const danasRemoval = [...byId.values()].find(r => r.id !== elisRemoval && r.id !== danasGrant);
    expect(danasRemoval.status).toBe('resolved');
  });

  test('a member whose removal has not finished keeps their open removal error', async () => {
    const dana = await buy('Dana');
    kisiDeleteDown(3);
    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);
    expect(await accessStatus(dana)).toBe('removing');

    expect(await retryEngine.resolveFinishedRemoval(clientId, dana.accessId)).toBe(0);
    expect((await errorRows())[0].status).toBe('failed');
  });

  test('a failure to close the rows never fails the removal (the job still completes)', async () => {
    const dana = await buy('Dana');
    kisiDeleteDown(3);
    expect(await runLikeBullmq(cancelJob(dana))).toBe(false);
    await ageParked(dana);
    await sweep([dana]);

    const realQuery = realDb.query;
    const spy = jest.spyOn(realDb, 'query').mockImplementation((sql, ...rest) =>
      (/UPDATE error_queue eq/.test(String(sql))
        ? Promise.reject(new Error('db hiccup'))
        : realQuery.call(realDb, sql, ...rest)));
    try {
      expect(await runQueuedRestart()).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(await accessStatus(dana)).toBe('deleted');
    expect(logged('retry.removal_finished.resolve_failed')).toHaveLength(1);
    expect((await errorRows())[0].status).toBe('failed');                 // left open; it ages to support as before
  });
});
