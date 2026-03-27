/**
 * db.js
 * AccessSync Database Layer
 *
 * Responsibilities:
 * - Initializes a single pg connection pool for the entire application
 * - Exports a query() helper used by all core modules
 * - Validates DATABASE_URL on startup — fails fast rather than silently
 * - Logs pool errors without crashing the process
 *
 * Usage in any module:
 *   const db = require('../db');
 *   const result = await db.query('SELECT * FROM clients WHERE id = $1', [clientId]);
 */

require('dotenv').config();
const { Pool } = require('pg');

// --- Startup Validation ---

if (!process.env.DATABASE_URL) {
  console.error('[DB] FATAL: DATABASE_URL environment variable is not set.');
  console.error('[DB] Set DATABASE_URL in your .env file (local) or Railway environment (production).');
  process.exit(1);
}

// --- Connection Pool ---

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  // Connection pool sizing
  max: 10,               // Maximum concurrent connections
  idleTimeoutMillis: 30000,   // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if no connection available within 5s
});

// Log pool-level errors (e.g. dropped connection, Postgres restart)
// These are non-fatal — the pool will reconnect automatically
pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

// --- Query Helper ---

/**
 * Execute a parameterized SQL query.
 *
 * @param {string} text    - SQL string with $1, $2... placeholders
 * @param {Array}  params  - Parameter values in order
 * @returns {Promise<pg.QueryResult>}
 *
 * @example
 * const result = await db.query(
 *   'SELECT * FROM member_identity WHERE wix_member_id = $1 AND client_id = $2',
 *   [wixMemberId, clientId]
 * );
 * const row = result.rows[0];
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    // Log slow queries in production (> 500ms) for observability
    if (process.env.NODE_ENV === 'production' && duration > 500) {
      console.warn(`[DB] Slow query (${duration}ms):`, text);
    }
    return result;
  } catch (err) {
    console.error('[DB] Query error:', {
      query: text,
      params,
      error: err.message,
      code: err.code,
    });
    throw err; // Re-throw so calling module can handle or route to retry engine
  }
}

/**
 * Acquire a client from the pool for multi-statement transactions.
 *
 * Always release the client in a finally block:
 *
 * @example
 * const client = await db.getClient();
 * try {
 *   await client.query('BEGIN');
 *   await client.query('UPDATE ...', [...]);
 *   await client.query('INSERT ...', [...]);
 *   await client.query('COMMIT');
 * } catch (err) {
 *   await client.query('ROLLBACK');
 *   throw err;
 * } finally {
 *   client.release();
 * }
 */
async function getClient() {
  return pool.connect();
}

// --- Health Check ---

/**
 * Lightweight connectivity check used by the /health route and Railway.
 * Returns true if the database is reachable, false otherwise.
 */
async function healthCheck() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[DB] Health check failed:', err.message);
    return false;
  }
}

module.exports = { query, getClient, healthCheck, pool };
