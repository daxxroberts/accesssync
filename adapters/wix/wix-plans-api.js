/**
 * wix-plans-api.js
 * Outbound Wix API client for fetching pricing plans, booking services, and member identity.
 * Used by the plan mapping page and the nightly reconciliation correction sweep.
 *
 * Requires: Wix API key stored encrypted in clients.source_api_key
 * Docs: https://dev.wix.com/docs/rest/api-reference/wix-pricing-plans
 *       https://dev.wix.com/docs/rest/api-reference/wix-bookings
 *       https://dev.wix.com/docs/rest/api-reference/members
 *       https://dev.wix.com/docs/rest/api-reference/contacts
 */

const { log } = require('../../core/logger');
const { RateLimiter } = require('../../core/rate-limiter');

const WIX_API_BASE = 'https://www.wixapis.com';

// Shared limiter for this file. Wix documents a 10 req/sec REST cap.
// Module-scoped — every caller of listPricingPlans / listBookingServices / etc. contends
// against the same bucket. Critical for nightly reconciliation which page-walks orders.
const limiter = new RateLimiter({ rate: 10, windowMs: 1000, name: 'wix-plans' });

/**
 * Make an authenticated request to the Wix REST API.
 */
async function wixFetch(path, apiKey, siteId, options = {}) {
  await limiter.acquire();
  const url = `${WIX_API_BASE}${path}`;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': apiKey,
      'Content-Type': 'application/json',
      'wix-site-id': siteId,
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');

    const statusMap = {
      401: {
        code: 'WIX_KEY_INVALID',
        userMessage: "Your Wix API key was rejected. It may have expired or been revoked.",
        action: 'Go to System Config and update your Wix API key.',
        resolution: 'UPDATE_WIX_KEY',
      },
      403: {
        code: 'WIX_KEY_PERMISSIONS',
        userMessage: "Your Wix API key doesn't have the permissions AccessSync needs.",
        action: 'Regenerate your Wix API key with Pricing Plans and Bookings read permissions.',
        resolution: 'UPDATE_WIX_KEY',
      },
    };

    const mapped = statusMap[res.status] || {
      code: 'WIX_API_ERROR',
      userMessage: `Wix returned an unexpected error (${res.status}).`,
      action: 'Try refreshing. If the problem persists, contact AccessSync support.',
      resolution: 'RETRY',
    };

    const err = new Error(`Wix API ${res.status}: ${text.slice(0, 200)}`);
    err.statusCode = res.status;
    err.code = mapped.code;
    err.userMessage = mapped.userMessage;
    err.action = mapped.action;
    err.resolution = mapped.resolution;
    throw err;
  }
  return res.json();
}

/**
 * List all pricing plans for a Wix site.
 * Returns normalized plan objects.
 */
function extractWixPrice(p) {
  try {
    const pricing = p.pricing;
    if (!pricing) return null;

    // Subscription plan
    if (pricing.subscription) {
      const sub = pricing.subscription;
      const fee = sub.price?.value || sub.cyclePrice?.value;
      const currency = sub.price?.currency || sub.cyclePrice?.currency || 'USD';
      const dur = sub.cycleDuration;
      if (fee != null && dur) {
        const amount = parseFloat(fee);
        const symbol = currency === 'USD' ? '$' : currency;
        const count = dur.count || 1;
        const unit = (dur.unit || 'MONTH').toLowerCase();
        const period = count === 1
          ? (unit.startsWith('year') ? 'yr' : unit.startsWith('week') ? 'wk' : 'mo')
          : `${count} ${unit}s`;
        return `${symbol}${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}/${period}`;
      }
    }

    // One-time / single payment
    if (pricing.oneTimeFee) {
      const fee = pricing.oneTimeFee?.price?.value;
      const currency = pricing.oneTimeFee?.price?.currency || 'USD';
      if (fee != null) {
        const amount = parseFloat(fee);
        const symbol = currency === 'USD' ? '$' : currency;
        return `${symbol}${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)} one-time`;
      }
    }

    // Singleplan / singlePaymentForDuration
    if (pricing.singlePaymentForDuration || pricing.singlePayment) {
      const block = pricing.singlePaymentForDuration || pricing.singlePayment;
      const fee = block?.price?.value;
      const currency = block?.price?.currency || 'USD';
      if (fee != null) {
        const amount = parseFloat(fee);
        const symbol = currency === 'USD' ? '$' : currency;
        return `${symbol}${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)} one-time`;
      }
    }
  } catch (_) { /* non-blocking */ }
  return null;
}

async function listPricingPlans(apiKey, siteId) {
  try {
    const data = await wixFetch('/pricing-plans/v2/plans', apiKey, siteId);
    const plans = data.plans || [];
    log.info('wix.pricing_plans.fetched', { siteId, count: plans.length });
    return plans.map(p => ({
      id: p._id || p.id,
      name: p.name || 'Unnamed Plan',
      type: 'pricing_plan',
      description: p.description || '',
      status: p.archived ? 'archived' : (p.primary ? 'primary' : 'active'),
      slug: p.slug || null,
      wixPrice: extractWixPrice(p),
    }));
  } catch (err) {
    log.error('wix.pricing_plans.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    return [];
  }
}

/**
 * List all booking services for a Wix site.
 * Returns normalized service objects.
 * Uses Bookings Services V2 API (POST query pattern).
 */
async function listBookingServices(apiKey, siteId) {
  try {
    const data = await wixFetch('/_api/bookings/v2/services/query', apiKey, siteId, {
      method: 'POST',
      body: { query: {} },
    });
    const services = data.services || [];
    log.info('wix.booking_services.fetched', { siteId, count: services.length });
    return services.map(s => ({
      id: s.id,
      name: s.name || 'Unnamed Service',
      type: 'booking_service',
      description: s.description || '',
      status: s.hidden ? 'hidden' : 'active',
      slug: s.mainSlug?.name || s.supportedSlugs?.[0]?.name || null,
    }));
  } catch (err) {
    log.error('wix.booking_services.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    return [];
  }
}

/**
 * List all mappable items (pricing plans + booking services) for a Wix site.
 * Calls both APIs in parallel and merges into a unified list.
 */
async function listAllMappable(apiKey, siteId) {
  const [plans, services] = await Promise.all([
    listPricingPlans(apiKey, siteId),
    listBookingServices(apiKey, siteId),
  ]);
  return [...plans, ...services];
}

/**
 * List all active pricing plan orders for a Wix site.
 * Used by nightly reconciliation to discover members who paid but were never provisioned.
 * Returns normalized order objects — one per active plan holder.
 *
 * OB-85/87: The v2 /orders/query POST endpoint was removed by Wix (returns 503 FUNCTION_REMOVED).
 * Replacement is GET /pricing-plans/v2/orders with query-string paging. Client-side filters
 * for status === 'ACTIVE' since the GET variant doesn't accept a filter parameter.
 * Throws on failure so reconciliation can abort instead of false-revoking.
 */
async function listActiveOrders(apiKey, siteId) {
  const allOrders = [];
  let offset = 0;
  const limit = 50;

  try {
    while (true) {
      const path = `/pricing-plans/v2/orders?limit=${limit}&offset=${offset}`;
      const data = await wixFetch(path, apiKey, siteId);
      const orders = data.orders || [];

      // OB-188 PROBE — dump the raw shape of the FIRST page only, before filtering.
      // Wix UI shows 4 active subs for Daxx but reconcile only sees 1 — need to see
      // what fields actually come back. Elevated to warn so it lands in diagnostic_log.
      if (offset === 0) {
        log.warn('wix.active_orders.probe', {
          siteId,
          pagingMetadata: data.pagingMetadata || null,
          orderCount: orders.length,
          sample: orders.slice(0, 8).map(o => ({
            keys:        Object.keys(o).slice(0, 30),
            status:      o.status,
            planId:      o.planId,
            buyer:       o.buyer ? Object.keys(o.buyer) : null,
            memberId:    o.buyer?.memberId || null,
            contactId:   o.buyer?.contactId || null,
            _id:         o._id || null,
            id:          o.id || null,
            orderId:     o.orderId || null,
            hasPricing:  !!o.pricing,
          })),
        });
      }

      for (const o of orders) {
        if (o.status !== 'ACTIVE') continue;
        allOrders.push({
          memberId: o.buyer?.memberId || o.buyer?.contactId || null,
          planId:   o.planId || null,
          email:    null,
          name:     null,
          // OB-187: pass through the raw order shape so reconcile can build a
          // billing snapshot for legacy members who never came in via a webhook.
          // extractBillingSnapshot expects { data: { entity: <order> } } — we
          // wrap here so the caller doesn't have to know the webhook envelope.
          rawOrder: o,
        });
      }
      if (orders.length < limit) break;
      offset += limit;
    }
    log.info('wix.active_orders.fetched', { siteId, count: allOrders.length });
    return allOrders;
  } catch (err) {
    log.error('wix.active_orders.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    throw err;
  }
}

/**
 * List all confirmed bookings for a Wix site.
 * Used by nightly reconciliation alongside active orders — booking members
 * don't have pricing plan orders but should have access while their booking is confirmed.
 * Returns normalized booking objects — serviceId serves as the planId equivalent.
 */
async function listConfirmedBookings(apiKey, siteId) {
  const allBookings = [];
  let cursor = null;
  const limit = 100;

  // OB-86/87: Bookings V1 /_api/bookings/v2/bookings/query returned HTML 404
  // (wrong path). The correct endpoint is the Bookings Reader V2 API at
  // /_api/bookings-reader/v2/extended-bookings/query. Response key is
  // `extendedBookings` (not `bookings`) and pagination is cursor-based.
  // Throws on failure to protect reconciliation from false-revokes.
  try {
    while (true) {
      const query = {
        cursorPaging: cursor ? { limit, cursor } : { limit },
      };
      const data = await wixFetch('/_api/bookings-reader/v2/extended-bookings/query', apiKey, siteId, {
        method: 'POST',
        body: { query },
      });
      const bookings = data.extendedBookings || data.bookings || [];
      for (const b of bookings) {
        const booking = b.booking || b;
        if (booking.status && booking.status !== 'CONFIRMED') continue;
        allBookings.push({
          memberId: booking.contactId || null,
          planId:   booking.bookedEntity?.serviceId || booking.serviceId || null,
          email:    booking.contactDetails?.email || null,
          name:     booking.contactDetails?.firstName
            ? `${booking.contactDetails.firstName} ${booking.contactDetails.lastName || ''}`.trim()
            : null,
        });
      }
      cursor = data.pagingMetadata?.cursors?.next || null;
      if (!cursor || bookings.length < limit) break;
    }
    log.info('wix.confirmed_bookings.fetched', { siteId, count: allBookings.length });
    return allBookings;
  } catch (err) {
    log.error('wix.confirmed_bookings.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    throw err;
  }
}

/**
 * Validate a Wix API key by making a lightweight API call.
 * Returns { valid: true } or { valid: false, error: '...' }
 */
async function testApiKey(apiKey, siteId) {
  try {
    await wixFetch('/pricing-plans/v2/plans', apiKey, siteId);
    return { valid: true };
  } catch (err) {
    if (err.statusCode === 401) return { valid: false, error: 'Invalid API key — Wix rejected it' };
    if (err.statusCode === 403) return { valid: false, error: 'API key lacks required permissions' };
    return { valid: false, error: err.message };
  }
}

module.exports = { listPricingPlans, listBookingServices, listAllMappable, testApiKey, listActiveOrders, listConfirmedBookings };
