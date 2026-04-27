/**
 * @file log-redaction.js
 * @layer core/shared
 * @role logging-redaction
 * @exports redact, REDACTED, registerSecretField, SENSITIVE_FIELDS
 * @dr DR-039
 *
 * Two-layer redaction for all log entries (DR-039).
 *
 * Layer 1 — Schema-driven allowlist:
 *   Known sensitive field names replaced with [REDACTED] recursively.
 *   Covers hardware/Wix API keys, auth tokens, and DR-001 PII fields.
 *
 * Layer 2 — Runtime regex backstop:
 *   Every string value scanned for secret patterns (Resend, Stripe-shape, JWT, Bearer).
 *   Catches secrets that slipped through allowlist registration.
 *   Replaced with [REDACTED_RUNTIME] (distinct tag for telemetry — helps audit allowlist coverage).
 *
 * Borderline PII (ip_address, user_agent) are NOT in the allowlist per DR-039 policy:
 *   they are permitted in activity_event.request_meta for audit purposes only.
 *
 * NOTE: The long-hex/base64 catch-all pattern is excluded from initial ship —
 *   too aggressive (would mask UUIDs). CIRCUIT refinement deferred to Step 8.
 */

'use strict';

const REDACTED = '[REDACTED]';
const REDACTED_RUNTIME = '[REDACTED_RUNTIME]';

// ── Layer 1: allowlist ────────────────────────────────────────────────────────

const SENSITIVE_FIELDS = new Set([
  // Hardware secrets (DR-028, DR-035)
  'hardware_api_key',
  'kisi_api_key',
  'seam_api_key',
  'api_key',
  'apiKey',
  // Platform secrets
  'wix_api_key',
  'wix_app_secret',
  'WIX_APP_SECRET',
  'WIX_WEBHOOK_SECRET',
  // Auth tokens
  'password',
  'secret',
  'webhook_secret',
  'jwt',
  'token',
  'authorization',
  'authToken',
  'access_token',
  'refresh_token',
  'cookie',
  'set-cookie',
  // Service keys
  'OPERATOR_INVITE_TOKEN',
  'OWNER_PIN',
  'RESEND_API_KEY',
  'ADMIN_JWT_SECRET',
  'API_KEY_ENCRYPTION_KEY',
  // PII per DR-001
  'email',
  'phone',
  'first_name',
  'last_name',
  'full_name',
  'address',
  'street_address',
  'zip_code',
  'postal_code',
  'ssn',
  'date_of_birth',
  'name',
]);

// ── Layer 2: runtime regex backstop ──────────────────────────────────────────

const SECRET_PATTERNS = [
  /\bre_[a-zA-Z0-9_]{20,}/g,
  /\bsk_(live|test)_[a-zA-Z0-9]{24,}/g,
  /\bpk_(live|test)_[a-zA-Z0-9]{24,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9_.~-]{20,}/gi,
];

function redactString(s) {
  let out = s;
  for (const pat of SECRET_PATTERNS) {
    pat.lastIndex = 0;
    out = out.replace(pat, REDACTED_RUNTIME);
  }
  return out;
}

function redactValue(key, value) {
  if (SENSITIVE_FIELDS.has(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redactValue(key, v));
  if (value !== null && typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

/**
 * Recursively redact a log entry object. Returns a new object — does not mutate.
 * @param {Object} entry
 * @returns {Object}
 */
function redact(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return redactObject(entry);
}

/**
 * Register a new sensitive field name at runtime (used by EVENT_REGISTRY loader).
 * @param {string} name
 */
function registerSecretField(name) {
  SENSITIVE_FIELDS.add(name);
}

module.exports = { redact, REDACTED, REDACTED_RUNTIME, registerSecretField, SENSITIVE_FIELDS, SECRET_PATTERNS };
