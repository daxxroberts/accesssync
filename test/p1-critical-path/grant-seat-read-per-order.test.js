/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: the nightly sweep grants a re-purchase whose webhook was lost│
 * │                                                                         │
 * │  Business consequence: a holder who released their seat on an OLD order │
 * │  and re-bought the plan has paid for a live seat. The sweep's synthetic │
 * │  grant carries no Wix order of its own, so the grant path read the      │
 * │  seat flag plan-wide, found the old order's "released" and refused —    │
 * │  every sweep, while the member stood at a locked door. It now reads the │
 * │  flag for the paying order(s) the sweep names (seatOrderIds).           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const db = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');

const MASTER = 'mm-1', PLAN = 'plan-1';
let flags;   // wix_order_id → holder_seated (newest row); a missing key = no billing row for that order
beforeEach(() => {
  jest.clearAllMocks();
  flags = {};
  db.query.mockImplementation(async (sql, params) => {
    if (/wix_order_id = \$3/.test(sql)) {
      const v = flags[params[2]];
      return { rows: v === undefined ? [] : [{ holder_seated: v }] };
    }
    // plan-wide read: the OLD released order is the newest row
    return { rows: [{ holder_seated: false }] };
  });
});

const resolve = (orderIds) => standardAdapter._resolveHolderSeated(null, MASTER, PLAN, orderIds);

test('a re-purchase with no billing row yet is seated, even though an older order on the plan was released', async () => {
  flags = { 'ord-old': false };
  expect(await resolve(['ord-new'])).toBeNull();          // null = not released → the grant goes ahead
  expect(db.query.mock.calls.every(([sql]) => /wix_order_id = \$3/.test(sql))).toBe(true);   // never the plan-wide read
});

test('two paying orders: released only when BOTH are released', async () => {
  flags = { 'ord-a': false, 'ord-b': true };
  expect(await resolve(['ord-a', 'ord-b'])).toBeNull();
  flags = { 'ord-a': false, 'ord-b': false };
  expect(await resolve(['ord-a', 'ord-b'])).toBe(false);
});

test('a holder who released THIS order is still suppressed', async () => {
  flags = { 'ord-a': false };
  expect(await resolve(['ord-a'])).toBe(false);
});

test('without order ids (holder-claim-slot, bookings) the plan-wide read is unchanged', async () => {
  expect(await resolve(null)).toBe(false);
  expect(db.query.mock.calls[0][0]).not.toMatch(/wix_order_id/);
});

test('a value the billing write already returned is used as-is (no extra read)', async () => {
  expect(await standardAdapter._resolveHolderSeated(true, MASTER, PLAN, ['ord-a'])).toBe(true);
  expect(db.query).not.toHaveBeenCalled();
});
