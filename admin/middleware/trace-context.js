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
 * Honors inbound x-trace-id header so admin → core proxy calls can chain
 * traces across service boundaries.
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
  const inbound = req.headers['x-trace-id'];
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

  registerTrace(traceId, {
    entryPoint,
    clientId,
    actorType: actor.type,
    actorId:   actor.id,
  });

  runWith({ traceId, actor }, () => {
    next();
  });
}

module.exports = { traceContextMiddleware, resolveActor };
