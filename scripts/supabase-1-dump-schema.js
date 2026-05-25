/**
 * ⚠️ ONE-TIME MIGRATION ARTIFACT — historical, executed 2026-05-20.
 *
 * This script references the Railway Postgres URL (gondola.proxy.rlwy.net:27298) which was
 * DECOMMISSIONED on 2026-05-20 per DR-047 (Supabase migration). It ran ONCE during cutover
 * to extract the schema from Railway and write it to migrations/supabase-bootstrap.sql.
 * It is preserved as an audit-trail artifact only — DO NOT RE-RUN.
 *
 * Closed audit reference: OB-180 (migration executed), OB-182 grep sweep (2026-05-24).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * supabase-1-dump-schema.js
 * Phase 1.1B of DR-047 Supabase migration (Path B — Node, no libpq).
 *
 * Reads Railway pg_catalog + information_schema, emits DDL to
 *   migrations/supabase-bootstrap.sql
 *
 * Output is ordered: extensions → tables (FK-aware topological sort) →
 * primary-key constraints → unique constraints → indexes → foreign-key
 * constraints (last, so they don't block table creation order) →
 * check constraints → views.
 *
 * NOT a pg_dump replacement. Handles AccessSync's vanilla schema only:
 *   - standard column types (uuid, text, jsonb, timestamptz, int, bool, varchar, numeric)
 *   - DEFAULT expressions (incl. uuid_generate_v4(), NOW(), literals)
 *   - PRIMARY KEY, UNIQUE, FOREIGN KEY (incl. ON DELETE), CHECK constraints
 *   - non-unique indexes
 *   - views (incl. v_trace_timeline)
 *   - uuid-ossp extension
 *
 * Does NOT handle: triggers, functions, sequences (other than serial-implicit),
 * domain types, custom types, RULES, partitioned tables, materialized views,
 * tablespaces. We don't use any of those.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const RAILWAY_URL = 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';
const OUT_FILE = path.resolve(__dirname, '..', 'migrations', 'supabase-bootstrap.sql');

const client = new Client({
  connectionString: RAILWAY_URL,
  ssl: { rejectUnauthorized: false },
  keepAlive: true,
});

const QUOTE = (id) => `"${id.replace(/"/g, '""')}"`;

const sections = {
  header:      [],
  extensions:  [],
  tables:      [],
  pkeys:       [],
  uniques:     [],
  indexes:     [],
  fkeys:       [],
  checks:      [],
  views:       [],
};

function section(name, line) { sections[name].push(line); }

async function dumpExtensions() {
  // Only emit non-built-in extensions. plpgsql is everywhere; skip it.
  const r = await client.query(`
    SELECT extname FROM pg_extension
    WHERE extname NOT IN ('plpgsql')
    ORDER BY extname
  `);
  for (const row of r.rows) {
    section('extensions', `CREATE EXTENSION IF NOT EXISTS ${QUOTE(row.extname)};`);
  }
}

async function listTables() {
  const r = await client.query(`
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  return r.rows.map(r => r.table_name);
}

async function dumpTable(tableName) {
  // Columns
  const colsRes = await client.query(`
    SELECT a.attname AS column_name,
           pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           pg_get_expr(d.adbin, d.adrelid) AS default_expr,
           a.attnum AS pos
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ($1::regclass)
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY a.attnum
  `, [`public.${tableName}`]);

  const colLines = colsRes.rows.map(c => {
    const parts = [`  ${QUOTE(c.column_name)} ${c.data_type}`];
    if (c.default_expr) parts.push(`DEFAULT ${c.default_expr}`);
    if (c.not_null)     parts.push('NOT NULL');
    return parts.join(' ');
  });

  section('tables', `\nCREATE TABLE ${QUOTE(tableName)} (\n${colLines.join(',\n')}\n);`);
}

async function dumpConstraints(tableName) {
  // PKs, UNIQUE, FK, CHECK — emit as ALTER TABLE statements so we control ordering.
  const r = await client.query(`
    SELECT con.conname AS name,
           con.contype AS type,
           pg_get_constraintdef(con.oid, true) AS def
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = $1
    ORDER BY con.contype, con.conname
  `, [tableName]);

  for (const row of r.rows) {
    const stmt = `ALTER TABLE ${QUOTE(tableName)} ADD CONSTRAINT ${QUOTE(row.name)} ${row.def};`;
    if (row.type === 'p')      section('pkeys', stmt);
    else if (row.type === 'u') section('uniques', stmt);
    else if (row.type === 'f') section('fkeys', stmt);
    else if (row.type === 'c') section('checks', stmt);
    // Note: 'x' (exclusion) we don't use; skip silently.
  }
}

async function dumpIndexes(tableName) {
  // pg_indexes gives us the original CREATE INDEX statement.
  // Skip indexes that back constraints (PK / UNIQUE) — those are created by
  // the ALTER TABLE ... ADD CONSTRAINT above. We detect by checking
  // pg_index.indisunique + pg_constraint linkage.
  const r = await client.query(`
    SELECT i.indexname, i.indexdef
    FROM pg_indexes i
    LEFT JOIN pg_constraint con
      ON con.conname = i.indexname
     AND con.contype IN ('p','u')
    WHERE i.schemaname = 'public'
      AND i.tablename = $1
      AND con.conname IS NULL
    ORDER BY i.indexname
  `, [tableName]);

  for (const row of r.rows) {
    section('indexes', `${row.indexdef};`);
  }
}

async function dumpViews() {
  const r = await client.query(`
    SELECT viewname, definition
    FROM pg_views
    WHERE schemaname = 'public'
    ORDER BY viewname
  `);
  for (const row of r.rows) {
    section('views', `\nCREATE VIEW ${QUOTE(row.viewname)} AS\n${row.definition.trim()}`);
  }
}

(async () => {
  await client.connect();

  section('header', '-- ============================================================================');
  section('header', '-- supabase-bootstrap.sql');
  section('header', '-- Generated by scripts/supabase-1-dump-schema.js');
  section('header', `-- Source: Railway Postgres (gondola.proxy.rlwy.net:27298) ${new Date().toISOString()}`);
  section('header', '-- Target: Supabase Free tier project AccessSync (us-west-1)');
  section('header', '-- Path B (Node pg + Supabase MCP) per DR-047 / OB-180');
  section('header', '-- ============================================================================');
  section('header', '');

  console.log('Reading extensions...');
  await dumpExtensions();

  console.log('Reading tables...');
  const tables = await listTables();
  console.log(`Found ${tables.length} tables:`, tables);

  for (const t of tables) {
    console.log(`  → ${t}`);
    await dumpTable(t);
    await dumpConstraints(t);
    await dumpIndexes(t);
  }

  console.log('Reading views...');
  await dumpViews();

  await client.end();

  // Compose final file in dependency-safe order:
  //   header → extensions → tables → pkeys → uniques → checks →
  //   indexes (separate so they don't block table creation order) →
  //   fkeys (last so all referenced tables exist) → views
  const out = [
    ...sections.header,
    '-- --- Extensions ---',
    ...sections.extensions,
    '',
    '-- --- Tables ---',
    ...sections.tables,
    '',
    '-- --- Primary keys ---',
    ...sections.pkeys,
    '',
    '-- --- Unique constraints ---',
    ...sections.uniques,
    '',
    '-- --- Check constraints ---',
    ...sections.checks,
    '',
    '-- --- Indexes ---',
    ...sections.indexes,
    '',
    '-- --- Foreign keys (last so all referenced tables exist) ---',
    ...sections.fkeys,
    '',
    '-- --- Views ---',
    ...sections.views,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, out);
  console.log(`\n✓ Wrote ${OUT_FILE} (${out.length.toLocaleString()} bytes)`);
  console.log(`  extensions: ${sections.extensions.length}`);
  console.log(`  tables:     ${tables.length}`);
  console.log(`  pkeys:      ${sections.pkeys.length}`);
  console.log(`  uniques:    ${sections.uniques.length}`);
  console.log(`  fkeys:      ${sections.fkeys.length}`);
  console.log(`  checks:     ${sections.checks.length}`);
  console.log(`  indexes:    ${sections.indexes.length}`);
  console.log(`  views:      ${sections.views.length}`);
})().catch(e => {
  console.error('FATAL:', e.message);
  console.error(e.stack);
  process.exit(1);
});
