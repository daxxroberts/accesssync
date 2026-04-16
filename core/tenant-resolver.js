/**
 * @file tenant-resolver.js
 * @layer core/layer4
 * @role tenant-resolution
 * @reads clients (source_site_id lookup, 5-min cache)
 * @writes clients.source_site_id (registerSiteId — idempotent)
 * @exports resolve(siteId), registerSiteId(clientId, siteId)
 * @dr DR-016
 *
 * tenant-resolver.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Single responsibility: resolves a platform site ID to an AccessSync client ID
 * - Looks up the clients table using source_site_id (platform-agnostic, was wix_source_site_id)
 * - Returns null if no matching client found (unknown site — not our webhook)
 * - Caches resolved mappings in memory to avoid repeated DB reads on high-volume
 *   webhook traffic (cache TTL: 5 minutes)
 *
 * [ASSUMPTION: OB-03-A] The Wix site identifier arrives as a header value.
 * Exact header name requires verification against Wix webhook documentation.
 * Current assumption: 'x-wix-site-id'. ORION to verify via PARSE before go-live.
 */

const db = require('../db');
const { log } = require('./logger');

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
      log.warn('tenant.no_source_site_id', {});
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
        `SELECT id FROM clients WHERE source_site_id = $1 AND status = 'active' LIMIT 1`,
        [wixSiteId]
      );

      if (result.rows.length === 0) {
        // Phase 1 fallback — DEFAULT_TENANT_ID bootstraps HOG before source_site_id is registered.
        // On first use, auto-wires the real source_site_id to that client so future lookups resolve
        // normally. Remove DEFAULT_TENANT_ID from env after first successful webhook.
        const fallback = process.env.DEFAULT_TENANT_ID || null;
        if (fallback) {
          log.warn('tenant.fallback_used', { wixSiteId });
          // Auto-wire: write this source_site_id to the fallback client row (only if not already set)
          try {
            await db.query(
              `UPDATE clients SET source_site_id = $1 WHERE id = $2 AND (source_site_id IS NULL OR source_site_id = '')`,
              [wixSiteId, fallback]
            );
            log.info('tenant.auto_wired', { wixSiteId, clientId: fallback });
          } catch (wireErr) {
            log.error('tenant.auto_wire_failed', { wixSiteId, clientId: fallback }, wireErr);
          }
          this._cache.set(wixSiteId, { clientId: fallback, cachedAt: Date.now() });
          return fallback;
        }
        log.warn('tenant.not_found', { wixSiteId });
        return null;
      }

      const clientId = result.rows[0].id;

      // 3. Cache the result
      this._cache.set(wixSiteId, { clientId, cachedAt: Date.now() });

      return clientId;

    } catch (err) {
      log.error('tenant.db_lookup_failed', {}, err);
      // Do not throw — return null so webhook-processor can handle gracefully
      return null;
    }
  }

  /**
   * Register a Wix site ID against a client UUID.
   * Called on first webhook from a new client whose events.js includes their CLIENT_ID.
   * Only writes if source_site_id is currently NULL — safe to call on every request.
   *
   * @param {string} clientId - UUID from the X-AccessSync-Client-Id header
   * @param {string} siteId   - instanceId from the Wix webhook payload
   */
  async registerSiteId(clientId, siteId) {
    if (!clientId || !siteId) return;
    try {
      const result = await db.query(
        `UPDATE clients SET source_site_id = $1 WHERE id = $2 AND (source_site_id IS NULL OR source_site_id = '') RETURNING id`,
        [siteId, clientId]
      );
      if (result.rowCount > 0) {
        log.info('tenant.source_site_id_registered', { clientId, siteId });
      }
    } catch (err) {
      log.error('tenant.register_failed', { clientId, siteId }, err);
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
