/**
 * e2e/helpers/seed.js
 * Database seed and teardown helpers for E2E tests.
 *
 * Two-client strategy:
 *   TEST_CLIENT  — fixed UUIDs, seeded by global-setup, torn down after suite
 *   HOG_CLIENT   — real prod client, test members created by email pattern e2e-test-*@accesssync.test
 *
 * All HOG test members are cleaned up by teardownHogTestMembers().
 * Test client is cleaned up by teardownTestClient() (cascades via FK).
 */

const db = require('./db');

// ── Fixed UUIDs for Test Client (idempotent re-runs) ──────────────────────────
const TEST_CLIENT_ID   = '00000000-e2e0-4000-a000-000000000001';
const TEST_LOCATION_ID = '00000000-e2e0-4000-a000-000000000002';

// Test plan mappings — two plans, one single-member, one multi-member
const TEST_PLAN_INDIVIDUAL_ID = '00000000-e2e0-4000-a000-000000000010';
const TEST_PLAN_COUPLES_ID    = '00000000-e2e0-4000-a000-000000000011';

// HOG client (read-only reference — never deleted by teardown)
const HOG_CLIENT_ID   = '15962eac-c767-46ad-8056-094f35a4a193';
const HOG_LOCATION_ID = '1c6a8aee-4c71-4c11-9e15-5cd8a33ccef0';

// HOG plan_mapping IDs from memory (reference_hog_seed_values.md)
const HOG_PLANS = {
  individual:      '4b6d0144-4ec3-4b88-9191-d6a73fa9e1e3',
  student:         '2dcaf897-f355-42ba-8b73-dff789ed0e94',
  firstResponder:  '7861f180-925b-44d8-80ee-f0a458d8fc06',
  military:        '87e831a4-13bf-40dd-adf6-2a4be47530ee',
  couples:         '16d5654d-b427-4425-a3ec-2ee9f266e57a',
  family:          '0d478601-8e54-4628-ba17-c5e14995b490',
  individualV2:    'd75b1b50-4df5-49f6-819b-42fc13de5bf8',
  couplesV2:       '2c126a17-1bce-4e9e-a8ae-17be588323a3',
  freeService:     'c068eb5f-51bf-40be-a351-47e62b6a8175',
  servicePackage:  '28dd565b-6566-4b3f-a37d-a27aa0e009af',
};

// HOG Wix source plan IDs (Wix-side plan IDs, same as source_plan_id in plan_mappings)
const HOG_SOURCE_PLAN_IDS = {
  individual:     '4b6d0144-4ec3-4b88-9191-d6a73fa9e1e3',
  student:        '2dcaf897-f355-42ba-8b73-dff789ed0e94',
  couples:        '16d5654d-b427-4425-a3ec-2ee9f266e57a',
  family:         '0d478601-8e54-4628-ba17-c5e14995b490',
};

// HOG Kisi hardware group IDs
const HOG_HW_GROUP_ENTRANCE = '838622';
const HOG_HW_GROUP_TEST     = '852557';

// Wix Site ID for HOG — must match clients.source_site_id in Railway DB
const HOG_WIX_SITE_ID = '413432bb-71bc-40ed-a3d4-550bc6841fd0';

// E2E test email domain — all HOG test members use this pattern
const E2E_EMAIL_DOMAIN = 'accesssync.test';
const E2E_EMAIL_PATTERN = `e2e-test-%@${E2E_EMAIL_DOMAIN}`;

// ── Test Client Seed ──────────────────────────────────────────────────────────

async function seedTestClient() {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Client
    await client.query(`
      INSERT INTO clients (id, name, notification_email, hardware_platform, tier)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [TEST_CLIENT_ID, 'E2E_Test_Client', 'e2e@accesssync.test', 'kisi', 'Base']);

    // Location
    await client.query(`
      INSERT INTO locations (id, client_id, name, tier, subscription_status)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO NOTHING
    `, [TEST_LOCATION_ID, TEST_CLIENT_ID, 'E2E Test Location', 'Base', 'active']);

    // connector_subscriptions (no real Kisi key — verifies endpoint fires, no actual write)
    await client.query(`
      INSERT INTO connector_subscriptions
        (client_id, hardware_platform, hardware_api_key, kisi_user_pattern, status)
      VALUES ($1, $2, NULL, $3, $4)
      ON CONFLICT (client_id, hardware_platform) DO NOTHING
    `, [TEST_CLIENT_ID, 'kisi', 'invited', 'active']);

    // billing_subscriptions
    await client.query(`
      INSERT INTO billing_subscriptions
        (client_id, location_id, tier, status)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT DO NOTHING
    `, [TEST_CLIENT_ID, TEST_LOCATION_ID, 'Base', 'active']);

    // Plan mappings — Individual (single member)
    await client.query(`
      INSERT INTO plan_mappings
        (id, client_id, source_plan_id, hardware_group_id, plan_name, door_name,
         location_id, allow_multiple, max_members, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [TEST_PLAN_INDIVIDUAL_ID, TEST_CLIENT_ID, 'test-plan-individual',
        '999999', 'Test Individual', 'Test Door', TEST_LOCATION_ID, false, 1, 'active']);

    // Plan mappings — Couples (multi-member, max 2)
    await client.query(`
      INSERT INTO plan_mappings
        (id, client_id, source_plan_id, hardware_group_id, plan_name, door_name,
         location_id, allow_multiple, max_members, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (id) DO NOTHING
    `, [TEST_PLAN_COUPLES_ID, TEST_CLIENT_ID, 'test-plan-couples',
        '999999', 'Test Couples', 'Test Door', TEST_LOCATION_ID, true, 2, 'active']);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    clientId:        TEST_CLIENT_ID,
    locationId:      TEST_LOCATION_ID,
    planMappings: {
      individual: { id: TEST_PLAN_INDIVIDUAL_ID, sourcePlanId: 'test-plan-individual' },
      couples:    { id: TEST_PLAN_COUPLES_ID,    sourcePlanId: 'test-plan-couples' },
    },
  };
}

async function teardownTestClient() {
  // CASCADE deletes all child rows (member_master, member_access, etc.)
  await db.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
}

// ── HOG Member Seed ───────────────────────────────────────────────────────────

/**
 * Generate a unique E2E test email.
 * Pattern: e2e-test-<suffix>@accesssync.test
 */
function makeE2eEmail(suffix) {
  return `e2e-test-${suffix}@${E2E_EMAIL_DOMAIN}`;
}

/**
 * Generate a unique fake Wix member ID for test use.
 */
function makeWixMemberId(suffix) {
  return `e2e-wix-member-${suffix}`;
}

/**
 * Seed a member_master row under HOG client.
 * Does NOT trigger any Kisi calls — call postWebhook() for full grant flow.
 */
async function seedHogMemberMaster(email, wixMemberId, opts = {}) {
  const row = await db.queryOne(`
    INSERT INTO member_master
      (client_id, source_platform, platform_member_id, email, display_name, source_tag)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (client_id, source_platform, platform_member_id) DO UPDATE
      SET email = EXCLUDED.email
    RETURNING id
  `, [
    HOG_CLIENT_ID,
    'wix',
    wixMemberId,
    email,
    opts.displayName || `E2E Test ${wixMemberId}`,
    'e2e',
  ]);
  return row.id;
}

/**
 * Seed a member_access row under HOG client for a given plan_mapping.
 */
async function seedHogMemberAccess(memberMasterId, planMappingId, opts = {}) {
  const row = await db.queryOne(`
    INSERT INTO member_access
      (member_master_id, client_id, plan_mapping_id, source_platform, platform_member_id,
       status, plan_holder)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (member_master_id, plan_mapping_id) DO UPDATE
      SET status = EXCLUDED.status
    RETURNING id
  `, [
    memberMasterId,
    HOG_CLIENT_ID,
    planMappingId,
    'wix',
    opts.wixMemberId || memberMasterId,
    opts.status || 'active',
    opts.planHolder !== undefined ? opts.planHolder : true,
  ]);
  return row.id;
}

/**
 * Remove all HOG test member rows created by E2E runs.
 * Deletes by email pattern — cascades to member_access, member_billing, member_access_sources.
 */
async function teardownHogTestMembers() {
  await db.query(
    `DELETE FROM member_master WHERE client_id = $1 AND email LIKE $2`,
    [HOG_CLIENT_ID, E2E_EMAIL_PATTERN]
  );
}

// ── Wix Webhook Payload Builders ──────────────────────────────────────────────

/**
 * Build a minimal Wix orderPurchased payload for the given plan and member.
 * Matches the REST webhook format wix-adapter.js expects: data.entity is the Order object.
 */
function buildOrderPurchasedPayload(opts = {}) {
  const orderId      = opts.orderId      || `e2e-order-${Date.now()}`;
  const memberId     = opts.memberId     || makeWixMemberId('default');
  const planId       = opts.planId       || 'test-plan-individual';
  const cycleIndex   = opts.cycleIndex   || 1;

  return {
    eventType: 'wixPricingPlans.orderPurchased',
    data: {
      entity: {
        _id:               orderId,
        planId:            planId,
        planName:          opts.planName || 'Test Plan',
        status:            'ACTIVE',
        lastPaymentStatus: 'PAID',
        subscriptionId:    opts.subscriptionId || `e2e-sub-${Date.now()}`,
        startDate:         opts.startDate || new Date().toISOString(),
        endDate:           opts.endDate   || null,
        currentCycle:      { index: cycleIndex },
        buyer: {
          memberId:  memberId,
          contactId: opts.contactId || memberId,
          email:     opts.email     || makeE2eEmail(memberId),
          fullName:  opts.fullName  || `E2E ${memberId}`,
        },
      },
    },
  };
}

function buildOrderCancelledPayload(opts = {}) {
  const orderId  = opts.orderId  || `e2e-order-${Date.now()}`;
  const memberId = opts.memberId || makeWixMemberId('default');
  const planId   = opts.planId   || 'test-plan-individual';

  return {
    eventType: 'wixPricingPlans.orderCanceled',
    data: {
      entity: {
        _id:               orderId,
        planId:            planId,
        planName:          opts.planName || 'Test Plan',
        status:            'CANCELED',
        lastPaymentStatus: 'PAID',
        buyer: {
          memberId:  memberId,
          contactId: opts.contactId || memberId,
          email:     opts.email     || makeE2eEmail(memberId),
          fullName:  opts.fullName  || `E2E ${memberId}`,
        },
      },
    },
  };
}

function buildOrderPausedPayload(opts = {}) {
  const orderId  = opts.orderId  || `e2e-order-${Date.now()}`;
  const memberId = opts.memberId || makeWixMemberId('default');
  const planId   = opts.planId   || 'test-plan-individual';

  return {
    eventType: 'wixPricingPlans.orderPaused',
    data: {
      entity: {
        _id:    orderId,
        planId: planId,
        status: 'PAUSED',
        buyer:  { memberId, contactId: memberId,
                  email: opts.email || makeE2eEmail(memberId) },
      },
    },
  };
}

function buildOrderStartedPayload(opts = {}) {
  const orderId  = opts.orderId  || `e2e-order-${Date.now()}`;
  const memberId = opts.memberId || makeWixMemberId('default');
  const planId   = opts.planId   || 'test-plan-individual';

  return {
    eventType: 'wixPricingPlans.orderStarted',
    data: {
      entity: {
        _id:               orderId,
        planId:            planId,
        planName:          opts.planName || 'Test Plan',
        status:            'ACTIVE',
        lastPaymentStatus: 'PAID',
        startDate:         opts.startDate || new Date().toISOString(),
        buyer: {
          memberId,
          contactId: memberId,
          email:     opts.email || makeE2eEmail(memberId),
        },
      },
    },
  };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Constants
  TEST_CLIENT_ID,
  TEST_LOCATION_ID,
  TEST_PLAN_INDIVIDUAL_ID,
  TEST_PLAN_COUPLES_ID,
  HOG_CLIENT_ID,
  HOG_LOCATION_ID,
  HOG_PLANS,
  HOG_SOURCE_PLAN_IDS,
  HOG_HW_GROUP_ENTRANCE,
  HOG_HW_GROUP_TEST,
  HOG_WIX_SITE_ID,
  E2E_EMAIL_DOMAIN,
  E2E_EMAIL_PATTERN,

  // Test client lifecycle
  seedTestClient,
  teardownTestClient,

  // HOG member helpers
  seedHogMemberMaster,
  seedHogMemberAccess,
  teardownHogTestMembers,
  makeE2eEmail,
  makeWixMemberId,

  // Payload builders
  buildOrderPurchasedPayload,
  buildOrderCancelledPayload,
  buildOrderPausedPayload,
  buildOrderStartedPayload,
};
