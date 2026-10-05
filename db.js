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

// Lazy-require logger to avoid circular dependency (logger requires db)
let _log = null;
function getLog() {
  if (!_log) _log = require('./core/logger').log;
  return _log;
}

// --- Startup Validation ---

if (!process.env.DATABASE_URL) {
  throw new Error(
    '[DB] FATAL: DATABASE_URL environment variable is not set. ' +
    'Set DATABASE_URL in your .env file (local) or Railway environment (production).'
  );
}

// --- Connection Pool ---

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway Postgres requires SSL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  // Connection pool sizing
  // Supabase's session-mode pooler allows only ~15 clients IN TOTAL across every process (Core Engine, Admin Hub and the
  // cron jobs each open their own pool). DB_POOL_MAX lets a service be sized down without a code change.
  max: Number.parseInt(process.env.DB_POOL_MAX, 10) > 0 ? Number.parseInt(process.env.DB_POOL_MAX, 10) : 10,
  // Hand an idle connection back after 5s (was 30s). In Supabase session mode every open connection holds one of
  // the pooler's ~15 slots even while it does nothing; on 2026-10-05 ten slots sat reserved by idle connections at a
  // quiet moment, so a small burst filled the rest. Reconnecting costs a few ms; a full pooler fails the query.
  idleTimeoutMillis: 5000,
  connectionTimeoutMillis: 5000, // Fail fast if no connection available within 5s
});

// Log pool-level errors (e.g. dropped connection, Postgres restart)
// These are non-fatal — the pool will reconnect automatically
pool.on('error', (err) => {
  getLog().error('db.pool_error', {}, err);
});

// --- Pool exhaustion ---

// Supabase answers a NEW connection with "(EMAXCONNSESSION) max clients reached in session mode" when its pooler is full.
// That is refused while connecting — the statement never ran — so trying again a moment later is always safe, and a
// batch of simultaneous jobs (e.g. a family's sub-members queued at once) clears itself within a second or two.
const POOL_RETRY_DELAYS_MS = [150, 400, 900];
function isPoolExhausted(err) {
  const msg = err && err.message ? String(err.message) : '';
  return /EMAXCONNSESSION|max clients reached/i.test(msg);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Runs fn(); on pool exhaustion waits (with jitter) and tries again. Any other error is thrown at once. */
async function withPoolRetry(label, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      if (attempt > 0 && label !== 'diagnostic_log') {
        getLog().warn('db.pool_exhausted_recovered', { attempts: attempt + 1 });
      }
      return result;
    } catch (err) {
      if (!isPoolExhausted(err) || attempt >= POOL_RETRY_DELAYS_MS.length) throw err;
      await sleep(POOL_RETRY_DELAYS_MS[attempt] + Math.floor(Math.random() * 100));
    }
  }
}

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
    const result = await withPoolRetry(/INSERT INTO diagnostic_log/i.test(text) ? 'diagnostic_log' : 'query', () => pool.query(text, params));
    const duration = Date.now() - start;
    // Log slow queries in production (> 500ms) for observability
    if (process.env.NODE_ENV === 'production' && duration > 500) {
      getLog().warn('db.slow_query', { duration, query: text });
    }
    return result;
  } catch (err) {
    // Avoid recursion: a failing INSERT into diagnostic_log must not trigger
    // another log.error() call, which would try to INSERT into diagnostic_log
    // again. The logger has its own internal stdout fallback for this case.
    if (!/INSERT INTO diagnostic_log/i.test(text)) {
      getLog().error('db.query_error', { query: text, params, code: err.code }, err);
    }
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
  return withPoolRetry('client', () => pool.connect());   // nothing has run on the connection yet, so retrying is safe
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
    getLog().error('db.health_check_failed', {}, err);
    return false;
  }
}

module.exports = { query, getClient, healthCheck, pool, isPoolExhausted };
