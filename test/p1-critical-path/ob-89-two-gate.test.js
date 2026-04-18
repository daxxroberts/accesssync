/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: OB-89 two-gate qualified-request design                      │
 * │                                                                         │
 * │  Business consequence: Before this design, a grant job with null email  │
 * │  (e.g. from reconciliation where Wix listOrders doesn't include email)  │
 * │  would call Kisi's createUser with nulls and get a 422 with a generic   │
 * │  error message. The member would dead-letter as 'failed' with no        │
 * │  attempt to recover.                                                    │
 * │                                                                         │
 * │  After the two-gate design:                                             │
 * │    Gate 1 (Layer 5) refuses to call Kisi with missing required fields.  │
 * │    Gate 2 (Layer 3) catches Gate 1's error, runs a recovery ladder      │
 * │      (Wix Members API → DB cache → park pending_identity), and          │
 * │      retries with recovered data.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-members-api', () => ({
  getMemberById: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `plaintext-${enc}`),
}));

jest.mock('../../adapters/kisi/kisi-adapter', () => ({
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
  suspendAccess:   jest.fn(),
  enableAccess:    jest.fn(),
  deleteUser:      jest.fn(),
}));

jest.mock('../../adapters/seam/seam-adapter', () => ({}));

const db              = require('../../db');
const wixMembersApi   = require('../../adapters/wix/wix-members-api');
const kisiAdapter     = require('../../adapters/kisi/kisi-adapter');
const hardwareAdapter = require('../../adapters/hardware-adapter');

// Require after mocks are wired so StandardAdapter picks up the mocked hardware-adapter.
const standardAdapter = require('../../adapters/standard-adapter');

const MEMBER_ID            = 'member-internal-uuid-001';
const TENANT_ID            = 'client-hog-001';
const PLATFORM_MEMBER_ID   = 'wix-member-external-abc';
const RECOVERED_EMAIL      = 'chad@houseofgains.com';
const RECOVERED_NAME       = 'Chad Owner';
const KISI_USER_ID         = 'kisi-user-99561847';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Gate 1 — Layer 5 Validator ─────────────────────────────────────────────

describe('[P1] Gate 1 — hardware adapter refuses calls with missing required fields', () => {

  test('createUser throws INVALID_HARDWARE_REQUEST when email is null', async () => {
    await expect(
      hardwareAdapter.createUser('kisi', 'api-key', null, 'Some Name')
    ).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      missingFields: ['email'],
      attemptedOperation: 'createUser',
      hardwarePlatform: 'kisi',
    });

    expect(kisiAdapter.createUser).not.toHaveBeenCalled();
  });

  test('createUser throws when email is empty string', async () => {
    await expect(
      hardwareAdapter.createUser('kisi', 'api-key', '   ', 'Name')
    ).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      missingFields: ['email'],
    });
    expect(kisiAdapter.createUser).not.toHaveBeenCalled();
  });

  test('findUserByEmail throws when email is null', async () => {
    await expect(
      hardwareAdapter.findUserByEmail('kisi', 'api-key', null)
    ).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      missingFields: ['email'],
    });
    expect(kisiAdapter.findUserByEmail).not.toHaveBeenCalled();
  });

  test('assignRole throws when groupId is missing', async () => {
    await expect(
      hardwareAdapter.assignRole('kisi', 'api-key', KISI_USER_ID, null)
    ).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      missingFields: ['groupId'],
      attemptedOperation: 'assignRole',
    });
    expect(kisiAdapter.assignRole).not.toHaveBeenCalled();
  });

  test('createUser passes through when both fields present', async () => {
    kisiAdapter.createUser.mockResolvedValue({ id: KISI_USER_ID });
    await hardwareAdapter.createUser('kisi', 'api-key', RECOVERED_EMAIL, RECOVERED_NAME);
    expect(kisiAdapter.createUser).toHaveBeenCalledWith('api-key', RECOVERED_EMAIL, RECOVERED_NAME);
  });
});

// ─── Gate 2 — Layer 3 Recovery Orchestrator ─────────────────────────────────

describe('[P1] Gate 2 — standard adapter recovers missing email via Wix Members API', () => {

  test('recovers email from Wix Members API and retries createUser', async () => {
    // Arrange: cache miss, Wix Members API returns valid email, retry succeeds.
    db.query
      // member_identity cache lookup — no hardware_user_id yet
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })
      // clients lookup for wix api key + site id
      .mockResolvedValueOnce({ rows: [{ source_api_key: 'enc-wix-key', source_site_id: 'site-123' }] })
      // member_identity UPDATE to cache the new hardware_user_id
      .mockResolvedValueOnce({ rowCount: 1 });

    wixMembersApi.getMemberById.mockResolvedValue({
      memberId:  PLATFORM_MEMBER_ID,
      email:     RECOVERED_EMAIL,
      firstName: 'Chad',
      lastName:  'Owner',
      name:      RECOVERED_NAME,
      status:    'ACTIVE',
    });
    kisiAdapter.findUserByEmail.mockResolvedValue(null); // not found — new user
    // NB: mocking kisi-adapter directly, so return the raw ID (real kisi-adapter does data.id unwrap itself).
    kisiAdapter.createUser.mockResolvedValue(KISI_USER_ID);

    // Act
    const hardwareUserId = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    // Assert
    expect(hardwareUserId).toBe(String(KISI_USER_ID));
    expect(wixMembersApi.getMemberById).toHaveBeenCalledWith('plaintext-enc-wix-key', 'site-123', PLATFORM_MEMBER_ID);
    expect(kisiAdapter.createUser).toHaveBeenCalledWith('kisi-api-key', RECOVERED_EMAIL, RECOVERED_NAME);
  });

  test('parks as pending_identity when Wix Members API returns null email AND DB cache empty', async () => {
    db.query
      // member_identity cache lookup
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })
      // clients lookup
      .mockResolvedValueOnce({ rows: [{ source_api_key: 'enc-wix-key', source_site_id: 'site-123' }] })
      // Tier 2 DB cache — no email stored on member_identity either
      .mockResolvedValueOnce({ rows: [{ email: null, display_name: null, first_name: null, last_name: null }] })
      // _parkPendingIdentity UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    // Wix returns a member object with no email (rare — social login fallback)
    wixMembersApi.getMemberById.mockResolvedValue({
      memberId:  PLATFORM_MEMBER_ID,
      email:     null,
      firstName: null,
      lastName:  null,
      name:      null,
      status:    'ACTIVE',
    });

    // Act
    const result = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    // Assert: returns null (parked), never called Kisi
    expect(result).toBeNull();
    expect(kisiAdapter.findUserByEmail).not.toHaveBeenCalled();
    expect(kisiAdapter.createUser).not.toHaveBeenCalled();
    // Verify _parkPendingIdentity UPDATE was the last DB call
    const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
    expect(lastCall[0]).toMatch(/UPDATE member_access_state/);
    expect(lastCall[0]).toMatch(/pending_identity/);
    expect(lastCall[1]).toEqual([MEMBER_ID]);
  });

  test('falls back to DB cache when Wix Members API throws', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })
      // clients lookup succeeds
      .mockResolvedValueOnce({ rows: [{ source_api_key: 'enc-wix-key', source_site_id: 'site-123' }] })
      // DB cache DOES have email from prior event
      .mockResolvedValueOnce({ rows: [{
        email: RECOVERED_EMAIL, display_name: RECOVERED_NAME,
        first_name: 'Chad', last_name: 'Owner',
      }] })
      // member_identity UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    const wixErr = new Error('Wix Members API 500: transient');
    wixErr.statusCode = 500;
    wixMembersApi.getMemberById.mockRejectedValue(wixErr);

    kisiAdapter.findUserByEmail.mockResolvedValue(null);
    kisiAdapter.createUser.mockResolvedValue(KISI_USER_ID);

    const hardwareUserId = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    expect(hardwareUserId).toBe(String(KISI_USER_ID));
    expect(kisiAdapter.createUser).toHaveBeenCalledWith('kisi-api-key', RECOVERED_EMAIL, RECOVERED_NAME);
  });

  test('parks pending_identity when tenantId missing (cannot call Wix Members API)', async () => {
    db.query
      // member_identity cache lookup
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })
      // _parkPendingIdentity UPDATE
      .mockResolvedValueOnce({ rowCount: 1 });

    // Without tenantId/platformMemberId, Gate 2's recovery function short-circuits
    // (returns null immediately) and resolveIdentity parks the member.
    const result = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key', {}
    );

    expect(result).toBeNull();
    expect(wixMembersApi.getMemberById).not.toHaveBeenCalled();
    expect(kisiAdapter.createUser).not.toHaveBeenCalled();
    // Verify _parkPendingIdentity UPDATE was called
    const lastCall = db.query.mock.calls[db.query.mock.calls.length - 1];
    expect(lastCall[0]).toMatch(/UPDATE member_access_state/);
    expect(lastCall[0]).toMatch(/pending_identity/);
  });
});

// ─── Follow-up guardrails (standards-register-and-guardrails branch) ────────

describe('[P1] Gate 2 — _parkPendingIdentity releases the in_flight lock via status change', () => {

  test('the park UPDATE transitions status out of in_flight to pending_identity', async () => {
    // DR-011/DR-023: the "in_flight lock" is a sentinel value in the status column,
    // not a separate boolean column. Setting status='pending_identity' IS the release.
    // Regression guard: the park UPDATE must write status='pending_identity' and must
    // NOT reference a non-existent `in_flight` column (production schema has no such
    // column; an earlier OB-89 commit incorrectly wrote `in_flight = FALSE`).
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })           // cache miss
      .mockResolvedValueOnce({ rows: [{ source_api_key: null, source_site_id: null }] }) // no Wix key
      .mockResolvedValueOnce({ rows: [{ email: null, display_name: null, first_name: null, last_name: null }] }) // DB cache empty
      .mockResolvedValueOnce({ rowCount: 1 });                                  // park UPDATE

    const result = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    expect(result).toBeNull();
    const parkCall = db.query.mock.calls[db.query.mock.calls.length - 1];
    const parkSql  = parkCall[0];
    expect(parkSql).toMatch(/UPDATE member_access_state/);
    expect(parkSql).toMatch(/status\s*=\s*'pending_identity'/);
    // Must NOT reference a non-existent in_flight column (schema sentinel).
    expect(parkSql).not.toMatch(/\bin_flight\s*=/);
  });
});

describe('[P1] Gate 2 — synthetic @users.wix.com emails are rejected as unqualified', () => {

  test('Wix Members API returning a @users.wix.com email → Gate 2 falls through to DB cache', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ hardware_user_id: null }] })            // cache miss
      .mockResolvedValueOnce({ rows: [{ source_api_key: 'enc-wix-key', source_site_id: 'site-123' }] })
      // DB cache has a real email from a prior event
      .mockResolvedValueOnce({ rows: [{
        email: 'chad@houseofgains.com', display_name: 'Chad Owner',
        first_name: 'Chad', last_name: 'Owner',
      }] })
      .mockResolvedValueOnce({ rowCount: 1 });                                  // member_identity UPDATE

    // Wix Members API returns a synthetic address — wix-members-api.js normalises it
    // to null before returning. Gate 2 tier 1 returns null email → falls to Tier 2 DB cache.
    wixMembersApi.getMemberById.mockResolvedValue({
      memberId:  PLATFORM_MEMBER_ID,
      email:     null,                      // ← synthetic was rejected upstream in wix-members-api
      firstName: null,
      lastName:  null,
      name:      null,
      status:    'ACTIVE',
    });
    kisiAdapter.findUserByEmail.mockResolvedValue(null);
    kisiAdapter.createUser.mockResolvedValue(KISI_USER_ID);

    const hardwareUserId = await standardAdapter.resolveIdentity(
      MEMBER_ID, null, null, 'kisi', 'kisi-api-key',
      { tenantId: TENANT_ID, platformMemberId: PLATFORM_MEMBER_ID }
    );

    expect(hardwareUserId).toBe(String(KISI_USER_ID));
    expect(kisiAdapter.createUser).toHaveBeenCalledWith(
      'kisi-api-key', 'chad@houseofgains.com', 'Chad Owner'
    );
  });
});
