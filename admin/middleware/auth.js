/**
 * admin/middleware/auth.js
 * JWT authentication middleware for Admin Hub.
 *
 * Auth flow: Google Identity Services → POST /auth/google → verifies credential
 * → checks email against ADMIN_ALLOWED_EMAIL → sets this JWT as httpOnly cookie.
 * Token stored in httpOnly cookie (adminToken), 24h expiry.
 */

const jwt = require('jsonwebtoken');

if (!process.env.ADMIN_JWT_SECRET) {
  throw new Error('[auth] ADMIN_JWT_SECRET env var is required — refusing to start with default secret');
}
const JWT_SECRET = process.env.ADMIN_JWT_SECRET;

/**
 * Express middleware — validates adminToken cookie.
 * Returns 401 if missing or invalid.
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.adminToken;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Signs a new 24-hour admin JWT.
 */
function signToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

/**
 * Express middleware for page routes — redirects to login on auth failure.
 * Use on GET routes that render HTML pages (not API endpoints).
 */
function requireAuthPage(req, res, next) {
  const token = req.cookies?.adminToken;
  if (!token) {
    return res.redirect('/OwnerDashboard');
  }
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.redirect('/OwnerDashboard');
  }
}

module.exports = { requireAuth, requireAuthPage, signToken };
