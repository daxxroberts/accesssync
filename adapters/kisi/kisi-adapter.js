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
const { log } = require('../../core/logger');

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
   * Create a Kisi user. DR-043: behaviour is per-tenant via options.userPattern.
   *
   * 'invited'  (default) — send_emails: true  → Kisi sends invitation email; member can download app
   * 'managed'            — send_emails: false  → DR-007 managed user; no app access
   *
   * Both patterns always set confirm: true (server-side confirmation — no email link required).
   * Returns new Kisi user ID.
   */
  async createUser(apiKey, email, name, options = {}) {
    const pattern   = options.userPattern || 'invited';
    const sendEmails = pattern === 'invited';
    // Kisi's POST /users schema accepts only email + send_emails + confirm. Name is not part
    // of the request body — Kisi defaults it server-side from email. Email is the identity anchor.
    const data = await kisiConnector.makeRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        user: { email, send_emails: sendEmails, confirm: true }
      })
    }, apiKey);
    log.info('kisi.user.created', { email, pattern, sendEmails, kisiUserId: data.id });
    return data.id;
  }

  /**
   * Assign a user to a Kisi access group.
   * Returns role assignment ID.
   *
   * Gap 6: options.validUntil (ISO8601 string | null) — time-bounded grants for booking/session use cases.
   * Kisi field: valid_until. GD-02: behavior unverified against live API — test before relying on it.
   */
  async assignRole(apiKey, userId, groupId, options = {}) {
    const body = {
      role_assignment: {
        user_id: userId,
        role_id: 'group_basic', // VERIFIED in llms.txt
        group_id: groupId,
        ...(options.validUntil ? { valid_until: options.validUntil } : {}),
      }
    };
    log.info('kisi.role.assigning', { userId, groupId, validUntil: options.validUntil || null });
    try {
      const data = await kisiConnector.makeRequest('/role_assignments', {
        method: 'POST',
        body: JSON.stringify(body)
      }, apiKey);
      log.info('kisi.role.assigned', { userId, groupId, roleAssignmentId: data.id });
      return data.id;
    } catch (err) {
      // 409 means the assignment already exists — idempotent success.
      // Fetch the existing role assignment ID so we can record it correctly.
      if (err.statusCode === 409) {
        log.info('kisi.role.already_exists', { userId, groupId });
        const existing = await kisiConnector.makeRequest(
          `/role_assignments?user_id=${userId}&group_id=${groupId}&limit=1`,
          { method: 'GET' },
          apiKey
        );
        const match = Array.isArray(existing) ? existing[0] : null;
        if (match?.id) return match.id;
        // Kisi confirmed 409 but we can't retrieve the ID — surface as unknown
        log.warn('kisi.role.conflict_unresolvable', { userId, groupId });
        throw err;
      }
      log.error('kisi.role.assign_failed', { userId, groupId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Remove a role assignment (plan.cancelled flow).
   * OB-147: 404 treated as idempotent success — the role is already gone, which is the goal.
   */
  async removeRole(apiKey, roleAssignmentId) {
    log.info('kisi.role.removing', { roleAssignmentId });
    try {
      await kisiConnector.makeRequest(
        `/role_assignments/${roleAssignmentId}`,
        { method: 'DELETE' },
        apiKey
      );
      log.info('kisi.role.removed', { roleAssignmentId });
    } catch (err) {
      if (err.statusCode === 404) {
        log.info('kisi.role.remove_skipped_already_gone', { roleAssignmentId });
        return;
      }
      log.error('kisi.role.remove_failed', { roleAssignmentId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Suspend access without deleting role (payment.failed flow).
   */
  async suspendAccess(apiKey, userId, contextMessage = 'Access suspended') {
    log.info('kisi.user.suspending', { userId });
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          user: { access_enabled: false, notes: contextMessage }
        })
      }, apiKey);
      log.info('kisi.user.suspended', { userId });
    } catch (err) {
      log.error('kisi.user.suspend_failed', { userId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Re-enable access (payment.recovered flow).
   */
  async enableAccess(apiKey, userId) {
    log.info('kisi.user.enabling', { userId });
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          user: { access_enabled: true }
        })
      }, apiKey);
      log.info('kisi.user.enabled', { userId });
    } catch (err) {
      log.error('kisi.user.enable_failed', { userId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Completely remove user from Kisi org (member.deleted flow).
   * OB-125: callers must check member_identity.source_tag = 'accesssync' before invoking
   * — AccessSync deletes only Kisi users it created.
   */
  async deleteUser(apiKey, userId) {
    log.info('kisi.user.deleting', { userId });
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, { method: 'DELETE' }, apiKey);
      log.info('kisi.user.deleted', { userId });
    } catch (err) {
      log.error('kisi.user.delete_failed', { userId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Fetch all access groups for the org (OB-42).
   * Used by onboarding (show groups after key validated) and plan-mapping dropdown.
   * Returns [] on error or missing key.
   */
  async getGroups(apiKey) {
    if (!apiKey) {
      log.warn('kisi.get_groups_no_key', {});
      return [];
    }
    try {
      const data = await kisiConnector.makeRequest('/groups', { method: 'GET' }, apiKey);
      return Array.isArray(data) ? data : [];
    } catch (err) {
      // Propagate auth/permission errors so callers can surface them to the operator
      if (err.statusCode === 401 || err.statusCode === 403) throw err;
      log.error('kisi.get_groups_failed', {}, err);
      return [];
    }
  }

  /**
   * Fetch all role assignments for the org — used by reconciliation._syncClient() to build
   * the Kisi side of the Wix ↔ Kisi diff. Returns all assignments regardless of source_tag;
   * the reconciliation filters by joining against member_identity (source_tag = 'accesssync').
   *
   * Returns [] on error or missing key.
   */
  async getManagedRoleAssignments(apiKey) {
    if (!apiKey) {
      log.warn('kisi.get_role_assignments_no_key', {});
      return [];
    }
    const allAssignments = [];
    let offset = 0;
    const limit = 100;

    try {
      while (true) {
        const data = await kisiConnector.makeRequest(
          `/role_assignments?limit=${limit}&offset=${offset}`,
          { method: 'GET' },
          apiKey
        );
        const assignments = Array.isArray(data) ? data : [];
        for (const a of assignments) {
          allAssignments.push({
            userId:           a.user_id || a.user?.id,
            groupId:          a.group_id || a.group?.id,
            roleAssignmentId: a.id,
          });
        }
        if (assignments.length < limit) break;
        offset += limit;
      }
      log.info('kisi.managed_assignments.fetched', { count: allAssignments.length });
      return allAssignments;
    } catch (err) {
      log.error('kisi.managed_assignments.fetch_failed', {}, err);
      return [];
    }
  }

  /**
   * Fetch all locks for the org. Used by reconciliation._syncDoorLockdownStates().
   *
   * DR-035: Normalized return shape — { id, name, locked: boolean }.
   * All hardware adapters must return this shape. Reconciliation reads 'locked', not platform-specific fields.
   * Kisi source field: locked_down (boolean) — VERIFIED 2026-05-02 live API test.
   * Note: is_locked does not exist on the Kisi lock response.
   *
   * Returns [] on error or missing key.
   */
  async getLocks(apiKey) {
    if (!apiKey) {
      log.warn('kisi.get_locks_no_key', {});
      return [];
    }
    try {
      const data = await kisiConnector.makeRequest('/locks', { method: 'GET' }, apiKey);
      const locks = Array.isArray(data) ? data : [];
      return locks.map(l => ({
        id:     l.id,
        name:   l.name || String(l.id),
        locked: l.locked_down === true,
      }));
    } catch (err) {
      log.error('kisi.get_locks_failed', {}, err);
      return [];
    }
  }
}

module.exports = new KisiAdapter();
