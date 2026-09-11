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
const { classifyOrder } = require('../../core/wix-order-classification');

const WIX_API_BASE = 'https://www.wixapis.com';

// Pagination integrity (reconciliation safety pass, 2026-09-10).
// A list that is silently short is worse than a list that fails: the sweep
// reads "member missing from Wix" as "member stopped paying". So every
// page-walk below throws a WIX_PAGE_INTEGRITY error instead of returning a
// partial list when the response shape or the paging looks wrong. Callers
// already fail closed on a throw (reconciliation aborts the client's sync).
const WIX_MAX_PAGES = 200;

function wixIntegrityError(message, detail = {}) {
  const err = new Error(`Wix page integrity: ${message}`);
  err.code = 'WIX_PAGE_INTEGRITY';
  err.detail = detail;
  err.userMessage = 'Wix returned an incomplete or inconsistent list, so AccessSync skipped this sync rather than act on partial data.';
  err.action = 'No action needed — the next sync retries. If this repeats, contact AccessSync support.';
  err.resolution = 'RETRY';
  return err;
}

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
 * Page-walk EVERY pricing-plan order on a Wix site (all statuses), raw.
 * Internal — listActiveOrders and listOrdersClassified both build on it so
 * they share one set of integrity checks.
 *
 * OB-85/87: The v2 /orders/query POST endpoint was removed by Wix (returns 503 FUNCTION_REMOVED).
 * Replacement is GET /pricing-plans/v2/orders with query-string (offset) paging.
 * The GET variant doesn't accept a filter parameter, so callers filter client-side.
 *
 * Throws (never returns a partial list):
 *   - HTTP errors, via wixFetch (unchanged)
 *   - WIX_PAGE_INTEGRITY when a 200 body has no `orders` array ({} is NOT
 *     "zero orders"), when the same order id appears twice (offset drift —
 *     an order moved between pages, so another one may have been skipped),
 *     or when the walk needs more than WIX_MAX_PAGES pages.
 *
 * Orders with no id at all cannot be duplicate-checked; they are passed
 * through unchanged (the REST list always carries `id`).
 */
async function _fetchAllOrders(apiKey, siteId) {
  const allOrders = [];
  const seenIds = new Set();
  const limit = 50;
  let offset = 0;
  let pages = 0;

  while (true) {
    if (pages >= WIX_MAX_PAGES) {
      throw wixIntegrityError(`orders walk exceeded ${WIX_MAX_PAGES} pages`, { siteId, pages, limit });
    }
    const path = `/pricing-plans/v2/orders?limit=${limit}&offset=${offset}`;
    const data = await wixFetch(path, apiKey, siteId);
    pages += 1;

    if (!data || !Array.isArray(data.orders)) {
      throw wixIntegrityError('orders page has no orders array', { siteId, page: pages, offset });
    }
    const orders = data.orders;

    for (const o of orders) {
      // A null/primitive entry threw a TypeError here before; name it instead.
      if (!o || typeof o !== 'object') {
        throw wixIntegrityError('orders page contains a non-object entry', { siteId, page: pages, offset });
      }
      const id = o.id || o._id || null;
      if (id) {
        if (seenIds.has(id)) {
          throw wixIntegrityError('duplicate order id across pages', { siteId, page: pages, offset });
        }
        seenIds.add(id);
      }
      allOrders.push(o);
    }
    if (orders.length < limit) break;
    offset += limit;
  }
  return allOrders;
}

/**
 * List all active pricing plan orders for a Wix site.
 * Used by nightly reconciliation to discover members who paid but were never provisioned.
 * Returns normalized order objects — one per active plan holder.
 *
 * Contract unchanged by the 2026-09-10 safety pass: ACTIVE status only (any
 * payment status), same return shape. It now inherits _fetchAllOrders'
 * integrity checks. reconcileMember still depends on this exact filter.
 * Throws on failure so reconciliation can abort instead of false-revoking.
 */
async function listActiveOrders(apiKey, siteId) {
  const allOrders = [];

  try {
    const orders = await _fetchAllOrders(apiKey, siteId);
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
    log.info('wix.active_orders.fetched', { siteId, count: allOrders.length });
    return allOrders;
  } catch (err) {
    log.error('wix.active_orders.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    throw err;
  }
}

/**
 * List EVERY pricing-plan order for a Wix site (all statuses), each tagged
 * with its classification from core/wix-order-classification.js
 * (PAYING / PENDING / DECLINED / ENDED / UNKNOWN).
 *
 * Used by the nightly sweep so it can tell "stopped paying" apart from
 * "payment declined" or "checkout not finished" — listActiveOrders cannot,
 * because it keeps any ACTIVE order regardless of payment status.
 *
 * Returns [{ orderId, memberId, planId, classification, status,
 *            lastPaymentStatus, autoRenewCanceled, endDate, rawOrder }].
 * Orders with no buyer memberId/contactId are skipped (they cannot be tied
 * to a member) and counted in one wix.orders.no_member_id warn per call.
 *
 * Throws on any HTTP or integrity failure — never returns a partial list.
 */
async function listOrdersClassified(apiKey, siteId) {
  try {
    const orders = await _fetchAllOrders(apiKey, siteId);
    const out = [];
    let noMemberId = 0;

    for (const o of orders) {
      const memberId = o.buyer?.memberId || o.buyer?.contactId || null;
      if (!memberId) {
        noMemberId += 1;
        continue;
      }
      out.push({
        orderId:           o.id || o._id || null,
        memberId,
        planId:            o.planId || null,
        classification:    classifyOrder(o),
        status:            o.status ?? null,
        lastPaymentStatus: o.lastPaymentStatus ?? null,
        autoRenewCanceled: typeof o.autoRenewCanceled === 'boolean' ? o.autoRenewCanceled : null,
        endDate:           o.endDate ?? null,
        rawOrder:          o,
      });
    }

    if (noMemberId > 0) {
      log.warn('wix.orders.no_member_id', { siteId, count: noMemberId });
    }
    return out;
  } catch (err) {
    log.error('wix.orders_classified.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
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
  //
  // Pagination integrity (2026-09-10) — throws WIX_PAGE_INTEGRITY, never a
  // partial list, when: the body has neither an `extendedBookings` nor a
  // `bookings` array; a FULL page arrives with no next cursor (Wix truncated
  // the walk — unless it explicitly says pagingMetadata.hasNext === false,
  // which is a legitimate last page when the total is an exact multiple of
  // the limit); a booking id repeats; or the walk needs > WIX_MAX_PAGES pages.
  const seenIds = new Set();
  let pages = 0;
  try {
    while (true) {
      if (pages >= WIX_MAX_PAGES) {
        throw wixIntegrityError(`bookings walk exceeded ${WIX_MAX_PAGES} pages`, { siteId, pages, limit });
      }
      const query = {
        cursorPaging: cursor ? { limit, cursor } : { limit },
      };
      const data = await wixFetch('/_api/bookings-reader/v2/extended-bookings/query', apiKey, siteId, {
        method: 'POST',
        body: { query },
      });
      pages += 1;

      let bookings;
      if (data && Array.isArray(data.extendedBookings))  bookings = data.extendedBookings;
      else if (data && Array.isArray(data.bookings))     bookings = data.bookings;
      else {
        throw wixIntegrityError('bookings page has no extendedBookings/bookings array', { siteId, page: pages });
      }

      for (const b of bookings) {
        // A null/primitive entry threw a TypeError here before; name it instead.
        if (!b || typeof b !== 'object') {
          throw wixIntegrityError('bookings page contains a non-object entry', { siteId, page: pages });
        }
        const booking = b.booking || b;
        const bookingId = booking.id || booking._id || null;
        if (bookingId) {
          if (seenIds.has(bookingId)) {
            throw wixIntegrityError('duplicate booking id across pages', { siteId, page: pages });
          }
          seenIds.add(bookingId);
        }
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
      if (!cursor && bookings.length >= limit && data.pagingMetadata?.hasNext !== false) {
        throw wixIntegrityError('full bookings page with no next cursor', { siteId, page: pages, limit });
      }
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

module.exports = { listPricingPlans, listBookingServices, listAllMappable, testApiKey, listActiveOrders, listConfirmedBookings, listOrdersClassified };
