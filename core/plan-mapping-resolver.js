/**
 * plan-mapping-resolver.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Single Responsibility rule: takes a Wix Plan ID and returns array of hardware properties
 * - Resolves tier mapping (e.g. Basic vs Connect)
 * - Identifies correct hardware group inside Seam or Kisi
 */

const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');

class PlanMappingResolver {

  /**
   * Maps a Wix Plan ID to ALL active hardware group mappings for that plan.
   * Returns an array — one entry per active door/group mapped to this plan.
   *
   * DR-027: Filters to locations with subscription_status = 'active' only.
   *         Mappings with no location_id (legacy rows) pass through.
   * DR-028: Resolves API key per mapping — location override || client default.
   *
   * @param {string} tenantId - client_id UUID
   * @param {string} wixPlanId
   * @returns {Array|null} [{ mappingId, hardwareGroupId, hardwarePlatform, tierName, accessType, apiKey }] or null
   */
  async resolve(tenantId, wixPlanId) {
    const result = await db.query(
      `SELECT pm.id,
              pm.hardware_group_id,
              pm.tier_name,
              pm.access_type,
              COALESCE(l.kisi_api_key, c.kisi_api_key) AS kisi_api_key_enc
       FROM plan_mappings pm
       LEFT JOIN locations l ON pm.location_id = l.id
       JOIN  clients c ON pm.client_id = c.id
       WHERE pm.client_id = $1
         AND pm.wix_plan_id = $2
         AND pm.status = 'active'
         AND (l.id IS NULL OR l.subscription_status = 'active')`,
      [tenantId, wixPlanId]
    );

    if (result.rows.length === 0) {
      console.warn(`[PlanMappingResolver] No active mapping for plan ${wixPlanId} in tenant ${tenantId}`);
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'missing_group', $2)`,
        [tenantId, wixPlanId]
      ).catch(e => console.error('[PlanMappingResolver] Failed to log alert:', e.message));
      return null;
    }

    return result.rows.map(row => ({
      mappingId:        row.id,
      hardwareGroupId:  row.hardware_group_id,
      hardwarePlatform: 'kisi', // Phase 1 only. Seam post-V1.
      tierName:         row.tier_name,
      accessType:       row.access_type || 'group',
      apiKey:           row.kisi_api_key_enc
                          ? decryptApiKey(row.kisi_api_key_enc)
                          : process.env.KISI_API_KEY_MOCK, // fallback: remove after OB-23 fully wired
    }));
  }
}

module.exports = new PlanMappingResolver();
