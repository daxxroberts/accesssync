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
    const map = {
      'wixPricingPlans.orderCreated':   'plan.purchased',
      'wixPricingPlans.orderUpdated':   'plan.purchased',  // covers renewals + upgrades
      'wixPricingPlans.orderCanceled':  'plan.cancelled',
      'wixPricingPlans.orderCancelled': 'plan.cancelled',  // British spelling variant
      'wixPricingPlans.orderExpired':   'plan.cancelled',
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
    const normalizedEventType = this._normalizeEventType(eventType);
    if (normalizedEventType !== eventType) {
      log.info('wix.parse.event_type_normalized', { raw: eventType, normalized: normalizedEventType });
    }

    // P6: Field paths resolved for Wix Velo backend event handlers.
    // events.js sends { eventType, data: event } where event is the Wix handler param.
    // Structure varies by event module:
    //   wixPricingPlans: event.order.buyer.memberId, event.order.planId
    //   wixBookings:     event.booking.contactId (→ needs Wix member lookup)
    //   wixMembers:      event.member.id or event.memberId

    const d = body?.data;  // The raw Wix event object from events.js _send()
    const entity = d?.entity;  // REST webhook format: data.entity is the Order/Booking/Member object

    // Resolve memberId — try each Wix module's known path
    const memberId =
      entity?.buyer?.memberId     ||  // REST webhook: entity is the Order object
      entity?.buyer?.contactId    ||  // REST webhook: contactId fallback
      d?.order?.buyer?.memberId   ||  // Velo events.js: wixPricingPlans events
      d?.booking?.contactId       ||  // Velo events.js: wixBookings events
      d?.member?._id              ||  // Velo events.js: wixMembers events (member deleted)
      entity?.member?._id         ||  // REST webhook: member deleted
      entity?.contactId           ||  // REST webhook: booking contactId
      d?.memberId                 ||  // direct field (some event shapes)
      d?.data?.order?.buyer?.memberId || // double-wrapped edge case
      body?.memberId              ||  // top-level fallback
      null;

    // Resolve planId
    const planId =
      entity?.planId              ||  // REST webhook: entity is the Order object
      entity?.planName            ||  // REST webhook: planName fallback
      d?.order?.planId            ||  // Velo events.js: wixPricingPlans events
      d?.order?.planName          ||  // Velo events.js: planName fallback
      d?.booking?.serviceId       ||  // Velo events.js: wixBookings
      entity?.serviceId           ||  // REST webhook: booking serviceId
      d?.planId                   ||  // direct field
      d?.data?.order?.planId      ||  // double-wrapped edge case
      body?.planId                ||  // top-level fallback
      null;

    // Resolve email/name from buyer or member data
    const email =
      entity?.buyer?.email        ||  // REST webhook
      d?.order?.buyer?.email      ||  // Velo events.js
      entity?.member?.loginEmail  ||  // REST webhook: member event
      d?.member?.loginEmail       ||  // Velo events.js: member event
      d?.email                    ||
      body?.email                 ||
      null;
    const name =
      entity?.buyer?.fullName     ||  // REST webhook
      d?.order?.buyer?.fullName   ||  // Velo events.js
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
      email,
      name,
      timestamp: new Date().toISOString(),
      rawPayload: body
    };
  }
}

module.exports = new WixAdapter();
