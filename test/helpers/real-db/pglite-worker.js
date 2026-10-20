/**
 * pglite-worker.js — runs the PGlite engine in a worker thread for pglite-db.js.
 *
 * PGlite loads its WebAssembly with a dynamic import(), which Jest's module sandbox
 * refuses (it needs --experimental-vm-modules). A worker thread is plain Node, so the
 * engine lives here and test code talks to it by message: { id, op, text, params }.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { parentPort } = require('worker_threads');
const { PGlite } = require('@electric-sql/pglite');
const { uuid_ossp } = require('@electric-sql/pglite/contrib/uuid_ossp');

const SCHEMA_PATH = path.join(__dirname, '..', '..', 'integration-db', 'schema.sql');

// node-pg returns int8 (COUNT(*)) and numeric as strings; keep that so the code under
// test sees the same types it sees in production.
const PG_INT8 = 20;
const PG_NUMERIC = 1700;

let tables = [];
const ready = (async () => {
  const pg = await PGlite.create({
    extensions: { uuid_ossp },
    parsers: { [PG_INT8]: v => v, [PG_NUMERIC]: v => v },
  });
  await pg.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const t = await pg.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`);
  tables = t.rows.map(r => r.tablename);
  return pg;
})();

async function handle(op, text, params) {
  const pg = await ready;
  if (op === 'query') {
    const res = await pg.query(text, params || []);
    const rows = res.rows || [];
    const affected = typeof res.affectedRows === 'number' ? res.affectedRows : 0;
    return { rows, rowCount: affected > 0 ? affected : rows.length };
  }
  if (op === 'reset') {
    // A test that failed mid-transaction would leave the shared session aborted.
    await pg.exec('ROLLBACK').catch(() => {});
    await pg.exec(`TRUNCATE ${tables.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
    return { ok: true };
  }
  if (op === 'close') {
    await pg.close();
    return { ok: true };
  }
  throw new Error(`unknown op ${op}`);
}

parentPort.on('message', ({ id, op, text, params }) => {
  handle(op, text, params).then(
    result => parentPort.postMessage({ id, result }),
    err => parentPort.postMessage({
      id,
      error: { message: err.message, code: err.code, detail: err.detail, constraint: err.constraint },
    }),
  );
});
