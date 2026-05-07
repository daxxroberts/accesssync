/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                      │
 * │  Scenario: Plan mapping resolver returns correct hardware groups        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `decrypted-${enc}`),
  encryptApiKey: jest.fn(),
}));

const db = require('../../db');
const { decryptApiKey } = require('../../core/crypto-utils');
const planMappingResolver = require('../../core/plan-mapping-resolver');

const {
  HOG_CLIENT_ID,
  CONNECT_PLAN_ID,
  KISI_GROUP_ID,
  ENCRYPTED_API_KEY_DB_VALUE,
} = require('../helpers/fixtures');

// ─── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Helper: build a mock DB row as returned by the big JOIN query ──────────

function mockMappingRow(overrides = {}) {
  return {
    id:                   'plan-mapping-001',
    hardware_group_id:    KISI_GROUP_ID,
    tier_name:            'Connect',
    access_type:          'group',
    hardware_platform:    'kisi',
    hardware_api_key_enc: ENCRYPTED_API_KEY_DB_VALUE,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('[P2] Plan mapping resolver returns correct hardware groups for a purchased plan', () => {

  it('returns the mapped hardware group when a single active mapping exists', async () => {
    db.query.mockResolvedValueOnce({
      rows: [mockMappingRow()],
    });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      mappingId:        'plan-mapping-001',
      hardwareGroupId:  KISI_GROUP_ID,
      hardwarePlatform: 'kisi',
      tierName:         'Connect',
      accessType:       'group',
    });
  });

  it('decrypts the API key from the database — never returns encrypted ciphertext', async () => {
    db.query.mockResolvedValueOnce({
      rows: [mockMappingRow()],
    });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(decryptApiKey).toHaveBeenCalledWith(ENCRYPTED_API_KEY_DB_VALUE);
    expect(result[0].apiKey).toBe(`decrypted-${ENCRYPTED_API_KEY_DB_VALUE}`);
  });

  it('returns multiple groups when a plan maps to several doors (multi-group)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        mockMappingRow({ hardware_group_id: 'kisi-group-front-door' }),
        mockMappingRow({ hardware_group_id: 'kisi-group-gym-floor' }),
        mockMappingRow({ hardware_group_id: 'kisi-group-pool-area' }),
      ],
    });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result).toHaveLength(3);
    const groupIds = result.map(r => r.hardwareGroupId);
    expect(groupIds).toContain('kisi-group-front-door');
    expect(groupIds).toContain('kisi-group-gym-floor');
    expect(groupIds).toContain('kisi-group-pool-area');
  });

  it('returns apiKey as null when no hardware API key is configured — does not throw', async () => {
    db.query.mockResolvedValueOnce({
      rows: [mockMappingRow({ hardware_api_key_enc: null })],
    });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result[0].apiKey).toBeNull();
    expect(decryptApiKey).not.toHaveBeenCalled();
  });

});

describe('[P2] Plan mapping resolver handles missing and unmapped plans correctly', () => {

  it('returns null for a completely unknown plan — triggers PLAN_NOT_MAPPED error path', async () => {
    // Main query returns no rows
    db.query.mockResolvedValueOnce({ rows: [] });
    // planExists check also returns no rows
    db.query.mockResolvedValueOnce({ rows: [] });
    // config_alert_log INSERT (has .catch() chained)
    db.query.mockResolvedValueOnce({ rows: [] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, 'wix-plan-unknown-999');

    expect(result).toBeNull();
  });

  it('writes a config_alert_log entry when an unknown plan is encountered', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    db.query.mockResolvedValueOnce({ rows: [] });
    // Alert log insert
    db.query.mockResolvedValueOnce({ rows: [] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, 'wix-plan-unknown-999');

    const alertCall = db.query.mock.calls.find(
      call => call[0] && call[0].includes('config_alert_log')
    );
    expect(alertCall).toBeDefined();
    expect(alertCall[1]).toContain(HOG_CLIENT_ID);
    expect(alertCall[1]).toContain('wix-plan-unknown-999');
  });

  it('returns empty array when plan exists but has no hardware group mapped (Wix-first flow)', async () => {
    // Main query returns no rows (no groups mapped)
    db.query.mockResolvedValueOnce({ rows: [] });
    // planExists check returns a row — plan IS recognized
    db.query.mockResolvedValueOnce({ rows: [{ id: 'plan-mapping-001' }] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });

});

describe('[P2] Plan mapping resolver filters unhealthy groups (K-2 edge case)', () => {

  it('SQL query includes health_status = ok filter — dead groups excluded at the DB level', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockMappingRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toContain('health_status');
    expect(mainQuery).toContain("'ok'");
  });

  it('SQL query filters inactive subscription locations via billing_subscriptions (DR-027)', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockMappingRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toContain('billing_subscriptions');
    expect(mainQuery).toContain("'active'");
  });

});
