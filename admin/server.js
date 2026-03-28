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
const errorsRoutes   = require('./routes/errors');
const membersRoutes  = require('./routes/members');
const webhooksRoutes = require('./routes/webhooks');
const queueRoutes    = require('./routes/queue');
const clientsRoutes  = require('./routes/clients');
const { requireAuth } = require('./middleware/auth');

const app  = express();
const PORT = process.env.ADMIN_PORT || process.env.PORT || 3001;

app.use(express.json());
app.use(cookieParser());

// ── Public routes ──────────────────────────────────────────────
app.use('/auth', authRoutes);

// ── Protected API routes ───────────────────────────────────────
app.use('/admin/errors',   requireAuth, errorsRoutes);
app.use('/admin/members',  requireAuth, membersRoutes);
app.use('/admin/webhooks', requireAuth, webhooksRoutes);
app.use('/admin/queue',    requireAuth, queueRoutes);
app.use('/admin/clients',  requireAuth, clientsRoutes);

// ── Health check (Railway requires a reachable HTTP endpoint) ──
app.get('/health', (req, res) => res.json({ status: 'ok', service: 'admin-hub' }));

// ── Serve frontend ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

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
