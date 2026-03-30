/**
 * wix-connector.js
 * Wix Connector (Layer 1)
 *
 * Responsibilities:
 * - HTTP handler for incoming Wix webhooks
 * - HMAC-SHA256 signature verification (DR-009)
 * - Immediate 200 OK acknowledgement
 * - Calls wix-adapter.parseEvent() (Layer 2) for payload normalization
 * - Passes standard event to webhook-processor for deduplication and queuing
 *
 * No payload parsing here. No business logic here.
 * This layer owns only: HTTP in + HMAC check + handoff to Layer 2.
 */

const crypto = require('crypto');
const wixAdapter = require('./wix-adapter');
const webhookProcessor = require('../../core/webhook-processor');

class WixConnector {
  constructor() {
    this.webhookSecret = process.env.WIX_WEBHOOK_SECRET;
  }

  /**
   * Express-compatible HTTP handler.
   * Registered in server.js at POST /webhooks/wix.
   *
   * @param {Object} req
   * @param {Object} res
   */
  async handleWebhook(req, res) {
    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const signature = req.headers['x-wix-signature'];

      // 1. Verify Signature (DR-009)
      if (!this._verifySignature(rawBody, signature)) {
        console.warn('[Wix Connector] Invalid webhook signature rejected.');
        await webhookProcessor.logWebhookAttempt({
          eventId: req.headers['x-wix-event-id'] || null,
          hmacStatus: 'rejected',
          rawPayload: req.body || null,
          errorDetail: 'HMAC signature mismatch'
        }).catch(() => {}); // best-effort — never block on logging
        return res.status(401).send('Unauthorized');
      }

      // 2. Acknowledge Immediately — Wix requires fast 200 ACK
      res.status(200).send('OK');

      // 3. Parse event (Layer 2)
      const eventId = req.headers['x-wix-event-id'] || 'fallback-id';
      const eventType = req.headers['x-wix-event-type'] || req.body?.eventType;

      // OB-03-A RESOLVED (PARSE VERIFIED 2026-03-28): No 'x-wix-site-id' header exists.
      // instanceId is the site identifier — present in the Wix webhook body.
      // Full JWT decode (OB-08) will confirm exact path; req.body?.instanceId is correct for now.
      const wixSiteId = req.body?.instanceId || null;

      const standardEvent = wixAdapter.parseEvent(eventType, wixSiteId, req.body);

      // 4. Pass to Webhook Processor (deduplication + queuing)
      await webhookProcessor.processIncoming(eventId, standardEvent, rawBody);

    } catch (error) {
      console.error('[Wix Connector] Webhook processing error:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  }

  /**
   * Verifies the Wix HMAC-SHA256 signature.
   *
   * @param {string} rawBody
   * @param {string} signature
   * @returns {boolean}
   */
  _verifySignature(rawBody, signature) {
    if (!this.webhookSecret || !signature) return false;

    try {
      const hmac = crypto.createHmac('sha256', this.webhookSecret);
      hmac.update(rawBody, 'utf8');
      const expectedSignature = hmac.digest('base64');

      const secureExpected = Buffer.from(expectedSignature);
      const secureActual = Buffer.from(signature);

      if (secureExpected.length !== secureActual.length) return false;
      return crypto.timingSafeEqual(secureExpected, secureActual);
    } catch (e) {
      console.error('[Wix Connector] Signature verification failed:', e);
      return false;
    }
  }
}

module.exports = new WixConnector();
