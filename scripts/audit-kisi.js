/**
 * audit-kisi.js
 * Live audit of a single member against Kisi — resolves hardware_user_id from
 * member_identity, then hits Kisi to confirm user existence + role assignments,
 * cross-referencing against this client's active plan_mappings.
 *
 * Usage (from repo root):
 *   DATABASE_URL=<public-proxy> \
 *   API_KEY_ENCRYPTION_KEY=<key> \
 *   node scripts/audit-kisi.js [platformMemberId]
 *
 * Defaults to the member under investigation (7af07f2c-6c9b-4180-9c79-6697e1d673a9).
 */

const db = require('../db');
const { decryptApiKey } = require('../core/crypto-utils');
const kisiConnector = require('../adapters/kisi/kisi-connector');

const PMID = process.argv[2] || '7af07f2c-6c9b-4180-9c79-6697e1d673a9';

function header(title) {
  console.log(`\n=== ${title} ===`);
}

(async () => {
  header(`Auditing platform_member_id = ${PMID}`);

  const identRow = (await db.query(
    `SELECT mi.*, c.hardware_api_key AS client_api_key, c.name AS client_name
     FROM member_identity mi
     JOIN clients c ON c.id = mi.client_id
     WHERE mi.platform_member_id = $1 OR mi.id::text = $1`,
    [PMID]
  )).rows[0];

  if (!identRow) {
    console.log('RESULT: member NOT FOUND in member_identity — pipeline never reached Standard Adapter resolveIdentity');
    console.log('  Next check: webhook_log (did the webhook arrive?) and error_queue (did the job fail before identity?)');
    process.exit(0);
  }

  console.log('member_identity:', {
    client_id:          identRow.client_id,
    client_name:        identRow.client_name,
    platform_member_id: identRow.platform_member_id,
    source_platform:    identRow.source_platform,
    hardware_platform:  identRow.hardware_platform,
    hardware_user_id:   identRow.hardware_user_id,
    created_at:         identRow.created_at,
    updated_at:         identRow.updated_at,
  });

  if (!identRow.hardware_user_id) {
    console.log('\nRESULT: member_identity exists but hardware_user_id IS NULL');
    console.log('  Kisi user was never created OR the row was purged (OB-83 stale assignment cleanup)');
    console.log('  Next check: diagnostic_log for adapter.identity_creating / adapter.identity_replaced events');
    process.exit(0);
  }

  if (!identRow.client_api_key) {
    console.log('\nRESULT: client has no hardware_api_key — cannot query Kisi');
    process.exit(0);
  }

  const apiKey = decryptApiKey(identRow.client_api_key);

  // 1. Does the Kisi user still exist?
  header(`Kisi GET /users/${identRow.hardware_user_id}`);
  let userResp;
  try {
    userResp = await kisiConnector.makeRequest(`/users/${identRow.hardware_user_id}`, { method: 'GET' }, apiKey);
    console.log('kisi.user:', {
      id:    userResp.id,
      name:  userResp.name,
      email: userResp.email,
      image: userResp.image ? '[present]' : null,
    });
  } catch (err) {
    console.log('kisi.user ERROR:', err.statusCode, err.code, err.message);
    if (err.statusCode === 404) {
      console.log('  Kisi user was DELETED server-side — member_identity.hardware_user_id points at a ghost');
      console.log('  Next grant on this member should self-heal (OB-83 purge then re-create)');
    }
  }

  // 2. What role assignments does this user currently hold?
  header(`Kisi GET /role_assignments?user_id=${identRow.hardware_user_id}`);
  let roleAssignments = [];
  try {
    const res = await kisiConnector.makeRequest(
      `/role_assignments?user_id=${identRow.hardware_user_id}&limit=200`,
      { method: 'GET' },
      apiKey
    );
    roleAssignments = Array.isArray(res) ? res : (res.role_assignments || []);
    console.log(`kisi.role_assignments: ${roleAssignments.length} found`);
    for (const ra of roleAssignments) {
      console.log(`  - id=${ra.id} group_id=${ra.group_id || ra.groupId} valid_until=${ra.valid_until || 'permanent'}`);
    }
  } catch (err) {
    console.log('kisi.role_assignments ERROR:', err.statusCode, err.code, err.message);
  }

  // 3. What groups does this client's plan mappings target?
  header(`AccessSync plan_mappings for client ${identRow.client_name}`);
  const mappings = (await db.query(
    `SELECT pm.id, pm.source_plan_id, pm.plan_name, pm.hardware_group_id, pm.door_name, pm.access_type, pm.status
     FROM plan_mappings pm
     WHERE pm.client_id = $1 AND pm.status = 'active'
     ORDER BY pm.created_at ASC`,
    [identRow.client_id]
  )).rows;
  console.log(`active mappings: ${mappings.length}`);
  for (const m of mappings) {
    console.log(`  - plan=${m.plan_name || '[unnamed]'} source_plan_id=${m.source_plan_id} group=${m.hardware_group_id} door_name=${m.door_name || '(group-only)'}`);
  }

  // 4. Cross-reference — is this member in every group their plan should grant?
  header('Cross-reference: Kisi membership vs AccessSync mappings');
  const kisiGroupIds = new Set(roleAssignments.map(ra => String(ra.group_id || ra.groupId)));
  const mappedGroupIds = new Set(mappings.map(m => String(m.hardware_group_id)).filter(Boolean));
  const missing = [...mappedGroupIds].filter(g => !kisiGroupIds.has(g));
  const extra   = [...kisiGroupIds].filter(g => !mappedGroupIds.has(g));
  console.log(`mapped groups (expected):   ${[...mappedGroupIds].join(', ') || '(none)'}`);
  console.log(`kisi groups (actual):       ${[...kisiGroupIds].join(', ') || '(none)'}`);
  console.log(`missing (expected, absent): ${missing.join(', ') || '(none)'}`);
  console.log(`extra (present, unmapped):  ${extra.join(', ') || '(none)'}`);

  // 5. AccessSync's own record of role assignments for this member
  header('AccessSync member_role_assignments');
  const rows = (await db.query(
    `SELECT id, hardware_group_id, role_assignment_id, created_at
     FROM member_role_assignments
     WHERE member_id = $1
     ORDER BY created_at ASC`,
    [identRow.id]
  )).rows;
  console.log(`rows: ${rows.length}`);
  for (const r of rows) {
    console.log(`  - group=${r.hardware_group_id} role_assignment_id=${r.role_assignment_id} created=${r.created_at}`);
  }

  process.exit(0);
})().catch(err => {
  console.error('AUDIT FAILED:', err);
  process.exit(1);
});
