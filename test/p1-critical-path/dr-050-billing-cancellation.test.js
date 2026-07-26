/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                              │
 * │  DR-050 — member_billing.status honest on a real cancellation           │
 * │                                                                          │
 * │  member_billing.status has only ever held 'active' / 'completed' —      │
 * │  no code path ever set 'cancelled', confirmed live against Supabase      │
 * │  (SELECT status, COUNT(*) FROM member_billing GROUP BY status).          │
 * │                                                                          │
 * │  Orthogonal to DR-051's holder_seated: status answers "still paying,    │
 * │  per Wix?"; holder_seated answers "seated?". A holder releasing their   │
 * │  own seat, or removing a sub-member, does not mean the plan itself      │
 * │  ended on Wix — status must stay untouched in those cases.              │
 * │                                                                          │
 * │  What CANNOT regress:                                                   │
 * │    1. A real (non-synthetic) plan.cancelled/booking.cancelled webhook   │
 * │       flips status to 'cancelled'                                       │
 * │    2. reconciliation.reconcile_member's synthetic revoke ALSO flips it  │
 * │       — it only fires after confirming zero active Wix subs live       │
 * │    3. multi-member.holder_release and .remove_sub NEVER flip it —      │
 * │       the plan is still active on Wix, only a seat changed              │
 * │    4. The flip is scoped to the cancelled plan's billing row(s) only — │
 * │       a person's other active plans are untouched                      │
 * │    5. Idempotent — a billing row already 'cancelled' is not re-touched │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  removeRole: jest.fn(), deleteUser: jest.fn(), suspendAccess: jest.fn(), enableAccess: jest.fn(),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-dr050'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'test' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const MEMBER_ID  = 'ma-uuid-dr050';
const TENANT_ID  = 'client-hog-001';
const GROUP_ID   = 'kisi-group-42';
const RA_ID      = 'kisi-ra-99561847';
const MAPPING_ID = 'mapping-uuid-001';
const PLAN_ID    = 'wix-plan-family';
const BILLING_ID = 'billing-uuid-001';

beforeEach(() => {
  jest.resetAllMocks();
});

/** Queues the standard call sequence through the plan.cancelled branch's single-source path. */
function mockRevokeSequence({ billingRows, remainingCount = '0' }) {
  db.query
    .mockResolvedValueOnce({ rows: [{ hardware_api_key: null }] })                                    // _getClientApiKey
    .mockResolvedValueOnce({ rows: [{ role_assignment_id: RA_ID, hardware_group_id: GROUP_ID, mapping_id: MAPPING_ID }] }) // raWithGroups
    .mockResolvedValueOnce({ rows: billingRows })                                                     // DR-050 billing_id lookup
    .mockResolvedValueOnce({ rowCount: 1 })                                                            // DELETE source row
    .mockResolvedValueOnce({ rows: [{ cnt: remainingCount }] })                                        // COUNT remaining
    .mockResolvedValueOnce({ rowCount: 1 });                                                           // member_access_log INSERT
  if (billingRows.length > 0) {
    db.query.mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] });                                    // DR-050 UPDATE ... RETURNING id
  }
}

describe('[P1] DR-050 — genuine cancellation flips member_billing.status', () => {
  test('a real (non-synthetic) plan.cancelled webhook flips status to cancelled', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID, rawEventType: 'orderCanceled' };
    const status = await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    expect(status).toBe('inactive');
    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/UPDATE member_billing/);
    expect(updateCall[0]).toMatch(/SET status = 'cancelled'/);
    expect(updateCall[1][0]).toEqual([BILLING_ID]);
    expect(updateCall[1][1]).toBe(TENANT_ID);
  });

  test('a real booking.cancelled webhook also flips status', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'booking.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'booking.cancelled', event);

    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/UPDATE member_billing/);
  });

  test('reconciliation.reconcile_member (Wix-verified zero active subs) flips status', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = {
      eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID,
      synthetic: true, syntheticSource: 'reconciliation.reconcile_member',
    };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/UPDATE member_billing/);
  });

  test('no billing rows scoped to this plan → no UPDATE attempted', async () => {
    mockRevokeSequence({ billingRows: [] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/UPDATE member_billing/);
    }
  });
});

describe('[P1] DR-050 — seat changes never flip billing status', () => {
  test('multi-member.holder_release does NOT flip status — plan still active on Wix', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = {
      eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID,
      synthetic: true, syntheticSource: 'multi-member.holder_release',
    };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/UPDATE member_billing/);
    }
  });

  test('multi-member.remove_sub does NOT flip status — holder plan still active on Wix', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = {
      eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID,
      synthetic: true, syntheticSource: 'multi-member.remove_sub',
    };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/UPDATE member_billing/);
    }
  });

  test('an unrecognized future synthetic source defaults to NOT genuine (fail-safe)', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = {
      eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID,
      synthetic: true, syntheticSource: 'some.brand_new.source_nobody_reviewed',
    };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    for (const call of db.query.mock.calls) {
      expect(call[0]).not.toMatch(/UPDATE member_billing/);
    }
  });
});

describe('[P1] DR-050 — scoping and idempotency', () => {
  test('the billing lookup is scoped to this specific plan, not the whole person', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    const lookupCall = db.query.mock.calls[2];
    expect(lookupCall[0]).toMatch(/FROM member_access_sources/);
    expect(lookupCall[0]).toMatch(/source_plan_id/);
    expect(lookupCall[1]).toEqual([MEMBER_ID, 'plan', PLAN_ID, TENANT_ID]);
  });

  test('the UPDATE excludes rows already cancelled (status <> \'cancelled\')', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/status\s*<>\s*'cancelled'/);
  });

  test('the UPDATE is client-scoped (defense-in-depth, matches A9 pattern)', async () => {
    mockRevokeSequence({ billingRows: [{ billing_id: BILLING_ID }] });
    hardwareAdapter.removeRole.mockResolvedValue();

    const event = { eventType: 'plan.cancelled', platformMemberId: 'wix-member-abc', planId: PLAN_ID };
    await grantRevoke.processRevoke(TENANT_ID, MEMBER_ID, 'kisi-user-99', [RA_ID], 'kisi', 'plan.cancelled', event);

    const updateCall = db.query.mock.calls[6];
    expect(updateCall[0]).toMatch(/client_id\s*=\s*\$2/);
  });
});
