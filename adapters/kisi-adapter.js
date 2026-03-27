/**
 * kisi-adapter.js
 * Hardware Adapter Layer (Layer 5)
 *
 * Responsibilities:
 * - Direct REST API interactions with Kisi
 * - Strict adherence to 5 req/sec rate limit via internal delay queue
 * - Executes logic: GET /users, POST /users (send_emails: false), 
 *   POST /role_assignments, DELETE /role_assignments, PATCH /users
 */

class KisiAdapter {
  constructor() {
    this.baseUrl = 'https://api.kisi.io';
    // Rate Limiter State
    this.lastRequestTimes = [];
    this.rateLimit = 5; 
    this.timeWindowMs = 1000;
  }

  _getHeaders(apiKey) {
    return {
      'Authorization': `KISI-LOGIN ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Kisi-Integration-Identifier': 'accesssync'
    };
  }

  /**
   * Enforces the 5 req/sec rate limit locally before making network calls.
   */
  async _enforceRateLimit() {
    const now = Date.now();
    // Remove timestamps older than our 1 second window
    this.lastRequestTimes = this.lastRequestTimes.filter(t => now - t < this.timeWindowMs);
    
    if (this.lastRequestTimes.length >= this.rateLimit) {
      // If we hit 5 requests in the last second, calculate how long to wait
      const oldestRequest = this.lastRequestTimes[0];
      const timeToWait = this.timeWindowMs - (now - oldestRequest);
      console.log(`[Kisi Rate Limiter] Pausing for ${timeToWait}ms`);
      await new Promise(resolve => setTimeout(resolve, timeToWait + 10)); // +10ms buffer
      return this._enforceRateLimit(); // Check again
    }
    
    this.lastRequestTimes.push(Date.now());
  }

  /**
   * Wrapper for making Kisi API calls with built-in 429 backoff
   */
  async _makeRequest(endpoint, options, apiKey, attempt = 1) {
    await this._enforceRateLimit();

    const url = `${this.baseUrl}${endpoint}`;
    
    try {
      // Using native Node fetch (v18+)
      const response = await fetch(url, {
        ...options,
        headers: this._getHeaders(apiKey)
      });

      if (response.status === 429) {
        if (attempt >= 3) throw new Error(`Kisi 429 Rate Limit Exhausted for ${url}`);
        const backoffMs = attempt * 1000;
        console.warn(`[Kisi Adapter] 429 Rate Limit hit. Backing off ${backoffMs}ms`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return this._makeRequest(endpoint, options, apiKey, attempt + 1);
      }

      if (!response.ok) {
        let errorBody = {};
        try { errorBody = await response.json(); } catch(e) {}
        const error = new Error(`Kisi API Error: ${response.status} ${response.statusText}`);
        error.statusCode = response.status;
        error.body = errorBody;
        throw error;
      }

      // 204 No Content
      if (response.status === 204) return null;

      return await response.json();

    } catch (error) {
      if (error.code === 'ETIMEDOUT' || error.statusCode >= 500) {
          // Handled upstream by Retry Engine
          throw error;
      }
      throw error;
    }
  }

  /**
   * Find a user by email
   */
  async findUserByEmail(apiKey, email) {
    const data = await this._makeRequest(`/users?query=${encodeURIComponent(email)}`, { method: 'GET' }, apiKey);
    // Returns array or single object depending on exact Kisi response shape
    if (Array.isArray(data) && data.length > 0) return data[0].id;
    if (data && data.id) return data.id;
    return null;
  }

  /**
   * Create a new managed user
   */
  async createUser(apiKey, email, name) {
    const data = await this._makeRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        user: { email, name, send_emails: false, confirm: true }
      })
    }, apiKey);
    return data.id;
  }

  /**
   * Assign a user to a specific group
   */
  async assignRole(apiKey, userId, groupId) {
    const data = await this._makeRequest('/role_assignments', {
      method: 'POST',
      body: JSON.stringify({
        role_assignment: {
          user_id: userId,
          role_id: 'group_basic', // VERIFIED in llms.txt
          group_id: groupId
        }
      })
    }, apiKey);
    return data.id; // Returns Role Assignment ID
  }

  /**
   * Remove a role assignment (plan.cancelled flow)
   */
  async removeRole(apiKey, roleAssignmentId) {
    await this._makeRequest(`/role_assignments/${roleAssignmentId}`, { method: 'DELETE' }, apiKey);
  }

  /**
   * Suspend access without deleting role (payment.failed flow)
   */
  async suspendAccess(apiKey, userId, contextMessage = 'Access suspended') {
    await this._makeRequest(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        user: { 
          access_enabled: false,
          notes: contextMessage
        }
      })
    }, apiKey);
  }

  /**
   * Re-enable access
   */
  async enableAccess(apiKey, userId) {
    await this._makeRequest(`/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        user: { access_enabled: true }
      })
    }, apiKey);
  }

  /**
   * Completely remove user (member.deleted flow)
   */
  async deleteUser(apiKey, userId) {
    await this._makeRequest(`/users/${userId}`, { method: 'DELETE' }, apiKey);
  }

  /**
   * Fetch all locks for the org. Used by reconciliation._syncDoorLockdownStates().
   * Returns array of lock objects, [] on error or missing key.
   */
  async getLocks(apiKey) {
    if (!apiKey) {
      console.warn('[Kisi Adapter] getLocks called with no API key. Skipping.');
      return [];
    }
    try {
      const data = await this._makeRequest('/locks', { method: 'GET' }, apiKey);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      console.error('[Kisi Adapter] getLocks failed:', err.message);
      return [];
    }
  }
}

module.exports = new KisiAdapter();
