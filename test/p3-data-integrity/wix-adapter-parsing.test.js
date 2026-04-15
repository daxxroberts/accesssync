/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Wix webhook payload → member ID and plan ID resolve          │
 * │            correctly across all Wix event structures                   │
 * │                                                                         │
 * │  Business consequence: If memberId resolves to the wrong value,         │
 * │  the WRONG member gets provisioned or loses access. If planId is        │
 * │  missed, the plan-mapping-resolver returns null and access is silently  │
 * │  dropped — member pays but the grant job is discarded.                 │
 * │                                                                         │
 * │  Pure function — no mocks needed. wix-adapter has zero dependencies.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const wixAdapter = require('../../adapters/wix/wix-adapter');

const {
  WIX_MEMBER_ID,
  CONNECT_PLAN_ID,
  wixPlanPurchasedPayload,
  wixMemberDeletedPayload,
  wixRestOrderCreatedPayload,
  wixRestMemberDeletedPayload,
} = require('../helpers/fixtures');

// ─── memberId Resolution ─────────────────────────────────────────────────────

describe('[P3] Wix webhook → memberId resolves correctly', () => {

  it('resolves memberId from wixPricingPlans event (most common path — plan purchased/cancelled)', () => {
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', wixPlanPurchasedPayload);
    expect(result.platformMemberId).toBe(WIX_MEMBER_ID);
  });

  it('resolves memberId from wixMembers deleted event (member._id path)', () => {
    const result = wixAdapter.parseEvent('member.deleted', 'site-001', wixMemberDeletedPayload);
    expect(result.platformMemberId).toBe(WIX_MEMBER_ID);
  });

  it('resolves memberId from wixBookings event (booking.contactId path)', () => {
    const bookingPayload = {
      data: {
        booking: { contactId: 'booking-member-abc' }
      }
    };
    const result = wixAdapter.parseEvent('booking.cancelled', 'site-001', bookingPayload);
    expect(result.platformMemberId).toBe('booking-member-abc');
  });

  it('resolves memberId from direct top-level field (fallback path)', () => {
    const directPayload = { memberId: 'direct-member-xyz', planId: CONNECT_PLAN_ID };
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', directPayload);
    expect(result.platformMemberId).toBe('direct-member-xyz');
  });

  it('returns null memberId and logs a warning when no memberId found — prevents ghost provisioning', () => {
    const { log } = require('../../core/logger');
    const warnSpy = jest.spyOn(log, 'warn').mockImplementation(() => {});

    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', { data: {} });

    expect(result.platformMemberId).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'wix.parse.no_member_id',
      expect.objectContaining({ eventType: 'plan.purchased' })
    );

    warnSpy.mockRestore();
  });

});

// ─── planId Resolution ────────────────────────────────────────────────────────

describe('[P3] Wix webhook → planId resolves correctly', () => {

  it('resolves planId from wixPricingPlans order.planId (standard path)', () => {
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', wixPlanPurchasedPayload);
    expect(result.planId).toBe(CONNECT_PLAN_ID);
  });

  it('resolves planId from wixBookings booking.serviceId (service = plan equivalent)', () => {
    const bookingPayload = {
      data: {
        booking: {
          contactId:  'member-abc',
          serviceId:  'service-crossfit-001'
        }
      }
    };
    const result = wixAdapter.parseEvent('booking.cancelled', 'site-001', bookingPayload);
    expect(result.planId).toBe('service-crossfit-001');
  });

});

// ─── Standard Event Structure ─────────────────────────────────────────────────

describe('[P3] Parsed event always contains the required fields for downstream processing', () => {

  it('output includes all required fields — eventType, sourcePlatform, timestamp, rawPayload', () => {
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', wixPlanPurchasedPayload);

    expect(result).toMatchObject({
      eventType:      'plan.purchased',
      wixSiteId:      'site-001',
      sourcePlatform: 'wix',
      timestamp:      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      rawPayload:     wixPlanPurchasedPayload,
    });
  });

  it('sourcePlatform is always "wix" — required by DR-021 for member_identity uniqueness', () => {
    const result = wixAdapter.parseEvent('any.event', 'site-001', {});
    expect(result.sourcePlatform).toBe('wix');
  });

  it('passes through email and name from buyer data — used for hardware user creation', () => {
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', wixPlanPurchasedPayload);
    expect(result.email).toBe('chad@houseofgains.com');
    expect(result.name).toBe('Chad Member');
  });

});

// ─── REST Webhook Format (data.metadata + data.entity) ──────────────────────

describe('[P3] Wix REST webhook format (data.entity) resolves correctly', () => {

  it('normalizes wixPricingPlans.orderCreated → plan.purchased', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderCreated', 'site-001', wixRestOrderCreatedPayload);
    expect(result.eventType).toBe('plan.purchased');
  });

  it('normalizes wixPricingPlans.orderUpdated → plan.purchased', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderUpdated', 'site-001', wixRestOrderCreatedPayload);
    expect(result.eventType).toBe('plan.purchased');
  });

  it('normalizes wixPricingPlans.orderCanceled → plan.cancelled', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderCanceled', 'site-001', wixRestOrderCreatedPayload);
    expect(result.eventType).toBe('plan.cancelled');
  });

  it('normalizes wixMembers.memberDeleted → member.deleted', () => {
    const result = wixAdapter.parseEvent('wixMembers.memberDeleted', 'site-001', wixRestMemberDeletedPayload);
    expect(result.eventType).toBe('member.deleted');
  });

  it('resolves memberId from REST webhook entity.buyer.memberId', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderCreated', 'site-001', wixRestOrderCreatedPayload);
    expect(result.platformMemberId).toBe(WIX_MEMBER_ID);
  });

  it('resolves planId from REST webhook entity.planId', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderCreated', 'site-001', wixRestOrderCreatedPayload);
    expect(result.planId).toBe(CONNECT_PLAN_ID);
  });

  it('resolves email and name from REST webhook entity.buyer', () => {
    const result = wixAdapter.parseEvent('wixPricingPlans.orderCreated', 'site-001', wixRestOrderCreatedPayload);
    expect(result.email).toBe('chad@houseofgains.com');
    expect(result.name).toBe('Chad Member');
  });

  it('resolves memberId from REST webhook member deleted entity', () => {
    const result = wixAdapter.parseEvent('wixMembers.memberDeleted', 'site-001', wixRestMemberDeletedPayload);
    expect(result.platformMemberId).toBe(WIX_MEMBER_ID);
  });

});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('[P3] Edge cases that could cause silent wrong-member provisioning', () => {

  it('does not mix up memberId from a nested double-wrapped payload', () => {
    const doubleWrapped = {
      data: {
        data: {
          order: {
            buyer: { memberId: 'inner-member-id' },
            planId: 'inner-plan-id'
          }
        }
      }
    };
    const result = wixAdapter.parseEvent('plan.purchased', 'site-001', doubleWrapped);
    // Should resolve via the deep fallback path
    expect(result.platformMemberId).toBe('inner-member-id');
  });

  it('handles completely empty body without throwing', () => {
    expect(() => wixAdapter.parseEvent('plan.purchased', null, {})).not.toThrow();
    expect(() => wixAdapter.parseEvent('plan.purchased', null, null)).not.toThrow();
  });

});
