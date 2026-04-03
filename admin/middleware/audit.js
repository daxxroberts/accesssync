/**
 * audit.js
 * Admin audit logging utility.
 * Writes to adapter_admin_log with admin-specific columns (admin_action, details, target_entity, target_id).
 * This table has NO CASCADE on client deletion — audit entries survive client removal.
 */

const db = require('../../db');

/**
 * Log an admin action for audit trail.
 * @param {string} clientId - Client UUID
 * @param {string} action - e.g. 'client_edited', 'client_archived', 'client_restored', 'client_deleted', 'api_key_rotated'
 * @param {Object} details - JSON snapshot of what changed
 * @param {string} [targetEntity] - 'client', 'location', 'plan_mapping'
 * @param {string} [targetId] - UUID of the entity acted on
 */
async function logAdminAction(clientId, action, details, targetEntity = 'client', targetId = null) {
  try {
    await db.query(
      `INSERT INTO adapter_admin_log (client_id, event_type, admin_action, details, target_entity, target_id, result, configured_at)
       VALUES ($1, $2, $2, $3, $4, $5, 'success', NOW())`,
      [clientId, action, JSON.stringify(details), targetEntity, targetId || clientId]
    );
  } catch (err) {
    console.error('[Audit] Failed to log admin action:', err.message);
  }
}

module.exports = { logAdminAction };
