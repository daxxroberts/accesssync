/**
 * plan-mapping-resolver.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Single Responsibility rule: takes a source platform Plan ID and returns array of hardware properties
 * - Resolves tier mapping (e.g. Basic vs Connect)
 * - Identifies correct hardware group inside any supported hardware platform
 * - DR-035: platform-agnostic — reads hardware_platform from clients table, source_plan_id from plan_mappings
 */

const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');

class PlanMappingResolver {

  /**
   * Maps a source platform Plan ID to ALL active hardware group mappings for that plan.
   * Returns an array — one entry per active door/group mapped to this plan.
   *
   * DR-027: Filters to locations with subscription_status = 'active' only.
   *         Mappings with no location_id (legacy rows) pass through.
   * DR-028: Resolves API key per mapping — location override || client default.
   * DR-035: hardware_platform read from clients table — not hardcoded.
   *         Column renamed: wix_plan_id → source_plan_id, kisi_api_key → hardware_api_key.
   *
   * @param {string} tenantId - client_id UUID
   * @param {string} planId   - plan/product ID from the source membership platform
   * @returns {Array|null} [{ mappingId, hardwareGroupId, hardwarePlatform, tierName, accessType, apiKey }] or null
   */
  async resolve(tenantId, planId) {
    // Multi-group: JOIN plan_mapping_groups to expand one mapping into multiple entries (one per group).
    // Falls back to plan_mappings.hardware_group_id for legacy rows without junction table entries.
    const result = await db.query(
      `SELECT pm.id,
              COALESCE(pmg.hardware_group_id, pm.hardware_group_id) AS hardware_group_id,
              pm.tier_name,
              pm.access_type,
              c.hardware_platform,
              COALESCE(l.hardware_api_key, c.hardware_api_key) AS hardware_api_key_enc
       FROM plan_mappings pm
       LEFT JOIN plan_mapping_groups pmg ON pmg.mapping_id = pm.id
       LEFT JOIN locations l ON pm.location_id = l.id
       JOIN  clients c ON pm.client_id = c.id
       WHERE pm.client_id = $1
         AND pm.source_plan_id = $2
         AND pm.status = 'active'
         AND (l.id IS NULL OR l.subscription_status = 'active')
         AND COALESCE(pmg.hardware_group_id, pm.hardware_group_id, '') != ''`,
      [tenantId, planId]
    );

    if (result.rows.length === 0) {
      // Distinguish "plan not recognized" from "plan recognized but no group mapped yet" (Wix-first flow)
      const planExists = await db.query(
        `SELECT id FROM plan_mappings WHERE client_id = $1 AND source_plan_id = $2 AND status = 'active' LIMIT 1`,
        [tenantId, planId]
      );

      if (planExists.rows.length > 0) {
        // Plan is mapped but has no hardware group assigned yet — Wix-first scenario
        console.warn(`[PlanMappingResolver] Plan ${planId} recognized but no hardware group mapped yet in tenant ${tenantId}`);
        return []; // Empty array signals "recognized but not ready" (vs null = "unknown plan")
      }

      console.warn(`[PlanMappingResolver] No active mapping for plan ${planId} in tenant ${tenantId}`);
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'missing_group', $2)`,
        [tenantId, planId]
      ).catch(e => console.error('[PlanMappingResolver] Failed to log alert:', e.message));
      return null;
    }

    return result.rows.map(row => ({
      mappingId:        row.id,
      hardwareGroupId:  row.hardware_group_id,
      hardwarePlatform: row.hardware_platform || 'kisi', // DR-035: read from DB. Fallback guards legacy rows.
      tierName:         row.tier_name,
      accessType:       row.access_type || 'group',
      apiKey:           row.hardware_api_key_enc ? decryptApiKey(row.hardware_api_key_enc) : null,
                          // DR-028: null means no API key configured — hardware calls will fail with a clear error
    }));
  }
}

module.exports = new PlanMappingResolver();
