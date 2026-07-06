/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Standard Adapter — DR-023 L3 primitives (2026-07-06 boundary refactor) │
 * │                                                                         │
 * │  Direct method-level coverage for the six primitives extracted so that │
 * │  no code outside L3 writes member_access / member_master /              │
 * │  member_access_sources:                                                 │
 * │    rollupAccessStatus, rollupAccessStatusByPlatformMember,              │
 * │    markRecoveryPending, markKisiUserObservation,                        │
 * │    markSubMemberRemoving, createSubMemberDraft                          │
 * │                                                                         │
 * │  These sit on the grant/revoke critical path (rollup runs on every      │
 * │  completeGrant/completeRevoke) — hence P1.                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// ─── Mocks ──────────────────────────────────────────────────────────────────

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
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId:      jest.fn().mockReturnValue(null),
  setTraceContext: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-members-api', () => ({
  getMemberById: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(k => k + '_decrypted'),
}));

jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

// ─── Setup ──────────────────────────────────────────────────────────────────

const db      = require('../../db');
const adapter = require('../../adapters/standard-adapter');

const ACCESS_ID = 'access-uuid-001';
const CLIENT_ID = 'client-uuid-001';

function capturedQueries() {
  return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// markRecoveryPending
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] markRecoveryPending', () => {
  test('flips one row to recovery_pending and stamps updated_at', async () => {
    await adapter.markRecoveryPending(ACCESS_ID);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE member_access SET status = 'recovery_pending', updated_at = NOW\(\) WHERE id = \$1/);
    expect(params).toEqual([ACCESS_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markKisiUserObservation
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] markKisiUserObservation', () => {
  test('disappeared=true stamps kisi_user_disappeared_observed_at = NOW()', async () => {
    await adapter.markKisiUserObservation(ACCESS_ID, true);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET kisi_user_disappeared_observed_at = NOW\(\)/);
    expect(params).toEqual([ACCESS_ID]);
  });

  test('disappeared=false clears the marker to NULL', async () => {
    await adapter.markKisiUserObservation(ACCESS_ID, false);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET kisi_user_disappeared_observed_at = NULL/);
    expect(params).toEqual([ACCESS_ID]);
  });

  test('deliberately does NOT touch updated_at (feeds the stale-lock threshold)', async () => {
    await adapter.markKisiUserObservation(ACCESS_ID, true);
    await adapter.markKisiUserObservation(ACCESS_ID, false);

    for (const sql of capturedQueries()) {
      expect(sql).not.toMatch(/updated_at/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rollupAccessStatus
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] rollupAccessStatus', () => {
  test('plain variant: single query, CASE rollup, no provisioned_at stamp', async () => {
    await adapter.rollupAccessStatus(ACCESS_ID);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET status = CASE/);
    expect(sql).toMatch(/WHEN EXISTS \(\s*SELECT 1 FROM member_access_sources mas\s*WHERE mas\.access_id = \$1 AND mas\.status = 'active'\s*\) THEN 'active'/);
    expect(sql).toMatch(/ELSE 'inactive'/);
    expect(sql).not.toMatch(/provisioned_at/);
    expect(sql).not.toMatch(/hardware_platform/);
    expect(params).toEqual([ACCESS_ID]);
  });

  test('stampProvisioned variant: also stamps provisioned_at + hardware_platform', async () => {
    await adapter.rollupAccessStatus(ACCESS_ID, { stampProvisioned: true, hardwarePlatform: 'kisi' });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/provisioned_at = COALESCE\(provisioned_at, NOW\(\)\)/);
    expect(sql).toMatch(/hardware_platform = COALESCE\(hardware_platform, \$2\)/);
    expect(params).toEqual([ACCESS_ID, 'kisi']);
  });

  test('stampProvisioned with null hardwarePlatform STILL stamps provisioned_at (pre-refactor behavior)', async () => {
    // completeGrant resolves hardwarePlatform from assignments[0] which can be
    // absent — the grant rollup must still stamp provisioned_at in that case.
    await adapter.rollupAccessStatus(ACCESS_ID, { stampProvisioned: true, hardwarePlatform: null });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/provisioned_at = COALESCE\(provisioned_at, NOW\(\)\)/);
    expect(params).toEqual([ACCESS_ID, null]);
  });

  test('dbClient pass-through: runs on the transaction client, not the pool', async () => {
    const fakeClient = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    await adapter.rollupAccessStatus(ACCESS_ID, { dbClient: fakeClient });

    expect(fakeClient.query).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// rollupAccessStatusByPlatformMember
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] rollupAccessStatusByPlatformMember', () => {
  test('set-based rollup keyed by (client_id, platform_member_id) via member_master join', async () => {
    await adapter.rollupAccessStatusByPlatformMember(CLIENT_ID, 'wix-member-abc');

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE member_access ma/);
    expect(sql).toMatch(/FROM member_master mm/);
    expect(sql).toMatch(/ma\.member_master_id = mm\.id/);
    expect(sql).toMatch(/ma\.client_id = \$1/);
    expect(sql).toMatch(/mm\.platform_member_id = \$2/);
    expect(sql).toMatch(/WHEN EXISTS/);
    expect(params).toEqual([CLIENT_ID, 'wix-member-abc']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markSubMemberRemoving
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] markSubMemberRemoving', () => {
  test("writes the DR-044 'removing' entry state with updated_at stamp", async () => {
    await adapter.markSubMemberRemoving(ACCESS_ID);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE member_access SET status = 'removing', updated_at = NOW\(\) WHERE id = \$1/);
    expect(params).toEqual([ACCESS_ID]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createSubMemberDraft
// ─────────────────────────────────────────────────────────────────────────────

describe('[P1] createSubMemberDraft', () => {
  const DRAFT_PARAMS = {
    clientId:            CLIENT_ID,
    sourcePlatform:      'wix',
    hardwarePlatform:    'kisi',
    holderMasterId:      'holder-master-uuid',
    subPlatformMemberId: 'wix-holder-1###asab12cd',
    firstName:           'Drew',
    lastName:            'Roberts',
    email:               'drew@test.com',
    phone:               '555-0100',
    planMappingId:       'mapping-uuid-001',
    sourcePlanId:        'plan-uuid-001',
    hardwareGroupId:     'group-uuid-001',
  };

  function mockDraftHappyPath() {
    db.query
      .mockResolvedValueOnce({ rows: [{
        id: 'mm-sub-1', platform_member_id: DRAFT_PARAMS.subPlatformMemberId,
        first_name: 'Drew', last_name: 'Roberts', email: 'drew@test.com', phone: '555-0100',
      }] })
      .mockResolvedValueOnce({ rows: [{ id: 'acc-sub-1', status: 'pending_identity' }] })
      .mockResolvedValueOnce({ rows: [] });
  }

  test('writes the 3 draft rows in order: member_master → member_access → member_access_sources', async () => {
    mockDraftHappyPath();
    await adapter.createSubMemberDraft(DRAFT_PARAMS);

    expect(db.query).toHaveBeenCalledTimes(3);
    const sqls = capturedQueries();
    expect(sqls[0]).toMatch(/INSERT INTO member_master/);
    expect(sqls[0]).toMatch(/'accesssync'/); // DR-003 source_tag
    expect(sqls[1]).toMatch(/INSERT INTO member_access/);
    expect(sqls[1]).toMatch(/'pending_identity'/);
    expect(sqls[2]).toMatch(/INSERT INTO member_access_sources/);
    expect(sqls[2]).toMatch(/'draft'/);
  });

  test('links the rows: access row gets master id + sub_master_id, source row gets access id', async () => {
    mockDraftHappyPath();
    await adapter.createSubMemberDraft(DRAFT_PARAMS);

    const accessParams = db.query.mock.calls[1][1];
    expect(accessParams[0]).toBe('mm-sub-1');                    // member_master_id from row 1
    expect(accessParams[5]).toBe(DRAFT_PARAMS.holderMasterId);   // sub_master_id

    const sourceParams = db.query.mock.calls[2][1];
    expect(sourceParams[1]).toBe('acc-sub-1');                   // access_id from row 2
    expect(sourceParams[4]).toBe(DRAFT_PARAMS.planMappingId);    // mapping_id
  });

  test('returns the shape the add-member route response is built from', async () => {
    mockDraftHappyPath();
    const draft = await adapter.createSubMemberDraft(DRAFT_PARAMS);

    expect(draft).toEqual({
      memberMasterId:   'mm-sub-1',
      platformMemberId: DRAFT_PARAMS.subPlatformMemberId,
      firstName:        'Drew',
      lastName:         'Roberts',
      email:            'drew@test.com',
      phone:            '555-0100',
      accessId:         'acc-sub-1',
      accessStatus:     'pending_identity',
    });
  });

  test('deliberately non-transactional — no BEGIN/COMMIT (caller retry loop owns 23505 semantics)', async () => {
    mockDraftHappyPath();
    await adapter.createSubMemberDraft(DRAFT_PARAMS);

    for (const sql of capturedQueries()) {
      expect(sql).not.toMatch(/BEGIN|COMMIT/);
    }
  });

  test('propagates raw pg 23505 so the caller can regenerate the DR-029 suffix', async () => {
    const dupErr = new Error('duplicate key value violates unique constraint');
    dupErr.code = '23505';
    db.query.mockRejectedValueOnce(dupErr);

    await expect(adapter.createSubMemberDraft(DRAFT_PARAMS)).rejects.toMatchObject({ code: '23505' });
    expect(db.query).toHaveBeenCalledTimes(1); // stopped at the collision, no partial rows after
  });
});
