/**
 * e2e/helpers/db.js
 * Thin pg Pool wrapper for E2E tests.
 * No logger dependency — stdout only so test output stays clean.
 */

const { Pool } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';

const pool = new Pool({
  connectionString: DATABASE_URL,
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
