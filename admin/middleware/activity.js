/**
 * @file activity.js
 * @layer admin/middleware
 * @role activity-logging
 * @writes activity_event
 * @calls core/trace-context (getTraceId, getActor)
 * @exports recordActivity
 * @dr DR-037
 *
 * recordActivity() — call once per mutating route handler after the operation succeeds.
 * Writes a row to activity_event with the trace_id and actor from ALS context.
 * Fire-and-forget via setImmediate — never blocks the response, never throws to caller.
 *
 * Usage:
 *   const { recordActivity } = require('../middleware/activity');
 *
 *   router.post('/plan-mappings', requireAuth, async (req, res) => {
 *     await savePlanMapping(...);
 *     recordActivity(req, 'plan_mapping.created', { clientId: req.admin.clientId, mappingId });
 *     res.json({ ok: true });
 *   });
 *
 * event naming:  noun.verb  — e.g. plan_mapping.created, api_key.rotated, member.synced
 * ctx fields:    clientId (required), plus any fields relevant to the operation
 */

'use strict';

const { getTraceId, getActor } = require('../../core/trace-context');

let _db = null;
function getDb() {
  if (!_db) _db = require('../../db');
  return _db;
}

/**
 * Record an activity event.
 * Resolves actor + trace_id from ALS — no explicit passing required.
 *
 * @param {import('express').Request} req  - used for IP + user-agent (stored as context)
 * @param {string}  event  - e.g. 'plan_mapping.created'
 * @param {Object}  ctx    - { clientId, ...any other relevant fields }
 */
function recordActivity(req, event, ctx = {}) {
  const traceId  = getTraceId();
  const actor    = getActor();
  const clientId = ctx.clientId || null;

  // diff — everything except clientId, stored in the activity_event.diff column
  const diff = { ...ctx };
  delete diff.clientId;

  // request_meta — standard HTTP context for audit trail
  const requestMeta = req ? {
    method:     req.method,
    path:       req.originalUrl || req.path,
    ip:         req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
    user_agent: req.headers?.['user-agent'] || null,
  } : null;

  setImmediate(() => {
    const db = getDb();
    if (!db || typeof db.query !== 'function') return;
    db.query(
      `INSERT INTO activity_event
         (client_id, action, actor_type, actor_id, trace_id, diff, request_meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        clientId,
        event,
        actor?.type || null,
        actor?.id   || null,
        traceId     || null,
        Object.keys(diff).length ? JSON.stringify(diff) : null,
        requestMeta ? JSON.stringify(requestMeta) : null,
      ]
    ).catch((err) => {
      // Never propagate — activity logging must never break the main path.
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(), level: 'error',
        event: 'activity.write_failed',
        error: { message: err.message, code: err.code },
      }) + '\n');
    });
  });
}

module.exports = { recordActivity };
