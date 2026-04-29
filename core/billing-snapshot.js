/**
 * @file billing-snapshot.js
 * @layer core/shared
 * @role billing-snapshot-extractor
 * @reads (pure)
 * @writes (pure)
 * @consumed-by core/grant-revoke.js
 * @exports extractBillingSnapshot
 * @dr DR-042
 *
 * Pure extractor — given a Wix order webhook raw payload, returns a
 * canonicalised billing snapshot for storage on member_role_assignments.
 *
 * Display-only. Never used to gate grant/revoke decisions.
 *
 * Returns null when the payload is missing pricing data entirely (e.g.
 * member.deleted events, malformed payloads). Defensive — never throws.
 */

'use strict';

/**
 * @param {object} rawPayload  The full webhook payload as stored in webhook_log.raw_payload
 *                             Shape: { data: { entity: {...} }, eventType: '...' }
 * @returns {object|null}      Canonical billing snapshot or null when extraction yields no data.
 */
function extractBillingSnapshot(rawPayload) {
  try {
    const entity = rawPayload?.data?.entity || rawPayload?.data || rawPayload?.entity;
    if (!entity || typeof entity !== 'object') return null;

    const pricing = entity.pricing || null;
    const firstPrice = pricing?.prices?.[0]?.price || null;
    const subscription = pricing?.subscription || null;
    const cycleDuration = subscription?.cycleDuration || null;

    // If absolutely nothing pricing-related is present, snapshot is meaningless.
    // Return null so callers can omit the column rather than store noise.
    if (!entity.planPrice && !pricing) return null;

    const couponObj = firstPrice?.coupon || null;
    const coupon = couponObj && couponObj.code
      ? { code: couponObj.code, amount: couponObj.amount || null }
      : null;

    const cycleCountRaw = cycleDuration?.count;
    const cycleCount = (cycleCountRaw == null) ? null : Number(cycleCountRaw);

    return {
      planPrice:         entity.planPrice         || null,
      cycleUnit:         cycleDuration?.unit      || null,
      cycleCount:        Number.isFinite(cycleCount) ? cycleCount : null,
      currency:          firstPrice?.currency     || null,
      total:             firstPrice?.total        || null,
      subtotal:          firstPrice?.subtotal     || null,
      discount:          firstPrice?.discount     || null,
      coupon,
      autoRenewCanceled: entity.autoRenewCanceled === true,
      lastPaymentStatus: entity.lastPaymentStatus || null,
      subscriptionId:    entity.subscriptionId    || null,
      orderMethod:       entity.orderMethod       || null,
      orderId:           entity._id               || null,
      capturedAt:        new Date().toISOString(),
    };
  } catch (_) {
    // Pricing extraction must never break grant flow.
    return null;
  }
}

module.exports = { extractBillingSnapshot };
