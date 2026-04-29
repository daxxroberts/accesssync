/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: billing-snapshot extractor handles real Wix payloads + edges │
 * │                                                                         │
 * │  Business consequence: snapshot powers the operator Members page rate   │
 * │  / coupon / auto-renew display. A bad extractor either: (a) silently    │
 * │  drops pricing → operators see "—" everywhere, or (b) throws → grant    │
 * │  flow fails → members lose access. Extractor MUST be defensive.        │
 * │                                                                         │
 * │  Governed by: DR-042                                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { extractBillingSnapshot } = require('../../core/billing-snapshot');

// Real production payload from webhook_log (2026-04-29 — DAXXADMIN coupon order).
const REAL_HOG_PAYLOAD = {
  data: {
    entity: {
      _id: '8aad0ad0-8051-39cc-b75a-b016937f3327',
      type: 'ONLINE',
      buyer: { memberId: 'f98bdcf3-5844-4e0d-b2d9-37354fbddbcf' },
      planId: '4b6d0144-4ec3-4b88-9191-d6a73fa9e1e3',
      planName: 'Individual',
      planPrice: '40',
      status: 'DRAFT',
      pricing: {
        prices: [{
          price: {
            fees:      [],
            total:     '0.00',
            coupon:    { _id: '9b4de43f-...', code: 'DAXXADMIN', amount: '40.00' },
            currency:  'USD',
            discount:  '40.00',
            subtotal:  '40.00',
            proration: '0',
          },
          duration: { cycleFrom: 0, numberOfCycles: 1 },
        }],
        subscription: {
          cycleCount:    0,
          cycleDuration: { unit: 'MONTH', count: 1 },
        },
      },
      subscriptionId:    '37998f25-82bf-4346-857d-6d34f985594e',
      autoRenewCanceled: false,
      lastPaymentStatus: 'UNPAID',
      orderMethod:       'UNKNOWN',
    },
  },
  eventType: 'wixPricingPlans.orderUpdated',
};

describe('[P3] billing-snapshot extraction', () => {

  test('extracts full snapshot from real HOG payload', () => {
    const snap = extractBillingSnapshot(REAL_HOG_PAYLOAD);

    expect(snap).toMatchObject({
      planPrice:         '40',
      cycleUnit:         'MONTH',
      cycleCount:        1,
      currency:          'USD',
      total:             '0.00',
      subtotal:          '40.00',
      discount:          '40.00',
      coupon:            { code: 'DAXXADMIN', amount: '40.00' },
      autoRenewCanceled: false,
      lastPaymentStatus: 'UNPAID',
      subscriptionId:    '37998f25-82bf-4346-857d-6d34f985594e',
      orderMethod:       'UNKNOWN',
      orderId:           '8aad0ad0-8051-39cc-b75a-b016937f3327',
    });
    expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('returns null coupon when no coupon code present', () => {
    const noCoupon = JSON.parse(JSON.stringify(REAL_HOG_PAYLOAD));
    delete noCoupon.data.entity.pricing.prices[0].price.coupon;
    expect(extractBillingSnapshot(noCoupon).coupon).toBeNull();
  });

  test('autoRenewCanceled is true when explicitly true', () => {
    const cancelled = JSON.parse(JSON.stringify(REAL_HOG_PAYLOAD));
    cancelled.data.entity.autoRenewCanceled = true;
    expect(extractBillingSnapshot(cancelled).autoRenewCanceled).toBe(true);
  });

  test('autoRenewCanceled defaults to false when missing', () => {
    const missing = JSON.parse(JSON.stringify(REAL_HOG_PAYLOAD));
    delete missing.data.entity.autoRenewCanceled;
    expect(extractBillingSnapshot(missing).autoRenewCanceled).toBe(false);
  });

  test('returns null when no pricing data anywhere', () => {
    expect(extractBillingSnapshot({ data: { entity: { _id: 'x' } } })).toBeNull();
  });

  test('returns null on null/undefined input', () => {
    expect(extractBillingSnapshot(null)).toBeNull();
    expect(extractBillingSnapshot(undefined)).toBeNull();
    expect(extractBillingSnapshot({})).toBeNull();
  });

  test('extracts planPrice even without full pricing block (degenerate but seen)', () => {
    const snap = extractBillingSnapshot({
      data: { entity: { _id: 'o1', planPrice: '99', autoRenewCanceled: false } },
    });
    expect(snap.planPrice).toBe('99');
    expect(snap.currency).toBeNull();
    expect(snap.cycleUnit).toBeNull();
  });

  test('never throws on malformed input', () => {
    expect(() => extractBillingSnapshot({ data: { entity: { pricing: 'not an object' } } })).not.toThrow();
    expect(() => extractBillingSnapshot({ data: { entity: { pricing: { prices: 'not array' } } } })).not.toThrow();
  });

  test('handles yearly cycle correctly', () => {
    const yearly = JSON.parse(JSON.stringify(REAL_HOG_PAYLOAD));
    yearly.data.entity.pricing.subscription.cycleDuration = { unit: 'YEAR', count: 1 };
    const snap = extractBillingSnapshot(yearly);
    expect(snap.cycleUnit).toBe('YEAR');
    expect(snap.cycleCount).toBe(1);
  });
});
