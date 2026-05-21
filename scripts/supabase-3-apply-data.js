/**
 * supabase-3-apply-data.js
 * Phase 2B step 2 of DR-047 Supabase migration (Path B).
 *
 * Reads migrations/supabase-data.sql and applies it to Supabase Direct URL
 * via pg.Client in one transaction. Verifies row counts post-insert and
 * compares against expected counts.
 *
 * Run via:
 *   SUPABASE_DB_PASSWORD=xxx node scripts/supabase-3-apply-data.js
 *
 * Password never logged; never written to disk; consumed once.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const PROJECT_REF = 'gklgwyrnkedebyulrclv';
const PASSWORD = process.env.SUPABASE_DB_PASSWORD;
if (!PASSWORD) {
  console.error('FATAL: SUPABASE_DB_PASSWORD env var not set');
  process.exit(1);
}

// Supabase Direct connection (port 5432 direct, NOT pooler 6543 transaction mode)
// Needed because we run DDL-adjacent multi-statement transactions.
const SUPABASE_URL = `postgresql://postgres:${encodeURIComponent(PASSWORD)}@db.${PROJECT_REF}.supabase.co:5432/postgres`;

const DATA_FILE = path.resolve(__dirname, '..', 'migrations', 'supabase-data.sql');

const expectedCounts = {
  activity_event: 0,           // empty in 48h window
  adapter_admin_log: 0,
  as_client_subscriptions: 0,
  as_subscription_terms: 0,
  billing_subscriptions: 55,
  client_activity_summary: 0,
  clients: 2,                  // already applied — will hit conflict
  config_alert_log: 0,
  connector_subscriptions: 2,  // already applied
  diagnostic_log: 34,
  error_queue: 0,
  locations: 2,                // already applied
  member_access: 3,
  member_access_log: 0,
  member_access_sources: 7,
  member_billing: 5,
  member_master: 3,            // already applied
  plan_mapping_groups: 14,
  plan_mappings: 13,
  processed_event_ids: 2,      // already applied
  reconciliation_run: 8,       // already applied
  trace_context: 3628,
  webhook_log: 0,
};

(async () => {
  const client = new Client({
    connectionString: SUPABASE_URL,
    ssl: { rejectUnauthorized: false },
    keepAlive: true,
  });

  console.log('Connecting to Supabase Direct...');
  await client.connect();
  console.log('Connected. Reading data file...');

  const sql = fs.readFileSync(DATA_FILE, 'utf8');
  console.log(`Data file size: ${(sql.length / 1024).toFixed(1)} KB`);

  // Some tables already have data from MCP applies earlier this session.
  // Strategy: wrap entire load in a transaction with ON CONFLICT DO NOTHING
  // semantics via a savepoint per statement. Easier: try each INSERT, ignore 23505 (unique violation).
  // Since INSERT doesn't have ON CONFLICT DO NOTHING without specifying the conflict target,
  // we run each statement and catch duplicate-key errors.

  // Split into statements (each ends in ;\n based on dumper output)
  const statements = sql.split(/;\r?\n/).map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--') && s.toUpperCase() !== 'BEGIN' && s.toUpperCase() !== 'COMMIT');
  console.log(`Statements to apply: ${statements.length}`);

  let inserted = 0;
  let skipped_dup = 0;
  let errors = 0;
  const errorSamples = [];

  await client.query('BEGIN');
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i] + ';';
    try {
      await client.query('SAVEPOINT sp');
      await client.query(stmt);
      await client.query('RELEASE SAVEPOINT sp');
      inserted++;
    } catch (err) {
      await client.query('ROLLBACK TO SAVEPOINT sp');
      if (err.code === '23505') {
        skipped_dup++;
      } else {
        errors++;
        if (errorSamples.length < 5) {
          errorSamples.push({ code: err.code, message: err.message, stmtPreview: stmt.slice(0, 200) });
        }
      }
    }
    if ((i + 1) % 500 === 0) {
      process.stdout.write(`  ${i + 1}/${statements.length}\n`);
    }
  }
  await client.query('COMMIT');
  console.log(`\nApply complete. inserted=${inserted}  skipped_dup=${skipped_dup}  errors=${errors}`);
  if (errorSamples.length) {
    console.log('\nError samples:');
    for (const e of errorSamples) console.log('  ', e.code, e.message, '\n     stmt:', e.stmtPreview);
  }

  console.log('\nVerifying row counts...');
  const verifyResults = [];
  for (const [table, expected] of Object.entries(expectedCounts)) {
    const r = await client.query(`SELECT COUNT(*)::int AS cnt FROM ${client.escapeIdentifier ? client.escapeIdentifier(table) : '"' + table + '"'}`);
    const actual = r.rows[0].cnt;
    const ok = actual === expected;
    verifyResults.push({ table, expected, actual, ok });
  }
  console.table(verifyResults);
  const allOk = verifyResults.every(r => r.ok);
  console.log(allOk ? '\n✓ ALL ROW COUNTS MATCH' : '\n✗ ROW COUNT MISMATCH — investigate above');

  await client.end();
  process.exit(allOk ? 0 : 2);
})().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
