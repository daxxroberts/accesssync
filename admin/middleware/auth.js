/**
 * admin/middleware/auth.js
 * JWT authentication middleware for Admin Hub.
 *
 * Auth flow: Google Identity Services → POST /auth/google → verifies credential
 * → checks email against ADMIN_ALLOWED_EMAIL → sets this JWT as httpOnly cookie.
 * Token stored in httpOnly cookie (adminToken), 24h expiry.
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'changeme-must-set-ADMIN_JWT_SECRET-in-env';

/**
 * Express middleware — validates adminToken cookie or Authorization header.
 * Accepts: httpOnly cookie (adminToken) or Bearer token in Authorization header.
 * Returns 401 if missing or invalid.
 */
function requireAuth(req, res, next) {
  // Prefer Authorization header (Bearer <token>), fall back to httpOnly cookie
  let token = req.cookies?.adminToken;
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  }

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

module.exports = { requireAuth, signToken };
