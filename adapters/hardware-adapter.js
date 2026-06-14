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

/**
 * OB-89 Gate 1 — platform-agnostic required-field validator.
 * Throws INVALID_HARDWARE_REQUEST before any Layer 6/7 call fires so null/empty
 * inputs never reach the hardware API. Layer 3 (standard-adapter) catches this
 * error and runs the recovery orchestrator (_recoverMissingEmail → pending_identity park).
 *
 * Per-platform required fields are declared in _requiredFields(). Adding a platform
 * means adding a new platform key with that platform's input contract.
 */
function _requireFields(operation, inputs, requiredFields, hardwarePlatform) {
  const missing = [];
  for (const field of requiredFields) {
    const val = inputs[field];
    // Empty string, null, undefined all count as missing.
    // Zero is a legitimate value; do not treat as missing (no zero-valued hardware inputs today).
    if (val === null || val === undefined || (typeof val === 'string' && val.trim() === '')) {
      missing.push(field);
    }
  }
  if (missing.length === 0) return;

  const err = new Error(
    `INVALID_HARDWARE_REQUEST: ${operation} on ${hardwarePlatform} requires ${requiredFields.join(', ')}; missing ${missing.join(', ')}`
  );
  err.code = 'INVALID_HARDWARE_REQUEST';
  err.missingFields = missing;
  err.attemptedOperation = operation;
  err.hardwarePlatform = hardwarePlatform;
  err.inputs = inputs; // Full input map — Gate 2 uses to know what we already have vs need
  throw err;
}

/**
 * Per-platform required-field contract. Kisi today; Seam post-V1 adds its own row.
 * If a future platform does not require an identifier Gate 2 can recover, do NOT add
 * that identifier here — the validator only enforces fields Gate 2 or OB-91 can resolve.
 */
const _requiredFieldsByPlatform = {
  kisi: {
    findUserByEmail: ['email'],
    // Per Kisi API: only email is required on POST /users. Name is not in the request schema.
    createUser:      ['email'],
    assignRole:      ['userId', 'groupId'],
    removeRole:      ['roleAssignmentId'],
    suspendAccess:   ['userId'],
    enableAccess:    ['userId'],
    deleteUser:      ['userId'],
  },
  seam: {
    // TODO: populated when Seam adapter is built (post-V1).
    // Keep the key present so unknown-platform validation does not accidentally allow calls.
  },
};

class HardwareAdapter {

  _getAdapter(hardwarePlatform) {
    switch (hardwarePlatform) {
      case 'kisi': return kisiAdapter;
      case 'seam': return seamAdapter;
      default: throw new Error(`Unknown hardware platform: ${hardwarePlatform}`);
    }
  }

  /**
   * Gate 1 — called at the top of every Layer 5 method.
   * Throws INVALID_HARDWARE_REQUEST if any required field for this (platform, operation)
   * is missing. Never does I/O. Standard adapter (Layer 3) catches and runs recovery.
   */
  _validate(hardwarePlatform, operation, inputs) {
    const platformRules = _requiredFieldsByPlatform[hardwarePlatform];
    if (!platformRules) {
      // Unknown platform — _getAdapter will throw a clearer error, let it.
      return;
    }
    const required = platformRules[operation];
    if (!required) {
      // No declared required fields for this operation on this platform — skip validation.
      // This is a legitimate case (e.g. getLocks takes only the apiKey).
      return;
    }
    _requireFields(operation, inputs, required, hardwarePlatform);
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
    this._validate(hardwarePlatform, 'findUserByEmail', { email });
    return this._getAdapter(hardwarePlatform).findUserByEmail(apiKey, email);
  }

  /**
   * DR-043: options.userPattern ('invited' | 'managed') controls whether the new
   * user receives an invitation email. Passed through to the Layer 6 adapter unchanged.
   */
  async createUser(hardwarePlatform, apiKey, email, name, options = {}) {
    this._validate(hardwarePlatform, 'createUser', { email, name });
    return this._getAdapter(hardwarePlatform).createUser(apiKey, email, name, options);
  }

  /**
   * Assign a user to a hardware access group.
   * Gap 6: options.validUntil (ISO8601 string | null) for time-bounded grants (booking/session model).
   * Adapters that do not support validUntil ignore the option safely.
   */
  async assignRole(hardwarePlatform, apiKey, userId, groupId, options = {}) {
    this._validate(hardwarePlatform, 'assignRole', { userId, groupId });
    return this._getAdapter(hardwarePlatform).assignRole(apiKey, userId, groupId, options);
  }

  async removeRole(hardwarePlatform, apiKey, roleAssignmentId) {
    this._validate(hardwarePlatform, 'removeRole', { roleAssignmentId });
    return this._getAdapter(hardwarePlatform).removeRole(apiKey, roleAssignmentId);
  }

  async suspendAccess(hardwarePlatform, apiKey, userId, contextMessage, options = {}) {
    this._validate(hardwarePlatform, 'suspendAccess', { userId });
    return this._getAdapter(hardwarePlatform).suspendAccess(apiKey, userId, contextMessage, options);
  }

  async enableAccess(hardwarePlatform, apiKey, userId, options = {}) {
    this._validate(hardwarePlatform, 'enableAccess', { userId });
    return this._getAdapter(hardwarePlatform).enableAccess(apiKey, userId, options);
  }

  /**
   * deleteUser carries an `options.clientId` payload that the Kisi adapter uses to
   * verify the `[AS|managed|<clientId>|...]` marker stamped into the user's `notes`
   * field at create time. See adapters/kisi/kisi-adapter.js deleteUser for the full
   * two-layer guard description.
   */
  async deleteUser(hardwarePlatform, apiKey, userId, options = {}) {
    this._validate(hardwarePlatform, 'deleteUser', { userId });
    return this._getAdapter(hardwarePlatform).deleteUser(apiKey, userId, options);
  }

  async getLocks(hardwarePlatform, apiKey) {
    return this._getAdapter(hardwarePlatform).getLocks(apiKey);
  }

  async getGroups(hardwarePlatform, apiKey) {
    return this._getAdapter(hardwarePlatform).getGroups(apiKey);
  }

  async getManagedRoleAssignments(hardwarePlatform, apiKey) {
    return this._getAdapter(hardwarePlatform).getManagedRoleAssignments(apiKey);
  }

  // OB-249: bulk-read user list for reconcile Pass 3 (operator-deleted drift detection)
  async listAllUsers(hardwarePlatform, apiKey) {
    return this._getAdapter(hardwarePlatform).listAllUsers(apiKey);
  }
}

module.exports = new HardwareAdapter();
