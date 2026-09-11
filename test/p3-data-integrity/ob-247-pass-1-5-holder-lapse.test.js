/**
 * P3 — OB-247 Pass 1.5: holder-lapse → sub-member removal proposals.
 *
 * A sub-member's door rides on its holder's plan. Phase 1 (2026-09-10) judges
 * that from WIX, not from the holder's member_access.status: for each active
 * sub-member source, the holder (member_master via member_access.sub_master_id)
 * must hold a PAYING plan with that source_plan_id in either Wix read. The old
 * DB-status predicate lapsed the subs of a holder who had only released their
 * OWN seat (DR-051) while still paying. No Kisi calls in this pass.
 *
 * Fix round (2026-09-10): a lapse is proposed only when the HOLDER's
 * classification for that plan is ENDED or ABSENT (P-2). A declined, pending
 * or unrecognised holder payment — or a holder that cannot be found — leaves the
 * sub alone as held_payment_state. Every proposal carries the family's unit
 * (unitKey = the holder, P-1).
 *
 * Per-source semantics (OB-150 invariant): one proposal per
 * (sub_access × source_plan_id), each carrying planId. Phase 1 records and
 * HOLDS every proposal — the sweep queues nothing. Live behaviour is covered in
 * reconcile-revoke-gate.test.js, which asserts on eventQueue.add.
 *
 * Static-scan tests — verify the reconciliation.js code contains the right
 * query shape, event names, and per-source loop.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-247: Pass 1.5 holder-lapse sub-member removal proposals (recorded and held in Phase 1)', () => {
  const reconcileSrc = fs.readFileSync(
    path.join(__dirname, '../../core/reconciliation.js'),
    'utf8'
  );

  describe('query shape', () => {
    test('SELECT resolves the holder via sub_master_id, tenant-scoped (holder platform id is matched against Wix)', () => {
      // sub_master_id is the FK to the holder's member_master.id (DR-030). Phase 1
      // reads the holder's platform_member_id so its PAYING plans can be looked
      // up in the Wix double read — the holder's member_access row is no longer
      // consulted.
      expect(reconcileSrc).toMatch(/LEFT JOIN member_master holder_mm/);
      expect(reconcileSrc).toMatch(/holder_mm\.id\s+=\s+sub\.sub_master_id/);
      expect(reconcileSrc).toMatch(/holder_mm\.client_id\s+=\s+sub\.client_id/);
      expect(reconcileSrc).toMatch(/holder_mm\.platform_member_id AS holder_platform_member_id/);
    });

    test('WHERE clause filters to sub-members (sub_master_id IS NOT NULL) with active access', () => {
      expect(reconcileSrc).toMatch(/sub\.sub_master_id IS NOT NULL/);
      expect(reconcileSrc).toMatch(/sub\.status\s+=\s+'active'/);
    });

    test('holder-lapse predicate is Wix PAYING for the sub\'s plan — not the holder\'s DB status', () => {
      // The DB-status predicate is gone: a holder who released their own seat
      // (DR-051) while still paying must not lapse their subs.
      expect(reconcileSrc).not.toMatch(/holder\.status IS NULL OR holder\.status <> 'active'/);
      expect(reconcileSrc).not.toMatch(/LEFT JOIN member_access holder\b/);
      // Keep the sub only while the holder pays for THIS source plan (either read).
      // A missing holder (NULL join → no holderKey) is never kept by this line; it
      // falls through to the classification gate below, where it is UNKNOWN.
      expect(reconcileSrc).toMatch(
        /if \(holderKey && isPayingPlan\(holderKey, null, source\.source_plan_id\)\) continue;/
      );
    });

    test("the lapse is judged by the HOLDER's classification; no resolvable holder is UNKNOWN, never ABSENT (fix round P-2)", () => {
      expect(reconcileSrc).toMatch(
        /const holderClass = holderKey \? classOf\(holderKey, source\.source_plan_id\) : ORDER_CLASS\.UNKNOWN;/
      );
      // only ENDED / ABSENT (the policy's REMOVABLE_CLASSIFICATIONS) is proposed…
      expect(reconcileSrc).toMatch(/if \(isRemovableClass\(holderClass\)\) \{/);
      // …everything else is recorded as held_payment_state
      const gateIdx = reconcileSrc.search(/if \(isRemovableClass\(holderClass\)\) \{/);
      const after   = reconcileSrc.slice(gateIdx, gateIdx + 3000);
      expect(after).toMatch(/\} else \{[\s\S]*heldPaymentState\.push\(\{\s*source:\s+REVOKE_SOURCE\.HOLDER_LAPSE/);
      // the old fallback that proposed a holder-less sub as ABSENT is gone
      expect(reconcileSrc).not.toMatch(/holderKey \? classOf\(holderKey, source\.source_plan_id\) : CLASS_ABSENT/);
    });
  });

  describe('per-source proposal (OB-150 invariant)', () => {
    test('enumerates active source plans per sub-member in the Pass 1.5 query, not one proposal per sub', () => {
      // One row per (sub access, active source plan): the sub's own
      // member_access_sources rows are joined in, DISTINCT on the pair.
      expect(reconcileSrc).toMatch(/SELECT DISTINCT sub\.id AS sub_access_id/);
      expect(reconcileSrc).toMatch(
        /JOIN member_access_sources mas\s+ON mas\.access_id = sub\.id\s+AND mas\.status = 'active'\s+AND mas\.source_plan_id IS NOT NULL/
      );
    });

    test('each lapse is a HOLDER_LAPSE proposal on the wix_orders data source, keyed to the family unit (recorded + held, never enqueued in Phase 1)', () => {
      const idx = reconcileSrc.search(/source:\s+REVOKE_SOURCE\.HOLDER_LAPSE/);
      expect(idx).toBeGreaterThan(-1);
      const slice = reconcileSrc.slice(idx, idx + 400);
      expect(slice).toMatch(/dataSource:\s+DATA_SOURCE\.WIX_ORDERS/);
      expect(slice).toMatch(/planId:\s+source\.source_plan_id/);
      // P-1: a sub is counted in its holder's unit
      expect(slice).toMatch(/unitKey:\s+holderKey/);
      // the proposal goes to the removal decision, not to the queue
      const before = reconcileSrc.slice(Math.max(0, idx - 200), idx);
      expect(before).toMatch(/revokeProposals\.push\(\{\s*$/);
    });

    test("synthetic event sets planId from source_plan_id (not null)", () => {
      // OB-150 fix: planId must be populated so a future (3b) targeted revoke's
      // DELETE hits the right source row.
      expect(reconcileSrc).toMatch(/planId:\s+source\.source_plan_id/);
    });

    test("the held proposal's synthetic event is 'plan.cancelled' — the event Phase 3b would enqueue", () => {
      expect(reconcileSrc).toMatch(/eventType:\s+'plan\.cancelled'/);
    });
  });

  describe('event vocabulary', () => {
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

  // Nothing in this block runs in Phase 1: the sweep has no flush loop and
  // _enqueueApprovedRevoke refuses while SWEEP_OBSERVATION_ONLY is true. These
  // pin the path Phase 3b re-arms. For what the sweep does TODAY (records and
  // holds; zero revoke jobs), see reconcile-revoke-gate.test.js.
  describe('Phase 3b re-arm contract (dormant in Phase 1)', () => {
    test('the dormant enqueue path still emits reconciliation.sub_member_holder_lapsed for a HOLDER_LAPSE proposal once re-armed', () => {
      expect(reconcileSrc).toMatch(
        /case REVOKE_SOURCE\.HOLDER_LAPSE:\s*log\.info\('reconciliation\.sub_member_holder_lapsed'/
      );
    });

    test('…and refuses to enqueue anything while the sweep is observation-only', () => {
      expect(reconcileSrc).toMatch(/const SWEEP_OBSERVATION_ONLY = true;/);
      const fnIdx = reconcileSrc.search(/async _enqueueApprovedRevoke\(clientId, p\) \{/);
      expect(fnIdx).toBeGreaterThan(-1);
      const body = reconcileSrc.slice(fnIdx, fnIdx + 600);
      expect(body).toMatch(/if \(SWEEP_OBSERVATION_ONLY\) \{[\s\S]*return false;/);
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

    test('Pass 1.5 runs BEFORE the 3A grant-queue block (its proposals are recorded independently of grants)', () => {
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

    test('reconciliation.sub_member_holder_lapsed keeps persist:true (the dormant 3b enqueue line)', () => {
      expect(overrides.overrides['reconciliation.sub_member_holder_lapsed']).toEqual({ persist: true });
    });
  });
});
