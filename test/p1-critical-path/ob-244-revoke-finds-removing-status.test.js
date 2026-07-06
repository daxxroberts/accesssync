/**
 * P1 — OB-244 follow-up: standardAdapter.resolveAndLock (revoke path) must find
 * member_access rows in 'removing' status.
 *
 * DR-044 sub-member delete handler at admin/routes/multi-member.js sets
 * status='removing' BEFORE queueing the synthetic plan.cancelled revoke job.
 * The revoke worker then calls resolveAndLock, which executes the lookup query.
 * If 'removing' is missing from the WHERE clause, the resolver returns null
 * and the revoke silently no-ops — door access stays granted.
 *
 * This bug was masked pre-OB-244 because the handler 500'd at the UPDATE
 * (status='removing' violated the post-S-11/OB-202 CHECK constraint) before
 * the job was ever queued. After widening the constraint, the bug surfaced.
 *
 * Tested via static scan + behavior assertion.
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe("OB-244 follow-up: revoke resolve query includes 'removing' status", () => {
  const adapterSrc = fs.readFileSync(
    path.join(__dirname, '../../adapters/standard-adapter.js'),
    'utf8'
  );

  test("resolveAndLock revoke-path query allows status IN ('active','in_flight','removing')", () => {
    // The DR-044 sub-member soft-delete flow REQUIRES finding rows already in
    // 'removing' state, because the handler sets that status BEFORE queueing
    // the synthetic revoke job. Omitting it makes the revoke silently no-op.
    expect(adapterSrc).toMatch(/AND ma\.status IN \('active', 'in_flight', 'removing'\)/);
  });

  test("the older 2-state version (without 'removing') is NOT present", () => {
    // Regression guard — if a future refactor drops 'removing' the test fails.
    const twoStateMatches = adapterSrc.match(/AND ma\.status IN \('active', 'in_flight'\)/g) || [];
    expect(twoStateMatches).toHaveLength(0);
  });

  describe('parity check — handler still writes the state the resolver expects', () => {
    const deleteHandler = fs.readFileSync(
      path.join(__dirname, '../../admin/routes/multi-member.js'),
      'utf8'
    );

    test("multi-member DELETE handler writes status='removing' before queueing revoke", () => {
      // DR-023: the UPDATE itself lives in standard-adapter (markSubMemberRemoving);
      // the handler awaits the primitive. The ordering invariant is unchanged:
      // the write must land BEFORE the queue add, otherwise a race could let the
      // worker see 'active' status and the lock semantics break.
      expect(adapterSrc).toMatch(/UPDATE member_access SET status = 'removing'/);
      const updateIdx = deleteHandler.search(/await standardAdapter\.markSubMemberRemoving\(subId\)/);
      const queueAddIdx = deleteHandler.search(/eventQueue\.add\('revoke'/);
      expect(updateIdx).toBeGreaterThan(-1);
      expect(queueAddIdx).toBeGreaterThan(-1);
      expect(updateIdx).toBeLessThan(queueAddIdx);
    });
  });
});
