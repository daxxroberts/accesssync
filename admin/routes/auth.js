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

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── GET /auth/config ────────────────────────────────────────────
// Returns Google Client ID to the frontend so GIS can initialize.
// Client ID is not a secret — it is intentionally public.
router.get('/config', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    console.error('[Admin Auth] GOOGLE_CLIENT_ID env var not set.');
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
      console.error('[Admin Auth] ADMIN_ALLOWED_EMAIL env var not set.');
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
      console.warn(`[Admin Auth] Rejected login attempt from: ${payload.email}`);
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
    console.error('[Admin Auth] Google verification error:', err.message);
    res.status(401).json({ error: 'Invalid Google credential' });
  }
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
