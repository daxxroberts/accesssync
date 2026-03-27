/**
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

// --- BullMQ Queue Connection ---
// Connects to Railway Redis in production, localhost in development
// BullMQ requires parsed host/port/password — does not support { url } format reliably
function parseRedisUrl(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: parseInt(u.port) || 6379,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      username: u.username ? decodeURIComponent(u.username) : undefined,
    };
  } catch {
    return { host: 'localhost', port: 6379 };
  }
}

const connection = process.env.REDIS_URL
  ? parseRedisUrl(process.env.REDIS_URL)
  : { host: 'localhost', port: 6379 };

const eventQueue = new Queue('accesssync-events', {
  connection,
  defaultJobOptions: {
    attempts: 3,                  // Max retries before dead-lettering (aligns with retry-engine)
    backoff: {
      type: 'exponential',
      delay: 1000,                // 1s, 2s, 4s
    },
    removeOnComplete: 100,        // Keep last 100 completed jobs for observability
    removeOnFail: 500,            // Keep last 500 failed jobs for debugging
  },
});

class WebhookProcessor {

  /**
   * Main entry point from Wix Adapter.
   * Validates → deduplicates → enqueues. Fast path — no hardware calls here.
   *
   * @param {string} eventId
   * @param {Object} standardEvent
   * @param {string} rawPayload
   */
  async processIncoming(eventId, standardEvent, rawPayload) {
    console.log(`[Webhook Processor] Received event ${eventId} of type ${standardEvent.eventType}`);

    // 1. Validate Structure
    if (!this._validateStructure(standardEvent)) {
      console.warn(`[Webhook Processor] Invalid structure for ${eventId}. Rejecting.`);
      await this._logToAlertLog(eventId, standardEvent, 'Missing required fields: wixMemberId or eventType');
      return;
    }

    // 2. Deduplication check (Idempotency — DR-010)
    const isDuplicate = await this._checkIfDuplicate(eventId);
    if (isDuplicate) {
      console.log(`[Webhook Processor] Event ${eventId} is a duplicate. Dropping.`);
      return;
    }

    // 3. Register Event (mark processed before enqueuing — prevents re-entry on crash)
    await this._markEventProcessed(eventId, standardEvent);

    // 4. Resolve tenant from wix_site_id (OB-03)
    const tenantId = await tenantResolver.resolve(standardEvent.wixSiteId);
    if (!tenantId) {
      console.warn(`[Webhook Processor] Could not resolve tenant for wix_site_id: ${standardEvent.wixSiteId}. Event ${eventId} dropped.`);
      await this._logToAlertLog(eventId, standardEvent, `Unknown wix_site_id: ${standardEvent.wixSiteId}`);
      return;
    }

    // 5. Classify and enqueue (DR-012)
    if (['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(standardEvent.eventType)) {
      await eventQueue.add('grant', { tenantId, standardEvent }, { jobId: `grant-${eventId}` });
      console.log(`[Webhook Processor] Event ${eventId} enqueued as grant job.`);

    } else if (['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'].includes(standardEvent.eventType)) {
      await eventQueue.add('revoke', { tenantId, standardEvent }, { jobId: `revoke-${eventId}` });
      console.log(`[Webhook Processor] Event ${eventId} enqueued as revoke job.`);

    } else {
      console.log(`[Webhook Processor] Unrecognized event type: ${standardEvent.eventType}. Ignoring.`);
    }
  }

  /**
   * @param {Object} event
   * @returns {boolean}
   */
  _validateStructure(event) {
    if (!event.eventType) return false;
    if (!event.platformMemberId) return false; // DR-021: was wixMemberId

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
    // Note: client_id not yet available at this point in the flow — tenant resolution
    // happens after deduplication. The processed_event_ids table allows nullable client_id.
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
}

const instance = new WebhookProcessor();
module.exports = instance;
module.exports.eventQueue = eventQueue; // Exported for reconciliation re-queue (DR-012)
