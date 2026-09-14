/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: day pass grant + revoke (OB-98 / OB-101 / OB-251)            │
 * │                                                                         │
 * │  A day pass is a Wix 1-day plan delivered as a Kisi group link (QR +   │
 * │  access link) — no hardware user, no role assignment. These tests pin:  │
 * │    - processDayPassGrant creates a link per mapping, never assignRole   │
 * │    - endDate rule: synthetic → no-op, real webhook → DAY_PASS_NO_END_DATE│
 * │    - processGrant's reuse SELECTs never adopt a day_pass row            │
 * │    - processRevoke: link deleted BEFORE the row, only for this plan,    │
 * │      never removeRole; role rows' remaining-count excludes day_pass     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
  deleteUser:      jest.fn(),
  suspendAccess:   jest.fn(),
  enableAccess:    jest.fn(),
  createGroupLink: jest.fn(),
  deleteGroupLink: jest.fn(),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-daypass-001'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const MEMBER_ID  = 'ma-uuid-daypass-001';
const TENANT_ID  = 'client-hog-001';
const MAPPING_ID = 'mapping-uuid-daypass';
const GROUP_ID   = 'kisi-group-daypass';
const PLAN_ID    = 'wix-plan-daypass';
const LINK_ID    = 777;
const START      = '2026-09-14T15:00:00.000Z';
const END        = '2026-09-15T15:00:00.000Z';

const dayPassMapping = {
  mappingId:        MAPPING_ID,
  hardwarePlatform: 'kisi',
  hardwareGroupId:  GROUP_ID,
  apiKey:           'kisi-api-key',
  accessType:       'day_pass',
};

const dayPassEvent = {
  eventType:        'plan.purchased',
  platformMemberId: 'wix-member-daypass',
  planId:           PLAN_ID,
  planName:         'Day Pass',
  startDate:        START,
  endDate:          END,
  wixOrderId:       'order-daypass-1',
};

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ─── processDayPassGrant ────────────────────────────────────────────────────

describe('[P1] day pass — processDayPassGrant', () => {

  test('creates one group link per mapping and never calls assignRole', async () => {
    hardwareAdapter.createGroupLink.mockResolvedValue({
      id: LINK_ID, linkUrl: 'https://link.example/abc', qrImageBase64: 'QUJD', qrImageUrl: null, secret: 's3cr3t',
    });

    const { assignments, links } = await grantRevoke.processDayPassGrant(
      TENANT_ID, MEMBER_ID, [dayPassMapping], dayPassEvent, { email: 'buyer@example.com' }
    );

    expect(hardwareAdapter.assignRole).not.toHaveBeenCalled();
    expect(hardwareAdapter.createGroupLink).toHaveBeenCalledTimes(1);
    const [platform, apiKey, params] = hardwareAdapter.createGroupLink.mock.calls[0];
    expect(platform).toBe('kisi');
    expect(apiKey).toBe('kisi-api-key');
    expect(params).toMatchObject({
      groupId: GROUP_ID, clientId: TENANT_ID, email: 'buyer@example.com',
      validFrom: START, validUntil: END,
    });
    expect(params.label).toContain('Day Pass');

    expect(assignments).toHaveLength(1);
    expect(assignments[0]).toMatchObject({
      accessId: MEMBER_ID, mappingId: MAPPING_ID, roleAssignmentId: String(LINK_ID),
      hardwareGroupId: GROUP_ID, sourceType: 'day_pass', sourcePlanId: PLAN_ID,
      planEndDate: END, effectiveStart: START, wixOrderId: 'order-daypass-1',
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      groupLinkId: LINK_ID, linkUrl: 'https://link.example/abc', qrImageBase64: 'QUJD', validUntil: END,
    });

    // provisioned audit row written (credential_type 'qr' lives in the helper's params)
    const logCall = db.query.mock.calls.find(c => /INSERT INTO member_access_log/.test(c[0]));
    expect(logCall).toBeTruthy();
  });

  test('synthetic event without endDate → empty result, no hardware call, no throw', async () => {
    const synthetic = { ...dayPassEvent, endDate: null, synthetic: true, syntheticSource: 'reconciliation.reconcile_member' };
    const result = await grantRevoke.processDayPassGrant(TENANT_ID, MEMBER_ID, [dayPassMapping], synthetic);
    expect(result).toEqual({ assignments: [], links: [] });
    expect(hardwareAdapter.createGroupLink).not.toHaveBeenCalled();
  });

  test('REAL webhook without endDate → throws DAY_PASS_NO_END_DATE before any hardware call', async () => {
    const noEnd = { ...dayPassEvent, endDate: null };
    await expect(
      grantRevoke.processDayPassGrant(TENANT_ID, MEMBER_ID, [dayPassMapping], noEnd)
    ).rejects.toMatchObject({ code: 'DAY_PASS_NO_END_DATE' });
    expect(hardwareAdapter.createGroupLink).not.toHaveBeenCalled();
  });

  test('dayPassEndDate: returns endDate, null for synthetic-without, throws for real-without', () => {
    expect(grantRevoke.dayPassEndDate(dayPassEvent)).toBe(END);
    expect(grantRevoke.dayPassEndDate({ synthetic: true })).toBeNull();
    expect(() => grantRevoke.dayPassEndDate({ eventType: 'plan.purchased' })).toThrow(/end date/);
  });

  test('partial failure: one mapping fails, one succeeds → returns the success, no throw', async () => {
    const second = { ...dayPassMapping, mappingId: 'mapping-2', hardwareGroupId: 'group-2' };
    hardwareAdapter.createGroupLink
      .mockRejectedValueOnce(Object.assign(new Error('kisi 500'), { statusCode: 500, code: 'HARDWARE_API_ERROR' }))
      .mockResolvedValueOnce({ id: 778, linkUrl: null, qrImageBase64: 'QUJD' });

    const { assignments } = await grantRevoke.processDayPassGrant(
      TENANT_ID, MEMBER_ID, [dayPassMapping, second], dayPassEvent
    );
    expect(assignments).toHaveLength(1);
    expect(assignments[0].mappingId).toBe('mapping-2');
  });

  test('all mappings fail → throws the first failure', async () => {
    const boom = Object.assign(new Error('kisi 500'), { statusCode: 500, code: 'HARDWARE_API_ERROR' });
    hardwareAdapter.createGroupLink.mockRejectedValue(boom);
    await expect(
      grantRevoke.processDayPassGrant(TENANT_ID, MEMBER_ID, [dayPassMapping], dayPassEvent)
    ).rejects.toBe(boom);
  });
});

// ─── processGrant must never adopt a day-pass row ───────────────────────────

describe('[P1] day pass — processGrant reuse SELECTs exclude day_pass rows', () => {
  const permMapping = { ...dayPassMapping, accessType: 'permanent' };
  const permEvent   = { eventType: 'plan.purchased', platformMemberId: 'wix-member-perm', planId: 'wix-plan-perm' };

  test('both idempotency SELECTs carry source_type <> day_pass', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })      // source check
      .mockResolvedValueOnce({ rows: [] })      // idempotency check
      .mockResolvedValueOnce({ rowCount: 1 });  // member_access_log INSERT
    hardwareAdapter.assignRole.mockResolvedValue('ra-1');

    await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, 'kisi-user-1', [permMapping], permEvent);

    expect(db.query.mock.calls[0][0]).toMatch(/source_type\s*<>\s*'day_pass'/);
    expect(db.query.mock.calls[1][0]).toMatch(/source_type\s*<>\s*'day_pass'/);
    // Param shapes unchanged — the guard is SQL-literal only.
    expect(db.query.mock.calls[0][1]).toEqual([MEMBER_ID, GROUP_ID]);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith('kisi', 'kisi-api-key', 'kisi-user-1', GROUP_ID);
  });
});

// ─── processRevoke — day pass rows ──────────────────────────────────────────

describe('[P1] day pass — processRevoke plan.cancelled', () => {
  const cancelEvent = {
    eventType: 'plan.cancelled', rawEventType: 'orderEnded',
    platformMemberId: 'wix-member-daypass', planId: PLAN_ID,
  };
  const dayPassRow = {
    role_assignment_id: String(LINK_ID), hardware_group_id: GROUP_ID, mapping_id: MAPPING_ID,
    source_plan_id: PLAN_ID, source_type: 'day_pass',
  };

  test('deletes the Kisi link BEFORE the row, scoped to this plan, and never calls removeRole', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })  // _getClientApiKey
      .mockResolvedValueOnce({ rows: [dayPassRow] })                   // raWithGroups
      .mockResolvedValueOnce({ rows: [] })                             // DR-050 billing lookup
      .mockResolvedValueOnce({ rowCount: 1 })                          // DELETE source row
      .mockResolvedValueOnce({ rowCount: 1 });                         // member_access_log INSERT
    hardwareAdapter.deleteGroupLink.mockResolvedValue(undefined);

    const status = await grantRevoke.processRevoke(
      TENANT_ID, MEMBER_ID, null, [String(LINK_ID)], 'kisi', 'plan.cancelled', cancelEvent
    );

    expect(status).toBe('inactive');
    expect(hardwareAdapter.removeRole).not.toHaveBeenCalled();
    expect(hardwareAdapter.deleteGroupLink).toHaveBeenCalledWith('kisi', null, String(LINK_ID), { clientId: TENANT_ID });

    const deleteIdx = db.query.mock.calls.findIndex(c => /DELETE FROM member_access_sources/.test(c[0]));
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(db.query.mock.calls[deleteIdx][1]).toEqual([MEMBER_ID, GROUP_ID, 'day_pass', PLAN_ID, TENANT_ID]);

    // Kisi DELETE happened before the row DELETE (404-idempotent ordering)
    const kisiOrder = hardwareAdapter.deleteGroupLink.mock.invocationCallOrder[0];
    const rowOrder  = db.query.mock.invocationCallOrder[deleteIdx];
    expect(kisiOrder).toBeLessThan(rowOrder);
  });

  test('a day_pass row for a DIFFERENT plan is left alone', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      .mockResolvedValueOnce({ rows: [{ ...dayPassRow, source_plan_id: 'some-other-plan' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 });                         // member_access_log INSERT

    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, null, [String(LINK_ID)], 'kisi', 'plan.cancelled', cancelEvent);

    expect(hardwareAdapter.deleteGroupLink).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(c => /DELETE FROM member_access_sources/.test(c[0]))).toBe(false);
  });

  test('role rows: remaining-count excludes day_pass, removeRole still fires when nothing else remains', async () => {
    const roleRow = {
      role_assignment_id: 'ra-99', hardware_group_id: GROUP_ID, mapping_id: MAPPING_ID,
      source_plan_id: PLAN_ID, source_type: 'plan',
    };
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      .mockResolvedValueOnce({ rows: [roleRow] })
      .mockResolvedValueOnce({ rows: [] })                             // billing lookup
      .mockResolvedValueOnce({ rowCount: 1 })                          // DELETE
      .mockResolvedValueOnce({ rows: [{ cnt: '0' }] })                 // remaining count
      .mockResolvedValueOnce({ rowCount: 1 });                         // member_access_log INSERT

    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-1', ['ra-99'], 'kisi', 'plan.cancelled', cancelEvent);

    expect(hardwareAdapter.removeRole).toHaveBeenCalledWith('kisi', null, 'ra-99');
    expect(hardwareAdapter.deleteGroupLink).not.toHaveBeenCalled();
    const remainingCall = db.query.mock.calls.find(c => /SELECT COUNT\(\*\) AS cnt FROM member_access_sources/.test(c[0]));
    expect(remainingCall[0]).toMatch(/source_type\s*<>\s*'day_pass'/);
  });

  test('billing lookup for plan.cancelled spans plan AND day_pass source types', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })
      .mockResolvedValueOnce({ rows: [dayPassRow] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 });
    hardwareAdapter.deleteGroupLink.mockResolvedValue(undefined);

    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, null, [String(LINK_ID)], 'kisi', 'plan.cancelled', cancelEvent);

    const billingCall = db.query.mock.calls[2];
    expect(billingCall[0]).toMatch(/source_type = ANY\(\$2::text\[\]\)/);
    expect(billingCall[1][1]).toEqual(['plan', 'day_pass']);
  });
});
