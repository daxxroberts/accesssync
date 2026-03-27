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
const path = require('path');

const authRoutes     = require('./routes/auth');
const clientsRoutes  = require('./routes/clients');
const errorsRoutes   = require('./routes/errors');
const membersRoutes  = require('./routes/members');
const webhooksRoutes = require('./routes/webhooks');
const queueRoutes    = require('./routes/queue');
const { requireAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.ADMIN_PORT || process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());

// ── Public routes ──────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Health check (Railway requires a reachable HTTP endpoint) ──
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'admin-hub' }));

// ── Protected API routes ───────────────────────────────────────
app.use('/api/clients',    requireAuth, clientsRoutes);
app.use('/admin/errors',   requireAuth, errorsRoutes);
app.use('/admin/members',  requireAuth, membersRoutes);
app.use('/admin/webhooks', requireAuth, webhooksRoutes);
app.use('/admin/queue',    requireAuth, queueRoutes);

// ── Serve frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => {
  console.log(`[AccessSync Admin Hub] Running on port ${PORT}`);
  console.log(`[AccessSync Admin Hub] Environment: ${process.env.NODE_ENV}`);
});

// ── Graceful shutdown ──────────────────────────────────────────
function shutdown(signal) {
  console.log(`[AccessSync Admin Hub] ${signal} received — shutting down gracefully`);
  server.close(() => {
    console.log('[AccessSync Admin Hub] HTTP server closed');
    process.exit(0);
  });
  // Force exit if server hasn't closed within 10 seconds
  setTimeout(() => {
    console.error('[AccessSync Admin Hub] Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
