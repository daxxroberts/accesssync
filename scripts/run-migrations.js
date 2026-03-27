/**
 * scripts/run-migrations.js
 * AccessSync Migration Runner
 *
 * Responsibilities:
 * - Reads SQL migration files from the migrations/ directory in filename order
 * - Executes each file against the DATABASE_URL Postgres instance
 * - Wraps each migration in a transaction — rolls back on failure
 * - Tracks applied migrations in a migration_log table to prevent re-runs
 * - Exits with code 0 on success, 1 on failure (Railway deploy hook compatible)
 *
 * Usage:
 *   npm run migrate
 *   node scripts/run-migrations.js
 *
 * Environment:
 *   DATABASE_URL  — Required. PostgreSQL connection string.
 *   NODE_ENV      — Optional. Enables SSL for production.
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// --- Startup Validation ---

if (!process.env.DATABASE_URL) {
  console.error('[Migrate] FATAL: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

// --- Pool (single-use — closed after migrations complete) ---

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 1,
  connectionTimeoutMillis: 10000,
});

// --- Migration Log Table ---

const ENSURE_MIGRATION_LOG = `
  CREATE TABLE IF NOT EXISTS migration_log (
    id SERIAL PRIMARY KEY,
    filename VARCHAR(255) NOT NULL UNIQUE,
    applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  );
`;

// --- Helpers ---

/**
 * Returns sorted list of .sql files from the migrations/ directory.
 * Sorted alphabetically so numbered files (001-, 002-) run in order.
 */
function getMigrationFiles() {
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');

  if (!fs.existsSync(migrationsDir)) {
    console.warn('[Migrate] No migrations/ directory found. Nothing to run.');
    return [];
  }

  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Returns the set of filenames already recorded in migration_log.
 */
async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM migration_log');
  return new Set(result.rows.map((r) => r.filename));
}

/**
 * Executes a single SQL migration file inside a transaction.
 * Records the filename in migration_log on success.
 */
async function runMigration(client, filename, sql) {
  console.log(`[Migrate] Applying: ${filename}`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO migration_log (filename) VALUES ($1)',
      [filename]
    );
    await client.query('COMMIT');
    console.log(`[Migrate] ✓ Applied: ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[Migrate] ✗ Failed: ${filename}`);
    console.error(`[Migrate] Error: ${err.message}`);
    throw err;
  }
}

// --- Main ---

async function main() {
  const client = await pool.connect();

  try {
    // Ensure the migration tracking table exists
    await client.query(ENSURE_MIGRATION_LOG);

    const files = getMigrationFiles();

    if (files.length === 0) {
      console.log('[Migrate] No migration files found. Done.');
      return;
    }

    const applied = await getAppliedMigrations(client);
    const pending = files.filter((f) => !applied.has(f));

    if (pending.length === 0) {
      console.log('[Migrate] All migrations already applied. Nothing to do.');
      return;
    }

    console.log(`[Migrate] Found ${pending.length} pending migration(s).`);

    const migrationsDir = path.resolve(__dirname, '..', 'migrations');

    for (const filename of pending) {
      const filePath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filePath, 'utf8');
      await runMigration(client, filename, sql);
    }

    console.log('[Migrate] All migrations applied successfully.');

  } catch (err) {
    console.error('[Migrate] Migration run failed. Exiting with error.');
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
