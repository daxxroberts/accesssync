/**
 * P3 — Reconciliation safety pass, Phase 1 (2026-09-10): migrations M2 and M3.
 *
 *   M2  reconcile-proposal-log.sql      reconciliation_proposal, the sweep's
 *                                       proposal log (Builder reviews it before
 *                                       any client's removals are switched on).
 *   M3  reconcile-not-paying-strike.sql member_access_sources strike-clock
 *                                       columns (not_paying_since /
 *                                       _last_seen_at / _observations).
 *
 * Both run against a live database with paying members, so both must be
 * additive (no UPDATE / DELETE / DROP / TRUNCATE), idempotent (safe to re-run:
 * the Free plan may have no Supabase branch to rehearse on), and each must have
 * a rollback that removes exactly what it added. Source-text checks, in the
 * style of reconcile-auto-revoke-migration.test.js and the OB-249 tests.
 *
 * M1 (clients.auto_revoke_mode) lives in reconcile-auto-revoke-migration.test.js.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');
const BOOTSTRAP_PATH = path.join(MIGRATIONS_DIR, 'supabase-bootstrap.sql');
const RECON_RUN_PATH = path.join(MIGRATIONS_DIR, 'reconciliation-run.sql');

const M2_FORWARD  = path.join(MIGRATIONS_DIR, 'reconcile-proposal-log.sql');
const M2_ROLLBACK = path.join(MIGRATIONS_DIR, 'reconcile-proposal-log.rollback.sql');
const M3_FORWARD  = path.join(MIGRATIONS_DIR, 'reconcile-not-paying-strike.sql');
const M3_ROLLBACK = path.join(MIGRATIONS_DIR, 'reconcile-not-paying-strike.rollback.sql');

const APPLIED_PENDING_LINE =
  /^-- Applied to Supabase gklgwyrnkedebyulrclv: <PENDING — Builder approval>$/m;

/**
 * Reduce a migration to its SQL statements: drop `--` comments, then blank out
 * string literals, so prose in headers and COMMENT ON text can't trip keyword
 * checks. Comments go first: an apostrophe in a comment would otherwise open a
 * fake string literal that swallows the real SQL after it.
 */
function statementsOnly(sql) {
  return sql
    .replace(/--.*$/gm, '')
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** Split stripped SQL into whitespace-normalised statements. */
function splitStatements(stripped) {
  return stripped
    .split(';')
    .map(s => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** Pull the column list out of a CREATE TABLE body: { name: definition }. */
function parseColumns(createBody) {
  const cols = {};
  for (const raw of createBody.split(/,\s*\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const m = line.match(/^(\w+)\s+(.*)$/);
    if (m) cols[m[1]] = m[2];
  }
  return cols;
}

function assertPurelyAdditive(statements, { allowOnDeleteCascade = 0 } = {}) {
  // ON DELETE CASCADE is a foreign-key action, not a DELETE statement. Strip
  // exactly the expected number of them, then no DELETE may remain.
  const cascades = statements.match(/\bON DELETE CASCADE\b/gi) || [];
  expect(cascades).toHaveLength(allowOnDeleteCascade);
  const withoutFkActions = statements.replace(/\bON DELETE CASCADE\b/gi, '');

  for (const keyword of ['UPDATE', 'DELETE', 'DROP', 'TRUNCATE']) {
    expect({ keyword, found: new RegExp(`\\b${keyword}\\b`, 'i').test(withoutFkActions) })
      .toEqual({ keyword, found: false });
  }
  // No data statements of any kind: DDL and COMMENT only.
  expect(withoutFkActions).not.toMatch(/\bINSERT\b/i);
  expect(withoutFkActions).not.toMatch(/\bALTER COLUMN\b/i);
  expect(withoutFkActions).not.toMatch(/\bRENAME\b/i);
}

// ─── M2 ──────────────────────────────────────────────────────────────────────

describe('M2 reconcile-proposal-log.sql: reconciliation_proposal', () => {
  const migration = fs.readFileSync(M2_FORWARD, 'utf8');
  const statements = statementsOnly(migration);
  const createMatch = statements.match(
    /CREATE TABLE IF NOT EXISTS reconciliation_proposal\s*\(([\s\S]*?)\)\s*;/
  );
  const columns = createMatch ? parseColumns(createMatch[1]) : {};

  test('statement stripping left the real SQL intact (guards the additive checks)', () => {
    expect(statements).toMatch(/CREATE TABLE IF NOT EXISTS reconciliation_proposal/);
    expect(statements).toMatch(/CREATE INDEX IF NOT EXISTS/);
    expect(createMatch).not.toBeNull();
  });

  test('is purely additive: no UPDATE / DELETE / DROP / TRUNCATE (FK ON DELETE CASCADE x2 only)', () => {
    assertPurelyAdditive(statements, { allowOnDeleteCascade: 2 });
  });

  test('is idempotent: every CREATE is IF NOT EXISTS', () => {
    const creates = statements.match(/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\b(?:\s+IF NOT EXISTS)?/gi) || [];
    expect(creates.length).toBeGreaterThanOrEqual(2);
    for (const c of creates) expect(c).toMatch(/IF NOT EXISTS$/i);
  });

  test('has exactly the pinned columns, no more and no fewer', () => {
    expect(Object.keys(columns).sort()).toEqual([
      'classification',
      'client_id',
      'created_at',
      'data_source',
      'decision',
      'evidence',
      'hardware_group_id',
      'hold_reason',
      'id',
      'kind',
      'platform_member_id',
      'run_id',
      'source',
      'source_plan_id',
    ]);
  });

  test.each([
    ['id',                 /^UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)$/i],
    ['run_id',             /^UUID NULL REFERENCES reconciliation_run\(id\) ON DELETE CASCADE$/i],
    ['client_id',          /^UUID NOT NULL REFERENCES clients\(id\) ON DELETE CASCADE$/i],
    ['platform_member_id', /^VARCHAR$/i],
    ['source_plan_id',     /^VARCHAR$/i],
    ['hardware_group_id',  /^VARCHAR$/i],
    ['kind',               /^VARCHAR\(32\) NOT NULL$/i],
    ['source',             /^VARCHAR\(32\)$/i],
    ['data_source',        /^VARCHAR\(32\)$/i],
    ['classification',     /^VARCHAR\(16\)$/i],
    ['decision',           /^VARCHAR\(16\) NOT NULL$/i],
    ['hold_reason',        /^VARCHAR\(48\)$/i],
    ['evidence',           /^JSONB$/i],
    ['created_at',         /^TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW\(\)$/i],
  ])('column %s is declared as pinned', (name, shape) => {
    expect(columns[name]).toMatch(shape);
  });

  test('run_id type matches reconciliation_run.id (UUID) in both schema sources', () => {
    // A mismatched FK type fails the CREATE outright on apply.
    const reconRun = fs.readFileSync(RECON_RUN_PATH, 'utf8');
    expect(reconRun).toMatch(/CREATE TABLE IF NOT EXISTS reconciliation_run \(\s*id\s+UUID PRIMARY KEY/i);

    const bootstrap = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const block = bootstrap.match(/CREATE TABLE "reconciliation_run" \(([\s\S]*?)\n\);/);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/"id" uuid\b/);
    expect(bootstrap).toMatch(
      /ALTER TABLE "reconciliation_run" ADD CONSTRAINT "reconciliation_run_pkey" PRIMARY KEY \(id\);/
    );
  });

  test('client_id type matches clients.id (uuid)', () => {
    const bootstrap = fs.readFileSync(BOOTSTRAP_PATH, 'utf8');
    const block = bootstrap.match(/CREATE TABLE "clients" \(([\s\S]*?)\n\);/);
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/"id" uuid\b/);
  });

  test('hold_reason / kind / source / data_source / classification widths fit every value the sweep writes', () => {
    // A value wider than its column fails the whole batched INSERT, and the
    // sweep's try/catch would then drop every proposal of that sweep. Pin the
    // values Phase 1 writes (spec I-1, I-7, I-10) against the widths.
    const width = (name) => Number(columns[name].match(/\((\d+)\)/)[1]);
    const holdReasons = [
      'invalid_proposal', 'snapshot_unstable', 'mass_revoke', 'auto_revoke_off',
      'dry_run', 'strike_pending', 'observation_only',
    ];
    const kinds = ['repair_pending', 'removal_pending'];
    const sources = ['kisi_user_vanished', 'role_drift', 'holder_lapse', 'wix_absence'];
    const dataSources = ['wix_orders', 'wix_bookings', 'kisi', 'db'];
    const classes = ['PAYING', 'PENDING', 'DECLINED', 'ENDED', 'UNKNOWN'];
    for (const v of holdReasons) expect(v.length).toBeLessThanOrEqual(width('hold_reason'));
    for (const v of kinds)       expect(v.length).toBeLessThanOrEqual(width('kind'));
    for (const v of sources)     expect(v.length).toBeLessThanOrEqual(width('source'));
    for (const v of dataSources) expect(v.length).toBeLessThanOrEqual(width('data_source'));
    for (const v of classes)     expect(v.length).toBeLessThanOrEqual(width('classification'));
    expect('held'.length).toBeLessThanOrEqual(width('decision'));
  });

  test('has no CHECK constraints (a rejected log INSERT would lose evidence, not protect anything)', () => {
    expect(statements).not.toMatch(/\bCHECK\b/i);
  });

  test('indexes (client_id, created_at DESC)', () => {
    expect(statements).toMatch(
      /CREATE INDEX IF NOT EXISTS \w+\s+ON reconciliation_proposal\s*\(\s*client_id\s*,\s*created_at DESC\s*\)/i
    );
  });

  test('header: house style, order note, pending applied line', () => {
    expect(migration).toMatch(/^-- /);
    expect(migration).toMatch(/ORDER: either/);
    expect(migration).toMatch(/Rollback is reconcile-proposal-log\.rollback\.sql/);
    expect(migration).toMatch(APPLIED_PENDING_LINE);
  });

  describe('rollback', () => {
    test('rollback file exists', () => {
      expect(fs.existsSync(M2_ROLLBACK)).toBe(true);
    });

    test('drops only reconciliation_proposal and nothing else', () => {
      const rollback = statementsOnly(fs.readFileSync(M2_ROLLBACK, 'utf8'));
      expect(splitStatements(rollback)).toEqual([
        'DROP TABLE IF EXISTS reconciliation_proposal',
      ]);
    });

    test('has no CASCADE (must not take any dependent object with it silently)', () => {
      const rollback = statementsOnly(fs.readFileSync(M2_ROLLBACK, 'utf8'));
      expect(rollback).not.toMatch(/\bCASCADE\b/i);
    });
  });
});

// ─── M3 ──────────────────────────────────────────────────────────────────────

describe('M3 reconcile-not-paying-strike.sql: member_access_sources strike clock', () => {
  const migration = fs.readFileSync(M3_FORWARD, 'utf8');
  const statements = statementsOnly(migration);
  const sqlStatements = splitStatements(statements);

  test('statement stripping left the real SQL intact (guards the additive checks)', () => {
    expect(statements).toMatch(/ALTER TABLE member_access_sources/);
    expect(statements).toMatch(/COMMENT ON COLUMN member_access_sources\.not_paying_since/);
  });

  test('is purely additive: no UPDATE / DELETE / DROP / TRUNCATE', () => {
    assertPurelyAdditive(statements, { allowOnDeleteCascade: 0 });
  });

  test('adds all three columns in ONE ALTER TABLE, each IF NOT EXISTS', () => {
    // One statement, so the three columns arrive together: the L3 primitive
    // sets all three in a single UPDATE.
    const alters = sqlStatements.filter(s => /^ALTER TABLE\b/i.test(s));
    expect(alters).toEqual([
      'ALTER TABLE member_access_sources ' +
        'ADD COLUMN IF NOT EXISTS not_paying_since TIMESTAMP WITH TIME ZONE, ' +
        'ADD COLUMN IF NOT EXISTS not_paying_last_seen_at TIMESTAMP WITH TIME ZONE, ' +
        'ADD COLUMN IF NOT EXISTS not_paying_observations INTEGER NOT NULL DEFAULT 0',
    ]);
  });

  test('every other statement is a COMMENT ON COLUMN for one of the three new columns', () => {
    const others = sqlStatements.filter(s => !/^ALTER TABLE\b/i.test(s));
    expect(others.map(s => s.match(/^COMMENT ON COLUMN member_access_sources\.(\w+) IS/)?.[1]).sort())
      .toEqual(['not_paying_last_seen_at', 'not_paying_observations', 'not_paying_since']);
  });

  test('column names match what the L3 primitives write (spec I-5)', () => {
    // recordNotPayingObservation / clearNotPayingObservation UPDATE exactly
    // these three columns. A misspelling here would make every call hit
    // Postgres 42703 and no strike clock would ever start.
    for (const col of ['not_paying_since', 'not_paying_last_seen_at', 'not_paying_observations']) {
      expect(statements).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}\\b`));
    }
  });

  test('does not touch status, updated_at or any existing column', () => {
    expect(statements).not.toMatch(/\bALTER COLUMN\b/i);
    expect(statements).not.toMatch(/\bstatus\b/i);
    expect(statements).not.toMatch(/\bupdated_at\b/i);
  });

  test('header: house style, order note, fail-safe note, pending applied line', () => {
    expect(migration).toMatch(/^-- /);
    expect(migration).toMatch(/ORDER: either/);
    expect(migration).toMatch(/42703/);
    expect(migration).toMatch(/reconcile-not-paying-strike\.rollback\.sql/);
    expect(migration).toMatch(APPLIED_PENDING_LINE);
  });

  describe('rollback', () => {
    test('rollback file exists', () => {
      expect(fs.existsSync(M3_ROLLBACK)).toBe(true);
    });

    test('drops exactly the three strike-clock columns, in one statement, and nothing else', () => {
      const rollback = statementsOnly(fs.readFileSync(M3_ROLLBACK, 'utf8'));
      expect(splitStatements(rollback)).toEqual([
        'ALTER TABLE member_access_sources ' +
          'DROP COLUMN IF EXISTS not_paying_since, ' +
          'DROP COLUMN IF EXISTS not_paying_last_seen_at, ' +
          'DROP COLUMN IF EXISTS not_paying_observations',
      ]);
    });
  });
});
