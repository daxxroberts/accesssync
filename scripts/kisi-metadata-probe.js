/**
 * kisi-metadata-probe.js
 * One-off live probe: does the Kisi REST API accept a `metadata` object on a user?
 *
 * Why: the DR-045 ownership marker lives in the free-text `notes` field today. Kisi users
 * also carry a `metadata` JSON object (seen in the user schema; Kisi's SCIM guide writes
 * `metadata.<key>` through it). If PATCH /users/:id accepts `metadata` over REST, it is a
 * structured, operator-proof home for the marker. This script answers that question on
 * ONE user and can undo itself. It does not touch notes, access_enabled, name, or roles.
 *
 * Usage (from repo root, with the HOG Kisi API key — never commit it):
 *   KISI_API_KEY=<key> node scripts/kisi-metadata-probe.js <userId|email>            # read only
 *   KISI_API_KEY=<key> node scripts/kisi-metadata-probe.js <userId|email> --write    # PATCH metadata, then re-read
 *   KISI_API_KEY=<key> node scripts/kisi-metadata-probe.js <userId|email> --revert   # remove the accesssync_* keys again
 *
 * The write merges three flat keys into whatever metadata already exists; nothing else on
 * the user is sent. Flat because Kisi's OpenAPI spec (users schema) constrains metadata to:
 * values of type string/null/integer/float/boolean only (no nested objects), keys <= 50
 * chars, values <= 500 chars, at most 50 keys. Keys written:
 *   accesssync_managed    = true
 *   accesssync_client_id  = 'probe'
 *   accesssync_written_at = <ISO timestamp>
 *
 * Read the result as:
 *   200 and the re-read shows the accesssync_* keys → REST accepts metadata. Viable marker home.
 *   200 but the re-read shows no metadata change  → silently ignored (SCIM-only). Not viable.
 *   422 / 400 naming metadata                      → rejected. Not viable.
 */

const kisiConnector = require('../adapters/kisi/kisi-connector');

const apiKey = process.env.KISI_API_KEY;
const target = process.argv[2];
const mode = process.argv.includes('--revert') ? 'revert'
           : process.argv.includes('--write') ? 'write'
           : 'read';

if (!apiKey || !target) {
  console.error('Usage: KISI_API_KEY=<key> node scripts/kisi-metadata-probe.js <userId|email> [--write|--revert]');
  process.exit(2);
}

function show(label, user) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify({
    id: user.id,
    email: user.email,
    name: user.name,
    notes: user.notes === undefined ? '(field absent)' : user.notes,
    metadata: user.metadata === undefined ? '(field absent)' : user.metadata,
  }, null, 2));
}

async function resolveUser() {
  if (/^\d+$/.test(target)) {
    return kisiConnector.makeRequest(`/users/${target}`, { method: 'GET' }, apiKey);
  }
  const list = await kisiConnector.makeRequest(
    `/users?query=${encodeURIComponent(target)}`, { method: 'GET' }, apiKey
  );
  const hit = (Array.isArray(list) ? list : []).find(
    u => (u.email || '').toLowerCase() === target.toLowerCase()
  );
  if (!hit) throw new Error(`No Kisi user with email ${target}`);
  // The search result may be a slim object; fetch the full record.
  return kisiConnector.makeRequest(`/users/${hit.id}`, { method: 'GET' }, apiKey);
}

(async () => {
  const before = await resolveUser();
  show('BEFORE', before);

  if (mode === 'read') {
    console.log('\nRead only. Re-run with --write to attempt the metadata PATCH.');
    return;
  }

  const PROBE_KEYS = ['accesssync_managed', 'accesssync_client_id', 'accesssync_written_at'];
  const existing = (before.metadata && typeof before.metadata === 'object') ? before.metadata : {};
  let next;
  if (mode === 'write') {
    next = {
      ...existing,
      accesssync_managed: true,
      accesssync_client_id: 'probe',
      accesssync_written_at: new Date().toISOString(),
    };
  } else {
    next = { ...existing };
    for (const k of PROBE_KEYS) delete next[k];
  }

  console.log(`\n=== PATCH /users/${before.id} (${mode}) ===`);
  console.log(JSON.stringify({ user: { metadata: next } }, null, 2));

  let patchResult;
  try {
    patchResult = await kisiConnector.makeRequest(
      `/users/${before.id}`,
      { method: 'PATCH', body: JSON.stringify({ user: { metadata: next } }) },
      apiKey
    );
    console.log('PATCH response:', JSON.stringify(patchResult, null, 2));
  } catch (err) {
    console.log(`PATCH FAILED: status=${err.statusCode || '?'} code=${err.code || '?'} message=${err.message}`);
    if (err.body) console.log('body:', typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
    console.log('\nVERDICT: Kisi REST rejected the metadata write. Not a viable marker home. notes stays.');
    process.exit(1);
  }

  const after = await kisiConnector.makeRequest(`/users/${before.id}`, { method: 'GET' }, apiKey);
  show('AFTER', after);

  const persisted = after.metadata && typeof after.metadata === 'object'
    && PROBE_KEYS.some(k => k in after.metadata);
  if (mode === 'write') {
    console.log(persisted
      ? '\nVERDICT: accesssync_* metadata keys persisted on re-read. REST accepts metadata. Viable marker home.'
      : '\nVERDICT: PATCH returned 2xx but metadata did not change on re-read. Silently ignored (likely SCIM-only). Not viable.');
    console.log('Clean up with: --revert');
  } else {
    console.log(persisted
      ? '\nRevert did NOT remove the accesssync_* keys. Check the user in the Kisi dashboard.'
      : '\nReverted. The accesssync_* keys are gone.');
  }
})().catch(err => {
  console.error('\nPROBE ERROR:', err.statusCode || '', err.code || '', err.message);
  process.exit(1);
});
