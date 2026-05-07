/**
 * e2e/schema/schema-indexes.spec.js
 * Verifies all 10 non-inline performance indexes from schema-restructure.sql Section 10.
 * ~25 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db = require('../helpers/db');

const EXPECTED_INDEXES = [
  { name: 'idx_member_master_client_platform',   table: 'member_master' },
  { name: 'idx_member_access_client_status',     table: 'member_access' },
  { name: 'idx_member_access_sub_master',        table: 'member_access' },
  { name: 'idx_member_access_sources_access',    table: 'member_access_sources' },
  { name: 'idx_member_access_sources_billing',   table: 'member_access_sources' },
  { name: 'idx_member_billing_master_status',    table: 'member_billing' },
  { name: 'idx_member_billing_wix_order',        table: 'member_billing' },
  { name: 'idx_connector_subscriptions_client',  table: 'connector_subscriptions' },
  { name: 'idx_billing_subscriptions_location',  table: 'billing_subscriptions' },
  { name: 'idx_as_client_subscriptions_client',  table: 'as_client_subscriptions' },
];

async function indexExists(indexName) {
  const row = await db.queryOne(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = $1
  `, [indexName]);
  return !!row;
}

test.describe('Schema — Performance Indexes', () => {
  test('all 10 indexes exist', async () => {
    const results = await Promise.all(
      EXPECTED_INDEXES.map(async idx => ({
        name:   idx.name,
        exists: await indexExists(idx.name),
      }))
    );
    const missing = results.filter(r => !r.exists).map(r => r.name);
    expect(missing, `Missing indexes: ${missing.join(', ')}`).toHaveLength(0);
  });

  for (const idx of EXPECTED_INDEXES) {
    test(`index ${idx.name} exists on ${idx.table}`, async () => {
      const row = await db.queryOne(`
        SELECT indexname, tablename FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = $1
      `, [idx.name]);
      expect(row, `Index ${idx.name} not found`).not.toBeNull();
      expect(row.tablename).toBe(idx.table);
    });
  }
});

test.describe('Schema — Partial Indexes', () => {
  test('idx_member_access_sub_master is a partial index (WHERE sub_master_id IS NOT NULL)', async () => {
    const row = await db.queryOne(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_member_access_sub_master'
    `, []);
    expect(row).not.toBeNull();
    expect(row.indexdef.toLowerCase()).toContain('where');
    expect(row.indexdef.toLowerCase()).toContain('sub_master_id is not null');
  });

  test('idx_member_access_sources_billing is a partial index (WHERE billing_id IS NOT NULL)', async () => {
    const row = await db.queryOne(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_member_access_sources_billing'
    `, []);
    expect(row).not.toBeNull();
    expect(row.indexdef.toLowerCase()).toContain('where');
    expect(row.indexdef.toLowerCase()).toContain('billing_id is not null');
  });

  test('idx_billing_subscriptions_location is a composite index on (location_id, status)', async () => {
    const row = await db.queryOne(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_billing_subscriptions_location'
    `, []);
    expect(row).not.toBeNull();
    expect(row.indexdef.toLowerCase()).toContain('location_id');
    expect(row.indexdef.toLowerCase()).toContain('status');
  });

  test('idx_member_master_client_platform is a composite index on (client_id, source_platform, platform_member_id)', async () => {
    const row = await db.queryOne(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = 'idx_member_master_client_platform'
    `, []);
    expect(row).not.toBeNull();
    const def = row.indexdef.toLowerCase();
    expect(def).toContain('client_id');
    expect(def).toContain('source_platform');
    expect(def).toContain('platform_member_id');
  });
});
