/**
 * wix-plans-api.js
 * Outbound Wix API client for fetching pricing plans and booking services.
 * Used by the plan mapping page to show all available plans/services for a client's Wix site.
 *
 * Requires: Wix API key stored encrypted in clients.wix_api_key
 * Docs: https://dev.wix.com/docs/rest/api-reference/wix-pricing-plans
 *       https://dev.wix.com/docs/rest/api-reference/wix-bookings
 */

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
    const err = new Error(`Wix API ${res.status}: ${text.slice(0, 200)}`);
    err.statusCode = res.status;
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
    return plans.map(p => ({
      id: p._id || p.id,
      name: p.name || 'Unnamed Plan',
      type: 'pricing_plan',
      description: p.description || '',
      status: p.archived ? 'archived' : (p.primary ? 'primary' : 'active'),
      slug: p.slug || null,
    }));
  } catch (err) {
    console.error('[WixPlansAPI] Failed to list pricing plans:', err.message);
    return [];
  }
}

/**
 * List all booking services for a Wix site.
 * Returns normalized service objects.
 */
async function listBookingServices(apiKey, siteId) {
  try {
    const data = await wixFetch('/bookings/v1/services', apiKey, siteId);
    const services = data.services || [];
    return services.map(s => ({
      id: s._id || s.id,
      name: s.info?.name || s.name || 'Unnamed Service',
      type: 'booking_service',
      description: s.info?.description || s.description || '',
      status: s.hidden ? 'hidden' : 'active',
      slug: s.slugs?.[0]?.name || null,
    }));
  } catch (err) {
    console.error('[WixPlansAPI] Failed to list booking services:', err.message);
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
