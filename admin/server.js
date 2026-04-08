/**
 * admin/server.js
 * AccessSync Admin Hub — Express Server
 *
 * Separate Railway service from Core Engine (crash-isolated).
 * Connects to the same PostgreSQL and Redis instances.
 * Auth-gated: JWT stored in httpOnly cookie.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const authRoutes     = require('./routes/auth');
const errorsRoutes   = require('./routes/errors');
const membersRoutes  = require('./routes/members');
const webhooksRoutes = require('./routes/webhooks');
const queueRoutes    = require('./routes/queue');
const clientsRoutes  = require('./routes/clients');
const operatorRoutes    = require('./routes/operator');
const multiMemberRoutes = require('./routes/multi-member');
const portalRoutes      = require('./routes/portal');
const { requireAuth, requireAuthPage, requireAuthPageOrOperator } = require('./middleware/auth');

const app  = express();
const PORT = process.env.ADMIN_PORT || process.env.PORT || 3001;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Security & logging middleware ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — pages use inline scripts/styles
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json());
app.use(cookieParser());

// ── Wix iframe — allow framing from manage.wix.com only ───────
// Helmet sets X-Frame-Options: sameorigin globally, which blocks the Wix
// Dashboard Page Extension iframe. Override for /operator-portal routes only.
function allowWixFrame(req, res, next) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://manage.wix.com");
  next();
}

// ── Public routes ──────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Protected API routes ───────────────────────────────────────
app.use('/admin/errors',   requireAuth, errorsRoutes);
app.use('/admin/members',  requireAuth, membersRoutes);
app.use('/admin/webhooks', requireAuth, webhooksRoutes);
app.use('/admin/queue',    requireAuth, queueRoutes);
app.use('/admin/clients',  requireAuth, clientsRoutes);

// ── Operator dashboard API (auth handled inside router — signup endpoints exempt) ──
app.use('/operator', operatorRoutes);

// ── Wix Dashboard Page Extension entry point (signed instance auth) ──
// allowWixFrame removes X-Frame-Options and sets frame-ancestors for manage.wix.com
app.use('/operator-portal', allowWixFrame, portalRoutes);

// ── Multi-member API (member-facing — no admin auth) ──
app.use('/', multiMemberRoutes);

// ── Health check (Railway requires a reachable HTTP endpoint) ──
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'admin-hub' }));

// ── Serve frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── Operator dashboard pages (auth-gated) ─────────────────────
// Operator pages — accessible by owner (adminToken) or Chad via Wix portal (operatorToken)
// allowWixFrame applied so these pages render correctly inside the Wix iframe
app.get('/dashboard',    allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/dashboard',   { activeTab: 'overview' }));
app.get('/members',      allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/members',      { activeTab: 'members' }));
app.get('/plan-mapping', allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/plan-mapping', { activeTab: 'plan-mapping' }));
app.get('/access',       allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/access',       { activeTab: 'access' }));
app.get('/locations',    allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/locations',    { activeTab: 'config' }));
// Admin panel — owner only (no iframe — no allowWixFrame)
app.get('/admin-panel',  requireAuthPage,            (req, res) => res.render('pages/admin-panel', { activeTab: 'admin' }));
// Onboarding — server-rendered so invite token is injected securely (never in URL)
app.get('/onboard', allowWixFrame, requireAuthPageOrOperator, (req, res) =>
  res.render('pages/onboard', {
    clientId:    req.admin?.clientId   || req.query.clientId || '',
    instanceId:  req.admin?.instanceId || '',
    inviteToken: process.env.OPERATOR_INVITE_TOKEN || '',
  }));
// Member-facing pages — no auth required
app.get('/sync-status',    (req, res) => res.render('pages/sync-status'));
app.get('/multi-member',   (req, res) => res.render('pages/multi-member'));

// ── Admin Hub ──────────────────────────────────────────────────
app.get('/',               (req, res) => res.redirect('/OwnerDashboard'));
app.get('/OwnerDashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*',               (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Admin Hub] Unhandled error:', err.stack || err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[AccessSync Admin Hub] Running on port ${PORT}`);
  console.log(`[AccessSync Admin Hub] Environment: ${process.env.NODE_ENV}`);
});

// ── Prevent silent crashes ─────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[Admin Hub] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Admin Hub] unhandledRejection:', reason);
});
