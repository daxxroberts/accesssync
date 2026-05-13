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

/**
 * AccessSync ownership marker stored in Kisi user `notes` field.
 *
 * Format: `[AS|managed|<clientId>|<createdAt-ISO>] <free-text reason>`
 *
 * Why this exists: Kisi `deleteUser` is destructive and irreversible. Relying on
 * `member_master.source_tag = 'accesssync'` as the only guard means a DB wipe would
 * cascade into a mass Kisi-user wipe. Stamping ownership on the Kisi user itself —
 * inside its own `notes` field — makes the guard survive any DB disaster.
 *
 * Verified 2026-05-13 against live HOG Kisi org: POST /users accepts `notes` in the
 * body and the value persists exactly on GET /users/:id (status 200, no munging).
 *
 * Maintenance contract: anything that PATCHes `notes` on a managed user MUST preserve
 * the `[AS|managed|...]` prefix. See `_preserveMarker()`.
 */
const AS_MARKER_PREFIX = '[AS|managed|';
const AS_MARKER_REGEX = /^\[AS\|managed\|([^|]+)\|([^\]]+)\] ?(.*)$/;

function buildAccessSyncMarker(clientId, reason) {
  const createdAt = new Date().toISOString();
  const text = reason || 'Managed by AccessSync';
  return `[AS|managed|${clientId}|${createdAt}] ${text}`;
}

/**
 * Parse a Kisi user's `notes` field. Returns null if the marker is absent or malformed.
 * Returns `{ clientId, createdAt, reason }` on a valid marker.
 */
function parseAccessSyncMarker(notes) {
  if (!notes || typeof notes !== 'string') return null;
  const match = notes.match(AS_MARKER_REGEX);
  if (!match) return null;
  return { clientId: match[1], createdAt: match[2], reason: match[3] || '' };
}

/**
 * Layer C of the delete guard — elevated-role check (DR-045 amendment).
 *
 * AccessSync only ever issues `group_basic` role assignments scoped to Groups. Any
 * other role on a Kisi user means a human operator promoted them: org administrator,
 * place manager, owner, etc. Those users must never be deleted by AccessSync — even
 * if the AS ownership marker says we created them — because the elevated role is
 * outside our scope of ownership.
 *
 * Verified live against HOG Kisi org 2026-05-13: 3 of 6 remaining users hold elevated
 * roles (Daxx admin, houseofgains@mail.com admin, kalib@getkisi.com owner).
 *
 * Detection: any role_assignment with scope ∈ {organization, place} OR role_id
 * outside the allowed group-member set is considered elevated. Belt + suspenders.
 */
const ALLOWED_MEMBER_ROLE_IDS = new Set(['group_basic']);
const ELEVATED_SCOPES = new Set(['organization', 'place']);

function findElevatedAssignments(roleAssignments) {
  if (!Array.isArray(roleAssignments)) return [];
  return roleAssignments.filter(ra => {
    const scope = ra?.scope || ra?.applies_to_type?.toLowerCase();
    const roleId = ra?.role_id;
    if (scope && ELEVATED_SCOPES.has(scope)) return true;
    if (roleId && !ALLOWED_MEMBER_ROLE_IDS.has(roleId)) return true;
    return false;
  });
}

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
    const pattern    = options.userPattern || 'invited';
    const sendEmails = pattern === 'invited';
    const clientId   = options.clientId;

    if (!clientId) {
      // Hard requirement: every AccessSync-created Kisi user must carry an ownership
      // marker. Without clientId we cannot stamp it, so we cannot create.
      throw new Error('[KisiAdapter] createUser requires options.clientId for ownership marker');
    }

    const notes = buildAccessSyncMarker(clientId, 'Created by AccessSync');

    // Kisi POST /users accepts: email, send_emails, confirm, notes (verified 2026-05-13).
    // notes carries the [AS|managed|clientId|createdAt] marker that deleteUser checks
    // before destroying the user.
    const data = await kisiConnector.makeRequest('/users', {
      method: 'POST',
      body: JSON.stringify({
        user: { email, send_emails: sendEmails, confirm: true, notes }
      })
    }, apiKey);
    log.info('kisi.user.created', { email, pattern, sendEmails, kisiUserId: data.id, clientId });
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
   *
   * Re-stamps the `[AS|managed|clientId|...]` marker so the deleteUser guard survives
   * the suspend cycle. The createdAt in the marker resets to "now" on each suspend —
   * the marker's job is ownership-proof, not provenance audit (member_access_log holds
   * provenance). One call, no preceding GET.
   *
   * If clientId is not supplied (legacy call sites), we fall back to the bare context
   * message and emit a warning — the user loses delete-guard protection until the next
   * grant re-stamps it.
   */
  async suspendAccess(apiKey, userId, contextMessage = 'Access suspended', options = {}) {
    log.info('kisi.user.suspending', { userId });
    const clientId = options.clientId;
    const notes = clientId
      ? buildAccessSyncMarker(clientId, contextMessage)
      : contextMessage;
    if (!clientId) {
      log.warn('kisi.user.suspend_without_marker', { userId, reason: 'clientId not supplied' });
    }
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          user: { access_enabled: false, notes }
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
   *
   * Re-stamps the marker when clientId is supplied so the access cycle leaves a tagged
   * user behind. We only patch `access_enabled` plus `notes` — same single PATCH call as
   * before. If clientId is missing we skip touching notes entirely (avoids clobbering
   * an existing marker with no context).
   */
  async enableAccess(apiKey, userId, options = {}) {
    log.info('kisi.user.enabling', { userId });
    const clientId = options.clientId;
    const body = clientId
      ? { user: { access_enabled: true, notes: buildAccessSyncMarker(clientId, 'Access restored') } }
      : { user: { access_enabled: true } };
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(body)
      }, apiKey);
      log.info('kisi.user.enabled', { userId });
    } catch (err) {
      log.error('kisi.user.enable_failed', { userId, statusCode: err.statusCode }, err);
      throw err;
    }
  }

  /**
   * Fetch all role assignments for a single Kisi user. Used by Layer C of the delete
   * guard. Distinct from `getManagedRoleAssignments()` which fetches org-wide.
   *
   * Returns [] on 404 (user gone). Other errors propagate.
   */
  async getRoleAssignmentsForUser(apiKey, userId) {
    try {
      const data = await kisiConnector.makeRequest(
        `/role_assignments?user_id=${userId}&limit=100`,
        { method: 'GET' },
        apiKey
      );
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err.statusCode === 404) return [];
      throw err;
    }
  }

  /**
   * Completely remove user from Kisi org (member.deleted flow).
   *
   * **Three-layer delete guard (defense in depth):**
   *
   *   Layer A (DB):    caller in core/grant-revoke.js verifies member_master.source_tag = 'accesssync'.
   *   Layer B (Kisi):  GET /users/:id → parse `[AS|managed|<clientId>|...]` marker from `notes`.
   *                    Refuse if marker absent (UNOWNED_USER) or clientId mismatches (CLIENT_MISMATCH).
   *   Layer C (Kisi):  GET /role_assignments?user_id=:id → refuse if ANY assignment has
   *                    scope ∈ {organization, place} OR role_id outside the AccessSync allowed
   *                    set (`group_basic` only). Catches the case where the marker says we own
   *                    the user but an operator separately granted them elevated rights
   *                    (admin / manager / owner) post-creation. ELEVATED_ROLE_ATTACHED.
   *
   * Any single guard failing alone fails closed. All three must pass for DELETE to fire.
   *
   * Call count: 2 GETs + 1 DELETE on the destructive path. All other adapter methods remain
   * single-call. The added cost protects an irreversible operation against a real failure
   * mode (verified live 2026-05-13: 3 of 6 HOG Kisi users hold elevated roles).
   *
   * Throws `KisiAdapterError` with one of:
   *   code='UNOWNED_USER'           Layer B failure — marker absent
   *   code='CLIENT_MISMATCH'        Layer B failure — marker names different tenant
   *   code='ELEVATED_ROLE_ATTACHED' Layer C failure — user holds non-member role(s)
   */
  async deleteUser(apiKey, userId, options = {}) {
    log.info('kisi.user.delete_guard_check', { userId, clientId: options.clientId });

    let user;
    try {
      user = await kisiConnector.makeRequest(`/users/${userId}`, { method: 'GET' }, apiKey);
    } catch (err) {
      if (err.statusCode === 404) {
        // User already gone — idempotent success. Nothing to delete, nothing to guard.
        log.info('kisi.user.delete_skipped_already_gone', { userId });
        return;
      }
      log.error('kisi.user.delete_guard_fetch_failed', { userId, statusCode: err.statusCode }, err);
      throw err;
    }

    // Layer B — ownership marker
    const marker = parseAccessSyncMarker(user.notes);
    if (!marker) {
      const err = new Error(`Kisi user ${userId} has no AccessSync ownership marker — refusing to delete`);
      err.code = 'UNOWNED_USER';
      err.userId = userId;
      err.kisiNotes = user.notes || null;
      log.warn('kisi.user.delete_refused_unowned', { userId, kisiNotes: user.notes || null });
      throw err;
    }
    if (options.clientId && marker.clientId !== options.clientId) {
      const err = new Error(
        `Kisi user ${userId} is owned by clientId ${marker.clientId}, ` +
        `not requesting clientId ${options.clientId} — refusing to delete`
      );
      err.code = 'CLIENT_MISMATCH';
      err.userId = userId;
      err.ownerClientId = marker.clientId;
      err.requestingClientId = options.clientId;
      log.warn('kisi.user.delete_refused_cross_tenant', {
        userId, ownerClientId: marker.clientId, requestingClientId: options.clientId,
      });
      throw err;
    }

    // Layer C — elevated-role check
    const roleAssignments = await this.getRoleAssignmentsForUser(apiKey, userId);
    const elevated = findElevatedAssignments(roleAssignments);
    if (elevated.length > 0) {
      const summary = elevated.map(ra => ({
        role_id: ra.role_id,
        scope: ra.scope || ra.applies_to_type,
        applies_to: ra.applies_to?.name || ra.applies_to_id,
      }));
      const err = new Error(
        `Kisi user ${userId} holds ${elevated.length} elevated role assignment(s) — refusing to delete`
      );
      err.code = 'ELEVATED_ROLE_ATTACHED';
      err.userId = userId;
      err.elevatedAssignments = summary;
      log.warn('kisi.user.delete_refused_elevated', {
        userId, ownerClientId: marker.clientId, elevatedAssignments: summary,
      });
      throw err;
    }

    log.info('kisi.user.deleting', { userId, ownerClientId: marker.clientId });
    try {
      await kisiConnector.makeRequest(`/users/${userId}`, { method: 'DELETE' }, apiKey);
      log.info('kisi.user.deleted', { userId, ownerClientId: marker.clientId });
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

const adapter = new KisiAdapter();
adapter.buildAccessSyncMarker = buildAccessSyncMarker;
adapter.parseAccessSyncMarker = parseAccessSyncMarker;
adapter.findElevatedAssignments = findElevatedAssignments;
module.exports = adapter;
