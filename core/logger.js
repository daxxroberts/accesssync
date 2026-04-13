/**
 * @file logger.js
 * @layer core/shared
 * @role logging
 * @exports log, logger
 *
 * Structured JSON logger for AccessSync.
 *
 * Every log entry is a single JSON line written to stdout.
 * Railway ingests stdout — each line is a searchable, filterable log event.
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
 *   log.error('hardware.call.failed', { tenantId, memberId, code: err.code, error: err }, err);
 *
 * With a trace ID (pass through from the original webhook event):
 *   const logger = require('./logger').withTrace(traceId);
 *   logger.info('queue.job.start', { jobId, tenantId });
 *
 * Trace ID convention:
 *   Generated at webhook entry (wix-connector.js) as crypto.randomUUID().
 *   Attached to the BullMQ job payload as standardEvent.traceId.
 *   Every log in the grant/revoke path carries this ID.
 *   In Railway logs: filter by traceId to replay the full lifecycle of one webhook.
 */

'use strict';

const PRODUCTION = process.env.NODE_ENV === 'production';

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
};

/**
 * Emit a single structured log line to stdout.
 *
 * @param {string} level     - debug | info | warn | error | critical
 * @param {string} event     - dot.namespaced event name, e.g. 'grant.complete'
 * @param {Object} ctx       - context fields: tenantId, memberId, jobId, traceId, etc.
 * @param {Error}  [err]     - optional Error object — adds stack + KEDB lookup
 * @param {string} [traceId] - optional trace ID override (use withTrace() instead)
 */
function emit(level, event, ctx = {}, err = null, traceId = null) {
  // Suppress debug in production
  if (level === 'debug' && PRODUCTION) return;

  const entry = {
    ts:    new Date().toISOString(),
    level,
    event,
    ...ctx,
  };

  if (traceId) entry.traceId = traceId;

  if (err) {
    entry.error = {
      message: err.message,
      code:    err.code    || null,
      status:  err.statusCode || null,
      stack:   PRODUCTION ? undefined : err.stack,  // full stack in dev, omit in prod to reduce noise
    };
    // KEDB lookup — attach doc reference and resolution summary if known code
    if (err.code && KEDB[err.code]) {
      entry.kedb = KEDB[err.code];
    }
    // Attach userMessage + resolution if the error carried them (from connector layer)
    if (err.userMessage)  entry.userMessage  = err.userMessage;
    if (err.resolution)   entry.resolution   = err.resolution;
  }

  // Write single JSON line — Railway ingests this as a structured log event
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * Base logger — use when no trace ID is available yet.
 */
const log = {
  debug:    (event, ctx, err)      => emit('debug',    event, ctx, err),
  info:     (event, ctx, err)      => emit('info',     event, ctx, err),
  warn:     (event, ctx, err)      => emit('warn',     event, ctx, err),
  error:    (event, ctx, err)      => emit('error',    event, ctx, err),
  critical: (event, ctx, err)      => emit('critical', event, ctx, err),
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
