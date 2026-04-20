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
const { diagnoseMember, getTimeline } = require('../../core/diagnostics');

const eventQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

// ── GET /admin/members/search ──────────────────────────────────
// OB-13: Searches by platform_member_id OR email.
// Email search: calls Wix API to resolve email → platformMemberId → DB query.
router.get('/search', async (req, res) => {
  try {
    const { q = '', client_id, limit = 25 } = req.query;

    // No search term — return the most recently updated members (default view)
    if (!q.trim()) {
      const params = [];
      const conditions = [];
      if (client_id) {
        params.push(client_id);
        conditions.push(`mi.client_id = $${params.length}`);
      }
      params.push(parseInt(limit));
      const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await db.query(
        `SELECT mi.id, mi.client_id, mi.platform_member_id, mi.display_name,
                mi.email, mi.first_name, mi.last_name,
                mi.source_platform, mi.hardware_platform, mi.hardware_user_id,
                mi.created_at, mi.updated_at,
                mas.status AS access_status, mas.provisioned_at, mas.role_assignment_id,
                c.name AS client_name
         FROM member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         LEFT JOIN clients c ON c.id = mi.client_id
         ${whereClause}
         ORDER BY mi.updated_at DESC NULLS LAST
         LIMIT $${params.length}`,
        params
      );
      return res.json({ data: result.rows, searchType: 'recent' });
    }

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
                mi.display_name,
                mi.first_name,
                mi.last_name,
                mi.email,
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
                lat.total_s,
                (SELECT COUNT(DISTINCT mra.mapping_id)::int
                 FROM member_role_assignments mra
                 JOIN plan_mappings pm ON pm.id = mra.mapping_id AND pm.status = 'active'
                 WHERE mra.member_id = mi.id) AS plan_count
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
router.get('/:id/diagnose', async (req, res) => {
  try {
    const result = await diagnoseMember(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Member not found' });
    log.error('admin.members_diagnose_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /admin/members/:id/timeline ───────────────────────────
router.get('/:id/timeline', async (req, res) => {
  try {
    const result = await getTimeline(req.params.id);
    res.json(result);
  } catch (err) {
    if (err.statusCode === 404) return res.status(404).json({ error: 'Member not found' });
    log.error('admin.members_timeline_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /admin/members/:id/plans ──────────────────────────────
// Returns active plan mappings assigned to this member.
router.get('/:id/plans', async (req, res) => {
  try {
    const { id } = req.params;
    const memberCheck = await db.query('SELECT id FROM member_identity WHERE id = $1', [id]);
    if (!memberCheck.rows.length) return res.status(404).json({ error: 'Member not found' });

    const result = await db.query(
      `SELECT pm.id          AS mapping_id,
              pm.plan_name,
              pm.door_name,
              pm.access_type,
              pm.status,
              pm.source_plan_id,
              l.name         AS location_name,
              mra.created_at AS granted_at
       FROM member_role_assignments mra
       JOIN plan_mappings pm ON pm.id = mra.mapping_id
       LEFT JOIN locations l ON l.id = pm.location_id
       WHERE mra.member_id = $1
       ORDER BY pm.status DESC, mra.created_at DESC`,
      [id]
    );

    res.json({ plans: result.rows });
  } catch (err) {
    log.error('admin.members_plans_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
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
