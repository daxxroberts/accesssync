/**
 * P3 — member-sync-api.js getAccessStatus(): must gate visible plans/doors on
 * member_access_sources.status, not member_billing.status.
 *
 * INCIDENT 2026-07-03: a member with 5 active member_access_sources rows (confirmed live —
 * all status='active') only saw 2 plans and 1 partially-attributed door in "My Access".
 * Root cause: the query's WHERE clause required `mas.billing_id IN (SELECT id FROM
 * member_billing WHERE status = 'active')` — but member_billing.status reflects the
 * billing/order record's own lifecycle (e.g. 'completed' for a fully-processed order cycle),
 * not whether the plan currently grants door access. 3 of the 5 plans had billing rows with
 * status='completed' (a legitimate billing state) and were silently hidden from a member-
 * facing screen even though their access sources were fully active.
 *
 * member_access_sources.status is the one column whose enum literally means "is this
 * plan-grant currently active" (DR-046). member_billing exists purely for rate/snapshot
 * enrichment (LEFT JOIN, may be absent or non-active without affecting visibility).
 *
 * Static-scan test — verifies the query shape in the source file directly, consistent with
 * this repo's other schema-shape regression guards (e.g. ob-248-finalize-revoke.test.js).
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('member-sync-api.js getAccessStatus() — access visibility gated on the right table', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '../../core/member-sync-api.js'),
    'utf8'
  );

  test('the plans/doors query does NOT gate on member_billing.status in its WHERE clause', () => {
    // The LEFT JOIN below may still filter mb.status='active' for enrichment purposes (rate
    // label) — that's fine, a null/missing rate just means no rate is shown. What must NOT
    // happen is a WHERE-clause requirement that the billing row itself be 'active', which
    // hides fully-active door access behind an unrelated billing lifecycle state.
    expect(src).not.toMatch(/WHERE ma\.id = ANY\(\$1\)\s*\n\s*AND mas\.billing_id IN/);
  });

  test('the plans/doors query DOES gate on mas.status (member_access_sources), the real access-state column', () => {
    expect(src).toMatch(/WHERE ma\.id = ANY\(\$1\)\s*\n\s*AND mas\.status = 'active'/);
  });
});
