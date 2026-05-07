/**
 * e2e/schema/schema-tables.spec.js
 * Verifies all 8 new tables exist with correct columns, data types, and nullability.
 * Gates S-9 deploy — run against Railway production DB before any migration.
 * ~40 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db = require('../helpers/db');

const NEW_TABLES = [
  'member_master',
  'member_access',
  'member_access_sources',
  'member_billing',
  'connector_subscriptions',
  'billing_subscriptions',
  'as_subscription_terms',
  'as_client_subscriptions',
];

test.describe('Schema — New Tables Exist', () => {
  test('all 8 new tables exist in public schema', async () => {
    const result = await db.queryRows(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    `, [NEW_TABLES]);

    const found = result.map(r => r.table_name).sort();
    const expected = [...NEW_TABLES].sort();
    expect(found).toEqual(expected);
  });

  for (const tableName of NEW_TABLES) {
    test(`table "${tableName}" exists`, async () => {
      const row = await db.queryOne(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      `, [tableName]);
      expect(row, `Table ${tableName} not found`).not.toBeNull();
    });
  }
});

test.describe('Schema — member_master columns', () => {
  const REQUIRED_COLUMNS = [
    { name: 'id',                 type: 'uuid',                      nullable: 'NO' },
    { name: 'client_id',         type: 'uuid',                      nullable: 'NO' },
    { name: 'source_platform',   type: 'character varying',          nullable: 'NO' },
    { name: 'platform_member_id',type: 'character varying',          nullable: 'NO' },
    { name: 'email',             type: 'character varying',          nullable: 'YES' },
    { name: 'display_name',      type: 'character varying',          nullable: 'YES' },
    { name: 'created_at',        type: 'timestamp with time zone',   nullable: 'YES' },
    { name: 'updated_at',        type: 'timestamp with time zone',   nullable: 'YES' },
  ];

  for (const col of REQUIRED_COLUMNS) {
    test(`column ${col.name} — type=${col.type}, nullable=${col.nullable}`, async () => {
      const row = await db.queryOne(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_master'
          AND column_name = $1
      `, [col.name]);
      expect(row, `Column member_master.${col.name} not found`).not.toBeNull();
      expect(row.data_type).toBe(col.type);
      expect(row.is_nullable).toBe(col.nullable);
    });
  }
});

test.describe('Schema — member_access columns', () => {
  const REQUIRED_COLUMNS = [
    { name: 'id',                   nullable: 'NO' },
    { name: 'member_master_id',     nullable: 'NO' },
    { name: 'client_id',            nullable: 'NO' },
    { name: 'plan_mapping_id',      nullable: 'YES' },
    { name: 'hardware_user_id',     nullable: 'YES' },
    { name: 'status',               nullable: 'NO' },
    { name: 'provisioned_at',       nullable: 'YES' },
    { name: 'scheduled_start_date', nullable: 'YES' },
    { name: 'pending_plan_id',      nullable: 'YES' },
    { name: 'sub_master_id',        nullable: 'YES' },
    { name: 'plan_holder',          nullable: 'YES' },
    { name: 'billing_snapshot',     nullable: 'YES' },
  ];

  for (const col of REQUIRED_COLUMNS) {
    test(`column ${col.name} nullable=${col.nullable}`, async () => {
      const row = await db.queryOne(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_access'
          AND column_name = $1
      `, [col.name]);
      expect(row, `Column member_access.${col.name} not found`).not.toBeNull();
      expect(row.is_nullable).toBe(col.nullable);
    });
  }
});

test.describe('Schema — member_billing columns', () => {
  const REQUIRED_COLUMNS = [
    'id', 'member_master_id', 'client_id', 'wix_order_id',
    'wix_subscription_id', 'cycle_index', 'plan_id', 'plan_name',
    'effective_start', 'effective_end', 'status', 'billing_snapshot',
  ];

  for (const colName of REQUIRED_COLUMNS) {
    test(`column ${colName} exists`, async () => {
      const row = await db.queryOne(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'member_billing'
          AND column_name = $1
      `, [colName]);
      expect(row, `Column member_billing.${colName} not found`).not.toBeNull();
    });
  }
});

test.describe('Schema — connector_subscriptions columns', () => {
  const REQUIRED_COLUMNS = [
    'id', 'client_id', 'hardware_platform', 'hardware_api_key',
    'kisi_user_pattern', 'status', 'key_last_verified', 'key_last_error',
  ];

  for (const colName of REQUIRED_COLUMNS) {
    test(`column ${colName} exists`, async () => {
      const row = await db.queryOne(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'connector_subscriptions'
          AND column_name = $1
      `, [colName]);
      expect(row, `Column connector_subscriptions.${colName} not found`).not.toBeNull();
    });
  }
});
