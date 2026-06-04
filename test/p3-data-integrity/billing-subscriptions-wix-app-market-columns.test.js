/**
 * P3 -- DATA INTEGRITY
 *
 * F-16 schema migration parity: confirms the repo-side migration file
 * `migrations/f-16-billing-subscriptions-wix-app-market.sql` declares both
 * `vendor_product_id` and `wix_app_instance_id` columns on
 * `billing_subscriptions`.
 *
 * Why static: the migration has already been applied to the live Supabase
 * project via apply_migration MCP; the SQL file is the audit trail. If the
 * SQL file drifts from production, future OB-66 build sessions will be
 * working from a stale migration record. This test guards against that
 * drift.
 *
 * Governed by: F-16 / OB-66.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  '..',
  'migrations',
  'f-16-billing-subscriptions-wix-app-market.sql'
);

describe('F-16 billing_subscriptions Wix App Market migration', () => {
  let sql;

  beforeAll(() => {
    sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  });

  test('migration file exists at the canonical path', () => {
    expect(fs.existsSync(MIGRATION_PATH)).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  test('declares vendor_product_id as a VARCHAR(255) ADD COLUMN', () => {
    // Match the ADD COLUMN clause -- tolerate IF NOT EXISTS and whitespace.
    const re = /ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?vendor_product_id\s+VARCHAR\s*\(\s*255\s*\)/i;
    expect(sql).toMatch(re);
  });

  test('declares wix_app_instance_id as a VARCHAR(255) ADD COLUMN', () => {
    const re = /ADD\s+COLUMN\s+(IF\s+NOT\s+EXISTS\s+)?wix_app_instance_id\s+VARCHAR\s*\(\s*255\s*\)/i;
    expect(sql).toMatch(re);
  });

  test('alters the billing_subscriptions table specifically', () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+billing_subscriptions/i);
  });

  test('attaches COMMENT ON COLUMN for each new column referencing OB-66 / F-16', () => {
    const vendorComment = /COMMENT\s+ON\s+COLUMN\s+billing_subscriptions\.vendor_product_id[\s\S]+OB-66[\s\S]+F-16/i;
    const instanceComment = /COMMENT\s+ON\s+COLUMN\s+billing_subscriptions\.wix_app_instance_id[\s\S]+OB-66[\s\S]+F-16/i;
    expect(sql).toMatch(vendorComment);
    expect(sql).toMatch(instanceComment);
  });
});
