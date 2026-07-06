/**
 * P3 — OB-249: Pass 3 operator-deleted-Kisi-user drift detection.
 *
 * The case we catch: operator manually deletes a user (or removes a role) in
 * the Kisi dashboard. Pass 1 (Wix-driven) doesn't see this — the Wix order
 * still exists. Pass 2 (Kisi orphan observe) doesn't see this — the role
 * assignment is gone from Kisi's side. Pass 1.5 doesn't see this — holder
 * is still active. Only a DB → Kisi verification sweep catches it.
 *
 * SAGE-locked design (2026-06-14):
 *   - Bulk-read: ONE paginated listAllUsers call, not N per-user GETs
 *   - Two-strike requirement: kisi_user_disappeared_observed_at marker on
 *     first sighting; revoke only on the second consecutive observation
 *   - Outage short-circuit: listAllUsers throws → Pass 3 aborts for that
 *     client; other passes continue
 *   - Per-source role drift: re-uses Pass 2's kisiAssignments set, free of
 *     additional HTTP calls
 *   - A12 universe filter: only checks groups AccessSync manages
 *   - Platform gate: Kisi only (Seam stub no listAllUsers)
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-249: Pass 3 operator-deleted-Kisi-user drift detection', () => {
  const reconcileSrc = fs.readFileSync(
    path.join(__dirname, '../../core/reconciliation.js'),
    'utf8'
  );
  const kisiAdapterSrc = fs.readFileSync(
    path.join(__dirname, '../../adapters/kisi/kisi-adapter.js'),
    'utf8'
  );
  const hardwareAdapterSrc = fs.readFileSync(
    path.join(__dirname, '../../adapters/hardware-adapter.js'),
    'utf8'
  );
  const standardAdapterSrc = fs.readFileSync(
    path.join(__dirname, '../../adapters/standard-adapter.js'),
    'utf8'
  );

  describe('migration', () => {
    const migration = fs.readFileSync(
      path.join(__dirname, '../../migrations/ob-249-member-access-kisi-disappeared-observed.sql'),
      'utf8'
    );

    test('ALTER TABLE adds kisi_user_disappeared_observed_at column', () => {
      expect(migration).toMatch(/ALTER TABLE member_access/);
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS kisi_user_disappeared_observed_at TIMESTAMPTZ/);
    });

    test('COMMENT ON COLUMN documents the two-strike semantic', () => {
      expect(migration).toMatch(/COMMENT ON COLUMN member_access\.kisi_user_disappeared_observed_at/);
      expect(migration).toMatch(/Two-strike/);
    });
  });

  describe('hardwareAdapter.listAllUsers (bulk-read primitive)', () => {
    test('kisi-adapter implements listAllUsers with offset/limit pagination', () => {
      expect(kisiAdapterSrc).toMatch(/async listAllUsers\(apiKey\)/);
      expect(kisiAdapterSrc).toMatch(/\/users\?limit=\$\{limit\}&offset=\$\{offset\}/);
    });

    test('listAllUsers returns shape { id, email, name } per user', () => {
      expect(kisiAdapterSrc).toMatch(/allUsers\.push\(\{ id: u\.id, email: u\.email/);
    });

    test('listAllUsers throws on non-2xx so caller can short-circuit on outage', () => {
      expect(kisiAdapterSrc).toMatch(/kisi\.list_users_failed/);
      // Must throw, not return [] on error
      const failedMatchIdx = kisiAdapterSrc.search(/kisi\.list_users_failed/);
      const slice = kisiAdapterSrc.slice(failedMatchIdx, failedMatchIdx + 200);
      expect(slice).toMatch(/throw err/);
    });

    test('hardware-adapter routes listAllUsers via platform key', () => {
      expect(hardwareAdapterSrc).toMatch(/async listAllUsers\(hardwarePlatform, apiKey\)/);
      expect(hardwareAdapterSrc).toMatch(/_getAdapter\(hardwarePlatform\)\.listAllUsers\(apiKey\)/);
    });
  });

  describe('Pass 3 in reconciliation.js', () => {
    test('platform gate — only runs for Kisi (Seam stub skipped)', () => {
      expect(reconcileSrc).toMatch(/if \(hardwarePlatform === 'kisi'\)/);
      expect(reconcileSrc).toMatch(/reconciliation\.pass_3_skipped_unsupported_platform/);
    });

    test('outage short-circuit — listAllUsers in try/catch, sets pass3OutageObserved', () => {
      expect(reconcileSrc).toMatch(/pass3OutageObserved = true/);
      expect(reconcileSrc).toMatch(/reconciliation\.pass_3_aborted_kisi_unavailable/);
    });

    test('builds in-memory Set of Kisi user IDs from bulk list', () => {
      expect(reconcileSrc).toMatch(/kisiUserIdSet = new Set\(pass3KisiUsers\.map\(u => String\(u\.id\)\)\)/);
    });

    test('builds (userId, groupId) Set from Pass 2 assignments for drift check (no extra HTTP)', () => {
      expect(reconcileSrc).toMatch(/kisiAssignmentPairs = new Set\(/);
      expect(reconcileSrc).toMatch(/`\$\{a\.userId\}:\$\{a\.groupId\}`/);
    });

    test('iterates active access rows scoped to source_tag = accesssync', () => {
      expect(reconcileSrc).toMatch(/ma\.status = 'active'\s+AND ma\.hardware_user_id IS NOT NULL\s+AND mm\.source_tag = 'accesssync'/);
    });
  });

  describe('two-strike requirement (SAGE condition)', () => {
    test('first sighting writes kisi_user_disappeared_observed_at = NOW() via L3 (DR-023)', () => {
      // The UPDATE itself lives in standard-adapter (L3 owns member_access writes);
      // reconciliation calls the primitive.
      expect(standardAdapterSrc).toMatch(/UPDATE member_access SET kisi_user_disappeared_observed_at = NOW\(\)/);
      expect(reconcileSrc).toMatch(/standardAdapter\.markKisiUserObservation\(row\.access_id, true\)/);
      expect(reconcileSrc).toMatch(/reconciliation\.kisi_user_disappeared_first_sighting/);
    });

    test('second sighting (column already set) queues synthetic plan.cancelled', () => {
      // Logic guard: presence of `kisi_user_disappeared_observed_at` truthy check
      expect(reconcileSrc).toMatch(/row\.kisi_user_disappeared_observed_at/);
      expect(reconcileSrc).toMatch(/reconciliation\.kisi_user_disappeared_confirmed/);
    });

    test("synthetic event uses planId from source_plan_id (OB-150 invariant)", () => {
      // Within the disappeared_confirmed block, planId must be source_plan_id
      const confirmedIdx = reconcileSrc.search(/reconciliation\.kisi_user_disappeared_confirmed/);
      // Look BACKWARDS from the log to find the synthetic event construction
      const slice = reconcileSrc.slice(Math.max(0, confirmedIdx - 800), confirmedIdx);
      expect(slice).toMatch(/planId:\s+src\.source_plan_id/);
    });

    test('recovery path — user back in Kisi clears the marker via L3 (DR-023)', () => {
      expect(standardAdapterSrc).toMatch(/UPDATE member_access SET kisi_user_disappeared_observed_at = NULL/);
      expect(reconcileSrc).toMatch(/standardAdapter\.markKisiUserObservation\(row\.access_id, false\)/);
      expect(reconcileSrc).toMatch(/reconciliation\.kisi_user_recovered/);
    });
  });

  describe('per-source role drift detection', () => {
    test('checks (hardware_user_id, hardware_group_id) pair against Pass 2 set', () => {
      expect(reconcileSrc).toMatch(/const pairKey = `\$\{row\.hardware_user_id\}:\$\{src\.hardware_group_id\}`/);
      expect(reconcileSrc).toMatch(/!kisiAssignmentPairs\.has\(pairKey\)/);
    });

    test('A12 universe filter — only checks AccessSync-managed hardware groups', () => {
      // Look for the accessSyncGroupIds filter in the drift loop
      const driftIdx = reconcileSrc.search(/reconciliation\.role_assignment_drifted/);
      const slice = reconcileSrc.slice(Math.max(0, driftIdx - 1500), driftIdx);
      expect(slice).toMatch(/accessSyncGroupIds\.has\(String\(src\.hardware_group_id\)\)/);
    });

    test("role-drift synthetic event uses src.source_plan_id (OB-150)", () => {
      const driftIdx = reconcileSrc.search(/reconciliation\.role_assignment_drifted/);
      const slice = reconcileSrc.slice(Math.max(0, driftIdx - 1500), driftIdx);
      expect(slice).toMatch(/planId:\s+src\.source_plan_id/);
    });
  });

  describe('event vocabulary in EVENT_REGISTRY', () => {
    const registry = fs.readFileSync(
      path.join(__dirname, '../../core/EVENT_REGISTRY.md'),
      'utf8'
    );
    const overrides = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../core/EVENT_REGISTRY.json'),
      'utf8'
    ));

    test.each([
      'reconciliation.pass_3_aborted_kisi_unavailable',
      'reconciliation.pass_3_skipped_unsupported_platform',
      'reconciliation.kisi_user_disappeared_first_sighting',
      'reconciliation.kisi_user_disappeared_confirmed',
      'reconciliation.kisi_user_recovered',
      'reconciliation.role_assignment_drifted',
      'reconciliation.pass_3_revoke_queue_failed',
      'reconciliation.pass_3_complete',
      'kisi.list_users.fetched',
      'kisi.list_users_no_key',
      'kisi.list_users_failed',
    ])('event %s is documented in EVENT_REGISTRY.md', (eventName) => {
      expect(registry.includes(eventName)).toBe(true);
    });

    test('disappeared_confirmed has persist:true (operator-visible revoke trigger)', () => {
      expect(overrides.overrides['reconciliation.kisi_user_disappeared_confirmed']).toEqual({ persist: true });
    });

    test('role_assignment_drifted has persist:true (operator-visible revoke trigger)', () => {
      expect(overrides.overrides['reconciliation.role_assignment_drifted']).toEqual({ persist: true });
    });
  });

  describe('ordering invariant within _syncClient', () => {
    test('Pass 3 runs AFTER Pass 2 orphan loop (so Pass 2 assignments are available)', () => {
      const pass2OrphanIdx = reconcileSrc.search(/reconciliation\.unmanaged_assignment_observed/);
      const pass3OutageIdx = reconcileSrc.search(/Pass 3: Operator-deleted-Kisi-user/);
      expect(pass2OrphanIdx).toBeGreaterThan(-1);
      expect(pass3OutageIdx).toBeGreaterThan(-1);
      expect(pass2OrphanIdx).toBeLessThan(pass3OutageIdx);
    });

    test('Pass 3 runs BEFORE Pass 1 promotion (so DB → Kisi check runs against pre-Pass-1 state)', () => {
      const pass3OutageIdx = reconcileSrc.search(/Pass 3: Operator-deleted-Kisi-user/);
      const pass1PromoIdx  = reconcileSrc.search(/OB-185 Pass 1 promotion logic/);
      expect(pass3OutageIdx).toBeLessThan(pass1PromoIdx);
    });
  });
});
