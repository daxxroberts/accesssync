/**
 * @file diagnostics.js
 * @layer core/shared
 * @role diagnostics
 * @reads member_master, member_access, member_access_sources, plan_mappings,
 *        diagnostic_log, webhook_log, adapter_admin_log, error_queue, member_access_log
 * @exports diagnoseMember, getTimeline
 *
 * Migration history: this file was originally written against
 * member_identity / member_access_state / member_role_assignments. Schema
 * restructure moved to member_master / member_access / member_access_sources.
 * Rewritten 2026-05-10 to match current schema. The Member Incident drawer
 * (Errors page) was returning 500 on every "View incident" click before this fix.
 *
 * memberId param semantics: this is the AccessSync internal ID — for the new
 * schema, that's member_master.id (which is also what error_queue.member_id stores
 * for migrated rows). Sub-member rows live on member_access.sub_master_id.
 */

'use strict';

const db = require('../db');

/**
 * Runs the diagnostic for a member.
 * Returns { verdict, member, roles, sources, findings }.
 * Throws if the member does not exist.
 *
 * @param {string} memberId  member_master.id (UUID)
 */
async function diagnoseMember(memberId) {
  const findings = [];
  let verdict = 'healthy';

  // 1. Identity + state. Pull the member_master row plus the holder's member_access
  //    row (sub_master_id IS NULL = holder, not a sub-member).
  const memberResult = await db.query(
    `SELECT mm.id, mm.platform_member_id, mm.client_id, mm.email, mm.first_name,
            mm.last_name, mm.display_name, mm.source_platform, c.name AS client_name,
            ma.id AS access_id, ma.status AS access_status, ma.provisioned_at,
            ma.hardware_user_id, ma.hardware_platform
     FROM member_master mm
     LEFT JOIN clients c ON c.id = mm.client_id
     LEFT JOIN member_access ma ON ma.member_master_id = mm.id AND ma.sub_master_id IS NULL
     WHERE mm.id = $1
     LIMIT 1`,
    [memberId]
  );
  if (!memberResult.rows.length) {
    const err = new Error('Member not found');
    err.statusCode = 404;
    throw err;
  }
  const member = memberResult.rows[0];

  if (member.access_status === 'failed') {
    verdict = 'failed';
    findings.push({ level: 'error', code: 'STATUS_FAILED', message: 'Member access status is failed — grant job exhausted retries or was never completed.' });
  } else if (!member.access_status) {
    verdict = 'degraded';
    findings.push({ level: 'warn', code: 'NO_ACCESS_ROW', message: 'No member_access row found — member identity exists but no access record.' });
  } else if (member.access_status !== 'active') {
    verdict = 'degraded';
    findings.push({ level: 'warn', code: 'STATUS_NOT_ACTIVE', message: `Access status is "${member.access_status}" — expected "active".` });
  }

  // 2. Hardware role assignments — stored on member_access_sources.role_assignment_id.
  const rolesResult = await db.query(
    `SELECT mas.role_assignment_id, mas.hardware_group_id, mas.mapping_id,
            mas.source_type, mas.source_plan_id, mas.created_at,
            pm.plan_name, pm.door_name
     FROM member_access_sources mas
     JOIN member_access ma ON ma.id = mas.access_id
     LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
     WHERE ma.member_master_id = $1
       AND mas.role_assignment_id IS NOT NULL`,
    [memberId]
  );
  const roles = rolesResult.rows;
  if (roles.length === 0) {
    if (verdict === 'healthy') verdict = 'degraded';
    findings.push({ level: 'warn', code: 'NO_ROLE_ASSIGNMENTS', message: 'No hardware role assignments found — member has no door access provisioned.' });
  }

  // 3. Access sources vs active plan mappings — surface stale/inactive mapping refs.
  const sourcesResult = await db.query(
    `SELECT mas.id, mas.access_id, mas.mapping_id, mas.role_assignment_id,
            mas.source_type, mas.source_plan_id, mas.effective_start, mas.valid_until,
            pm.plan_name, pm.status AS mapping_status
     FROM member_access_sources mas
     JOIN member_access ma ON ma.id = mas.access_id
     LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
     WHERE ma.member_master_id = $1`,
    [memberId]
  );
  const sources = sourcesResult.rows;
  for (const src of sources) {
    if (src.mapping_status === 'inactive') {
      findings.push({ level: 'warn', code: 'SOURCE_INACTIVE_MAPPING', message: `Source row references inactive mapping "${src.plan_name}" — plan was disabled but source row was not cleaned up.` });
      if (verdict === 'healthy') verdict = 'degraded';
    }
  }

  // 4. Recent diagnostic_log errors (last 24h) — keyed off memberId AND platform_member_id.
  //    Both stored in diagnostic_log.context per the trace context spec.
  const recentErrors = await db.query(
    `SELECT error_code, message, created_at, context
     FROM diagnostic_log
     WHERE (context->>'memberId' = $1 OR context->>'platformMemberId' = $2)
       AND level = 'error'
       AND created_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC
     LIMIT 10`,
    [memberId, member.platform_member_id]
  );
  for (const err of recentErrors.rows) {
    const alreadyFlagged = findings.some(f => f.code === err.error_code);
    if (!alreadyFlagged) {
      findings.push({ level: 'error', code: err.error_code, message: err.message, at: err.created_at, context: err.context });
      if (verdict === 'healthy') verdict = 'degraded';
    }
  }

  if (findings.length === 0) {
    findings.push({ level: 'ok', code: 'ALL_CHECKS_PASSED', message: `${roles.length} role(s), ${sources.length} source(s) — all consistent.` });
  }

  return {
    verdict,
    member: {
      id:               member.id,
      platform_member_id: member.platform_member_id,
      display_name:     member.display_name,
      first_name:       member.first_name,
      last_name:        member.last_name,
      email:            member.email,
      client_name:      member.client_name,
      access_status:    member.access_status,
      hardware_user_id: member.hardware_user_id,
      hardware_platform: member.hardware_platform,
      provisioned_at:   member.provisioned_at,
    },
    roles,
    sources,
    findings,
  };
}

/**
 * Fetches the full lifecycle timeline for a member across multiple log sources.
 * Returns { member, timeline }.
 * Throws if the member does not exist.
 *
 * @param {string} memberId  member_master.id (UUID)
 */
async function getTimeline(memberId) {
  const memberResult = await db.query(
    `SELECT mm.id, mm.platform_member_id, mm.client_id, mm.email, mm.display_name,
            c.name AS client_name,
            ma.id AS access_id, ma.status AS access_status, ma.provisioned_at,
            lat.webhook_received_at, lat.enqueued_at, lat.kisi_confirmed_at,
            lat.ingest_s, lat.processing_s, lat.total_s
     FROM member_master mm
     LEFT JOIN clients c ON c.id = mm.client_id
     LEFT JOIN member_access ma ON ma.member_master_id = mm.id AND ma.sub_master_id IS NULL
     LEFT JOIN LATERAL (
       SELECT
         wl.received_at                                                          AS webhook_received_at,
         pei.processed_at                                                        AS enqueued_at,
         mas2.created_at                                                         AS kisi_confirmed_at,
         ROUND(EXTRACT(EPOCH FROM (pei.processed_at  - wl.received_at)))::int   AS ingest_s,
         ROUND(EXTRACT(EPOCH FROM (mas2.created_at   - pei.processed_at)))::int AS processing_s,
         ROUND(EXTRACT(EPOCH FROM (mas2.created_at   - wl.received_at)))::int   AS total_s
       FROM webhook_log wl
       JOIN processed_event_ids pei ON pei.event_id = wl.event_id
       JOIN member_access_sources mas2
         ON mas2.access_id = ma.id
        AND mas2.created_at > wl.received_at
        AND mas2.created_at < wl.received_at + INTERVAL '1 hour'
       WHERE wl.client_id = mm.client_id
         AND wl.normalized_payload->>'platformMemberId' = mm.platform_member_id
         AND wl.hmac_status = 'accepted'
         AND wl.dedup_status = 'new'
       ORDER BY wl.received_at DESC
       LIMIT 1
     ) lat ON TRUE
     WHERE mm.id = $1
     LIMIT 1`,
    [memberId]
  );
  if (!memberResult.rows.length) {
    const err = new Error('Member not found');
    err.statusCode = 404;
    throw err;
  }
  const member = memberResult.rows[0];

  const timeline = await db.query(
    `SELECT 'access_log'      AS source,
            mal.id::text,
            mal.event_type,
            mal.error_code     AS detail,
            NULL::text         AS error_code,
            NULL::jsonb        AS context,
            mal.trace_id,
            mal.created_at
     FROM member_access_log mal
     JOIN member_access ma ON ma.id = mal.member_id
     WHERE ma.member_master_id = $1

     UNION ALL

     SELECT 'error_queue'     AS source,
            eq.id::text,
            eq.event_type,
            eq.error_reason    AS detail,
            eq.error_code,
            NULL::jsonb        AS context,
            eq.trace_id,
            eq.created_at
     FROM error_queue eq
     WHERE eq.member_id = $1

     UNION ALL

     SELECT 'adapter_log'     AS source,
            aal.id::text,
            aal.event_type,
            aal.result         AS detail,
            NULL::text         AS error_code,
            NULL::jsonb        AS context,
            aal.trace_id,
            aal.created_at
     FROM adapter_admin_log aal
     WHERE aal.platform_member_id = $2 AND aal.client_id = $3

     UNION ALL

     SELECT 'diagnostic_log'  AS source,
            dl.id::text,
            dl.error_code      AS event_type,
            dl.message         AS detail,
            dl.error_code,
            dl.context,
            dl.trace_id,
            dl.created_at
     FROM diagnostic_log dl
     WHERE dl.context->>'memberId' = $1::text
        OR dl.context->>'platformMemberId' = $2

     UNION ALL

     SELECT 'webhook_log'     AS source,
            wl.id::text,
            wl.event_type,
            wl.dedup_status    AS detail,
            wl.hmac_status     AS error_code,
            wl.normalized_payload AS context,
            wl.trace_id,
            wl.received_at     AS created_at
     FROM webhook_log wl
     WHERE wl.client_id = $3
       AND wl.normalized_payload->>'platformMemberId' = $2

     ORDER BY created_at DESC
     LIMIT 200`,
    [memberId, member.platform_member_id, member.client_id]
  );

  return {
    member,
    timeline: timeline.rows,
  };
}

module.exports = { diagnoseMember, getTimeline };
