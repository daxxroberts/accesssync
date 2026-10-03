/**
 * @file onboarding.js
 * @layer admin/routes
 * @role onboarding-entry
 * @route GET /onboard, POST /onboard/redeem
 * @auth none to load the page; the invite token (or an existing session) decides what it shows
 *
 * Entry point for a gym completing setup. Replaces the old flow where /onboard was
 * public and wrote the platform-wide OPERATOR_INVITE_TOKEN into its own HTML.
 *
 *   GET  /onboard?invite=<token>  decides which screen to render. It changes NOTHING:
 *                                 no cookie, no state — so an email scanner, a link
 *                                 previewer or a second device opening it is harmless.
 *   POST /onboard/redeem          the person clicks "Start setup" → the token is
 *                                 exchanged for an operator session scoped to the one
 *                                 client it names. Every later call (the wizard's
 *                                 /operator/... requests) rides that cookie.
 *   GET  /onboard                 with an existing session → that client's wizard.
 *   (no invite, no session)       → a "you need a setup link" screen, never the wizard.
 *
 * The page receives a small `boot` object — never a secret. See core/invite-token.js
 * for the token format and why it is stateless.
 */

'use strict';

const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const db = require('../../db');
const { log } = require('../../core/logger');
const { verifyInvite } = require('../../core/invite-token');
const { signOperatorToken, readSession } = require('../middleware/auth');
const { recordActivity } = require('../middleware/activity');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATOR_COOKIE_MS = 8 * 60 * 60 * 1000;

async function findClient(clientId) {
  const r = await db.query('SELECT id, name, status FROM clients WHERE id = $1', [clientId]);
  return r.rows[0] || null;
}

/**
 * What should /onboard show? Pure decision, no side effects.
 * @returns {Promise<{mode:'invite'|'wizard'|'blocked', reason?:string, clientId?:string, clientName?:string, expiresAt?:number}>}
 */
async function computeBoot(req) {
  const invite = typeof req.query.invite === 'string' && req.query.invite ? req.query.invite : null;

  if (invite) {
    let v;
    try { v = verifyInvite(invite); }
    catch (err) {
      log.error('operator.invite.secret_missing', {}, err);
      return { mode: 'blocked', reason: 'unavailable' };
    }
    if (!v.ok) return { mode: 'blocked', reason: v.reason === 'expired' ? 'invite_expired' : 'invite_invalid' };
    const client = await findClient(v.clientId);
    if (!client || client.status !== 'active') return { mode: 'blocked', reason: 'invite_revoked' };
    return { mode: 'invite', clientName: client.name, expiresAt: v.expiresAt };
  }

  const session = readSession(req);
  if (session && session.role === 'operator') {
    const client = await findClient(session.clientId);
    if (client && client.status === 'active') return { mode: 'wizard', clientId: client.id, clientName: client.name };
    return { mode: 'blocked', reason: 'invite_revoked' };
  }
  if (session && session.role === 'admin') {
    const wanted = typeof req.query.clientId === 'string' ? req.query.clientId : '';
    if (!UUID_RE.test(wanted)) return { mode: 'blocked', reason: 'owner_no_client' };
    const client = await findClient(wanted);
    if (client) return { mode: 'wizard', clientId: client.id, clientName: client.name };
    return { mode: 'blocked', reason: 'owner_no_client' };
  }
  return { mode: 'blocked', reason: 'no_access' };
}

// ── GET /onboard ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  let boot;
  let status = 200;
  try {
    boot = await computeBoot(req);
  } catch (err) {
    log.error('operator.onboard.boot_failed', {}, err);
    boot = { mode: 'blocked', reason: 'unavailable' };
    status = 503;
  }
  // A page that decides on a bearer link must never be cached or leak it onward.
  res.set('Cache-Control', 'no-store');
  res.status(status).render('pages/onboard', { boot });
});

// ── POST /onboard/redeem ──────────────────────────────────────────
const redeemLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => {
    log.warn('operator.invite.rate_limited', {});
    res.status(429).json({ error: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' });
  },
});

router.post('/redeem', redeemLimiter, async (req, res) => {
  const token = req.body && req.body.token;

  let v;
  try { v = verifyInvite(token); }
  catch (err) {
    log.error('operator.invite.secret_missing', {}, err);
    return res.status(503).json({ error: 'unavailable', message: 'Setup links are temporarily unavailable. Try again shortly.' });
  }
  if (!v.ok) {
    log.warn('operator.invite.rejected', { reason: v.reason });
    const expired = v.reason === 'expired';
    return res.status(expired ? 410 : 400).json({
      error: expired ? 'invite_expired' : 'invite_invalid',
      message: expired ? 'This setup link has expired.' : 'This setup link is not valid.',
    });
  }

  try {
    const client = await findClient(v.clientId);
    if (!client || client.status !== 'active') {
      log.warn('operator.invite.rejected', { reason: 'revoked', clientId: v.clientId });
      return res.status(410).json({ error: 'invite_revoked', message: 'This setup link is no longer active.' });
    }

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('operatorToken', signOperatorToken(client.id, null), {
      httpOnly: true,
      secure:   isProd,
      sameSite: 'lax',          // top-level setup link; no cross-site sends of this cookie
      maxAge:   OPERATOR_COOKIE_MS,
    });

    req.admin = { role: 'operator', clientId: client.id };   // so the audit row names the actor
    recordActivity(req, 'client.invite_redeemed', { clientId: client.id, expiresAt: new Date(v.expiresAt).toISOString() });
    res.json({ ok: true, clientId: client.id, clientName: client.name });
  } catch (err) {
    log.error('operator.invite.redeem_failed', { clientId: v.clientId }, err);
    res.status(500).json({ error: 'server_error', message: 'Something went wrong. Try again.' });
  }
});

module.exports = router;
module.exports.computeBoot = computeBoot;
