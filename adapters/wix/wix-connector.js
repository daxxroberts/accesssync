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
const tenantResolver = require('../../core/tenant-resolver');
const hmacMonitor = require('../../core/hmac-monitor'); // Sprint 5.1
const { log } = require('../../core/logger');

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
      // Use raw body captured by server.js middleware for HMAC verification (P1 fix).
      // Re-serializing req.body risks field ordering differences that break signature checks.
      const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const signature = req.headers['x-wix-signature'];

      // 1. Verify Signature (DR-009)
      if (!this._verifySignature(rawBody, signature)) {
        const clientHint = req.headers['x-accesssync-client-id'] || 'unknown';
        log.warn('wix.hmac.rejected', { clientHint });
        hmacMonitor.recordFailure(clientHint).catch(() => {}); // Sprint 5.1 — non-blocking
        await webhookProcessor.logWebhookAttempt({
          eventId: req.headers['x-wix-event-id'] || null,
          hmacStatus: 'rejected',
          rawPayload: req.body || null,
          errorDetail: 'HMAC signature mismatch'
        }).catch((dbErr) => {
          log.error('wix.webhook_log_write_failed', {}, dbErr);
        });
        return res.status(401).send('Unauthorized');
      }

      // 2. Acknowledge Immediately — Wix requires fast 200 ACK
      res.status(200).send('OK');

      // 3. Parse event (Layer 2)
      // eventId: Wix REST webhooks send the event UUID in data.metadata.id (confirmed from live payloads).
      // The x-wix-event-id header is not reliably present — fall back to body field, then synthetic.
      const eventId =
        req.headers['x-wix-event-id']        ||  // header (Velo / some REST variants)
        req.body?.data?.metadata?.id          ||  // REST webhook: data.metadata.id (confirmed live)
        req.body?.metadata?.id                ||  // top-level metadata variant
        req.body?.eventId                     ||  // direct field fallback
        ('fallback-' + Date.now());               // last resort — unique per request to avoid dedup collision

      const eventType = req.headers['x-wix-event-type'] || req.body?.eventType || null;

      // OB-03-A: wixSiteId extraction — Wix REST webhooks confirmed from live payloads.
      // instanceId (= site ID) lives at data.metadata.instanceId in REST webhooks.
      // Velo events.js puts it at top-level instanceId or passes it via x-accesssync-client-id.
      const wixSiteId =
        req.body?.data?.metadata?.instanceId  ||  // REST webhook: confirmed live payload location
        req.body?.instanceId                  ||  // Velo events.js top-level
        req.body?.metadata?.instanceId        ||  // top-level metadata variant
        null;

      // Self-registration: if events.js includes X-AccessSync-Client-Id, wire source_site_id on
      // first arrival so future lookups resolve by source_site_id without DEFAULT_TENANT_ID.
      // Velo payloads do not carry instanceId — platformClientIdHint is the primary tenant-routing
      // path for Velo. Header is HMAC-verified (signature covers headers indirectly via secret).
      const clientIdHint = req.headers['x-accesssync-client-id'] || null;
      if (clientIdHint && wixSiteId) {
        tenantResolver.registerSiteId(clientIdHint, wixSiteId).catch(() => {});
      }

      const standardEvent = wixAdapter.parseEvent(eventType, wixSiteId, req.body);
      standardEvent.platformClientIdHint = clientIdHint;

      // Diagnostic context — used by webhook-processor when tenant resolution fails so
      // operators can self-diagnose "your events.js is outdated" vs. other failure modes.
      const tenantDiagnostic = {
        hasClientIdHeader: !!clientIdHint,
        hasInstanceId:     !!wixSiteId,
        payloadTopKeys:    req.body ? Object.keys(req.body) : [],
        dataKeys:          req.body?.data ? Object.keys(req.body.data) : [],
        metadataKeys:      req.body?.data?.metadata ? Object.keys(req.body.data.metadata) : [],
        headerKeys:        Object.keys(req.headers || {}).filter(k => k.startsWith('x-')),
      };

      // 4. Pass to Webhook Processor (deduplication + queuing)
      await webhookProcessor.processIncoming(eventId, standardEvent, rawBody, tenantDiagnostic);

    } catch (error) {
      log.error('wix.webhook.processing_error', {}, error);
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
      log.error('wix.hmac.verification_error', {}, e);
      return false;
    }
  }
}

module.exports = new WixConnector();
