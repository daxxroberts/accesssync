/**
 * wix-adapter.js
 * Wix Adapter Layer (Layer 2)
 *
 * Responsibilities:
 * - Wix-specific payload parsing only
 * - parseEvent() returns AccessSync standard event object
 * - Depends only on core/logger for structured logging and the pure
 *   core/wix-order-classification constants (shared paying rule)
 *
 * Called by wix-connector (Layer 1) after HMAC verification passes.
 */

const { log } = require('../../core/logger');
const { PAYING_PAYMENT_STATUSES } = require('../../core/wix-order-classification');

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
      // Auto-renew hotfix (2026-09-10): orderAutoRenewCanceled means the member
      // turned off auto-renew — the order stays ACTIVE and PAID until its end
      // date, and Wix fires orderEnded then. Mapping it to plan.cancelled
      // revoked a paid member's door access immediately, weeks early.
      // 'plan.autorenew_cancelled' is deliberately NON-ROUTABLE: it is in
      // neither list in core/event-routing.js, so webhook-processor logs
      // webhook.unrecognised_type, keeps the webhook_log row for audit, and
      // enqueues nothing. Access ends on orderEnded / orderCanceled below.
      'wixPricingPlans.orderAutoRenewCanceled': 'plan.autorenew_cancelled',
      'wixPricingPlans.orderEnded':             'plan.cancelled',  // natural expiry or deferred cancel completion
      'wixPricingPlans.orderExpired':           'plan.cancelled',  // legacy / non-standard variant, kept for safety
      'wixPricingPlans.orderPaused':    'payment.failed',
      'wixPricingPlans.orderResumed':   'payment.recovered',
      'wixBookings.bookingCreated':     'booking.confirmed',
      'wixBookings.bookingCanceled':    'booking.cancelled',
      'wixBookings.bookingCancelled':   'booking.cancelled',
      'wixMembers.memberDeleted':       'member.deleted',
      // OB-98 day pass: a one-off pass is sold as a Wix STORES product, because
      // Pricing Plans cannot go below a 7-day length (verified 2026-09-14). A paid
      // store order is a grant trigger exactly like a plan purchase — the mapped
      // "plan" is the product, and the access window comes from the mapping's
      // day_pass_hours, not from the order (a store order has no end date).
      'wixStores.orderPaid':            'store.order_paid',
    };
    return map[eventType] || eventType;
  }

  /**
   * OB-98 — pull the fields a Wix Stores order carries that a Pricing Plans order
   * does not: the catalog item id of every line item (what Plan Mapping maps), and
   * a buyer email that is actually present (plan webhooks omit it, which is why the
   * day-pass grant has to recover the address from the Members API).
   *
   * Guest checkout is normal here: `buyerInfo.memberId` is absent for a visitor who
   * never logs in, so the contact id is the identity anchor instead. Either way the
   * value lands in platformMemberId and member_master keys off it as usual.
   */
  _parseStoreOrder(body) {
    const d = body?.data;
    const order = d?.order || d?.entity || d || {};
    const buyer = order.buyerInfo || {};
    const lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];

    const lineItemPlanIds = lineItems
      .map(li =>
        li?.catalogReference?.catalogItemId ||
        li?.catalogItemId ||
        li?.productId ||
        li?.productName?.original && null ||
        null
      )
      .filter(Boolean);

    // Per-item name + quantity: every unit bought gets its own door code, so the
    // worker needs to know that "2-Day Pass x3" is three passes, not one.
    const itemId = li =>
      li?.catalogReference?.catalogItemId || li?.catalogItemId || li?.productId || null;
    const lineItemDetails = lineItems
      .map(li => ({
        id:       itemId(li),
        name:     (typeof li?.productName === 'object' ? li.productName.original : li?.productName) || li?.name || null,
        quantity: Number.isInteger(li?.quantity) && li.quantity > 0 ? li.quantity : 1,
      }))
      .filter(d => d.id);

    const lineItemNames = lineItems
      .map(li => (typeof li?.productName === 'object' ? li.productName.original : li?.productName) || li?.name || null)
      .filter(Boolean);

    // Velo's wixStores_onOrderPaid sends buyerInfo as { id, identityType, email, ... }
    // (verified against dev.wix.com 2026-09-18) — identityType 'MEMBER' is a logged-in
    // site member, 'CONTACT' a guest checkout. The eCom REST shape uses memberId /
    // contactId instead, so both are read.
    const buyerId  = buyer.memberId || buyer.id || buyer.contactId || order.memberId || null;
    const isMember = buyer.identityType ? buyer.identityType === 'MEMBER' : !!buyer.memberId;

    return {
      memberId: buyerId,
      lineItemPlanIds,
      lineItemDetails,
      planName: lineItemNames[0] || null,
      orderId:  order._id || order.id || null,
      email:    buyer.email || null,
      name:     [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || null,
      isGuest:  !isMember,
    };
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
    //
    // The paying payment statuses come from core/wix-order-classification.js so
    // the webhook and the nightly sweep share one rule. isPayingOrder() is NOT
    // used here on purpose: this guard lets a payload with NO status through
    // (Velo short-form events carry no order status), while isPayingOrder
    // requires status === 'ACTIVE'. Behaviour here is unchanged.
    const GRANT_TRIGGERS = ['plan.purchased', 'plan.started'];
    if (GRANT_TRIGGERS.includes(normalizedEventType)) {
      // orderPurchased / orderStarted arrive double-wrapped ({ data: { data: { order } } }),
      // orderUpdated as { data: { entity } } — verified in production webhook_log 2026-09-14.
      const orderEntity = body?.data?.entity || body?.data?.data?.order || body?.data;
      const orderStatus = orderEntity?.status || null;
      const paymentStatus = orderEntity?.lastPaymentStatus || null;
      const ALLOWED_STATUS  = new Set(['ACTIVE']);
      const statusOk  = !orderStatus  || ALLOWED_STATUS.has(orderStatus);
      const paymentOk = PAYING_PAYMENT_STATUSES.includes(paymentStatus); // null = not yet set on free plans
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
    // Every order field below also reads the double-wrapped shape (d.data.order) that
    // orderPurchased / orderStarted use — memberId/planId already did, the rest did not,
    // which left startDate/endDate/planName/orderId NULL on those events and only
    // populated on the orderUpdated echo. Day passes need endDate on the first event.
    const wrappedOrder = d?.data?.order;
    const startDate =
      entity?.startDate  ||   // REST webhook: entity is the Order object
      d?.startDate       ||   // Velo events.js: data IS the Order object directly
      wrappedOrder?.startDate ||
      body?.startDate    ||   // top-level fallback
      null;

    // Resolve billing fields from the Wix Order object — stored for record-keeping,
    // not used to drive access decisions (Wix events remain the sole revocation trigger)
    const wixOrderId =
      entity?._id        ||   // REST webhook: Order._id
      d?._id             ||   // Velo: data IS the Order object
      d?.order?._id      ||   // legacy wrapper
      wrappedOrder?._id  ||
      body?.orderId      ||
      null;
    const wixSubscriptionId =
      entity?.subscriptionId ||
      d?.subscriptionId      ||
      d?.order?.subscriptionId ||
      wrappedOrder?.subscriptionId ||
      null;
    const planName =
      entity?.planName   ||
      d?.planName        ||
      d?.order?.planName ||
      wrappedOrder?.planName ||
      null;
    const endDate =
      entity?.endDate    ||
      d?.endDate         ||
      d?.order?.endDate  ||
      wrappedOrder?.endDate ||
      null;
    const cycleIndex =
      entity?.currentCycle?.index  ||
      d?.currentCycle?.index       ||
      d?.order?.currentCycle?.index ||
      wrappedOrder?.currentCycle?.index ||
      null;

    // Resolve email/name from buyer or member data
    const email =
      entity?.buyer?.email        ||  // REST webhook
      d?.buyer?.email             ||  // Velo: data IS the Order object
      d?.order?.buyer?.email      ||  // legacy wrapper
      wrappedOrder?.buyer?.email  ||
      entity?.member?.loginEmail  ||  // REST webhook: member event
      d?.member?.loginEmail       ||  // Velo events.js: member event
      d?.email                    ||
      body?.email                 ||
      null;
    const name =
      entity?.buyer?.fullName     ||  // REST webhook
      d?.buyer?.fullName          ||  // Velo: data IS the Order object
      d?.order?.buyer?.fullName   ||  // legacy wrapper
      wrappedOrder?.buyer?.fullName ||
      entity?.member?.name        ||  // REST webhook: member event
      d?.member?.name             ||  // Velo events.js: member event
      d?.name                     ||
      body?.name                  ||
      null;

    // OB-98 — a Stores order carries its identity, its items and its buyer email in
    // a completely different shape from a plan order. Overlay those fields rather
    // than threading store paths through every resolver above.
    let storeOrder = null;
    if (normalizedEventType === 'store.order_paid') {
      storeOrder = this._parseStoreOrder(body);
      if (storeOrder.lineItemPlanIds.length === 0) {
        log.warn('wix.parse.store_order_no_items', { eventType: normalizedEventType });
      }
    }

    if (!memberId && !storeOrder) {
      log.warn('wix.parse.no_member_id', { eventType: normalizedEventType, dataKeys: d ? Object.keys(d).join(',') : 'null' });
    }
    if (!planId && !storeOrder && normalizedEventType && !normalizedEventType.includes('member.deleted')) {
      log.warn('wix.parse.no_plan_id', { eventType: normalizedEventType, dataKeys: d ? Object.keys(d).join(',') : 'null' });
    }

    const standardEvent = {
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

    if (storeOrder) {
      standardEvent.platformMemberId = storeOrder.memberId;
      // planId is the FIRST line item; lineItemPlanIds carries them all so the
      // worker can find whichever item is actually mapped in a mixed basket.
      standardEvent.planId          = storeOrder.lineItemPlanIds[0] || null;
      standardEvent.lineItemPlanIds = storeOrder.lineItemPlanIds;
      standardEvent.lineItemDetails = storeOrder.lineItemDetails;
      standardEvent.planName        = storeOrder.planName;
      standardEvent.wixOrderId      = storeOrder.orderId;
      standardEvent.email           = storeOrder.email;
      standardEvent.name            = storeOrder.name;
      standardEvent.isGuestCheckout = storeOrder.isGuest;
      // A store order has no end date — the window is the mapping's day_pass_hours.
      standardEvent.endDate         = null;
    }

    return standardEvent;
  }
}

module.exports = new WixAdapter();
