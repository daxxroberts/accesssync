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
         AND ($6::uuid IS NULL OR trace_id = $6)
       ORDER BY ts DESC
       LIMIT $7 OFFSET $8`,
      [sinceTs, untilTs, source || null, resultFilter || null,
       clientId || null, traceIdParam || null, limit, offset]
    );

    res.json({
      window: { since: sinceTs.toISOString(), until: untilTs ? untilTs.toISOString() : null },
      filters: {
        source: source || null,
        result: resultFilter || null,
        client_id: clientId || null,
        trace_id: traceIdParam || null,
      },
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

    // 1. Members (FTS via trace_context GIN index, idx_trace_context_fts).
    //    Note: `websearch_to_tsquery` is forgiving of bare words, quotes, and OR.
    const memberRes = await db.query(
      `SELECT DISTINCT ON (member_id)
              member_id, member_name, member_email,
              client_id, client_name, platform_member_id, hardware_user_id,
              MAX(started_at) OVER (PARTITION BY member_id) AS last_seen
       FROM trace_context
       WHERE member_id IS NOT NULL
         AND to_tsvector('english',
              coalesce(client_name,'') || ' ' || coalesce(member_name,'') || ' ' ||
              coalesce(member_email,'') || ' ' || coalesce(platform_member_id,'') || ' ' ||
              coalesce(hardware_user_id,'') || ' ' || coalesce(plan_name,'') || ' ' ||
              coalesce(door_name,'')
            ) @@ websearch_to_tsquery('english', $1)
       ORDER BY member_id, last_seen DESC
       LIMIT 5`,
      [q]
    );

    // 2. Clients (small table — ILIKE is fine).
    const clientRes = await db.query(
      `SELECT id AS client_id, name AS client_name
       FROM clients
       WHERE name ILIKE '%' || $1 || '%' AND status = 'active'
       LIMIT 3`,
      [q]
    );

    // 3. Traces (UUID prefix only — UUIDs aren't real text).
    const traceRes = await db.query(
      `SELECT trace_id, started_at, client_name, member_name,
              plan_name, door_name, entry_point
       FROM trace_context
       WHERE trace_id::text LIKE $1 || '%'
       ORDER BY started_at DESC
       LIMIT 4`,
      [q]
    );

    // 4. Untraced fallback (FAULT.2): when no resolved-member match,
    //    search raw payloads. Skipped if we found members already.
    let untracedRes = { rows: [] };
    if (memberRes.rows.length === 0) {
      untracedRes = await db.query(
        `SELECT trace_id, ts, source, event, client_id
         FROM v_trace_timeline
         WHERE ts > NOW() - INTERVAL '7 days'
           AND member_name IS NULL
           AND detail::text ILIKE '%' || $1 || '%'
         ORDER BY ts DESC
         LIMIT 5`,
        [q]
      );
    }

    res.json({
      members:  memberRes.rows,
      clients:  clientRes.rows,
      traces:   traceRes.rows,
      untraced: untracedRes.rows,
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

    const result = await db.query(
      `SELECT trace_id, ts, source, actor_type, actor_id, event,
              target_type, target_id, result, detail, client_id,
              client_name, member_name, member_email,
              source_platform, hardware_platform, hardware_user_id,
              plan_name, door_name, entry_point
       FROM v_trace_timeline
       WHERE trace_id = $1
       ORDER BY ts ASC`,
      [traceId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'trace_not_found', trace_id: traceId });
    }

    // Pull the trace_context header for drawer summary panel.
    const ctxRes = await db.query(
      `SELECT trace_id, started_at, client_id, client_name,
              member_id, member_name, member_email, platform_member_id,
              source_platform, hardware_platform, hardware_user_id,
              plan_name, door_name, mapping_id,
              actor_type, actor_id, entry_point
       FROM trace_context WHERE trace_id = $1`,
      [traceId]
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

module.exports = router;
