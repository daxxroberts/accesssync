/**
 * kisi-ownership-migrate.js
 * DR-045 Layer B migration: move the AccessSync ownership marker from each Kisi
 * user's free-text `notes` into its `metadata` object.
 * Proposal + runbook: handoff/KISI_METADATA_MARKER_PROPOSAL_2026-10-23.md
 *
 * Steps (run in this order, one client at a time if you like):
 *   verify             Read-only. For every Kisi user, compares the metadata marker
 *                      against the notes marker and reports what is left to do.
 *   backfill           Dry run: lists the users backfill would write.
 *   backfill --apply   Writes the metadata marker onto every user whose ONLY marker is
 *                      the notes line for this client, using the notes line's own
 *                      client id and timestamp. Read → merge → PATCH → re-read per user
 *                      (kisiAdapter.stampOwnershipMetadata): other metadata keys are
 *                      kept, another client's marker is never overwritten.
 *   verify             Again. "READY FOR PHASE 2" means no user is left with a
 *                      notes-only or conflicting marker.
 *
 * What this never does:
 *   - Stamp a user that has no marker at all. Some AccessSync members are linked to a
 *     Kisi account that existed before AccessSync (an owner, an admin, staff who also
 *     bought a plan). They were never marked, so AccessSync may not delete them; giving
 *     them a marker now would change that. They are reported, never touched.
 *   - Touch notes, names, access, or role assignments.
 *
 * Usage (from repo root; needs DATABASE_URL + API_KEY_ENCRYPTION_KEY, like
 * scripts/backfill-kisi-names.js):
 *   node scripts/kisi-ownership-migrate.js verify
 *   node scripts/kisi-ownership-migrate.js backfill
 *   node scripts/kisi-ownership-migrate.js backfill --apply
 *   ... --client <client uuid>     limit to one client
 *   ... --list                     print Kisi user ids for every category, not just the actionable ones
 *
 * Exit code: 0 = every client ready for phase 2 (or backfill finished with no
 * failures), 1 = work remains or a write failed, 2 = conflicting markers found.
 */

const db = require('../db');
const { decryptApiKey } = require('../core/crypto-utils');
const kisiAdapter = require('../adapters/kisi/kisi-adapter');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] || null);
}

const MODE     = process.argv[2];
const APPLY    = process.argv.includes('--apply');
const CLIENT   = arg('--client');
const LIST_ALL = process.argv.includes('--list');

/**
 * Sort one client's Kisi users into the categories the migration cares about.
 * Exported for tests; no I/O.
 */
function classifyUsers(users, clientId, dbKnownIds = new Set()) {
  const out = {
    total: 0,
    agree: [], metadataOnly: [], notesOnly: [], conflict: [],
    foreign: [], none: [], noneLinked: [], createdAtDiffers: [],
  };
  for (const u of users || []) {
    if (!u || u.id === undefined || u.id === null) continue;
    out.total++;
    const id = String(u.id);
    const meta  = kisiAdapter.parseOwnershipMetadata(u.metadata);
    // First line only: an operator may have typed more under AccessSync's marker line.
    const notes = typeof u.notes === 'string' ? kisiAdapter.parseAccessSyncMarker(u.notes.split(/\r?\n/)[0]) : null;

    if (meta && notes && meta.clientId !== notes.clientId) {
      if (meta.clientId === clientId || notes.clientId === clientId) {
        out.conflict.push({ id, metadataClientId: meta.clientId, notesClientId: notes.clientId });
      } else {
        out.foreign.push({ id });
      }
      continue;
    }
    const owner = (meta || notes || {}).clientId;
    if (!owner) {
      out.none.push({ id });
      if (dbKnownIds.has(id)) out.noneLinked.push({ id });
      continue;
    }
    if (owner !== clientId) { out.foreign.push({ id }); continue; }

    if (meta && notes) {
      out.agree.push({ id });
      if (meta.createdAt && notes.createdAt && meta.createdAt !== notes.createdAt) {
        out.createdAtDiffers.push({ id, metadata: meta.createdAt, notes: notes.createdAt });
      }
    } else if (meta) {
      out.metadataOnly.push({ id });
    } else {
      out.notesOnly.push({ id, createdAt: notes.createdAt });
    }
  }
  return out;
}

function ids(list, max = 50) {
  const shown = list.slice(0, max).map(x => x.id).join(', ');
  return list.length > max ? `${shown}, … (+${list.length - max} more)` : shown;
}

function printReport(name, clientId, c, dbMissingFromKisi) {
  const row = (label, list, note = '') => console.log(`  ${label.padEnd(54)} ${String(list.length).padStart(5)}${note}`);
  console.log(`\n=== ${name} (${clientId}) ===`);
  console.log(`  Kisi users in the org: ${c.total}`);
  row('AccessSync, metadata + notes agree', c.agree);
  row('AccessSync, metadata only', c.metadataOnly);
  row('AccessSync, notes only — needs backfill', c.notesOnly);
  row('CONFLICT — metadata and notes name different clients', c.conflict);
  row("another client's marker", c.foreign);
  row('no marker', c.none, `   (${c.noneLinked.length} linked to an AccessSync member: pre-existing accounts, left alone)`);
  if (c.createdAtDiffers.length) row('agree on client, timestamps differ (informational)', c.createdAtDiffers);
  console.log(`  AccessSync members whose Kisi user is gone from Kisi: ${dbMissingFromKisi}`);

  if (c.notesOnly.length)  console.log(`  notes-only ids: ${ids(c.notesOnly)}`);
  if (c.conflict.length)   c.conflict.forEach(x => console.log(`  CONFLICT id ${x.id}: metadata=${x.metadataClientId} notes=${x.notesClientId}`));
  if (LIST_ALL) {
    console.log(`  agree ids: ${ids(c.agree, 1e6)}`);
    console.log(`  metadata-only ids: ${ids(c.metadataOnly, 1e6)}`);
    console.log(`  no-marker ids linked to members: ${ids(c.noneLinked, 1e6)}`);
  }

  const ready = c.notesOnly.length === 0 && c.conflict.length === 0;
  console.log(`  Ready for phase 2: ${ready ? 'YES' : 'NO'}` +
    (ready ? '' : ` (${c.notesOnly.length} notes-only, ${c.conflict.length} conflicting)`));
  return ready;
}

async function loadClients() {
  const { rows } = await db.query(
    `SELECT c.id AS client_id, c.name AS client_name, cs.hardware_api_key
       FROM clients c
       JOIN LATERAL (
         SELECT hardware_api_key FROM connector_subscriptions
          WHERE client_id = c.id AND status = 'active' AND hardware_platform = 'kisi'
            AND hardware_api_key IS NOT NULL
          ORDER BY created_at DESC LIMIT 1
       ) cs ON true
      WHERE ($1::uuid IS NULL OR c.id = $1::uuid)
      ORDER BY c.name`,
    [CLIENT]
  );
  return rows;
}

async function loadDbKnownIds(clientId) {
  const { rows } = await db.query(
    `SELECT DISTINCT ma.hardware_user_id::text AS id
       FROM member_access ma
      WHERE ma.client_id = $1 AND ma.hardware_user_id IS NOT NULL`,
    [clientId]
  );
  return new Set(rows.map(r => r.id));
}

async function runClient(row) {
  let apiKey;
  try {
    apiKey = decryptApiKey(row.hardware_api_key);
  } catch (err) {
    console.log(`\n=== ${row.client_name} (${row.client_id}) ===\n  SKIPPED — could not decrypt the Kisi key: ${err.message}`);
    return { ready: false, conflicts: 0, failed: 0 };
  }

  const users = await kisiAdapter.listAllUsersRaw(apiKey);
  const dbKnown = await loadDbKnownIds(row.client_id);
  const kisiIds = new Set(users.map(u => String(u.id)));
  const dbMissingFromKisi = [...dbKnown].filter(id => !kisiIds.has(id)).length;
  const c = classifyUsers(users, row.client_id, dbKnown);

  if (MODE === 'verify') {
    const ready = printReport(row.client_name, row.client_id, c, dbMissingFromKisi);
    return { ready, conflicts: c.conflict.length, failed: 0 };
  }

  // backfill
  console.log(`\n=== ${row.client_name} (${row.client_id}) — backfill ${APPLY ? 'APPLY' : 'DRY RUN'} ===`);
  console.log(`  ${c.notesOnly.length} user(s) carry only the notes marker for this client.`);
  if (c.conflict.length) {
    console.log(`  ${c.conflict.length} CONFLICTING user(s) are skipped — resolve by hand:`);
    c.conflict.forEach(x => console.log(`    id ${x.id}: metadata=${x.metadataClientId} notes=${x.notesClientId}`));
  }
  const tally = { written: 0, already: 0, failed: 0 };
  for (const u of c.notesOnly) {
    if (!APPLY) { console.log(`  WOULD WRITE  kisi ${u.id}  (created ${u.createdAt})`); continue; }
    try {
      const res = await kisiAdapter.stampOwnershipMetadata(apiKey, u.id, row.client_id, { createdAt: u.createdAt });
      tally[res.status === 'already' ? 'already' : 'written']++;
      console.log(`  ${res.status === 'already' ? 'ALREADY' : 'WROTE  '}  kisi ${u.id}`);
    } catch (err) {
      tally.failed++;
      console.log(`  FAILED   kisi ${u.id} — ${err.code || err.statusCode || ''} ${err.message}`);
    }
  }
  if (APPLY) console.log(`  written ${tally.written}, already ${tally.already}, failed ${tally.failed}`);
  return { ready: tally.failed === 0, conflicts: c.conflict.length, failed: tally.failed };
}

async function main() {
  if (MODE !== 'verify' && MODE !== 'backfill') {
    console.error('Usage: node scripts/kisi-ownership-migrate.js <verify|backfill> [--apply] [--client <uuid>] [--list]');
    process.exit(64);
  }
  if (MODE === 'verify' && APPLY) {
    console.error('verify is read-only; --apply does nothing there');
    process.exit(64);
  }
  const clients = await loadClients();
  if (clients.length === 0) {
    console.log(CLIENT ? `No active Kisi client ${CLIENT}` : 'No active Kisi clients');
    return 0;
  }
  let allReady = true;
  let conflicts = 0;
  let failed = 0;
  for (const row of clients) {
    try {
      const r = await runClient(row);
      allReady = allReady && r.ready;
      conflicts += r.conflicts;
      failed += r.failed;
    } catch (err) {
      allReady = false;
      console.log(`\n=== ${row.client_name} (${row.client_id}) ===\n  ABORTED — ${err.code || err.statusCode || ''} ${err.message}`);
    }
  }
  console.log('');
  if (MODE === 'verify') {
    console.log(allReady ? 'READY FOR PHASE 2 — every AccessSync marker is in metadata.' : 'NOT READY — see above.');
  }
  if (conflicts > 0) return 2;
  return allReady && failed === 0 ? 0 : 1;
}

if (require.main === module) {
  main()
    .then(code => db.pool.end().then(() => process.exit(code), () => process.exit(code)))
    .catch(err => { console.error('FATAL', err); process.exit(1); });
}

module.exports = { classifyUsers };
