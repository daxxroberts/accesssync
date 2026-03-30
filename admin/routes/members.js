/**
 * admin/routes/members.js
 * Admin Hub — Debug Center
 *
 * GET  /admin/members/search?q=&client_id=   Cross-tenant member search
 * GET  /admin/members/:id/timeline           Full event timeline for one member
 * POST /admin/members/:id/retry              Re-queue latest failed job for member
 */

const router = require('express').Router();
const db     = require('../../db');
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../../core/redis-utils');

const eventQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

// ── GET /admin/members/search ──────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { q = '', client_id, limit = 50 } = req.query;
    if (!q.trim()) return res.json({ data: [] });

    // Search by platform_member_id only — email/name resolved from Wix on-demand (data minimization)
    const params = [`%${q.trim()}%`];
    const conditions = [
      `mi.platform_member_id ILIKE $1`
    ];

    if (client_id) {
      params.push(client_id);
      conditions.push(`mi.client_id = $${params.length}`);
    }

    params.push(parseInt(limit));

    // Note: email/display_name are not stored (data minimization — fetched from Wix on-demand)
    const result = await db.query(
      `SELECT mi.id,
              mi.client_id,
              mi.platform_member_id,
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

    res.json({ data: result.rows });
  } catch (err) {
    console.error('[Admin/members] GET /search error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/members/:id/timeline ───────────────────────────
router.get('/:id/timeline', async (req, res) => {
  try {
    const { id } = req.params;

    // Verify member exists
    const memberResult = await db.query(
      `SELECT mi.*, mas.status AS access_status, mas.provisioned_at, c.name AS client_name
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       LEFT JOIN clients c ON c.id = mi.client_id
       WHERE mi.id = $1`,
      [id]
    );
    if (!memberResult.rows.length) return res.status(404).json({ error: 'Member not found' });

    // Unified timeline from 3 sources
    const timeline = await db.query(
      `SELECT 'access_log'      AS source,
              mal.id::text,
              mal.event_type,
              mal.error_code     AS detail,
              mal.created_at
       FROM member_access_log mal
       WHERE mal.member_id = $1

       UNION ALL

       SELECT 'error_queue'     AS source,
              eq.id::text,
              eq.event_type,
              eq.error_reason    AS detail,
              eq.created_at
       FROM error_queue eq
       WHERE eq.member_id = $1

       UNION ALL

       SELECT 'adapter_log'     AS source,
              aal.id::text,
              aal.event_type,
              aal.result         AS detail,
              aal.created_at
       FROM adapter_admin_log aal
       WHERE aal.platform_member_id = (
         SELECT platform_member_id FROM member_identity WHERE id = $1
       ) AND aal.client_id = (
         SELECT client_id FROM member_identity WHERE id = $1
       )

       ORDER BY created_at DESC
       LIMIT 100`,
      [id]
    );

    res.json({
      member:   memberResult.rows[0],
      timeline: timeline.rows
    });
  } catch (err) {
    console.error('[Admin/members] GET /:id/timeline error:', err.message);
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
    console.error('[Admin/members] POST /:id/retry error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/members/by-client — Member Sync Panel ──────────────
// Returns paginated members for a client with optional location + status filters.
// Used by the Admin Hub Member Sync panel.
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
                mal.created_at      AS last_event_at
         FROM   member_identity mi
         LEFT JOIN member_access_state mas ON mas.member_id = mi.id
         LEFT JOIN LATERAL (
           SELECT event_type, created_at
           FROM   member_access_log
           WHERE  member_id = mi.id
           ORDER  BY created_at DESC
           LIMIT  1
         ) mal ON TRUE
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
    console.error('[Admin/members] GET /by-client error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
