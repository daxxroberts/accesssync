/**
 * @file retry-engine.js
 * @layer core/layer4
 * @role error-handling, dead-letter
 * @writes error_queue
 * @calls resend (email alerts)
 * @exports handleFailedJob
 * @dr DR-020
 *
 * retry-engine.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Called by queue-worker when BullMQ has exhausted all retries (worker.on('failed'))
 * - Writes dead-lettered job to error_queue for reconciliation re-attempt
 * - Sends operator email notification via Resend SDK (DR-020)
 */

const db = require('../db');
const { log } = require('./logger');
const { getTraceId, getActor } = require('./trace-context');

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

    log.error('retry.dead_letter', {
      jobId: job.id, tenantId, memberId: platformMemberId, eventType,
      traceId: job.data?.standardEvent?.traceId || null,
    }, error);

    await this._moveToDeadLetter(tenantId, platformMemberId, eventType, standardEvent, error);
    await this._notifyOperator(tenantId, error, platformMemberId, eventType);
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

      // Resolve plan/door/location context for operator triage
      let planName = null, doorName = null, locationId = null;
      const planId = standardEvent?.planId || null;
      if (tenantId && planId) {
        const mappingResult = await db.query(
          `SELECT pm.plan_name, pm.door_name, pm.location_id
           FROM plan_mappings pm
           WHERE pm.client_id = $1 AND pm.source_plan_id = $2 AND pm.status = 'active'
           LIMIT 1`,
          [tenantId, planId]
        );
        if (mappingResult.rows.length > 0) {
          planName   = mappingResult.rows[0].plan_name || null;
          doorName   = mappingResult.rows[0].door_name || null;
          locationId = mappingResult.rows[0].location_id || null;
        }
      }

      const errorCode    = error.code        || null;
      const rawApiBody   = error.body        ? JSON.stringify(error.body) : null;

      // Dedup: if same (client, member, error_code) already failed, increment count
      // instead of inserting a duplicate row. Skips email re-notification.
      if (tenantId && memberId && errorCode) {
        const existing = await db.query(
          `SELECT id FROM error_queue
           WHERE client_id = $1 AND member_id = $2 AND error_code = $3 AND status = 'failed'
           LIMIT 1`,
          [tenantId, memberId, errorCode]
        );
        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE error_queue SET
               occurred_count   = occurred_count + 1,
               last_occurred_at = NOW(),
               error_reason     = $2,
               user_message     = $3,
               action_text      = $4,
               http_status      = $5,
               raw_api_body     = $6
             WHERE id = $1`,
            [
              existing.rows[0].id,
              error.message,
              error.userMessage || null,
              error.action      || null,
              error.statusCode  || null,
              rawApiBody,
            ]
          );
          return; // Skip duplicate email — operator was already notified on first occurrence
        }
      }

      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO error_queue
           (client_id, member_id, event_type, payload, error_reason,
            error_code, user_message, resolution, action_text,
            http_status, raw_api_body,
            retry_count, status,
            plan_name, door_name, location_id,
            occurred_count, last_occurred_at,
            trace_id, actor_type, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'failed',$13,$14,$15,1,NOW(),$16,$17,$18)`,
        [
          tenantId          || null,
          memberId          || null,
          eventType         || null,
          JSON.stringify(standardEvent || {}),
          error.message,
          errorCode,
          error.userMessage || null,
          error.resolution  || null,
          error.action      || null,
          error.statusCode  || null,
          rawApiBody,
          this.maxAttempts,
          planName          || null,
          doorName          || null,
          locationId        || null,
          getTraceId()      || null,
          _actor.type       || null,
          _actor.id         || null,
        ]
      );
    } catch (dbErr) {
      // Never crash retry-engine — log and continue to notification
      log.error('retry.dead_letter.db_write_failed', { tenantId }, dbErr);
    }
  }

  /**
   * Sends operator email via Resend SDK (DR-020).
   * Falls back to config_alert_log if email is not configured or delivery fails.
   */
  async _notifyOperator(tenantId, error, platformMemberId, eventType) {
    let toEmail = null;

    try {
      if (tenantId) {
        const clientRow = await db.query(
          'SELECT notification_email FROM clients WHERE id = $1',
          [tenantId]
        );
        toEmail = clientRow.rows[0]?.notification_email || null;
      }
      toEmail = toEmail || process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;

      if (!toEmail) {
        log.warn('retry.notify.no_email', { tenantId }, error);
        return;
      }

      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      const subject = error.code
        ? `[AccessSync] A member didn't get access — ${error.code}`
        : '[AccessSync] A member provisioning failed — action may be required';

      const bodyLines = [
        error.userMessage || error.message,
        '',
        error.action ? `What to do: ${error.action}` : '',
        '',
        `Member ID: ${platformMemberId || 'unknown'}`,
        `Event: ${eventType || 'unknown'}`,
        `Gym: ${tenantId}`,
        '',
        'Log in to your AccessSync dashboard to retry or dismiss this error.',
      ].filter(l => l !== undefined);

      await resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL || 'alerts@accesssync.io',
        to: toEmail,
        subject,
        text: bodyLines.join('\n'),
      });

      log.info('retry.notify.sent', { tenantId, to: toEmail });
    } catch (notifyErr) {
      // Notification failure → write to config_alert_log so nightly digest catches it
      log.error('retry.notify.send_failed', { tenantId }, notifyErr);
      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, 'notification_delivery_failed', $2, $3, $4, $5)`,
        [tenantId || null, notifyErr.message, getTraceId() || null, _actor.type || null, _actor.id || null]
      ).catch(() => {}); // Best-effort — never crash on notification failure
    }
  }
}

module.exports = new RetryEngine();
