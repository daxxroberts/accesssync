/**
 * tenant-resolver.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Single responsibility: resolves a platform site ID to an AccessSync client ID
 * - Looks up the clients table using site_id (platform-agnostic, was wix_site_id)
 * - Returns null if no matching client found (unknown site — not our webhook)
 * - Caches resolved mappings in memory to avoid repeated DB reads on high-volume
 *   webhook traffic (cache TTL: 5 minutes)
 *
 * [ASSUMPTION: OB-03-A] The Wix site identifier arrives as a header value.
 * Exact header name requires verification against Wix webhook documentation.
 * Current assumption: 'x-wix-site-id'. ORION to verify via PARSE before go-live.
 */

const db = require('../db');

class TenantResolver {
  constructor() {
    // In-memory cache: wixSiteId → { clientId, cachedAt }
    this._cache = new Map();
    this._cacheTtlMs = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Resolve a Wix site ID to an AccessSync client ID.
   *
   * @param {string} wixSiteId - The Wix site identifier from the webhook
   * @returns {string|null} The matching client UUID, or null if not found
   */
  async resolve(wixSiteId) {
    if (!wixSiteId) {
      console.warn('[Tenant Resolver] No wixSiteId provided. Cannot resolve tenant.');
      return null;
    }

    // 1. Check cache first
    const cached = this._cache.get(wixSiteId);
    if (cached && (Date.now() - cached.cachedAt) < this._cacheTtlMs) {
      return cached.clientId;
    }

    // 2. Look up from DB
    try {
      const result = await db.query(
        `SELECT id FROM clients WHERE site_id = $1 AND status = 'active' LIMIT 1`,
        [wixSiteId]
      );

      if (result.rows.length === 0) {
        console.warn(`[Tenant Resolver] No active client found for site_id: ${wixSiteId}`);
        return null;
      }

      const clientId = result.rows[0].id;

      // 3. Cache the result
      this._cache.set(wixSiteId, { clientId, cachedAt: Date.now() });

      return clientId;

    } catch (err) {
      console.error('[Tenant Resolver] DB lookup failed:', err.message);
      // Do not throw — return null so webhook-processor can handle gracefully
      return null;
    }
  }

  /**
   * Invalidate a specific site ID from the cache.
   * Called if a client's status changes (e.g. cancelled).
   *
   * @param {string} wixSiteId
   */
  invalidate(wixSiteId) {
    this._cache.delete(wixSiteId);
  }

  /**
   * Clear the entire cache. Used in tests.
   */
  clearCache() {
    this._cache.clear();
  }
}

module.exports = new TenantResolver();
