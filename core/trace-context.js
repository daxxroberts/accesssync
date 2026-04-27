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

module.exports = {
  runWith,
  setActor,
  getContext,
  getTraceId,
  getActor,
  mintTraceId,
};
