/**
 * admin/routes/auth.js
 * Admin Hub — Google Identity Services auth.
 *
 * POST /auth/google   { credential }  → verify Google ID token, gate on ADMIN_ALLOWED_EMAIL, set JWT cookie
 * POST /auth/logout                   → clear adminToken cookie
 * GET  /auth/check                    → 200 if session valid, 401 if not
 * GET  /auth/config                   → returns { clientId } for frontend GIS initialization (public)
 */

const router  = require('express').Router();
const { OAuth2Client } = require('google-auth-library');
const { signToken, requireAuth } = require('../middleware/auth');
const { log } = require('../../core/logger');

const client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);

// ── GET /auth/config ────────────────────────────────────────────
// Returns Google Client ID to the frontend so GIS can initialize.
// Client ID is not a secret — it is intentionally public.
router.get('/config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    log.error('auth.missing_google_client_id', {});
    return res.status(500).json({ error: 'Auth not configured' });
  }
  res.json({ clientId });
});

// ── POST /auth/google ───────────────────────────────────────────
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: 'Google credential required' });
    }

    const allowedEmail = process.env.ADMIN_ALLOWED_EMAIL;
    if (!allowedEmail) {
      log.error('auth.missing_allowed_email', {});
      return res.status(500).json({ error: 'Auth not configured' });
    }

    // Verify the Google ID token
    const ticket = await client.verifyIdToken({
      idToken:  credential,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    // Email gate — only the configured admin email is allowed
    if (payload.email !== allowedEmail) {
      log.warn('auth.login_rejected', { email: payload.email });
      return res.status(403).json({ error: 'Access denied' });
    }

    // Issue our own JWT as httpOnly cookie
    const token = signToken();
    res.cookie('adminToken', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000, // 24 hours
    });

    res.json({ ok: true, email: payload.email });

  } catch (err) {
    log.error('auth.google_verify_failed', {}, err);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
});

// ── GET /auth/google/callback ───────────────────────────────────
// Handles OAuth redirect flow (fallback when GIS button is blocked by origin).
router.get('/google/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) {
    log.error('auth.oauth_callback_error', { error });
    return res.redirect('/OwnerDashboard?auth_error=' + encodeURIComponent(error));
  }
  if (!code) {
    return res.redirect('/OwnerDashboard?auth_error=no_code');
  }
  try {
    const redirectUri = `https://${req.get('host')}/auth/google/callback`;
    const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    log.info('auth.oauth_callback_attempt', { email: payload.email });

    const allowedEmail = process.env.ADMIN_ALLOWED_EMAIL;
    if (payload.email !== allowedEmail) {
      log.warn('auth.oauth_callback_rejected', { email: payload.email });
      return res.redirect('/OwnerDashboard?auth_error=access_denied');
    }

    const token = signToken();
    res.cookie('adminToken', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   24 * 60 * 60 * 1000,
    });
    log.info('auth.oauth_callback_success', { email: payload.email });
    res.redirect('/OwnerDashboard');
  } catch (err) {
    log.error('auth.oauth_callback_verify_failed', {}, err);
    res.redirect('/OwnerDashboard?auth_error=' + encodeURIComponent(err.message));
  }
});

// ── POST /auth/pin ──────────────────────────────────────────────
router.post('/pin', (req, res) => {
  const { pin } = req.body;
  const ownerPin = process.env.OWNER_PIN;
  if (!ownerPin) {
    log.error('auth.missing_owner_pin', {});
    return res.status(500).json({ error: 'PIN auth not configured' });
  }
  if (!pin || pin !== ownerPin) {
    log.warn('auth.invalid_pin', {});
    return res.status(401).json({ error: 'Invalid PIN' });
  }
  const token = signToken();
  res.cookie('adminToken', token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   24 * 60 * 60 * 1000,
  });
  log.info('auth.pin_login_success', {});
  res.json({ ok: true });
});

// ── POST /auth/logout ───────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('adminToken');
  res.json({ ok: true });
});

// ── GET /auth/check ─────────────────────────────────────────────
// Frontend calls this on load to verify session is still valid.
router.get('/check', requireAuth, (req, res) => {
  res.json({ ok: true, role: req.admin.role });
});

module.exports = router;
