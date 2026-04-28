/**
 * @file trace-context.js
 * @layer core/shared
 * @role logging-context
 * @exports runWith, setActor, getContext, getTraceId, getActor, mintTraceId
 * @dr DR-037
 *
 * Universal trace + actor context via AsyncLocalStorage.
 *
 * Set the context once at every entry point (Express middleware, BullMQ handler,
 * cron starter, internal API caller). It propagates automatically through every
 * `await` to every downstream `log.*()` call. Zero call-site changes required.
 *
 * Usage at entry point:
 *   const { runWith, mintTraceId } = require('./trace-context');
 *   runWith({ traceId: mintTraceId(), actor: { type: 'operator', id: req.admin.email } }, () => {
 *     // every log.* call inside this function (and any awaited descendants)
 *     // automatically picks up traceId + actor from the context
 *   });
 *
 * Usage at log call site:
 *   No change required. logger.js reads context internally.
 *
 * BullMQ note: ALS does NOT cross the process boundary. Pass traceId in the job
 * payload and call runWith() at the top of the job handler to restore context.
 */

'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

const als = new AsyncLocalStorage();

let _db = null;
function getDb() {
  if (!_db) _db = require('../db');
  return _db;
}

const VALID_ACTOR_TYPES = ['owner', 'operator', 'member', 'system', 'webhook'];

/**
 * Run callback inside a new context. Any async descendants inherit it.
 * Nested runWith calls REPLACE the parent context (not merge).
 *
 * @param {Object} ctx
 * @param {string} ctx.traceId  - UUID v4 string
 * @param {Object} ctx.actor    - { type, id }
 * @param {Function} fn         - sync or async function to run inside the context
 * @returns whatever fn returns (Promise or value)
 */
function runWith(ctx, fn) {
  if (!ctx || !ctx.traceId) {
    throw new Error('runWith: ctx.traceId is required');
  }
  if (!ctx.actor || !ctx.actor.type || !ctx.actor.id) {
    throw new Error('runWith: ctx.actor.{type,id} is required');
  }
  if (!VALID_ACTOR_TYPES.includes(ctx.actor.type)) {
    throw new Error(`runWith: actor.type must be one of ${VALID_ACTOR_TYPES.join(', ')}, got ${ctx.actor.type}`);
  }
  return als.run({ traceId: ctx.traceId, actor: { type: ctx.actor.type, id: ctx.actor.id } }, fn);
}

/**
 * Update the actor portion of the current context.
 * Trace ID is immutable once set — actor can change (e.g., after auth resolves).
 * No-op if no context is active.
 *
 * @param {{ type: string, id: string }} actor
 */
function setActor(actor) {
  const ctx = als.getStore();
  if (!ctx) return;
  ctx.actor = { type: actor.type, id: actor.id };
}

/**
 * Returns the full context object or undefined if none is active.
 * @returns {{ traceId: string, actor: { type: string, id: string } } | undefined}
 */
function getContext() {
  return als.getStore();
}

/**
 * Returns the trace ID from the current context, or undefined.
 * @returns {string | undefined}
 */
function getTraceId() {
  const ctx = als.getStore();
  return ctx ? ctx.traceId : undefined;
}

/**
 * Returns the actor from the current context, or undefined.
 * @returns {{ type: string, id: string } | undefined}
 */
function getActor() {
  const ctx = als.getStore();
  return ctx ? ctx.actor : undefined;
}

/**
 * Generate a new UUID v4 trace ID. Use this at every entry point.
 * @returns {string} RFC 4122 UUID v4
 */
function mintTraceId() {
  return crypto.randomUUID();
}

/**
 * Register a trace in the trace_context lookup table.
 * Call once per entry point after mint — fire-and-forget, never throws to caller.
 *
 * Resolves client name, member name, hardware context, and source platform at
 * write time so the log viewer can filter/search without per-row JOINs.
 *
 * @param {string} traceId
 * @param {Object} opts
 * @param {string}  opts.entryPoint   - 'webhook' | 'operator_ui' | 'admin_ui' | 'cron' | 'queue' | 'api'
 * @param {string}  [opts.clientId]
 * @param {string}  [opts.memberId]   - member_identity.id (UUID)
 * @param {string}  [opts.actorType]
 * @param {string}  [opts.actorId]
 * @param {string}  [opts.planName]
 * @param {string}  [opts.doorName]
 * @param {string}  [opts.mappingId]
 */
function registerTrace(traceId, opts = {}) {
  if (!traceId) return;
  setImmediate(async () => {
    try {
      const db = getDb();

      let clientName = null;
      let memberName = null;
      let memberEmail = null;
      let platformMemberId = null;
      let sourcePlatform = null;
      let hardwarePlatform = null;
      let hardwareUserId = null;

      if (opts.clientId) {
        const cr = await db.query(
          'SELECT name FROM clients WHERE id = $1 LIMIT 1',
          [opts.clientId]
        );
        clientName = cr.rows[0]?.name || null;
      }

      if (opts.memberId) {
        const mr = await db.query(
          `SELECT first_name, last_name, display_name, email,
                  platform_member_id, source_platform,
                  hardware_platform, hardware_user_id
           FROM member_identity WHERE id = $1 LIMIT 1`,
          [opts.memberId]
        );
        if (mr.rows[0]) {
          const m = mr.rows[0];
          memberName = m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ') || null;
          memberEmail       = m.email;
          platformMemberId  = m.platform_member_id;
          sourcePlatform    = m.source_platform;
          hardwarePlatform  = m.hardware_platform;
          hardwareUserId    = m.hardware_user_id;
        }
      }

      await db.query(
        `INSERT INTO trace_context
           (trace_id, client_id, client_name, member_id, member_name, member_email,
            platform_member_id, source_platform, hardware_platform, hardware_user_id,
            plan_name, door_name, mapping_id, actor_type, actor_id, entry_point)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (trace_id) DO NOTHING`,
        [
          traceId,
          opts.clientId    || null,
          clientName,
          opts.memberId    || null,
          memberName,
          memberEmail,
          platformMemberId,
          sourcePlatform,
          hardwarePlatform,
          hardwareUserId,
          opts.planName    || null,
          opts.doorName    || null,
          opts.mappingId   || null,
          opts.actorType   || null,
          opts.actorId     || null,
          opts.entryPoint  || null,
        ]
      );
    } catch (err) {
      // Never propagate — trace registration must never break the main path
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(), level: 'warn',
        event: 'trace_context.write_failed',
        error: { message: err.message, code: err.code },
        traceId,
      }) + '\n');
    }
  });
}

module.exports = {
  runWith,
  setActor,
  getContext,
  getTraceId,
  getActor,
  mintTraceId,
  registerTrace,
};
