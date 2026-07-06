/**
 * P3 — OB-244 member_access.status enum coverage.
 *
 * Regression guard: the CHECK constraint on member_access.status MUST allow all
 * 7 lifecycle states the code writes. Pre-OB-244 it only allowed 5, which 500'd
 * the Member Hub Remove flow because admin/routes/multi-member.js writes
 * 'removing' before DR-044 finalize writes 'deleted'.
 *
 * If a future schema change drops one of these values, this test fails before
 * deploy, surfacing the regression at gate time instead of in production.
 *
 * Tested via static scan of the migration file (deploy gate doesn't run live SQL).
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('OB-244: member_access.status CHECK constraint covers all DR-044 + OB-202 states', () => {
  const migration = fs.readFileSync(
    path.join(__dirname, '../../migrations/ob-244-member-access-status-dr-044-states.sql'),
    'utf8'
  );

  test('migration drops the old constraint before re-adding (idempotent on re-run)', () => {
    expect(migration).toMatch(/ALTER TABLE member_access DROP CONSTRAINT member_access_status_check/);
  });

  test.each([
    ['active'],
    ['inactive'],
    ['in_flight'],
    ['pending_identity'],
    ['recovery_pending'],
    ['removing'],
    ['deleted'],
  ])('CHECK constraint includes %s', (status) => {
    expect(migration).toMatch(new RegExp(`'${status}'`));
  });

  test('CHECK constraint is on the status column', () => {
    expect(migration).toMatch(/CHECK\s*\(status IN/);
  });

  test('COMMENT ON COLUMN documents all 7 values for future agents', () => {
    expect(migration).toMatch(/COMMENT ON COLUMN member_access\.status/);
    // Each state should be explained in the comment so docs don't drift from constraint.
    expect(migration).toMatch(/active.*source active/i);
    expect(migration).toMatch(/in_flight.*lock/i);
    expect(migration).toMatch(/recovery_pending.*OB-202/i);
    expect(migration).toMatch(/removing.*DR-044/i);
    expect(migration).toMatch(/deleted.*DR-044.*terminal/i);
  });

  describe('code-side parity — handler writes match the constraint', () => {
    const deleteHandler = fs.readFileSync(
      path.join(__dirname, '../../admin/routes/multi-member.js'),
      'utf8'
    );
    const standardAdapterSrc = fs.readFileSync(
      path.join(__dirname, '../../adapters/standard-adapter.js'),
      'utf8'
    );

    test("DELETE /api/multi-member/members/:subId still writes status='removing' via L3 (DR-044 entry, DR-023)", () => {
      // If someone refactors this write away, the constraint is no longer load-bearing
      // for this path — but we want to know immediately so we can re-evaluate.
      // The UPDATE itself lives in standard-adapter (L3 owns member_access writes);
      // the route calls the primitive.
      expect(standardAdapterSrc).toMatch(/UPDATE member_access SET status = 'removing'/);
      expect(deleteHandler).toMatch(/standardAdapter\.markSubMemberRemoving\(subId\)/);
    });
  });
});
