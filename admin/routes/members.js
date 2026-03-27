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

function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return {
      host:     u.hostname,
      port:     parseInt(u.port) || 6379,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      username: u.username ? decodeURIComponent(u.username) : undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}
const connection = process.env.REDIS_URL
  ? parseRedisUrl(process.env.REDIS_URL)
  : { host: 'localhost', port: 6379 };
const eventQueue = new Queue('accesssync-events', { connection });

// ── GET /admin/members/search ──────────────────────────────────
router.get('/search', async (req, res) => {
  try {
    const { q = '', client_id, limit = 50 } = req.query;
    if (!q.trim()) return res.json({ data: [] });

    const params = [`%${q.trim()}%`, `%${q.trim()}%`, `%${q.trim()}%`];
    const conditions = [
      `(mi.email ILIKE $1 OR mi.display_name ILIKE $2 OR mi.platform_member_id ILIKE $3)`
    ];

    if (client_id) {
      params.push(client_id);
      conditions.push(`mi.client_id = $${params.length}`);
    }

    params.push(parseInt(limit));

    const result = await db.query(
      `SELECT mi.id,
              mi.client_id,
              mi.platform_member_id,
              mi.source_platform,
              mi.hardware_platform,
              mi.hardware_user_id,
              mi.email,
              mi.display_name,
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

module.exports = router;
