/**
 * retry-engine.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Called by queue-worker when BullMQ has exhausted all retries (worker.on('failed'))
 * - Writes dead-lettered job to error_queue for reconciliation re-attempt
 * - Sends operator email notification via Resend SDK (DR-020)
 */

const db = require('../db');

class RetryEngine {
  constructor() {
    this.maxAttempts = 3;
  }

  /**
   * Called by queue-worker after BullMQ exhausts all retries.
   * Writes to error_queue and notifies operator.
   *
   * @param {Object} job       - BullMQ job object (job.data = { tenantId, standardEvent })
   * @param {Error}  error     - The final error that caused failure
   */
  async handleFailure(job, error) {
    const tenantId = job.data?.tenantId;
    const standardEvent = job.data?.standardEvent;
    const eventType = standardEvent?.eventType;
    const platformMemberId = standardEvent?.platformMemberId;

    console.error(`[Retry Engine] Dead-lettering job ${job.id} | tenant=${tenantId} | member=${platformMemberId} | error=${error.message}`);

    await this._moveToDeadLetter(tenantId, platformMemberId, eventType, standardEvent, error);
    await this._notifyOperator(tenantId, error);
  }

  /**
   * Writes failed job to error_queue.
   * member_access_state.status is already set to 'failed' by grant-revoke before throw.
   */
  async _moveToDeadLetter(tenantId, platformMemberId, eventType, standardEvent, error) {
    try {
      // Resolve internal member_identity.id from (client_id, platform_member_id)
      let memberId = null;
      if (tenantId && platformMemberId) {
        const identityResult = await db.query(
          `SELECT id FROM member_identity
           WHERE client_id = $1 AND platform_member_id = $2
           LIMIT 1`,
          [tenantId, platformMemberId]
        );
        if (identityResult.rows.length > 0) {
          memberId = identityResult.rows[0].id;
        }
      }

      await db.query(
        `INSERT INTO error_queue (client_id, member_id, event_type, payload, error_reason, retry_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'failed')`,
        [
          tenantId || null,
          memberId || null,
          eventType || null,
          JSON.stringify(standardEvent || {}),
          error.message,
          this.maxAttempts,
        ]
      );
    } catch (dbErr) {
      // Never crash retry-engine — log and continue to notification
      console.error('[Retry Engine] Failed to write to error_queue:', dbErr.message);
    }
  }

  /**
   * Sends operator email via Resend SDK (DR-020).
   * Falls back to config_alert_log if email is not configured or delivery fails.
   */
  async _notifyOperator(tenantId, error) {
    let toEmail = null;

    try {
      if (tenantId) {
        const clientRow = await db.query(
          'SELECT notification_email FROM clients WHERE id = $1',
          [tenantId]
        );
        toEmail = clientRow.rows[0]?.notification_email || null;
      }
      toEmail = toEmail || process.env.OPERATOR_NOTIFICATION_EMAIL || null;

      if (!toEmail) {
        console.error(`[Retry Engine] OPERATOR ALERT (no email configured) | tenant=${tenantId} | ${error.message}`);
        return;
      }

      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
        to: toEmail,
        subject: '[AccessSync] Action required — member provisioning failed',
        text: `Tenant: ${tenantId}\nError: ${error.message}\nCheck the error_queue table for full details and payload.`,
      });

      console.log(`[Retry Engine] Operator alert sent to ${toEmail}`);
    } catch (notifyErr) {
      // Notification failure → write to config_alert_log so nightly digest catches it
      console.error('[Retry Engine] Failed to send operator notification:', notifyErr.message);
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
         VALUES ($1, 'notification_delivery_failed', $2)`,
        [tenantId || null, notifyErr.message]
      ).catch(() => {}); // Best-effort — never crash on notification failure
    }
  }
}

module.exports = new RetryEngine();
