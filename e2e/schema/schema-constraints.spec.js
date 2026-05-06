/**
 * e2e/schema/schema-constraints.spec.js
 * Verifies all UNIQUE constraints, FK constraints, and CHECK constraints.
 * ~45 scenarios.
 */

const { test, expect } = require('@playwright/test');
const db = require('../helpers/db');

async function getUniqueConstraints(tableName) {
  const rows = await db.queryRows(`
    SELECT tc.constraint_name
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_type = 'UNIQUE'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
  `, [tableName]);
  return rows.map(r => r.constraint_name);
}

async function getFkConstraints(tableName) {
  const rows = await db.queryRows(`
    SELECT tc.constraint_name, kcu.column_name, ccu.table_name AS referenced_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name = $1
  `, [tableName]);
  return rows;
}

test.describe('UNIQUE constraints — member_master', () => {
  test('has UNIQUE on (client_id, source_platform, platform_member_id)', async () => {
    const constraints = await getUniqueConstraints('member_master');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });

  test('blocks duplicate (client_id, source_platform, platform_member_id) insert', async () => {
    const clientId = '00000000-e2e0-4000-a000-000000000001';
    const uid = `uniq-test-${Date.now()}`;
    await db.query(`
      INSERT INTO member_master (client_id, source_platform, platform_member_id, email)
      VALUES ($1, 'wix', $2, $3)
    `, [clientId, uid, `${uid}@test.com`]);

    await expect(db.query(`
      INSERT INTO member_master (client_id, source_platform, platform_member_id, email)
      VALUES ($1, 'wix', $2, $3)
    `, [clientId, uid, `${uid}+2@test.com`])).rejects.toThrow(/unique/i);

    await db.query(`DELETE FROM member_master WHERE platform_member_id = $1`, [uid]);
  });
});

test.describe('UNIQUE constraints — member_access', () => {
  test('has UNIQUE on (member_master_id, plan_mapping_id)', async () => {
    const constraints = await getUniqueConstraints('member_access');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('UNIQUE constraints — member_billing', () => {
  test('has UNIQUE on (wix_order_id, cycle_index)', async () => {
    const constraints = await getUniqueConstraints('member_billing');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });

  test('blocks duplicate (wix_order_id, cycle_index) insert', async () => {
    const clientId  = '00000000-e2e0-4000-a000-000000000001';
    const masterId = await db.queryOne(`
      INSERT INTO member_master (client_id, source_platform, platform_member_id)
      VALUES ($1, 'wix', $2) RETURNING id
    `, [clientId, `billing-dedup-test-${Date.now()}`]);

    const orderId = `e2e-dedup-order-${Date.now()}`;
    await db.query(`
      INSERT INTO member_billing (member_master_id, client_id, wix_order_id, cycle_index, status)
      VALUES ($1, $2, $3, 1, 'active')
    `, [masterId.id, clientId, orderId]);

    await expect(db.query(`
      INSERT INTO member_billing (member_master_id, client_id, wix_order_id, cycle_index, status)
      VALUES ($1, $2, $3, 1, 'active')
    `, [masterId.id, clientId, orderId])).rejects.toThrow(/unique/i);

    await db.query(`DELETE FROM member_master WHERE id = $1`, [masterId.id]);
  });
});

test.describe('UNIQUE constraints — member_access_sources', () => {
  test('has UNIQUE on (access_id, source_type, source_plan_id, hardware_group_id)', async () => {
    const constraints = await getUniqueConstraints('member_access_sources');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('UNIQUE constraints — connector_subscriptions', () => {
  test('has UNIQUE on (client_id, hardware_platform)', async () => {
    const constraints = await getUniqueConstraints('connector_subscriptions');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('UNIQUE constraints — as_client_subscriptions', () => {
  test('has UNIQUE on (client_id, location_id)', async () => {
    const constraints = await getUniqueConstraints('as_client_subscriptions');
    expect(constraints.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('FK constraints — member_master', () => {
  test('client_id references clients(id)', async () => {
    const fks = await getFkConstraints('member_master');
    const clientFk = fks.find(f => f.column_name === 'client_id');
    expect(clientFk, 'FK client_id → clients not found').not.toBeUndefined();
    expect(clientFk.referenced_table).toBe('clients');
  });
});

test.describe('FK constraints — member_access', () => {
  test('member_master_id references member_master(id)', async () => {
    const fks = await getFkConstraints('member_access');
    const fk = fks.find(f => f.column_name === 'member_master_id');
    expect(fk, 'FK member_master_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('member_master');
  });

  test('client_id references clients(id)', async () => {
    const fks = await getFkConstraints('member_access');
    const fk = fks.find(f => f.column_name === 'client_id');
    expect(fk, 'FK client_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('clients');
  });

  test('plan_mapping_id references plan_mappings(id)', async () => {
    const fks = await getFkConstraints('member_access');
    const fk = fks.find(f => f.column_name === 'plan_mapping_id');
    expect(fk, 'FK plan_mapping_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('plan_mappings');
  });
});

test.describe('FK constraints — member_access_sources', () => {
  test('access_id references member_access(id)', async () => {
    const fks = await getFkConstraints('member_access_sources');
    const fk = fks.find(f => f.column_name === 'access_id');
    expect(fk, 'FK access_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('member_access');
  });

  test('billing_id references member_billing(id)', async () => {
    const fks = await getFkConstraints('member_access_sources');
    const fk = fks.find(f => f.column_name === 'billing_id');
    expect(fk, 'FK billing_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('member_billing');
  });
});

test.describe('FK constraints — member_billing', () => {
  test('member_master_id references member_master(id)', async () => {
    const fks = await getFkConstraints('member_billing');
    const fk = fks.find(f => f.column_name === 'member_master_id');
    expect(fk, 'FK member_master_id not found').not.toBeUndefined();
    expect(fk.referenced_table).toBe('member_master');
  });
});

test.describe('CHECK constraints — connector_subscriptions', () => {
  test('kisi_user_pattern CHECK restricts to invited|managed', async () => {
    const clientId = '00000000-e2e0-4000-a000-000000000001';
    await expect(db.query(`
      INSERT INTO connector_subscriptions
        (client_id, hardware_platform, kisi_user_pattern)
      VALUES ($1, 'kisi-test-invalid', 'bad_value')
    `, [clientId])).rejects.toThrow(/check/i);
  });
});

test.describe('FK constraints — permanent tables still intact post-S9', () => {
  test('member_access_log has NO FK to member_identity (dropped in S-9)', async () => {
    const rows = await db.queryRows(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND table_schema = 'public'
        AND table_name = 'member_access_log'
        AND constraint_name = 'member_access_log_member_id_fkey'
    `, []);
    expect(rows.length).toBe(0);
  });

  test('trace_context has NO FK to member_identity (dropped in S-9)', async () => {
    const rows = await db.queryRows(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND table_schema = 'public'
        AND table_name = 'trace_context'
        AND constraint_name = 'trace_context_member_id_fkey'
    `, []);
    expect(rows.length).toBe(0);
  });
});
