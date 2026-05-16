/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY (A11 multi-tenancy regression)             │
 * │  Scenario: every INSERT into a member table includes client_id          │
 * │                                                                         │
 * │  Business consequence: When an INSERT into member_master / member_      │
 * │  billing / member_access / member_access_sources writes a row WITHOUT   │
 * │  client_id, the row escapes the tenant boundary. Per S-11 schema:       │
 * │    - member_master.client_id NOT NULL (UNIQUE includes client_id)       │
 * │    - member_billing.client_id NOT NULL (A10: UNIQUE includes client_id) │
 * │    - member_access.client_id NOT NULL (UNIQUE includes client_id)       │
 * │    - member_access_sources.client_id NOT NULL (A9: UNIQUE includes      │
 * │      client_id, FK CASCADE to clients)                                  │
 * │                                                                         │
 * │  An INSERT that omits client_id will fail at runtime against the NOT    │
 * │  NULL constraint — but failing AT runtime in production is too late.    │
 * │  This test catches the regression at the deploy gate.                   │
 * │                                                                         │
 * │  Convention: every INSERT INTO <member table> in core/ or adapters/ or  │
 * │  admin/ must include client_id in its column list. Enforced here so the │
 * │  multi-tenancy boundary cannot accidentally drop in a future change.    │
 * │                                                                         │
 * │  Runtime impact: ~50ms filesystem scan. Zero production impact.         │
 * │  Governed by: DR-046 (Per-Person Member Access Cardinality), A9-A11     │
 * │               of S-11 spec (multi-tenancy hardening)                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MEMBER_TABLES = [
  'member_master',
  'member_billing',
  'member_access',
  'member_access_sources',
];

const SCAN_ROOTS = [
  path.join(__dirname, '..', '..', 'core'),
  path.join(__dirname, '..', '..', 'adapters'),
  path.join(__dirname, '..', '..', 'admin'),
];

const SKIP_FILES = new Set([
  // seed.js writes mock data with explicit client_id seeds — exempt to avoid noise
  // and because the file is independently flagged for rewrite (F-22).
  'seed.js',
]);

function collectJsFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(full);
    }
  }
  walk(root);
  return files;
}

/**
 * Returns array of { file, line, table, columnList } for every INSERT into a member
 * table that does NOT include client_id in its column list.
 *
 * Multi-line column lists are captured between "INTO <table> (" and the first ")".
 */
function findOffenders(file) {
  const src = fs.readFileSync(file, 'utf8');
  const offenders = [];

  for (const table of MEMBER_TABLES) {
    // Match INSERT INTO <table> ( ... ). Permissive about whitespace.
    const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)`, 'gm');
    let m;
    while ((m = re.exec(src)) !== null) {
      const columnList = m[1];
      const before = src.slice(0, m.index);
      const line = before.split('\n').length;

      if (!/\bclient_id\b/.test(columnList)) {
        offenders.push({
          file: path.relative(path.join(__dirname, '..', '..'), file),
          line,
          table,
          columnList: columnList.trim().replace(/\s+/g, ' ').slice(0, 160),
        });
      }
    }
  }
  return offenders;
}

describe('member table INSERTs include client_id (A11 multi-tenancy regression)', () => {
  test('every INSERT into a member table includes client_id in its column list', () => {
    const allFiles = SCAN_ROOTS.flatMap(collectJsFiles)
      .filter((f) => !SKIP_FILES.has(path.basename(f)));

    const offenders = [];
    for (const f of allFiles) {
      offenders.push(...findOffenders(f));
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  INSERT INTO ${o.table} (${o.columnList})`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} INSERT(s) into a member table without client_id:\n${msg}\n\n` +
        `Fix: add client_id to the column list. Per S-11/DR-046 (A9, A10, A11), all member\n` +
        `tables enforce client_id NOT NULL with tenant-scoped UNIQUE constraints. An INSERT\n` +
        `that omits client_id will fail at runtime against the NOT NULL constraint.`
      );
    }
    expect(offenders.length).toBe(0);
  });
});
