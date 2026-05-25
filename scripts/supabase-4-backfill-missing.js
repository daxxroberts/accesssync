/**
 * ⚠️ ONE-TIME MIGRATION ARTIFACT — historical, executed 2026-05-20.
 *
 * This script references the Railway Postgres URL (gondola.proxy.rlwy.net:27298) which was
 * DECOMMISSIONED on 2026-05-20 per DR-047 (Supabase migration). It ran ONCE during cutover
 * to backfill rows that the statement-split brittleness (RULE-17 trigger) missed in the
 * primary data dump. It is preserved as an audit-trail artifact only — DO NOT RE-RUN.
 *
 * Closed audit reference: OB-180 (migration executed), OB-182 grep sweep (2026-05-24).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * supabase-4-backfill-missing.js
 * Phase 2B fix-up: find rows present in Railway but missing in Supabase,
 * generate targeted INSERTs, apply them.
 *
 * Strategy: for each table reporting a row-count mismatch, fetch all IDs
 * from both sides, diff, then SELECT * for the missing IDs from Railway
 * and INSERT into Supabase one row at a time (parents before children).
 */

'use strict';

const { Client } = require('pg');

const RAILWAY = 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';
const PASSWORD = process.env.SUPABASE_DB_PASSWORD;
if (!PASSWORD) { console.error('SUPABASE_DB_PASSWORD missing'); process.exit(1); }
const SUPABASE = `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.gklgwyrnkedebyulrclv.supabase.co:5432/postgres`;

// Tables with PKs we can diff by + the same 48h time filter (matches Phase 2 dumper).
const TIME_FILTERED = {
  diagnostic_log:'created_at', trace_context:'started_at',
};

// Order matters — parents before children
const TABLES_FK_ORDER = [
  { name: 'plan_mappings', pk: 'id' },
  { name: 'billing_subscriptions', pk: 'id' },
  { name: 'plan_mapping_groups', pk: 'id' },
  { name: 'member_access', pk: 'id' },
  { name: 'member_billing', pk: 'id' },
  { name: 'member_access_sources', pk: 'id' },
  { name: 'diagnostic_log', pk: 'id' },
  { name: 'trace_context', pk: 'trace_id' },
];

const QUOTE_ID = (id) => `"${id.replace(/"/g, '""')}"`;
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function getColumns(c, table) {
  const r = await c.query(`SELECT a.attname FROM pg_attribute a WHERE a.attrelid = ($1::regclass) AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [`public.${table}`]);
  return r.rows.map(r => r.attname);
}

(async () => {
  const rw = new Client({ connectionString: RAILWAY, ssl: { rejectUnauthorized: false }, keepAlive: true });
  const sb = new Client({ connectionString: SUPABASE, ssl: { rejectUnauthorized: false }, keepAlive: true });
  await Promise.all([rw.connect(), sb.connect()]);
  console.log('Connected to Railway + Supabase.');

  let totalInserted = 0;
  let totalErrors = 0;

  for (const { name: table, pk } of TABLES_FK_ORDER) {
    const timeCol = TIME_FILTERED[table];
    const whereClause = timeCol ? `WHERE ${QUOTE_ID(timeCol)} > NOW() - INTERVAL '48 hours'` : '';

    const rwIds = (await rw.query(`SELECT ${QUOTE_ID(pk)} FROM ${QUOTE_ID(table)} ${whereClause}`)).rows.map(r => r[pk]);
    const sbIds = (await sb.query(`SELECT ${QUOTE_ID(pk)} FROM ${QUOTE_ID(table)}`)).rows.map(r => r[pk]);
    const sbSet = new Set(sbIds.map(String));
    const missing = rwIds.filter(id => !sbSet.has(String(id)));

    if (missing.length === 0) { console.log(`  ${table}: in sync (${rwIds.length} = ${sbIds.length})`); continue; }
    console.log(`  ${table}: missing ${missing.length} of ${rwIds.length} on Supabase. Backfilling...`);

    const cols = await getColumns(rw, table);
    const colList = cols.map(QUOTE_ID).join(', ');

    for (const id of missing) {
      const rowRes = await rw.query(`SELECT ${colList} FROM ${QUOTE_ID(table)} WHERE ${QUOTE_ID(pk)} = $1`, [id]);
      if (rowRes.rows.length === 0) { console.log(`    skip ${id} (no longer exists in Railway)`); continue; }
      const row = rowRes.rows[0];
      const values = cols.map(c => literal(row[c])).join(', ');
      const sql = `INSERT INTO ${QUOTE_ID(table)} (${colList}) VALUES (${values})`;
      try {
        await sb.query(sql);
        totalInserted++;
      } catch (err) {
        totalErrors++;
        console.log(`    ERR ${table} ${id}: ${err.code} ${err.message.slice(0, 120)}`);
      }
    }
  }

  console.log(`\nBackfill done. inserted=${totalInserted}  errors=${totalErrors}`);

  console.log('\nFinal verification...');
  const expected = { billing_subscriptions:55, diagnostic_log:34, member_access:3, member_access_sources:7, member_billing:5, plan_mapping_groups:14, trace_context:3628, plan_mappings:13 };
  let allOk = true;
  for (const [t, e] of Object.entries(expected)) {
    const r = await sb.query(`SELECT COUNT(*)::int AS cnt FROM ${QUOTE_ID(t)}`);
    const a = r.rows[0].cnt;
    const ok = a === e;
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✓' : '✗'} ${t}: expected=${e} actual=${a}`);
  }

  await Promise.all([rw.end(), sb.end()]);
  process.exit(allOk ? 0 : 2);
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
