/**
 * backfill-kisi-names.js
 * One-time: give AccessSync-created Kisi users their member name. Before the
 * createUser fix, Kisi users were created with email only, so the Kisi dashboard
 * shows the email in the Name column.
 *
 * Renames in place (PATCH /users/:id { name }) via kisiAdapter.setUserName, which
 * refuses any user whose notes marker doesn't name this client. Never deletes,
 * re-creates, or touches role assignments — door access is unaffected.
 *
 * A user is only changed when its current Kisi name is blank or equals its email,
 * so a name someone typed in Kisi is never overwritten. --name skips that check
 * (single-user test only).
 *
 * Usage (from repo root; needs DATABASE_URL + API_KEY_ENCRYPTION_KEY):
 *   node scripts/backfill-kisi-names.js                         dry run, everyone
 *   node scripts/backfill-kisi-names.js --apply                 rename everyone eligible
 *   node scripts/backfill-kisi-names.js --only-email a@b.com    dry run, one member
 *   node scripts/backfill-kisi-names.js --only-email a@b.com --name "A B" --apply
 */

const db = require('../db');
const { decryptApiKey } = require('../core/crypto-utils');
const kisiAdapter = require('../adapters/kisi/kisi-adapter');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] || null);
}
const APPLY      = process.argv.includes('--apply');
const ONLY_EMAIL = arg('--only-email');
const FORCE_NAME = arg('--name');

if (FORCE_NAME && !ONLY_EMAIL) {
  console.error('--name is only allowed together with --only-email');
  process.exit(1);
}

const norm = (s) => (s || '').trim().toLowerCase();

(async () => {
  const { rows } = await db.query(
    `SELECT ma.id AS access_id, ma.client_id, ma.hardware_user_id,
            mm.email, mm.first_name, mm.last_name, mm.display_name,
            c.name AS client_name, cs.hardware_api_key
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       JOIN clients c ON c.id = ma.client_id
       JOIN LATERAL (
         SELECT hardware_api_key FROM connector_subscriptions
          WHERE client_id = ma.client_id AND status = 'active' AND hardware_platform = 'kisi'
          ORDER BY created_at DESC LIMIT 1
       ) cs ON true
      WHERE ma.hardware_user_id IS NOT NULL
        AND ($1::text IS NULL OR lower(trim(mm.email)) = lower(trim($1)))
      ORDER BY c.name, mm.last_name NULLS LAST, mm.first_name NULLS LAST`,
    [ONLY_EMAIL]
  );

  if (rows.length === 0) {
    console.log(ONLY_EMAIL ? `No Kisi-linked member found for ${ONLY_EMAIL}` : 'No Kisi-linked members found');
    process.exit(0);
  }

  // One Kisi user can back several member_access rows; handle each user once.
  const seen = new Set();
  const keys = new Map();
  const tally = { rename: 0, renamed: 0, skip: 0, failed: 0 };

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} Kisi-linked member row(s)\n`);

  for (const r of rows) {
    const userKey = `${r.client_id}:${r.hardware_user_id}`;
    if (seen.has(userKey)) continue;
    seen.add(userKey);

    const who = `${r.client_name} | kisi ${r.hardware_user_id} | ${r.email || '(no email)'}`;
    const skip = (why) => { tally.skip++; console.log(`SKIP    ${who} — ${why}`); };

    const wanted = FORCE_NAME
      || [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
      || (r.display_name || '').trim();
    const newName = kisiAdapter.normalizeKisiName(wanted, r.email);
    if (!newName) { skip('no name on file'); continue; }

    if (!keys.has(r.client_id)) {
      try { keys.set(r.client_id, r.hardware_api_key ? decryptApiKey(r.hardware_api_key) : null); }
      catch (_) { keys.set(r.client_id, null); }
    }
    const apiKey = keys.get(r.client_id);
    if (!apiKey) { skip('no usable Kisi key for this client'); continue; }

    let user;
    try {
      user = await kisiAdapter.getUserById(apiKey, r.hardware_user_id);
    } catch (err) {
      tally.failed++; console.log(`FAILED  ${who} — Kisi read: ${err.statusCode || err.code || err.message}`); continue;
    }
    if (!user) { skip('Kisi user no longer exists'); continue; }

    const marker = kisiAdapter.parseAccessSyncMarker(user.notes);
    if (!marker) { skip('not created by AccessSync'); continue; }
    if (marker.clientId !== r.client_id) { skip('marked for a different client'); continue; }

    const current = (user.name || '').trim();
    if (current === newName) { skip(`already "${current}"`); continue; }
    if (!FORCE_NAME && current && norm(current) !== norm(user.email || r.email)) {
      skip(`has a name already set in Kisi ("${current}")`); continue;
    }

    tally.rename++;
    console.log(`RENAME  ${who} — "${current || '(blank)'}" → "${newName}"`);
    if (!APPLY) continue;

    try {
      await kisiAdapter.setUserName(apiKey, r.hardware_user_id, newName, { clientId: r.client_id });
      tally.renamed++;
    } catch (err) {
      tally.failed++; console.log(`FAILED  ${who} — rename: ${err.statusCode || err.code || err.message}`);
    }
  }

  console.log(`\n${APPLY ? `Renamed ${tally.renamed} of ${tally.rename}` : `Would rename ${tally.rename}`}, ` +
              `skipped ${tally.skip}, failed ${tally.failed}`);
  process.exit(tally.failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
