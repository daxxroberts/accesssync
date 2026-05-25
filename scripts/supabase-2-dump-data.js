/**
 * ⚠️ ONE-TIME MIGRATION ARTIFACT — historical, executed 2026-05-20.
 *
 * This script references the Railway Postgres URL (gondola.proxy.rlwy.net:27298) which was
 * DECOMMISSIONED on 2026-05-20 per DR-047 (Supabase migration). It ran ONCE during cutover
 * to extract data from Railway into migrations/supabase-data.sql. It is preserved as an
 * audit-trail artifact only — DO NOT RE-RUN.
 *
 * Closed audit reference: OB-180 (migration executed), OB-182 grep sweep (2026-05-24).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * supabase-2-dump-data.js
 * Phase 2B of DR-047 Supabase migration (Path B).
 *
 * Reads every public.* table from Railway, generates parameterized INSERT
 * statements to migrations/supabase-data.sql. Tables are ordered FK-safe
 * (parents before children) via topological sort on pg_constraint.
 *
 * The output file is read by `supabase-3-apply-data.js` (which feeds chunks
 * to the Supabase MCP) OR can be applied directly via psql/Supabase dashboard
 * SQL editor as one big script.
 *
 * Each row becomes one INSERT statement (not bulk VALUES) for simplicity and
 * easy error attribution. With ~50 rows total, this is trivial overhead.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAILWAY_URL = 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';
const OUT_FILE = path.resolve(__dirname, '..', 'migrations', 'supabase-data.sql');

const client = new Client({
  connectionString: RAILWAY_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
});

const QUOTE_ID = (id) => `"${id.replace(/"/g, '""')}"`;
// Escape a literal value for SQL. Handles: null, numbers, booleans, strings, JSON, dates.
function literal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (typeof v === 'object') {
    // JSONB — re-stringify, then quote
    return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  }
  // String
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function listTablesInFkOrder() {
  // Topological sort: tables with no incoming FKs first, then tables whose
  // FKs all point at already-emitted tables.
  const tables = (await client.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `)).rows.map(r => r.table_name);

  const fks = (await client.query(`
    SELECT
      c.relname AS table_name,
      f.relname AS ref_table
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class f ON f.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname = 'public'
  `)).rows;

  // Build dependency map: table → set of tables it references
  const deps = new Map(tables.map(t => [t, new Set()]));
  for (const { table_name, ref_table } of fks) {
    if (table_name !== ref_table) deps.get(table_name).add(ref_table); // self-refs ignored
  }

  // Kahn's algorithm
  const sorted = [];
  const ready = tables.filter(t => deps.get(t).size === 0);
  while (ready.length) {
    const t = ready.shift();
    sorted.push(t);
    for (const [other, otherDeps] of deps.entries()) {
      if (otherDeps.has(t)) {
        otherDeps.delete(t);
        if (otherDeps.size === 0 && !sorted.includes(other) && !ready.includes(other)) {
          ready.push(other);
        }
      }
    }
  }
  // If any tables left (cycles), append them in alphabetical order
  for (const t of tables) if (!sorted.includes(t)) sorted.push(t);
  return sorted;
}

// Tables whose time-series rows are observability, not business state.
// We migrate only the last 48 hours per Builder ruling 2026-05-20 — preserves
// recent debug-window history without bringing 17K trace_context rows over.
// Business tables (members/billing/etc) ignore this and migrate fully.
const TIME_FILTERED_TABLES = {
  trace_context:    'started_at',
  diagnostic_log:   'created_at',
  webhook_log:      'received_at',
  member_access_log:'created_at',
  error_queue:      'created_at',
  reconciliation_run:'started_at',
  activity_event:   'ts',
  config_alert_log: 'created_at',
  adapter_admin_log:'created_at',
  client_activity_summary: 'summary_date',
};
const HOURS_WINDOW = 48;

async function dumpTable(tableName) {
  const colsRes = await client.query(`
    SELECT a.attname AS column_name
    FROM pg_attribute a
    WHERE a.attrelid = ($1::regclass)
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [`public.${tableName}`]);
  const cols = colsRes.rows.map(r => r.column_name);
  const colList = cols.map(QUOTE_ID).join(', ');

  const timeCol = TIME_FILTERED_TABLES[tableName];
  const whereClause = timeCol
    ? `WHERE ${QUOTE_ID(timeCol)} > NOW() - INTERVAL '${HOURS_WINDOW} hours'`
    : '';

  const dataRes = await client.query(`SELECT ${colList} FROM ${QUOTE_ID(tableName)} ${whereClause}`);
  const lines = [];
  lines.push(`-- Table: ${tableName} — ${dataRes.rows.length} row(s)`);
  for (const row of dataRes.rows) {
    const values = cols.map(c => literal(row[c])).join(', ');
    lines.push(`INSERT INTO ${QUOTE_ID(tableName)} (${colList}) VALUES (${values});`);
  }
  lines.push('');
  return { count: dataRes.rows.length, sql: lines.join('\n') };
}

(async () => {
  await client.connect();

  console.log('Computing FK-safe table order...');
  const tables = await listTablesInFkOrder();
  console.log('Order:', tables.join(' → '));

  const out = [
    '-- ============================================================================',
    '-- supabase-data.sql',
    `-- Generated ${new Date().toISOString()} by scripts/supabase-2-dump-data.js`,
    '-- Source: Railway Postgres',
    '-- Target: Supabase AccessSync project',
    '-- Tables ordered FK-safe (parents before children) via topological sort',
    '-- ============================================================================',
    '',
    'BEGIN;',
    '',
  ];
  const counts = {};
  let total = 0;

  for (const t of tables) {
    process.stdout.write(`  → ${t}: `);
    const { count, sql } = await dumpTable(t);
    counts[t] = count;
    total += count;
    out.push(sql);
    console.log(`${count} row(s)`);
  }

  out.push('COMMIT;');
  out.push('');

  await client.end();

  fs.writeFileSync(OUT_FILE, out.join('\n'));
  console.log(`\n✓ Wrote ${OUT_FILE} (${(out.join('\n').length / 1024).toFixed(1)} KB)`);
  console.log(`  Total rows: ${total} across ${tables.length} tables`);
  console.log('  Counts per table:');
  for (const [t, n] of Object.entries(counts)) {
    if (n > 0) console.log(`    ${t.padEnd(30)} ${n}`);
  }
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
