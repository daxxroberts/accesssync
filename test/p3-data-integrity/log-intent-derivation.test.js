/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                             │
 * │  admin/public/humanize.js — deriveIntent()                               │
 * │                                                                          │
 * │  2026-08-04: the Trace Timeline group header showed WHO (client/member)  │
 * │  but never WHAT (new signup vs. renewal vs. cancellation vs. failure) —  │
 * │  an operator had to expand every trace and read the raw rows to find     │
 * │  out. deriveIntent() picks one plain-English intent label per trace out  │
 * │  of fields already returned by v_trace_timeline; no migration.           │
 * │                                                                          │
 * │  humanize.js is a browser-global IIFE (no module system, no build       │
 * │  step) — loaded here by stubbing `global.window` before require(),       │
 * │  same technique the file's own header comment describes ("no            │
 * │  dependencies, browser global").                                        │
 * │                                                                          │
 * │  What CANNOT regress:                                                    │
 * │    1. Each taxonomy rule fires on its matching event shape               │
 * │    2. Priority order — a trace with BOTH a grant and a later             │
 * │       cancellation reads "Plan cancelled", not "New signup"              │
 * │    3. Renewal detection reads cycleIndex/isRenewal from the diagnostic   │
 * │       row's `detail`, not the webhook row                                │
 * │    4. No match → null (caller falls back, never shows a guessed label)   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

global.window = {};
require('../../admin/public/humanize.js');
const { deriveIntent } = global.window.AccessSyncHumanize;

function ev(source, event, extra = {}) {
  return { source, event, result: 'success', detail: null, ts: '2026-08-04T00:00:00.000Z', ...extra };
}

describe('[P3] deriveIntent — Trace Timeline header intent label', () => {
  test('payment.failed webhook → Payment failed / error', () => {
    expect(deriveIntent([ev('webhook', 'payment.failed')]))
      .toEqual({ label: 'Payment failed', tone: 'error' });
  });

  test('member_access revoked → Access revoked / error', () => {
    expect(deriveIntent([ev('member_access', 'revoked')]))
      .toEqual({ label: 'Access revoked', tone: 'error' });
  });

  test('member_access deleted (DR-044 finalize) → Access revoked / error', () => {
    expect(deriveIntent([ev('member_access', 'deleted')]))
      .toEqual({ label: 'Access revoked', tone: 'error' });
  });

  test('member_access disabled (payment.failed suspend path) → Access suspended / warn', () => {
    expect(deriveIntent([ev('member_access', 'disabled')]))
      .toEqual({ label: 'Access suspended', tone: 'warn' });
  });

  test('payment.recovered webhook → Payment recovered / success', () => {
    expect(deriveIntent([ev('webhook', 'payment.recovered')]))
      .toEqual({ label: 'Payment recovered', tone: 'success' });
  });

  test('plan.cancelled webhook → Plan cancelled / warn', () => {
    expect(deriveIntent([ev('webhook', 'plan.cancelled')]))
      .toEqual({ label: 'Plan cancelled', tone: 'warn' });
  });

  test('member_access cancelled_by_member (never-provisioned skip path) → Plan cancelled / warn', () => {
    expect(deriveIntent([ev('member_access', 'cancelled_by_member')]))
      .toEqual({ label: 'Plan cancelled', tone: 'warn' });
  });

  test('admin.sub_member_removed → Sub-member removed / warn', () => {
    expect(deriveIntent([ev('diagnostic', 'admin.sub_member_removed')]))
      .toEqual({ label: 'Sub-member removed', tone: 'warn' });
  });

  test('admin.holder_release_slot_queued → Seat released / warn', () => {
    expect(deriveIntent([ev('diagnostic', 'admin.holder_release_slot_queued')]))
      .toEqual({ label: 'Seat released', tone: 'warn' });
  });

  test('admin.sub_member_added → Sub-member added / success', () => {
    expect(deriveIntent([ev('diagnostic', 'admin.sub_member_added')]))
      .toEqual({ label: 'Sub-member added', tone: 'success' });
  });

  test('admin.holder_claim_slot_queued → Seat claimed / success', () => {
    expect(deriveIntent([ev('diagnostic', 'admin.holder_claim_slot_queued')]))
      .toEqual({ label: 'Seat claimed', tone: 'success' });
  });

  test('plan.purchased with no renewal signal → New signup / success', () => {
    expect(deriveIntent([ev('webhook', 'plan.purchased')]))
      .toEqual({ label: 'New signup', tone: 'success' });
  });

  test('booking.confirmed → New signup / success (no Wix order-cycle concept)', () => {
    expect(deriveIntent([ev('webhook', 'booking.confirmed')]))
      .toEqual({ label: 'New signup', tone: 'success' });
  });

  test('plan.purchased + diagnostic isRenewal:false → New signup / success', () => {
    expect(deriveIntent([
      ev('webhook', 'plan.purchased'),
      ev('diagnostic', 'queue.grant.complete', { detail: { cycleIndex: 1, isRenewal: false } }),
    ])).toEqual({ label: 'New signup', tone: 'success' });
  });

  test('plan.purchased + diagnostic isRenewal:true → Recurring renewal / info', () => {
    expect(deriveIntent([
      ev('webhook', 'plan.purchased'),
      ev('diagnostic', 'queue.grant.complete', { detail: { cycleIndex: 4, isRenewal: true } }),
    ])).toEqual({ label: 'Recurring renewal', tone: 'info' });
  });

  test('priority: a grant followed by a cancellation reads "Plan cancelled", not "New signup"', () => {
    expect(deriveIntent([
      ev('webhook', 'plan.purchased'),
      ev('diagnostic', 'queue.grant.complete', { detail: { cycleIndex: 1, isRenewal: false } }),
      ev('webhook', 'plan.cancelled'),
    ])).toEqual({ label: 'Plan cancelled', tone: 'warn' });
  });

  test('priority: a failed payment outranks a same-trace revoke label (error path wins)', () => {
    expect(deriveIntent([
      ev('webhook', 'payment.failed'),
      ev('member_access', 'disabled'),
    ])).toEqual({ label: 'Payment failed', tone: 'error' });
  });

  test('no matching event → null, caller falls back to raw humanize()', () => {
    expect(deriveIntent([ev('admin_audit', 'admin.client_created')])).toBeNull();
  });

  test('empty events array → null', () => {
    expect(deriveIntent([])).toBeNull();
  });

  test('null/undefined events → null (never throws)', () => {
    expect(deriveIntent(null)).toBeNull();
    expect(deriveIntent(undefined)).toBeNull();
  });
});
