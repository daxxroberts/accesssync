/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Standard Adapter — new schema (S-2)                                    │
 * │                                                                         │
 * │  Replaces: member-pays-gets-access.test.js                              │
 * │            member-cancels-loses-access.test.js                          │
 * │            ob-89-two-gate.test.js (Gate 2 DB cache tier only)           │
 * │                                                                         │
 * │  Verifies every function in adapters/standard-adapter.js against the   │
 * │  new schema: member_master, member_access, member_access_sources (new   │
 * │  shape with access_id FK), member_billing.                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

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
  log: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  },
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

// Prevent Resend from loading in tests — _maybeFireFirstGrantEmail loads it lazily
jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID          = 'client-uuid-001';
const PLATFORM_MEMBER_ID = 'wix-member-abc';
const PLAN_MAPPING_ID    = 'mapping-uuid-001';
const MEMBER_MASTER_ID   = 'master-uuid-001';
const MEMBER_ACCESS_ID   = 'access-uuid-001';
const BILLING_ID         = 'billing-uuid-001';
const HARDWARE_USER_ID   = '99001';

const standardEvent = {
  sourcePlatform:  'wix',
  platformMemberId: PLATFORM_MEMBER_ID,
  planMappingId:   PLAN_MAPPING_ID,
};

// ─── Setup ──────────────────────────────────────────────────────────────────

const db             = require('../../db');
const adapter        = require('../../adapters/standard-adapter');

function makeDbClient(queryResponses) {
  let callIndex = 0;
  const mockQuery = jest.fn().mockImplementation(() => {
    const response = queryResponses[callIndex++] || { rows: [] };
    if (response instanceof Error) return Promise.reject(response);
    return Promise.resolve(response);
  });
  return {
    query:   mockQuery,
    release: jest.fn(),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Test 1 — resolveAndLock GRANT: UPSERT member_master then UPSERT/lock member_access
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] resolveAndLock GRANT — UPSERTs member_master then member_access', () => {
  it('executes BEGIN, UPSERT member_master, FOR UPDATE NOWAIT, UPSERT member_access, COMMIT — returns memberId', async () => {
    const dbClient = makeDbClient([
      { rows: [] },                                        // BEGIN
      { rows: [{ id: MEMBER_MASTER_ID }] },               // UPSERT member_master RETURNING id
      { rows: [] },                                        // SELECT … FOR UPDATE NOWAIT (no rows = not yet locked)
      { rows: [{ id: MEMBER_ACCESS_ID, hardware_user_id: null }] }, // UPSERT member_access RETURNING id, hardware_user_id
      { rows: [] },                                        // COMMIT
    ]);
    db.getClient.mockResolvedValue(dbClient);
    db.query.mockResolvedValue({ rows: [] }); // _incrementActivity

    // 4th arg (planMappingId) added 2026-05-11 — was previously read from event.planMappingId
    // (which was always undefined) and is now passed explicitly by queue-worker.
    const result = await adapter.resolveAndLock(TENANT_ID, standardEvent, 'kisi', PLAN_MAPPING_ID);

    expect(result).toEqual({ memberId: MEMBER_ACCESS_ID });

    const calls = dbClient.query.mock.calls;
    expect(calls[0][0]).toBe('BEGIN');

    // Step 1: UPSERT member_master
    expect(calls[1][0]).toContain('INSERT INTO member_master');
    expect(calls[1][0]).toContain('ON CONFLICT');
    expect(calls[1][1]).toEqual([TENANT_ID, 'wix', PLATFORM_MEMBER_ID, null, null]);

    // Step 2: FOR UPDATE NOWAIT — S-11/DR-046 lock scope is per-(person × client)
    expect(calls[2][0]).toContain('FOR UPDATE NOWAIT');
    expect(calls[2][0]).toContain('member_access');
    expect(calls[2][0]).toContain('client_id');
    expect(calls[2][1]).toEqual([MEMBER_MASTER_ID, TENANT_ID]);

    // Step 3: UPSERT member_access with status='in_flight' (no plan_mapping_id post-S-11)
    expect(calls[3][0]).toContain('INSERT INTO member_access');
    expect(calls[3][0]).toContain("'in_flight'");
    expect(calls[3][0]).toContain('ON CONFLICT (member_master_id, client_id)');
    expect(calls[3][0]).not.toContain('plan_mapping_id');
    expect(calls[3][1]).toContain(MEMBER_MASTER_ID);
    expect(calls[3][1]).toContain(TENANT_ID);

    expect(calls[4][0]).toBe('COMMIT');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 2 — resolveAndLock REVOKE: SELECT from member_access, returns hardwareUserId
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] resolveAndLock REVOKE — SELECTs member_access via member_master JOIN', () => {
  it('returns memberId + hardwareUserId from member_access JOIN member_master', async () => {
    const dbClient = makeDbClient([
      { rows: [] }, // BEGIN
      { rows: [{ id: MEMBER_ACCESS_ID, hardware_user_id: HARDWARE_USER_ID, hardware_platform: 'kisi', status: 'active' }] }, // SELECT member_access JOIN member_master
      { rows: [] }, // SELECT … FOR UPDATE NOWAIT
      { rows: [] }, // UPDATE status='in_flight'
      { rows: [{ role_assignment_id: 'ra-001' }] }, // SELECT role_assignment_id FROM member_access_sources
      { rows: [] }, // COMMIT
    ]);
    db.getClient.mockResolvedValue(dbClient);
    db.query.mockResolvedValue({ rows: [] }); // _incrementActivity

    const result = await adapter.resolveAndLock(TENANT_ID, standardEvent, null, null);

    expect(result.memberId).toBe(MEMBER_ACCESS_ID);
    expect(result.hardwareUserId).toBe(HARDWARE_USER_ID);
    expect(result.roleAssignmentIds).toEqual(['ra-001']);

    const calls = dbClient.query.mock.calls;
    const selectCall = calls[1];
    expect(selectCall[0]).toContain('FROM member_access ma');
    expect(selectCall[0]).toContain('JOIN member_master mm');
    expect(selectCall[0]).not.toContain('member_identity');
    expect(selectCall[0]).not.toContain('member_access_state');

    const sourcesCall = calls[4];
    expect(sourcesCall[0]).toContain('FROM member_access_sources');
    expect(sourcesCall[0]).toContain('access_id');
    expect(sourcesCall[0]).not.toContain('member_id');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 3 — FOR UPDATE NOWAIT concurrency: 55P03 → IN_FLIGHT_LOCK error code
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] FOR UPDATE NOWAIT contention — Postgres 55P03 → IN_FLIGHT_LOCK thrown', () => {
  it('throws error with code IN_FLIGHT_LOCK when Postgres returns 55P03', async () => {
    const lockError = new Error('could not obtain lock on row in relation "member_access"');
    lockError.code = '55P03';

    const dbClient = makeDbClient([
      { rows: [] },                          // BEGIN
      { rows: [{ id: MEMBER_MASTER_ID }] }, // UPSERT member_master
      lockError,                             // FOR UPDATE NOWAIT — throws 55P03
    ]);
    // Provide ROLLBACK response for the catch block
    dbClient.query.mockImplementationOnce(() => Promise.resolve({ rows: [] }))   // BEGIN
      .mockImplementationOnce(() => Promise.resolve({ rows: [{ id: MEMBER_MASTER_ID }] })) // UPSERT member_master
      .mockImplementationOnce(() => Promise.reject(lockError))                   // FOR UPDATE NOWAIT
      .mockImplementationOnce(() => Promise.resolve({ rows: [] }));              // ROLLBACK
    db.getClient.mockResolvedValue(dbClient);

    await expect(
      adapter.resolveAndLock(TENANT_ID, standardEvent, 'kisi', PLAN_MAPPING_ID)
    ).rejects.toMatchObject({ code: 'IN_FLIGHT_LOCK' });
  });

  it('does NOT throw IN_FLIGHT_LOCK for unrelated Postgres errors (e.g. 23505)', async () => {
    const otherError = new Error('duplicate key value violates unique constraint');
    otherError.code = '23505';

    db.getClient.mockResolvedValue({
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })                                // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: MEMBER_MASTER_ID }] })       // UPSERT member_master
        .mockRejectedValueOnce(otherError)                                  // FOR UPDATE NOWAIT
        .mockResolvedValueOnce({ rows: [] }),                               // ROLLBACK
      release: jest.fn(),
    });

    await expect(
      adapter.resolveAndLock(TENANT_ID, standardEvent, 'kisi', PLAN_MAPPING_ID)
    ).rejects.toMatchObject({ code: '23505' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 4 — completeGrant: INSERT to restructured member_access_sources + UPDATE member_access
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] completeGrant — INSERTs to member_access_sources (access_id FK), UPDATEs member_access', () => {
  it('inserts member_billing, inserts member_access_sources with access_id FK, updates member_access.status=active', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // SELECT member_master_id
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] })                     // INSERT member_billing
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access status=active
      .mockResolvedValue({ rows: [] });                                           // _incrementActivity + _maybeFireFirstGrantEmail

    const assignments = [{
      mappingId:       PLAN_MAPPING_ID,
      roleAssignmentId: 'ra-001',
      hardwareGroupId: 'hg-001',
      sourcePlanId:    'plan-001',
      sourceType:      'plan',
      planEndDate:     null,
      wixOrderId:      'wix-order-001',
      wixSubscriptionId: 'sub-001',
      cycleIndex:      1,
      planId:          'plan-001',
      planName:        'Basic',
      effectiveStart:  null,
      effectiveEnd:    null,
      billingSnapshot: null,
    }];

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, assignments);

    const calls = db.query.mock.calls;

    // Step 1: resolve member_master_id (SELECT widened with diagnostic columns)
    expect(calls[0][0]).toContain('FROM member_access');
    expect(calls[0][0]).toContain('member_master_id');
    expect(calls[0][1]).toEqual([MEMBER_ACCESS_ID]);

    // Step 2: INSERT member_billing — S-11/A10: UNIQUE includes client_id.
    // Uses DO UPDATE with COALESCE so retries fill in fields that were null on
    // first write (snapshot backfill via second webhook arrival or reconcile).
    expect(calls[1][0]).toContain('INSERT INTO member_billing');
    expect(calls[1][0]).toContain('ON CONFLICT (client_id, wix_order_id, cycle_index) DO UPDATE');
    expect(calls[1][0]).toContain('COALESCE(EXCLUDED.billing_snapshot');
    expect(calls[1][1]).toContain(MEMBER_MASTER_ID);

    // Step 3: INSERT member_access_sources — S-11/A9: client_id NOT NULL, status='active'
    expect(calls[2][0]).toContain('INSERT INTO member_access_sources');
    expect(calls[2][0]).toContain('client_id');
    expect(calls[2][0]).toContain('access_id');
    expect(calls[2][0]).not.toContain(' member_id ');
    // Param order: client_id=$1, access_id=$2, ...
    expect(calls[2][1][0]).toBe(TENANT_ID);
    expect(calls[2][1][1]).toBe(MEMBER_ACCESS_ID);

    // Step 4: UPDATE member_access — S-11/DR-046 status is source-aggregate rollup
    expect(calls[3][0]).toContain('UPDATE member_access');
    expect(calls[3][0]).toContain('CASE');
    expect(calls[3][0]).toContain("'active'");
    expect(calls[3][0]).toContain("'inactive'");
    expect(calls[3][0]).not.toContain('member_access_state');
    expect(calls[3][1][0]).toBe(MEMBER_ACCESS_ID);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5 — completeGrant RI-03: valid_until written from planEndDate
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] completeGrant RI-03 — valid_until written to member_access_sources from planEndDate', () => {
  it('passes planEndDate as valid_until in the member_access_sources INSERT', async () => {
    const planEndDate = '2026-12-31T23:59:59.000Z';

    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // SELECT member_master_id
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] })                     // INSERT member_billing
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [{
      mappingId:       PLAN_MAPPING_ID,
      roleAssignmentId: 'ra-002',
      hardwareGroupId: 'hg-001',
      sourcePlanId:    'plan-001',
      sourceType:      'plan',
      planEndDate,
      wixOrderId:      'wix-order-002',
      wixSubscriptionId: null,
      cycleIndex:      1,
      planId:          null,
      planName:        null,
      effectiveStart:  null,
      effectiveEnd:    null,
      billingSnapshot: null,
    }]);

    const masInsertCall = db.query.mock.calls[2];
    expect(masInsertCall[0]).toContain('valid_until');
    // valid_until is $8 in the INSERT — verify the value passed is the planEndDate
    const params = masInsertCall[1];
    expect(params).toContain(planEndDate);
    // Also verify it's NOT going into billingSnapshot JSONB
    const billingCall = db.query.mock.calls[1];
    const billingParams = billingCall[1];
    const billingSnapshotParam = billingParams[billingParams.length - 1];
    expect(JSON.stringify(billingSnapshotParam || '')).not.toContain('planEndDate');
  });

  it('passes null as valid_until when planEndDate is absent (permanent access)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [{
      mappingId: PLAN_MAPPING_ID, roleAssignmentId: 'ra-003',
      hardwareGroupId: 'hg-001', sourcePlanId: 'plan-001', sourceType: 'plan',
      planEndDate: null,
      wixOrderId: 'wix-order-003', wixSubscriptionId: null,
      cycleIndex: 1, planId: null, planName: null,
      effectiveStart: null, effectiveEnd: null, billingSnapshot: null,
    }]);

    const masParams = db.query.mock.calls[2][1];
    const validUntilValue = masParams[masParams.length - 1]; // $8 is last
    expect(validUntilValue).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5b — completeGrant: sharedBillingSnapshot (4th arg) is written to
//           member_billing.billing_snapshot when assignment doesn't carry one.
// Regression for "snapshot silently dropped" bug — caller extracted the snapshot
// from webhook payload but it never reached the DB because completeGrant
// originally only accepted 3 params.
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] completeGrant — sharedBillingSnapshot reaches member_billing.billing_snapshot', () => {
  it('writes the 4th-arg snapshot to billing_snapshot when assignment.billingSnapshot is null', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    const sharedSnapshot = {
      planPrice: '30', cycleUnit: 'MONTH', cycleCount: 1,
      currency: 'USD', total: '0.00', subtotal: '30.00', discount: '30.00',
      coupon: { code: 'DAXXADMIN', amount: '30.00' },
      autoRenewCanceled: false, lastPaymentStatus: 'PAID',
      subscriptionId: 'sub-shared', orderMethod: 'UNKNOWN',
      orderId: 'wix-order-shared', capturedAt: '2026-05-26T15:00:00.000Z',
    };

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [{
      mappingId: PLAN_MAPPING_ID, roleAssignmentId: 'ra-shared',
      hardwareGroupId: 'hg-001', sourcePlanId: 'plan-shared', sourceType: 'plan',
      planEndDate: null,
      wixOrderId: 'wix-order-shared', wixSubscriptionId: 'sub-shared',
      cycleIndex: 1, planId: null, planName: 'First Responder',
      effectiveStart: null, effectiveEnd: null, billingSnapshot: null,
    }], sharedSnapshot);

    const billingParams = db.query.mock.calls[1][1];
    const snapshotParam = billingParams[billingParams.length - 1];
    expect(snapshotParam).not.toBeNull();
    expect(JSON.parse(snapshotParam)).toMatchObject({ coupon: { code: 'DAXXADMIN' }, planPrice: '30' });
  });

  it('per-assignment billingSnapshot wins over sharedBillingSnapshot when both present', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValue({ rows: [] });

    const sharedSnapshot     = { planPrice: '30', orderId: 'shared',  capturedAt: 'shared-ts'  };
    const perAssignSnapshot  = { planPrice: '99', orderId: 'per-row', capturedAt: 'per-row-ts' };

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [{
      mappingId: PLAN_MAPPING_ID, roleAssignmentId: 'ra-mix',
      hardwareGroupId: 'hg-001', sourcePlanId: 'plan-x', sourceType: 'plan',
      planEndDate: null,
      wixOrderId: 'wix-order-mix', wixSubscriptionId: null,
      cycleIndex: 1, planId: null, planName: null,
      effectiveStart: null, effectiveEnd: null,
      billingSnapshot: perAssignSnapshot,
    }], sharedSnapshot);

    const billingParams = db.query.mock.calls[1][1];
    const snapshotParam = billingParams[billingParams.length - 1];
    expect(JSON.parse(snapshotParam).orderId).toBe('per-row');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6 — completeRevoke: DELETE member_access_sources, UPDATE member_access
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] completeRevoke — DELETEs from member_access_sources, UPDATEs member_access.status', () => {
  it('DELETEs from member_access_sources WHERE access_id, then rolls up access status', async () => {
    const dbClient = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // DELETE member_access_sources
        .mockResolvedValueOnce({ rows: [] }) // UPDATE member_access (rollup)
        .mockResolvedValueOnce({ rows: [] }),// COMMIT
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(dbClient);
    db.query.mockResolvedValue({ rows: [] }); // _incrementActivity

    await adapter.completeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'revoked', {});

    const calls = dbClient.query.mock.calls;
    const deleteCall = calls[1];
    expect(deleteCall[0]).toContain('DELETE FROM member_access_sources');
    expect(deleteCall[0]).toContain('access_id');
    expect(deleteCall[0]).not.toContain(' member_id ');
    expect(deleteCall[1][0]).toBe(MEMBER_ACCESS_ID);

    // S-11: access status is now source-aggregate rollup, not a literal value.
    const updateCall = calls[2];
    expect(updateCall[0]).toContain('UPDATE member_access');
    expect(updateCall[0]).toContain('CASE');
    expect(updateCall[0]).toContain("'active'");
    expect(updateCall[0]).toContain("'inactive'");
    expect(updateCall[0]).not.toContain('member_access_state');
    expect(updateCall[1]).toEqual([MEMBER_ACCESS_ID]);
  });

  // INCIDENT 2026-07-02 regression guard: targetStatus='inactive' (what queue-worker.js
  // passes for every plan.cancelled/booking.cancelled revoke) must NOT blanket-delete
  // member_access_sources. grant-revoke.js's processRevoke() already deletes the
  // correctly-scoped row(s) for the specific plan before completeRevoke runs — a
  // second unscoped delete here wipes every OTHER active plan on the same access_id
  // too. This exact bug shipped and deleted all 5 plans on a real multi-plan account
  // when only one was meant to be left. Only the status rollup should run.
  it("targetStatus='inactive' does NOT delete member_access_sources — relies on processRevoke's per-plan scoping", async () => {
    const dbClient = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // UPDATE member_access (rollup) — the only query besides BEGIN/COMMIT
        .mockResolvedValueOnce({ rows: [] }),// COMMIT
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(dbClient);
    db.query.mockResolvedValue({ rows: [] }); // _incrementActivity

    await adapter.completeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'inactive');

    const calls = dbClient.query.mock.calls;
    // BEGIN, rollup UPDATE, COMMIT — exactly 3 calls. No DELETE.
    expect(calls).toHaveLength(3);
    expect(calls.some(c => c[0].includes('DELETE FROM member_access_sources'))).toBe(false);

    const updateCall = calls[1];
    expect(updateCall[0]).toContain('UPDATE member_access');
    expect(updateCall[0]).toContain('CASE');
    expect(updateCall[1]).toEqual([MEMBER_ACCESS_ID]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6b — finalizeRevoke: safety guard for multi-plan holders (INCIDENT 2026-07-02 follow-up)
// ════════════════════════════════════════════════════════════════════════════
// BOT review (STRATA): pressure-test the actual reported shape — a holder with 5 active
// plans on one access_id, one of them revoked. completeRevoke's rollup (tested above) leaves
// member_access.status = 'active' because 4 sources are still active. queue-worker.js calls
// finalizeRevoke() unconditionally whenever processRevoke returns targetStatus='inactive' —
// regardless of how many other plans the member holds — so finalizeRevoke's own fresh status
// re-check is the ONLY thing standing between a single-plan cancellation and deleting the
// member's entire Kisi user account. This locks that guard in explicitly rather than relying
// on inference.
describe('[P1] finalizeRevoke — bails out when other plans keep the member active (multi-plan safety)', () => {
  it('holder with 4 remaining active plans: returns access_still_active and does not call deleteUser', async () => {
    const hardwareAdapter = require('../../adapters/hardware-adapter');

    // Reflects the post-rollup state: member_access.status was recomputed to 'active' because
    // 4 of the original 5 member_access_sources rows are still active (source_tag intact).
    db.query.mockResolvedValueOnce({
      rows: [{ status: 'active', hardware_user_id: HARDWARE_USER_ID, member_master_id: MEMBER_MASTER_ID, source_tag: 'accesssync' }],
    });

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', 'decrypted-key', HARDWARE_USER_ID);

    expect(result).toEqual({ finalized: false, reason: 'access_still_active' });
    expect(hardwareAdapter.deleteUser).not.toHaveBeenCalled();
    // Only the status re-check query should have run — no DB finalize transaction opened.
    expect(db.getClient).not.toHaveBeenCalled();
  });

  it('holder with zero remaining active plans (true single-plan cancellation): proceeds to delete', async () => {
    const hardwareAdapter = require('../../adapters/hardware-adapter');
    hardwareAdapter.deleteUser.mockResolvedValueOnce(undefined);

    db.query
      .mockResolvedValueOnce({
        rows: [{ status: 'inactive', hardware_user_id: HARDWARE_USER_ID, member_master_id: MEMBER_MASTER_ID, source_tag: 'accesssync' }],
      });
    const dbClient = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    };
    db.getClient.mockResolvedValue(dbClient);

    const result = await adapter.finalizeRevoke(MEMBER_ACCESS_ID, TENANT_ID, 'kisi', 'decrypted-key', HARDWARE_USER_ID);

    expect(hardwareAdapter.deleteUser).toHaveBeenCalledWith('kisi', 'decrypted-key', HARDWARE_USER_ID, { clientId: TENANT_ID });
    expect(result.finalized).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 7 — releaseLock: UPDATE member_access.status='failed'
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] releaseLock — UPDATEs member_access.status (not member_access_state)', () => {
  it("translates legacy 'failed' to 'inactive' on member_access (S-11 enum collapse)", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await adapter.releaseLock(MEMBER_ACCESS_ID, TENANT_ID, 'failed');

    const updateCall = db.query.mock.calls[0];
    expect(updateCall[0]).toContain('UPDATE member_access');
    expect(updateCall[0]).not.toContain('member_access_state');
    // S-11/DR-046: 'failed' is no longer a valid access status. Translates to 'inactive'.
    // Per-plan failure lives on member_access_sources.status='failed'.
    expect(updateCall[1]).toEqual(['inactive', MEMBER_ACCESS_ID]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 8 — _parkPendingIdentity: UPDATE member_access.status='pending_identity'
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] _parkPendingIdentity — writes pending_identity to member_access', () => {
  it("updates member_access.status='pending_identity'", async () => {
    db.query.mockResolvedValue({ rows: [] });

    await adapter._parkPendingIdentity(MEMBER_ACCESS_ID, TENANT_ID, ['email']);

    const updateCall = db.query.mock.calls[0];
    expect(updateCall[0]).toContain('UPDATE member_access');
    expect(updateCall[0]).toContain("status = 'pending_identity'");
    expect(updateCall[0]).not.toContain('member_access_state');
    expect(updateCall[1]).toEqual([MEMBER_ACCESS_ID]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 9 — Gate 2 DB cache tier: SELECT from member_master.email, not member_identity
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] Gate 2 DB cache tier — reads email from member_master, not member_identity', () => {
  it('falls back to member_master.email when Wix API is unavailable', async () => {
    const hardwareAdapter = require('../../adapters/hardware-adapter');
    const invalidReqError = new Error('missing required fields');
    invalidReqError.code = 'INVALID_HARDWARE_REQUEST';
    invalidReqError.missingFields = ['email'];

    // DB query sequence for resolveIdentity:
    // 1. SELECT kisi_user_pattern FROM connector_subscriptions
    // 2. SELECT hardware_user_id FROM member_access (cache miss)
    // --- Gate 2 recovery triggers ---
    // 3. SELECT source_api_key, source_site_id FROM clients (Tier 1 setup — no API key found)
    // 4. SELECT member_master_id FROM member_access (Tier 2 step 1)
    // 5. SELECT email … FROM member_master (Tier 2 step 2 — returns email)
    // 6. UPDATE member_access SET hardware_user_id (cache write)
    db.query
      .mockResolvedValueOnce({ rows: [{ kisi_user_pattern: 'invited' }] })          // 1
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })                 // 2 — cache miss
      .mockResolvedValueOnce({ rows: [{ source_api_key: null, source_site_id: null }] }) // 3 — Tier 1 skipped
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] })     // 4
      .mockResolvedValueOnce({ rows: [{ email: 'member@gym.com', display_name: 'Alex', first_name: null, last_name: null }] }) // 5
      .mockResolvedValueOnce({ rows: [] });                                           // 6 — cache write

    hardwareAdapter.findUserByEmail
      .mockRejectedValueOnce(invalidReqError)           // first call — triggers Gate 2
      .mockResolvedValueOnce(HARDWARE_USER_ID);         // second call after recovery

    const result = await adapter.resolveIdentity(
      MEMBER_ACCESS_ID, '', '', 'kisi', 'api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    expect(result).toBe(HARDWARE_USER_ID);

    // Confirm Tier 2 read targeted member_master (not member_identity)
    const tier2EmailCall = db.query.mock.calls[4];
    expect(tier2EmailCall[0]).toContain('FROM member_master');
    expect(tier2EmailCall[0]).not.toContain('member_identity');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10 — _maybeFireFirstGrantEmail: regression guard — still reads clients.first_grant_sent
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] _maybeFireFirstGrantEmail — regression guard: still reads clients.first_grant_sent', () => {
  it('reads clients.first_grant_sent and clients.notification_email — unchanged from prior schema', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // UPDATE clients returns 0 rows (already sent)

    await adapter._maybeFireFirstGrantEmail(TENANT_ID, MEMBER_ACCESS_ID);

    const call = db.query.mock.calls[0];
    expect(call[0]).toContain('clients');
    expect(call[0]).toContain('first_grant_sent');
    expect(call[0]).toContain('notification_email');
    expect(call[1]).toEqual([TENANT_ID]);
  });

  it('sends email when first_grant_sent was false (UPDATE returns 1 row)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ name: 'House of Gains', notification_email: 'chad@hog.com' }],
    });
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'alerts@accesssync.io';

    await adapter._maybeFireFirstGrantEmail(TENANT_ID, MEMBER_ACCESS_ID);

    const call = db.query.mock.calls[0];
    expect(call[0]).toContain('first_grant_sent = false');
    // No throw = success
  });
});
