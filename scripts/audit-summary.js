/**
 * audit-summary.js — human-readable timeline summary for memberId 7af07f2c.
 * Pulls webhook_log + diagnostic_log + state rows and prints one line each.
 */

const { Pool } = require('pg');
const INTERNAL_ID = '7af07f2c-6c9b-4180-9c79-6697e1d673a9';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const mi = (await pool.query('SELECT * FROM member_identity WHERE id=$1', [INTERNAL_ID])).rows[0];
  if (!mi) { console.log('member_identity not found'); process.exit(0); }
  const PMID = mi.platform_member_id;
  console.log(`member_identity: id=${INTERNAL_ID} platform_member_id=${PMID} client=${mi.client_id} hardware_user_id=${mi.hardware_user_id} created=${mi.created_at.toISOString()} updated=${mi.updated_at.toISOString()}`);

  const state = (await pool.query('SELECT * FROM member_access_state WHERE member_id=$1', [INTERNAL_ID])).rows[0];
  if (state) console.log(`member_access_state: status=${state.status} provisioned_at=${state.provisioned_at} updated_at=${state.updated_at.toISOString()}`);

  console.log('\n--- webhook_log (by platform_member_id) ---');
  const wh = (await pool.query(
    `SELECT received_at, event_type,
            raw_payload->'data'->'entity'->>'status' AS entity_status,
            raw_payload->'data'->'entity'->>'statusNew' AS entity_status_new,
            hmac_status, dedup_status, event_id, client_id
       FROM webhook_log
      WHERE raw_payload::text ILIKE '%' || $1 || '%'
      ORDER BY received_at ASC`, [PMID])).rows;
  for (const r of wh) {
    console.log(`  ${r.received_at.toISOString()} ${r.event_type.padEnd(40)} status=${r.entity_status || '-'} new=${r.entity_status_new || '-'} hmac=${r.hmac_status} dedup=${r.dedup_status} event_id=${r.event_id} client=${r.client_id || '(null)'}`);
  }

  console.log('\n--- diagnostic_log (by memberId internal OR platform) ---');
  const dl = (await pool.query(
    `SELECT created_at, service, level, error_code, message, context
       FROM diagnostic_log
      WHERE context->>'memberId' IN ($1, $2)
         OR context::text ILIKE '%' || $1 || '%'
         OR context::text ILIKE '%' || $2 || '%'
      ORDER BY created_at ASC`, [INTERNAL_ID, PMID])).rows;
  for (const r of dl) {
    const ctx = r.context || {};
    console.log(`  ${r.created_at.toISOString()} [${r.level}] ${r.service.padEnd(22)} ${r.error_code.padEnd(30)} — ${r.message}`);
    if (ctx.httpStatus) console.log(`      httpStatus=${ctx.httpStatus} resolution=${ctx.resolution} attempt=${ctx.attempt || '-'} jobName=${ctx.jobName || '-'}`);
  }

  console.log('\n--- error_queue (any client-level entry by memberId or planId) ---');
  const eq = (await pool.query(
    `SELECT created_at, status, error_code, resolution
       FROM error_queue
      WHERE member_id = $1 OR client_id = $2
      ORDER BY created_at DESC LIMIT 10`, [INTERNAL_ID, mi.client_id])).rows;
  for (const r of eq) {
    console.log(`  ${r.created_at.toISOString()} status=${r.status} code=${r.error_code} resolution=${r.resolution}`);
  }

  console.log('\n--- member_role_assignments + member_access_log ---');
  const ra = (await pool.query('SELECT * FROM member_role_assignments WHERE member_id=$1', [INTERNAL_ID])).rows;
  console.log(`  member_role_assignments: ${ra.length} row(s)`);
  for (const r of ra) console.log(`    group=${r.hardware_group_id} role_assignment_id=${r.role_assignment_id} created=${r.created_at.toISOString()}`);
  const al = (await pool.query('SELECT * FROM member_access_log WHERE member_id=$1', [INTERNAL_ID])).rows;
  console.log(`  member_access_log: ${al.length} row(s)`);
  for (const r of al) console.log(`    ${r.created_at.toISOString()} ${r.event_type} ${r.error_code || ''}`);

  console.log('\n--- plan_mappings for HOG ---');
  const pm = (await pool.query(
    `SELECT source_plan_id, plan_name, hardware_group_id, door_name, status
       FROM plan_mappings WHERE client_id=$1 ORDER BY created_at ASC`, [mi.client_id])).rows;
  for (const r of pm) console.log(`  plan=${r.plan_name || '-'} source_plan_id=${r.source_plan_id} group=${r.hardware_group_id || '-'} door=${r.door_name || '(group-only)'} status=${r.status}`);

  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
