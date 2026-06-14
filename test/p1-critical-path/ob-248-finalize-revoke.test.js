/**
 * P1 — OB-248: DR-044 finalize hook + delete-Kisi-user-on-every-revoke.
 *
 * After a successful revoke that rolls member_access.status to 'inactive',
 * standardAdapter.finalizeRevoke must:
 *   (a) call hardwareAdapter.deleteUser (DR-045 three-layer guard inside)
 *   (b) UPDATE member_access SET status='deleted'
 *   (c) UPDATE member_master NULL'ing all PII columns
 *
 * Solves two compounding problems:
 *   1. Brittany case — sub-member removed via Member Hub, access landed at
 *      'inactive' with PII intact because the DR-044 state machine was wired
 *      against the dropped member_identity.sub_member_status column pre-S-10.
 *   2. Email-on-re-add — keeping the Kisi user as an empty 'invited' account
 *      means the next findUserByEmail reuses it, skipping createUser, skipping
 *      Kisi's welcome email. Delete-on-revoke guarantees a fresh createUser
 *      cycle (and fresh welcome email) on every re-grant.
 *
 * Static-scan tests — verify standardAdapter contains the right method shape,
 * queue-worker wires it after completeRevoke, and DR-045 guard refusals do
 * not trigger PII purge.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-248: standardAdapter.finalizeRevoke + queue-worker wiring', () => {
  const adapterSrc = fs.readFileSync(
    path.join(__dirname, '../../adapters/standard-adapter.js'),
    'utf8'
  );
  const workerSrc = fs.readFileSync(
    path.join(__dirname, '../../core/queue-worker.js'),
    'utf8'
  );

  describe('standardAdapter.finalizeRevoke shape', () => {
    test('method exists with the expected signature', () => {
      expect(adapterSrc).toMatch(/async finalizeRevoke\(memberId, tenantId, hardwarePlatform, apiKey, hardwareUserId\)/);
    });

    test('early-exit when access status is not inactive', () => {
      expect(adapterSrc).toMatch(/status\s*!==\s*'inactive'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.access_still_active/);
    });

    test('early-exit when access status is already deleted (idempotent)', () => {
      expect(adapterSrc).toMatch(/status === 'deleted'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.already_deleted/);
    });

    test('defense-in-depth re-check of source_tag = accesssync (Layer A)', () => {
      expect(adapterSrc).toMatch(/source_tag !== 'accesssync'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.refused_foreign_source_tag/);
    });
  });

  describe('hardwareAdapter.deleteUser invocation', () => {
    test('passes clientId in options so DR-045 Layer B can verify marker', () => {
      expect(adapterSrc).toMatch(/hardwareAdapter\.deleteUser\(hardwarePlatform, apiKey, hardwareUserId, \{ clientId: tenantId \}\)/);
    });

    test('handles UNOWNED_USER refusal without throwing or purging PII', () => {
      expect(adapterSrc).toMatch(/err\.code === 'UNOWNED_USER'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.refused_unowned/);
      // Must return early (no PII update) before the DB finalize block
      const unownedIdx = adapterSrc.search(/err\.code === 'UNOWNED_USER'/);
      const piiUpdateIdx = adapterSrc.search(/email = NULL,\s+first_name = NULL/);
      expect(unownedIdx).toBeLessThan(piiUpdateIdx);
    });

    test('handles CLIENT_MISMATCH refusal without throwing or purging PII', () => {
      expect(adapterSrc).toMatch(/err\.code === 'CLIENT_MISMATCH'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.refused_cross_tenant/);
    });

    test('handles ELEVATED_ROLE_ATTACHED refusal without throwing or purging PII', () => {
      expect(adapterSrc).toMatch(/err\.code === 'ELEVATED_ROLE_ATTACHED'/);
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.refused_elevated/);
    });

    test('all three guard refusals call _alertOperatorFinalizeRefused for operator visibility', () => {
      const refusalMatches = adapterSrc.match(/_alertOperatorFinalizeRefused/g) || [];
      // 4 call sites: 3 catch branches + 1 method definition
      expect(refusalMatches.length).toBeGreaterThanOrEqual(4);
    });

    test('any other Kisi error throws so BullMQ can retry', () => {
      // After the three guard refusals are caught and returned, anything else throws
      expect(adapterSrc).toMatch(/adapter\.finalize_revoke\.kisi_delete_failed/);
      expect(adapterSrc).toMatch(/throw err;/);
    });
  });

  describe('DB finalize transaction', () => {
    test("UPDATE member_access SET status = 'deleted'", () => {
      expect(adapterSrc).toMatch(/UPDATE member_access SET status = 'deleted'/);
    });

    test('UPDATE member_master NULL all five PII columns', () => {
      expect(adapterSrc).toMatch(/UPDATE member_master/);
      expect(adapterSrc).toMatch(/email = NULL/);
      expect(adapterSrc).toMatch(/first_name = NULL/);
      expect(adapterSrc).toMatch(/last_name = NULL/);
      expect(adapterSrc).toMatch(/display_name = NULL/);
      expect(adapterSrc).toMatch(/phone = NULL/);
    });

    test('wrapped in BEGIN/COMMIT/ROLLBACK transaction', () => {
      // Find the DB finalize block and verify the transaction shape
      const finalizeIdx = adapterSrc.search(/DB finalize/);
      const slice = adapterSrc.slice(finalizeIdx, finalizeIdx + 800);
      expect(slice).toMatch(/await dbClient\.query\('BEGIN'\)/);
      expect(slice).toMatch(/await dbClient\.query\('COMMIT'\)/);
      expect(slice).toMatch(/await dbClient\.query\('ROLLBACK'\)/);
    });

    test('lineage preserved — platform_member_id, source_tag, hardware_user_id NOT NULLed', () => {
      // Only the five PII columns should be NULLed
      expect(adapterSrc).not.toMatch(/platform_member_id = NULL/);
      expect(adapterSrc).not.toMatch(/source_tag = NULL/);
      expect(adapterSrc).not.toMatch(/hardware_user_id = NULL/);
    });
  });

  describe('queue-worker integration', () => {
    test('finalizeRevoke is called only when targetStatus is inactive', () => {
      expect(workerSrc).toMatch(/if \(targetStatus === 'inactive'\)/);
      expect(workerSrc).toMatch(/standardAdapter\.finalizeRevoke/);
    });

    test('finalizeRevoke runs AFTER completeRevoke (ordering invariant)', () => {
      const completeIdx = workerSrc.search(/await standardAdapter\.completeRevoke/);
      const finalizeIdx = workerSrc.search(/await standardAdapter\.finalizeRevoke/);
      expect(completeIdx).toBeGreaterThan(-1);
      expect(finalizeIdx).toBeGreaterThan(-1);
      expect(completeIdx).toBeLessThan(finalizeIdx);
    });

    test('finalize errors are thrown so BullMQ retries the whole revoke', () => {
      expect(workerSrc).toMatch(/queue\.revoke\.finalize_failed/);
      // Look for the throw in the finalize catch block
      const finalizeFailedIdx = workerSrc.search(/queue\.revoke\.finalize_failed/);
      const slice = workerSrc.slice(finalizeFailedIdx, finalizeFailedIdx + 400);
      expect(slice).toMatch(/throw finalizeErr/);
    });

    test('no api key path logs a warn and skips finalize (does NOT throw)', () => {
      expect(workerSrc).toMatch(/queue\.revoke\.finalize_skipped_no_api_key/);
    });
  });

  describe('EVENT_REGISTRY parity', () => {
    const registry = fs.readFileSync(
      path.join(__dirname, '../../core/EVENT_REGISTRY.md'),
      'utf8'
    );
    const overrides = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../core/EVENT_REGISTRY.json'),
      'utf8'
    ));

    test.each([
      'adapter.finalize_revoke.delete_kisi_user_start',
      'adapter.finalize_revoke.complete',
      'adapter.finalize_revoke.already_deleted',
      'adapter.finalize_revoke.access_still_active',
      'adapter.finalize_revoke.access_missing',
      'adapter.finalize_revoke.no_hardware_user',
      'adapter.finalize_revoke.refused_unowned',
      'adapter.finalize_revoke.refused_cross_tenant',
      'adapter.finalize_revoke.refused_elevated',
      'adapter.finalize_revoke.refused_foreign_source_tag',
      'adapter.finalize_revoke.kisi_delete_failed',
      'adapter.finalize_revoke.db_finalize_failed',
    ])('event %s is documented in EVENT_REGISTRY.md', (eventName) => {
      // toMatch with a string does substring search — no regex escaping needed
      expect(registry.includes(eventName)).toBe(true);
    });

    test('adapter.finalize_revoke.complete has persist:true (trace-closing line)', () => {
      expect(overrides.overrides['adapter.finalize_revoke.complete']).toEqual({ persist: true });
    });
  });
});
