/**
 * @file trace-context.js
 * @layer admin/middleware
 * @role logging-context
 * @reads x-trace-id (inbound header), req.admin, req.wixOperator, req.member
 * @writes x-trace-id (outbound response header)
 * @calls core/trace-context (runWith, mintTraceId)
 * @exports traceContextMiddleware, resolveActor
 * @dr DR-037
 *
 * Mints a trace ID on every request and resolves the actor from auth context.
 * Wraps the request lifecycle in AsyncLocalStorage so every downstream log.*
 * call inherits trace_id, actor_type, and actor_id automatically.
 *
 * MUST mount AFTER cookieParser and AFTER auth middleware that populates
 * req.admin / req.wixOperator. MUST mount BEFORE any route handler.
 *
 * Honors an inbound x-trace-id header only on authenticated (req.admin) requests, so a
 * signed-in admin → core call can chain traces; on any other request a fresh id is minted.
 */

'use strict';

const { runWith, mintTraceId, registerTrace } = require('../../core/trace-context');

const VALID_TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve actor from the current request's auth context.
 * Priority: owner > operator > wixOperator > member > webhook > anonymous
 *
 * @param {import('express').Request} req
 * @returns {{ type: string, id: string }}
 */
function resolveActor(req) {
  if (req.admin && req.admin.email) {
    const isOwner = req.admin.email === process.env.ADMIN_ALLOWED_EMAIL;
    return { type: isOwner ? 'owner' : 'operator', id: req.admin.email };
  }
  // INCIDENT 2026-07-02 follow-up: the admin JWT payload is signed as { role: 'admin' } —
  // email is verified via Google OAuth at login but never added to the token, so admin
  // sessions always missed the branch above and fell through to 'system'/'anonymous' in
  // every activity/diagnostic log entry. There is exactly one admin today
  // (ADMIN_ALLOWED_EMAIL), so substitute it directly rather than reissuing tokens.
  if (req.admin && req.admin.role === 'admin' && process.env.ADMIN_ALLOWED_EMAIL) {
    return { type: 'owner', id: process.env.ADMIN_ALLOWED_EMAIL };
  }
  if (req.admin && req.admin.role === 'operator' && req.admin.clientId) {
    return { type: 'operator', id: `wix:${req.admin.clientId}` };
  }
  if (req.wixOperator && req.wixOperator.uid) {
    return { type: 'operator', id: `wix-uid:${req.wixOperator.uid}` };
  }
  if (req.member && req.member.id) {
    return { type: 'member', id: req.member.id };
  }
  if (req.path && req.path.startsWith('/webhook')) {
    return { type: 'webhook', id: req.path };
  }
  return { type: 'system', id: 'anonymous' };
}

/**
 * Express middleware — mount on both admin/server.js and server.js.
 * After auth middleware, before route handlers.
 */
function traceContextMiddleware(req, res, next) {
  // An inbound trace id is only trusted from a signed-in session. Anyone can send the header on a public request
  // (a webhook, the member hub): reusing a victim's trace id would let a stranger's log rows inherit that trace's
  // client through trace_context and appear on another gym's log. Nothing in AccessSync sends it today.
  const inbound = req.admin ? req.headers['x-trace-id'] : null;
  const traceId = (inbound && VALID_TRACE_ID.test(inbound)) ? inbound : mintTraceId();

  const actor = resolveActor(req);

  res.setHeader('x-trace-id', traceId);

  // Resolve clientId from auth context for trace_context enrichment
  const clientId = req.admin?.clientId
    || req.wixOperator?.clientId
    || req.params?.clientId
    || null;

  const entryPoint = req.path?.startsWith('/webhook') ? 'webhook'
    : req.admin?.email ? 'admin_ui'
    : clientId ? 'operator_ui'
    : 'api';

  const traceOpts = {
    entryPoint,
    clientId,
    actorType: actor.type,
    actorId:   actor.id,
  };

  // 'api' is a request with no resolved operator, client, or webhook — which, because per-router
  // auth runs after this middleware, is nearly every admin HTTP request. Written eagerly, those
  // rows held nothing but a timestamp: 260k of them, 99.9% never referenced by any log table
  // (2026-10-15 review). So an 'api' trace is parked on the context and written only when
  // something is actually logged under it — db.js flushes it before any trace-bearing INSERT.
  // Every other entry point (webhook, admin_ui, operator_ui) is a real, attributable trace and
  // is still registered up front.
  const lazy = entryPoint === 'api';
  if (!lazy) registerTrace(traceId, traceOpts);

  runWith({ traceId, actor, clientId, pendingTrace: lazy ? traceOpts : undefined }, () => {
    next();
  });
}

module.exports = { traceContextMiddleware, resolveActor };
