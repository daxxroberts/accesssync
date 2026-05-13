/**
 * seed.js — AccessSync comprehensive demo data for House of Gains (HOG)
 *
 * TRUNCATES all tables then inserts demo data that populates every admin screen.
 * Uses fixed UUIDs so it's safe to run multiple times.
 * Run via: railway run node seed.js
 *
 * ⚠️  PARTIALLY UPDATED FOR POST-S-9 SCHEMA (2026-05-12).
 * Client + connector_subscriptions + locations + billing_subscriptions sections
 * are clean. Plan mappings clean.
 *
 * Member fixture sections (5: member identities, 6: member access states,
 * 7: member role assignments) STILL REFERENCE RETIRED TABLES and will fail.
 * Filed as F-22 — rewrite member fixtures using member_master + member_access +
 * member_access_sources before next dev seed run.
 *
 * Until then: this script will fail at section 5. Either skip member sections
 * for now, or seed members via Wix webhook replay (see Phase 7 onboarding test).
 */

require('dotenv').config();
const db = require('./db');

// ── Fixed UUIDs ─────────────────────────────────────────────────
const CLIENT = 'a0000001-0000-0000-0000-000000000001';

const LOC = {
  fs: 'b0000001-0000-0000-0000-000000000001', // Fort Smith
  ro: 'b0000001-0000-0000-0000-000000000002', // Roland
  fv: 'b0000001-0000-0000-0000-000000000003', // Fayetteville
};

const PM = {
  fs_monthly:  'c0000001-0000-0000-0000-000000000001',
  fs_annual:   'c0000001-0000-0000-0000-000000000002',
  fs_daypass:  'c0000001-0000-0000-0000-000000000003',
  ro_monthly:  'c0000001-0000-0000-0000-000000000004',
  ro_annual:   'c0000001-0000-0000-0000-000000000005',
  ro_family:   'c0000001-0000-0000-0000-000000000006',
  fv_monthly:  'c0000001-0000-0000-0000-000000000007',
  fv_dropin:   'c0000001-0000-0000-0000-000000000008',
};

// Members: d0000001-...-01 through -20
const M = {};
for (let i = 1; i <= 20; i++) M[`m${i}`] = `d0000001-0000-0000-0000-${String(i).padStart(12, '0')}`;

// Member access state IDs
const MAS = {};
for (let i = 1; i <= 20; i++) MAS[`s${i}`] = `f0000001-0000-0000-0000-${String(i).padStart(12, '0')}`;

// Member role assignment IDs
const MRA = {};
for (let i = 1; i <= 20; i++) MRA[`r${i}`] = `f1000001-0000-0000-0000-${String(i).padStart(12, '0')}`;

// Plan mapping group IDs
const PMG = {
  family_weights: 'f2000001-0000-0000-0000-000000000001',
  family_yoga:    'f2000001-0000-0000-0000-000000000002',
};

// Error queue IDs
const ERR = {
  e1: 'e0000001-0000-0000-0000-000000000001',
  e2: 'e0000001-0000-0000-0000-000000000002',
  e3: 'e0000001-0000-0000-0000-000000000003',
};

// Config alert IDs
const ALERT = {
  a1: 'e1000001-0000-0000-0000-000000000001',
  a2: 'e1000001-0000-0000-0000-000000000002',
};

// Webhook log IDs
const WH = {};
for (let i = 1; i <= 10; i++) WH[`w${i}`] = `e2000001-0000-0000-0000-${String(i).padStart(12, '0')}`;

// Adapter admin log IDs
const AAL = {};
for (let i = 1; i <= 5; i++) AAL[`a${i}`] = `e3000001-0000-0000-0000-${String(i).padStart(12, '0')}`;

// ── Members definition ──────────────────────────────────────────
const MEMBERS = [
  // Fort Smith — active (1-8)
  { id: M.m1,  pid: 'wix-member-jake-morrison',  loc: LOC.fs, status: 'active',           pm: PM.fs_monthly, ra: 'kisi-ra-jake-001' },
  { id: M.m2,  pid: 'wix-member-sara-rhodes',     loc: LOC.fs, status: 'active',           pm: PM.fs_monthly, ra: 'kisi-ra-sara-001' },
  { id: M.m3,  pid: 'wix-member-derek-lane',      loc: LOC.fs, status: 'active',           pm: PM.fs_monthly, ra: 'kisi-ra-derek-001' },
  { id: M.m4,  pid: 'wix-member-marcus-webb',     loc: LOC.fs, status: 'active',           pm: PM.fs_annual,  ra: 'kisi-ra-marcus-001' },
  { id: M.m5,  pid: 'wix-member-chris-martin',    loc: LOC.fs, status: 'active',           pm: PM.fs_annual,  ra: 'kisi-ra-chris-001' },
  { id: M.m6,  pid: 'wix-member-lisa-torres',     loc: LOC.fs, status: 'active',           pm: PM.fs_monthly, ra: 'kisi-ra-lisa-001' },
  { id: M.m7,  pid: 'wix-member-ryan-nash',       loc: LOC.fs, status: 'active',           pm: PM.fs_monthly, ra: 'kisi-ra-ryan-001' },
  { id: M.m8,  pid: 'wix-member-priya-singh',     loc: LOC.fs, status: 'active',           pm: PM.fs_annual,  ra: 'kisi-ra-priya-001' },
  // Fort Smith — error + pending (9-10)
  { id: M.m9,  pid: 'wix-member-amber-knox',      loc: LOC.fs, status: 'failed',           pm: PM.fs_monthly, ra: null },
  { id: M.m10, pid: 'wix-member-ben-okafor',      loc: LOC.fs, status: 'pending_hardware', pm: PM.fs_monthly, ra: null },
  // Roland — active (11-16)
  { id: M.m11, pid: 'wix-member-noah-blake',      loc: LOC.ro, status: 'active',           pm: PM.ro_monthly, ra: 'kisi-ra-noah-001' },
  { id: M.m12, pid: 'wix-member-emma-chen',       loc: LOC.ro, status: 'active',           pm: PM.ro_monthly, ra: 'kisi-ra-emma-001' },
  { id: M.m13, pid: 'wix-member-liam-foster',     loc: LOC.ro, status: 'active',           pm: PM.ro_annual,  ra: 'kisi-ra-liam-001' },
  { id: M.m14, pid: 'wix-member-olivia-grant',    loc: LOC.ro, status: 'active',           pm: PM.ro_annual,  ra: 'kisi-ra-olivia-001' },
  { id: M.m15, pid: 'wix-member-ethan-price',     loc: LOC.ro, status: 'active',           pm: PM.ro_family,  ra: 'kisi-ra-ethan-001' },
  { id: M.m16, pid: 'wix-member-ava-reyes',       loc: LOC.ro, status: 'active',           pm: PM.ro_family,  ra: 'kisi-ra-ava-001' },
  // Roland — pending + suspended (17-18)
  { id: M.m17, pid: 'wix-member-jordan-kelly',    loc: LOC.ro, status: 'pending_hardware', pm: PM.ro_monthly, ra: null },
  { id: M.m18, pid: 'wix-member-taylor-morgan',   loc: LOC.ro, status: 'suspended',        pm: PM.ro_monthly, ra: null },
  // Fayetteville — active at lapsed location (19-20)
  { id: M.m19, pid: 'wix-member-kai-brooks',      loc: LOC.fv, status: 'active',           pm: PM.fv_monthly, ra: 'kisi-ra-kai-001' },
  { id: M.m20, pid: 'wix-member-maya-watts',      loc: LOC.fv, status: 'active',           pm: PM.fv_monthly, ra: 'kisi-ra-maya-001' },
];

async function seed() {
  console.log('[seed] ════════════════════════════════════════════');
  console.log('[seed] AccessSync — Comprehensive Demo Data Seed');
  console.log('[seed] ════════════════════════════════════════════\n');

  // ── 0. TRUNCATE all tables ────────────────────────────────────
  console.log('[seed] Clearing all tables...');
  await db.query(`
    TRUNCATE TABLE
      client_activity_summary,
      config_alert_log,
      adapter_admin_log,
      webhook_log,
      processed_event_ids,
      error_queue,
      member_access_log,
      member_access_sources,
      member_access,
      member_billing,
      member_master,
      plan_mapping_groups,
      plan_mappings,
      billing_subscriptions,
      connector_subscriptions,
      locations,
      clients
    CASCADE
  `);
  console.log('[seed] ✓ All tables truncated\n');

  // ── 1. Client ─────────────────────────────────────────────────
  await db.query(`
    INSERT INTO clients (id, name, platform, source_site_id, source_site_name, status,
                         notification_email, last_sync_at, source_site_url, last_webhook_at)
    VALUES ($1, 'House of Gains', 'wix', 'hog-wix-site-001', 'House of Gains', 'active',
            'chad@houseofgains.com', NOW() - INTERVAL '4 minutes', 'houseofgains.com', NOW() - INTERVAL '2 hours')
  `, [CLIENT]);
  console.log('[seed] ✓ Client: House of Gains');

  // ── 1b. Connector subscription (hardware platform) ────────────
  await db.query(`
    INSERT INTO connector_subscriptions (client_id, hardware_platform, status)
    VALUES ($1, 'kisi', 'active')
  `, [CLIENT]);
  console.log('[seed] ✓ Connector: Kisi');

  // ── 2. Locations ──────────────────────────────────────────────
  await db.query(`
    INSERT INTO locations (id, client_id, name, city, state, notification_email)
    VALUES
      ($1, $4, 'Fort Smith — Main',       'Fort Smith',   'AR', 'fortsmith@houseofgains.com'),
      ($2, $4, 'Roland — Annex',          'Roland',       'AR', NULL),
      ($3, $4, 'Fayetteville — Downtown', 'Fayetteville', 'AR', 'fayetteville@houseofgains.com')
  `, [LOC.fs, LOC.ro, LOC.fv, CLIENT]);
  console.log('[seed] ✓ Locations: Fort Smith, Roland, Fayetteville');

  // ── 2b. Billing subscriptions (per-location tier + status) ───
  await db.query(`
    INSERT INTO billing_subscriptions (client_id, location_id, tier, status, subscribed_at)
    VALUES
      ($4, $1, 'Pro',  'active',  NOW() - INTERVAL '90 days'),
      ($4, $2, 'Pro',  'active',  NOW() - INTERVAL '60 days'),
      ($4, $3, 'Base', 'lapsed',  NOW() - INTERVAL '120 days')
  `, [LOC.fs, LOC.ro, LOC.fv, CLIENT]);
  console.log('[seed] ✓ Billing subscriptions: 2 active, 1 lapsed');

  // ── 3. Plan Mappings ──────────────────────────────────────────
  await db.query(`
    INSERT INTO plan_mappings
      (id, client_id, source_plan_id, hardware_group_id, plan_name, door_name, status, location_id, tier_name, access_type, allow_multiple, max_members)
    VALUES
      ($1,  $9,  'wix-plan-monthly-001', 'kisi-grp-fs-front',    'Monthly Member',  'Front Door',      'active',   $10, 'Pro',  'group', false, 1),
      ($2,  $9,  'wix-plan-annual-001',  'kisi-grp-fs-front',    'Annual Member',   'Front Door',      'active',   $10, 'Pro',  'group', false, 1),
      ($3,  $9,  'wix-plan-daypass-001', 'kisi-grp-fs-front',    'Day Pass',        'Front Door',      'excluded', $10, 'Pro',  'group', false, 1),
      ($4,  $9,  'wix-plan-monthly-001', 'kisi-grp-ro-all',      'Monthly Member',  'All Access',      'active',   $11, 'Pro',  'group', false, 1),
      ($5,  $9,  'wix-plan-annual-001',  'kisi-grp-ro-all',      'Annual Member',   'All Access',      'active',   $11, 'Pro',  'group', false, 1),
      ($6,  $9,  'wix-plan-family-001',  NULL,                    'Family Monthly',  NULL,              'active',   $11, 'Pro',  'group', true,  5),
      ($7,  $9,  'wix-plan-monthly-001', 'kisi-grp-fv-main',     'Monthly Member',  'Main Entrance',   'active',   $12, 'Base', 'group', false, 1),
      ($8,  $9,  'wix-plan-dropin-001',  'kisi-grp-fv-main',     'Drop-In',         'Main Entrance',   'excluded', $12, 'Base', 'group', false, 1)
  `, [
    PM.fs_monthly, PM.fs_annual, PM.fs_daypass,
    PM.ro_monthly, PM.ro_annual, PM.ro_family,
    PM.fv_monthly, PM.fv_dropin,
    CLIENT, LOC.fs, LOC.ro, LOC.fv,
  ]);
  console.log('[seed] ✓ Plan mappings: 8 rows (3 FS, 3 RO, 2 FV)');

  // ── 4. Plan Mapping Groups (multi-group for Family plan) ──────
  await db.query(`
    INSERT INTO plan_mapping_groups (id, mapping_id, hardware_group_id, door_name)
    VALUES
      ($1, $3, 'kisi-grp-ro-weights', 'Weight Room'),
      ($2, $3, 'kisi-grp-ro-yoga',    'Yoga Studio')
  `, [PMG.family_weights, PMG.family_yoga, PM.ro_family]);
  console.log('[seed] ✓ Plan mapping groups: Family Monthly → Weight Room + Yoga Studio');

  // ── 5. Member Identities ──────────────────────────────────────
  for (const m of MEMBERS) {
    const hwUser = 'kisi-user-' + m.pid.slice(11);
    await db.query(`
      INSERT INTO member_identity
        (id, client_id, platform_member_id, source_platform, hardware_platform, hardware_user_id)
      VALUES ($1, $2, $3, 'wix', 'kisi', $4)
    `, [m.id, CLIENT, m.pid, m.status === 'pending_hardware' ? null : hwUser]);
  }
  console.log('[seed] ✓ Member identities: 20 members');

  // ── 6. Member Access States ───────────────────────────────────
  for (const m of MEMBERS) {
    const pendingPlan = m.status === 'pending_hardware' ? 'wix-plan-monthly-001' : null;
    await db.query(`
      INSERT INTO member_access_state
        (id, member_id, client_id, status, role_assignment_id, provisioned_at, pending_plan_id, updated_at)
      VALUES ($1, $2, $3, $4, $5, ${m.status === 'active' ? "NOW() - INTERVAL '3 days'" : 'NULL'}, $6, NOW() - INTERVAL '${Math.floor(Math.random() * 72) + 1} hours')
    `, [MAS[`s${MEMBERS.indexOf(m) + 1}`], m.id, CLIENT, m.status, m.ra, pendingPlan]);
  }
  console.log('[seed] ✓ Member access states: 14 active, 1 failed, 2 pending_hardware, 1 suspended, 2 active@lapsed');

  // ── 7. Member Role Assignments ────────────────────────────────
  let raCount = 0;
  for (let i = 0; i < MEMBERS.length; i++) {
    const m = MEMBERS[i];
    if (!m.ra) continue; // skip failed/pending/suspended
    await db.query(`
      INSERT INTO member_role_assignments (id, member_id, mapping_id, role_assignment_id, hardware_group_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [
      MRA[`r${i + 1}`], m.id, m.pm, m.ra,
      m.pm === PM.ro_family ? 'kisi-grp-ro-weights' : null,
    ]);
    raCount++;
  }
  console.log(`[seed] ✓ Member role assignments: ${raCount} rows`);

  // ── 8. Member Access Log (40+ events over 30 days) ────────────
  const eventTypes = ['provisioned', 'provisioning_started', 'provisioning_failed', 'revoked', 'disabled', 'restored'];
  const credTypes = ['kisi_app', 'pin', 'qr', null];
  const errorCodes = [null, null, null, 'CRED_001', 'NET_TIMEOUT', 'RATE_LIMITED'];
  let logCount = 0;

  for (const m of MEMBERS) {
    // Each member gets 2-3 log entries
    const numEntries = m.status === 'failed' ? 3 : m.status === 'active' ? 2 : 1;
    for (let j = 0; j < numEntries; j++) {
      const daysAgo = Math.floor(Math.random() * 28) + 1;
      const hoursAgo = Math.floor(Math.random() * 24);
      let evType, credType, errCode;

      if (j === 0 && m.status === 'active') {
        evType = 'provisioned';
        credType = 'kisi_app';
        errCode = null;
      } else if (j === 0 && m.status === 'failed') {
        evType = 'provisioning_failed';
        credType = null;
        errCode = 'CRED_001';
      } else if (j === 1 && m.status === 'failed') {
        evType = 'provisioning_started';
        credType = null;
        errCode = null;
      } else if (m.status === 'suspended') {
        evType = 'disabled';
        credType = null;
        errCode = null;
      } else {
        evType = eventTypes[Math.floor(Math.random() * eventTypes.length)];
        credType = credTypes[Math.floor(Math.random() * credTypes.length)];
        errCode = evType === 'provisioning_failed' ? errorCodes[Math.floor(Math.random() * errorCodes.length)] : null;
      }

      await db.query(`
        INSERT INTO member_access_log (member_id, client_id, event_type, credential_type, error_code, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW() - INTERVAL '${daysAgo} days' - INTERVAL '${hoursAgo} hours')
      `, [m.id, CLIENT, evType, credType, errCode]);
      logCount++;
    }
  }
  console.log(`[seed] ✓ Access log: ${logCount} events across 30 days`);

  // ── 9. Error Queue (3 active errors) ──────────────────────────
  await db.query(`
    INSERT INTO error_queue
      (id, client_id, member_id, event_type, payload, error_reason, retry_count, status, location_id, plan_name, door_name, created_at)
    VALUES
      ($1, $4, $5, 'plan.purchased',
       '{"planId":"wix-plan-monthly-001","memberId":"wix-member-amber-knox"}',
       '422 on POST /role_assignments. User created (kisi_user_id stored), group assignment incomplete. Likely cause: group capacity or permission scope. 2 retries failed.',
       2, 'failed', $6, 'Monthly Member', 'Front Door', NOW() - INTERVAL '6 hours'),
      ($2, $4, $7, 'plan.purchased',
       '{"planId":"wix-plan-monthly-001","memberId":"wix-member-jordan-kelly"}',
       '401 Unauthorized — API key expired or revoked. Hardware platform rejected the request. Verify the Kisi API key is valid.',
       1, 'failed', $8, 'Monthly Member', 'All Access', NOW() - INTERVAL '3 hours'),
      ($3, $4, $9, 'plan.purchased',
       '{"planId":"wix-plan-monthly-001","memberId":"wix-member-kai-brooks"}',
       '503 Service Unavailable — Kisi API temporarily unreachable. This is usually transient. Auto-retry scheduled.',
       0, 'failed', $10, 'Monthly Member', 'Main Entrance', NOW() - INTERVAL '45 minutes')
  `, [ERR.e1, ERR.e2, ERR.e3, CLIENT, M.m9, LOC.fs, M.m17, LOC.ro, M.m19, LOC.fv]);
  console.log('[seed] ✓ Error queue: 3 errors (422, 401, 503)');

  // ── 10. Config Alert Log ──────────────────────────────────────
  await db.query(`
    INSERT INTO config_alert_log
      (id, client_id, alert_type, plan_mapping_id, hardware_ref, affected_member_count, created_at, last_seen_at)
    VALUES
      ($1, $3, 'missing_group',        $4, 'kisi-grp-fs-front', 3, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 hour'),
      ($2, $3, 'expired_credentials',  $5, 'kisi-grp-ro-all',   1, NOW() - INTERVAL '12 hours', NOW() - INTERVAL '30 minutes')
  `, [ALERT.a1, ALERT.a2, CLIENT, PM.fs_monthly, PM.ro_monthly]);
  console.log('[seed] ✓ Config alerts: 2 (missing_group + expired_credentials)');

  // ── 11. Client Activity Summary (7 days) ──────────────────────
  const activityData = [
    [0, 14, 11, 1, 2],  // today
    [1, 12, 10, 1, 1],
    [2, 15, 12, 2, 1],
    [3, 8,  7,  0, 0],
    [4, 11, 9,  1, 1],
    [5, 13, 11, 1, 0],
    [6, 10, 8,  0, 2],  // 6 days ago
  ];
  for (const [daysAgo, events, grants, revokes, errors] of activityData) {
    await db.query(`
      INSERT INTO client_activity_summary
        (client_id, summary_date, events_received, grants_completed, revokes_completed, errors_count, updated_at)
      VALUES ($1, CURRENT_DATE - $2::int, $3, $4, $5, $6, NOW())
    `, [CLIENT, daysAgo, events, grants, revokes, errors]);
  }
  console.log('[seed] ✓ Activity summary: 7 days');

  // ── 12. Webhook Log (10 entries) ──────────────────────────────
  const webhookEvents = [
    { evType: 'plan.purchased',    hmac: 'accepted', dedup: 'new',       daysAgo: 0, hoursAgo: 1 },
    { evType: 'plan.purchased',    hmac: 'accepted', dedup: 'new',       daysAgo: 0, hoursAgo: 3 },
    { evType: 'plan.cancelled',    hmac: 'accepted', dedup: 'new',       daysAgo: 1, hoursAgo: 5 },
    { evType: 'member.updated',    hmac: 'accepted', dedup: 'new',       daysAgo: 1, hoursAgo: 8 },
    { evType: 'plan.purchased',    hmac: 'accepted', dedup: 'duplicate', daysAgo: 2, hoursAgo: 2 },
    { evType: 'bookings.created',  hmac: 'accepted', dedup: 'new',       daysAgo: 2, hoursAgo: 14 },
    { evType: 'plan.purchased',    hmac: 'rejected', dedup: null,        daysAgo: 3, hoursAgo: 6, error: 'HMAC signature mismatch — expected sha256=abc123, received sha256=def456' },
    { evType: 'plan.purchased',    hmac: 'accepted', dedup: 'new',       daysAgo: 4, hoursAgo: 10 },
    { evType: 'member.updated',    hmac: 'rejected', dedup: null,        daysAgo: 5, hoursAgo: 3, error: 'Missing X-Wix-Signature header' },
    { evType: 'plan.purchased',    hmac: 'accepted', dedup: 'new',       daysAgo: 6, hoursAgo: 7 },
  ];

  for (let i = 0; i < webhookEvents.length; i++) {
    const w = webhookEvents[i];
    const eventId = `wix-evt-${String(i + 1).padStart(4, '0')}`;
    await db.query(`
      INSERT INTO webhook_log
        (id, event_id, client_id, received_at, hmac_status, dedup_status, event_type, error_detail,
         raw_payload, normalized_payload)
      VALUES ($1, $2, $3, NOW() - INTERVAL '${w.daysAgo} days' - INTERVAL '${w.hoursAgo} hours',
              $4, $5, $6, $7,
              '{"source":"demo","type":"${w.evType}"}',
              '{"eventType":"${w.evType}","memberId":"wix-member-demo-${i + 1}","planId":"wix-plan-monthly-001"}')
    `, [WH[`w${i + 1}`], eventId, CLIENT, w.hmac, w.dedup, w.evType, w.error || null]);
  }
  console.log('[seed] ✓ Webhook log: 10 entries (8 accepted, 2 rejected)');

  // ── 13. Adapter Admin Log (5 audit entries) ───────────────────
  await db.query(`
    INSERT INTO adapter_admin_log
      (id, client_id, event_type, admin_action, details, target_entity, target_id, result, configured_at, created_at)
    VALUES
      ($1, $6, 'admin_audit', 'api_key_rotated',
       '{"reason":"Quarterly key rotation","rotated_by":"chad@houseofgains.com"}',
       'client', $6, 'success', NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days'),
      ($2, $6, 'admin_audit', 'plan_mapping_edited',
       '{"mapping_id":"${PM.fs_monthly}","changes":{"door_name":"Front Door","status":"active"}}',
       'plan_mapping', '${PM.fs_monthly}', 'success', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),
      ($3, $6, 'admin_audit', 'client_archived',
       '{"reason":"Temporary pause for location renovation"}',
       'client', $6, 'success', NOW() - INTERVAL '45 days', NOW() - INTERVAL '45 days'),
      ($4, $6, 'admin_audit', 'client_restored',
       '{"reason":"Renovation complete, resuming operations"}',
       'client', $6, 'success', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days'),
      ($5, $6, 'admin_audit', 'api_key_rotated',
       '{"reason":"New Kisi account setup for Roland location","rotated_by":"daxx@accesssync.com"}',
       'location', '${LOC.ro}', 'success', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days')
  `, [AAL.a1, AAL.a2, AAL.a3, AAL.a4, AAL.a5, CLIENT]);
  console.log('[seed] ✓ Adapter admin log: 5 audit entries');

  // ── 14. Processed Event IDs (matches webhook log) ─────────────
  for (let i = 0; i < webhookEvents.length; i++) {
    const w = webhookEvents[i];
    if (w.hmac === 'rejected') continue; // rejected events aren't processed
    const eventId = `wix-evt-${String(i + 1).padStart(4, '0')}`;
    await db.query(`
      INSERT INTO processed_event_ids (event_id, client_id, processed_at)
      VALUES ($1, $2, NOW() - INTERVAL '${w.daysAgo} days' - INTERVAL '${w.hoursAgo} hours')
    `, [eventId, CLIENT]);
  }
  console.log('[seed] ✓ Processed event IDs: 8 entries (matching accepted webhooks)');

  // ── Summary ───────────────────────────────────────────────────
  console.log('\n[seed] ════════════════════════════════════════════');
  console.log('[seed] ✅ Demo data loaded successfully!');
  console.log('[seed] ════════════════════════════════════════════');
  console.log(`[seed]   Client:       House of Gains`);
  console.log(`[seed]   Locations:    3 (2 active, 1 lapsed)`);
  console.log(`[seed]   Plans:        8 mappings (incl. multi-group Family)`);
  console.log(`[seed]   Members:      20 (14 active, 1 failed, 2 pending, 1 suspended, 2 active@lapsed)`);
  console.log(`[seed]   Access log:   ${logCount} events (30-day spread)`);
  console.log(`[seed]   Errors:       3 (422, 401, 503)`);
  console.log(`[seed]   Alerts:       2 (missing_group, expired_credentials)`);
  console.log(`[seed]   Webhooks:     10 (8 accepted, 2 rejected)`);
  console.log(`[seed]   Activity:     7 days of summaries`);
  console.log(`[seed]   Audit log:    5 admin actions`);
  console.log(`\n[seed] Dashboard URL:`);
  console.log(`  https://accesssync-admin.up.railway.app/dashboard?clientId=${CLIENT}`);

  await db.pool.end();
}

seed().catch(err => {
  console.error('[seed] ❌ FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
