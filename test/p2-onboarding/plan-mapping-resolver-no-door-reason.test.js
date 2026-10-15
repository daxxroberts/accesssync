/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: a mapped plan resolves to no door — the resolver says WHY    │
 * │  (owner hub review 2026-10-15, bug 3)                                   │
 * │                                                                         │
 * │  Three situations used to look identical (an empty array):             │
 * │    no_group         the gym has not chosen a door group yet             │
 * │    location_lapsed  the location has no active billing subscription     │
 * │    group_unhealthy  every door group was marked not_found               │
 * │  The reason now rides on the empty array as a non-enumerable property  │
 * │  so every existing `mappings.length === 0` caller is unchanged.         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn((enc) => `decrypted-${enc}`), encryptApiKey: jest.fn() }));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-1'), getActor: jest.fn(() => ({ type: 'system', id: 'queue-worker' })), setTraceContext: jest.fn(),
}));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const db = require('../../db');
const resolver = require('../../core/plan-mapping-resolver');

function mockEmptyThen(whyRow) {
  db.query
    .mockResolvedValueOnce({ rows: [] })                 // main resolve: nothing usable
    .mockResolvedValueOnce({ rows: [{ id: 'pm-1' }] })   // plan exists
    .mockResolvedValueOnce({ rows: [whyRow] });          // why
}

beforeEach(() => jest.clearAllMocks());

describe('[P2] plan-mapping-resolver — reason for an empty result', () => {
  test('no door group chosen yet → [] with reason no_group', async () => {
    mockEmptyThen({ location_lapsed: false, group_unhealthy: false });
    const out = await resolver.resolve('c1', 'plan-1');
    expect(out).toEqual([]);
    expect(out.noMappingReason).toBe('no_group');
    expect(Object.keys(out)).toEqual([]);   // non-enumerable: the Array contract is unchanged
  });

  test('location without an active billing subscription → reason location_lapsed', async () => {
    mockEmptyThen({ location_lapsed: true, group_unhealthy: false });
    const out = await resolver.resolve('c1', 'plan-1');
    expect(out).toEqual([]);
    expect(out.noMappingReason).toBe('location_lapsed');
  });

  test('every door group marked not_found → reason group_unhealthy', async () => {
    mockEmptyThen({ location_lapsed: false, group_unhealthy: true });
    expect((await resolver.resolve('c1', 'plan-1')).noMappingReason).toBe('group_unhealthy');
  });

  test('a lapsed location outranks a missing group', async () => {
    mockEmptyThen({ location_lapsed: true, group_unhealthy: true });
    expect((await resolver.resolve('c1', 'plan-1')).noMappingReason).toBe('location_lapsed');
  });

  test('the why-query failing never breaks the grant path: falls back to no_group', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'pm-1' }] })
      .mockRejectedValueOnce(new Error('db down'));
    const out = await resolver.resolve('c1', 'plan-1');
    expect(out).toEqual([]);
    expect(out.noMappingReason).toBe('no_group');
  });

  test('the why-query joins billing_subscriptions on status active and reads plan_mapping_groups.health_status', async () => {
    mockEmptyThen({ location_lapsed: false, group_unhealthy: false });
    await resolver.resolve('c1', 'plan-1');
    const sql = String(db.query.mock.calls[2][0]);
    expect(sql).toMatch(/billing_subscriptions bs ON bs.location_id = pm.location_id AND bs.status = 'active'/);
    expect(sql).toMatch(/health_status/);
    expect(db.query.mock.calls[2][1]).toEqual(['c1', 'plan-1']);
  });

  test('an unknown plan is still null (not an empty array)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    expect(await resolver.resolve('c1', 'plan-x')).toBeNull();
  });
});
