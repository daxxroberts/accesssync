/**
 * wix-adapter.js
 * Platform Adapter Layer (Layer 2)
 *
 * Responsibilities:
 * - Listen for incoming Wix Webhooks
 * - Verify Webhook HMAC signatures from Wix using Node crypto
 * - Acknowledge receipt (200 OK) immediately
 * - Normalize payload into a standard internal event format
 * - Pass validated event to Webhook Processor
 */

const crypto = require('crypto');
const webhookProcessor = require('../core/webhook-processor');

class WixAdapter {
  constructor() {
    this.webhookSecret = process.env.WIX_WEBHOOK_SECRET;
  }

  /**
   * Express/Fastify compatible HTTP handler 
   * @param {Object} req 
   * @param {Object} res 
   */
  async handleWebhook(req, res) {
    try {
      const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const signature = req.headers['x-wix-signature'];

      // 1. Verify Signature
      if (!this._verifySignature(rawBody, signature)) {
        console.warn('[Wix Adapter] Invalid Webhook signature rejected.');
        return res.status(401).send('Unauthorized');
      }

      // 2. Acknowledge Immediately
      res.status(200).send('OK');

      // 3. Normalize into standard format
      const eventId = req.headers['x-wix-event-id'] || 'fallback-id';
      const eventType = req.headers['x-wix-event-type'] || req.body?.eventType; // e.g. "plan.purchased"

      // OB-03-A [ASSUMPTION]: Header 'x-wix-site-id' — verify against Wix docs via PARSE before go-live.
      // If incorrect, tenant resolution silently fails for all multi-tenant events.
      const wixSiteId = req.headers['x-wix-site-id'] || req.body?.instanceId || null;

      const standardEvent = this._normalizePayload(eventType, wixSiteId, req.body);

      // 4. Pass to Webhook Processor (which handles deduplication & queuing)
      await webhookProcessor.processIncoming(eventId, standardEvent, rawBody);

    } catch (error) {
      console.error('[Wix Adapter] Webhook processing error:', error);
      // We already returned 200 OK ideally, but if it failed early:
      if (!res.headersSent) {
         res.status(500).send('Internal Server Error');
      }
    }
  }

  /**
   * Verifies the Wix HMAC-SHA256 signature
   * @param {string} rawBody 
   * @param {string} signature 
   */
  _verifySignature(rawBody, signature) {
    if (!this.webhookSecret || !signature) return false;
    
    try {
      const hmac = crypto.createHmac('sha256', this.webhookSecret);
      hmac.update(rawBody, 'utf8');
      const expectedSignature = hmac.digest('base64');
      
      // Use timingSafeEqual to prevent timing attacks
      const secureExpected = Buffer.from(expectedSignature);
      const secureActual = Buffer.from(signature);
      
      if (secureExpected.length !== secureActual.length) return false;
      return crypto.timingSafeEqual(secureExpected, secureActual);
    } catch(e) {
      console.error('[Wix Adapter] Signature verification failed exception:', e);
      return false;
    }
  }

  /**
   * Normalizes the Wix payload into the internal schema
   * @param {string} eventType
   * @param {string|null} wixSiteId
   * @param {Object} body
   */
  _normalizePayload(eventType, wixSiteId, body) {
    // Map Wix-specific payload fields to the AccessSync standard struct
    // Note: The specific paths (body.data.memberId) depend on the exact Wix event structure.
    // [ASSUMPTION: OB-03-A] Payload field paths require PARSE verification against Wix webhook docs.
    return {
      eventType: eventType,
      wixSiteId: wixSiteId,
      sourcePlatform: 'wix',                               // DR-021: all adapters set this
      platformMemberId: body?.data?.memberId || body?.memberId, // DR-021: was wixMemberId
      planId: body?.data?.planId || body?.planId,
      email: body?.data?.email || body?.email || null,
      name: body?.data?.name || body?.name || null,
      timestamp: new Date().toISOString(),
      rawPayload: body
    };
  }
}

module.exports = new WixAdapter();
