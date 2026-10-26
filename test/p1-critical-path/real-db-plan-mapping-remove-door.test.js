/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH (real database)                             │
 * │  Scenario: the gym takes a door off a plan in Plan Mapping. Everyone    │
 * │  on that plan must lose that door in Kisi — or the gym is told.         │
 * │                                                                         │
 * │  Found by the 2026-10-26 DR-045 audit (origin/main 7782e81):            │
 * │   1. PATCH removeGroupId deleted the members' source rows BEFORE the    │
 * │      background sync ran, so the sync found nobody and never called     │
 * │      Kisi removeRole. Members kept the door; the DB said they didn't;   │
 * │      no alert.                                                          │
 * │   2. The sync itself deleted each row before calling Kisi and only      │
 * │      log.warn'ed a Kisi failure — the 2026-10-19 "H1" order bug that    │
 * │      core/grant-revoke.js already fixed for webhook cancels.            │
 * │   3. The sync had no source_type filter, so a day-pass row (its         │
 * │      role_assignment_id is a Kisi group-LINK id) could be sent to       │
 * │      DELETE /role_assignments/:id.                                      │
 * │                                                                         │
 * │  Runs the app's own SQL on PGlite (production schema snapshot); only    │
 * │  Kisi, Redis, auth and email are faked. The sync is fire-and-forget     │
 * │  after the response, so each test waits for its end state (row gone,   │
 * │  or alert written) before asserting.                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db',                         () => require('../helpers/real-db/pglite-db'));
jest.mock('../../adapters/hardware-adapter',  () => require('../helpers/real-db/fake-kisi').adapter);
jest.mock('../../core/redis-utils',           () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/webhook-processor',     () => ({ eventQueue: { add: jest.fn(), getJob: jest.fn() } }));
jest.mock('../../core/crypto-utils',          () => ({ decryptApiKey: jest.fn(k => k), encryptApiKey: jest.fn(k => k) }));
jest.mock('../../core/member-mailer',         () => ({}));
jest.mock('bullmq', () => ({ Queue: jest.fn(), Worker: jest.fn() }));
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

const express  = require('express');
const request  = require('supertest');
const realDb   = require('../helpers/real-db/pglite-db');
const kisi     = require('../helpers/real-db/fake-kisi');

const FRONT  = 'grp-front-door';
const STUDIO = 'grp-yoga-studio';

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

// First engine call boots PostgreSQL (WebAssembly) + the schema — give it room once.
beforeAll(() => realDb.reset(), 60000);

beforeEach(async () => {
  logLines = [];
  kisi.reset();
  await realDb.reset();
  clientId = (await realDb.query(`INSERT INTO clients (name) VALUES ('Test Gym') RETURNING id`)).rows[0].id;
  locationId = (await realDb.query(
    `INSERT INTO locations (client_id, name) VALUES ($1, 'House of Gains - Roland') RETURNING id`, [clientId])).rows[0].id;
  await realDb.query(
    `INSERT INTO connector_subscriptions (client_id, hardware_platform, hardware_api_key, status)
     VALUES ($1, 'kisi', 'test-kisi-key', 'active')`, [clientId]);
});

// ── fixtures ────────────────────────────────────────────────────────────────

/** A plan mapping with its doors (plan_mapping_groups), as Plan Mapping leaves it. */
async function addMapping(planId, groups, accessType = 'group') {
  const id = (await realDb.query(
    `INSERT INTO plan_mappings (client_id, source_plan_id, hardware_group_id, plan_name, location_id, status, access_type)
     VALUES ($1, $2, $3, $2, $4, 'active', $5) RETURNING id`,
    [clientId, planId, groups[0], locationId, accessType])).rows[0].id;
  for (const g of groups) {
    await realDb.query(`INSERT INTO plan_mapping_groups (mapping_id, hardware_group_id) VALUES ($1, $2)`, [id, g]);
  }
  return id;
}

/** A provisioned member: a Kisi user (in the fake door system) + their access row. */
async function addMember(first) {
  const userId = `kisi-user-${first.toLowerCase()}`;
  kisi.state.users.set(userId, { email: `${first.toLowerCase()}@example.com`, name: first, suspended: false });
  const mm = (await realDb.query(
    `INSERT INTO member_master (client_id, source_platform, platform_member_id, first_name, last_name)
     VALUES ($1, 'wix', $2, $3, 'Example') RETURNING id`, [clientId, `wix-${first.toLowerCase()}`, first])).rows[0].id;
  const accessId = (await realDb.query(
    `INSERT INTO member_access (member_master_id, client_id, status, hardware_user_id)
     VALUES ($1, $2, 'active', $3) RETURNING id`, [mm, clientId, userId])).rows[0].id;
  return { accessId, userId, first };
}

let raSeq = 0;
/** A live door for the member under a mapping: a Kisi role assignment + its source row. */
async function grant(member, mappingId, planId, groupId, { sourceType = 'plan', withRole = true, status = 'active' } = {}) {
  let raId = null;
  if (sourceType === 'day_pass') {
    raId = `group-link-${++raSeq}`; // a day pass holds a Kisi group-LINK id, never a role assignment
  } else if (withRole) {
    raId = `ra-${++raSeq}`;
    kisi.state.roles.set(raId, { userId: member.userId, groupId });
  }
  await realDb.query(
    `INSERT INTO member_access_sources
       (client_id, access_id, source_type, source_plan_id, mapping_id, hardware_group_id, role_assignment_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [clientId, member.accessId, sourceType, planId, mappingId, groupId, raId, status]);
  return raId;
}

async function sourceRows(mappingId) {
  return (await realDb.query(
    `SELECT access_id, source_type, hardware_group_id, role_assignment_id
       FROM member_access_sources WHERE mapping_id = $1 ORDER BY hardware_group_id, source_type`, [mappingId])).rows;
}

async function alerts() {
  return (await realDb.query(
    `SELECT alert_type, hardware_ref, plan_mapping_id FROM config_alert_log WHERE client_id = $1 ORDER BY created_at`,
    [clientId])).rows;
}

const removeDoor = (mappingId, groupId) =>
  request(app).patch(`/operator/${clientId}/plan-mappings/${mappingId}`).send({ removeGroupId: groupId });

/** The sync runs after the response — wait (bounded) for the state it ends in. */
async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 15));
  }
}

const noRowsOn = (mappingId, groupId) => async () =>
  !(await sourceRows(mappingId)).some(r => r.hardware_group_id === groupId && r.source_type !== 'day_pass');
const alertCount = (n) => async () => (await alerts()).length >= n;

// ── 1. The reported bug: removing a door from a plan ────────────────────────

describe('[P1] real DB — taking a door off a plan removes it from every member in Kisi', () => {
  test('every member on the plan loses that door in Kisi; their other door stays', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana = await addMember('Dana');
    const eli  = await addMember('Eli');
    for (const m of [dana, eli]) {
      await grant(m, mapping, 'plan-monthly', FRONT);
      await grant(m, mapping, 'plan-monthly', STUDIO);
    }

    const res = await removeDoor(mapping, STUDIO);
    expect(res.status).toBe(200);
    await waitFor(noRowsOn(mapping, STUDIO), 'studio rows to be removed');

    expect(kisi.adapter.removeRole).toHaveBeenCalledTimes(2);
    for (const m of [dana, eli]) {
      expect(kisi.canOpen(m.userId, STUDIO)).toBe(false);
      expect(kisi.canOpen(m.userId, FRONT)).toBe(true);
    }
    expect((await sourceRows(mapping)).map(r => r.hardware_group_id)).toEqual([FRONT, FRONT]);
    const groups = (await realDb.query(`SELECT hardware_group_id FROM plan_mapping_groups WHERE mapping_id = $1`, [mapping])).rows;
    expect(groups.map(g => g.hardware_group_id)).toEqual([FRONT]);
    expect(await alerts()).toEqual([]);
  });

  test('Kisi is called while the member\'s row still exists (Kisi first, then the database)', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana = await addMember('Dana');
    await grant(dana, mapping, 'plan-monthly', STUDIO);
    let rowsWhenKisiCalled = null;
    kisi.adapter.removeRole.mockImplementationOnce(async (_p, _k, raId) => {
      rowsWhenKisiCalled = (await sourceRows(mapping)).length;
      kisi.state.roles.delete(String(raId));
    });

    await removeDoor(mapping, STUDIO);
    await waitFor(noRowsOn(mapping, STUDIO), 'studio row to be removed');

    expect(rowsWhenKisiCalled).toBe(1);
    expect(kisi.canOpen(dana.userId, STUDIO)).toBe(false);
  });

  test('a member Kisi never saw (no role yet) just has their row dropped — no Kisi call, no alert', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const fay = await addMember('Fay');
    await grant(fay, mapping, 'plan-monthly', STUDIO, { withRole: false, status: 'pending_hardware' });

    await removeDoor(mapping, STUDIO);
    await waitFor(noRowsOn(mapping, STUDIO), 'pending row to be removed');

    expect(kisi.adapter.removeRole).not.toHaveBeenCalled();
    expect(await alerts()).toEqual([]);
  });

  test('C-4: a door another plan still grants stays open; only this plan\'s row goes', async () => {
    const monthly = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const yoga    = await addMapping('plan-yoga', [STUDIO]);
    const dana = await addMember('Dana');
    await grant(dana, monthly, 'plan-monthly', STUDIO);
    await grant(dana, yoga, 'plan-yoga', STUDIO);

    await removeDoor(monthly, STUDIO);
    await waitFor(noRowsOn(monthly, STUDIO), 'monthly studio row to be removed');

    expect(kisi.adapter.removeRole).not.toHaveBeenCalled();
    expect(kisi.canOpen(dana.userId, STUDIO)).toBe(true);
    expect(await sourceRows(yoga)).toHaveLength(1);
  });
});

// ── 2. Kisi fails: the row stays and the gym is told ───────────────────────

describe('[P1] real DB — Kisi fails while a door is being taken off a plan', () => {
  test('the row stays, a door_removal_failed alert names the member, and the next member is still done', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana = await addMember('Dana');
    const eli  = await addMember('Eli');
    const danaRa = await grant(dana, mapping, 'plan-monthly', STUDIO);
    await grant(eli, mapping, 'plan-monthly', STUDIO);
    // Fail whichever member Kisi is asked about first; remember who that was.
    let failedRa = null;
    kisi.adapter.removeRole.mockImplementationOnce(async (_p, _k, raId) => {
      failedRa = raId;
      throw Object.assign(new Error('Kisi removeRole timed out (503)'), { statusCode: 503 });
    });

    await removeDoor(mapping, STUDIO);
    await waitFor(alertCount(1), 'the alert');
    await waitFor(async () => (await sourceRows(mapping)).filter(r => r.hardware_group_id === STUDIO).length === 1,
      'the other member\'s row to be removed');

    const [failed, done] = failedRa === danaRa ? [dana, eli] : [eli, dana];
    // The member Kisi failed on: still has the door, and the database says so.
    expect(kisi.canOpen(failed.userId, STUDIO)).toBe(true);
    const left = (await sourceRows(mapping)).filter(r => r.hardware_group_id === STUDIO);
    expect(left).toEqual([{ access_id: failed.accessId, source_type: 'plan', hardware_group_id: STUDIO, role_assignment_id: failedRa }]);
    // The other member was still done.
    expect(kisi.canOpen(done.userId, STUDIO)).toBe(false);

    expect(await alerts()).toEqual([
      { alert_type: 'door_removal_failed', hardware_ref: `member_id=${failed.accessId}`, plan_mapping_id: mapping },
    ]);
    expect(logLines.some(l => (l.event || l.message) === 'operator.sync.revoke_failed' && l.level === 'error')).toBe(true);
  });

  test('the gym\'s alerts list says who still has the door, where, and what to do', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana = await addMember('Dana');
    await grant(dana, mapping, 'plan-monthly', STUDIO);
    kisi.failNext('removeRole');

    await removeDoor(mapping, STUDIO);
    await waitFor(alertCount(1), 'the alert');

    const res = await request(app).get(`/operator/${clientId}/alerts`);
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].message).toBe(
      'Dana Example at House of Gains - Roland can still open a door that was taken off their plan — '
      + 'Kisi didn’t respond when AccessSync tried to remove it. Remove that door from their account in Kisi.');
  });

  test('a second failure for the same member does not stack a second open alert', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana = await addMember('Dana');
    await grant(dana, mapping, 'plan-monthly', FRONT);
    await grant(dana, mapping, 'plan-monthly', STUDIO);
    kisi.failNext('removeRole');
    kisi.failNext('removeRole');

    await removeDoor(mapping, STUDIO);
    await waitFor(alertCount(1), 'the first alert');
    await removeDoor(mapping, FRONT);
    await waitFor(() => logLines.filter(l => (l.event || l.message) === 'operator.sync.revoke_failed').length >= 2,
      'the second failure');

    expect(await alerts()).toHaveLength(1);
    expect(await sourceRows(mapping)).toHaveLength(2); // both rows kept — both doors still open
  });
});

// ── 3. Day passes are not role assignments ──────────────────────────────────

describe('[P1] real DB — a day-pass row is never sent to Kisi removeRole', () => {
  test('taking the door off leaves the day pass to run out (day-pass sweep) and still removes plan members', async () => {
    const mapping = await addMapping('plan-day-pass', [FRONT, STUDIO], 'day_pass');
    const guest = await addMember('Gus');
    const dana  = await addMember('Dana');
    const linkId = await grant(guest, mapping, 'plan-day-pass#order-1#1', STUDIO, { sourceType: 'day_pass' });
    await grant(dana, mapping, 'plan-day-pass', STUDIO);

    await removeDoor(mapping, STUDIO);
    await waitFor(noRowsOn(mapping, STUDIO), 'the plan row to be removed');

    expect(kisi.adapter.removeRole).toHaveBeenCalledTimes(1);
    expect(kisi.adapter.removeRole).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), linkId);
    expect(kisi.adapter.deleteGroupLink).not.toHaveBeenCalled();
    expect(await sourceRows(mapping)).toEqual([
      { access_id: guest.accessId, source_type: 'day_pass', hardware_group_id: STUDIO, role_assignment_id: linkId },
    ]);
  });
});

// ── 4. Switching a whole plan off goes through the same path ────────────────

describe('[P1] real DB — switching a plan off (status inactive)', () => {
  test('removes every member\'s doors in Kisi; a Kisi failure keeps that row and alerts; day passes untouched', async () => {
    const mapping = await addMapping('plan-monthly', [FRONT, STUDIO]);
    const dana  = await addMember('Dana');
    const guest = await addMember('Gus');
    await grant(dana, mapping, 'plan-monthly', FRONT);
    const studioRa = await grant(dana, mapping, 'plan-monthly', STUDIO);
    const linkId = await grant(guest, mapping, 'plan-monthly#order-9#1', FRONT, { sourceType: 'day_pass' });
    const fakeRemoveRole = kisi.adapter.removeRole.getMockImplementation();
    kisi.adapter.removeRole.mockImplementation(async (p, k, raId) => {
      if (raId === studioRa) throw Object.assign(new Error('Kisi 503'), { statusCode: 503 });
      return fakeRemoveRole(p, k, raId);
    });

    try {
      const res = await request(app).patch(`/operator/${clientId}/plan-mappings/${mapping}`).send({ status: 'inactive' });
      expect(res.status).toBe(200);
      await waitFor(alertCount(1), 'the alert');
      await waitFor(noRowsOn(mapping, FRONT), 'the front-door plan row to be removed');
    } finally {
      kisi.adapter.removeRole.mockImplementation(fakeRemoveRole);
    }

    expect(kisi.canOpen(dana.userId, FRONT)).toBe(false);
    expect(kisi.canOpen(dana.userId, STUDIO)).toBe(true);
    expect(kisi.adapter.removeRole).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), linkId);
    expect((await sourceRows(mapping)).map(r => [r.source_type, r.hardware_group_id])).toEqual([
      ['day_pass', FRONT], ['plan', STUDIO],
    ]);
    expect((await alerts()).map(a => a.alert_type)).toEqual(['door_removal_failed']);
  });
});
