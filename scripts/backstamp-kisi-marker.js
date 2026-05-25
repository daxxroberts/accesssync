/**
 * ⚠️ DEPRECATED INFRASTRUCTURE REFERENCE — historical artifact.
 *
 * This script references the Railway Postgres URL (gondola.proxy.rlwy.net:27298) which was
 * DECOMMISSIONED on 2026-05-20 per DR-047 (Supabase migration). The script was authored
 * before cutover. It is preserved for audit/rollback reference only.
 *
 * If you need to back-stamp Kisi users today, port this to use Supabase via the live DB
 * connection in db.js. See memory/reference_supabase_project.md.
 *
 * Closed audit reference: OB-182 grep sweep (2026-05-24).
 * ─────────────────────────────────────────────────────────────────────────────────
 *
 * OB-171 / Phase B — back-stamp every pre-2026-05-13 Kisi user with the AccessSync marker.
 *
 * Why: DR-045 deployed 2026-05-13. Any Kisi user we created before that date has empty `notes`
 * and will be refused by `deleteUser` with UNOWNED_USER on a real `member.deleted` event.
 *
 * Usage:
 *   node scripts/backstamp-kisi-marker.js                # DRY RUN — prints plan, no writes
 *   node scripts/backstamp-kisi-marker.js --execute      # LIVE — PATCHes notes on each user
 *
 * Algorithm:
 *   1. Query DB for every HOG member_access row with hardware_user_id IS NOT NULL
 *      where the parent member_master.source_tag = 'accesssync'
 *   2. For each row, GET /users/:hardware_user_id from Kisi
 *      - 404: skip (user already gone; row is stale)
 *      - 200 with marker already present (parses as [AS|managed|...]): skip (already done)
 *      - 200 with empty notes: stamp `[AS|managed|<HOG_CLIENT_ID>|<member_access.created_at>] Back-stamped <today>`
 *      - 200 with non-empty notes that are NOT an AS marker: prepend marker, preserve existing text
 *        (e.g. "[AS|managed|...|...] Back-stamped ...; original: <preserved_text>")
 *   3. GET back after PATCH to verify persistence
 *   4. Report totals: total_inspected / already_marked / newly_stamped / skipped_gone / failed
 *
 * Idempotent: re-runnable safely. Already-marked users are skipped.
 * Preserves operator-edited notes by prepending the marker rather than overwriting.
 *
 * DELETE THIS FILE after Phase B completes and OB-171 closes.
 */

process.env.API_KEY_ENCRYPTION_KEY = '301650ad0b74924f749db310144bae93ed465cdf7e8c703bd2296a4ce1e81c06';
process.env.DATABASE_URL = 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';

const { Client } = require('pg');
const { decryptApiKey } = require('../core/crypto-utils');
const kisiAdapter = require('../adapters/kisi/kisi-adapter');

const HOG_CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';
const TODAY_ISO = new Date().toISOString();
const EXECUTE = process.argv.includes('--execute');

async function kisiRequest(apiKey, path, method, body) {
  const res = await fetch(`https://api.kisi.io${path}`, {
    method,
    headers: {
      'Authorization': `KISI-LOGIN ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function main() {
  console.log('=== OB-171 Phase B: back-stamp legacy Kisi users ===');
  console.log('mode:', EXECUTE ? 'LIVE PATCH' : 'DRY RUN (no writes)');
  console.log('client:', HOG_CLIENT_ID);
  console.log('');

  const pg = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pg.connect();

  const keyRes = await pg.query(
    `SELECT hardware_api_key FROM connector_subscriptions WHERE client_id = $1 LIMIT 1`,
    [HOG_CLIENT_ID]
  );
  const apiKey = decryptApiKey(keyRes.rows[0].hardware_api_key);
  console.log('API key resolved (last 8):', apiKey.slice(-8));

  const rowsRes = await pg.query(
    `SELECT  ma.id              AS access_id,
             ma.hardware_user_id,
             ma.created_at      AS access_created_at,
             mm.id              AS master_id,
             mm.email,
             mm.platform_member_id,
             mm.source_tag
     FROM    member_access ma
     JOIN    member_master mm ON mm.id = ma.member_master_id
     WHERE   ma.client_id        = $1
     AND     mm.source_tag       = 'accesssync'
     AND     ma.hardware_user_id IS NOT NULL
     ORDER BY ma.created_at ASC`,
    [HOG_CLIENT_ID]
  );
  await pg.end();

  const dbRows = rowsRes.rows;
  // Dedup by hardware_user_id — same Kisi user may appear in multiple access rows
  // (member with multiple plans). Use earliest created_at for the marker timestamp.
  const byUser = new Map();
  for (const row of dbRows) {
    const existing = byUser.get(row.hardware_user_id);
    if (!existing || new Date(row.access_created_at) < new Date(existing.access_created_at)) {
      byUser.set(row.hardware_user_id, row);
    }
  }
  console.log(`DB rows: ${dbRows.length}`);
  console.log(`Distinct Kisi users to inspect: ${byUser.size}`);
  console.log('');

  const stats = {
    inspected: 0,
    already_marked: 0,
    would_stamp: 0,
    newly_stamped: 0,
    skipped_gone: 0,
    failed: 0,
  };

  for (const [userId, row] of byUser) {
    stats.inspected++;
    const tag = `[${stats.inspected}/${byUser.size}] kisi=${userId} email=${row.email || '(none)'}`;

    const getRes = await kisiRequest(apiKey, `/users/${userId}`, 'GET');
    if (getRes.status === 404) {
      stats.skipped_gone++;
      console.log(`${tag} — SKIP (user gone in Kisi, DB row is stale)`);
      continue;
    }
    if (getRes.status >= 400) {
      stats.failed++;
      console.log(`${tag} — FAIL (GET status ${getRes.status})`);
      continue;
    }

    const existingNotes = getRes.body.notes || '';
    const parsed = kisiAdapter.parseAccessSyncMarker(existingNotes);
    if (parsed && parsed.clientId === HOG_CLIENT_ID) {
      stats.already_marked++;
      console.log(`${tag} — already marked, skipping`);
      continue;
    }

    // Build the back-stamp marker. createdAt = earliest member_access.created_at for this user.
    const createdAt = new Date(row.access_created_at).toISOString();
    const reason = existingNotes && !parsed
      ? `Back-stamped ${TODAY_ISO}; original notes: ${existingNotes}`
      : `Back-stamped ${TODAY_ISO}`;
    const newNotes = `[AS|managed|${HOG_CLIENT_ID}|${createdAt}] ${reason}`;

    if (!EXECUTE) {
      stats.would_stamp++;
      console.log(`${tag} — WOULD PATCH notes:`);
      console.log(`     existing: ${JSON.stringify(existingNotes)}`);
      console.log(`     new:      ${JSON.stringify(newNotes.slice(0, 120) + (newNotes.length > 120 ? '...' : ''))}`);
      continue;
    }

    // LIVE PATCH
    const patchRes = await kisiRequest(apiKey, `/users/${userId}`, 'PATCH', {
      user: { notes: newNotes }
    });
    if (patchRes.status >= 400) {
      stats.failed++;
      console.log(`${tag} — PATCH FAILED (status ${patchRes.status}): ${JSON.stringify(patchRes.body)}`);
      continue;
    }
    // verify
    const verifyRes = await kisiRequest(apiKey, `/users/${userId}`, 'GET');
    const verifiedMarker = kisiAdapter.parseAccessSyncMarker(verifyRes.body.notes);
    if (verifiedMarker && verifiedMarker.clientId === HOG_CLIENT_ID) {
      stats.newly_stamped++;
      console.log(`${tag} — STAMPED + VERIFIED`);
    } else {
      stats.failed++;
      console.log(`${tag} — PATCH returned 200 but verify GET shows no marker: ${JSON.stringify(verifyRes.body.notes)}`);
    }
  }

  console.log('');
  console.log('=== Totals ===');
  console.log(JSON.stringify(stats, null, 2));
  if (!EXECUTE) {
    console.log('');
    console.log('DRY RUN — no writes performed. Re-run with --execute to apply.');
  }
}

main().catch(err => {
  console.error('FATAL:', err.message);
  console.error(err.stack);
  process.exit(1);
});
