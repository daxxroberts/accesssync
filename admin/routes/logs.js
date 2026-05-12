/**
 * @file admin/routes/logs.js
 * @layer admin/routes
 * @role trace-timeline-api
 * @reads v_trace_timeline, trace_context, clients
 * @exports router (Express)
 * @dr DR-037, DR-041
 *
 * Trace Timeline API — backs the Admin Trace Timeline UI (Sprint 6).
 *
 * GET /admin/logs/events                 Paginated events feed (24h default, 7d max)
 * GET /admin/logs/typeahead?q=           Member / client / trace search (FTS + fallback)
 * GET /admin/logs/trace/:trace_id        Full ordered event list for one trace
 *
 * Auth: admin JWT required (mounted under requireAuth in admin/server.js).
 *
 * Query patterns are documented in handoff/QUERY_PATTERNS.md (Pattern N.1–N.4).
 *
 * Severity derivation: the view's `result` column carries different semantics
 * per source (HMAC status, error level, status). MVP returns `result` as-is and
 * lets the UI map it. Future migration may add a derived `severity` column.
 */

'use strict';

const router = require('express').Router();
const db = require('../../db');
const { log } = require('../../core/logger');

const VALID_SOURCES = new Set([
  'activity', 'webhook', 'diagnostic', 'member_access',
  'error_queue', 'admin_audit', 'config_alert',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Tenant-scope a request. Returns the client_id this caller is allowed to see:
 *   - Owner (no role or role !== 'operator'): may pass any client_id, may pass
 *     null to see all clients.
 *   - Operator (role === 'operator'): forced to their own clientId. Any
 *     client_id query param is ignored; they cannot cross tenants.
 *
 * This is the security boundary for the Trace Timeline. Without it, an
 * operator could pass ?client_id=<another-tenant-id> and read another
 * client's logs. With it, the parameter is silently overridden.
 */
function scopedClientId(req, requestedClientId) {
  if (req.admin?.role === 'operator') {
    return req.admin.clientId || null;
  }
  return requestedClientId || null;
}

function isOperator(req) {
  return req.admin?.role === 'operator';
}

// ─── GET /admin/logs/events ─────────────────────────────────────
// Paginated trace timeline feed. Bounded by `since` (required default 24h)
// and `until` (optional). Hard cap on `limit` server-side at 500.
router.get('/events', async (req, res) => {
  try {
    const {
      since, until, source, result: resultFilter,
      client_id: clientId, trace_id: traceIdParam,
      limit: rawLimit, offset: rawOffset,
    } = req.query;

    // Default window: last 24h. Hard-capped at 7 days back.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const oneDayAgo    = new Date(Date.now() - 24 * 60 * 60 * 1000);
    let sinceTs = since ? new Date(since) : oneDayAgo;
    if (Number.isNaN(sinceTs.getTime())) sinceTs = oneDayAgo;
    if (sinceTs < sevenDaysAgo) sinceTs = sevenDaysAgo;

    let untilTs = null;
    if (until) {
      const u = new Date(until);
      if (!Number.isNaN(u.getTime())) untilTs = u;
    }

    if (source && !VALID_SOURCES.has(source)) {
      return res.status(400).json({ error: 'invalid_source', valid: [...VALID_SOURCES] });
    }
    if (clientId && !UUID_RE.test(clientId)) {
      return res.status(400).json({ error: 'invalid_client_id' });
    }
    if (traceIdParam && !UUID_RE.test(traceIdParam)) {
      return res.status(400).json({ error: 'invalid_trace_id' });
    }

    // Tenant scope — operators are forced to their own clientId. Owners may
    // pass any clientId or omit it to see all clients.
    const effectiveClientId = scopedClientId(req, clientId);

    const limit  = Math.min(parseInt(rawLimit, 10) || 100, 500);
    const offset = Math.max(parseInt(rawOffset, 10) || 0, 0);

    const result = await db.query(
      `SELECT trace_id, ts, source, actor_type, actor_id, event,
              target_type, target_id, result, detail, client_id,
              client_name, member_name, member_email,
              source_platform, hardware_platform, hardware_user_id,
              plan_name, door_name, entry_point
       FROM v_trace_timeline
       WHERE ts >= $1
         AND ($2::timestamptz IS NULL OR ts < $2)
         AND ($3::text IS NULL OR source = $3)
         AND ($4::text IS NULL OR result = $4)
         AND ($5::uuid IS NULL OR client_id = $5)
         AND ($6::text IS NULL OR trace_id = $6)
       ORDER BY ts DESC
       LIMIT $7 OFFSET $8`,
      [sinceTs, untilTs, source || null, resultFilter || null,
       effectiveClientId, traceIdParam || null, limit, offset]
    );

    res.json({
      window: { since: sinceTs.toISOString(), until: untilTs ? untilTs.toISOString() : null },
      filters: {
        source: source || null,
        result: resultFilter || null,
        client_id: effectiveClientId,
        trace_id: traceIdParam || null,
      },
      role: isOperator(req) ? 'operator' : 'owner',
      pagination: { limit, offset, returned: result.rows.length },
      events: result.rows,
    });
  } catch (err) {
    log.error('admin.logs.events_failed', {}, err);
    res.status(500).json({ error: 'logs_events_failed' });
  }
});

// ─── GET /admin/logs/typeahead ──────────────────────────────────
// Search members, clients, traces. Includes FAULT.2 fallback: untraced
// payload search when no member match is found.
router.get('/typeahead', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.json({ members: [], clients: [], traces: [], untraced: [] });
    }

    // Tenant scope — for operators, every query gets WHERE client_id = their_id
    // injected. Owners pass null and see everything.
    const scopeId = scopedClientId(req, null);

    // 1. Members (FTS via trace_context GIN index, idx_trace_context_fts).
    const memberRes = await db.query(
      `SELECT DISTINCT ON (member_id)
              member_id, member_name, member_email,
              client_id, client_name, platform_member_id, hardware_user_id,
              MAX(started_at) OVER (PARTITION BY member_id) AS last_seen
       FROM trace_context
       WHERE member_id IS NOT NULL
         AND ($2::uuid IS NULL OR client_id = $2)
         AND to_tsvector('english',
              coalesce(client_name,'') || ' ' || coalesce(member_name,'') || ' ' ||
              coalesce(member_email,'') || ' ' || coalesce(platform_member_id,'') || ' ' ||
              coalesce(hardware_user_id,'') || ' ' || coalesce(plan_name,'') || ' ' ||
              coalesce(door_name,'')
            ) @@ websearch_to_tsquery('english', $1)
       ORDER BY member_id, last_seen DESC
       LIMIT 5`,
      [q, scopeId]
    );

    // 2. Clients — owners only. Operators have a single client (their own);
    //    surfacing it via search would imply multi-client capability they
    //    don't have.
    let clientRes = { rows: [] };
    if (!isOperator(req)) {
      clientRes = await db.query(
        `SELECT id AS client_id, name AS client_name
         FROM clients
         WHERE name ILIKE '%' || $1 || '%' AND status = 'active'
         LIMIT 3`,
        [q]
      );
    }

    // 3. Traces — scoped for operators.
    const traceRes = await db.query(
      `SELECT trace_id, started_at, client_name, member_name,
              plan_name, door_name, entry_point
       FROM trace_context
       WHERE trace_id::text LIKE $1 || '%'
         AND ($2::uuid IS NULL OR client_id = $2)
       ORDER BY started_at DESC
       LIMIT 4`,
      [q, scopeId]
    );

    // 4. Untraced fallback (FAULT.2). Scoped for operators.
    let untracedRes = { rows: [] };
    if (memberRes.rows.length === 0) {
      untracedRes = await db.query(
        `SELECT trace_id, ts, source, event, client_id
         FROM v_trace_timeline
         WHERE ts > NOW() - INTERVAL '7 days'
           AND member_name IS NULL
           AND ($2::uuid IS NULL OR client_id = $2)
           AND detail::text ILIKE '%' || $1 || '%'
         ORDER BY ts DESC
         LIMIT 5`,
        [q, scopeId]
      );
    }

    res.json({
      members:  memberRes.rows,
      clients:  clientRes.rows,
      traces:   traceRes.rows,
      untraced: untracedRes.rows,
      role:     isOperator(req) ? 'operator' : 'owner',
    });
  } catch (err) {
    log.error('admin.logs.typeahead_failed', { q: req.query.q }, err);
    res.status(500).json({ error: 'logs_typeahead_failed' });
  }
});

// ─── GET /admin/logs/trace/:trace_id ────────────────────────────
// Full event list for one trace, chronological. Drives the drawer detail
// view in the Trace Timeline UI.
router.get('/trace/:trace_id', async (req, res) => {
  try {
    const { trace_id: traceId } = req.params;
    if (!UUID_RE.test(traceId)) {
      return res.status(400).json({ error: 'invalid_trace_id' });
    }

    const scopeId = scopedClientId(req, null);

    const result = await db.query(
      `SELECT trace_id, ts, source, actor_type, actor_id, event,
              target_type, target_id, result, detail, client_id,
              client_name, member_name, member_email,
              source_platform, hardware_platform, hardware_user_id,
              plan_name, door_name, entry_point
       FROM v_trace_timeline
       WHERE trace_id = $1
         AND ($2::uuid IS NULL OR client_id = $2)
       ORDER BY ts ASC`,
      [traceId, scopeId]
    );

    if (result.rows.length === 0) {
      // Operators get the same 404 whether the trace truly doesn't exist or
      // belongs to a different tenant — never confirm cross-tenant existence.
      return res.status(404).json({ error: 'trace_not_found', trace_id: traceId });
    }

    // Pull the trace_context header for drawer summary panel.
    const ctxRes = await db.query(
      `SELECT trace_id, started_at, client_id, client_name,
              member_id, member_name, member_email, platform_member_id,
              source_platform, hardware_platform, hardware_user_id,
              plan_name, door_name, mapping_id,
              actor_type, actor_id, entry_point
       FROM trace_context
       WHERE trace_id = $1
         AND ($2::uuid IS NULL OR client_id = $2)`,
      [traceId, scopeId]
    );

    res.json({
      trace_id:     traceId,
      context:      ctxRes.rows[0] || null,
      event_count:  result.rows.length,
      first_event:  result.rows[0].ts,
      last_event:   result.rows[result.rows.length - 1].ts,
      events:       result.rows,
    });
  } catch (err) {
    log.error('admin.logs.trace_failed', { trace_id: req.params.trace_id }, err);
    res.status(500).json({ error: 'logs_trace_failed' });
  }
});

// ─── GET /admin/logs/bundle/trace/:trace_id ─────────────────────
// Assemble a paste-ready bundle for one trace. Returns the bundle text +
// metadata (chars, template_version, generated_at) + a pre-formatted stub
// the UI can show in the "log this?" modal if Daxx hits ✓.
const { buildTraceBundle, buildMemberBundle } = require('../../core/ai/bundle-assembler');

function buildStubText({ id, idField, bundleType, chars, templateVersion, generatedAt }) {
  const stubId = require('node:crypto').randomUUID();
  return [
    '<!-- ENTRY-START -->',
    `id: ${stubId}`,
    `timestamp: ${generatedAt}`,
    `bundle_type: ${bundleType}`,
    `${idField}: ${id}`,
    `template_version: ${templateVersion}`,
    `character_count: ${chars}`,
    'status: pending',
    '',
    '## claude_ai_response',
    '<!-- paste Claude.ai initial response here -->',
    '',
    '## claude_code_outcome',
    '<!-- paste Claude Code conclusion here after deeper investigation -->',
    '',
    '<!-- ENTRY-END -->',
    '',
  ].join('\n');
}

router.get('/bundle/trace/:trace_id', async (req, res) => {
  try {
    const { trace_id: traceId } = req.params;
    if (!UUID_RE.test(traceId)) {
      return res.status(400).json({ error: 'invalid_trace_id' });
    }
    // Tenant scope check — block cross-tenant bundle access for operators.
    const scopeId = scopedClientId(req, null);
    if (scopeId !== null) {
      const check = await db.query(
        'SELECT 1 FROM v_trace_timeline WHERE trace_id = $1 AND client_id = $2 LIMIT 1',
        [traceId, scopeId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'trace_not_found', trace_id: traceId });
      }
    }

    const bundle = await buildTraceBundle(traceId);
    const stub = buildStubText({
      id: traceId, idField: 'trace_id', bundleType: 'trace',
      chars: bundle.chars, templateVersion: bundle.template_version, generatedAt: bundle.generated_at,
    });
    res.json({
      trace_id: traceId,
      text: bundle.text,
      chars: bundle.chars,
      template_version: bundle.template_version,
      generated_at: bundle.generated_at,
      stub,
    });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    log.error('admin.logs.bundle_trace_failed', { trace_id: req.params.trace_id }, err);
    res.status(500).json({ error: 'bundle_trace_failed' });
  }
});

// ─── GET /admin/logs/bundle/member/:member_id ──────────────────
router.get('/bundle/member/:member_id', async (req, res) => {
  try {
    const { member_id: memberId } = req.params;
    if (!UUID_RE.test(memberId)) {
      return res.status(400).json({ error: 'invalid_member_id' });
    }
    const scopeId = scopedClientId(req, null);
    if (scopeId !== null) {
      // Post-migration: member_id refers to member_access.id (matches the
      // bundle-assembler interface). Existence check moves to member_access.
      const check = await db.query(
        'SELECT 1 FROM member_access WHERE id = $1 AND client_id = $2 LIMIT 1',
        [memberId, scopeId]
      );
      if (check.rows.length === 0) {
        return res.status(404).json({ error: 'member_not_found', member_id: memberId });
      }
    }

    const bundle = await buildMemberBundle(memberId);
    const stub = buildStubText({
      id: memberId, idField: 'member_id', bundleType: 'member',
      chars: bundle.chars, templateVersion: bundle.template_version, generatedAt: bundle.generated_at,
    });
    res.json({
      member_id: memberId,
      text: bundle.text,
      chars: bundle.chars,
      trace_count: bundle.trace_count,
      template_version: bundle.template_version,
      generated_at: bundle.generated_at,
      stub,
    });
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: err.message });
    log.error('admin.logs.bundle_member_failed', { member_id: req.params.member_id }, err);
    res.status(500).json({ error: 'bundle_member_failed' });
  }
});

module.exports = router;
