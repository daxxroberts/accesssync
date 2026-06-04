/**
 * core/wix-app-market.js
 *
 * Wix App Market operator-billing webhook handler -- STUB.
 *
 * Scope (this file, today):
 *   - Receive POST /webhooks/wix-app-market with a raw body
 *   - Log the receipt to webhook_log (event_type='wix-app-market-stub')
 *   - Respond 503 with a "not implemented" error code
 *   - Never throw -- defensive against malformed payloads / DB errors
 *
 * Scope (OB-66 build proper, separate session -- NOT this file):
 *   - JWT verification against WIX_APP_PUBLIC_KEY (F-17)
 *   - Branch by event type:
 *       App Instance Installed         -> INSERT billing_subscriptions row
 *                                         with wix_app_instance_id (F-16)
 *       Paid Plan Purchased            -> UPDATE tier (via OB-72 mapping of
 *                                         vendorProductId), set status='active',
 *                                         persist vendor_product_id (F-16)
 *       Paid Plan Changed              -> UPDATE tier per OB-72 mapping
 *       Paid Plan Auto-Renewal Cancel  -> UPDATE status (distinguish
 *                                         operator-cancel vs FAILED_PAYMENT
 *                                         via cancelReason)
 *       App Instance Removed           -> UPDATE status='uninstalled'
 *   - Trial->paid detection lives in F-18 (poll job), NOT here -- Wix fires
 *     no webhook for that transition
 *
 * Why a stub now:
 *   The route + table + env-var-doc need to be in place so that when OB-66
 *   ships, the developer can focus on JWT verification + handler branching
 *   rather than plumbing. Returning 503 (rather than 404) signals to Wix's
 *   webhook retry logic that the endpoint is known but temporarily
 *   unavailable -- they will redeliver, which is the desired behavior
 *   once OB-66 is live.
 *
 * Auth note:
 *   This endpoint uses a DIFFERENT auth path from /webhooks/wix:
 *     - /webhooks/wix             member-level Pricing Plans, HMAC (WIX_WEBHOOK_SECRET)
 *     - /webhooks/wix-app-market  operator-level App Market, JWT (WIX_APP_PUBLIC_KEY)
 *   Do NOT conflate the two. Do NOT route App Market traffic through
 *   adapters/wix/wix-connector.js -- that's the member-level pipeline.
 *
 * HOG note:
 *   HOG is a Velo direct install (DR-016). Wix App Market will NEVER fire a
 *   webhook to this endpoint for HOG. HOG's billing_subscriptions row is a
 *   manual placeholder.
 *
 * See also:
 *   - memory: reference_wix_app_market_billing.md (PARSE 2026-05-12)
 *   - OB-66 (build this handler proper)
 *   - OB-72 (vendorProductId -> tier mapping design)
 *   - F-16  (billing_subscriptions.vendor_product_id + wix_app_instance_id)
 *   - F-17  (WIX_APP_PUBLIC_KEY env var)
 *   - F-18  (poll job for trial->paid)
 */

'use strict';

const db    = require('../db');
const { log } = require('./logger');

/**
 * Express handler for POST /webhooks/wix-app-market.
 *
 * Contract:
 *   - req.body is a Buffer (raw body, mounted with express.raw)
 *   - Response is always 503 with { error, message } -- never throws
 *   - Always attempts to write a webhook_log row (fire-and-forget; failures
 *     are caught and logged, never bubbled to the client)
 */
async function handleAppMarketWebhook(req, res) {
  // Extract raw body as string. Wix sends application/jwt; the body is the
  // signed token. Defensive: also handle the case where some intermediate
  // middleware already parsed the body.
  let rawBody = '';
  try {
    if (Buffer.isBuffer(req.body)) {
      rawBody = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBody = req.body;
    } else if (req.body && typeof req.body === 'object') {
      // Some webhooks may arrive JSON-parsed if Content-Type was application/json
      rawBody = JSON.stringify(req.body);
    }
  } catch (_) {
    rawBody = '';
  }

  // Fire-and-forget webhook_log write. We log the raw payload so a future
  // operator (or the OB-66 build session) can replay live captures.
  //
  // The raw_payload column is JSONB -- wrap the raw JWT string in a small
  // envelope so it round-trips cleanly through JSON.stringify.
  const logRow = {
    received_at:    new Date().toISOString(),
    content_type:   req.headers['content-type'] || null,
    body_length:    rawBody.length,
    body_raw:       rawBody,
  };

  db.query(
    `INSERT INTO webhook_log
       (event_id, client_id, hmac_status, dedup_status, event_type, raw_payload, normalized_payload, error_detail, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      null,                                      // event_id      -- unknown until JWT verified (OB-66)
      null,                                      // client_id     -- unknown until instanceId mapped (OB-66)
      'accepted',                                // hmac_status   -- "accepted" by convention for stub; real auth is JWT not HMAC
      null,                                      // dedup_status
      'wix-app-market-stub',                     // event_type
      JSON.stringify(logRow),                    // raw_payload
      null,                                      // normalized_payload -- nothing parsed
      'OB-66 stub -- handler not implemented',   // error_detail
      null,                                      // trace_id
    ]
  ).catch((dbErr) => {
    // Never throw from the handler. If we can't log, we can't log.
    try {
      log.error('wix_app_market.stub.webhook_log_write_failed', {
        contentType: req.headers['content-type'] || null,
        bodyLength:  rawBody.length,
      }, dbErr);
    } catch (_) {
      // Logger itself failed -- swallow to honor the "never throw" contract.
    }
  });

  // Informational breadcrumb so operators see traffic arrive even in stub mode.
  try {
    log.info('wix_app_market.stub.received', {
      contentType: req.headers['content-type'] || null,
      bodyLength:  rawBody.length,
    });
  } catch (_) {
    // ignore
  }

  return res.status(503).json({
    error:   'wix_app_market_handler_not_implemented',
    message: 'Stub -- OB-66 + OB-72 + F-17 must ship before this endpoint is wired.',
  });
}

module.exports = {
  handleAppMarketWebhook,
};
