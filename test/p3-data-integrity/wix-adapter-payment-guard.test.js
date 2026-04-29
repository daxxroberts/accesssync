/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Wix DRAFT/UNPAID orders must not grant access                │
 * │                                                                         │
 * │  Business consequence: Wix fires `orderUpdated` (and sometimes          │
 * │  `orderPurchased`) for orders that are still in DRAFT state with        │
 * │  lastPaymentStatus=UNPAID — typically because checkout failed on        │
 * │  billing-address validation. Without a payment-status guard in the      │
 * │  parser, AccessSync provisions hardware access for orders the member    │
 * │  never paid for. This is exactly how a refunded customer keeps their    │
 * │  door code.                                                             │
 * │                                                                         │
 * │  Production incident (2026-04-29): test member's `orderUpdated` fired   │
 * │  with status=DRAFT, lastPaymentStatus=UNPAID — AccessSync provisioned   │
 * │  Kisi role assignment 95518724 anyway. Confirmed by trace               │
 * │  d95223a1-b980-4d5c-b38f-a87de67c34a4 in webhook_log.                   │
 * │                                                                         │
 * │  Convention: parseEvent() rewrites the eventType to 'plan.unpaid_order' │
 * │  when status is not ACTIVE or lastPaymentStatus is not PAID/TRIAL/null. │
 * │  webhook_log retains the row for audit; queue-worker has no case for    │
 * │  the rewritten type, so no grant fires.                                 │
 * │                                                                         │
 * │  Runtime impact: zero — parser-only check. Five new lines per event.    │
 * │  Standards register entry: AccessSync/STANDARDS.md → Best Practices →   │
 * │  "Never trust webhook event type — verify the entity state" (2026-04-29)│
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const wixAdapter = require('../../adapters/wix/wix-adapter');

function makeOrder({ status, lastPaymentStatus, planId = 'plan-1', memberId = 'member-1' }) {
  return {
    data: {
      entity: {
        _id: 'order-test-1',
        type: 'ONLINE',
        status,
        lastPaymentStatus,
        planId,
        buyer: { memberId, contactId: memberId },
        cycles: [{ index: 0, startedDate: new Date().toISOString() }],
      },
    },
    eventType: 'wixPricingPlans.orderUpdated',
  };
}

describe('wix-adapter payment-status guard', () => {
  test('drops DRAFT/UNPAID orderUpdated — does not grant', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderUpdated',
      'site-1',
      makeOrder({ status: 'DRAFT', lastPaymentStatus: 'UNPAID' })
    );
    expect(evt.eventType).toBe('plan.unpaid_order');
  });

  test('drops DRAFT/UNPAID orderPurchased — failed checkout case', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderPurchased',
      'site-1',
      makeOrder({ status: 'DRAFT', lastPaymentStatus: 'UNPAID' })
    );
    expect(evt.eventType).toBe('plan.unpaid_order');
  });

  test('drops PAUSED/UNPAID orderUpdated', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderUpdated',
      'site-1',
      makeOrder({ status: 'PAUSED', lastPaymentStatus: 'UNPAID' })
    );
    expect(evt.eventType).toBe('plan.unpaid_order');
  });

  test('allows ACTIVE/PAID orderPurchased — real purchase grants', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderPurchased',
      'site-1',
      makeOrder({ status: 'ACTIVE', lastPaymentStatus: 'PAID' })
    );
    expect(evt.eventType).toBe('plan.purchased');
  });

  test('allows ACTIVE/TRIAL orderUpdated — trial transition is a grant', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderUpdated',
      'site-1',
      makeOrder({ status: 'ACTIVE', lastPaymentStatus: 'TRIAL' })
    );
    expect(evt.eventType).toBe('plan.purchased');
  });

  test('allows ACTIVE with no lastPaymentStatus — free plan with no price set', () => {
    // Some free plans have lastPaymentStatus=null because there is no payment record.
    // We rely on status=ACTIVE to confirm the order is real.
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderUpdated',
      'site-1',
      makeOrder({ status: 'ACTIVE', lastPaymentStatus: null })
    );
    expect(evt.eventType).toBe('plan.purchased');
  });

  test('allows ACTIVE/PAID orderStarted — delayed-start grant phase 2', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderStarted',
      'site-1',
      makeOrder({ status: 'ACTIVE', lastPaymentStatus: 'PAID' })
    );
    expect(evt.eventType).toBe('plan.started');
  });

  test('drops DRAFT/UNPAID orderStarted', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderStarted',
      'site-1',
      makeOrder({ status: 'DRAFT', lastPaymentStatus: 'UNPAID' })
    );
    expect(evt.eventType).toBe('plan.unpaid_order');
  });

  test('does not gate cancel events — cancellations always process', () => {
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderCanceled',
      'site-1',
      makeOrder({ status: 'CANCELED', lastPaymentStatus: 'UNPAID' })
    );
    expect(evt.eventType).toBe('plan.cancelled');
  });

  test('passes original Wix order ID + memberId through to the dropped event', () => {
    // Even when dropped, audit fields are preserved so the row in webhook_log
    // has enough info for the operator to find the abandoned cart.
    const evt = wixAdapter.parseEvent(
      'wixPricingPlans.orderUpdated',
      'site-1',
      makeOrder({ status: 'DRAFT', lastPaymentStatus: 'UNPAID', memberId: 'real-member-id', planId: 'real-plan-id' })
    );
    expect(evt.eventType).toBe('plan.unpaid_order');
    expect(evt.platformMemberId).toBe('real-member-id');
    expect(evt.planId).toBe('real-plan-id');
  });
});
