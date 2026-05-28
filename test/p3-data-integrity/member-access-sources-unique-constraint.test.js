/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: member_access_sources canonical UNIQUE constraint (DR-046 A9)│
 * │                                                                         │
 * │  Per DR-046 (Per-Person Member Access Cardinality, A9-strengthened),    │
 * │  member_access_sources MUST have a UNIQUE constraint on the tuple       │
 * │  (client_id, access_id, source_type, source_plan_id, hardware_group_id) │
 * │  in that exact column order.                                            │
 * │                                                                         │
 * │  This tuple is the table's declared identity. It guarantees:            │
 * │    - Multi-tenancy isolation (client_id leads — A11)                    │
 * │    - Per-(person × plan × hardware-group) uniqueness                    │
 * │    - Idempotent ON CONFLICT DO UPDATE behavior in standard-adapter      │
 * │    - Prevents duplicate source rows on webhook retry / reconcile pass 1 │
 * │                                                                         │
 * │  Per RULE-15 (Schema enforces invariants, not application code          │
 * │  discipline): if a future migration silently drops or alters this       │
 * │  constraint, the schema invariant evaporates. Application-layer ON      │
 * │  CONFLICT clauses would silently begin doing nothing, producing         │
 * │  duplicate sources and breaking the per-source revoke count guard       │
 * │  (DR-034 / OB-48).                                                      │
 * │                                                                         │
 * │  This test fails the deploy gate if the canonical UNIQUE constraint     │
 * │  on the bootstrap schema source-of-truth ever drifts from the           │
 * │  DR-046 A9 tuple.                                                       │
 * │                                                                         │
 * │  Filed: OB-230 (P3 regression — derived from OB-226 close /             │
 * │         FALSE_ALARM, 2026-05-27).                                       │
 * │  Owner: STRATA + FELIX.                                                 │
 * │  Runtime impact: ~10ms file read + regex. Zero production impact.       │
 * │  Governed by: DR-046 A9, RULE-15.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

const BOOTSTRAP_FILE = path.join(__dirname, '..', '..', 'migrations', 'supabase-bootstrap.sql');

// DR-046 A9 canonical tuple — column order is load-bearing for index usability.
const EXPECTED_COLUMNS = [
  'client_id',
  'access_id',
  'source_type',
  'source_plan_id',
  'hardware_group_id',
];

const EXPECTED_CONSTRAINT_NAME = 'member_access_sources_client_access_source_plan_group_key';

describe('[P3] member_access_sources canonical UNIQUE constraint (DR-046 A9, OB-230)', () => {

  test('schema source-of-truth declares UNIQUE (client_id, access_id, source_type, source_plan_id, hardware_group_id)', () => {
    expect(fs.existsSync(BOOTSTRAP_FILE)).toBe(true);
    const sql = fs.readFileSync(BOOTSTRAP_FILE, 'utf8');

    // Match: ALTER TABLE "member_access_sources" ADD CONSTRAINT "<name>" UNIQUE ( <cols> );
    // Permissive about whitespace, quoting style, and constraint name.
    const re = /ALTER\s+TABLE\s+"?member_access_sources"?\s+ADD\s+CONSTRAINT\s+"?([a-zA-Z0-9_]+)"?\s+UNIQUE\s*\(([^)]+)\)/gm;

    const matches = [];
    let m;
    while ((m = re.exec(sql)) !== null) {
      matches.push({ name: m[1], columns: m[2].split(',').map(c => c.trim().replace(/"/g, '')) });
    }

    if (matches.length === 0) {
      throw new Error(
        `No UNIQUE constraint found on member_access_sources in ${path.relative(process.cwd(), BOOTSTRAP_FILE)}.\n\n` +
        `Per DR-046 A9 / RULE-15, this table MUST declare UNIQUE on the tuple\n` +
        `(${EXPECTED_COLUMNS.join(', ')}) — the schema-enforced identity for per-source rows.\n` +
        `OB-230: if you see this failure, a migration silently dropped the constraint.\n` +
        `Restore via migrations/s11.sql STEP 4e (member_access_sources_client_access_source_plan_group_key).`
      );
    }

    // Exactly one UNIQUE constraint should match the DR-046 A9 tuple.
    const a9Match = matches.find(c =>
      c.columns.length === EXPECTED_COLUMNS.length &&
      c.columns.every((col, i) => col === EXPECTED_COLUMNS[i])
    );

    if (!a9Match) {
      const actual = matches.map(c => `  ${c.name}: (${c.columns.join(', ')})`).join('\n');
      throw new Error(
        `member_access_sources UNIQUE constraint(s) found, but none match DR-046 A9 tuple.\n\n` +
        `Expected: (${EXPECTED_COLUMNS.join(', ')}) in that exact order.\n` +
        `Found:\n${actual}\n\n` +
        `Per RULE-15, schema enforces invariants. The DR-046 A9 tuple is the\n` +
        `table's declared identity — application-layer ON CONFLICT clauses in\n` +
        `core/standard-adapter.js depend on this exact tuple.\n` +
        `OB-230: restore the canonical constraint definition.`
      );
    }

    // Sanity-check the constraint name matches what live DB has, so future
    // schema dumps don't silently rename it (which would survive this test
    // but break grep-based ops tooling).
    expect(a9Match.name).toBe(EXPECTED_CONSTRAINT_NAME);
    expect(a9Match.columns).toEqual(EXPECTED_COLUMNS);
  });

});
