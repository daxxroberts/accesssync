/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: Plan mapping resolver against new schema                     │
 * │                                                                         │
 * │  Replaces: plan-mapping-resolver.test.js (SKIPped in S-4, un-skip S-8) │
 * │                                                                         │
 * │  Tests the new-schema SQL shapes:                                       │
 * │    - connector_subscriptions JOIN for hardware API key + platform       │
 * │    - billing_subscriptions active filter (replaces subscription_status) │
 * │    - kisi_user_pattern returned from connector_subscriptions            │
 * │    - inactive billing_subscriptions → no mapping returned               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `decrypted-${enc}`),
  encryptApiKey: jest.fn(),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-s4-001'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
  setTraceContext: jest.fn(),
}));

const db                   = require('../../db');
const { decryptApiKey }    = require('../../core/crypto-utils');
const planMappingResolver  = require('../../core/plan-mapping-resolver');

const {
  HOG_CLIENT_ID,
  CONNECT_PLAN_ID,
  KISI_GROUP_ID,
  ENCRYPTED_API_KEY_DB_VALUE,
} = require('../helpers/fixtures');

const MAPPING_ID = 'plan-mapping-001';

function mockConnectorRow(overrides = {}) {
  return {
    id:                   MAPPING_ID,
    hardware_group_id:    KISI_GROUP_ID,
    tier_name:            'Connect',
    access_type:          'group',
    plan_name:            'Connect All Access',
    door_name:            'Main Entrance',
    hardware_platform:    'kisi',
    hardware_api_key_enc: ENCRYPTED_API_KEY_DB_VALUE,
    kisi_user_pattern:    null,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── connector_subscriptions replaces COALESCE from clients/locations ─────────

describe('[P2] plan-mapping-resolver — connector_subscriptions join (new schema)', () => {

  test('main query JOINs connector_subscriptions, not clients or locations for hardware key', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toMatch(/JOIN connector_subscriptions/);
    expect(mainQuery).not.toMatch(/COALESCE\(l\.hardware_api_key/);
    expect(mainQuery).not.toMatch(/JOIN clients c/);
  });

  test('returns hardware_platform from connector_subscriptions row', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow({ hardware_platform: 'kisi' })] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result[0].hardwarePlatform).toBe('kisi');
  });

  test('decrypts api key sourced from connector_subscriptions.hardware_api_key', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(decryptApiKey).toHaveBeenCalledWith(ENCRYPTED_API_KEY_DB_VALUE);
    expect(result[0].apiKey).toBe(`decrypted-${ENCRYPTED_API_KEY_DB_VALUE}`);
  });

  test('returns null apiKey when connector_subscriptions has no key configured', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow({ hardware_api_key_enc: null })] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result[0].apiKey).toBeNull();
    expect(decryptApiKey).not.toHaveBeenCalled();
  });

  test('returns kisi_user_pattern from connector_subscriptions', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow({ kisi_user_pattern: '{email}' })] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result[0].kisiUserPattern).toBe('{email}');
  });

  test('returns null kisi_user_pattern when not set on connector_subscriptions', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow({ kisi_user_pattern: null })] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result[0].kisiUserPattern).toBeNull();
  });
});

// ─── billing_subscriptions replaces subscription_status = 'active' ───────────

describe('[P2] plan-mapping-resolver — billing_subscriptions active filter (new schema)', () => {

  test('main query JOINs billing_subscriptions, not subscription_status on locations', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toMatch(/billing_subscriptions/);
    expect(mainQuery).not.toMatch(/subscription_status/);
  });

  test('billing_subscriptions JOIN uses status = active filter', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toMatch(/bs\.status\s*=\s*'active'/);
  });

  test('location filter uses bs.id IS NOT NULL, not subscription_status = active', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toMatch(/bs\.id IS NOT NULL/);
    expect(mainQuery).not.toMatch(/subscription_status\s*=\s*'active'/);
  });

  test('returns empty array (not null) when plan exists but no billing_subscriptions active row', async () => {
    // Main query returns empty (billing_subscriptions JOIN excluded the location)
    db.query.mockResolvedValueOnce({ rows: [] });
    // planExists check finds the plan mapping row
    db.query.mockResolvedValueOnce({ rows: [{ id: MAPPING_ID }] });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result).toEqual([]);
    expect(result).not.toBeNull();
  });
});

// ─── multi-group + happy path ─────────────────────────────────────────────────

describe('[P2] plan-mapping-resolver — multi-group mapping (new schema)', () => {

  test('returns one entry per active group row with correct shape', async () => {
    db.query.mockResolvedValueOnce({
      rows: [
        mockConnectorRow({ hardware_group_id: 'kisi-group-front' }),
        mockConnectorRow({ hardware_group_id: 'kisi-group-gym', id: 'plan-mapping-002' }),
      ],
    });

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    expect(result).toHaveLength(2);
    expect(result.map(r => r.hardwareGroupId)).toContain('kisi-group-front');
    expect(result.map(r => r.hardwareGroupId)).toContain('kisi-group-gym');
    expect(result[0]).toMatchObject({
      hardwarePlatform: 'kisi',
      tierName:         'Connect',
      accessType:       'group',
    });
  });

  test('health_status = ok filter still present in new schema query', async () => {
    db.query.mockResolvedValueOnce({ rows: [mockConnectorRow()] });

    await planMappingResolver.resolve(HOG_CLIENT_ID, CONNECT_PLAN_ID);

    const mainQuery = db.query.mock.calls[0][0];
    expect(mainQuery).toMatch(/health_status/);
    expect(mainQuery).toMatch(/'ok'/);
  });

  test('returns null for completely unknown plan — writes config_alert_log', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })        // main query
      .mockResolvedValueOnce({ rows: [] })        // planExists check
      .mockResolvedValueOnce({ rowCount: 1 });    // config_alert_log INSERT

    const result = await planMappingResolver.resolve(HOG_CLIENT_ID, 'wix-plan-unknown-999');

    expect(result).toBeNull();

    const alertCall = db.query.mock.calls.find(
      c => typeof c[0] === 'string' && c[0].includes('config_alert_log')
    );
    expect(alertCall).toBeDefined();
    expect(alertCall[1]).toContain(HOG_CLIENT_ID);
    expect(alertCall[1]).toContain('wix-plan-unknown-999');
  });
});
