/**
 * wix-adapter.js
 * Wix Adapter Layer (Layer 2)
 *
 * Responsibilities:
 * - Wix-specific payload parsing only
 * - parseEvent() returns AccessSync standard event object
 * - Zero dependencies — pure transformation, no imports
 *
 * Called by wix-connector (Layer 1) after HMAC verification passes.
 */

class WixAdapter {

  /**
   * Parses a Wix webhook body into the AccessSync standard event format.
   *
   * @param {string} eventType   e.g. 'plan.purchased'
   * @param {string|null} wixSiteId
   * @param {Object} body        raw Wix webhook body
   * @returns {Object} standard event
   */
  parseEvent(eventType, wixSiteId, body) {
    // P6: Field paths resolved for Wix Velo backend event handlers.
    // events.js sends { eventType, data: event } where event is the Wix handler param.
    // Structure varies by event module:
    //   wixPricingPlans: event.order.buyer.memberId, event.order.planId
    //   wixBookings:     event.booking.contactId (→ needs Wix member lookup)
    //   wixMembers:      event.member.id or event.memberId

    const d = body?.data;  // The raw Wix event object from events.js _send()

    // Resolve memberId — try each Wix module's known path
    const memberId =
      d?.order?.buyer?.memberId   ||  // wixPricingPlans events
      d?.booking?.contactId       ||  // wixBookings events (contactId maps to member)
      d?.member?._id              ||  // wixMembers events (member deleted)
      d?.memberId                 ||  // direct field (some event shapes)
      d?.data?.order?.buyer?.memberId || // double-wrapped edge case
      body?.memberId              ||  // top-level fallback
      null;

    // Resolve planId
    const planId =
      d?.order?.planId            ||  // wixPricingPlans events
      d?.order?.planName          ||  // fallback — name if ID missing
      d?.booking?.serviceId       ||  // wixBookings — service maps to plan
      d?.planId                   ||  // direct field
      d?.data?.order?.planId      ||  // double-wrapped edge case
      body?.planId                ||  // top-level fallback
      null;

    // Resolve email/name from buyer or member data
    const email =
      d?.order?.buyer?.email      ||
      d?.member?.loginEmail       ||
      d?.email                    ||
      body?.email                 ||
      null;
    const name =
      d?.order?.buyer?.fullName   ||
      d?.member?.name             ||
      d?.name                     ||
      body?.name                  ||
      null;

    if (!memberId) {
      console.warn(`[WixAdapter] No memberId resolved for ${eventType}. body.data keys: ${d ? Object.keys(d).join(',') : 'null'}`);
    }
    if (!planId && eventType && !eventType.includes('memberDeleted')) {
      console.warn(`[WixAdapter] No planId resolved for ${eventType}. body.data keys: ${d ? Object.keys(d).join(',') : 'null'}`);
    }

    return {
      eventType,
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
