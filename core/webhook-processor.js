/**
 * @file webhook-processor.js
 * @layer core/layer4
 * @role deduplication, enqueue
 * @reads processed_event_ids, clients
 * @writes processed_event_ids, BullMQ, diagnostic_log (via logger)
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

  async processIncoming(eventId, standardEvent, rawPayload) {
    log.info('webhook.received', { eventId, eventType: standardEvent.eventType });

    // 1. Validate Structure
    if (!this._validateStructure(standardEvent)) {
      log.warn('webhook.invalid_structure', { eventId, eventType: standardEvent.eventType });
      await this._logToAlertLog(eventId, standardEvent, 'Missing required fields: platformMemberId or eventType');
      return;
    }

    // 2. Deduplication check (Idempotency — DR-010)
    const isDuplicate = await this._checkIfDuplicate(eventId);
    if (isDuplicate) {
      log.info('webhook.duplicate', { eventId, eventType: standardEvent.eventType });
      return;
    }

    // 3. Register Event (mark processed before enqueuing — prevents re-entry on crash)
    await this._markEventProcessed(eventId, standardEvent);

    // 3b. Log to webhook_log for Admin Hub Webhook Inspector
    await this.logWebhookAttempt({
      eventId,
      hmacStatus: 'accepted',
      dedupStatus: isDuplicate ? 'duplicate' : 'new',
      eventType: standardEvent.eventType,
      rawPayload: rawPayload ? (() => { try { return JSON.parse(rawPayload); } catch { return null; } })() : null,
      normalizedPayload: standardEvent
    }).catch(() => {});

    // 4. Resolve tenant from wix_site_id
    const tenantId = await tenantResolver.resolve(standardEvent.wixSiteId);
    if (!tenantId) {
      const err = new Error(`Unknown wix_site_id: ${standardEvent.wixSiteId}`);
      err.code = 'TENANT_NOT_RESOLVED';
      log.warn('webhook.tenant_not_resolved', { eventId, wixSiteId: standardEvent.wixSiteId }, err);
      await this._logToAlertLog(eventId, standardEvent, `Unknown wix_site_id: ${standardEvent.wixSiteId}`);
      return;
    }

    // 5. Classify and enqueue (DR-012)
    if (['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(standardEvent.eventType)) {
      await eventQueue.add('grant', { tenantId, standardEvent }, { jobId: `grant-${eventId}` });
      log.info('webhook.enqueued', { eventId, eventType: standardEvent.eventType, jobType: 'grant', tenantId });

    } else if (['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'].includes(standardEvent.eventType)) {
      await eventQueue.add('revoke', { tenantId, standardEvent }, { jobId: `revoke-${eventId}` });
      log.info('webhook.enqueued', { eventId, eventType: standardEvent.eventType, jobType: 'revoke', tenantId });

    } else {
      log.info('webhook.unrecognised_type', { eventId, eventType: standardEvent.eventType });
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
    await db.query(
      `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
       VALUES ($1, $2, $3)`,
      [
        process.env.DEFAULT_TENANT_ID || null,
        'malformed_payload',
        eventId
      ]
    );
  }

  async logWebhookAttempt({
    eventId = null, clientId = null, hmacStatus, dedupStatus = null,
    eventType = null, rawPayload = null, normalizedPayload = null, errorDetail = null
  }) {
    await db.query(
      `INSERT INTO webhook_log
       (event_id, client_id, hmac_status, dedup_status, event_type, raw_payload, normalized_payload, error_detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId, clientId, hmacStatus, dedupStatus, eventType,
        rawPayload        ? JSON.stringify(rawPayload)        : null,
        normalizedPayload ? JSON.stringify(normalizedPayload) : null,
        errorDetail
      ]
    );
  }
}

const instance = new WebhookProcessor();
module.exports = instance;
module.exports.eventQueue = eventQueue;
