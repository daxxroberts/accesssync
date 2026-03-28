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
    // [ASSUMPTION: OB-03-A] Payload field paths require PARSE verification against Wix webhook docs.
    return {
      eventType,
      wixSiteId,
      sourcePlatform: 'wix',                                    // DR-021: all adapters set this
      platformMemberId: body?.data?.memberId || body?.memberId, // DR-021: was wixMemberId
      planId: body?.data?.planId || body?.planId,
      email: body?.data?.email || body?.email || null,
      name: body?.data?.name || body?.name || null,
      timestamp: new Date().toISOString(),
      rawPayload: body
    };
  }
}

module.exports = new WixAdapter();
