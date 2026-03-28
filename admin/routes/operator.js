/**
 * admin/routes/operator.js
 * AccessSync Operator Dashboard API
 *
 * Operator-facing endpoints — no admin JWT required.
 * Client identified by UUID in URL path.
 * Auth: OB-08 (Wix JWT) will gate this properly pre-launch.
 */

const express = require('express');
const router = express.Router();
const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');

// ── GET /operator/:clientId ─────────────────────────────────────
// Client overview: name, platform status, all-location stats
router.get('/:clientId', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [clientResult, errorCount, activeMembers, totalMembers, locationCount] = await Promise.all([
      db.query(
        `SELECT id, name, site_url, platform, hardware_platform, tier,
                last_sync_at, last_wix_webhook_at
         FROM clients WHERE id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM error_queue
         WHERE client_id = $1 AND status = 'failed'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_access_state
         WHERE client_id = $1 AND status = 'active'`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM member_identity
         WHERE client_id = $1`,
        [clientId]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count FROM locations WHERE client_id = $1`,
        [clientId]
      ),
    ]);

    if (!clientResult.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json({
      client: clientResult.rows[0],
      stats: {
        error_count:    errorCount.rows[0].count,
        active_members: activeMembers.rows[0].count,
        total_members:  totalMembers.rows[0].count,
        location_count: locationCount.rows[0].count,
      },
    });
  } catch (err) {
    console.error('[operator] GET /:clientId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations ───────────────────────────
// Location list with per-location error count, door count, plan count
router.get('/:clientId/locations', async (req, res) => {
  const { clientId } = req.params;
  try {
    const [locations, errorCounts, doorCounts, planCounts] = await Promise.all([
      db.query(
        `SELECT id, name, city, state FROM locations
         WHERE client_id = $1 ORDER BY created_at ASC`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(*)::int AS count FROM error_queue
         WHERE client_id = $1 AND status = 'failed'
         GROUP BY location_id`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(DISTINCT door_name)::int AS count
         FROM plan_mappings
         WHERE client_id = $1 AND status = 'active'
         GROUP BY location_id`,
        [clientId]
      ),
      db.query(
        `SELECT location_id, COUNT(*)::int AS count FROM plan_mappings
         WHERE client_id = $1 GROUP BY location_id`,
        [clientId]
      ),
    ]);

    const errMap = {}, doorMap = {}, planMap = {};
    errorCounts.rows.forEach(r => { errMap[r.location_id] = r.count; });
    doorCounts.rows.forEach(r => { doorMap[r.location_id] = r.count; });
    planCounts.rows.forEach(r => { planMap[r.location_id] = r.count; });

    res.json({
      locations: locations.rows.map(loc => ({
        ...loc,
        error_count: errMap[loc.id] || 0,
        door_count:  doorMap[loc.id] || 0,
        plan_count:  planMap[loc.id] || 0,
      })),
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/locations error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /operator/:clientId/locations/:locationId ───────────────
// Location detail: errors, plan mappings, recent access log
router.get('/:clientId/locations/:locationId', async (req, res) => {
  const { clientId, locationId } = req.params;
  try {
    const [errors, planMappings, accessLog, activeMembers] = await Promise.all([
      db.query(
        `SELECT id, event_type, error_reason, retry_count, plan_name, door_name, created_at
         FROM error_queue
         WHERE location_id = $1 AND status = 'failed'
         ORDER BY created_at DESC`,
        [locationId]
      ),
      db.query(
        `SELECT id, wix_plan_id, hardware_group_id, plan_name, door_name, status, created_at
         FROM plan_mappings
         WHERE location_id = $1
         ORDER BY plan_name`,
        [locationId]
      ),
      db.query(
        `SELECT mal.id, mal.event_type, mal.credential_type, mal.created_at,
                mi.platform_member_id
         FROM member_access_log mal
         JOIN member_identity mi ON mi.id = mal.member_id
         WHERE mal.client_id = $1
         ORDER BY mal.created_at DESC LIMIT 10`,
        [clientId]
      ),
      db.query(
        `SELECT mi.id, mi.platform_member_id, mas.status, mas.provisioned_at
         FROM member_identity mi
         JOIN member_access_state mas ON mas.member_id = mi.id
         WHERE mi.client_id = $1
         ORDER BY mas.provisioned_at DESC NULLS LAST`,
        [clientId]
      ),
    ]);

    res.json({
      errors: errors.rows.map(e => ({
        ...e,
        plain_message: e.error_reason,
      })),
      plan_mappings: planMappings.rows,
      access_log: accessLog.rows,
      active_members: activeMembers.rows,
    });
  } catch (err) {
    console.error('[operator] GET /:clientId/locations/:locationId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/sync ───────────────────────────────
// Trigger sync — V1 placeholder: updates last_sync_at
router.post('/:clientId/sync', async (req, res) => {
  const { clientId } = req.params;
  try {
    const result = await db.query(
      `UPDATE clients SET last_sync_at = NOW() WHERE id = $1 RETURNING last_sync_at`,
      [clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json({ last_sync_at: result.rows[0].last_sync_at });
  } catch (err) {
    console.error('[operator] POST /:clientId/sync error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/errors/:errorId/dismiss ────────────
router.post('/:clientId/errors/:errorId/dismiss', async (req, res) => {
  const { clientId, errorId } = req.params;
  try {
    const result = await db.query(
      `UPDATE error_queue
       SET status = 'resolved', resolved_at = NOW(), dismissed_by = 'operator'
       WHERE id = $1 AND client_id = $2
       RETURNING id, status`,
      [errorId, clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Error not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[operator] POST errors/:errorId/dismiss error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /operator/:clientId/errors/:errorId/retry ──────────────
router.post('/:clientId/errors/:errorId/retry', async (req, res) => {
  const { clientId, errorId } = req.params;
  try {
    const result = await db.query(
      `SELECT * FROM error_queue WHERE id = $1 AND client_id = $2`,
      [errorId, clientId]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: 'Error not found' });
    }
    const error = result.rows[0];
    await eventQueue.add(error.event_type, error.payload, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });
    await db.query(
      `UPDATE error_queue SET status = 'resolved', resolved_at = NOW()
       WHERE id = $1`,
      [errorId]
    );
    res.json({ queued: true });
  } catch (err) {
    console.error('[operator] POST errors/:errorId/retry error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PATCH /operator/:clientId/plan-mappings/:mappingId ───────────
router.patch('/:clientId/plan-mappings/:mappingId', async (req, res) => {
  const { clientId, mappingId } = req.params;
  const { status, door_name, hardware_group_id } = req.body;
  try {
    const fields = [], vals = [mappingId, clientId];
    if (status !== undefined)            { fields.push(`status = $${vals.length + 1}`);            vals.push(status); }
    if (door_name !== undefined)         { fields.push(`door_name = $${vals.length + 1}`);         vals.push(door_name); }
    if (hardware_group_id !== undefined) { fields.push(`hardware_group_id = $${vals.length + 1}`); vals.push(hardware_group_id); }
    if (!fields.length) return res.status(400).json({ error: 'No fields to update' });
    const result = await db.query(
      `UPDATE plan_mappings SET ${fields.join(', ')} WHERE id = $1 AND client_id = $2 RETURNING *`,
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Mapping not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[operator] PATCH plan-mappings/:mappingId error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
