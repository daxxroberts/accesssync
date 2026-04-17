/**
 * audit-member.js
 * Node runner for the per-member DB audit (psql-less Windows fallback).
 * Runs the same query set as scripts/audit-member.sql.
 *
 * Usage:
 *   DATABASE_URL=<public-proxy> node scripts/audit-member.js [platformMemberId]
 */

const { Pool } = require('pg');

const PMID = process.argv[2] || '7af07f2c-6c9b-4180-9c79-6697e1d673a9';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function section(title) { console.log(`\n=== ${title} ===`); }

(async () => {
  section(`Auditing platform_member_id = ${PMID}`);

  const combined = await pool.query(`
    WITH m AS (
      SELECT id, client_id, platform_member_id, source_platform,
             hardware_user_id, hardware_platform, created_at
      FROM member_identity
      WHERE platform_member_id = $1
    )
    SELECT 'member_identity' AS tbl, created_at AS ts, row_to_json(m.*)::text AS data FROM m
    UNION ALL
    SELECT 'member_access_state', updated_at, row_to_json(s.*)::text
      FROM member_access_state s WHERE member_id IN (SELECT id FROM m)
    UNION ALL
    SELECT 'member_role_assignments', created_at, row_to_json(r.*)::text
      FROM member_role_assignments r WHERE member_id IN (SELECT id FROM m)
    UNION ALL
    SELECT 'member_access_log', created_at, row_to_json(l.*)::text
      FROM member_access_log l WHERE member_id IN (SELECT id FROM m)
    UNION ALL
    SELECT 'error_queue', created_at, row_to_json(e.*)::text
      FROM error_queue e WHERE member_id IN (SELECT id FROM m)
    UNION ALL
    SELECT 'adapter_admin_log', created_at, row_to_json(a.*)::text
      FROM adapter_admin_log a WHERE platform_member_id = $1
    UNION ALL
    SELECT 'webhook_log', received_at, row_to_json(w.*)::text
      FROM webhook_log w WHERE raw_payload::text ILIKE '%' || $1 || '%'
    UNION ALL
    SELECT 'diagnostic_log', created_at, row_to_json(d.*)::text
      FROM diagnostic_log d
      WHERE context->>'memberId'         = $1
         OR context->>'platformMemberId' = $1
         OR context::text ILIKE '%' || $1 || '%'
    ORDER BY ts ASC NULLS LAST
  `, [PMID]);

  const byTable = {};
  for (const row of combined.rows) {
    byTable[row.tbl] = byTable[row.tbl] || [];
    byTable[row.tbl].push(row);
  }

  const order = [
    'webhook_log',
    'member_identity',
    'member_access_state',
    'member_role_assignments',
    'member_access_log',
    'error_queue',
    'adapter_admin_log',
    'diagnostic_log',
  ];

  for (const tbl of order) {
    const rows = byTable[tbl] || [];
    section(`${tbl} — ${rows.length} row(s)`);
    for (const r of rows) {
      console.log(`[${r.ts ? new Date(r.ts).toISOString() : 'null'}] ${r.data}`);
    }
  }

  // member_access_sources probe
  const tblExists = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'member_access_sources'`
  );
  section('member_access_sources');
  if (tblExists.rowCount === 0) {
    console.log('(table does not exist — OB-46 pending)');
  } else {
    const rows = (await pool.query(
      `SELECT * FROM member_access_sources
        WHERE member_id IN (SELECT id FROM member_identity WHERE platform_member_id = $1)
        ORDER BY created_at ASC`,
      [PMID]
    )).rows;
    console.log(`rows: ${rows.length}`);
    for (const r of rows) console.log(JSON.stringify(r));
  }

  // Processed-event-ids for this member's client (indirect evidence — dedup happened)
  section('processed_event_ids (last 10 for involved clients)');
  const ident = byTable['member_identity']?.[0];
  if (ident) {
    const clientId = JSON.parse(ident.data).client_id;
    const proc = await pool.query(
      `SELECT event_id, processed_at FROM processed_event_ids
        WHERE client_id = $1 ORDER BY processed_at DESC LIMIT 10`,
      [clientId]
    );
    console.log(`client ${clientId}: ${proc.rowCount} recent events`);
    for (const r of proc.rows) console.log(`  ${r.processed_at.toISOString()} ${r.event_id}`);
  } else {
    console.log('(member_identity absent — cannot resolve client_id for processed_event_ids lookup)');
  }

  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
