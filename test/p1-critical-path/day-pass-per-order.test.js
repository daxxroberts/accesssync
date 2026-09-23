/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: every PAID day pass gets its own door code (OB-98)           │
 * │                                                                         │
 * │  Business consequence (live, 2026-09-18): a buyer who already held an   │
 * │  active 2-Day Pass bought another one. The claim mutex was keyed on     │
 * │  person + product + door, so the second order "lost" to the first —     │
 * │  the customer paid and received nothing, silently. A quantity of 3      │
 * │  likewise produced one code.                                            │
 * │                                                                         │
 * │  Builder rule: if they paid for it, they get a code.                    │
 * │  Builder rule (2026-09-23): quantity is consecutive DAYS, not people.   │
 * │                                                                         │
 * │  The claim key is product#order#1:                                      │
 * │    - a second ORDER of the same pass        → a new key  → a new code   │
 * │    - quantity 5 on one order                → ONE code, 5 x the hours   │
 * │    - Wix's echoes of ONE order              → same key   → one code     │
 * │    - each code expires alone                (revoke matches by key)     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('bullmq', () => ({
  Queue: jest.fn(() => ({ add: jest.fn(), on: jest.fn() })),
  Worker: jest.fn(() => ({ on: jest.fn() })),
  UnrecoverableError: class UnrecoverableError extends Error {},
}));
jest.mock('../../db', () => ({ query: jest.fn(), getClient: jest.fn() }));
jest.mock('../../core/plan-mapping-resolver', () => ({ resolve: jest.fn() }));
jest.mock('../../adapters/standard-adapter', () => ({
  resolveEmailOnly:     jest.fn(),
  claimDayPassSources:  jest.fn(),
  releaseDayPassClaims: jest.fn(),
  completeGrant:        jest.fn(),
  rollupAccessStatus:   jest.fn(),
}));
jest.mock('../../core/grant-revoke', () => ({
  dayPassEndDate:      jest.fn(),
  processDayPassGrant: jest.fn(),
}));
jest.mock('../../core/member-mailer', () => ({
  maybeSendDayPassEmail: jest.fn(() => Promise.resolve({ sent: true })),
  maybeSendGrantEmail:   jest.fn(() => Promise.resolve({ sent: true })),
}));
jest.mock('../../adapters/hardware-adapter', () => ({}));
jest.mock('../../core/retry-engine', () => ({ handleFailure: jest.fn() }));
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() };
  return { log: l, withTrace: jest.fn(() => l) };
});

const standardAdapter  = require('../../adapters/standard-adapter');
const grantRevokeLogic = require('../../core/grant-revoke');
const memberMailer     = require('../../core/member-mailer');
const { _runDayPassGrant, _unitsBought } = require('../../core/queue-worker');

const TENANT = 'client-1', MEMBER = 'access-1', PRODUCT = 'prod-2day', GROUP = 'group-1';
const mapping = { mappingId: 'map-1', hardwareGroupId: GROUP, hardwarePlatform: 'kisi', apiKey: 'k', accessType: 'day_pass', dayPassHours: 48 };
const logger  = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

function event(orderId, quantity = 1) {
  return {
    eventType: 'store.order_paid', platformMemberId: 'wix-1', planId: PRODUCT, planName: '2-Day Pass',
    wixOrderId: orderId, email: 'buyer@example.com',
    lineItemDetails: [{ id: PRODUCT, name: '2-Day Pass', quantity }],
  };
}
const run = (standardEvent) => _runDayPassGrant({
  tenantId: TENANT, memberId: MEMBER, mappings: [mapping], standardEvent,
  eventId: 'evt-1', job: { id: 'job-1' }, logger, traceId: 't-1', jobStart: Date.now(),
});

let claimedKeys;
beforeEach(() => {
  jest.clearAllMocks();
  claimedKeys = new Set();
  grantRevokeLogic.dayPassEndDate.mockReturnValue('2026-09-20T20:00:00.000Z');
  standardAdapter.resolveEmailOnly.mockResolvedValue({ email: 'buyer@example.com' });
  standardAdapter.releaseDayPassClaims.mockResolvedValue(0);
  // A faithful stand-in for the DB's UNIQUE claim: the first claim of a key wins.
  standardAdapter.claimDayPassSources.mockImplementation(async (_m, _t, mappings, key) => {
    if (claimedKeys.has(key)) return [];
    claimedKeys.add(key);
    return mappings;
  });
  let n = 0;
  grantRevokeLogic.processDayPassGrant.mockImplementation(async (_t, _m, claimed, _e, opts) => {
    n += 1;
    return {
      assignments: claimed.map(c => ({ mappingId: c.mappingId, roleAssignmentId: String(900 + n), sourceKey: opts.sourceKey })),
      links:       claimed.map(c => ({ mappingId: c.mappingId, groupLinkId: 900 + n, qrImageBase64: 'QUJD', unit: opts.unit, units: opts.units })),
    };
  });
});

describe('[P1] day pass — one code per paid order, quantity is days', () => {
  test('REGRESSION: a second order of the SAME pass while the first is active still gets a code', async () => {
    await run(event('order-A'));
    await run(event('order-B'));

    expect(grantRevokeLogic.processDayPassGrant).toHaveBeenCalledTimes(2);
    expect([...claimedKeys]).toEqual([`${PRODUCT}#order-A#1`, `${PRODUCT}#order-B#1`]);
    expect(memberMailer.maybeSendDayPassEmail).toHaveBeenCalledTimes(2);
  });

  test('an echo of the SAME order mints nothing and sends nothing', async () => {
    await run(event('order-A'));
    await run(event('order-A'));

    expect(grantRevokeLogic.processDayPassGrant).toHaveBeenCalledTimes(1);
    expect(memberMailer.maybeSendDayPassEmail).toHaveBeenCalledTimes(1);
    expect(standardAdapter.rollupAccessStatus).toHaveBeenCalledTimes(1);   // the echo just recomputes
  });

  test('quantity 5 → ONE code, one source row, one email; the window is 5 x the pass length', async () => {
    await run(event('order-Q', 5));

    expect([...claimedKeys]).toEqual([`${PRODUCT}#order-Q#1`]);
    expect(grantRevokeLogic.dayPassEndDate).toHaveBeenCalledWith(expect.anything(), [mapping], 5);
    expect(grantRevokeLogic.processDayPassGrant).toHaveBeenCalledTimes(1);
    expect(grantRevokeLogic.processDayPassGrant.mock.calls[0][4]).toMatchObject({ units: 5 });
    expect(standardAdapter.completeGrant).toHaveBeenCalledTimes(1);
    expect(memberMailer.maybeSendDayPassEmail).toHaveBeenCalledTimes(1);
    const mail = memberMailer.maybeSendDayPassEmail.mock.calls[0][0];
    expect(mail.links).toHaveLength(1);
    expect(mail.units).toBe(5);
    expect(mail.eventKey).toBe('order-Q:u1');
  });

  test('the source row is stored under the claim key; the event keeps the real product id for billing', async () => {
    await run(event('order-A'));
    const call = grantRevokeLogic.processDayPassGrant.mock.calls[0];
    expect(call[4]).toMatchObject({ sourceKey: `${PRODUCT}#order-A#1`, units: 1 });
    expect(call[3].planId).toBe(PRODUCT);
  });

  test('Kisi failing: the claim is released so the retry can mint it, the job throws, nothing is emailed', async () => {
    const boom = Object.assign(new Error('kisi 500'), { statusCode: 500 });
    grantRevokeLogic.processDayPassGrant.mockImplementationOnce(async () => { throw boom; });

    await expect(run(event('order-P', 2))).rejects.toBe(boom);

    expect(standardAdapter.releaseDayPassClaims).toHaveBeenCalledWith(MEMBER, TENANT, [mapping], `${PRODUCT}#order-P#1`);
    expect(standardAdapter.rollupAccessStatus).toHaveBeenCalledTimes(1);
    expect(memberMailer.maybeSendDayPassEmail).not.toHaveBeenCalled();
  });

  test('no order id (legacy event) → the bare product id, one pass per product as before', async () => {
    await run({ ...event(null), wixOrderId: null });
    expect([...claimedKeys]).toEqual([PRODUCT]);
  });
});

describe('[P1] day pass — _unitsBought', () => {
  test('reads the quantity of the mapped product only', () => {
    const ev = { lineItemDetails: [{ id: 'shirt', quantity: 4 }, { id: PRODUCT, quantity: 2 }] };
    expect(_unitsBought(ev, PRODUCT, logger)).toBe(2);
  });

  test('no line-item detail (a plan order) → 1', () => {
    expect(_unitsBought({}, PRODUCT, logger)).toBe(1);
  });

  test('an absurd quantity is capped at 50 and logged — a sanity ceiling, not a product rule', () => {
    expect(_unitsBought({ lineItemDetails: [{ id: PRODUCT, quantity: 5000 }] }, PRODUCT, logger)).toBe(50);
    expect(logger.warn).toHaveBeenCalledWith('grant.day_pass.units_capped',
      expect.objectContaining({ unitsBought: 5000, unitsGranted: 50 }));
  });
});
