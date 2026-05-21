/**
 * e2e/helpers/db.js
 * Thin pg Pool wrapper for E2E tests.
 * No logger dependency — stdout only so test output stays clean.
 */

const { Pool } = require('pg');

// Post DR-047 cutover (2026-05-20): live DB is Supabase. Either set DATABASE_URL
// directly or set SUPABASE_DB_PASSWORD and the URL is composed for the AccessSync
// project's session-mode pooler. No hardcoded Railway fallback — tests fail loudly
// if env not configured rather than silently hit a deprecated instance.
const SUPABASE_PROJECT_REF = 'gklgwyrnkedebyulrclv';
function deriveUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const pw = process.env.SUPABASE_DB_PASSWORD;
  if (pw) return `postgresql://postgres.${SUPABASE_PROJECT_REF}:${encodeURIComponent(pw)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`;
  throw new Error('e2e/helpers/db.js: DATABASE_URL or SUPABASE_DB_PASSWORD env var required');
}

const pool = new Pool({
  connectionString: deriveUrl(),
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

async function query(sql, params) {
  return pool.query(sql, params);
}

async function queryOne(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
}

async function queryRows(sql, params) {
  const result = await pool.query(sql, params);
  return result.rows;
}

async function getClient() {
  return pool.connect();
}

async function end() {
  await pool.end();
}

module.exports = { query, queryOne, queryRows, getClient, end, pool };
