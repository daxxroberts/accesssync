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
app.get('/health', (req, res) => res.status(200).send('OK'));

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
app.listen(PORT, () => {
    console.log(`[AccessSync Core Engine] Server listening on port ${PORT}`);
    console.log(`[AccessSync Core Engine] Environment: ${process.env.NODE_ENV}`);
});
