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
const logsRoutes        = require('./routes/logs');
const systemHealthRoutes = require('./routes/system-health');
const wixAdminsRoutes    = require('./routes/wix-admins');
const { requireAuth, requireAuthOrOperator, requireAuthPage, requireAuthPageOrOperator } = require('./middleware/auth');
const { traceContextMiddleware } = require('./middleware/trace-context');
const { log } = require('../core/logger');

const app  = express();
const PORT = process.env.ADMIN_PORT || process.env.PORT || 3001;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // Railway runs behind a reverse proxy — required for rate limiting + IP resolution

// ── Security & logging middleware ─────────────────────────────
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — pages use inline scripts/styles
// JSON request logger — consistent with core/logger.js structured output
// Replaces Apache 'combined' format so all stdout is parseable JSON in Railway
morgan.token('body-size', (req) => req.headers['content-length'] || '0');
app.use(morgan(function (tokens, req, res) {
  return JSON.stringify({
    ts:     new Date().toISOString(),
    level:  res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
    event:  'http.request',
    method: tokens.method(req, res),
    path:   tokens.url(req, res),
    status: parseInt(tokens.status(req, res), 10),
    ms:     parseFloat(tokens['response-time'](req, res)),
    ip:     tokens['remote-addr'](req, res),
  });
}));
app.use(express.json());
app.use(cookieParser());
// Trace context — mounts after cookieParser so auth cookies are parsed first.
// Auth middleware runs per-route (requireAuth / requireAuthPageOrOperator), so
// actor resolution here reflects whatever req.admin is already set by the
// per-route middleware. For routes that are pre-auth (login, /health), actor
// defaults to system:anonymous — correct behavior.
app.use(traceContextMiddleware);

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
// OB-195: Owner-only System Health surface. Aggregates infrastructure observability
// across all clients (reconcile freshness, webhook ingestion, error queue, diagnostic log)
// plus a global DB health probe. Gated by requireAuth — never exposed to operator sessions.
app.use('/admin/system-health', requireAuth, systemHealthRoutes);
// OB-195 Administrators follow-up: Wix admin presence tracking. Surfaces wix_admin_seen
// for /admin-panel Administrators section. Owner-only — never exposed to operator sessions.
app.use('/admin/wix-admins',    requireAuth, wixAdminsRoutes);
// Trace Timeline API — accepts admin (Daxx, cross-client) or operator (Chad,
// scoped to their own client by the route handler). Tenant scope is enforced
// inside admin/routes/logs.js via scopedClientId(req).
app.use('/admin/logs',     requireAuthOrOperator, logsRoutes);

// ── Operator dashboard API (auth handled inside router — signup endpoints exempt) ──
app.use('/operator', operatorRoutes);

// ── Wix Dashboard Page Extension entry point (signed instance auth) ──
// allowWixFrame removes X-Frame-Options and sets frame-ancestors for manage.wix.com
app.use('/operator-portal', allowWixFrame, portalRoutes);

// ── Multi-member API (member-facing — no admin auth) ──
app.use('/', multiMemberRoutes);

// ── Health check (Railway requires a reachable HTTP endpoint) ──
// Extended 2026-05-23 (OB-196) to surface reconcile cron freshness. Any external
// monitor (uptime ping, Daxx eyeball) gets the silent-cron alert immediately.
app.get('/health', async (req, res) => {
  const out = { status: 'ok', service: 'admin-hub' };
  try {
    const db = require('../db');
    const r = await db.query(
      `SELECT MAX(started_at) AS latest_reconcile_at FROM reconciliation_run`
    );
    const latest = r.rows[0]?.latest_reconcile_at || null;
    out.latest_reconcile_at = latest;
    if (latest) {
      const ageHours = Math.floor((Date.now() - new Date(latest).getTime()) / 3_600_000);
      out.reconcile_age_hours = ageHours;
      out.reconcile_health = ageHours < 24 ? 'green' : (ageHours < 72 ? 'amber' : 'red');
    } else {
      out.reconcile_health = 'red';
      out.reconcile_health_reason = 'no_reconciliation_run_rows';
    }
  } catch (err) {
    out.reconcile_health = 'unknown';
    out.reconcile_health_reason = 'db_unreachable';
  }
  res.json(out);
});

// ── Serve frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Operator dashboard pages (auth-gated) ─────────────────────
// Operator pages — accessible by owner (adminToken) or Chad via Wix portal (operatorToken)
// allowWixFrame applied so these pages render correctly inside the Wix iframe
function sessionMeta(req) {
  const role = req.admin?.role === 'operator' ? 'operator' : 'owner';
  const loginUrl = role === 'owner' ? '/OwnerDashboard' : null;
  return { sessionRole: role, loginUrl };
}

app.get('/dashboard',    allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/dashboard',   { activeTab: 'overview',     ...sessionMeta(req) }));
app.get('/members',      allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/members',      { activeTab: 'members',      clientId: req.admin?.clientId || '', ...sessionMeta(req) }));
app.get('/plan-mapping', allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/plan-mapping', { activeTab: 'plan-mapping', ...sessionMeta(req) }));
app.get('/access',       allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/access',       { activeTab: 'access',       ...sessionMeta(req) }));
app.get('/locations',    allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/locations',    { activeTab: 'config',       ...sessionMeta(req) }));
app.get('/errors',       allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/errors',       { activeTab: 'errors',       ...sessionMeta(req) }));
// Trace Timeline operator page — accepts owner OR operator. Tenant scope is
// enforced server-side inside admin/routes/logs.js via scopedClientId(req).
app.get('/logs',         allowWixFrame, requireAuthPageOrOperator, (req, res) => res.render('pages/logs',         { activeTab: 'logs',         clientId: req.admin?.clientId || '', ...sessionMeta(req) }));
// Admin panel — owner only (no iframe — no allowWixFrame)
app.get('/admin-panel',  requireAuthPage, (req, res) => res.render('pages/admin-panel',  { activeTab: 'admin', ...sessionMeta(req) }));
// Admin error queue — full cross-tenant view with raw payload, owner only
app.get('/admin-errors', requireAuthPage, (req, res) => res.render('pages/admin-errors', { activeTab: 'admin', ...sessionMeta(req) }));
// Onboarding — server-rendered so invite token is injected securely (never in URL)
app.get('/onboard', allowWixFrame, (req, res) =>
  res.render('pages/onboard', {
    clientId:    req.admin?.clientId   || req.query.clientId || '',
    instanceId:  req.admin?.instanceId && req.admin.instanceId !== 'undefined' ? req.admin.instanceId : '',
    inviteToken: process.env.OPERATOR_INVITE_TOKEN || '',
  }));
// Member-facing pages — no auth required
// allowMemberFrame: removes X-Frame-Options and opens frame-ancestors so member pages
// can be embedded in Wix member area pages (any origin — member-facing public pages)
function allowMemberFrame(req, res, next) {
  res.removeHeader('X-Frame-Options');
  res.removeHeader('Content-Security-Policy');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");
  next();
}
app.get('/sync-status', allowMemberFrame, (req, res) => res.render('pages/sync-status', {
  coreUrl: '' // polls /member/access-status on this same server (proxied below)
}));
app.get('/my-access', allowMemberFrame, (req, res) => res.render('pages/my-access'));

// Proxy /member/access-status to the core engine server-side — avoids CORS and JWT
// requirement from the browser. The admin server calls the core engine internally.
app.get('/member/access-status', async (req, res) => {
  const coreUrl = process.env.CORE_ENGINE_URL || 'https://accesssync-production.up.railway.app';
  const qs = new URLSearchParams(req.query).toString();
  try {
    const upstream = await fetch(`${coreUrl}/member/access-status?${qs}`, {
      headers: { 'x-internal-proxy': '1' }
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: 'upstream unavailable' }; }
    res.status(upstream.status).json(data);
  } catch (err) {
    log.warn('admin.member_status_proxy_failed', {}, err);
    res.status(502).json({ error: 'upstream unavailable' });
  }
});
app.get('/multi-member', allowMemberFrame, (req, res) => res.render('pages/multi-member'));
app.get('/member-hub',   allowMemberFrame, (req, res) => res.render('pages/member-hub'));

// ── Admin Hub ──────────────────────────────────────────────────
// Serve index.html at both / and /OwnerDashboard — no redirect.
// Google GIS requires the JS origin to match exactly; a redirect to /OwnerDashboard
// changes window.location.origin to include the path, breaking postMessage.
app.get('/',               allowWixFrame, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/OwnerDashboard', allowWixFrame, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*',               allowWixFrame, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, _next) => {
  log.error('admin.unhandled_error', { path: req.path }, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  log.info('admin.started', { port: PORT, env: process.env.NODE_ENV });
});

// ── In-process reconcile scheduler (OB-196 fallback for silent Railway cron) ──
// Added 2026-05-23. Audit found Railway cron had not fired runNightlySweep since
// 2026-05-19 (4 days of silence post-Supabase cutover). This in-process schedule
// ensures reconcile runs every 6h even if Railway cron is paused/misconfigured.
//
// Behavior:
//   - First run fires 5 minutes after Admin Hub boot (gives Railway deploy time to settle)
//   - Subsequent runs every 6 hours
//   - Each run is the same `runNightlySweep()` the Railway cron would have called
//   - Idempotent at the DB level (reconciliation_run row written per client per sweep)
//   - If Railway cron comes back online, set DISABLE_INPROCESS_RECONCILE=1 to silence this
//
// Gated by NODE_ENV !== 'test' so Jest suite doesn't accidentally fire reconcile.
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RECONCILE_INITIAL_DELAY_MS = 5 * 60 * 1000;  // 5 minutes
const SCHEDULER_ENABLED = process.env.NODE_ENV !== 'test'
  && process.env.DISABLE_INPROCESS_RECONCILE !== '1';

if (SCHEDULER_ENABLED) {
  const fireSweep = async () => {
    try {
      // OB-197 fix 2026-05-24: bumped info → warn so scheduler liveness is
      // observable in diagnostic_log (info currently suppressed pre-OB-176).
      log.warn('admin.scheduler.reconcile_start', { trigger: 'inprocess_scheduler' });
      const reconciliation = require('../core/reconciliation');
      await reconciliation.runNightlySweep();
      log.warn('admin.scheduler.reconcile_complete', { trigger: 'inprocess_scheduler' });
    } catch (err) {
      log.error('admin.scheduler.reconcile_failed', { trigger: 'inprocess_scheduler' }, err);
    }
  };
  setTimeout(() => {
    fireSweep();
    setInterval(fireSweep, RECONCILE_INTERVAL_MS);
  }, RECONCILE_INITIAL_DELAY_MS);
  // OB-197 fix 2026-05-24: bumped info → warn so we can verify scheduler armed.
  log.warn('admin.scheduler.armed', {
    initial_delay_minutes: RECONCILE_INITIAL_DELAY_MS / 60000,
    interval_hours: RECONCILE_INTERVAL_MS / 3_600_000,
  });
}

// ── Prevent silent crashes ─────────────────────────────────────
process.on('uncaughtException', (err) => {
  log.critical('admin.uncaught_exception', {}, err);
});
process.on('unhandledRejection', (reason) => {
  log.critical('admin.unhandled_rejection', { reason: String(reason) });
});
