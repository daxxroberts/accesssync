/**
 * e2e/schema/schema-effective-start.spec.js
 * Verifies effective_start and valid_until columns on member_access_sources.
 * These were added in the effective_start wiring sprint (RI-03).
 * ~20 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db = require('../helpers/db');

test.describe('Schema — member_access_sources.effective_start', () => {
  test('effective_start column exists', async () => {
    const row = await db.queryOne(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'effective_start'
    `, []);
    expect(row, 'effective_start column not found').not.toBeNull();
  });

  test('effective_start is timestamp with time zone', async () => {
    const row = await db.queryOne(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'effective_start'
    `, []);
    expect(row).not.toBeNull();
    expect(row.data_type).toBe('timestamp with time zone');
  });

  test('effective_start is nullable', async () => {
    const row = await db.queryOne(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'effective_start'
    `, []);
    expect(row).not.toBeNull();
    expect(row.is_nullable).toBe('YES');
  });
});

test.describe('Schema — member_access_sources.valid_until', () => {
  test('valid_until column exists', async () => {
    const row = await db.queryOne(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'valid_until'
    `, []);
    expect(row, 'valid_until column not found').not.toBeNull();
  });

  test('valid_until is timestamp with time zone', async () => {
    const row = await db.queryOne(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'valid_until'
    `, []);
    expect(row).not.toBeNull();
    expect(row.data_type).toBe('timestamp with time zone');
  });

  test('valid_until is nullable', async () => {
    const row = await db.queryOne(`
      SELECT is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
        AND column_name = 'valid_until'
    `, []);
    expect(row).not.toBeNull();
    expect(row.is_nullable).toBe('YES');
  });
});

test.describe('Schema — member_access_sources full column set', () => {
  const REQUIRED_COLUMNS = [
    'id', 'access_id', 'billing_id', 'source_type', 'source_plan_id',
    'hardware_group_id', 'role_assignment_id', 'mapping_id',
    'effective_start', 'valid_until', 'created_at',
  ];

  test('all required columns present', async () => {
    const rows = await db.queryRows(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'member_access_sources'
    `, []);
    const existing = rows.map(r => r.column_name);
    const missing = REQUIRED_COLUMNS.filter(c => !existing.includes(c));
    expect(missing, `Missing columns: ${missing.join(', ')}`).toHaveLength(0);
  });

  for (const colName of REQUIRED_COLUMNS) {
    test(`column ${colName} exists`, async () => {
      const row = await db.queryOne(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_access_sources'
          AND column_name = $1
      `, [colName]);
      expect(row, `Column member_access_sources.${colName} not found`).not.toBeNull();
    });
  }
});

test.describe('Schema — effective_start COALESCE behavior (ON CONFLICT)', () => {
  test('ON CONFLICT preserves existing effective_start when new value is NULL', async () => {
    const clientId  = '00000000-e2e0-4000-a000-000000000001';
    const planMapId = '00000000-e2e0-4000-a000-000000000010';
    const uid = `eff-${Date.now()}`;

    // Insert a member_master and member_access so we have valid FK targets
    const master = await db.queryOne(`
      INSERT INTO member_master (client_id, source_platform, platform_member_id)
      VALUES ($1, 'wix', $2) RETURNING id
    `, [clientId, uid]);

    const access = await db.queryOne(`
      INSERT INTO member_access (member_master_id, client_id, plan_mapping_id, status)
      VALUES ($1, $2, $3, 'active') RETURNING id
    `, [master.id, clientId, planMapId]);

    const originalStart = new Date('2026-01-01T00:00:00Z');

    // First INSERT — sets effective_start
    await db.query(`
      INSERT INTO member_access_sources
        (access_id, source_type, source_plan_id, hardware_group_id, effective_start)
      VALUES ($1, 'wix', 'test-plan', '999999', $2)
      ON CONFLICT (access_id, source_type, source_plan_id, hardware_group_id) DO UPDATE
        SET effective_start = COALESCE(EXCLUDED.effective_start, member_access_sources.effective_start)
    `, [access.id, originalStart]);

    // Second INSERT — effective_start is NULL, should preserve original
    await db.query(`
      INSERT INTO member_access_sources
        (access_id, source_type, source_plan_id, hardware_group_id, effective_start)
      VALUES ($1, 'wix', 'test-plan', '999999', NULL)
      ON CONFLICT (access_id, source_type, source_plan_id, hardware_group_id) DO UPDATE
        SET effective_start = COALESCE(EXCLUDED.effective_start, member_access_sources.effective_start)
    `, [access.id]);

    const row = await db.queryOne(`
      SELECT effective_start FROM member_access_sources
      WHERE access_id = $1 AND source_type = 'wix' AND source_plan_id = 'test-plan'
    `, [access.id]);

    expect(row).not.toBeNull();
    expect(new Date(row.effective_start).toISOString()).toBe(originalStart.toISOString());

    // Cleanup
    await db.query('DELETE FROM member_master WHERE id = $1', [master.id]);
  });
});
