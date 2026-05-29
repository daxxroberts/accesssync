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
const setupTelemetry = require('../../core/setup-telemetry'); // OB-237 Phase C
const { decryptApiKey } = require('../../core/crypto-utils'); // OB-238
const db = require('../../db'); // OB-238
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
    // Hoist traceId so the catch block can include it in the error log.
    const traceId = crypto.randomUUID();
    try {
      // Use raw body captured by server.js middleware for HMAC verification (P1 fix).
      // Re-serializing req.body risks field ordering differences that break signature checks.
      const rawBody = req.rawBody || (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
      const signature = req.headers['x-wix-signature'];
      const verifyClientIdHint = req.headers['x-accesssync-client-id'] || null;

      // Generate traceId at ingress — threaded through all downstream log events and DB writes.
      // traceId is hoisted above the try block so the catch block can log it on any failure.

      // 1. Verify Signature (DR-009 + OB-238 per-client)
      if (!(await this._verifySignature(rawBody, signature, verifyClientIdHint))) {
        const clientHint = verifyClientIdHint || 'unknown';
        const rejectedEventId = req.headers['x-wix-event-id'] || null;
        log.warn('wix.hmac.rejected', { traceId, clientId: null, eventId: rejectedEventId, stage: 'ingress', result: 'failed', clientHint });
        hmacMonitor.recordFailure(clientHint).catch(() => {}); // Sprint 5.1 — non-blocking
        await webhookProcessor.logWebhookAttempt({
          eventId:   rejectedEventId,
          hmacStatus: 'rejected',
          rawPayload: req.body || null,
          errorDetail: 'HMAC signature mismatch',
          traceId,
        }).catch((dbErr) => {
          log.error('wix.webhook_log_write_failed', { traceId }, dbErr);
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

      // OB-161: wixSiteId extraction — header is primary source.
      // Wix orderUpdated / orderStarted payloads omit instanceId from the body entirely.
      // x-wix-site-id header is present on all Wix REST webhook calls regardless of event type.
      // Body paths are retained as fallback for Velo events.js and non-standard variants.
      const wixSiteId =
        req.headers['x-wix-site-id']          ||  // HTTP header — primary (OB-161)
        req.body?.data?.metadata?.instanceId  ||  // REST webhook body fallback
        req.body?.instanceId                  ||  // Velo events.js top-level
        req.body?.metadata?.instanceId        ||  // top-level metadata variant
        null;

      const wixSiteIdSource =
        req.headers['x-wix-site-id']          ? 'header' :
        (req.body?.data?.metadata?.instanceId ||
         req.body?.instanceId                 ||
         req.body?.metadata?.instanceId)      ? 'body'   : null;

      if (!wixSiteId) {
        // Velo events.js posts legitimately lack x-wix-site-id and are tenant-routed
        // via the x-accesssync-client-id header instead. That's the expected HOG flow,
        // so don't pollute diagnostic_log when we know we can recover. Only warn when
        // we have neither a site_id nor a clientIdHint — that case is unrecoverable
        // and worth surfacing.
        const recoverableHint = req.headers['x-accesssync-client-id'] || null;
        if (!recoverableHint) {
          log.warn('wix.site_id.unresolved', {
            traceId,
            clientIdHint: null,
            wixHeaders: Object.keys(req.headers).filter(k => k.startsWith('x-wix')),
          });
        }
      }

      // Self-registration: if events.js includes X-AccessSync-Client-Id, wire source_site_id on
      // first arrival so future lookups resolve by source_site_id without DEFAULT_TENANT_ID.
      // Velo payloads do not carry instanceId — platformClientIdHint is the primary tenant-routing
      // path for Velo. Header is HMAC-verified (signature covers headers indirectly via secret).
      const clientIdHint = req.headers['x-accesssync-client-id'] || null;
      if (clientIdHint && wixSiteId) {
        tenantResolver.registerSiteId(clientIdHint, wixSiteId).catch(() => {});
      }

      // OB-237 Phase C — snippet version telemetry. The events.js Velo template
      // embeds its version in x-accesssync-snippet-version. Capture it so the
      // Setup Hub knows what's actually installed on the Wix side.
      const snippetVersion = req.headers['x-accesssync-snippet-version'] || null;
      if (clientIdHint && snippetVersion) {
        setupTelemetry.recordSnippetTelemetry(clientIdHint, 'velo_events_backend', snippetVersion)
          .catch(() => {});
      }

      const standardEvent = wixAdapter.parseEvent(eventType, wixSiteId, req.body);
      standardEvent.platformClientIdHint = clientIdHint;
      standardEvent.traceId  = traceId;
      standardEvent.eventId  = eventId;

      // Diagnostic context — used by webhook-processor when tenant resolution fails so
      // operators can self-diagnose "your events.js is outdated" vs. other failure modes.
      const tenantDiagnostic = {
        hasClientIdHeader: !!clientIdHint,
        hasInstanceId:     !!wixSiteId,
        wixSiteIdSource,
        payloadTopKeys:    req.body ? Object.keys(req.body) : [],
        dataKeys:          req.body?.data ? Object.keys(req.body.data) : [],
        metadataKeys:      req.body?.data?.metadata ? Object.keys(req.body.data.metadata) : [],
        headerKeys:        Object.keys(req.headers || {}).filter(k => k.startsWith('x-')),
      };

      // 4. Pass to Webhook Processor (deduplication + queuing)
      await webhookProcessor.processIncoming(eventId, standardEvent, rawBody, tenantDiagnostic);

    } catch (error) {
      log.error('wix.webhook.processing_error', { traceId: traceId || null, stage: 'ingress', result: 'failed' }, error);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  }

  /**
   * Verifies the Wix HMAC-SHA256 signature.
   *
   * OB-238: tries per-client secret first (clients.wix_webhook_secret), falls
   * back to platform-wide env var for legacy clients without per-client secret.
   * One operator's leaked secret no longer forges webhooks for other operators.
   *
   * @param {string} rawBody
   * @param {string} signature
   * @param {string|null} clientIdHint  from x-accesssync-client-id header
   * @returns {Promise<boolean>}
   */
  async _verifySignature(rawBody, signature, clientIdHint) {
    if (!signature) return false;

    // Try per-client secret first if hint present
    if (clientIdHint) {
      const perClientSecret = await this._resolvePerClientSecret(clientIdHint);
      if (perClientSecret) {
        return this._checkHmac(rawBody, signature, perClientSecret);
      }
    }

    // Fall back to platform-wide env var (legacy clients during transition)
    if (this.webhookSecret) {
      return this._checkHmac(rawBody, signature, this.webhookSecret);
    }

    return false;
  }

  /**
   * Look up + decrypt clients.wix_webhook_secret.
   * Returns null if no row, no secret, or decryption fails.
   * Never throws — observability doctrine, DR-037.
   */
  async _resolvePerClientSecret(clientId) {
    try {
      const result = await db.query(
        'SELECT wix_webhook_secret FROM clients WHERE id = $1 LIMIT 1',
        [clientId]
      );
      if (!result.rows.length || !result.rows[0].wix_webhook_secret) return null;
      return decryptApiKey(result.rows[0].wix_webhook_secret);
    } catch (e) {
      log.error('wix.hmac.per_client_secret_lookup_failed', { clientId }, e);
      return null;
    }
  }

  /**
   * Timing-safe HMAC-SHA256 comparison.
   */
  _checkHmac(rawBody, signature, secret) {
    try {
      const hmac = crypto.createHmac('sha256', secret);
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
