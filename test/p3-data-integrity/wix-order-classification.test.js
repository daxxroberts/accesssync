/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: one shared rule decides whether a Wix order is "paying"      │
 * │                                                                         │
 * │  Business consequence: the nightly sweep used to treat every ACTIVE     │
 * │  Wix order as a paying member — including ACTIVE orders whose payment   │
 * │  was still UNPAID. The webhook guard already refused those. Two rules   │
 * │  for one question means the sweep could grant a door the webhook       │
 * │  refused, or (once removals are armed) remove someone the webhook       │
 * │  considers paid.                                                        │
 * │                                                                         │
 * │  core/wix-order-classification.js is now the single rule. These tests   │
 * │  pin every classification branch and prove the webhook guard and the    │
 * │  sweep's isPayingOrder agree on every order that carries a status.     │
 * │                                                                         │
 * │  Pure module — no mocks needed.                                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// Quiet the logger — the parity block drives parseEvent's unpaid-order warn
// dozens of times. No assertion here depends on log output.
jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const {
  PAYING_PAYMENT_STATUSES,
  ORDER_CLASS,
  isPayingOrder,
  classifyOrder,
} = require('../../core/wix-order-classification');

const wixAdapter = require('../../adapters/wix/wix-adapter');

describe('[P3] wix-order-classification — constants', () => {
  test('PAYING_PAYMENT_STATUSES is exactly the old wix-adapter ALLOWED_PAYMENT set, frozen', () => {
    expect([...PAYING_PAYMENT_STATUSES]).toEqual(['PAID', 'TRIAL', null]);
    expect(Object.isFrozen(PAYING_PAYMENT_STATUSES)).toBe(true);
  });

  test('ORDER_CLASS has the five pinned values, frozen', () => {
    expect(ORDER_CLASS).toEqual({
      PAYING: 'PAYING', PENDING: 'PENDING', DECLINED: 'DECLINED', ENDED: 'ENDED', UNKNOWN: 'UNKNOWN',
    });
    expect(Object.isFrozen(ORDER_CLASS)).toBe(true);
  });
});

describe('[P3] classifyOrder — every branch', () => {
  const cases = [
    // [status, lastPaymentStatus, expected]
    // PAYING
    ['ACTIVE', 'PAID',            'PAYING'],
    ['ACTIVE', 'TRIAL',           'PAYING'],
    ['ACTIVE', null,              'PAYING'],   // free plan, no payment record yet
    ['ACTIVE', undefined,         'PAYING'],   // field absent → treated as null
    // PENDING
    ['ACTIVE', 'UNPAID',          'PENDING'],  // the sweep used to grant this
    ['ACTIVE', 'PENDING',         'PENDING'],
    ['DRAFT',  'UNPAID',          'PENDING'],
    ['DRAFT',  null,              'PENDING'],
    ['PENDING', 'PAID',           'PENDING'],
    // DECLINED
    ['PAUSED', 'UNPAID',          'DECLINED'],
    ['PAUSED', 'PAID',            'DECLINED'],
    ['ACTIVE', 'FAILED',          'DECLINED'],
    ['ACTIVE', 'REFUNDED',        'DECLINED'],
    // ENDED
    ['ENDED',     'PAID',         'ENDED'],
    ['CANCELED',  'PAID',         'ENDED'],
    ['CANCELLED', null,           'ENDED'],
    ['EXPIRED',   'UNPAID',       'ENDED'],
    // UNKNOWN — inert: never granted, never removed
    ['ACTIVE', 'NOT_APPLICABLE',  'UNKNOWN'],  // webhook guard refuses it too
    ['ACTIVE', 'UNDEFINED',       'UNKNOWN'],
    ['ACTIVE', '',                'UNKNOWN'],
    [undefined, 'PAID',           'UNKNOWN'],  // missing status
    [null,      'PAID',           'UNKNOWN'],
    ['active',  'PAID',           'UNKNOWN'],  // exact match only
    ['OFFLINE_PENDING', 'PAID',   'UNKNOWN'],  // a status this module has never seen
  ];

  test.each(cases)('status=%p lastPaymentStatus=%p → %s', (status, lastPaymentStatus, expected) => {
    const order = { id: 'o-1', planId: 'plan-1' };
    if (status !== undefined) order.status = status;
    if (lastPaymentStatus !== undefined) order.lastPaymentStatus = lastPaymentStatus;
    expect(classifyOrder(order)).toBe(expected);
  });

  test('null / undefined / non-object order → UNKNOWN, never throws', () => {
    expect(classifyOrder(null)).toBe('UNKNOWN');
    expect(classifyOrder(undefined)).toBe('UNKNOWN');
    expect(classifyOrder('ACTIVE')).toBe('UNKNOWN');
    expect(classifyOrder(42)).toBe('UNKNOWN');
  });

  test('every classification is one of ORDER_CLASS', () => {
    const values = new Set(Object.values(ORDER_CLASS));
    for (const [status, lastPaymentStatus] of cases) {
      expect(values.has(classifyOrder({ status, lastPaymentStatus }))).toBe(true);
    }
  });
});

describe('[P3] isPayingOrder', () => {
  test('true only for ACTIVE with PAID / TRIAL / null / absent payment status', () => {
    expect(isPayingOrder({ status: 'ACTIVE', lastPaymentStatus: 'PAID' })).toBe(true);
    expect(isPayingOrder({ status: 'ACTIVE', lastPaymentStatus: 'TRIAL' })).toBe(true);
    expect(isPayingOrder({ status: 'ACTIVE', lastPaymentStatus: null })).toBe(true);
    expect(isPayingOrder({ status: 'ACTIVE' })).toBe(true);
  });

  test('false for ACTIVE + UNPAID — the order the sweep used to grant', () => {
    expect(isPayingOrder({ status: 'ACTIVE', lastPaymentStatus: 'UNPAID' })).toBe(false);
  });

  test('false for every non-ACTIVE status, even when PAID', () => {
    for (const status of ['DRAFT', 'PENDING', 'PAUSED', 'ENDED', 'CANCELED', 'CANCELLED', 'EXPIRED', undefined, null]) {
      expect(isPayingOrder({ status, lastPaymentStatus: 'PAID' })).toBe(false);
    }
  });

  test('false for null / non-object input, never throws', () => {
    expect(isPayingOrder(null)).toBe(false);
    expect(isPayingOrder(undefined)).toBe(false);
    expect(isPayingOrder('ACTIVE')).toBe(false);
  });

  test('isPayingOrder(order) === (classifyOrder(order) === PAYING) for every order', () => {
    const statuses = ['ACTIVE', 'DRAFT', 'PENDING', 'PAUSED', 'ENDED', 'CANCELED', 'CANCELLED', 'EXPIRED', undefined, null, 'active'];
    const payments = ['PAID', 'TRIAL', null, undefined, 'UNPAID', 'PENDING', 'FAILED', 'REFUNDED', 'NOT_APPLICABLE', ''];
    for (const status of statuses) {
      for (const lastPaymentStatus of payments) {
        const order = { status, lastPaymentStatus };
        expect(isPayingOrder(order)).toBe(classifyOrder(order) === ORDER_CLASS.PAYING);
      }
    }
  });
});

describe('[P3] webhook guard and sweep share one paying rule', () => {
  // For any order that CARRIES a status, the webhook payment guard in
  // wix-adapter.parseEvent must grant exactly when the sweep's isPayingOrder
  // says the order is paying. (A payload with no status at all is a Velo
  // short-form event — the webhook guard lets it through by design and the
  // sweep never sees one, so it is outside this parity check.)
  const statuses = ['ACTIVE', 'DRAFT', 'PENDING', 'PAUSED', 'ENDED', 'CANCELED', 'EXPIRED'];
  const payments = ['PAID', 'TRIAL', null, undefined, 'UNPAID', 'PENDING', 'FAILED', 'REFUNDED', 'NOT_APPLICABLE'];

  function webhookGrants(status, lastPaymentStatus) {
    const entity = { _id: 'order-1', status, planId: 'plan-1', buyer: { memberId: 'm-1' } };
    if (lastPaymentStatus !== undefined) entity.lastPaymentStatus = lastPaymentStatus;
    const evt = wixAdapter.parseEvent('wixPricingPlans.orderPurchased', 'site-1', { data: { entity } });
    return evt.eventType === 'plan.purchased';
  }

  for (const status of statuses) {
    for (const lastPaymentStatus of payments) {
      test(`status=${status} lastPaymentStatus=${String(lastPaymentStatus)}`, () => {
        const order = { status };
        if (lastPaymentStatus !== undefined) order.lastPaymentStatus = lastPaymentStatus;
        expect(webhookGrants(status, lastPaymentStatus)).toBe(isPayingOrder(order));
      });
    }
  }
});
