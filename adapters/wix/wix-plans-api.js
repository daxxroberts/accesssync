/**
 * wix-plans-api.js
 * Outbound Wix API client for fetching pricing plans, booking services, and member identity.
 * Used by the plan mapping page and the nightly reconciliation correction sweep.
 *
 * Requires: Wix API key stored encrypted in clients.wix_api_key
 * Docs: https://dev.wix.com/docs/rest/api-reference/wix-pricing-plans
 *       https://dev.wix.com/docs/rest/api-reference/wix-bookings
 *       https://dev.wix.com/docs/rest/api-reference/members
 *       https://dev.wix.com/docs/rest/api-reference/contacts
 */

const { log } = require('../../core/logger');

const WIX_API_BASE = 'https://www.wixapis.com';

/**
 * Make an authenticated request to the Wix REST API.
 */
async function wixFetch(path, apiKey, siteId, options = {}) {
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
 */
async function listActiveOrders(apiKey, siteId) {
  const allOrders = [];
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const data = await wixFetch('/pricing-plans/v2/orders/query', apiKey, siteId, {
        method: 'POST',
        body: { query: { filter: { 'buyer.status': 'ACTIVE' }, paging: { limit, offset } } },
      });
      const orders = data.orders || [];
      for (const o of orders) {
        allOrders.push({
          memberId: o.buyer?.memberId || o.buyer?.contactId || null,
          planId:   o.planId || null,
          email:    o.buyer?.email    || null,
          name:     o.buyer?.fullName || null,
        });
      }
      if (orders.length < limit) break;
      offset += limit;
    }
    log.info('wix.active_orders.fetched', { siteId, count: allOrders.length });
    return allOrders;
  } catch (err) {
    log.error('wix.active_orders.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    return [];
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
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const data = await wixFetch('/_api/bookings/v2/bookings/query', apiKey, siteId, {
        method: 'POST',
        body: { query: { filter: { status: 'CONFIRMED' }, paging: { limit, offset } } },
      });
      const bookings = data.bookings || [];
      for (const b of bookings) {
        allBookings.push({
          memberId: b.contactId || null,
          planId:   b.serviceId  || null,  // serviceId is the plan equivalent for bookings
          email:    b.contactDetails?.email || null,
          name:     b.contactDetails?.firstName
            ? `${b.contactDetails.firstName} ${b.contactDetails.lastName || ''}`.trim()
            : null,
        });
      }
      if (bookings.length < limit) break;
      offset += limit;
    }
    log.info('wix.confirmed_bookings.fetched', { siteId, count: allBookings.length });
    return allBookings;
  } catch (err) {
    log.error('wix.confirmed_bookings.fetch_failed', { siteId, httpStatus: err.statusCode }, err);
    return [];
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
