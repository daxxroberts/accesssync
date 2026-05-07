/**
 * wix-adapter.js
 * Wix Adapter Layer (Layer 2)
 *
 * Responsibilities:
 * - Wix-specific payload parsing only
 * - parseEvent() returns AccessSync standard event object
 * - Depends only on core/logger for structured logging
 *
 * Called by wix-connector (Layer 1) after HMAC verification passes.
 */

const { log } = require('../../core/logger');

class WixAdapter {

  /**
   * Parses a Wix webhook body into the AccessSync standard event format.
   *
   * @param {string} eventType   e.g. 'plan.purchased'
   * @param {string|null} wixSiteId
   * @param {Object} body        raw Wix webhook body
   * @returns {Object} standard event
   */
  /**
   * Maps Wix REST webhook eventType strings to AccessSync internal event names.
   * Wix REST webhooks use dot-namespaced types like 'wixPricingPlans.orderCreated'.
   * Velo events.js sends short types like 'plan.purchased' directly.
   */
  _normalizeEventType(eventType) {
    // orderPurchased: fires on payment confirmation for paid plans, and on acceptance for
    // free plans. This is the canonical grant trigger — payment is confirmed at this point.
    // orderCreated fires before payment (DRAFT/PENDING state) and is intentionally excluded
    // to prevent provisioning access before a member finishes paying.
    // orderStarted fires when the order's startDate arrives — required for delayed-start plans
    // where orderPurchased fires weeks before the member's access window opens.
    const map = {
      'wixPricingPlans.orderPurchased': 'plan.purchased',
      'wixPricingPlans.orderStarted':   'plan.started',   // fires when startDate arrives — phase 2 of delayed-start grant
      'wixPricingPlans.orderUpdated':   'plan.purchased',  // covers renewals + upgrades
      'wixPricingPlans.orderCanceled':          'plan.cancelled',
      'wixPricingPlans.orderCancelled':         'plan.cancelled',  // British spelling variant
      'wixPricingPlans.orderAutoRenewCanceled': 'plan.cancelled',  // member cancels, access ends at next billing date
      'wixPricingPlans.orderEnded':             'plan.cancelled',  // natural expiry or deferred cancel completion
      'wixPricingPlans.orderExpired':           'plan.cancelled',  // legacy / non-standard variant, kept for safety
      'wixPricingPlans.orderPaused':    'payment.failed',
      'wixPricingPlans.orderResumed':   'payment.recovered',
      'wixBookings.bookingCreated':     'booking.confirmed',
      'wixBookings.bookingCanceled':    'booking.cancelled',
      'wixBookings.bookingCancelled':   'booking.cancelled',
      'wixMembers.memberDeleted':       'member.deleted',
    };
    return map[eventType] || eventType;
  }

  parseEvent(eventType, wixSiteId, body) {
    // Normalize Wix REST webhook event type strings to internal names
    let normalizedEventType = this._normalizeEventType(eventType);
    if (normalizedEventType !== eventType) {
      log.info('wix.parse.event_type_normalized', { raw: eventType, normalized: normalizedEventType });
    }

    // Payment-status guard. Wix fires plan.purchased / plan.started / plan.purchased
    // (from orderUpdated) for orders in any state — including DRAFT/UNPAID, which
    // happens when checkout fails (e.g., billing-address validation). Without this
    // guard, AccessSync would provision access for an order the member never paid for.
    //
    // Rule: a Wix order grants access only when status='ACTIVE' AND lastPaymentStatus
    // ∈ {PAID, TRIAL}. Anything else is dropped — the eventType is rewritten to
    // 'plan.unpaid_order' so the row still lands in webhook_log (audit trail
    // preserved) but queue-worker has no case for it, so no grant fires.
    const GRANT_TRIGGERS = ['plan.purchased', 'plan.started'];
    if (GRANT_TRIGGERS.includes(normalizedEventType)) {
      const orderEntity = body?.data?.entity || body?.data;
      const orderStatus = orderEntity?.status || null;
      const paymentStatus = orderEntity?.lastPaymentStatus || null;
      const ALLOWED_STATUS  = new Set(['ACTIVE']);
      const ALLOWED_PAYMENT = new Set(['PAID', 'TRIAL', null]); // null = not yet set on free plans
      const statusOk  = !orderStatus  || ALLOWED_STATUS.has(orderStatus);
      const paymentOk = ALLOWED_PAYMENT.has(paymentStatus);
      if (!statusOk || !paymentOk) {
        log.warn('wix.parse.unpaid_order_dropped', {
          rawEventType:    eventType,
          normalizedEvent: normalizedEventType,
          orderStatus,
          paymentStatus,
          orderId:         orderEntity?._id || null,
          planId:          orderEntity?.planId || null,
          memberId:        orderEntity?.buyer?.memberId || null,
        });
        normalizedEventType = 'plan.unpaid_order';
      }
    }

    // P6: Field paths resolved for Wix Velo backend event handlers.
    // events.js sends { eventType, data: event } where event is the Wix handler param.
    // Structure varies by event module:
    //   wixPricingPlans: event.order.buyer.memberId, event.order.planId
    //   wixBookings:     event.booking.contactId (→ needs Wix member lookup)
    //   wixMembers:      event.member.id or event.memberId

    const d = body?.data;  // The raw Wix event object from events.js _send()
    const entity = d?.entity;  // REST webhook format: data.entity is the Order/Booking/Member object

    // Resolve memberId — try each Wix module's known path.
    // Wix Order Object docs: buyer.memberId is at the Order root (not wrapped in .order).
    // Velo handler signature: wixPricingPlans_onOrderCreated(event) — event IS the Order object.
    const memberId =
      entity?.buyer?.memberId     ||  // REST webhook: entity is the Order object
      entity?.buyer?.contactId    ||  // REST webhook: contactId fallback
      d?.buyer?.memberId          ||  // Velo wixPricingPlans: data IS the Order object directly
      d?.buyer?.contactId         ||  // Velo wixPricingPlans: contactId fallback
      d?.order?.buyer?.memberId   ||  // legacy wrapper path (kept for compat)
      d?.booking?.contactId       ||  // Velo events.js: wixBookings events
      d?.member?._id              ||  // Velo events.js: wixMembers events (member deleted)
      entity?.member?._id         ||  // REST webhook: member deleted
      entity?.contactId           ||  // REST webhook: booking contactId
      d?.memberId                 ||  // direct field (some event shapes)
      d?.data?.order?.buyer?.memberId || // double-wrapped edge case
      body?.memberId              ||  // top-level fallback
      null;

    // Resolve planId — Wix Order Object: planId is at the Order root.
    const planId =
      entity?.planId              ||  // REST webhook: entity is the Order object
      entity?.planName            ||  // REST webhook: planName fallback
      d?.planId                   ||  // Velo wixPricingPlans: data IS the Order object directly
      d?.planName                 ||  // Velo wixPricingPlans: planName fallback
      d?.order?.planId            ||  // legacy wrapper path (kept for compat)
      d?.order?.planName          ||  // legacy wrapper planName fallback
      d?.booking?.serviceId       ||  // Velo events.js: wixBookings
      entity?.serviceId           ||  // REST webhook: booking serviceId
      d?.data?.order?.planId      ||  // double-wrapped edge case
      body?.planId                ||  // top-level fallback
      null;

    // Resolve startDate — present on Order object when orderStarted fires (delayed-start plans)
    const startDate =
      entity?.startDate  ||   // REST webhook: entity is the Order object
      d?.startDate       ||   // Velo events.js: data IS the Order object directly
      body?.startDate    ||   // top-level fallback
      null;

    // Resolve billing fields from the Wix Order object — stored for record-keeping,
    // not used to drive access decisions (Wix events remain the sole revocation trigger)
    const wixOrderId =
      entity?._id        ||   // REST webhook: Order._id
      d?._id             ||   // Velo: data IS the Order object
      d?.order?._id      ||   // legacy wrapper
      body?.orderId      ||
      null;
    const wixSubscriptionId =
      entity?.subscriptionId ||
      d?.subscriptionId      ||
      d?.order?.subscriptionId ||
      null;
    const planName =
      entity?.planName   ||
      d?.planName        ||
      d?.order?.planName ||
      null;
    const endDate =
      entity?.endDate    ||
      d?.endDate         ||
      d?.order?.endDate  ||
      null;
    const cycleIndex =
      entity?.currentCycle?.index  ||
      d?.currentCycle?.index       ||
      d?.order?.currentCycle?.index ||
      null;

    // Resolve email/name from buyer or member data
    const email =
      entity?.buyer?.email        ||  // REST webhook
      d?.buyer?.email             ||  // Velo: data IS the Order object
      d?.order?.buyer?.email      ||  // legacy wrapper
      entity?.member?.loginEmail  ||  // REST webhook: member event
      d?.member?.loginEmail       ||  // Velo events.js: member event
      d?.email                    ||
      body?.email                 ||
      null;
    const name =
      entity?.buyer?.fullName     ||  // REST webhook
      d?.buyer?.fullName          ||  // Velo: data IS the Order object
      d?.order?.buyer?.fullName   ||  // legacy wrapper
      entity?.member?.name        ||  // REST webhook: member event
      d?.member?.name             ||  // Velo events.js: member event
      d?.name                     ||
      body?.name                  ||
      null;

    if (!memberId) {
      log.warn('wix.parse.no_member_id', { eventType: normalizedEventType, dataKeys: d ? Object.keys(d).join(',') : 'null' });
    }
    if (!planId && normalizedEventType && !normalizedEventType.includes('member.deleted')) {
      log.warn('wix.parse.no_plan_id', { eventType: normalizedEventType, dataKeys: d ? Object.keys(d).join(',') : 'null' });
    }

    return {
      eventType: normalizedEventType,
      wixSiteId,
      sourcePlatform: 'wix',         // DR-021
      platformMemberId: memberId,     // DR-021
      planId,
      planName,
      startDate,
      endDate,
      wixOrderId,
      wixSubscriptionId,
      cycleIndex,
      email,
      name,
      timestamp: new Date().toISOString(),
      rawPayload: body
    };
  }
}

module.exports = new WixAdapter();
