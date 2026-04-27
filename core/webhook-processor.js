/**
 * @file webhook-processor.js
 * @layer core/layer4
 * @role deduplication, enqueue
 * @reads processed_event_ids, clients
 * @writes processed_event_ids, clients.last_webhook_at, BullMQ, diagnostic_log (via logger)
 * @exports eventQueue
 * @dr DR-010, DR-012
 *
 * webhook-processor.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Receives validated webhook events from Wix Adapter
 * - Verifies payload structure (required fields)
 * - Deduplicates via processed_event_ids table
 * - Enqueues valid new events to BullMQ for async processing (DR-012)
 */

const { Queue } = require('bullmq');
const db = require('../db');
const tenantResolver = require('./tenant-resolver');
const { getRedisConnection } = require('./redis-utils');
const { log } = require('./logger');

const connection = getRedisConnection();

const eventQueue = new Queue('accesssync-events', {
  connection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});

class WebhookProcessor {

  async processIncoming(eventId, standardEvent, rawPayload, tenantDiagnostic = null) {
    const traceId        = standardEvent.traceId  || null;
    const platformMemberId = standardEvent.platformMemberId || null;
    const planId         = standardEvent.planId   || null;
    log.info('webhook.received', {
      traceId, eventId, eventType: standardEvent.eventType,
      sourcePlatform: 'wix', platformMemberId, planId,
      stage: 'ingress', result: 'start',
    });

    // 1. Validate Structure
    if (!this._validateStructure(standardEvent)) {
      log.warn('webhook.invalid_structure', { traceId, eventId, eventType: standardEvent.eventType, stage: 'ingress', result: 'failed' });
      await this._logToAlertLog(eventId, standardEvent, 'Missing required fields: platformMemberId or eventType');
      return;
    }

    // 2. Deduplication check (Idempotency — DR-010)
    const isDuplicate = await this._checkIfDuplicate(eventId);
    if (isDuplicate) {
      log.info('webhook.duplicate', { traceId, eventId, eventType: standardEvent.eventType, stage: 'ingress', result: 'skipped' });
      return;
    }

    // 3. Register Event (mark processed before enqueuing — prevents re-entry on crash)
    await this._markEventProcessed(eventId, standardEvent);

    // 4. Resolve tenant. Two paths:
    //   REST webhook: wixSiteId (instanceId) → clients.source_site_id lookup.
    //   Velo forwarder: payload has no instanceId. events.js sends CLIENT_ID via
    //     X-AccessSync-Client-Id header (HMAC-verified end-to-end) → use it directly.
    let tenantId = null;
    if (standardEvent.wixSiteId) {
      tenantId = await tenantResolver.resolve(standardEvent.wixSiteId);
    }
    if (!tenantId && standardEvent.platformClientIdHint) {
      tenantId = await tenantResolver.resolveByClientId(standardEvent.platformClientIdHint);
    }

    // 4b. Log to webhook_log for Admin Hub Webhook Inspector (after tenant known)
    await this.logWebhookAttempt({
      eventId,
      clientId: tenantId,
      hmacStatus: 'accepted',
      dedupStatus: isDuplicate ? 'duplicate' : 'new',
      eventType: standardEvent.eventType,
      rawPayload: rawPayload ? (() => { try { return JSON.parse(rawPayload); } catch { return null; } })() : null,
      normalizedPayload: standardEvent,
      traceId,
    }).catch((dbErr) => {
      log.error('webhook.log_write_failed', { traceId, eventId, clientId: tenantId, eventType: standardEvent.eventType, stage: 'ingress', result: 'failed' }, dbErr);
    });

    if (!tenantId) {
      // OB-88: classify the failure so operators can self-diagnose.
      // (a) HMAC passed + both tenant identifiers missing → events.js is outdated on the Wix side
      //     (the current template sends x-accesssync-client-id; older forks did not).
      // (b) wixSiteId present but unknown → client row missing or source_site_id drifted.
      // (c) clientIdHint present but unknown → client row deleted or hint malformed.
      const hmacOk = true; // _verifySignature already passed upstream in wix-connector
      const classification =
        hmacOk && !standardEvent.wixSiteId && !standardEvent.platformClientIdHint
          ? 'events_js_outdated'
          : standardEvent.wixSiteId
            ? 'unknown_site_id'
            : 'unknown_client_id';

      const err = new Error(`Tenant not resolved — classification=${classification}`);
      err.code = 'TENANT_NOT_RESOLVED';

      log.error('webhook.tenant_not_resolved', {
        traceId, eventId,
        classification,
        eventType: standardEvent.eventType,
        sourcePlatform: 'wix',
        platformMemberId,
        wixSiteId: standardEvent.wixSiteId,
        clientIdHint: standardEvent.platformClientIdHint,
        diagnostic: tenantDiagnostic,
        stage: 'resolve', result: 'failed',
      }, err);

      await this._logToAlertLog(eventId, standardEvent, classification);
      return;
    }

    // 4c. Stamp clients.last_webhook_at — drives the dashboard's "Webhooks active" pill.
    // Fault-tolerant: a failed timestamp update must never block enqueue.
    db.query(`UPDATE clients SET last_webhook_at = NOW() WHERE id = $1`, [tenantId])
      .catch((err) => log.warn('webhook.last_webhook_at_update_failed', { clientId: tenantId, eventId }, err));

    // 5. Classify and enqueue (DR-012)
    if (['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(standardEvent.eventType)) {
      await eventQueue.add('grant', { tenantId, standardEvent }, { jobId: `grant-${eventId}` });
      log.info('webhook.enqueued', {
        traceId, eventId, eventType: standardEvent.eventType,
        clientId: tenantId, platformMemberId, planId,
        jobId: `grant-${eventId}`, jobType: 'grant',
        stage: 'queue', result: 'success',
      });

    } else if (['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'].includes(standardEvent.eventType)) {
      await eventQueue.add('revoke', { tenantId, standardEvent }, { jobId: `revoke-${eventId}` });
      log.info('webhook.enqueued', {
        traceId, eventId, eventType: standardEvent.eventType,
        clientId: tenantId, platformMemberId, planId,
        jobId: `revoke-${eventId}`, jobType: 'revoke',
        stage: 'queue', result: 'success',
      });

    } else {
      log.info('webhook.unrecognised_type', { traceId, eventId, eventType: standardEvent.eventType, stage: 'ingress', result: 'skipped' });
    }
  }

  _validateStructure(event) {
    if (!event.eventType) return false;
    if (!event.platformMemberId) return false;
    if (['plan.purchased', 'plan.cancelled'].includes(event.eventType)) {
      if (!event.planId) return false;
    }
    return true;
  }

  async _checkIfDuplicate(eventId) {
    const result = await db.query(
      'SELECT event_id FROM processed_event_ids WHERE event_id = $1',
      [eventId]
    );
    return result.rows.length > 0;
  }

  async _markEventProcessed(eventId, event) {
    await db.query(
      'INSERT INTO processed_event_ids (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [eventId]
    );
  }

  async _logToAlertLog(eventId, event, reason) {
    try {
      // OB-88: reason is now the classification string (events_js_outdated, unknown_site_id,
      // unknown_client_id, or 'missing_required_fields' for structure failures). Used to drive
      // operator-visible banners + count pills in the Admin Hub.
      const alertType = reason && ['events_js_outdated', 'unknown_site_id', 'unknown_client_id'].includes(reason)
        ? reason
        : 'malformed_payload';

      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, $2, $3)`,
        [
          process.env.DEFAULT_TENANT_ID || null,
          alertType,
          eventId
        ]
      );
    } catch (err) {
      log.error('webhook.alert_log_failed', { eventId, reason }, err);
    }
  }

  async logWebhookAttempt({
    eventId = null, clientId = null, hmacStatus, dedupStatus = null,
    eventType = null, rawPayload = null, normalizedPayload = null,
    errorDetail = null, traceId = null
  }) {
    await db.query(
      `INSERT INTO webhook_log
       (event_id, client_id, hmac_status, dedup_status, event_type, raw_payload, normalized_payload, error_detail, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        eventId, clientId, hmacStatus, dedupStatus, eventType,
        rawPayload        ? JSON.stringify(rawPayload)        : null,
        normalizedPayload ? JSON.stringify(normalizedPayload) : null,
        errorDetail, traceId
      ]
    );
  }
}

const instance = new WebhookProcessor();
module.exports = instance;
module.exports.eventQueue = eventQueue;
