/**
 * P3 — DR-045 phase 2: no runtime code reads or writes a Kisi user's `notes`.
 *
 * The ownership marker moved to the user's `metadata` (Builder direction 2026-10-24).
 * Notes now belong to the operator: AccessSync must not overwrite what a gym typed,
 * and must not trust anything written there as proof of ownership. This scans every
 * runtime source file — the app servers, adapters, core, admin routes and middleware,
 * and every script — and fails on any property access, object key, or string key
 * named `notes`, comments excluded.
 *
 * The one exception is scripts/kisi-ownership-migrate.js, which parses notes in order
 * to clear the retired marker text. Delete it from ALLOWED once clear-notes has run in
 * every org and the script is retired.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['adapters', 'core', 'admin/routes', 'admin/middleware', 'scripts'];
const SCAN_FILES = ['server.js', 'db.js', 'admin/server.js'];
const ALLOWED = new Set([
  'scripts/kisi-ownership-migrate.js',
]);

// `.notes`, `notes:` (object key), `{ …, notes }` (shorthand key), `'notes'` / "notes" /
// `notes` as a string key, kisiNotes.
const NOTES_PATTERNS = [/\.notes\b/, /\bnotes\s*:/, /[{,]\s*notes\s*[,}]/, /['"`]notes['"`]/, /kisiNotes/];

function listJs(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'))
    .join('\n');
}

const files = [...SCAN_DIRS.flatMap(listJs), ...SCAN_FILES.filter(f => fs.existsSync(path.join(ROOT, f)))]
  .map(f => f.split(path.sep).join('/'));

describe('[P3] DR-045 phase 2 — runtime code never touches a Kisi user\'s notes', () => {
  test('the scan covers the Kisi adapter, the delete guard callers, and reconcile', () => {
    expect(files).toEqual(expect.arrayContaining([
      'adapters/kisi/kisi-adapter.js',
      'adapters/hardware-adapter.js',
      'adapters/standard-adapter.js',
      'core/reconciliation.js',
      'core/grant-revoke.js',
      'scripts/backfill-kisi-names.js',
    ]));
  });

  test.each(files.filter(f => !ALLOWED.has(f)))('%s', (file) => {
    const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    const hits = code.split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => NOTES_PATTERNS.some(re => re.test(text)));
    expect(hits).toEqual([]);
  });

  test('the migration script is the only allowed exception, and it still exists', () => {
    for (const f of ALLOWED) expect(fs.existsSync(path.join(ROOT, f))).toBe(true);
  });
});
