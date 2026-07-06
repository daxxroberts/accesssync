/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  DR-023 boundary RATCHET — no new L3-table writes outside the adapter   │
 * │                                                                         │
 * │  DR-023: the Standard Adapter Layer (adapters/standard-adapter.js)      │
 * │  exclusively owns writes to member_master and member_access. The        │
 * │  2026-07-02 incident traced to exactly the failure mode this enables:   │
 * │  the same rule implemented in two places, drifting apart.               │
 * │                                                                         │
 * │  This suite scans core/, admin/, adapters/ source and FAILS if a write  │
 * │  (INSERT/UPDATE/DELETE) to an L3-owned table appears anywhere the       │
 * │  allowlist below doesn't sanction. If you trip it:                      │
 * │    1. Preferred — add/extend a primitive on standard-adapter and call   │
 * │       it (see markSubMemberRemoving / rollupAccessStatus precedents).   │
 * │    2. If the write is genuinely sanctioned (a new designed-in writer    │
 * │       of member_access_sources), update the allowlist AND say why in    │
 * │       the commit message.                                               │
 * │  Never widen the allowlist to make a build pass without a ruling.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');
const SCAN_DIRS = ['core', 'admin', 'adapters'];
const L3_FILE = path.normalize('adapters/standard-adapter.js');

// Write patterns per table. `member_access` must not match member_access_sources
// or member_access_log — the (?![a-z_]) lookahead enforces the exact table name.
const WRITE_RE = {
  member_access:         /(INSERT INTO|UPDATE|DELETE FROM)\s+member_access(?![a-z_])/g,
  member_master:         /(INSERT INTO|UPDATE|DELETE FROM)\s+member_master(?![a-z_])/g,
  member_access_sources: /(INSERT INTO|UPDATE|DELETE FROM)\s+member_access_sources(?![a-z_])/g,
};

// ── Allowlist: file → exact write count. Everything else must be zero. ──────
//
// member_access / member_master: L3-exclusive per DR-023 — no exceptions.
// (The former core/location-lapse.js legacy 'disabled' write was routed
// through standardAdapter.suspendMemberLocationSources per the OB-257
// ruling, 2026-07-06.)
//
// member_access_sources has multiple designed-in writers (DR-034 revoke
// deletes, OB-185 Pass 1 promote/insert, OB-240 retry probe, plan-mapping
// remap flows). Counts pinned so NEW writes still trip the ratchet.
const ALLOWLIST = {
  member_access: {
    // none — L3-exclusive
  },
  member_master: {
    // none — L3-exclusive
  },
  member_access_sources: {
    'core/grant-revoke.js':        1, // DR-034: targeted source-row DELETE on revoke
    'core/reconciliation.js':      5, // OB-185 Pass 1 promote/insert + DR-051 self-heal
    'core/source-retry-probe.js':  3, // OB-240: retry status transitions
    'admin/routes/clients.js':     1, // onboarding source-row INSERT (OB-203 hardened)
    'admin/routes/multi-member.js':1, // DR-032 submit: draft → pending_hardware
    'admin/routes/operator.js':    7, // plan-mapping remap INSERT/DELETE flows (OB-203 hardened)
  },
};

function walkJsFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkJsFiles(full, acc);
    } else if (entry.name.endsWith('.js')) {
      acc.push(full);
    }
  }
  return acc;
}

function scan() {
  const results = { member_access: {}, member_master: {}, member_access_sources: {} };
  for (const dir of SCAN_DIRS) {
    for (const file of walkJsFiles(path.join(REPO_ROOT, dir))) {
      const rel = path.relative(REPO_ROOT, file);
      if (path.normalize(rel) === L3_FILE) continue; // L3 owns these tables
      const src = fs.readFileSync(file, 'utf8');
      for (const [table, re] of Object.entries(WRITE_RE)) {
        const count = (src.match(re) || []).length;
        if (count > 0) results[table][rel.replace(/\\/g, '/')] = count;
      }
    }
  }
  return results;
}

describe('[P3] DR-023 boundary ratchet', () => {
  const found = scan();

  test.each(Object.keys(WRITE_RE))(
    '%s writes outside standard-adapter match the sanctioned allowlist exactly',
    (table) => {
      // toEqual (not toMatchObject) — a REMOVED write should also update the
      // allowlist, keeping it an honest inventory.
      expect(found[table]).toEqual(ALLOWLIST[table]);
    }
  );

  test('standard-adapter itself still writes all three tables (scan sanity check)', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, L3_FILE), 'utf8');
    for (const re of Object.values(WRITE_RE)) {
      expect((src.match(re) || []).length).toBeGreaterThan(0);
    }
  });

  test('regex distinguishes member_access from member_access_sources/_log', () => {
    expect('UPDATE member_access_sources SET x'.match(WRITE_RE.member_access)).toBeNull();
    expect('INSERT INTO member_access_log (a)'.match(WRITE_RE.member_access)).toBeNull();
    expect(`UPDATE member_access SET status = 'x'`.match(WRITE_RE.member_access)).toHaveLength(1);
    expect('UPDATE member_access ma SET status'.match(WRITE_RE.member_access)).toHaveLength(1);
  });
});
