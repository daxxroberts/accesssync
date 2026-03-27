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

class PlanMappingResolver {

  /**
   * Maps a Wix Plan ID to its underlying hardware group.
   * Pure DB read function.
   *
   * @param {string} tenantId - client_id UUID
   * @param {string} wixPlanId
   * @returns {object|null} { hardwareGroupId, hardwarePlatform, tierName } or null if unmapped
   */
  async resolve(tenantId, wixPlanId) {
    const result = await db.query(
      `SELECT hardware_group_id, tier_name
       FROM plan_mappings
       WHERE client_id = $1 AND wix_plan_id = $2`,
      [tenantId, wixPlanId]
    );

    if (result.rows.length === 0) {
      console.warn(`[PlanMappingResolver] No mapping for plan ${wixPlanId} in tenant ${tenantId}`);
      // Alert operator — plan is configured in Wix but has no hardware group mapped
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'missing_group', $2)`,
        [tenantId, wixPlanId]
      ).catch(e => console.error('[PlanMappingResolver] Failed to log alert:', e.message));
      return null;
    }

    const row = result.rows[0];
    return {
      hardwareGroupId: row.hardware_group_id,
      hardwarePlatform: 'kisi', // Phase 1 only. Seam post-V1.
      tierName: row.tier_name,
    };
  }
}

module.exports = new PlanMappingResolver();
