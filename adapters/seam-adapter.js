/**
 * seam-adapter.js
 * Hardware Adapter Layer (Layer 5)
 *
 * Responsibilities:
 * - Abstract physical access control for Seam-compatible smart locks (Starter/Pro tiers)
 * - Uses Seam REST API (or SDK when added)
 */

class SeamAdapter {
  constructor() {
    this.baseUrl = 'https://connect.getseam.com';
  }

  _getHeaders(apiKey) {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  // Placeholder methods matching the Grant/Revoke abstraction needs
  async findUserByEmail(apiKey, email) {
    // seam.access_codes.list or seam.workspaces.list matching
    return null;
  }

  async createUser(apiKey, email, name) {
    // In Seam, you often create an access_code directly on a device/group
    return `seam_user_stub_${Date.now()}`;
  }

  async assignRole(apiKey, userId, groupId) {
    // e.g. seam.access_codes.create({ device_id: groupId, name: userId })
    return `seam_role_stub_${Date.now()}`;
  }

  async removeRole(apiKey, roleAssignmentId) {
    // e.g. seam.access_codes.delete({ access_code_id: roleAssignmentId })
  }

  async suspendAccess(apiKey, userId) {
    // Abstracted as removing the code or disabling it
  }

  async deleteUser(apiKey, userId) {
    // Cleanup Seam state
  }
}

module.exports = new SeamAdapter();
