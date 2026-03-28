/**
 * seam-adapter.js
 * Seam Adapter Layer (Layer 6) — Stub
 *
 * Post-V1. Not implemented.
 * Mirrors the KisiAdapter interface for future implementation.
 * getLocks() and enableAccess() return safe no-ops (required by HardwareAdapter interface).
 */

class SeamAdapter {
  async findUserByEmail(apiKey, email) {
    throw new Error('Seam adapter not implemented');
  }

  async createUser(apiKey, email, name) {
    throw new Error('Seam adapter not implemented');
  }

  async assignRole(apiKey, userId, groupId) {
    throw new Error('Seam adapter not implemented');
  }

  async removeRole(apiKey, roleAssignmentId) {
    throw new Error('Seam adapter not implemented');
  }

  async suspendAccess(apiKey, userId, contextMessage) {
    throw new Error('Seam adapter not implemented');
  }

  async enableAccess(apiKey, userId) {
    // No-op — required by HardwareAdapter interface. Post-V1.
    return;
  }

  async deleteUser(apiKey, userId) {
    throw new Error('Seam adapter not implemented');
  }

  async getLocks(apiKey) {
    // Returns empty array — reconciliation._syncDoorLockdownStates() requires this to be safe.
    return [];
  }
}

module.exports = new SeamAdapter();
