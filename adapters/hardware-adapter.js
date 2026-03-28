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
 * Nothing else changes.
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

  async findUserByEmail(hardwarePlatform, apiKey, email) {
    return this._getAdapter(hardwarePlatform).findUserByEmail(apiKey, email);
  }

  async createUser(hardwarePlatform, apiKey, email, name) {
    return this._getAdapter(hardwarePlatform).createUser(apiKey, email, name);
  }

  async assignRole(hardwarePlatform, apiKey, userId, groupId) {
    return this._getAdapter(hardwarePlatform).assignRole(apiKey, userId, groupId);
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
