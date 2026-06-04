/**
 * P3 — OB-242 member_billing cycle transition invariant.
 *
 * When a new billing cycle (cycle_index > 1) arrives for the same Wix
 * subscription, standard-adapter.completeGrant must transition prior
 * cycles to status='completed'. Without this, v_active_members returns
 * duplicate rows and downstream UIs (Member Hub My Access / Manage
 * Members, dashboard plan list) show ghost cycles.
 *
 * Trigger: Daxx Student wix_subscription_id 5ad315ea-... auto-renewed
 * 2026-06-03 03:47 UTC. Cycle 2 INSERTed correctly but cycle 1 stayed
 * active. Both rows surfaced in operator + member UIs.
 *
 * Tested via:
 *   - Static check that the schema invariant migration exists
 *   - Static check that completeGrant contains the cycle-close UPDATE
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-242: member_billing cycle transition invariant', () => {
  describe('schema migration', () => {
    test('partial UNIQUE index on (client_id, member_master_id, wix_subscription_id) WHERE status=active exists', () => {
      const migration = fs.readFileSync(
        path.join(__dirname, '../../migrations/ob-242-member-billing-cycle-transition.sql'),
        'utf8'
      );
      expect(migration).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS member_billing_one_active_per_subscription/);
      expect(migration).toMatch(/ON member_billing.*\(client_id,\s*member_master_id,\s*wix_subscription_id\)/s);
      expect(migration).toMatch(/WHERE status = 'active'/);
      expect(migration).toMatch(/AND wix_subscription_id IS NOT NULL/);
    });
  });

  describe('completeGrant cycle-close logic', () => {
    const adapterSrc = fs.readFileSync(
      path.join(__dirname, '../../adapters/standard-adapter.js'),
      'utf8'
    );

    test('contains UPDATE that closes prior cycles when cycle_index > 1', () => {
      // Must update prior cycles for the same subscription
      expect(adapterSrc).toMatch(/UPDATE member_billing/);
      expect(adapterSrc).toMatch(/SET status = 'completed'/);
      expect(adapterSrc).toMatch(/cycle_index < \$3/);
      expect(adapterSrc).toMatch(/wix_subscription_id = \$2/);
      expect(adapterSrc).toMatch(/AND status = 'active'/);
    });

    test('guard prevents UPDATE when cycle_index = 1 (no prior cycle to close)', () => {
      // The cycle-close block must be inside a guard checking cycle > 1
      // so the first cycle doesn't trigger a no-op UPDATE on the whole table.
      expect(adapterSrc).toMatch(/cycleN\s*>\s*1/);
      expect(adapterSrc).toMatch(/wixSubscriptionId\s*&&\s*cycleN\s*>\s*1/);
    });

    test('UPDATE stamps effective_end with the new cycle effective_start (COALESCE preserves existing)', () => {
      expect(adapterSrc).toMatch(/effective_end = COALESCE\(effective_end, \$4\)/);
    });

    test('UPDATE is scoped by client_id (multi-tenancy safety)', () => {
      // Must include client_id in the WHERE clause so we don't accidentally
      // close cycles for the wrong tenant if a subscription_id collides
      // across tenants (theoretical but defensive).
      expect(adapterSrc).toMatch(/UPDATE member_billing[\s\S]+?WHERE client_id = \$1/);
    });

    test('cycle-close UPDATE precedes the INSERT INTO member_billing (ordering invariant)', () => {
      // Trace 5ba96217 (2026-06-04): the OB-242 UPDATE shipped AFTER the INSERT,
      // so the partial UNIQUE index member_billing_one_active_per_subscription
      // tripped on the INSERT before the UPDATE could close the prior cycle.
      // Anchored on block-unique fingerprints (cycle_index < $3 only appears in
      // the cycle-close UPDATE; the full column list only appears in the grant INSERT).
      const updateIdx = adapterSrc.search(/UPDATE member_billing[\s\S]*?cycle_index < \$3/);
      const insertIdx = adapterSrc.search(/INSERT INTO member_billing\s+\(member_master_id, client_id, wix_order_id/);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(insertIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeLessThan(insertIdx);
    });
  });
});
