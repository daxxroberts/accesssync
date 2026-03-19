/**
 * webhook-processor.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Receives validated webhook events from Wix Adapter
 * - Verifies payload structure (required fields)
 * - Deduplicates via processed_event_ids table
 * - Passes valid new events to Grant/Revoke Logic
 */

const grantRevokeLogic = require('./grant-revoke');

class WebhookProcessor {

  /**
   * Main entry point from Wix Adapter. 
   * Executes sequentially before enqueuing to BullMQ or directly processing.
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

    // 2. Deduplication check (Idempotency)
    const isDuplicate = await this._checkIfDuplicate(eventId);
    if (isDuplicate) {
      console.log(`[Webhook Processor] Event ${eventId} is a duplicate. Dropping.`);
      return; // Safe to drop
    }

    // 3. Register Event
    await this._markEventProcessed(eventId);

    // 4. Determine Target Action (or enqueue to BullMQ here in production)
    console.log(`[Webhook Processor] Event ${eventId} validated. Passing to logic layer.`);
    
    // In full production, this would be: await bullMqQueue.add('process-event', { standardEvent })
    // For foundational setup, we pass directly:
    const tenantId = process.env.DEFAULT_TENANT_ID || 'default-tenant-id'; // To be mapped from siteId if multi-tenant
    
    if (['plan.purchased', 'payment.recovered', 'booking.confirmed'].includes(standardEvent.eventType)) {
       await grantRevokeLogic.processGrant(tenantId, standardEvent);
    } else if (['plan.cancelled', 'payment.failed', 'booking.cancelled', 'member.deleted'].includes(standardEvent.eventType)) {
       await grantRevokeLogic.processRevoke(tenantId, standardEvent.eventType, standardEvent);
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
    if (!event.wixMemberId) return false;
    
    // For plan-related events, require a planId
    if (['plan.purchased', 'plan.cancelled'].includes(event.eventType)) {
      if (!event.planId) return false;
    }
    
    return true;
  }

  async _checkIfDuplicate(eventId) {
    // DB: SELECT * FROM processed_event_ids WHERE event_id = eventId
    // return !!result;
    return false; // placeholder memory layer
  }

  async _markEventProcessed(eventId) {
    // DB: INSERT INTO processed_event_ids (event_id) VALUES (eventId)
  }

  async _logToAlertLog(eventId, event, reason) {
    // DB: INSERT INTO config_alert_log (alert_type, hardware_ref) VALUES ('malformed_payload', eventId)
  }
}

module.exports = new WebhookProcessor();
