/**
 * audit-by-internal-id.js — same sweep but treats the input as member_identity.id
 * (the internal UUID used as `memberId` in logger context), not platform_member_id.
 */

const { Pool } = require('pg');

const ID = process.argv[2] || '7af07f2c-6c9b-4180-9c79-6697e1d673a9';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

function section(title) { console.log(`\n=== ${title} ===`); }

(async () => {
  section(`Auditing member_identity.id = ${ID}`);

  const mi = (await pool.query(
    `SELECT mi.*, c.name AS client_name, c.source_site_id
     FROM member_identity mi
     LEFT JOIN clients c ON c.id = mi.client_id
     WHERE mi.id = $1`, [ID]
  )).rows;

  section(`member_identity — ${mi.length} row(s)`);
  for (const r of mi) console.log(JSON.stringify(r, null, 2));

  if (mi.length === 0) {
    console.log('ID not found as member_identity.id either.');
    await pool.end();
    return;
  }

  const pmid = mi[0].platform_member_id;
  console.log(`\nResolved platform_member_id = ${pmid}`);
  console.log(`Client = ${mi[0].client_name} (${mi[0].client_id})`);

  const tables = [
    ['member_access_state',     'member_id = $1',                'updated_at'],
    ['member_role_assignments', 'member_id = $1',                'created_at'],
    ['member_access_log',       'member_id = $1',                'created_at'],
    ['error_queue',             'member_id = $1',                'created_at'],
  ];
  for (const [t, where, ts] of tables) {
    const rows = (await pool.query(`SELECT * FROM ${t} WHERE ${where} ORDER BY ${ts} ASC`, [ID])).rows;
    section(`${t} — ${rows.length} row(s)`);
    for (const r of rows) console.log(JSON.stringify(r));
  }

  // webhook_log by platform_member_id
  const wh = (await pool.query(
    `SELECT *
     FROM webhook_log
     WHERE raw_payload::text ILIKE '%' || $1 || '%'
     ORDER BY received_at ASC`, [pmid]
  )).rows;
  section(`webhook_log (by platform_member_id) — ${wh.length} row(s)`);
  for (const r of wh) console.log(JSON.stringify(r));

  // adapter_admin_log
  const aal = (await pool.query(
    `SELECT * FROM adapter_admin_log WHERE platform_member_id = $1 ORDER BY created_at ASC`,
    [pmid]
  )).rows;
  section(`adapter_admin_log — ${aal.length} row(s)`);
  for (const r of aal) console.log(JSON.stringify(r));

  // diagnostic_log referencing either internal id or platform_member_id
  const dl = (await pool.query(
    `SELECT id, created_at, service, level, error_code, message, context
     FROM diagnostic_log
     WHERE context->>'memberId' = $1
        OR context->>'memberId' = $2
        OR context->>'platformMemberId' = $2
        OR context::text ILIKE '%' || $1 || '%'
        OR context::text ILIKE '%' || $2 || '%'
     ORDER BY created_at ASC`, [ID, pmid]
  )).rows;
  section(`diagnostic_log — ${dl.length} row(s)`);
  for (const r of dl) console.log(JSON.stringify(r));

  await pool.end();
})().catch(err => { console.error(err); process.exit(1); });
