/**
 * plan-mapping-resolver.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Single Responsibility rule: takes a Wix Plan ID and returns array of hardware properties
 * - Resolves tier mapping (e.g. Basic vs Connect)
 * - Identifies correct hardware group inside Seam or Kisi
 */

class PlanMappingResolver {
  
  /**
   * Maps a Wix Plan ID to its underlying hardware group.
   * Pure DB read function.
   * 
   * @param {string} tenantId 
   * @param {string} wixPlanId 
   * @returns {object} { hardwareGroupId, hardwarePlatform, tierName }
   */
  async resolve(tenantId, wixPlanId) {
    // DB: SELECT * FROM plan_mappings WHERE client_id = tenantId AND wix_plan_id = wixPlanId
    
    // If NOT FOUND -> Error and log to config_alert_log (missing_group flag)
    // This stops the Grant flow safely before hardware API is called.
    
    return {
      hardwareGroupId: 'sample-group-123',
      hardwarePlatform: 'kisi', // or 'seam'
      tierName: 'Base'
    };
  }
}

module.exports = new PlanMappingResolver();
