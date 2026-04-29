/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: DR-043 Kisi user pattern — invited vs managed                │
 * │                                                                         │
 * │  Business consequence: If send_emails is wrong, a paying member never   │
 * │  receives the Kisi invitation email and cannot download the app or      │
 * │  open doors. This is a silent failure — access appears provisioned in   │
 * │  our DB but the member is physically locked out.                        │
 * │                                                                         │
 * │  Critical path: resolveIdentity reads kisi_user_pattern from DB →       │
 * │  passes userPattern to hardwareAdapter.createUser → kisi-adapter sends  │
 * │  correct send_emails flag to Kisi API.                                  │
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

const EMAIL = 'daxx@houseofgains.com';
const NAME  = 'Daxx Roberts';

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no cached hardware_user_id
  db.query.mockImplementation((sql) => {
    if (/SELECT hardware_user_id/.test(sql)) {
      return Promise.resolve({ rows: [{ hardware_user_id: null }] });
    }
    if (/SELECT kisi_user_pattern/.test(sql)) {
      return Promise.resolve({ rows: [{ kisi_user_pattern: 'invited' }] });
    }
    if (/UPDATE member_identity/.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    return Promise.resolve({ rows: [] });
  });
  hardwareAdapter.findUserByEmail.mockResolvedValue(null);
  hardwareAdapter.createUser.mockResolvedValue(KISI_HARDWARE_USER_ID);
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P1] DR-043 Kisi user pattern — invite flag reaches hardware adapter', () => {

  it('passes userPattern=invited to createUser when tenant kisi_user_pattern is invited', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/SELECT kisi_user_pattern/.test(sql)) return Promise.resolve({ rows: [{ kisi_user_pattern: 'invited' }] });
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'invited' })
    );
  });

  it('passes userPattern=managed to createUser when tenant kisi_user_pattern is managed', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/SELECT kisi_user_pattern/.test(sql)) return Promise.resolve({ rows: [{ kisi_user_pattern: 'managed' }] });
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'managed' })
    );
  });

  it('defaults to invited when kisi_user_pattern DB row is missing (new tenant without column set)', async () => {
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/SELECT kisi_user_pattern/.test(sql)) return Promise.resolve({ rows: [] }); // no row
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'invited' })
    );
  });

  it('defaults to invited when tenantId is not provided (edge case — reconciliation direct call)', async () => {
    // No tenantId → DB lookup skipped → fallback to invited
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      {} // no tenantId
    );

    expect(hardwareAdapter.createUser).toHaveBeenCalledWith(
      'kisi', KISI_API_KEY_PLAINTEXT, EMAIL, NAME,
      expect.objectContaining({ userPattern: 'invited' })
    );
  });

  it('does not call createUser when user already exists in Kisi (cache hit — no invite sent)', async () => {
    // User already in Kisi — findUserByEmail returns an ID, createUser never called
    hardwareAdapter.findUserByEmail.mockResolvedValue(KISI_HARDWARE_USER_ID);
    db.query.mockImplementation((sql) => {
      if (/SELECT hardware_user_id/.test(sql)) return Promise.resolve({ rows: [{ hardware_user_id: null }] });
      if (/SELECT kisi_user_pattern/.test(sql)) return Promise.resolve({ rows: [{ kisi_user_pattern: 'invited' }] });
      if (/UPDATE member_identity/.test(sql)) return Promise.resolve({ rows: [] });
      return Promise.resolve({ rows: [] });
    });

    const result = await standardAdapter.resolveIdentity(
      MEMBER_INTERNAL_ID, EMAIL, NAME, 'kisi', KISI_API_KEY_PLAINTEXT,
      { tenantId: HOG_CLIENT_ID, platformMemberId: 'wix-member-abc' }
    );

    expect(hardwareAdapter.createUser).not.toHaveBeenCalled();
    expect(result).toBe(KISI_HARDWARE_USER_ID);
  });

});
