/**
 * server.js
 * AccessSync Main Entry Point
 * 
 * Responsibilities:
 * - Bootstraps the Express server
 * - Mounts the Wix Webhook route
 * - Mounts the Member Sync Frontend endpoint
 * - Starts the BullMQ background workers
 */

require('dotenv').config();
const express = require('express');

// Import Modules
const wixAdapter = require('./adapters/wix-adapter');
const memberSyncApi = require('./core/member-sync-api');
const db = require('./db');
const { startWorker } = require('./core/queue-worker');

const app = express();
const PORT = process.env.PORT || 3000;

// Startup env check — remove after confirming Railway vars are wired
console.log('[AccessSync] ENV CHECK — REDIS_URL:', process.env.REDIS_URL ? `SET (${process.env.REDIS_URL.substring(0, 20)}...)` : 'NOT SET');
console.log('[AccessSync] ENV CHECK — DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');

// Middleware (Wix adapter needs raw body to verify HMAC signature exactly)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString(); // Save raw buffer string for HMAC crypto
  }
}));

// --- Routes ---

// Health Check for Railway
// Checks DB connectivity — Railway stops routing traffic on non-200
app.get('/health', async (req, res) => {
  const dbOk = await db.healthCheck();
  if (!dbOk) {
    return res.status(503).json({ status: 'error', db: 'unreachable' });
  }
  res.status(200).json({ status: 'ok', db: 'connected' });
});

// Platform Adapter: Wix Webhook Entry (Layer 2)
app.post('/webhooks/wix', async (req, res) => {
    // If we couldn't parse rawBody via middleware, fallback safely
    if (!req.rawBody && req.body) {
        req.rawBody = JSON.stringify(req.body);
    }
    await wixAdapter.handleWebhook(req, res);
});

// AccessSync UI Endpoint: Frontend Polling (Phase 5)
app.get('/member/access-status', async (req, res) => {
    await memberSyncApi.getAccessStatus(req, res);
});

// --- Boot Server ---
const serverInstance = app.listen(PORT, () => {
    console.log(`[AccessSync Core Engine] Server listening on port ${PORT}`);
    console.log(`[AccessSync Core Engine] Environment: ${process.env.NODE_ENV}`);

    // Start BullMQ worker (DR-012)
    // Worker connects to Redis and begins consuming from 'accesssync-events' queue
    startWorker();
});

// --- Graceful Shutdown (OI-09) ---
process.on('SIGTERM', () => {
    console.log('[AccessSync] SIGTERM received — graceful shutdown starting.');
    serverInstance.close(async () => {
        console.log('[AccessSync] HTTP server closed.');
        try {
            const { pool } = require('./db');
            await pool.end();
            console.log('[AccessSync] DB pool closed.');
        } catch (e) {
            console.error('[AccessSync] DB pool close error:', e.message);
        }
        process.exit(0);
    });
    // Force exit after 15s if graceful shutdown stalls
    setTimeout(() => {
        console.error('[AccessSync] Graceful shutdown timeout. Force exiting.');
        process.exit(1);
    }, 15000).unref();
});
