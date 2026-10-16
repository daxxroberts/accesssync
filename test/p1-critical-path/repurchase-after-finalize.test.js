/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Re-purchase after a finalized revoke gets a live Kisi user             │
 * │                                                                         │
 * │  2026-10-15: a member cancelled (21:15). finalizeRevoke deleted their   │
 * │  Kisi user and set member_access.status='deleted', keeping              │
 * │  hardware_user_id as DR-044 lineage. They re-bought at 21:19:           │
 * │  resolveIdentity's cache hit returned the dead id, createUser was       │
 * │  skipped, and all three grant jobs failed with Kisi 422 "assignee must  │
 * │  exist". The member paid and got no door.                               │
 * │                                                                         │
 * │  Contract: the grant-path UPSERT in resolveAndLock drops the dead id    │
 * │  when (and only when) the row it reactivates is 'deleted', so           │
 * │  resolveIdentity finds or creates a live user. finalize itself still    │
 * │  preserves hardware_user_id (DR-044 lineage — ob-248 test).             │
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
const adapter         = require('../../adapters/standard-adapter');

const TENANT_ID        = 'client-uuid-001';
const MEMBER_ACCESS_ID = 'access-uuid-001';
const MEMBER_MASTER_ID = 'master-uuid-001';
const API_KEY          = 'decrypted-key';

let txClient;

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [], rowCount: 1 });
  hardwareAdapter.findUserByEmail.mockReset();
  txClient = { query: jest.fn(), release: jest.fn() };
  db.getClient.mockResolvedValue(txClient);
});

function accessUpsertCall() {
  return txClient.query.mock.calls.find(c => /INSERT INTO member_access\b/.test(c[0]));
}

describe('[P1] resolveAndLock grant path — a deleted row drops its dead Kisi id', () => {
  test('the UPSERT nulls hardware_user_id only when the prior status is deleted', async () => {
    txClient.query.mockImplementation(async (sql) => {
      if (/INSERT INTO member_master/.test(sql)) return { rows: [{ id: MEMBER_MASTER_ID }] };
      if (/INSERT INTO member_access\b/.test(sql)) return { rows: [{ id: MEMBER_ACCESS_ID, hardware_user_id: null }] };
      return { rows: [] };
    });

    const result = await adapter.resolveAndLock(
      TENANT_ID, { platformMemberId: 'wix-member-1', sourcePlatform: 'wix' }, 'kisi'
    );

    expect(result).toEqual({ memberId: MEMBER_ACCESS_ID });
    const [sql] = accessUpsertCall();
    const doUpdate = sql.slice(sql.indexOf('DO UPDATE'));
    expect(doUpdate).toMatch(
      /hardware_user_id\s*=\s*CASE WHEN member_access\.status = 'deleted'\s+THEN NULL ELSE member_access\.hardware_user_id END/
    );
    expect(doUpdate).toMatch(/status = 'in_flight'/);
  });

  test('finalize still preserves hardware_user_id (DR-044 lineage)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../adapters/standard-adapter.js'), 'utf8');
    const finalizeUpdate = src.match(/UPDATE member_access SET status = 'deleted'[^`]*`/)[0];
    expect(finalizeUpdate).not.toMatch(/hardware_user_id/);
  });
});

describe('[P1] resolveAndLock grant path — the dropped id is logged (DR-044 lineage)', () => {
  const { log } = require('../../core/logger');
  const EVENT = { platformMemberId: 'wix-member-1', sourcePlatform: 'wix' };

  function mockLockRow(lockRows) {
    txClient.query.mockImplementation(async (sql) => {
      if (/INSERT INTO member_master/.test(sql)) return { rows: [{ id: MEMBER_MASTER_ID }] };
      if (/FROM member_access\s+WHERE member_master_id = \$1 AND client_id = \$2\s+FOR UPDATE NOWAIT/.test(sql)) {
        return { rows: lockRows };
      }
      if (/INSERT INTO member_access\b/.test(sql)) return { rows: [{ id: MEMBER_ACCESS_ID, hardware_user_id: null }] };
      return { rows: [] };
    });
  }

  function droppedWarns() {
    return log.warn.mock.calls.filter(c => c[0] === 'adapter.identity_dropped_after_finalize');
  }

  test('the lock query reads the prior status and hardware_user_id', async () => {
    mockLockRow([]);
    await adapter.resolveAndLock(TENANT_ID, EVENT, 'kisi');
    const lockCall = txClient.query.mock.calls.find(c => /FOR UPDATE NOWAIT/.test(c[0]));
    expect(lockCall[0]).toMatch(/SELECT id, status, hardware_user_id FROM member_access/);
  });

  test('prior row deleted with a Kisi id → warn logged once with the dropped id', async () => {
    mockLockRow([{ id: MEMBER_ACCESS_ID, status: 'deleted', hardware_user_id: '105806071' }]);

    const result = await adapter.resolveAndLock(TENANT_ID, EVENT, 'kisi');

    expect(result).toEqual({ memberId: MEMBER_ACCESS_ID });
    const warns = droppedWarns();
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toEqual({
      memberId: MEMBER_ACCESS_ID,
      memberMasterId: MEMBER_MASTER_ID,
      tenantId: TENANT_ID,
      platformMemberId: 'wix-member-1',
      droppedHardwareUserId: '105806071',
      stage: 'resolve', result: 'success',
    });
  });

  test('prior row inactive (id kept, not dropped) → no dropped-id warn', async () => {
    mockLockRow([{ id: MEMBER_ACCESS_ID, status: 'inactive', hardware_user_id: '105806071' }]);

    const result = await adapter.resolveAndLock(TENANT_ID, EVENT, 'kisi');

    expect(result).toEqual({ memberId: MEMBER_ACCESS_ID });
    expect(droppedWarns()).toHaveLength(0);
  });

  test('no prior row (brand-new member) → no warn, no crash', async () => {
    mockLockRow([]);

    const result = await adapter.resolveAndLock(TENANT_ID, EVENT, 'kisi');

    expect(result).toEqual({ memberId: MEMBER_ACCESS_ID });
    expect(droppedWarns()).toHaveLength(0);
  });
});

describe('[P1] resolveIdentity after the id is dropped', () => {
  test('null cached id → find-or-create runs and the live Kisi id is cached', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null, first_name: null, last_name: null, display_name: null }] })
      .mockResolvedValue({ rows: [] });
    hardwareAdapter.findUserByEmail.mockResolvedValueOnce('107200000');

    const id = await adapter.resolveIdentity(
      MEMBER_ACCESS_ID, 'member@example.com', 'Member Name', 'kisi', API_KEY,
      { userPattern: 'invited', tenantId: TENANT_ID }
    );

    expect(id).toBe('107200000');
    expect(hardwareAdapter.findUserByEmail).toHaveBeenCalled();
    const cacheWrite = db.query.mock.calls.find(c => /UPDATE member_access SET hardware_user_id = \$1/.test(c[0]));
    expect(cacheWrite[1]).toEqual(['107200000', MEMBER_ACCESS_ID]);
  });

  test('a kept cached id is trusted without a Kisi call — why the dead id had to go', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ hardware_user_id: '105806071' }] });

    const id = await adapter.resolveIdentity(
      MEMBER_ACCESS_ID, 'member@example.com', 'Member Name', 'kisi', API_KEY,
      { userPattern: 'invited', tenantId: TENANT_ID }
    );

    expect(id).toBe('105806071');
    expect(hardwareAdapter.findUserByEmail).not.toHaveBeenCalled();
  });
});
