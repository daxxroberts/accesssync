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
const { sendOperatorEmail } = require('./operator-mailer');
const { renderMemberFailureAlert } = require('./operator-email-templates');
const { guidanceFor, OWNER } = require('./error-guidance');

/**
 * Next-step text stored on the error row and put in the email. core/error-guidance.js is the single source of
 * truth for who must act and what to do, so the stored text, the page, the drawer and the email cannot disagree.
 * (The connector's own `action` is NOT used: for a Kisi 422 it said "try retrying", which re-sends the same
 * request and fails the same way.)
 */
function nextStepText(error, eventType) {
  return guidanceFor({
    error_code: error.code, resolution: error.resolution, http_status: error.statusCode, event_type: eventType,
  }).steps.join(' ');
}

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

    const dl = await this._moveToDeadLetter(tenantId, platformMemberId, eventType, standardEvent, error);

    // Alert ONCE per problem. A repeat of a failure that is already open (or was resolved in the last 24h and
    // has now come back) only counts up on its existing row: the operator was already told. Before this check
    // every repeat — each 12-hourly sweep, each Retry click — sent the same email again.
    if (!dl.isNew) {
      log.info('retry.notify.suppressed_repeat', { tenantId, errorCode: error.code || null, eventType });
      return;
    }
    const guide = guidanceFor({
      error_code: error.code, resolution: error.resolution, http_status: error.statusCode, event_type: eventType,
    });
    // One cause, many members (a revoked key, a deleted door group, an outage): one email, not one per member.
    if (await this._alertedRecentlyForCause(tenantId, error, dl.id, guide)) {
      log.info('retry.notify.suppressed_same_cause', { tenantId, errorCode: error.code || null, eventType });
      return;
    }
    await this._notifyOperator(tenantId, error, platformMemberId, eventType, guide);
    // The gym's email says "AccessSync support will look into it" — so AccessSync's owner must be told too,
    // not left to find it on the panel.
    if (guide.owner === OWNER.ACCESSSYNC) await this._notifyOwnerCopy(tenantId, error, eventType, guide);
  }

  /**
   * Writes failed job to error_queue.
   * member_access_state.status is already set to 'failed' by grant-revoke before throw.
   */
  async _moveToDeadLetter(tenantId, platformMemberId, eventType, standardEvent, error) {
    try {
      // Resolve internal member_master.id from (client_id, source_platform, platform_member_id)
      // so error_queue.member_id can be set for the operator's "View incident" drawer.
      let memberId = null;
      if (tenantId && platformMemberId) {
        const identityResult = await db.query(
          `SELECT id FROM member_master
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

      // Dedup: the same problem for the same member must not become a new row (and a new email) every sweep.
      //   same member  = the member_master row, or — when it is not in member_master yet — the Wix member id
      //                  carried in the event payload;
      //   same problem = the error code, or the error text when there is no code;
      //   same plan    = the event's planId (each row's Retry replays its own event).
      // A row that is still open matches, and so does one RESOLVED in the last 24h (someone pressed Retry or
      // "Mark resolved" and it failed again): that row is re-opened and counted, so the panel shows it again
      // instead of going quiet — and no second email goes out (handleFailure only mails new rows).
      const pmid = platformMemberId || null;
      if (tenantId && (memberId || pmid)) {
        const params = [tenantId];
        const memberCond = memberId
          ? (params.push(memberId), `member_id = $${params.length}`)
          : (params.push(pmid), `(member_id IS NULL AND payload->>'platformMemberId' = $${params.length})`);
        const causeCond = errorCode
          ? (params.push(errorCode), `error_code = $${params.length}`)
          : (params.push(error.message || ''), `error_reason = $${params.length}`);
        // same plan too: each row replays ITS event on Retry, so a second plan failing for the same member and
        // code must get its own row (it used to only count up the first plan's row, and Retry replayed the wrong plan).
        params.push(standardEvent?.planId || '');
        const planCond = `COALESCE(payload->>'planId', '') = $${params.length}`;
        const existing = await db.query(
          `SELECT id FROM error_queue
           WHERE client_id = $1 AND ${memberCond} AND ${causeCond} AND ${planCond}
             AND (status = 'failed' OR (status = 'resolved' AND resolved_at > NOW() - INTERVAL '24 hours'))
           ORDER BY (status = 'failed') DESC, created_at DESC
           LIMIT 1`,
          params
        );
        if (existing.rows.length > 0) {
          await db.query(
            `UPDATE error_queue SET
               status           = 'failed',
               resolved_at      = NULL,
               occurred_count   = COALESCE(occurred_count, 0) + 1,
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
              nextStepText(error, eventType),
              error.statusCode  || null,
              rawApiBody,
            ]
          );
          return { isNew: false, id: existing.rows[0].id };
        }
      }

      const _actor = getActor() || {};
      const inserted = await db.query(
        `INSERT INTO error_queue
           (client_id, member_id, event_type, payload, error_reason,
            error_code, user_message, resolution, action_text,
            http_status, raw_api_body,
            retry_count, status,
            plan_name, door_name, location_id,
            occurred_count, last_occurred_at,
            trace_id, actor_type, actor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'failed',$13,$14,$15,1,NOW(),$16,$17,$18)
         RETURNING id`,
        [
          tenantId          || null,
          memberId          || null,
          eventType         || null,
          JSON.stringify(standardEvent || {}),
          error.message,
          errorCode,
          error.userMessage || null,
          error.resolution  || null,
          nextStepText(error, eventType),
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
      return { isNew: true, id: inserted && inserted.rows && inserted.rows[0] ? inserted.rows[0].id : null };
    } catch (dbErr) {
      // Never crash retry-engine — log and continue to notification. (If the row could not be written the
      // operator must still hear about the failure, so this counts as new.)
      log.error('retry.dead_letter.db_write_failed', { tenantId }, dbErr);
      return { isNew: true, id: null };
    }
  }

  /**
   * Was this cause already alerted in the last hour? A rotated key or a deleted door group hits every member at once
   * and one email per member would only be noise. Only rows created BEFORE this one count (by created_at, then id):
   * workers run 20 at a time, so two members failing together both exist when each checks — if each counted the
   * other, both would stay silent. With the ordering the first row of a burst always alerts.
   * "Same cause" also means the same person must act: a 404 on a grant is the gym's (re-map the door group) but on a
   * removal it is AccessSync's, so one must not hide the other. Never throws; on any doubt it answers "no" so an
   * alert is not lost.
   */
  async _alertedRecentlyForCause(tenantId, error, newRowId, guide = null) {
    if (!tenantId || !newRowId) return false;
    try {
      const byCode = !!error.code;
      const r = await db.query(
        `SELECT event_type, error_code, resolution, http_status FROM error_queue
          WHERE client_id = $1 AND id <> $2
            AND ${byCode ? 'error_code' : 'error_reason'} = $3
            AND created_at > NOW() - INTERVAL '1 hour'
            AND (created_at, id) < (SELECT created_at, id FROM error_queue WHERE id = $2)
          LIMIT 20`,
        [tenantId, newRowId, byCode ? error.code : (error.message || '')]
      );
      const rows = (r && r.rows) || [];
      if (!guide) return rows.length > 0;
      return rows.some((row) => guidanceFor(row).owner === guide.owner);
    } catch (_err) {
      return false;
    }
  }

  /**
   * Sends operator email via Resend SDK (DR-020).
   * Falls back to config_alert_log if email is not configured or delivery fails.
   */
  async _notifyOperator(tenantId, error, platformMemberId, eventType, guide = null) {
    let toEmail = null;
    guide = guide || guidanceFor({
      error_code: error.code, resolution: error.resolution, http_status: error.statusCode, event_type: eventType,
    });

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

      // Raw IDs (member/event/tenant) deliberately stay out of the email body — they mean
      // nothing to a gym owner and are already on the error_queue row the CTA links to.
      const { sent, reason } = await sendOperatorEmail({
        toEmail,
        render: renderMemberFailureAlert,
        renderArgs: {
          // The headline and steps come from core/error-guidance.js, never from the connector's own message,
          // so the email says who must act and what to do — the same as the page it links to.
          userMessage: guide.headline,
          actionText: guide.steps.join(' '),
          owner: guide.owner,
          retry: guide.retry,
          memberName: null,
          planName: null,
          clientId: tenantId,
        },
        logContext: { alert: 'member_failure', tenantId, eventType, errorCode: error.code || null },
      });

      if (!sent) {
        throw new Error(reason || 'operator email not sent');
      }

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

  /**
   * AccessSync-owned errors also go to the AccessSync owner. The gym's email says "AccessSync support will look
   * into it"; without this the owner would only find out by opening the panel. Skipped when the owner address is
   * unset or is the same address the gym email just went to (no duplicate). Never throws.
   */
  async _notifyOwnerCopy(tenantId, error, eventType, guide) {
    try {
      const ownerEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;
      if (!ownerEmail) return;
      let clientName = null;
      let clientEmail = null;
      if (tenantId) {
        const c = await db.query('SELECT name, notification_email FROM clients WHERE id = $1', [tenantId]);
        clientName = c.rows[0]?.name || null;
        clientEmail = c.rows[0]?.notification_email || null;
      }
      if (clientEmail && clientEmail.toLowerCase() === ownerEmail.toLowerCase()) return;   // already sent
      await sendOperatorEmail({
        toEmail: ownerEmail,
        render: renderMemberFailureAlert,
        renderArgs: {
          userMessage: guide.headline,
          actionText: guide.steps.join(' '),
          owner: guide.owner,
          retry: guide.retry,
          audience: 'owner',
          clientName,
          memberName: null,
          planName: null,
          clientId: tenantId,
        },
        logContext: { alert: 'member_failure_owner_copy', tenantId, eventType, errorCode: error.code || null },
      });
    } catch (err) {
      log.error('retry.notify.owner_copy_failed', { tenantId }, err);
    }
  }
}

module.exports = new RetryEngine();
