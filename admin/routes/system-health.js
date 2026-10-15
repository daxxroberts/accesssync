/**
 * admin/routes/system-health.js
 * Owner Hub — GET /admin/system-health
 *
 * Thin route over core/owner-health.js, which is also what the owner daily email renders from, so the
 * page and the email can never disagree. Owner-only (mounted behind requireAuth in admin/server.js).
 * Response contract: see computeOwnerHealth() in core/owner-health.js; `verdict_line` is the one-sentence
 * verdict the page and the email subject share.
 */

const router = require('express').Router();
const { log } = require('../../core/logger');
const { computeOwnerHealth, verdictLine, reconcileState, thresholds } = require('../../core/owner-health');

router.get('/', async (req, res) => {
  try {
    const h = await computeOwnerHealth();
    res.json({ ...h, verdict_line: verdictLine(h) });
  } catch (err) {
    log.error('admin.system_health.failed', {}, err);
    res.status(500).json({ error: err.message || 'Health check failed', _error: err.detail || null });
  }
});

module.exports = router;
module.exports.RECONCILE_GREEN_H = thresholds.RECONCILE_AMBER_H;
module.exports.RECONCILE_AMBER_H = thresholds.RECONCILE_RED_H;
module.exports.reconcileState = reconcileState;
