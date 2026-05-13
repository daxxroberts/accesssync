/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING / CONFIGURATION                                │
 * │  Scenario: DR-043 connector_subscriptions.kisi_user_pattern contract    │
 * │                                                                         │
 * │  Business consequence: If the column is absent or the default is wrong, │
 * │  new tenants onboarded after the migration will either throw on first   │
 * │  grant or silently create managed users who can't use the Kisi app.     │
 * │                                                                         │
 * │  What this tests: the standard-adapter pattern-read logic in isolation  │
 * │  — correct default, explicit override, DB failure fallback.             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const standardAdapter = require('../../adapters/standard-adapter');

const {
  HOG_CLIENT_ID,
  MEMBER_INTERNAL_ID,
  KISI_HARDWARE_USER_ID,
  KISI_API_KEY_PLAINTEXT,
} = require('../helpers/fixtures');

const EMAIL = 'member@test.com';
const NAME  = 'Test Member';

function mockDbForPattern(pattern) {
  db.query.mockImplementation((sql) => {
    if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
    if (/SELECT kisi_user_pattern/.test(sql)) {
      return pattern !== undefined
        ? Promise.resolve({ rows: [{ kisi_user_pattern: pattern }] })
        : Promise.resolve({ rows: [] });
    }
    if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  hardwareAdapter.findUserByEmail.mockResolvedValue(null);
  hardwareAdapter.createUser.mockResolvedValue(KISI_HARDWARE_USER_ID);
});

describe('[P2] DR-043 connector_subscriptions.kisi_user_pattern — standard-adapter reads it correctly', () => {

  it('reads kisi_user_pattern from connector_subscriptions for the correct tenantId', async () => {
    mockDbForPattern('invited');

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    const patternCall = db.query.mock.calls.find(([sql]) => /SELECT kisi_user_pattern/.test(sql));
    expect(patternCall).toBeDefined();
    expect(patternCall[1]).toEqual([HOG_CLIENT_ID]);
  });

  it('uses invited pattern when DB returns invited', async () => {
    mockDbForPattern('invited');

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'invited' })
    );
  });

  it('uses managed pattern when DB returns managed', async () => {
    mockDbForPattern('managed');

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'managed' })
    );
  });

  it('falls back to invited when DB pattern read throws (defensive — DB not yet migrated)', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/SELECT kisi_user_pattern/.test(sql)) return Promise.reject(new Error('column does not exist'));
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    // Must not throw — falls back to invited
    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'invited' })
    );
  });

  it('skips DB lookup when userPattern is explicitly provided in opts', async () => {
    // Direct override — useful for tests and admin re-provisioning flows
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc', userPattern: 'managed' }
    );

    const patternDbCall = db.query.mock.calls.find(([sql]) => /SELECT kisi_user_pattern/.test(sql));
    expect(patternDbCall).toBeUndefined();

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'managed' })
    );
  });

});
