/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a Pricing Plan purchase is granted ONCE, not twice           │
 * │                                                                         │
 * │  Business consequence (live, 2026-09-23 → 10-05): buying a plan makes   │
 * │  Wix fire the plan.* webhooks AND a store.order_paid for its eCom       │
 * │  checkout, whose line item carries the plan's own id. The store path   │
 * │  matched it to the plan mapping and granted the plan again: a second    │
 * │  billing row under the checkout order id, the access source moved onto  │
 * │  it (so a cancel later hit the wrong row), and a second "access ready"  │
 * │  email. 59 House of Gains members.                                      │
 * │                                                                         │
 * │  Rule: a store order only ever grants DAY PASSES. Plans are granted by  │
 * │  their own plan.* webhooks.                                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })),
  Worker: jest.fn(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
  return { log: l, withTrace: jest.fn(() => l) };
});

const planMappingResolver = require('../../core/plan-mapping-resolver');
const { _resolveStoreMappings } = require('../../core/queue-worker');

const TENANT   = 'client-1';
const PLAN_ID  = 'plan-couples';
const PASS_ID  = 'prod-1day';
const SHIRT_ID = 'prod-shirt';

const planMapping = { mappingId: 'map-plan', hardwareGroupId: 'g-front', accessType: 'group' };
const passMapping = { mappingId: 'map-pass', hardwareGroupId: 'g-front', accessType: 'day_pass', dayPassHours: 24 };

const logger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function storeEvent(lineItemPlanIds) {
  return {
    eventType: 'store.order_paid', platformMemberId: 'wix-1',
    planId: lineItemPlanIds[0], lineItemPlanIds, wixOrderId: 'checkout-order-1',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  planMappingResolver.resolve.mockImplementation(async (_t, id) => {
    if (id === PLAN_ID) return [planMapping];
    if (id === PASS_ID) return [passMapping];
    return [];   // merchandise: recognised by nobody
  });
});

describe('[P1] store order — a plan checkout is not a second grant', () => {
  test('REGRESSION: the checkout of a Pricing Plan resolves to nothing (caller exits before any lock, billing or email)', async () => {
    const ev = storeEvent([PLAN_ID]);
    const mappings = await _resolveStoreMappings(TENANT, ev, logger);

    expect(mappings).toBeNull();
    expect(ev.planId).toBe(PLAN_ID);            // untouched
    expect(ev.storeGrantItems).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith('queue.grant.store.non_day_pass_item_skipped',
      expect.objectContaining({ planId: PLAN_ID, wixOrderId: 'checkout-order-1' }));
  });

  test('a day pass still grants (unchanged)', async () => {
    const ev = storeEvent([PASS_ID]);
    const mappings = await _resolveStoreMappings(TENANT, ev, logger);

    expect(mappings).toEqual([passMapping]);
    expect(ev.planId).toBe(PASS_ID);
    expect(ev.storeGrantItems).toEqual([{ id: PASS_ID, mappings: [passMapping] }]);
  });

  test('a basket with the plan item FIRST and a day pass second still grants the day pass', async () => {
    // Before the fix matched[0] was the plan item, so the whole order went down the
    // membership path and the day pass was silently dropped.
    const ev = storeEvent([PLAN_ID, PASS_ID]);
    const mappings = await _resolveStoreMappings(TENANT, ev, logger);

    expect(mappings).toEqual([passMapping]);
    expect(ev.planId).toBe(PASS_ID);
    expect(ev.storeGrantItems).toEqual([{ id: PASS_ID, mappings: [passMapping] }]);
  });

  test('merchandise only stays quiet (unchanged)', async () => {
    const ev = storeEvent([SHIRT_ID]);
    expect(await _resolveStoreMappings(TENANT, ev, logger)).toBeNull();
    expect(logger.info).toHaveBeenCalledWith('queue.grant.store.no_mapped_item', expect.anything());
  });
});
