/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  finalizeRevoke Phase 1 guards D + E ("stop the bleeding")              │
 * │                                                                         │
 * │  finalizeRevoke deletes the member's Kisi user and purges PII. Two      │
 * │  ways that destroyed door access it should not have:                    │
 * │    Guard E — another live member_access row shares the same Kisi user   │
 * │              (sub-member created with the holder's email) → deleting    │
 * │              the user takes the OTHER person's access with it.          │
 * │    Guard D — the Kisi user still holds role assignment(s) after our     │
 * │              revoke (operator-granted doors) → deleting the user        │
 * │              strips access AccessSync never granted.                    │
 * │                                                                         │
 * │  Both refuse with a NON-THROWING { finalized:false } and leave the      │
 * │  member exactly as found: no deleteUser, no member_access /             │
 * │  member_master write, no transaction opened. Guard D fails closed       │
 * │  when the lookup errors.                                                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
  suspendAccess:   jest.fn(),
  enableAccess:    jest.fn(),
  deleteUser:      jest.fn(),
  getRoleAssignmentsForUser: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId:      jest.fn().mockReturnValue('trace-001'),
  setTraceContext: jest.fn(),
  getActor:        jest.fn().mockReturnValue(null),
}));

jest.mock('../../adapters/wix/wix-members-api', () => ({
  getMemberById: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(k => k + '_decrypted'),
}));

jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

const fs              = require('fs');
const path            = require('path');
const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const { log }         = require('../../core/logger');
const traceContext    = require('../../core/trace-context');
const adapter         = require('../../adapters/standard-adapter');

const TENANT_ID        = 'client-uuid-001';
const MEMBER_ACCESS_ID = 'access-uuid-001';
const MEMBER_MASTER_ID = 'master-uuid-001';
const HARDWARE_USER_ID = '99001';
const API_KEY          = 'decrypted-key';

function accessRow(overrides = {}) {
  return {
    rows: [{
      status: 'inactive',
      hardware_user_id: HARDWARE_USER_ID,
      member_master_id: MEMBER_MASTER_ID,
      source_tag: 'accesssync',
      ...overrides,
    }],
  };
}

function sqlCalls() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}

function alertInsertCalls() {
  return db.query.mock.calls.filter(c => /INSERT INTO config_alert_log/.test(c[0]));
}

function warnEvents() {
  return log.warn.mock.calls.map(c => c[0]);
}

// Asserts the "left exactly as found" invariant: nothing destructive ran.
function expectMemberUntouched() {
  expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
  expect(db.getClient).not.toHaveBeenCalled(); // no finalize transaction opened
  for (const sql of sqlCalls()) {
    expect(sql).not.toMatch(/UPDATE member_access/);
    expect(sql).not.toMatch(/UPDATE member_master/);
    expect(sql).not.toMatch(/DELETE FROM/);
  }
}

let txClient;

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  hardwareAdapter.deleteUser.mockReset();
  hardwareAdapter.getRoleAssignmentsForUser.mockReset();
  traceContext.getActor.mockReset();
  traceContext.getActor.mockReturnValue(null);
  txClient = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
  db.getClient.mockResolvedValue(txClient);
});

// ════════════════════════════════════════════════════════════════════════════
// Happy path — both guards pass, finalize proceeds as before
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] finalizeRevoke — guards pass → existing finalize unchanged', () => {
  test('no shared user + no other assignments → deleteUser, then the purge transaction', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())   // status re-check
      .mockResolvedValueOnce({ rows: [] }); // Guard E: no sharers
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([]);
    hardwareAdapter.deleteUser.mockResolvedValueOnce(undefined);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: true, reason: 'ok' });
    expect(hardwareAdapter.getRoleAssignmentsForUser).toHaveBeenCalledWith('kisi', API_KEY, HARDWARE_USER_ID);
    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith('kisi', API_KEY, HARDWARE_USER_ID, { clientId: TENANT_ID });
    // Guard D runs strictly before the destructive call
    expect(hardwareAdapter.getRoleAssignmentsForUser.mock.invocationCallOrder[0])
      .toBeLessThan(hardwareAdapter.deleteUser.mock.invocationCallOrder[0]);
    // Guard E query ran before the transaction
    expect(db.query.mock.invocationCallOrder[1]).toBeLessThan(db.getClient.mock.invocationCallOrder[0]);
    const txSql = txClient.query.mock.calls.map(c => c[0]);
    expect(txSql[0]).toBe('BEGIN');
    expect(txSql.some(s => /UPDATE member_access SET status = 'deleted'/.test(s))).toBe(true);
    expect(txSql[txSql.length - 1]).toBe('COMMIT');
    expect(alertInsertCalls()).toHaveLength(0);
  });

  test('Guard E query shape: same Kisi user, other access row, not deleted, param stringified', async () => {
    db.query
      .mockResolvedValueOnce(accessRow({ hardware_user_id: '99001' }))
      .mockResolvedValueOnce({ rows: [] });
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([]);
    hardwareAdapter.deleteUser.mockResolvedValueOnce(undefined);

    await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, 99001); // numeric id

    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toMatch(/FROM member_access\b/);
    expect(sql).toMatch(/hardware_user_id = \$1/);
    expect(sql).toMatch(/id <> \$2/);
    expect(sql).toMatch(/NOT IN \('deleted'\)/);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)/);
    expect(params).toEqual(['99001', MEMBER_ACCESS_ID]); // varchar column — compared as text
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Guard D — other role assignments
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] finalizeRevoke Guard D — Kisi user still holds role assignments', () => {
  test('≥1 assignment → refuse user_has_other_assignments, alert, warn, member untouched', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [] })   // Guard E passes
      .mockResolvedValueOnce({ rows: [] });  // alert INSERT
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([
      { id: 555, role_id: 'group_basic', group_id: 42 }, // operator-granted door
    ]);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'user_has_other_assignments' });
    expectMemberUntouched();

    const alerts = alertInsertCalls();
    expect(alerts).toHaveLength(1);
    const [, alertParams] = alerts[0];
    expect(alertParams[0]).toBe(TENANT_ID);
    expect(alertParams[1]).toBe('finalize_refused_other_assignments');
    expect(alertParams[2]).toContain(`member_id=${MEMBER_ACCESS_ID}`);
    expect(alertParams[2]).toContain(`kisi_user_id=${HARDWARE_USER_ID}`);
    expect(alertParams[2].length).toBeLessThanOrEqual(255);
    expect(alertParams[3]).toBe('trace-001');

    expect(warnEvents()).toContain('adapter.finalize_revoke.refused_other_assignments');
  });

  test('lookup throws (Kisi 5xx) → fail closed: assignment_check_failed, no throw, member untouched', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [] });
    const kisiErr = new Error('Kisi 503');
    kisiErr.statusCode = 503;
    hardwareAdapter.getRoleAssignmentsForUser.mockRejectedValueOnce(kisiErr);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'assignment_check_failed' });
    expectMemberUntouched();
    expect(warnEvents()).toContain('adapter.finalize_revoke.assignment_check_failed');
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['an object', { data: [] }],
  ])('lookup returns %s (not an array) → fail closed: assignment_check_failed', async (_label, value) => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [] });
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce(value);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'assignment_check_failed' });
    expectMemberUntouched();
  });

  test('L5 lookup method absent → fail closed (never delete on an unknown)', async () => {
    const saved = hardwareAdapter.getRoleAssignmentsForUser;
    delete hardwareAdapter.getRoleAssignmentsForUser;
    try {
      db.query
        .mockResolvedValueOnce(accessRow())
        .mockResolvedValueOnce({ rows: [] });

      const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

      expect(result).toEqual({ finalized: false, reason: 'assignment_check_failed' });
      expectMemberUntouched();
    } finally {
      hardwareAdapter.getRoleAssignmentsForUser = saved;
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Guard E — shared Kisi user
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] finalizeRevoke Guard E — another member_access row shares the Kisi user', () => {
  test('shared → refuse shared_hardware_user, alert, warn, no Kisi calls, member untouched', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [{ id: 'access-uuid-holder' }] }) // holder shares the user
      .mockResolvedValueOnce({ rows: [] });                            // alert INSERT

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'shared_hardware_user' });
    expectMemberUntouched();
    // Evaluated first — the Kisi lookup never needs to run
    expect(hardwareAdapter.getRoleAssignmentsForUser).not.toHaveBeenCalled();

    const alerts = alertInsertCalls();
    expect(alerts).toHaveLength(1);
    expect(alerts[0][1][1]).toBe('finalize_refused_shared_user');
    expect(alerts[0][1][2].length).toBeLessThanOrEqual(255);

    expect(warnEvents()).toContain('adapter.finalize_revoke.refused_shared_user');
  });

  test('Guard E query error propagates (retryable) — before any destructive step', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockRejectedValueOnce(new Error('connection terminated'));

    await expect(
      adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID)
    ).rejects.toThrow('connection terminated');
    expectMemberUntouched();
    expect(hardwareAdapter.getRoleAssignmentsForUser).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Placement + non-regression
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] finalizeRevoke guards — placement and non-regression', () => {
  test('guards run AFTER the status check: access still active → no guard queries', async () => {
    db.query.mockResolvedValueOnce(accessRow({ status: 'active' }));

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'access_still_active' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getRoleAssignmentsForUser).not.toHaveBeenCalled();
  });

  test('guards run AFTER the source_tag check: foreign tag → no guard queries', async () => {
    db.query.mockResolvedValueOnce(accessRow({ source_tag: 'manual' }));

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'foreign_source_tag' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getRoleAssignmentsForUser).not.toHaveBeenCalled();
  });

  test('no hardware user → guards skipped, existing no_hardware_user path unchanged', async () => {
    db.query.mockResolvedValueOnce(accessRow({ hardware_user_id: null }));

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, null);

    expect(result).toEqual({ finalized: true, reason: 'ok' });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getRoleAssignmentsForUser).not.toHaveBeenCalled();
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    expect(db.getClient).toHaveBeenCalledTimes(1);
  });

  test('existing DR-045 refusals keep their finalize_revoke_refused_<reason> alert_type', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [] })   // Guard E
      .mockResolvedValueOnce({ rows: [] });  // alert INSERT
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([]);
    const unowned = new Error('no marker');
    unowned.code = 'UNOWNED_USER';
    hardwareAdapter.deleteUser.mockRejectedValueOnce(unowned);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'kisi_refused_unowned' });
    expect(alertInsertCalls()[0][1][1]).toBe('finalize_revoke_refused_unowned_user');
    expect(db.getClient).not.toHaveBeenCalled();
  });

  test('alert INSERT failing never turns a refusal into a throw', async () => {
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [{ id: 'access-uuid-holder' }] })
      .mockRejectedValueOnce(new Error('alert insert failed'));

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'shared_hardware_user' });
    expectMemberUntouched();
  });

  test('actor lookup throwing never turns a refusal into a throw', async () => {
    traceContext.getActor.mockImplementation(() => { throw new Error('ALS unavailable'); });
    db.query
      .mockResolvedValueOnce(accessRow())
      .mockResolvedValueOnce({ rows: [] });
    hardwareAdapter.getRoleAssignmentsForUser.mockResolvedValueOnce([{ id: 1 }]);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'user_has_other_assignments' });
    expectMemberUntouched();
  });

  test('queue-worker treats finalized:false as a logged, non-throwing skip', () => {
    const workerSrc = fs.readFileSync(path.join(__dirname, '../../core/queue-worker.js'), 'utf8');
    expect(workerSrc).toMatch(/result: finalizeResult\.finalized \? 'success' : 'skipped'/);
    expect(workerSrc).toMatch(/reason:\s+finalizeResult\.reason/);
  });
});
