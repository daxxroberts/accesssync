/**
 * hardware-adapter.js
 * Hardware Standard Adapter (Layer 5)
 *
 * Responsibilities:
 * - Platform router — delegates to Layer 6 adapter by hardwarePlatform string
 * - Uniform interface for all hardware operations
 * - Core Engine (Layer 4) and Standard Adapter (Layer 3) call this — never Layer 6 directly
 *
 * To add a new hardware platform: import its Layer 6 adapter and add a case to _getAdapter().
 * Nothing else changes in this file or above.
 *
 * DR-035: Rate limiting is per-adapter inside each Layer 7 connector — NOT in this layer.
 *         getRateLimit(platform) is available for informational use (e.g. worker configuration).
 *
 * getLocks() normalized return shape: { id, name, locked: boolean }
 * assignRole() Gap 6: options.validUntil (ISO8601 | null) for time-bounded session grants.
 */

const kisiAdapter = require('./kisi/kisi-adapter');
const seamAdapter = require('./seam/seam-adapter');

class HardwareAdapter {

  _getAdapter(hardwarePlatform) {
    switch (hardwarePlatform) {
      case 'kisi': return kisiAdapter;
      case 'seam': return seamAdapter;
      default: throw new Error(`Unknown hardware platform: ${hardwarePlatform}`);
    }
  }

  /**
   * Returns the requests-per-second rate limit for a given platform.
   * Informational — actual enforcement is inside each Layer 7 connector.
   * DR-035: use this when platform-aware configuration is needed (e.g. logging, alerting thresholds).
   */
  getRateLimit(hardwarePlatform) {
    switch (hardwarePlatform) {
      case 'kisi': return 5;
      case 'seam': return 10; // Seam default — confirm when adapter is built
      default:     return 5;  // Conservative fallback
    }
  }

  async findUserByEmail(hardwarePlatform, apiKey, email) {
    return this._getAdapter(hardwarePlatform).findUserByEmail(apiKey, email);
  }

  async createUser(hardwarePlatform, apiKey, email, name) {
    return this._getAdapter(hardwarePlatform).createUser(apiKey, email, name);
  }

  /**
   * Assign a user to a hardware access group.
   * Gap 6: options.validUntil (ISO8601 string | null) for time-bounded grants (booking/session model).
   * Adapters that do not support validUntil ignore the option safely.
   */
  async assignRole(hardwarePlatform, apiKey, userId, groupId, options = {}) {
    return this._getAdapter(hardwarePlatform).assignRole(apiKey, userId, groupId, options);
  }

  async removeRole(hardwarePlatform, apiKey, roleAssignmentId) {
    return this._getAdapter(hardwarePlatform).removeRole(apiKey, roleAssignmentId);
  }

  async suspendAccess(hardwarePlatform, apiKey, userId, contextMessage) {
    return this._getAdapter(hardwarePlatform).suspendAccess(apiKey, userId, contextMessage);
  }

  async enableAccess(hardwarePlatform, apiKey, userId) {
    return this._getAdapter(hardwarePlatform).enableAccess(apiKey, userId);
  }

  async deleteUser(hardwarePlatform, apiKey, userId) {
    return this._getAdapter(hardwarePlatform).deleteUser(apiKey, userId);
  }

  async getLocks(hardwarePlatform, apiKey) {
    return this._getAdapter(hardwarePlatform).getLocks(apiKey);
  }
}

module.exports = new HardwareAdapter();
