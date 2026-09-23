/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: day pass sold as a Wix STORES product (OB-98 hybrid)         │
 * │                                                                         │
 * │  Wix Pricing Plans cannot go below a 7-day length, so a one-day pass is │
 * │  a store product. Store orders differ from plan orders in three ways    │
 * │  that matter, and each is pinned here:                                  │
 * │    - a basket, not one plan → grant against the mapped line item only,  │
 * │      and stay quiet when a shopper buys only merchandise                │
 * │    - a real buyer email on the payload (plan webhooks carry none)       │
 * │    - NO end date → the window comes from the mapping's day_pass_hours   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const wixAdapter = require('../../adapters/wix/wix-adapter');
const { GRANT_EVENT_TYPES, jobNameForEventType } = require('../../core/event-routing');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole: jest.fn(), createGroupLink: jest.fn(), deleteGroupLink: jest.fn(),
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-store-001'),
  getActor:   jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const grantRevoke     = require('../../core/grant-revoke');

const PRODUCT_ID = 'prod-daypass-001';
const SHIRT_ID   = 'prod-tshirt-002';
const ORDER_ID   = 'store-order-abc';

function storeOrderBody({ items, memberId = 'wix-member-1', contactId = 'wix-contact-1', email = 'buyer@example.com' } = {}) {
  return {
    eventType: 'wixStores.orderPaid',
    data: {
      order: {
        _id: ORDER_ID,
        buyerInfo: { memberId, contactId, email, firstName: 'Casey', lastName: 'Guest' },
        lineItems: items,
      },
    },
  };
}
const passItem  = { catalogReference: { catalogItemId: PRODUCT_ID }, productName: { original: '1-Day Guest Pass' } };
const shirtItem = { catalogReference: { catalogItemId: SHIRT_ID },   productName: { original: 'Gym T-Shirt' } };

beforeEach(() => {
  jest.resetAllMocks();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('[P1] store order — routing and parsing', () => {
  test('wixStores.orderPaid is a grant event', () => {
    expect(GRANT_EVENT_TYPES).toContain('store.order_paid');
    expect(jobNameForEventType('store.order_paid')).toBe('grant');
  });

  test('normalizes to store.order_paid with every line item, the buyer email, and NO end date', () => {
    const ev = wixAdapter.parseEvent('wixStores.orderPaid', 'site-1', storeOrderBody({ items: [shirtItem, passItem] }));
    expect(ev.eventType).toBe('store.order_paid');
    expect(ev.platformMemberId).toBe('wix-member-1');
    expect(ev.lineItemPlanIds).toEqual([SHIRT_ID, PRODUCT_ID]);
    expect(ev.planId).toBe(SHIRT_ID);         // first item; the worker picks the mapped one
    expect(ev.wixOrderId).toBe(ORDER_ID);
    expect(ev.email).toBe('buyer@example.com');
    expect(ev.name).toBe('Casey Guest');
    expect(ev.endDate).toBeNull();            // a store order has no duration
    expect(ev.isGuestCheckout).toBe(false);
  });

  test('guest checkout falls back to the contact id and is flagged', () => {
    const ev = wixAdapter.parseEvent('wixStores.orderPaid', 'site-1',
      storeOrderBody({ items: [passItem], memberId: null }));
    expect(ev.platformMemberId).toBe('wix-contact-1');
    expect(ev.isGuestCheckout).toBe(true);
    expect(ev.email).toBe('buyer@example.com');
  });

  test('a plan order is untouched by the store overlay', () => {
    const ev = wixAdapter.parseEvent('wixPricingPlans.orderPurchased', 'site-1', {
      data: { data: { order: {
        _id: 'plan-order-1', planId: 'wix-plan-1', status: 'ACTIVE', lastPaymentStatus: 'PAID',
        endDate: '2026-10-01T00:00:00.000Z', buyer: { memberId: 'wix-member-9' },
      } } },
    });
    expect(ev.eventType).toBe('plan.purchased');
    expect(ev.planId).toBe('wix-plan-1');
    expect(ev.endDate).toBe('2026-10-01T00:00:00.000Z');
    expect(ev.lineItemPlanIds).toBeUndefined();
  });
});

describe('[P1] store order — the REAL Velo payload (wixStores_onOrderPaid)', () => {
  // Shape verified against dev.wix.com 2026-09-18. events.js sends { eventType, data: <order> }:
  // the order IS data, the buyer id is buyerInfo.id (+ identityType), and a line item
  // carries productId + name. The first live purchase was rejected as invalid_structure
  // because the parser only read buyerInfo.memberId.
  function veloBody(identityType) {
    return {
      eventType: 'wixStores.orderPaid',
      data: {
        _id: 'd5d43d01-d9a4-4cc2-b257-61184b881447',
        number: 10019,
        paymentStatus: 'PAID',
        buyerInfo: { id: 'f6c2c0f9-4e9f-a58d-a02d-9af2497294d9', identityType, firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com' },
        lineItems: [{ index: 1, quantity: 1, name: '1-Day Pass', productId: PRODUCT_ID, lineItemType: 'DIGITAL' }],
      },
    };
  }

  test('a logged-in member: id, order, product and email all resolve', () => {
    const ev = wixAdapter.parseEvent('wixStores.orderPaid', 'site-1', veloBody('MEMBER'));
    expect(ev.eventType).toBe('store.order_paid');
    expect(ev.platformMemberId).toBe('f6c2c0f9-4e9f-a58d-a02d-9af2497294d9');
    expect(ev.wixOrderId).toBe('d5d43d01-d9a4-4cc2-b257-61184b881447');
    expect(ev.lineItemPlanIds).toEqual([PRODUCT_ID]);
    expect(ev.planName).toBe('1-Day Pass');
    expect(ev.email).toBe('jane@example.com');
    expect(ev.name).toBe('Jane Doe');
    expect(ev.isGuestCheckout).toBe(false);
  });

  test('a guest checkout (identityType CONTACT) still resolves — and is flagged', () => {
    const ev = wixAdapter.parseEvent('wixStores.orderPaid', 'site-1', veloBody('CONTACT'));
    expect(ev.platformMemberId).toBe('f6c2c0f9-4e9f-a58d-a02d-9af2497294d9');
    expect(ev.email).toBe('jane@example.com');
    expect(ev.isGuestCheckout).toBe(true);
  });
});

describe('[P1] day pass window — dayPassEndDate precedence', () => {
  const NOW = 1789000000000;
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW));
  afterEach(() => Date.now.mockRestore());

  test('the mapping\'s pass length wins over the order end date', () => {
    const out = grantRevoke.dayPassEndDate(
      { endDate: '2026-10-01T00:00:00.000Z' },
      [{ dayPassHours: 24 }]
    );
    expect(out).toBe(new Date(NOW + 24 * 3600_000).toISOString());
  });

  test('a 7-day Wix plan sold as a 24-hour pass expires in 24 hours, not 7 days', () => {
    const weekOut = new Date(NOW + 7 * 24 * 3600_000).toISOString();
    const out = grantRevoke.dayPassEndDate({ endDate: weekOut }, [{ dayPassHours: 24 }]);
    expect(Date.parse(out)).toBe(NOW + 24 * 3600_000);
    expect(Date.parse(out)).toBeLessThan(Date.parse(weekOut));
  });

  test('quantity is consecutive days: 1-Day Pass x5 → 120 h; 2-Day Pass x3 → 144 h; bad units → 1', () => {
    expect(Date.parse(grantRevoke.dayPassEndDate({}, [{ dayPassHours: 24 }], 5))).toBe(NOW + 120 * 3600_000);
    expect(Date.parse(grantRevoke.dayPassEndDate({}, [{ dayPassHours: 48 }], 3))).toBe(NOW + 144 * 3600_000);
    expect(Date.parse(grantRevoke.dayPassEndDate({}, [{ dayPassHours: 24 }], 0))).toBe(NOW + 24 * 3600_000);
    expect(Date.parse(grantRevoke.dayPassEndDate({}, [{ dayPassHours: 24 }], undefined))).toBe(NOW + 24 * 3600_000);
  });

  test('no pass length → the order end date (unchanged Pricing-Plans behaviour)', () => {
    expect(grantRevoke.dayPassEndDate({ endDate: '2026-10-01T00:00:00.000Z' }, [{}]))
      .toBe('2026-10-01T00:00:00.000Z');
  });

  test('store order with neither → throws DAY_PASS_NO_END_DATE (operator has not set a length)', () => {
    expect(() => grantRevoke.dayPassEndDate({ eventType: 'store.order_paid', endDate: null }, [{}]))
      .toThrow(/pass length/i);
  });

  test('synthetic with neither → null, never a throw', () => {
    expect(grantRevoke.dayPassEndDate({ synthetic: true, endDate: null }, [{}])).toBeNull();
  });
});

describe('[P1] day pass grant from a store order', () => {
  test('creates a link expiring at purchase + pass length', async () => {
    const NOW = 1789000000000;
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    hardwareAdapter.createGroupLink.mockResolvedValue({ id: 900, linkUrl: 'https://l/x', qrImageBase64: 'QUJD' });

    const mapping = {
      mappingId: 'map-1', hardwarePlatform: 'kisi', hardwareGroupId: 'group-1',
      apiKey: 'k', accessType: 'day_pass', dayPassHours: 24,
    };
    const ev = wixAdapter.parseEvent('wixStores.orderPaid', 'site-1', storeOrderBody({ items: [passItem] }));

    const { assignments, links } = await grantRevoke.processDayPassGrant(
      'client-1', 'ma-1', [mapping], ev, { email: ev.email }
    );

    const expected = new Date(NOW + 24 * 3600_000).toISOString();
    expect(hardwareAdapter.createGroupLink.mock.calls[0][2]).toMatchObject({ validUntil: expected });
    expect(assignments[0]).toMatchObject({ sourceType: 'day_pass', planEndDate: expected, sourcePlanId: PRODUCT_ID });
    expect(links[0].validUntil).toBe(expected);
    Date.now.mockRestore();
  });
});
