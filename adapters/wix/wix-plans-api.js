/**
 * wix-plans-api.js
 * Outbound Wix API client for fetching pricing plans and booking services.
 * Used by the plan mapping page to show all available plans/services for a client's Wix site.
 *
 * Requires: Wix API key stored encrypted in clients.wix_api_key
 * Docs: https://dev.wix.com/docs/rest/api-reference/wix-pricing-plans
 *       https://dev.wix.com/docs/rest/api-reference/wix-bookings
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

module.exports = { listPricingPlans, listBookingServices, listAllMappable, testApiKey };
