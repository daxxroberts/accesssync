/**
 * pglite-db.js — a drop-in stand-in for ../../db.js backed by a REAL Postgres engine.
 *
 * Why: the unit tests mock db.query with scripted answers, so a wrong WHERE clause can
 * never fail them (2026-10-19 review). These tests swap the module for this one and the
 * app's own SQL runs against PostgreSQL 18 (PGlite: the Postgres server compiled to
 * WebAssembly, in-process, throwaway, no network). The schema is the production snapshot
 * in test/integration-db/schema.sql. Nothing here can reach Supabase.
 *
 * Usage (in a test file):
 *   jest.mock('../../db', () => require('../helpers/real-db/pglite-db'));
 *   const realDb = require('../helpers/real-db/pglite-db');
 *   beforeAll(() => realDb.reset(), 60000);   // first call boots the engine — give it room
 *   beforeEach(() => realDb.reset());
 *   afterAll(() => realDb.close());
 *
 * Same surface as db.js: query(text, params), getClient(), healthCheck(), pool, isPoolExhausted.
 * One engine, one session (it runs in a worker thread — see pglite-worker.js): a getClient()
 * "connection" shares it, which is enough for the sequential flows these tests drive
 * (BEGIN/COMMIT/ROLLBACK and FOR UPDATE NOWAIT all work).
 */

'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;
let nextId = 1;
const pending = new Map();

function call(op, text, params) {
  if (!worker) {
    worker = new Worker(path.join(__dirname, 'pglite-worker.js'));
    worker.on('message', ({ id, result, error }) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (error) p.reject(Object.assign(new Error(error.message), error));
      else p.resolve(result);
    });
    worker.on('error', (err) => {
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    });
    worker.unref();
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, text, params });
  });
}

async function query(text, params) {
  if (!worker && closed) throw new Error('pglite-db: engine closed');
  // node-pg sends undefined as NULL; so must we.
  return call('query', text, (params || []).map(p => (p === undefined ? null : p)));
}

async function getClient() {
  return { query, release() {} };
}

async function healthCheck() {
  try { await query('SELECT 1'); return true; } catch (_) { return false; }
}

/** Empties every table. Call in beforeEach so each scenario starts from nothing. */
async function reset() {
  return call('reset');
}

let closed = false;
async function close() {
  if (!worker) return;
  // Let fire-and-forget log writes from the last test land before the engine goes away.
  await new Promise(r => setTimeout(r, 50));
  await call('close').catch(() => {});
  await worker.terminate();
  worker = null;
  closed = true;
}

module.exports = {
  query, getClient, healthCheck, reset, close,
  pool: { end: close, on() {} },
  isPoolExhausted: () => false,
};
