/**
 * admin/routes/queue.js
 * Admin Hub — Queue Monitor
 *
 * GET /admin/queue/counts        BullMQ job counts (waiting/active/completed/failed/delayed)
 * GET /admin/queue/jobs?state=   Job list by state (max 50)
 *
 * Creates a read-only Queue instance pointing to the same Redis as Core Engine.
 * Frontend polls /counts every 5 seconds.
 */

const router    = require('express').Router();
const { Queue } = require('bullmq');
const { getRedisConnection } = require('../../core/redis-utils');

// Read-only Queue instance — connects to same Redis as Core Engine
const adminQueue = new Queue('accesssync-events', { connection: getRedisConnection() });

// ── GET /admin/queue/counts ────────────────────────────────────
router.get('/counts', async (req, res) => {
  try {
    const counts = await adminQueue.getJobCounts(
      'waiting', 'active', 'completed', 'failed', 'delayed', 'paused'
    );
    res.json(counts);
  } catch (err) {
    console.error('[Admin/queue] GET /counts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/queue/jobs?state= ───────────────────────────────
router.get('/jobs', async (req, res) => {
  try {
    const { state = 'failed', limit = 50 } = req.query;
    const validStates = ['waiting', 'active', 'completed', 'failed', 'delayed'];

    if (!validStates.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${validStates.join(', ')}` });
    }

    const jobs = await adminQueue.getJobs([state], 0, parseInt(limit) - 1);

    const formatted = jobs.map(j => ({
      id:           j.id,
      name:         j.name,
      attemptsMade: j.attemptsMade,
      processedOn:  j.processedOn,
      finishedOn:   j.finishedOn,
      failedReason: j.failedReason,
      tenantId:     j.data?.tenantId,
      eventType:    j.data?.standardEvent?.eventType,
      memberId:     j.data?.standardEvent?.platformMemberId,
    }));

    res.json({ state, data: formatted });
  } catch (err) {
    console.error('[Admin/queue] GET /jobs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
