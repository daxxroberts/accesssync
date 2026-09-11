/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: per-member reconcile (reconcileMember) in Phase 1            │
 * │                                                                         │
 * │  Business consequence: an operator presses "Re-check this member" in    │
 * │  the member drawer. Found in the Phase 1 fix round (2026-09-10):        │
 * │    - F15: getManagedRoleAssignments now THROWS on any Kisi error or     │
 * │      malformed page. reconcileMember called it unwrapped, so a Kisi     │
 * │      blip surfaced as a 500 "Reconcile failed" instead of a plain       │
 * │      "couldn't reach the door system — nothing changed".                │
 * │    - F16: the 7b per-member revoke. Its mode gate is real, but 7b is    │
 * │      UNREACHABLE as written (at HEAD c89b7c0 too): whenever 7b's        │
 * │      condition holds, 7a's does as well (no expected groups ⇒ every     │
 * │      actual group is untraceable), and 7a returns first. These tests    │
 * │      pin that NO mode — dry_run, off, an unreadable mode, or 'on' —     │
 * │      lets reconcileMember queue a revoke. Making 7b reachable would     │
 * │      add a removal path, which Phase 1 forbids.                         │
 * │                                                                         │
 * │  PHASE 1 TRIPWIRE: the afterEach below fails any test in this file     │
 * │  that lets a 'revoke' reach eventQueue.add.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs   = require('fs');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));

jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn() },
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks:                  jest.fn(),
  getManagedRoleAssignments: jest.fn(),
  listAllUsers:              jest.fn(),
}));

jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders:      jest.fn(),
  listConfirmedBookings: jest.fn(),
  listOrdersClassified:  jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(enc => `plain-${enc}`) }));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
  withTrace: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() })),
}));

jest.mock('../../core/trace-context', () => ({
  runWith:     jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-rm-001'),
  getTraceId:  jest.fn(() => 'trace-rm-001'),
  getActor:    jest.fn(() => ({ type: 'system', id: 'reconcileMember' })),
}));

const db                  = require('../../db');
const hardwareAdapter     = require('../../adapters/hardware-adapter');
const wixPlansApi         = require('../../adapters/wix/wix-plans-api');
const planMappingResolver = require('../../core/plan-mapping-resolver');
const { eventQueue }      = require('../../core/webhook-processor');
const { log }             = require('../../core/logger');
const reconciliation      = require('../../core/reconciliation');

const CLIENT_ID   = 'client-rm-001';
const ACCESS_ID   = 'ma-rm-001';                 // member_access.id — what the route passes
const PLATFORM_ID = 'wix-member-rm';
const KISI_USER   = 'kisi-user-rm';
const GROUP_ID    = 'kisi-group-rm';
const PLAN_ID     = 'plan-rm-monthly';

const revokeCalls = () => eventQueue.add.mock.calls.filter(c => c[0] === 'revoke');
const sqlCalls    = (fragment) => db.query.mock.calls.filter(c => String(c[0]).includes(fragment));

/**
 * Answers reconcileMember's queries by SQL text.
 *   mode        clients.auto_revoke_mode to answer with (only if 7b ever asks)
 *   modeThrows  the mode read fails (column not migrated)
 *   dbGroups    hardware_group_id values on the member's source rows
 */
function installDb({ mode = 'dry_run', modeThrows = false, dbGroups = [] } = {}) {
  db.query.mockImplementation(async (sql) => {
    const s = String(sql);
    if (s.includes('FROM clients c') && s.includes('connector_subscriptions')) {
      return {
        rows: [{ id: CLIENT_ID, source_site_id: 'wix-site-rm', source_api_key: 'enc-wix',
                 hardware_api_key: 'enc-hw', hardware_platform: 'kisi' }],
        rowCount: 1,
      };
    }
    if (s.includes('FROM member_access ma') && s.includes('WHERE ma.id = $1 AND ma.client_id = $2')) {
      return {
        rows: [{ id: ACCESS_ID, platform_member_id: PLATFORM_ID, hardware_user_id: KISI_USER,
                 sub_master_id: null, source_tag: 'accesssync' }],
        rowCount: 1,
      };
    }
    if (s.includes('SELECT hardware_group_id FROM member_access_sources WHERE access_id = $1')) {
      return { rows: dbGroups.map(g => ({ hardware_group_id: g })), rowCount: dbGroups.length };
    }
    if (s.includes('SELECT auto_revoke_mode FROM clients')) {
      if (modeThrows) throw Object.assign(new Error('column "auto_revoke_mode" does not exist'), { code: '42703' });
      return { rows: [{ auto_revoke_mode: mode }], rowCount: 1 };
    }
    if (s.includes('INSERT INTO config_alert_log')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  eventQueue.add.mockReset();
  eventQueue.add.mockResolvedValue({});
  hardwareAdapter.getManagedRoleAssignments.mockReset();
  wixPlansApi.listActiveOrders.mockReset();
  wixPlansApi.listConfirmedBookings.mockReset();
  planMappingResolver.resolve.mockReset();
});

// PHASE 1 TRIPWIRE — no test in this file may let a revoke reach the queue.
afterEach(() => {
  expect(revokeCalls()).toEqual([]);
});

// ════════════════════════════════════════════════════════════════════════════
// F15 — a failed Kisi read changes nothing and says so plainly
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F15 — reconcileMember wraps the hardware read like the Wix read', () => {

  function payingMemberWorld() {
    installDb({ dbGroups: [GROUP_ID] });
    wixPlansApi.listActiveOrders.mockResolvedValue([{ memberId: PLATFORM_ID, planId: PLAN_ID, email: 'm@example.test', name: 'M' }]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);
    planMappingResolver.resolve.mockResolvedValue([{ mappingId: 'map-rm', hardwareGroupId: GROUP_ID, hardwarePlatform: 'kisi' }]);
  }

  test.each([
    ['a KISI_PAGE_INTEGRITY page', Object.assign(new Error('KISI_PAGE_INTEGRITY: /role_assignments — non_array_page'), { code: 'KISI_PAGE_INTEGRITY' })],
    ['a Kisi 503',                 Object.assign(new Error('Kisi API 503'), { statusCode: 503, code: 'HARDWARE_API_ERROR' })],
  ])('getManagedRoleAssignments throws (%s) → hardware_unavailable, plain-English alert, nothing queued, nothing written', async (_label, err) => {
    payingMemberWorld();
    hardwareAdapter.getManagedRoleAssignments.mockRejectedValue(err);

    const result = await reconciliation.reconcileMember(ACCESS_ID, CLIENT_ID);

    expect(result).toEqual({
      action: 'hardware_unavailable', granted: 0, revoked: 0, repaired: 0,
      alerts: [{
        code:   'hardware_api_unavailable',
        detail: 'AccessSync couldn’t reach the door system — no changes were made. Try again in a few minutes.',
      }],
    });
    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(sqlCalls('INSERT INTO config_alert_log')).toEqual([]);
    expect(sqlCalls('FROM member_access_sources')).toEqual([]);          // stopped before the drift check
    expect(log.warn).toHaveBeenCalledWith('reconcileMember.hardware_fetch_failed', expect.objectContaining({
      clientId: CLIENT_ID, memberId: ACCESS_ID, hardwarePlatform: 'kisi',
      code: err.code, statusCode: err.statusCode || null,
    }), err);
  });

  test('getManagedRoleAssignments returns a non-array → treated as unavailable (fail-closed), nothing queued', async () => {
    payingMemberWorld();
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue({ data: [] });

    const result = await reconciliation.reconcileMember(ACCESS_ID, CLIENT_ID);

    expect(result.action).toBe('hardware_unavailable');
    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('reconcileMember.hardware_fetch_failed',
      expect.objectContaining({ code: 'KISI_PAGE_INTEGRITY' }), expect.any(Error));
  });

  test('the happy path is unchanged: Kisi answers, the member pays and holds the door → ok, nothing queued', async () => {
    payingMemberWorld();
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([{ userId: KISI_USER, groupId: GROUP_ID }]);

    const result = await reconciliation.reconcileMember(ACCESS_ID, CLIENT_ID);

    expect(result.action).toBe('ok');
    expect(eventQueue.add).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith('reconcileMember.hardware_fetch_failed', expect.anything(), expect.anything());
  });
});

// ════════════════════════════════════════════════════════════════════════════
// F16 — the 7b per-member revoke: gated, and unreachable in every mode
// ════════════════════════════════════════════════════════════════════════════

describe('[P3] Fix round F16 — reconcileMember never queues a revoke, in any mode (7b is unreachable)', () => {

  // A member with NO active Wix plan whose Kisi user still holds a door role —
  // exactly the case 7b was written for.
  function noPlanButDoorWorld(dbOpts) {
    installDb({ dbGroups: [GROUP_ID], ...dbOpts });
    wixPlansApi.listActiveOrders.mockResolvedValue([]);
    wixPlansApi.listConfirmedBookings.mockResolvedValue([]);
    hardwareAdapter.getManagedRoleAssignments.mockResolvedValue([{ userId: KISI_USER, groupId: GROUP_ID }]);
  }

  test.each([
    ["mode 'dry_run'",                  { mode: 'dry_run' }],
    ["mode 'off'",                      { mode: 'off' }],
    ['the mode read throws (→ off)',    { modeThrows: true }],
    ["mode 'on'",                       { mode: 'on' }],
  ])('%s: no active plan + door access → 7a needs_attention (untraceable); 0 jobs queued; the mode is never even read', async (_label, dbOpts) => {
    noPlanButDoorWorld(dbOpts);

    const result = await reconciliation.reconcileMember(ACCESS_ID, CLIENT_ID);

    expect(result.action).toBe('needs_attention');
    expect(result.revoked).toBe(0);
    expect(result.alerts.map(a => a.code)).toEqual(['untraceable_hardware_access']);
    expect(eventQueue.add).not.toHaveBeenCalled();                    // no revoke, no grant
    expect(sqlCalls('SELECT auto_revoke_mode FROM clients')).toEqual([]); // 7b's gate is never reached
    expect(log.warn).not.toHaveBeenCalledWith('reconciliation.revoke_held', expect.anything());
  });

  test("7b's own gate stays in place: it reads the mode and returns before any revoke unless the mode is exactly 'on'", () => {
    const src   = fs.readFileSync(path.join(__dirname, '../../core/reconciliation.js'), 'utf8');
    const start = src.indexOf('// 7b. Case: no active Wix subs, hardware has access → revoke');
    const end   = src.indexOf('// 7c. Case:', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = src.slice(start, end);
    const modeRead = block.indexOf('await this._readAutoRevokeMode(clientId)');
    const gate     = block.indexOf('if (mode !== REVOKE_MODE.ON) {');
    const enqueue  = block.indexOf("eventQueue.add('revoke'");
    expect(modeRead).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(modeRead);
    expect(enqueue).toBeGreaterThan(gate);
    // the gated branch returns revoke_held before the enqueue
    expect(block.slice(gate, enqueue)).toMatch(/result\.action = 'revoke_held';\s*return result;/);
  });
});
