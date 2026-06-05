/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: OB-240 migration file declares the three retry-tracking      │
 * │            columns and documents them via COMMENT ON.                   │
 * │                                                                         │
 * │  Guards the migration source-of-truth file. If the file is renamed,    │
 * │  truncated, or stripped of COMMENT ON declarations, this test fails    │
 * │  and the deploy gate blocks.                                            │
 * │                                                                         │
 * │  Live migration applied to Supabase as `ob_240_source_retry_tracking`   │
 * │  on 2026-06-04. The .sql file in the repo is the durable, reviewable   │
 * │  artifact of that change — schema drift between the two is caught by   │
 * │  the existing bootstrap-schema regression tests.                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(
  __dirname, '..', '..', 'migrations', 'ob-240-source-retry-tracking.sql'
);

describe('[P3] OB-240 — source-retry-tracking migration file', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_FILE, 'utf8');
  });

  test('ALTER TABLE member_access_sources statement present', () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+member_access_sources/i);
  });

  test('adds all three columns: retry_count, last_retry_at, failure_reason', () => {
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+retry_count\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+last_retry_at\s+TIMESTAMPTZ/i);
    expect(sql).toMatch(/ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+failure_reason\s+TEXT/i);
  });

  test('COMMENT ON declared for each new column (operator-readable schema)', () => {
    expect(sql).toMatch(/COMMENT\s+ON\s+COLUMN\s+member_access_sources\.retry_count\s+IS/i);
    expect(sql).toMatch(/COMMENT\s+ON\s+COLUMN\s+member_access_sources\.last_retry_at\s+IS/i);
    expect(sql).toMatch(/COMMENT\s+ON\s+COLUMN\s+member_access_sources\.failure_reason\s+IS/i);
  });
});
