/**
 * P3 — Reconciliation safety pass (2026-09-10): clients.auto_revoke_mode migration.
 *
 * The column is the per-client mode for the reconciliation sweep's automatic
 * removals: 'off' | 'dry_run' | 'on'. The application reads it fail-closed:
 * anything other than exactly 'dry_run' or 'on' is treated as 'off'. So the
 * migration's DEFAULT decides, on deploy, what every existing client does: it
 * must land every client in dry_run (record, remove nobody), never 'on'.
 * These are source-text checks on the migration and its rollback, in the style
 * of the OB-249 migration tests.
 *
 * History: an earlier, never-applied draft of this same file added a BOOLEAN
 * clients.auto_revoke_enabled DEFAULT true. Phase 1 reshaped it into the
 * tri-state mode; the "must not reintroduce the boolean" test below keeps the
 * two from both landing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const FORWARD_PATH   = path.join(MIGRATIONS_DIR, 'reconcile-auto-revoke-kill-switch.sql');
const ROLLBACK_PATH  = path.join(MIGRATIONS_DIR, 'reconcile-auto-revoke-kill-switch.rollback.sql');

/**
 * Reduce a migration to its SQL statements: drop `--` comments, then blank out
 * string literals. The header comment has to say "no backfill is needed", and the
 * COMMENT ON text is prose, so keyword checks must not see either.
 *
 * Comments go first: an apostrophe in a comment ("today's") would otherwise
 * open a fake string literal that swallows the real SQL after it.
 */
function statementsOnly(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Same as statementsOnly, but keeps string literals (for CHECK value lists). */
function withoutComments(sql) {
  return sql.replace(/--.*$/gm, '');
}

describe('Reconcile auto-revoke mode: clients.auto_revoke_mode', () => {
  describe('migration', () => {
    const migration = fs.readFileSync(FORWARD_PATH, 'utf8');
    const statements = statementsOnly(migration);
    const sql = withoutComments(migration);

    test('adds auto_revoke_mode to clients with ADD COLUMN IF NOT EXISTS', () => {
      expect(statements).toMatch(/ALTER TABLE clients\s+ADD COLUMN IF NOT EXISTS auto_revoke_mode\b/);
    });

    test("column is VARCHAR(16) NOT NULL DEFAULT 'dry_run'", () => {
      // Postgres writes the column default into every existing row when the
      // column is added. DEFAULT 'on' would arm automatic removals for every
      // existing client the moment removals are wired (Phase 3b) with nobody
      // having decided to. The approved plan (M1) makes dry_run the default:
      // the sweep records what it would remove for Builder review and removes
      // nobody. The default must be 'dry_run', specifically.
      const match = sql.match(
        /ADD COLUMN IF NOT EXISTS auto_revoke_mode\s+(\w+)\s*\(\s*(\d+)\s*\)\s+NOT NULL\s+DEFAULT\s+'([^']*)'/i
      );
      expect(match).not.toBeNull();
      expect(match[1].toUpperCase()).toBe('VARCHAR');
      expect(match[2]).toBe('16');
      expect(match[3]).toBe('dry_run');
    });

    test("CHECK allows exactly 'off', 'dry_run' and 'on'", () => {
      const match = sql.match(/CHECK\s*\(\s*auto_revoke_mode\s+IN\s*\(([^)]*)\)\s*\)/i);
      expect(match).not.toBeNull();
      const values = [...match[1].matchAll(/'([^']*)'/g)].map(m => m[1]).sort();
      expect(values).toEqual(['dry_run', 'off', 'on']);
    });

    test('the CHECK is part of the column definition, so IF NOT EXISTS makes a re-run a no-op', () => {
      // A separate "ALTER TABLE ... ADD CONSTRAINT" would fail on a second run
      // (constraint already exists). Inside the ADD COLUMN IF NOT EXISTS clause
      // it is skipped along with the column.
      expect(statements).not.toMatch(/ADD CONSTRAINT/i);
      expect(statements).toMatch(
        /ADD COLUMN IF NOT EXISTS auto_revoke_mode[^;]*CONSTRAINT clients_auto_revoke_mode_check\s+CHECK/
      );
    });

    test('does not reintroduce the never-applied auto_revoke_enabled boolean', () => {
      expect(statements).not.toMatch(/auto_revoke_enabled/);
      expect(statements).not.toMatch(/\bBOOLEAN\b/i);
    });

    test('COMMENT ON COLUMN exists, says grants are unaffected, and says unreadable = off', () => {
      const match = migration.match(
        /COMMENT ON COLUMN clients\.auto_revoke_mode IS\s+((?:'(?:[^']|'')*'\s*)+);/
      );
      expect(match).not.toBeNull();

      // Join adjacent string literals ('a' 'b' continuation) into one text.
      const text = [...match[1].matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1]).join('');
      expect(text).toMatch(/grants continue|grants (are )?(unaffected|not affected)/i);
      expect(text).toMatch(/webhook cancellations are NOT affected/i);
      expect(text).toMatch(/fail-closed/i);
      expect(text).toMatch(/treated as off/i);
    });

    test('header documents the fail-closed read and the apply-before-code order', () => {
      expect(migration).toMatch(/treated as 'off'/);
      expect(migration).toMatch(/ORDER: apply this BEFORE deploying the code/);
    });

    test('header carries the house-style applied line, still pending', () => {
      expect(migration).toMatch(
        /^-- Applied to Supabase gklgwyrnkedebyulrclv: <PENDING — Builder approval>$/m
      );
    });

    test('statement stripping left the real SQL intact (guards the next test)', () => {
      // If statementsOnly() ever ate the whole file, the "no destructive
      // keywords" check below would pass on an empty string.
      expect(statements).toMatch(/ALTER TABLE clients/);
      expect(statements).toMatch(/COMMENT ON COLUMN clients\.auto_revoke_mode/);
    });

    test.each(['UPDATE', 'DELETE', 'DROP', 'TRUNCATE'])(
      'contains no %s statement (migration must be purely additive)',
      (keyword) => {
        expect(statements).not.toMatch(new RegExp(`\\b${keyword}\\b`, 'i'));
      }
    );
  });

  describe('rollback', () => {
    test('rollback file exists', () => {
      expect(fs.existsSync(ROLLBACK_PATH)).toBe(true);
    });

    test('drops only clients.auto_revoke_mode and nothing else', () => {
      const rollback = statementsOnly(fs.readFileSync(ROLLBACK_PATH, 'utf8'));
      const sqlStatements = rollback
        .split(';')
        .map(s => s.replace(/\s+/g, ' ').trim())
        .filter(Boolean);

      expect(sqlStatements).toEqual([
        'ALTER TABLE clients DROP COLUMN IF EXISTS auto_revoke_mode',
      ]);
    });
  });
});
