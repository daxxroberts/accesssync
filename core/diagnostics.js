/**
 * @file diagnostics.js
 * @layer core/shared
 * @role diagnostics
 * @reads member_identity, member_access_state, member_role_assignments, member_access_sources, plan_mappings, diagnostic_log, webhook_log, adapter_admin_log, error_queue, member_access_log
 * @exports diagnoseMember, getTimeline
 */

'use strict';

const db = require('../db');

/**
 * Runs the 4-check diagnostic for a member.
 * Returns { verdict, member, roles, sources, findings }.
 * Throws if the member does not exist.
 *
 * @param {string} memberId  member_identity.id (UUID)
 */
async function diagnoseMember(memberId) {
  const findings = [];
  let verdict = 'healthy';

  // 1. Identity + state
  const memberResult = await db.query(
    `SELECT mi.*, mas.status AS access_status, mas.provisioned_at
     FROM member_identity mi
     LEFT JOIN member_access_state mas ON mas.member_id = mi.id
     WHERE mi.id = $1`,
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
    findings.push({ level: 'error', code: 'STATUS_FAILED', message: 'Member access_state is failed — grant job exhausted retries or was never completed.' });
  } else if (member.access_status !== 'active') {
    verdict = 'degraded';
    findings.push({ level: 'warn', code: 'STATUS_NOT_ACTIVE', message: `Access status is "${member.access_status}" — expected "active".` });
  }

  // 2. Hardware role assignments
  const rolesResult = await db.query(
    `SELECT mra.*, pm.plan_name, pm.door_name, pm.hardware_group_id AS mapping_group_id
     FROM member_role_assignments mra
     LEFT JOIN plan_mappings pm ON pm.id = mra.mapping_id
     WHERE mra.member_id = $1`,
    [memberId]
  );
  const roles = rolesResult.rows;
  if (roles.length === 0) {
    if (verdict === 'healthy') verdict = 'degraded';
    findings.push({ level: 'warn', code: 'NO_ROLE_ASSIGNMENTS', message: 'No hardware role assignments found — member has no door access provisioned in DB.' });
  }

  // 3. Access sources vs active plan mappings
  const sourcesResult = await db.query(
    `SELECT mas2.*, pm.plan_name, pm.status AS mapping_status
     FROM member_access_sources mas2
     LEFT JOIN plan_mappings pm ON pm.id = mas2.mapping_id
     WHERE mas2.member_id = $1`,
    [memberId]
  );
  const sources = sourcesResult.rows;
  if (sources.length === 0 && roles.length > 0) {
    verdict = 'mismatch';
    findings.push({ level: 'error', code: 'SOURCES_MISSING', message: 'Hardware role exists but no member_access_sources rows found — revoke logic will not fire correctly.' });
  }

  for (const src of sources) {
    if (src.mapping_status === 'inactive') {
      findings.push({ level: 'warn', code: 'SOURCE_INACTIVE_MAPPING', message: `Source row references inactive mapping "${src.plan_name}" — plan was disabled but source row was not cleaned up.` });
      if (verdict === 'healthy') verdict = 'degraded';
    }
  }

  for (const role of roles) {
    const matchingSource = sources.find(s => s.mapping_id === role.mapping_id);
    if (!matchingSource) {
      verdict = 'mismatch';
      findings.push({ level: 'error', code: 'ORPHANED_ROLE', message: `Role assignment for "${role.plan_name || role.mapping_id}" has no matching source row — revoke will not clean up this hardware role.` });
    }
  }

  // 4. Recent diagnostic_log errors (last 24h)
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
      display_name:     member.display_name,
      email:            member.email,
      access_status:    member.access_status,
      hardware_user_id: member.hardware_user_id,
      provisioned_at:   member.provisioned_at,
    },
    roles,
    sources,
    findings,
  };
}

/**
 * Fetches the full lifecycle timeline for a member from 4 sources.
 * Returns { member, timeline }.
 * Throws if the member does not exist.
 *
 * @param {string} memberId  member_identity.id (UUID)
 */
async function getTimeline(memberId) {
  const memberResult = await db.query(
    `SELECT mi.*, mas.status AS access_status, mas.provisioned_at, c.name AS client_name,
            lat.webhook_received_at, lat.enqueued_at, lat.kisi_confirmed_at,
            lat.ingest_s, lat.processing_s, lat.total_s
     FROM member_identity mi
     LEFT JOIN member_access_state mas ON mas.member_id = mi.id
     LEFT JOIN clients c ON c.id = mi.client_id
     LEFT JOIN LATERAL (
       SELECT
         wl.received_at                                                     AS webhook_received_at,
         pei.processed_at                                                   AS enqueued_at,
         mra.created_at                                                     AS kisi_confirmed_at,
         ROUND(EXTRACT(EPOCH FROM (pei.processed_at - wl.received_at)))::int  AS ingest_s,
         ROUND(EXTRACT(EPOCH FROM (mra.created_at   - pei.processed_at)))::int AS processing_s,
         ROUND(EXTRACT(EPOCH FROM (mra.created_at   - wl.received_at)))::int   AS total_s
       FROM webhook_log wl
       JOIN processed_event_ids pei ON pei.event_id = wl.event_id
       JOIN member_role_assignments mra ON mra.member_id = mi.id
       WHERE wl.client_id = mi.client_id
         AND wl.normalized_payload->>'platformMemberId' = mi.platform_member_id
         AND wl.hmac_status = 'accepted'
         AND wl.dedup_status = 'new'
         AND mra.created_at > wl.received_at
       ORDER BY wl.received_at DESC
       LIMIT 1
     ) lat ON TRUE
     WHERE mi.id = $1`,
    [memberId]
  );
  if (!memberResult.rows.length) {
    const err = new Error('Member not found');
    err.statusCode = 404;
    throw err;
  }

  const timeline = await db.query(
    `SELECT 'access_log'      AS source,
            mal.id::text,
            mal.event_type,
            mal.error_code     AS detail,
            NULL::text         AS error_code,
            NULL::jsonb        AS context,
            mal.created_at
     FROM member_access_log mal
     WHERE mal.member_id = $1

     UNION ALL

     SELECT 'error_queue'     AS source,
            eq.id::text,
            eq.event_type,
            eq.error_reason    AS detail,
            eq.error_code,
            NULL::jsonb        AS context,
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
            aal.created_at
     FROM adapter_admin_log aal
     WHERE aal.platform_member_id = (
       SELECT platform_member_id FROM member_identity WHERE id = $1
     ) AND aal.client_id = (
       SELECT client_id FROM member_identity WHERE id = $1
     )

     UNION ALL

     SELECT 'diagnostic_log'  AS source,
            dl.id::text,
            dl.error_code      AS event_type,
            dl.message         AS detail,
            dl.error_code,
            dl.context,
            dl.created_at
     FROM diagnostic_log dl
     WHERE dl.context->>'memberId' = (SELECT id::text FROM member_identity WHERE id = $1)
        OR dl.context->>'platformMemberId' = (SELECT platform_member_id FROM member_identity WHERE id = $1)

     UNION ALL

     SELECT 'webhook_log'     AS source,
            wl.id::text,
            wl.event_type,
            wl.dedup_status    AS detail,
            wl.hmac_status     AS error_code,
            wl.normalized_payload AS context,
            wl.received_at     AS created_at
     FROM webhook_log wl
     WHERE wl.client_id = (SELECT client_id FROM member_identity WHERE id = $1)
       AND wl.normalized_payload->>'platformMemberId' = (SELECT platform_member_id FROM member_identity WHERE id = $1)

     ORDER BY created_at DESC
     LIMIT 200`,
    [memberId]
  );

  return {
    member:   memberResult.rows[0],
    timeline: timeline.rows,
  };
}

module.exports = { diagnoseMember, getTimeline };
