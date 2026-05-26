/**
 * @file logger.js
 * @layer core/shared
 * @role logging
 * @writes diagnostic_log
 * @exports log, withTrace, KEDB
 * @dr DR-037, DR-039
 *
 * Structured JSON logger for AccessSync.
 *
 * Every log entry is a single JSON line written to stdout.
 * Railway ingests stdout — each line is a searchable, filterable log event.
 *
 * warn/error/critical events are also persisted to diagnostic_log table
 * (fire-and-forget via setImmediate — never blocks the main flow).
 *
 * trace_id + actor_type + actor_id are auto-populated from AsyncLocalStorage
 * (DR-037). No call-site changes needed — set context once at each entry point
 * (Express middleware, BullMQ handler, cron starter) and all downstream log
 * calls inherit it automatically.
 *
 * Log levels (intent-based, not mood-based):
 *   debug    → Active investigation only. Not emitted in production.
 *   info     → Significant business event. Normal path. No action required.
 *   warn     → Something unusual happened. System still running. Worth watching.
 *   error    → A specific operation failed. Needs attention. May auto-retry.
 *   critical → System-level failure. Someone needs to act now.
 *
 * Usage:
 *   const { log } = require('./logger');
 *   log.info('grant.complete', { tenantId, memberId, assignments: 2 });
 *   log.error('hardware.call.failed', { tenantId, memberId }, err);
 *
 * With a trace ID (pass through from the original webhook event):
 *   const logger = require('./logger').withTrace(traceId);
 *   logger.info('queue.job.start', { jobId, tenantId });
 *
 * Trace ID convention (DR-037):
 *   Prefer runWith() at entry points — auto-propagates to all calls.
 *   withTrace() is the legacy/explicit override — still works, kept for compat.
 *   In Railway logs: filter by traceId to replay the full lifecycle of one webhook.
 */

'use strict';

const { getTraceId, getActor } = require('./trace-context');
const { redact }               = require('./log-redaction');

const PRODUCTION = process.env.NODE_ENV === 'production';

// ── Event registry (OB-176) ──────────────────────────────────────
// Loaded once at module init. Maps event-name → { persist: bool }.
// Events not in the registry fall back to level-based default
// (warn+ persist, info/debug suppressed). Explicit entries override
// in either direction: `persist: false` suppresses noisy warns;
// `persist: true` promotes load-bearing info events.
//
// Builder ruling Q7-Q10 (2026-05-25): only `persist` field today.
// Additive fields (retention_days, pii_safe, etc.) deferred until needed.
const REGISTRY_OVERRIDES = (() => {
  try {
    const registry = require('./EVENT_REGISTRY.json');
    const map = new Map();
    const overrides = (registry && registry.overrides) || {};
    for (const eventName of Object.keys(overrides)) {
      const entry = overrides[eventName];
      if (entry && typeof entry.persist === 'boolean') {
        map.set(eventName, { persist: entry.persist });
      }
    }
    return map;
  } catch (_e) {
    // Registry JSON missing or unreadable → fall back to pure level-based
    // behavior. Logger remains functional.
    return new Map();
  }
})();

// Track info-level event names we've already warned about as "unregistered".
// One warn per process per event name (Builder ruling Q7-Q10 b).
const _warnedUnregisteredEvents = new Set();

// KEDB — Known Error Database.
// Maps error codes to documentation links and resolution summaries.
// Add a new entry whenever a new error code is introduced in a connector or adapter.
const KEDB = {
  HARDWARE_KEY_INVALID:        { doc: 'ERR-101', summary: 'Kisi/Seam rejected the API key (401). Rotate in System Config.' },
  HARDWARE_KEY_PERMISSIONS:    { doc: 'ERR-102', summary: 'API key lacks user-management permissions (403). Check Kisi tier.' },
  HARDWARE_KEY_MISSING:        { doc: 'ERR-103', summary: 'No hardware API key configured. Add in System Config.' },
  HARDWARE_RESOURCE_NOT_FOUND: { doc: 'ERR-104', summary: 'Referenced door group no longer exists. Re-map plan.' },
  HARDWARE_VALIDATION_ERROR:   { doc: 'ERR-105', summary: 'Hardware system rejected the payload (422). Check member/group data.' },
  HARDWARE_API_ERROR:          { doc: 'ERR-106', summary: 'Unexpected hardware API error. Check hardware provider status.' },
  WIX_KEY_INVALID:             { doc: 'ERR-201', summary: 'Wix API key rejected (401). Update in System Config.' },
  WIX_KEY_MISSING:             { doc: 'ERR-202', summary: 'No Wix API key configured. Add in System Config.' },
  WIX_KEY_PERMISSIONS:         { doc: 'ERR-203', summary: 'Wix API key missing Pricing Plans or Bookings permissions.' },
  WIX_API_ERROR:               { doc: 'ERR-204', summary: 'Unexpected Wix API error.' },
  PLAN_NOT_MAPPED:             { doc: 'ERR-301', summary: 'Member bought a plan with no door group mapped. Map it in Plan Mapping.' },
  SUBSCRIPTION_LAPSED:         { doc: 'ERR-302', summary: 'Location subscription inactive. Reactivate in Locations.' },
  HMAC_FAILURE:                { doc: 'ERR-401', summary: 'Webhook HMAC signature verification failed. Check webhook secret.' },
  HMAC_FAILURE_SPIKE:          { doc: 'ERR-402', summary: 'Multiple HMAC failures in a short window. Possible attack or misconfigured secret.' },
  WEBHOOK_INVALID_STRUCTURE:   { doc: 'ERR-403', summary: 'Webhook payload missing required fields. Check Wix event format.' },
  TENANT_NOT_RESOLVED:         { doc: 'ERR-404', summary: 'Could not resolve tenant from Wix site ID. Re-register webhook.' },
  REVOKE_UNKNOWN_EVENT:        { doc: 'ERR-501', summary: 'Unrecognised revoke event type received. Check Wix event mapping.' },
  REVOKE_LEGACY_FALLBACK:      { doc: 'ERR-502', summary: 'Revoke fell back to legacy role assignment IDs. Member may need re-provisioning.' },
};

// ── DB persistence ────────────────────────────────────────────────
// Lazy-require db to avoid circular dependency issues at module load time.
let _db = null;
function getDb() {
  if (!_db) {
    try { _db = require('../db'); } catch (_e) { return null; }
  }
  return _db;
}

/**
 * Maps dot-namespaced event prefix to a service name for diagnostic_log.
 * 'wix.pricing_plans.fetch_failed' → 'wix-plans-api'
 * 'hmac.failure'                   → 'hmac-monitor'
 */
function deriveService(event) {
  const prefix = (event || '').split('.')[0];
  const map = {
    wix:      'wix-plans-api',
    kisi:     'kisi-connector',
    hw:       'hardware-adapter',
    hardware: 'hardware-adapter',
    queue:    'queue-worker',
    grant:    'grant-revoke',
    revoke:   'grant-revoke',
    hmac:     'hmac-monitor',
    webhook:  'webhook-processor',
    retry:    'retry-engine',
    operator: 'operator-api',
    member:   'member-sync-api',
  };
  return map[prefix] || prefix || 'unknown';
}

/**
 * Persist warn/error/critical events to diagnostic_log.
 * Fire-and-forget via setImmediate — never awaited, never throws into caller.
 *
 * @param {string}  level
 * @param {string}  event
 * @param {Object}  ctx       - already-redacted entry fields
 * @param {Error}   err
 * @param {string}  traceId
 * @param {{ type: string, id: string } | undefined} actor
 */
function persistToDiagnosticLog(level, event, ctx, err, traceId, actor) {
  try {
  // Derive error_code: prefer err.code (KEDB-aligned), else humanise the event name.
  const errorCode = (err && err.code) ? err.code : event.toUpperCase().replace(/\./g, '_');

  // Human message: prefer operator-safe userMessage, else err.message, else event name.
  const message = (err && (err.userMessage || err.message)) || event;

  // Merge context — pull clientId from multiple conventions used across the codebase.
  const clientId = ctx.tenantId || ctx.clientId || null;

  const context = {
    ...ctx,
    ...(traceId ? { traceId } : {}),
    ...(err ? {
      httpStatus:  err.statusCode || null,
      resolution:  err.resolution || null,
    } : {}),
  };
  // Remove internal fields that don't belong in the DB context column.
  delete context.tenantId;
  delete context.clientId;

  setImmediate(() => {
    // Catch every failure mode — including post-teardown require errors in tests
    // ("trying to import a file after the Jest environment has been torn down").
    // Never propagate to caller; never crash the worker.
    try {
      const db = getDb();
      if (!db || typeof db.query !== 'function') return;
      const result = db.query(
        `INSERT INTO diagnostic_log
         (client_id, service, level, error_code, message, context, trace_id, actor_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          clientId,
          deriveService(event),
          level,
          errorCode,
          message,
          JSON.stringify(context),
          traceId || null,
          actor?.type || null,
          actor?.id   || null,
        ]
      );
      // db.query may return a Promise (real pg) or any value (test mocks)
      if (result && typeof result.catch === 'function') {
        result.catch((dbErr) => {
          try {
            process.stdout.write(JSON.stringify({
              ts: new Date().toISOString(), level: 'error',
              event: 'logger.diagnostic_log_write_failed',
              error: { message: dbErr.message, code: dbErr.code },
            }) + '\n');
          } catch (_) { /* stdout closed — nothing to do */ }
        });
      }
    } catch (_) {
      /* swallow — log persistence is fire-and-forget by contract */
    }
  });
  } catch (_) {
    /* swallow — entire persist function is fire-and-forget; never crash callers */
  }
}

// ── Core emit ─────────────────────────────────────────────────────

/**
 * Emit a single structured log line to stdout.
 * For warn/error/critical: also persists to diagnostic_log (fire-and-forget).
 *
 * trace_id and actor are auto-populated from ALS context (DR-037).
 * An explicit traceId arg overrides the ALS value (withTrace() escape hatch).
 *
 * @param {string} level     - debug | info | warn | error | critical
 * @param {string} event     - dot.namespaced event name, e.g. 'grant.complete'
 * @param {Object} ctx       - context fields: tenantId, memberId, jobId, etc.
 * @param {Error}  [err]     - optional Error object — adds stack + KEDB lookup
 * @param {string} [traceId] - explicit override; use withTrace() for this path
 */
function emit(level, event, ctx = {}, err = null, traceId = null) {
  if (level === 'debug' && PRODUCTION) return;

  // Auto-pull from ALS; explicit arg wins (withTrace() path)
  const effectiveTraceId = traceId || getTraceId();
  const actor            = getActor();

  const entry = {
    ts:    new Date().toISOString(),
    level,
    event,
    ...ctx,
  };

  // Top-level `message` for log aggregators (Railway, etc.) that key off it.
  // Priority: caller-provided ctx.message > err.message > event name fallback.
  entry.message = (ctx && ctx.message) || (err && err.message) || event;

  if (effectiveTraceId)  entry.traceId    = effectiveTraceId;
  if (actor) {
    entry.actor_type = actor.type;
    entry.actor_id   = actor.id;
  }

  if (err) {
    entry.error = {
      message: err.message,
      code:    err.code       || null,
      status:  err.statusCode || null,
      stack:   PRODUCTION ? undefined : err.stack,
    };
    if (err.code && KEDB[err.code]) entry.kedb = KEDB[err.code];
    if (err.userMessage) entry.userMessage = err.userMessage;
    if (err.resolution)  entry.resolution  = err.resolution;
  }

  // Redaction — applied before stdout AND before DB write (DR-039)
  const safeEntry = redact(entry);

  process.stdout.write(JSON.stringify(safeEntry) + '\n');

  // OB-176: EVENT_REGISTRY.json overrides level-based default.
  //   Registered entry → persist = override.persist
  //   No entry         → persist = (level is warn/error/critical)
  // For unregistered info-level events, emit one-time dev warn so authors
  // know to add an entry if they want it persisted (Builder ruling b).
  const levelDefaultPersist = (level === 'warn' || level === 'error' || level === 'critical');
  const override = REGISTRY_OVERRIDES.get(event);
  const shouldPersist = override ? override.persist : levelDefaultPersist;

  if (!override && level === 'info' && !_warnedUnregisteredEvents.has(event)) {
    _warnedUnregisteredEvents.add(event);
    // Write to stderr directly — using log.warn() here would recursively re-enter
    // emit() and risk an infinite loop if the warn event itself is unregistered.
    // The no-raw-console P3 test bans console.* even in logger.js; stderr.write
    // is the established escape hatch (same pattern as the stdout-write fallback
    // in persistToDiagnosticLog for DB write failures).
    try {
      process.stderr.write(
        `[logger] unregistered event: ${event} — add to core/EVENT_REGISTRY.json or accept default suppression\n`
      );
    } catch (_) { /* stderr closed — nothing to do */ }
  }

  if (shouldPersist) {
    persistToDiagnosticLog(level, event, safeEntry, err, effectiveTraceId, actor);
  }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Base logger — use when no trace ID is available yet.
 */
const log = {
  debug:    (event, ctx, err) => emit('debug',    event, ctx, err),
  info:     (event, ctx, err) => emit('info',     event, ctx, err),
  warn:     (event, ctx, err) => emit('warn',     event, ctx, err),
  error:    (event, ctx, err) => emit('error',    event, ctx, err),
  critical: (event, ctx, err) => emit('critical', event, ctx, err),
};

/**
 * Returns a trace-scoped logger — every call automatically includes traceId.
 * Use this in queue-worker.js after reading traceId from job.data.standardEvent.
 *
 * @param {string} traceId
 * @returns {{ debug, info, warn, error, critical }}
 */
function withTrace(traceId) {
  return {
    debug:    (event, ctx, err) => emit('debug',    event, ctx, err, traceId),
    info:     (event, ctx, err) => emit('info',     event, ctx, err, traceId),
    warn:     (event, ctx, err) => emit('warn',     event, ctx, err, traceId),
    error:    (event, ctx, err) => emit('error',    event, ctx, err, traceId),
    critical: (event, ctx, err) => emit('critical', event, ctx, err, traceId),
  };
}

module.exports = { log, withTrace, KEDB };
