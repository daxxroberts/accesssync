/**
 * admin/routes/members.js
 * Admin Hub — Debug Center
 *
 * GET  /admin/members/search?q=&client_id=   Cross-tenant member search
 * GET  /admin/members/:id/timeline           Full event timeline for one member
 * POST /admin/members/:id/retry              Re-queue latest failed job for member
 */

const router = require('express').Router();
const { log } = require('../../core/logger');
const db     = require('../../db');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../../core/redis-utils');
const { decryptApiKey } = require('../../core/crypto-utils');

const eventQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

// ── GET /admin/members/search ──────────────────────────────────
// OB-13: Searches by platform_member_id OR email.
// Email search: calls Wix API to resolve email → platformMemberId → DB query.
router.get('/search', async (req, res) => {
  try {
    const { q = '', client_id, limit = 50 } = req.query;
    if (!q.trim()) return res.json({ data: [] });

    const isEmail = q.includes('@');
    let platformMemberIds = null;

    // OB-13: If searching by email, try to resolve via Wix API first
    if (isEmail && client_id) {
      try {
        const clientResult = await db.query('SELECT source_site_id, source_api_key FROM clients WHERE id = $1', [client_id]);
        const siteId = clientResult.rows[0]?.source_site_id;
        const encWixKey = clientResult.rows[0]?.source_api_key;
        if (siteId && encWixKey) {
          const wixApiKey = decryptApiKey(encWixKey);
          // Call Wix Members API to search by email
          const wixRes = await fetch(
            `https://www.wixapis.com/members/v1/members/query`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': wixApiKey,
                'wix-site-id': siteId,
              },
              body: JSON.stringify({
                query: { filter: { 'loginEmail': { '$eq': q.trim() } } }
              })
            }
          );
          if (wixRes.ok) {
            const wixData = await wixRes.json();
            if (wixData.members && wixData.members.length > 0) {
              platformMemberIds = wixData.members.map(m => m._id);
            }
          }
        }
      } catch (wixErr) {
        log.warn('admin.members_email_lookup_failed', {}, wixErr);
      }
    }

    // Build query — search by resolved IDs or by pattern match
    const params = [];
    const conditions = [];

    if (platformMemberIds && platformMemberIds.length > 0) {
      params.push(platformMemberIds);
      conditions.push(`mi.platform_member_id = ANY($${params.length})`);
    } else {
      params.push(`%${q.trim()}%`);
      conditions.push(
        `(mi.platform_member_id ILIKE $${params.length}
          OR mi.email ILIKE $${params.length}
          OR mi.display_name ILIKE $${params.length}
          OR mi.first_name ILIKE $${params.length}
          OR mi.last_name ILIKE $${params.length})`
      );
    }

    if (client_id) {
      params.push(client_id);
      conditions.push(`mi.client_id = $${params.length}`);
    }

    params.push(parseInt(limit));

    const result = await db.query(
      `SELECT mi.id,
              mi.client_id,
              mi.platform_member_id,
              mi.display_name,
              mi.email,
              mi.first_name,
              mi.last_name,
              mi.source_platform,
              mi.hardware_platform,
              mi.hardware_user_id,
              mi.created_at,
              mi.updated_at,
              mas.status          AS access_status,
              mas.provisioned_at,
              mas.role_assignment_id,
              c.name              AS client_name
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       LEFT JOIN clients             c   ON c.id = mi.client_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY mi.updated_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      searchType: platformMemberIds ? 'email_resolved' : 'pattern_match',
    });
  } catch (err) {
    log.error('admin.members_search_error', {}, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/members/by-client — Member Sync Panel ──────────────
// Returns paginated members for a client with optional location + status filters.
// Used by the Admin Hub Member Sync panel.
// NOTE: must be declared before /:id routes — Express matches /:id/timeline
// before /by-client if the literal route comes after the param route.
router.get('/by-client', async (req, res) => {
  try {
    const { client_id, location_id, status, page = 1, limit = 50 } = req.query;
    if (!client_id) return res.status(400).json({ error: 'client_id is required' });

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [client_id];
    const conditions = ['mi.client_id = $1'];

    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`mas.status = $${params.length}`);
    }

    if (location_id) {
      // Filter members who have role assignments at this location
      params.push(location_id);
      conditions.push(
        `EXISTS (
           SELECT 1 FROM member_role_assignments mra
           JOIN plan_mappings pm ON pm.id = mra.mapping_id AND pm.location_id = $${params.length}
           WHERE mra.member_id = mi.id
         )`
      );
    }

    params.push(parseInt(limit));
    params.push(offset);

    const [membersResult, countResult] = await Promise.all([
      db.query(
        `SELECT mi.id,
                mi.platform_member_id,
                mi.source_platform,
                mi.hardware_platform,
                mi.hardware_user_id,
                mi.created_at,
                mas.status          AS access_status,
                mas.provisioned_at,
                mas.updated_at      AS state_updated_at,
                mal.event_type      AS last_event_type,
                mal.created_at      AS last_event_at,
                lat.webhook_received_at,
                lat.enqueued_at,
                lat.kisi_confirmed_at,
                lat.ingest_s,
                lat.processing_s,
                lat.total_s
         FROM   member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         LEFT JOIN LATERAL (
           SELECT event_type, created_at
           FROM   member_access_log
           WHERE  member_id = mi.id
           ORDER  BY created_at DESC
           LIMIT  1
         ) mal ON TRUE
         LEFT JOIN LATERAL (
           SELECT
             wl.received_at                                                     AS webhook_received_at,
             pei.processed_at                                                   AS enqueued_at,
             mra.created_at                                                     AS kisi_confirmed_at,
             ROUND(EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)))::int  AS ingest_s,
             ROUND(EXTRACT(EPOCH FROM (mra.created_at   - pei.processed_at)))::int AS processing_s,
             ROUND(EXTRACT(EPOCH FROM (mra.created_at   - wl.received_at)))::int   AS total_s
           FROM webhook_log wl
           JOIN processed_event_ids pei ON pei.event_id = wl.event_id
           JOIN member_role_assignments mra ON mra.member_id = mi.id
           WHERE wl.client_id = mi.client_id
             AND wl.normalized_payload->>'platformMemberId' = mi.platform_member_id
             AND wl.hmac_status = 'accepted'
             AND wl.dedup_status = 'new'
             AND mra.created_at > wl.received_at
           ORDER BY wl.received_at DESC
           LIMIT 1
         ) lat ON TRUE
         WHERE  ${conditions.join(' AND ')}
         ORDER  BY mas.provisioned_at DESC NULLS LAST
         LIMIT  $${params.length - 1} OFFSET $${params.length}`,
        params
      ),
      db.query(
        `SELECT COUNT(*)::int AS total
         FROM   member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         WHERE  ${conditions.join(' AND ')}`,
        params.slice(0, params.length - 2) // exclude limit + offset
      ),
    ]);

    // Status breakdown
    const breakdownResult = await db.query(
      `SELECT mas.status, COUNT(*)::int AS count
       FROM   member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       WHERE  mi.client_id = $1
       GROUP  BY mas.status`,
      [client_id]
    );
    const breakdown = {};
    for (const r of breakdownResult.rows) {
      breakdown[r.status || 'unknown'] = r.count;
    }

    res.json({
      data:      membersResult.rows,
      total:     countResult.rows[0].total,
      page:      parseInt(page),
      limit:     parseInt(limit),
      breakdown,
    });
  } catch (err) {
    log.error('admin.members_by_client_error', {}, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/members/:id/diagnose ───────────────────────────
// Structured diagnostic: runs all checks, returns a verdict + findings list.
// Checks: identity, state, sources vs mappings, roles, recent errors.
// Verdict: 'healthy' | 'degraded' | 'failed' | 'mismatch'
router.get('/:id/diagnose', async (req, res) => {
  try {
    const { id } = req.params;
    const findings = [];
    let verdict = 'healthy';

    // 1. Identity + state
    const memberResult = await db.query(
      `SELECT mi.*, mas.status AS access_status, mas.provisioned_at
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       WHERE mi.id = $1`,
      [id]
    );
    if (!memberResult.rows.length) return res.status(404).json({ error: 'Member not found' });
    const member = memberResult.rows[0];

    if (member.access_status === 'failed') {
      verdict = 'failed';
      findings.push({ level: 'error', code: 'STATUS_FAILED', message: 'Member access_state is failed — grant job exhausted retries or was never completed.' });
    } else if (member.access_status !== 'active') {
      verdict = 'degraded';
      findings.push({ level: 'warn', code: 'STATUS_NOT_ACTIVE', message: `Access status is "${member.access_status}" — expected "active".` });
    }

    // 2. Hardware role assignments
    const rolesResult = await db.query(
      `SELECT mra.*, pm.plan_name, pm.door_name, pm.hardware_group_id AS mapping_group_id
       FROM member_role_assignments mra
       LEFT JOIN plan_mappings pm ON pm.id = mra.mapping_id
       WHERE mra.member_id = $1`,
      [id]
    );
    const roles = rolesResult.rows;
    if (roles.length === 0) {
      if (verdict === 'healthy') verdict = 'degraded';
      findings.push({ level: 'warn', code: 'NO_ROLE_ASSIGNMENTS', message: 'No hardware role assignments found — member has no door access provisioned in DB.' });
    }

    // 3. Access sources vs active plan mappings
    const sourcesResult = await db.query(
      `SELECT mas2.*, pm.plan_name, pm.status AS mapping_status
       FROM member_access_sources mas2
       LEFT JOIN plan_mappings pm ON pm.id = mas2.mapping_id
       WHERE mas2.member_id = $1`,
      [id]
    );
    const sources = sourcesResult.rows;
    if (sources.length === 0 && roles.length > 0) {
      verdict = 'mismatch';
      findings.push({ level: 'error', code: 'SOURCES_MISSING', message: 'Hardware role exists but no member_access_sources rows found — revoke logic will not fire correctly.' });
    }

    // Check for inactive mapping references
    for (const src of sources) {
      if (src.mapping_status === 'inactive') {
        findings.push({ level: 'warn', code: 'SOURCE_INACTIVE_MAPPING', message: `Source row references inactive mapping "${src.plan_name}" — plan was disabled but source row was not cleaned up.` });
        if (verdict === 'healthy') verdict = 'degraded';
      }
    }

    // Check for role assignments without a matching source row (orphaned role)
    for (const role of roles) {
      const matchingSource = sources.find(s => s.mapping_id === role.mapping_id);
      if (!matchingSource) {
        verdict = 'mismatch';
        findings.push({ level: 'error', code: 'ORPHANED_ROLE', message: `Role assignment for "${role.plan_name || role.mapping_id}" has no matching source row — revoke will not clean up this hardware role.` });
      }
    }

    // 4. Recent diagnostic_log errors (last 24h)
    const recentErrors = await db.query(
      `SELECT error_code, message, created_at, context
       FROM diagnostic_log
       WHERE (context->>'memberId' = $1 OR context->>'platformMemberId' = $2)
         AND level = 'error'
         AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 10`,
      [id, member.platform_member_id]
    );
    for (const err of recentErrors.rows) {
      const alreadyFlagged = findings.some(f => f.code === err.error_code);
      if (!alreadyFlagged) {
        findings.push({ level: 'error', code: err.error_code, message: err.message, at: err.created_at, context: err.context });
        if (verdict === 'healthy') verdict = 'degraded';
      }
    }

    if (findings.length === 0) {
      findings.push({ level: 'ok', code: 'ALL_CHECKS_PASSED', message: `${roles.length} role(s), ${sources.length} source(s) — all consistent.` });
    }

    res.json({
      verdict,
      member: {
        id:               member.id,
        display_name:     member.display_name,
        email:            member.email,
        access_status:    member.access_status,
        hardware_user_id: member.hardware_user_id,
        provisioned_at:   member.provisioned_at,
      },
      roles,
      sources,
      findings,
    });
  } catch (err) {
    log.error('admin.members_diagnose_error', {}, err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/members/:id/timeline ───────────────────────────
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify member exists — include latency breakdown for timeline drawer
    const memberResult = await db.query(
      `SELECT mi.*, mas.status AS access_status, mas.provisioned_at, c.name AS client_name,
              lat.webhook_received_at, lat.enqueued_at, lat.kisi_confirmed_at,
              lat.ingest_s, lat.processing_s, lat.total_s
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       LEFT JOIN clients c ON c.id = mi.client_id
       LEFT JOIN LATERAL (
         SELECT
           wl.received_at                                                     AS webhook_received_at,
           pei.processed_at                                                   AS enqueued_at,
           mra.created_at                                                     AS kisi_confirmed_at,
           ROUND(EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)))::int  AS ingest_s,
           ROUND(EXTRACT(EPOCH FROM (mra.created_at   - pei.processed_at)))::int AS processing_s,
           ROUND(EXTRACT(EPOCH FROM (mra.created_at   - wl.received_at)))::int   AS total_s
         FROM webhook_log wl
         JOIN processed_event_ids pei ON pei.event_id = wl.event_id
         JOIN member_role_assignments mra ON mra.member_id = mi.id
         WHERE wl.client_id = mi.client_id
           AND wl.normalized_payload->>'platformMemberId' = mi.platform_member_id
           AND wl.hmac_status = 'accepted'
           AND wl.dedup_status = 'new'
           AND mra.created_at > wl.received_at
         ORDER BY wl.received_at DESC
         LIMIT 1
       ) lat ON TRUE
       WHERE mi.id = $1`,
      [id]
    );
    if (!memberResult.rows.length) return res.status(404).json({ error: 'Member not found' });

    // Unified timeline from 4 sources
    const timeline = await db.query(
      `SELECT 'access_log'      AS source,
              mal.id::text,
              mal.event_type,
              mal.error_code     AS detail,
              NULL::text         AS error_code,
              NULL::jsonb        AS context,
              mal.created_at
       FROM member_access_log mal
       WHERE mal.member_id = $1

       UNION ALL

       SELECT 'error_queue'     AS source,
              eq.id::text,
              eq.event_type,
              eq.error_reason    AS detail,
              eq.error_code,
              NULL::jsonb        AS context,
              eq.created_at
       FROM error_queue eq
       WHERE eq.member_id = $1

       UNION ALL

       SELECT 'adapter_log'     AS source,
              aal.id::text,
              aal.event_type,
              aal.result         AS detail,
              NULL::text         AS error_code,
              NULL::jsonb        AS context,
              aal.created_at
       FROM adapter_admin_log aal
       WHERE aal.platform_member_id = (
         SELECT platform_member_id FROM member_identity WHERE id = $1
       ) AND aal.client_id = (
         SELECT client_id FROM member_identity WHERE id = $1
       )

       UNION ALL

       SELECT 'diagnostic_log'  AS source,
              dl.id::text,
              dl.error_code      AS event_type,
              dl.message         AS detail,
              dl.error_code,
              dl.context,
              dl.created_at
       FROM diagnostic_log dl
       WHERE dl.context->>'memberId' = (SELECT id::text FROM member_identity WHERE id = $1)
          OR dl.context->>'platformMemberId' = (SELECT platform_member_id FROM member_identity WHERE id = $1)

       ORDER BY created_at DESC
       LIMIT 200`,
      [id]
    );

    res.json({
      member:   memberResult.rows[0],
      timeline: timeline.rows
    });
  } catch (err) {
    log.error('admin.members_timeline_error', {}, err);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/members/:id/retry ─────────────────────────────
router.post('/:id/retry', async (req, res) => {
  try {
    const { id } = req.params;

    // Get member's client context
    const memberResult = await db.query(
      'SELECT client_id FROM member_identity WHERE id = $1',
      [id]
    );
    if (!memberResult.rows.length) return res.status(404).json({ error: 'Member not found' });

    // Find most recent failed error_queue entry for this member
    const errorResult = await db.query(
      `SELECT id, client_id, event_type, payload
       FROM error_queue
       WHERE member_id = $1 AND status = 'failed'
       ORDER BY created_at DESC
       LIMIT 1`,
      [id]
    );
    if (!errorResult.rows.length) {
      return res.status(404).json({ error: 'No failed jobs found for this member' });
    }

    const { id: errorId, client_id: tenantId, event_type: eventType, payload } = errorResult.rows[0];
    const standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;

    const jobName = ['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(eventType)
      ? 'grant' : 'revoke';

    await eventQueue.add(jobName, { tenantId, standardEvent }, {
      jobId: `admin-member-retry-${id}-${Date.now()}`
    });

    await db.query(
      `UPDATE error_queue SET status='resolved', resolved_at=NOW(), dismissed_by='admin-retry' WHERE id=$1`,
      [errorId]
    );

    res.json({ ok: true, queued: jobName, errorId });
  } catch (err) {
    log.error('admin.members_retry_error', {}, err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
