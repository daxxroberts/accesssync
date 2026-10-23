/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: reconcile Pass 3 role drift on a Kisi owner / administrator  │
 * │                                                                         │
 * │  Business consequence: a member whose (Kisi user, door group) role is   │
 * │  missing is raised as repair_pending every sweep. A Kisi owner or       │
 * │  administrator opens every door through an org-wide role, so for them   │
 * │  that is a false "missing door": Chad (owner), a family member (admin)  │
 * │  and Daxx's own account (admin) were flagged 4x a day from 2026-10-21.  │
 * │  Once repairs are armed, the false finding would also add AccessSync    │
 * │  group roles to owner accounts.                                         │
 * │                                                                         │
 * │  Fix (2026-10-23): before raising drift, ask the user's own Kisi roles  │
 * │  with the delete guard's detection (findElevatedAssignments). Owner /   │
 * │  admin → a note, not a finding. A lookup that fails keeps the finding.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/webhook-processor', () => ({
  eventQueue: { add: jest.fn().mockResolvedValue({}) },
}));
jest.mock('../../adapters/hardware-adapter', () => ({
  getLocks: jest.fn(),
  getManagedRoleAssignments: jest.fn(),
  findElevatedAssignmentsForUser: jest.fn(),
}));
jest.mock('../../adapters/wix/wix-plans-api', () => ({
  listActiveOrders: jest.fn(),
  listConfirmedBookings: jest.fn(),
}));
jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k) }));
jest.mock('../../adapters/kisi/kisi-connector', () => ({ makeRequest: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const hardwareAdapter = require('../../adapters/hardware-adapter');
const kisiConnector   = require('../../adapters/kisi/kisi-connector');
const kisiAdapter     = require('../../adapters/kisi/kisi-adapter');
const { log }         = require('../../core/logger');
const recon           = require('../../core/reconciliation');

// Kisi role-assignment shapes as findElevatedAssignments reads them.
const OWNER  = { id: 1, role_id: 'owner',          scope: 'organization' };
const ADMIN  = { id: 2, role_id: 'administrator',  scope: 'organization' };
const MEMBER = { id: 3, role_id: 'group_basic',    scope: 'group', group_id: 838622 };

beforeEach(() => jest.clearAllMocks());

describe('kisi-adapter.findElevatedAssignmentsForUser — the delete guard\'s detection, per user', () => {
  test('an organization owner is elevated', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([OWNER]);
    await expect(kisiAdapter.findElevatedAssignmentsForUser('key', '106198887')).resolves.toEqual([OWNER]);
    expect(kisiConnector.makeRequest).toHaveBeenCalledWith(
      '/role_assignments?user_id=106198887&limit=100', { method: 'GET' }, 'key'
    );
  });

  test('an organization administrator is elevated', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([ADMIN]);
    await expect(kisiAdapter.findElevatedAssignmentsForUser('key', '106207200')).resolves.toEqual([ADMIN]);
  });

  test('a member with only the door group role is not elevated', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([MEMBER]);
    await expect(kisiAdapter.findElevatedAssignmentsForUser('key', '102904564')).resolves.toEqual([]);
  });

  test('an unreadable answer throws (the caller decides which way to fail)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ not: 'an array' });
    await expect(kisiAdapter.findElevatedAssignmentsForUser('key', '1')).rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY' });
  });
});

describe('reconciliation._elevatedRoleCoverage — is a missing group role a missing door?', () => {
  test('owner / administrator → covered (their elevated roles come back)', async () => {
    hardwareAdapter.findElevatedAssignmentsForUser.mockResolvedValueOnce([ADMIN]);
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    await expect(covered('99561846')).resolves.toEqual([ADMIN]);
    expect(hardwareAdapter.findElevatedAssignmentsForUser).toHaveBeenCalledWith('kisi', 'key', '99561846');
  });

  test('an ordinary member → not covered, so the drift stays a finding', async () => {
    hardwareAdapter.findElevatedAssignmentsForUser.mockResolvedValueOnce([]);
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    await expect(covered('102904564')).resolves.toBeNull();
  });

  test('the Kisi lookup fails → not covered (never hide a door gap on an unread answer) and warns', async () => {
    const err = Object.assign(new Error('Kisi 503'), { statusCode: 503 });
    hardwareAdapter.findElevatedAssignmentsForUser.mockRejectedValueOnce(err);
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    await expect(covered('106207200')).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'reconciliation.elevated_role_check_failed',
      expect.objectContaining({ clientId: 'client-1', hardwareUserId: '106207200', statusCode: 503 }),
      err
    );
  });

  test('a lookup that cannot even be called (throws synchronously) → not covered, and the sweep does not crash', async () => {
    hardwareAdapter.findElevatedAssignmentsForUser.mockImplementationOnce(() => {
      throw new TypeError('findElevatedAssignmentsForUser is not a function');
    });
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    await expect(covered('106198887')).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      'reconciliation.elevated_role_check_failed', expect.any(Object), expect.any(TypeError)
    );
  });

  test('one Kisi call per user per sweep (a member on 4 plans is asked once)', async () => {
    hardwareAdapter.findElevatedAssignmentsForUser.mockResolvedValue([ADMIN]);
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    for (let i = 0; i < 4; i++) await covered('99561846');
    await covered(99561846); // numeric id from a different row: same user
    expect(hardwareAdapter.findElevatedAssignmentsForUser).toHaveBeenCalledTimes(1);
  });

  test('no hardware user id → not covered, no Kisi call', async () => {
    const covered = recon._elevatedRoleCoverage('kisi', 'key', 'client-1');
    await expect(covered(null)).resolves.toBeNull();
    expect(hardwareAdapter.findElevatedAssignmentsForUser).not.toHaveBeenCalled();
  });
});

describe('Pass 3 wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../core/reconciliation.js'), 'utf8');

  test('the drift branch asks the owner / admin check before raising a ROLE_DRIFT finding, and skips when covered', () => {
    const branch = src.slice(src.indexOf('if (!kisiAssignmentPairs.has(pairKey))'));
    const ask = branch.indexOf('await elevatedRolesFor(row.hardware_user_id)');
    const finding = branch.indexOf('source:          REVOKE_SOURCE.ROLE_DRIFT');
    expect(ask).toBeGreaterThan(-1);
    expect(finding).toBeGreaterThan(ask);
    expect(branch.slice(ask, finding)).toMatch(/if \(elevatedRoles\) \{[\s\S]*continue;/);
  });

  test('the covered note persists; both new events are in the registry', () => {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, '../../core/EVENT_REGISTRY.json'), 'utf8'));
    const overrides = json.overrides || json;
    expect(overrides['reconciliation.role_drift_covered_by_elevated_role']).toEqual({ persist: true });
    const md = fs.readFileSync(path.join(__dirname, '../../core/EVENT_REGISTRY.md'), 'utf8');
    expect(md).toMatch(/`reconciliation\.role_drift_covered_by_elevated_role`/);
    expect(md).toMatch(/`reconciliation\.elevated_role_check_failed`/);
  });
});
