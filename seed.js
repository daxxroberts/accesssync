/**
 * seed.js — AccessSync sample data for House of Gains (HOG)
 *
 * Uses fixed UUIDs so it's safe to run multiple times (ON CONFLICT DO NOTHING).
 * Run via: railway run node seed.js
 */

require('dotenv').config();
const db = require('./db');

// ── Fixed UUIDs ─────────────────────────────────────────────────
const IDS = {
  client:   'a0000001-0000-0000-0000-000000000001',
  loc_fs:   'b0000001-0000-0000-0000-000000000001',  // Fort Smith
  loc_ro:   'b0000001-0000-0000-0000-000000000002',  // Roland

  // Plan mappings
  pm_fs_monthly:  'c0000001-0000-0000-0000-000000000001',
  pm_fs_annual:   'c0000001-0000-0000-0000-000000000002',
  pm_fs_daypass:  'c0000001-0000-0000-0000-000000000003',
  pm_ro_monthly:  'c0000001-0000-0000-0000-000000000004',
  pm_ro_annual:   'c0000001-0000-0000-0000-000000000005',
  pm_ro_daypass:  'c0000001-0000-0000-0000-000000000006',

  // Members (platform_member_id = realistic Wix-style IDs)
  m1:  'd0000001-0000-0000-0000-000000000001',  // Jake Morrison
  m2:  'd0000001-0000-0000-0000-000000000002',  // Sara Rhodes
  m3:  'd0000001-0000-0000-0000-000000000003',  // Amber Knox (error)
  m4:  'd0000001-0000-0000-0000-000000000004',  // Derek Lane
  m5:  'd0000001-0000-0000-0000-000000000005',  // Marcus Webb
  m6:  'd0000001-0000-0000-0000-000000000006',  // Chris Martin
  m7:  'd0000001-0000-0000-0000-000000000007',  // Lisa Torres
  m8:  'd0000001-0000-0000-0000-000000000008',  // Ryan Nash
  m9:  'd0000001-0000-0000-0000-000000000009',  // Priya Singh
  m10: 'd0000001-0000-0000-0000-000000000010', // Ben Okafor
};

async function seed() {
  console.log('[seed] Starting House of Gains sample data...\n');

  // ── 1. Client ──────────────────────────────────────────────────
  await db.query(`
    INSERT INTO clients (id, name, platform, site_id, site_name, hardware_platform, tier, status,
                         notification_email, last_sync_at, site_url, last_wix_webhook_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() - INTERVAL '4 minutes', $10, NOW() - INTERVAL '2 hours')
    ON CONFLICT (id) DO UPDATE SET
      last_sync_at = NOW() - INTERVAL '4 minutes',
      last_wix_webhook_at = NOW() - INTERVAL '2 hours'
  `, [
    IDS.client,
    'House of Gains',
    'wix',
    'hog-wix-site-001',
    'House of Gains',
    'kisi',
    'Pro',
    'active',
    'chad@houseofgains.com',
    'houseofgains.com',
  ]);
  console.log('[seed] ✓ Client: House of Gains');

  // ── 2. Locations ───────────────────────────────────────────────
  await db.query(`
    INSERT INTO locations (id, client_id, name, city, state)
    VALUES
      ($1, $2, 'Fort Smith — Main',  'Fort Smith', 'AR'),
      ($3, $2, 'Roland — Annex',     'Roland',     'AR')
    ON CONFLICT (id) DO NOTHING
  `, [IDS.loc_fs, IDS.client, IDS.loc_ro]);
  console.log('[seed] ✓ Locations: Fort Smith + Roland');

  // ── 3. Plan Mappings ───────────────────────────────────────────
  await db.query(`
    INSERT INTO plan_mappings
      (id, client_id, wix_plan_id, hardware_group_id, plan_name, door_name, status, location_id, tier_name)
    VALUES
      ($1,  $7, 'wix-plan-monthly-001', 'kisi-grp-fs-front',    'Monthly Member', 'Front Door',     'active',   $8, 'Pro'),
      ($2,  $7, 'wix-plan-annual-001',  'kisi-grp-fs-front',    'Annual Member',  'Front Door',     'excluded', $8, 'Pro'),
      ($3,  $7, 'wix-plan-daypass-001', 'kisi-grp-fs-front',    'Day Pass',       'Front Door',     'excluded', $8, 'Pro'),
      ($4,  $7, 'wix-plan-monthly-001', 'kisi-grp-ro-all',      'Monthly Member', '3 doors',        'active',   $9, 'Pro'),
      ($5,  $7, 'wix-plan-annual-001',  'kisi-grp-ro-all',      'Annual Member',  '3 doors',        'active',   $9, 'Pro'),
      ($6,  $7, 'wix-plan-daypass-001', 'kisi-grp-ro-daypass',  'Day Pass',       'Front Door',     'excluded', $9, 'Pro')
    ON CONFLICT (id) DO NOTHING
  `, [
    IDS.pm_fs_monthly, IDS.pm_fs_annual, IDS.pm_fs_daypass,
    IDS.pm_ro_monthly, IDS.pm_ro_annual, IDS.pm_ro_daypass,
    IDS.client, IDS.loc_fs, IDS.loc_ro,
  ]);
  console.log('[seed] ✓ Plan mappings: 6 rows (Fort Smith + Roland)');

  // ── 4. Member Identities ───────────────────────────────────────
  const members = [
    [IDS.m1,  'wix-member-jake-morrison'],
    [IDS.m2,  'wix-member-sara-rhodes'],
    [IDS.m3,  'wix-member-amber-knox'],
    [IDS.m4,  'wix-member-derek-lane'],
    [IDS.m5,  'wix-member-marcus-webb'],
    [IDS.m6,  'wix-member-chris-martin'],
    [IDS.m7,  'wix-member-lisa-torres'],
    [IDS.m8,  'wix-member-ryan-nash'],
    [IDS.m9,  'wix-member-priya-singh'],
    [IDS.m10, 'wix-member-ben-okafor'],
  ];

  for (const [id, platformMemberId] of members) {
    const hardwareUserId = 'kisi-user-' + platformMemberId.slice(11);
    await db.query(`
      INSERT INTO member_identity
        (id, client_id, platform_member_id, source_platform, hardware_platform, hardware_user_id)
      VALUES ($1, $2, $3, 'wix', 'kisi', $4)
      ON CONFLICT (id) DO NOTHING
    `, [id, IDS.client, platformMemberId, hardwareUserId]);
  }
  console.log('[seed] ✓ Member identities: 10 members');

  // ── 5. Member Access States ────────────────────────────────────
  // m3 (Amber Knox) is failed — matches the error queue entry
  const states = [
    [IDS.m1,  'active',  'kisi-ra-jake-001'],
    [IDS.m2,  'active',  'kisi-ra-sara-001'],
    [IDS.m3,  'failed',  null],
    [IDS.m4,  'active',  'kisi-ra-derek-001'],
    [IDS.m5,  'active',  'kisi-ra-marcus-001'],
    [IDS.m6,  'active',  'kisi-ra-chris-001'],
    [IDS.m7,  'active',  'kisi-ra-lisa-001'],
    [IDS.m8,  'active',  'kisi-ra-ryan-001'],
    [IDS.m9,  'active',  'kisi-ra-priya-001'],
    [IDS.m10, 'active',  'kisi-ra-ben-001'],
  ];

  for (const [memberId, status, roleAssignmentId] of states) {
    await db.query(`
      INSERT INTO member_access_state
        (member_id, client_id, status, role_assignment_id, provisioned_at)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '3 days')
      ON CONFLICT (member_id) DO UPDATE SET status = $3
    `, [memberId, IDS.client, status, roleAssignmentId]);
  }
  console.log('[seed] ✓ Member access states: 9 active, 1 failed (Amber Knox)');

  // ── 6. Member Access Log ───────────────────────────────────────
  const logEntries = [
    [IDS.m1,  'provisioned',          'kisi_app',  '2 minutes ago'],
    [IDS.m2,  'provisioned',          'kisi_app',  '11 minutes ago'],
    [IDS.m3,  'revoked',              null,        '1 hour ago'],
    [IDS.m4,  'provisioning_started', null,        '2 hours ago'],
    [IDS.m5,  'provisioned',          'kisi_app',  '3 hours ago'],
    [IDS.m6,  'provisioned',          'kisi_app',  '8 minutes ago'],
    [IDS.m7,  'provisioned',          'kisi_app',  '22 minutes ago'],
    [IDS.m8,  'provisioned',          'kisi_app',  '1 hour ago'],
    [IDS.m9,  'provisioned',          'kisi_app',  '4 hours ago'],
    [IDS.m10, 'provisioned',          'kisi_app',  '5 hours ago'],
  ];

  const intervalMap = {
    '2 minutes ago':  '2 minutes',
    '11 minutes ago': '11 minutes',
    '1 hour ago':     '1 hour',
    '2 hours ago':    '2 hours',
    '3 hours ago':    '3 hours',
    '8 minutes ago':  '8 minutes',
    '22 minutes ago': '22 minutes',
    '4 hours ago':    '4 hours',
    '5 hours ago':    '5 hours',
  };

  for (const [memberId, eventType, credentialType, timeAgo] of logEntries) {
    const interval = intervalMap[timeAgo] || '1 hour';
    await db.query(`
      INSERT INTO member_access_log
        (member_id, client_id, event_type, credential_type, created_at)
      VALUES ($1, $2, $3, $4, NOW() - INTERVAL '${interval}')
    `, [memberId, IDS.client, eventType, credentialType]);
  }
  console.log('[seed] ✓ Access log: 10 events');

  // ── 7. Error Queue (1 active error — Amber Knox, Fort Smith) ──
  await db.query(`
    INSERT INTO error_queue
      (id, client_id, member_id, event_type, payload, error_reason,
       retry_count, status, location_id, plan_name, door_name)
    VALUES (
      'e0000001-0000-0000-0000-000000000001',
      $1, $2,
      'plan.purchased',
      '{"planId":"wix-plan-monthly-001","memberId":"wix-member-amber-knox"}',
      '422 on POST /role_assignments. User created (kisi_user_id stored), group assignment incomplete. Likely cause: group capacity or permission scope. 2 retries failed.',
      2,
      'failed',
      $3,
      'Monthly Member',
      'Front Door'
    )
    ON CONFLICT (id) DO NOTHING
  `, [IDS.client, IDS.m3, IDS.loc_fs]);
  console.log('[seed] ✓ Error queue: 1 error (Amber Knox — Fort Smith)');

  // ── 8. Client Activity Summary (DR-024) ───────────────────────
  try {
    await db.query(`
      INSERT INTO client_activity_summary
        (client_id, summary_date, events_received, grants_completed, revokes_completed, errors_count)
      VALUES
        ($1, CURRENT_DATE,     12, 9, 1, 1),
        ($1, CURRENT_DATE - 1, 8,  7, 0, 0),
        ($1, CURRENT_DATE - 2, 15, 14, 1, 0)
      ON CONFLICT (client_id, summary_date) DO NOTHING
    `, [IDS.client]);
    console.log('[seed] ✓ Activity summary: 3 days');
  } catch (err) {
    console.log('[seed] ⚠ Skipped activity summary — table not yet migrated (run CREATE TABLE client_activity_summary migration first)');
  }

  console.log('\n[seed] ✅ Done. House of Gains data loaded.');
  console.log(`\n[seed] Dashboard URL:`);
  console.log(`  https://accesssync-admin.up.railway.app/dashboard.html?client=${IDS.client}`);

  await db.pool.end();
}

seed().catch(err => {
  console.error('[seed] FAILED:', err.message);
  process.exit(1);
});
