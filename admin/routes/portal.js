/**
 * @file portal.js
 * @layer admin/routes
 * @role operator-portal-entry
 * @route GET /operator-portal, GET /operator-portal/setup
 * @auth Wix signed instance (requireWixInstance) + operator/admin JWT (requireAuthPageOrOperator)
 * @exports router
 *
 * Operator Portal — entry point for Wix Dashboard Page Extension.
 *
 * Wix loads /operator-portal in an iframe in Chad's Wix dashboard sidebar.
 * The ?instance= token is verified, clientId resolved, operator JWT issued.
 * Setup check: if client has no API key and no locations → /operator-portal/setup
 * Otherwise → /dashboard?clientId=...
 */

'use strict';

const router = require('express').Router();
const db     = require('../../db');
const { log } = require('../../core/logger');
const { requireWixInstance } = require('../middleware/wix-instance');
const { signOperatorToken, requireAuthPageOrOperator } = require('../middleware/auth');

// ── GET /operator-portal ──────────────────────────────────────────
// Entry point Wix loads in the iframe. Verifies the signed instance,
// issues a scoped operator JWT cookie, checks setup status, then routes.
router.get('/', requireWixInstance, async (req, res) => {
  const { clientId, instanceId } = req.wixOperator;

  // Issue a scoped operator session cookie (8h) — include instanceId so /onboard can auto-wire source_site_id
  const token = signOperatorToken(clientId, instanceId);
  res.cookie('operatorToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'none', // required for iframe cross-site context
    maxAge:   8 * 60 * 60 * 1000,
  });

  try {
    // Check setup status — not set up if no API key AND no locations
    const [clientResult, locationResult] = await Promise.all([
      db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [clientId]),
      db.query('SELECT COUNT(*)::int AS count FROM locations WHERE client_id = $1', [clientId]),
    ]);

    const hasApiKey   = clientResult.rows[0]?.hardware_api_key != null;
    const hasLocation = locationResult.rows[0]?.count > 0;

    if (!hasApiKey && !hasLocation) {
      return res.redirect('/operator-portal/setup');
    }
  } catch (err) {
    log.error('admin.portal_setup_check_failed', {}, err);
    // On DB error, fall through to dashboard rather than blocking the operator
  }

  res.redirect(`/dashboard?clientId=${clientId}`);
});

// ── GET /operator-portal/setup ────────────────────────────────────
// Setup landing page shown when client has not yet completed onboarding.
// clientId comes from the operator JWT (set by requireAuthPageOrOperator).
router.get('/setup', requireAuthPageOrOperator, (req, res) => {
  const clientId    = req.admin?.clientId  || req.query.clientId;
  const instanceId  = req.admin?.instanceId || '';
  const inviteToken = process.env.OPERATOR_INVITE_TOKEN || '';
  res.render('pages/portal-setup', { clientId, instanceId, inviteToken });
});

module.exports = router;
