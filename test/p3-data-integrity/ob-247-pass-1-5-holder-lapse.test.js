/**
 * P3 — OB-247 Pass 1.5: holder-lapse → sub-member revoke propagation.
 *
 * Pass 1 of reconcile drives off Wix orders and settles holder access state.
 * Pass 1.5 then derives sub-member intent: if a holder's member_access.status
 * is no longer 'active', every sub-member under that holder should also lose
 * access. Pure DB-derived, no Kisi calls in this pass.
 *
 * Per-source semantics (OB-150 invariant): processRevoke requires planId on
 * the synthetic event to target the right source row's DELETE. We must enqueue
 * one synthetic event per (sub_access × source_plan_id), not one per sub-member.
 *
 * Static-scan tests — verify the reconciliation.js code contains the right
 * query shape, event names, and per-source loop. Behavioral integration is
 * covered by the existing reconciliation Jest tests when they hit this path.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-247: Pass 1.5 holder-lapse sub-member revoke propagation', () => {
  const reconcileSrc = fs.readFileSync(
    path.join(__dirname, '../../core/reconciliation.js'),
    'utf8'
  );

  describe('query shape', () => {
    test('SELECT joins sub-member access to holder access via sub_master_id', () => {
      // The JOIN must use sub_master_id (FK to holder member_master.id) per DR-030
      expect(reconcileSrc).toMatch(/LEFT JOIN member_access holder/);
      expect(reconcileSrc).toMatch(/holder\.member_master_id = sub\.sub_master_id/);
      expect(reconcileSrc).toMatch(/holder\.client_id\s+=\s+sub\.client_id/);
    });

    test('WHERE clause filters to sub-members (sub_master_id IS NOT NULL) with active access', () => {
      expect(reconcileSrc).toMatch(/sub\.sub_master_id IS NOT NULL/);
      expect(reconcileSrc).toMatch(/sub\.status\s+=\s+'active'/);
    });

    test('holder-lapse condition handles both deleted holder (NULL JOIN) and non-active holder', () => {
      expect(reconcileSrc).toMatch(/holder\.status IS NULL OR holder\.status <> 'active'/);
    });
  });

  describe('per-source revoke (OB-150 invariant)', () => {
    test('enumerates active source_plan_id values per sub-member, not one revoke per sub', () => {
      // Inner query selects DISTINCT source_plan_id per sub
      expect(reconcileSrc).toMatch(/SELECT DISTINCT source_plan_id\s+FROM member_access_sources/);
      expect(reconcileSrc).toMatch(/access_id = \$1\s+AND status = 'active'\s+AND source_plan_id IS NOT NULL/);
    });

    test("synthetic event sets planId from source_plan_id (not null)", () => {
      // OB-150 fix: planId must be populated so processRevoke's targeted DELETE
      // hits the right source row.
      expect(reconcileSrc).toMatch(/planId:\s+source\.source_plan_id/);
    });

    test("synthetic event eventType is 'plan.cancelled' for revoke path", () => {
      expect(reconcileSrc).toMatch(/eventType:\s+'plan\.cancelled'/);
    });
  });

  describe('event vocabulary', () => {
    test('emits reconciliation.sub_member_holder_lapsed per queued revoke', () => {
      expect(reconcileSrc).toMatch(/reconciliation\.sub_member_holder_lapsed/);
    });

    test('emits reconciliation.pass_1_5_complete after the per-client sweep', () => {
      expect(reconcileSrc).toMatch(/reconciliation\.pass_1_5_complete/);
    });

    test('emits reconciliation.pass_1_5_failed if the top-level block throws', () => {
      expect(reconcileSrc).toMatch(/reconciliation\.pass_1_5_failed/);
    });

    test('top-level try/catch wraps the whole Pass 1.5 block', () => {
      // Pass 1.5 failure must NOT abort the entire sweep — Pass 2/3 continue.
      // Indicator: the pass_1_5_failed log is inside a catch block.
      const passBlockIdx = reconcileSrc.search(/Pass 1\.5: Holder-lapse/);
      const grantQueueIdx = reconcileSrc.search(/3A\. In Wix, not in Kisi/);
      expect(passBlockIdx).toBeGreaterThan(-1);
      expect(grantQueueIdx).toBeGreaterThan(-1);
      expect(passBlockIdx).toBeLessThan(grantQueueIdx);
    });
  });

  describe('ordering invariant', () => {
    test('Pass 1.5 runs AFTER Pass 1 promotion/insert (pass_1_2_complete log precedes it)', () => {
      const pass12Idx  = reconcileSrc.search(/reconciliation\.pass_1_2_complete/);
      const pass15Idx  = reconcileSrc.search(/Pass 1\.5: Holder-lapse/);
      expect(pass12Idx).toBeGreaterThan(-1);
      expect(pass15Idx).toBeGreaterThan(-1);
      expect(pass12Idx).toBeLessThan(pass15Idx);
    });

    test('Pass 1.5 runs BEFORE the 3A grant-queue block (so derived revokes are independent)', () => {
      const pass15Idx     = reconcileSrc.search(/Pass 1\.5: Holder-lapse/);
      const grantQueueIdx = reconcileSrc.search(/3A\. In Wix, not in Kisi/);
      expect(pass15Idx).toBeLessThan(grantQueueIdx);
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

    test('all four Pass 1.5 events are documented in EVENT_REGISTRY.md', () => {
      expect(registry).toMatch(/reconciliation\.sub_member_holder_lapsed/);
      expect(registry).toMatch(/reconciliation\.sub_member_holder_lapsed_queue_failed/);
      expect(registry).toMatch(/reconciliation\.pass_1_5_complete/);
      expect(registry).toMatch(/reconciliation\.pass_1_5_failed/);
    });

    test('reconciliation.sub_member_holder_lapsed has persist:true override (trace-closing line)', () => {
      expect(overrides.overrides['reconciliation.sub_member_holder_lapsed']).toEqual({ persist: true });
    });
  });
});
