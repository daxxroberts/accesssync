/**
 * kisi-adapter.js
 * Kisi Adapter Layer (Layer 6)
 *
 * Responsibilities:
 * - Kisi business methods (user/role operations)
 * - Delegates all HTTP to kisi-connector (Layer 7)
 *
 * Interface matches HardwareAdapter (Layer 5) — all methods accept apiKey as first param.
 */

const kisiConnector = require('./kisi-connector');

class KisiAdapter {

  /**
   * Find a user by email. Returns Kisi user ID or null.
   */
  async findUserByEmail(apiKey, email) {
    const data = await kisiConnector.makeRequest(
      `/users?query=${encodeURIComponent(email)}`,
      { method: 'GET' },
      apiKey
    );
    if (Array.isArray(data) && data.length > 0) return data[0].id;
    if (data && data.id) return data.id;
    return null;
  }

  /**
   * Create a new managed user (DR-007: send_emails: false).
   * Returns new Kisi user ID.
   */
  async createUser(apiKey, email, name) {
    const data = await kisiConnector.makeRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        user: { email, name, send_emails: false, confirm: true }
      })
    }, apiKey);
    return data.id;
  }

  /**
   * Assign a user to a Kisi access group.
   * Returns role assignment ID.
   */
  async assignRole(apiKey, userId, groupId) {
    const data = await kisiConnector.makeRequest('/role_assignments', {
      method: 'POST',
      body: JSON.stringify({
        role_assignment: {
          user_id: userId,
          role_id: 'group_basic', // VERIFIED in llms.txt
          group_id: groupId
        }
      })
    }, apiKey);
    return data.id;
  }

  /**
   * Remove a role assignment (plan.cancelled flow).
   */
  async removeRole(apiKey, roleAssignmentId) {
    await kisiConnector.makeRequest(
      `/role_assignments/${roleAssignmentId}`,
      { method: 'DELETE' },
      apiKey
    );
  }

  /**
   * Suspend access without deleting role (payment.failed flow).
   */
  async suspendAccess(apiKey, userId, contextMessage = 'Access suspended') {
    await kisiConnector.makeRequest(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        user: { access_enabled: false, notes: contextMessage }
      })
    }, apiKey);
  }

  /**
   * Re-enable access (payment.recovered flow).
   */
  async enableAccess(apiKey, userId) {
    await kisiConnector.makeRequest(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        user: { access_enabled: true }
      })
    }, apiKey);
  }

  /**
   * Completely remove user from Kisi org (member.deleted flow).
   */
  async deleteUser(apiKey, userId) {
    await kisiConnector.makeRequest(`/users/${userId}`, { method: 'DELETE' }, apiKey);
  }

  /**
   * Fetch all locks for the org. Used by reconciliation._syncDoorLockdownStates().
   * Returns [] on error or missing key.
   */
  async getLocks(apiKey) {
    if (!apiKey) {
      console.warn('[Kisi Adapter] getLocks called with no API key. Skipping.');
      return [];
    }
    try {
      const data = await kisiConnector.makeRequest('/locks', { method: 'GET' }, apiKey);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[Kisi Adapter] getLocks failed:', err.message);
      return [];
    }
  }
}

module.exports = new KisiAdapter();
