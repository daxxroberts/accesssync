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
const wixConnector = require('./adapters/wix/wix-connector');
const memberSyncApi = require('./core/member-sync-api');
const db = require('./db');
const { startWorker } = require('./core/queue-worker');
const { log } = require('./core/logger');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Wix Connector: Webhook Entry (Layer 1)
app.post('/webhooks/wix', async (req, res) => {
    // If we couldn't parse rawBody via middleware, fallback safely
    if (!req.rawBody && req.body) {
        req.rawBody = JSON.stringify(req.body);
    }
    await wixConnector.handleWebhook(req, res);
});

// AccessSync UI Endpoint: Frontend Polling (Phase 5)
app.get('/member/access-status', async (req, res) => {
    await memberSyncApi.getAccessStatus(req, res);
});

// --- Boot Server ---
const serverInstance = app.listen(PORT, () => {
    log.info('server.started', { port: PORT, env: process.env.NODE_ENV });
    startWorker();
});

// --- Graceful Shutdown (OI-09) ---
process.on('SIGTERM', () => {
    log.info('server.shutdown.start', {});
    serverInstance.close(async () => {
        log.info('server.shutdown.http_closed', {});
        try {
            const { pool } = require('./db');
            await pool.end();
            log.info('server.shutdown.db_closed', {});
        } catch (e) {
            log.error('server.shutdown.db_close_failed', {}, e);
        }
        process.exit(0);
    });
    setTimeout(() => {
        log.critical('server.shutdown.timeout', {});
        process.exit(1);
    }, 15000).unref();
});
