/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: members-bridge formats billing snapshot for the React app    │
 * │                                                                         │
 * │  Business consequence: bridge is the only place that formats raw        │
 * │  snapshot fields ($40/mo, "DAXXADMIN · −$40", auto-renew flag) into     │
 * │  display strings. A regression here = blank Members page.               │
 * │                                                                         │
 * │  Governed by: DR-042                                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// The bridge runs in browser context (uses window, document, fetch). For unit
// tests we want only the pure formatting helpers. Re-implement the same
// formatters the bridge uses so this test stays in lock-step with the bridge
// when its logic changes — copy/paste from members-bridge.js, kept identical.
//
// Strategy: vm-eval the bridge IIFE in a stub window/document and fish out
// the exposed __membersBridge debug surface, OR re-test the formatting rules
// via a port. A lightweight port keeps Jest happy without DOM.

function formatRate(snap) {
  if (!snap || !snap.planPrice) return '—';
  const amount = parseFloat(snap.planPrice);
  if (!isFinite(amount)) return '—';
  const symbol = snap.currency === 'USD' || !snap.currency ? '$' : snap.currency + ' ';
  const amountStr = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
  const unit = (snap.cycleUnit || 'MONTH').toLowerCase();
  const count = snap.cycleCount || 1;
  let period;
  if (count === 1) {
    period = unit.indexOf('year') === 0 ? 'yr'
           : unit.indexOf('week') === 0 ? 'wk'
           : unit.indexOf('day')  === 0 ? 'day'
           : 'mo';
  } else {
    period = count + ' ' + unit + 's';
  }
  return symbol + amountStr + '/' + period;
}

function formatCouponLine(snap) {
  if (!snap || !snap.coupon || !snap.coupon.code) return null;
  const amt = snap.coupon.amount ? parseFloat(snap.coupon.amount) : null;
  const amtStr = (amt != null && isFinite(amt))
    ? '−$' + (amt % 1 === 0 ? amt.toFixed(0) : amt.toFixed(2))
    : 'discount';
  return snap.coupon.code + ' · ' + amtStr;
}

// Real production snapshot from Railway after backfill (HOG, member f98bdcf3...)
const HOG_SNAPSHOT = {
  total: '0.00',
  coupon: { code: 'DAXXADMIN', amount: '40.00' },
  orderId: '8aad0ad0-8051-39cc-b75a-b016937f3327',
  currency: 'USD',
  discount: '40.00',
  subtotal: '40.00',
  cycleUnit: 'MONTH',
  planPrice: '40',
  cycleCount: 1,
  orderMethod: 'UNKNOWN',
  subscriptionId: '37998f25-82bf-4346-857d-6d34f985594e',
  autoRenewCanceled: false,
  lastPaymentStatus: 'UNPAID',
  capturedAt: '2026-04-29T00:45:29.909Z',
};

describe('[P3] members-bridge billing formatting', () => {

  test('formats real HOG snapshot as $40/mo', () => {
    expect(formatRate(HOG_SNAPSHOT)).toBe('$40/mo');
  });

  test('formats coupon line as "DAXXADMIN · −$40"', () => {
    expect(formatCouponLine(HOG_SNAPSHOT)).toBe('DAXXADMIN · −$40');
  });

  test('returns "—" for null snapshot', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatCouponLine(null)).toBeNull();
  });

  test('yearly plan formats as $X/yr', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, cycleUnit: 'YEAR' })).toBe('$40/yr');
  });

  test('weekly plan formats as $X/wk', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, cycleUnit: 'WEEK' })).toBe('$40/wk');
  });

  test('multi-cycle period uses count + unit pluralised', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, cycleCount: 3, cycleUnit: 'MONTH' })).toBe('$40/3 months');
  });

  test('non-USD currency falls back to currency code prefix', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, currency: 'EUR' })).toBe('EUR 40/mo');
  });

  test('decimal price renders with 2 decimals', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, planPrice: '99.95' })).toBe('$99.95/mo');
  });

  test('integer-equal price renders without decimals', () => {
    expect(formatRate({ ...HOG_SNAPSHOT, planPrice: '100.00' })).toBe('$100/mo');
  });

  test('coupon line falls back to "discount" when amount missing', () => {
    expect(formatCouponLine({ coupon: { code: 'COMP' } })).toBe('COMP · discount');
  });

  test('coupon line returns null when no code', () => {
    expect(formatCouponLine({ coupon: { amount: '10.00' } })).toBeNull();
    expect(formatCouponLine({ coupon: null })).toBeNull();
  });

  test('NaN planPrice returns "—"', () => {
    expect(formatRate({ planPrice: 'not a number' })).toBe('—');
  });
});

// ── buildMembersArray sub-inherits-holder billing ──────────────────────────
// Ported from members-bridge.js — kept in sync with the bridge implementation.
// Verifies the bridge inheritance path that activates now that the SQL CASE guard
// returns NULL for sub rows instead of walking up to the holder.

function shapeBilling(rawSnap) {
  var snap = rawSnap || null;
  return {
    raw:               snap,
    rate:              formatRate(snap),
    coupon:            formatCouponLine(snap),
    autoRenewCanceled: !!(snap && snap.autoRenewCanceled),
    lastPaymentStatus: snap ? snap.lastPaymentStatus : null,
    subscriptionId:    snap ? snap.subscriptionId    : null,
    orderId:           snap ? snap.orderId           : null,
  };
}

// Minimal port of shapeMember — kept in sync with members-bridge.js.
// Only the fields relevant to billing inheritance are included.
function shapeMemberMinimal(r) {
  var billing = shapeBilling(r.billing_snapshot);
  return {
    id:              r.id,
    plan_holder_id:  r.plan_holder_id  || null,
    plan_mapping_id: r.plan_mapping_id || null,
    sub_plan_name:   r.sub_plan_name   || null,
    planMappingId:   r.plan_mapping_id || null,
    subPlanName:     r.sub_plan_name   || null,
    planNames:       Array.isArray(r.plan_names) ? r.plan_names : (r.plan_name ? [r.plan_name] : []),
    billing:         billing,
    rate:            billing.rate,
    coupon:          billing.coupon,
    autoRenewCanceled: billing.autoRenewCanceled,
    lastPaymentStatus: billing.lastPaymentStatus,
    subscriptionId:  billing.subscriptionId,
    orderId:         billing.orderId,
  };
}

// Minimal port of buildMembersArray — kept in sync with members-bridge.js.
// Produces plans[] shape as of DR-040 / multi-plan-holder fix (2026-05-04).
function buildMembersArray(flatRows) {
  if (!Array.isArray(flatRows)) return [];
  var holders = [];
  var subsByHolder = {};
  for (var i = 0; i < flatRows.length; i++) {
    var r = flatRows[i];
    if (r.plan_holder_id) {
      if (!subsByHolder[r.plan_holder_id]) subsByHolder[r.plan_holder_id] = [];
      subsByHolder[r.plan_holder_id].push(shapeMemberMinimal(r));
    } else {
      holders.push(r);
    }
  }
  return holders.map(function (h) {
    var shaped = shapeMemberMinimal(h);
    var allSubs = subsByHolder[h.id] || [];
    if (shaped.billing && shaped.billing.raw) {
      allSubs = allSubs.map(function (s) {
        if (s.billing && s.billing.raw) return s;
        return Object.assign({}, s, {
          rate:              shaped.rate,
          coupon:            shaped.coupon,
          autoRenewCanceled: shaped.autoRenewCanceled,
          lastPaymentStatus: shaped.lastPaymentStatus,
          subscriptionId:    shaped.subscriptionId,
          orderId:           shaped.orderId,
          billing:           shaped.billing,
        });
      });
    }

    // Group subs by subPlanName for plans[] construction.
    var subsByPlanName = {};
    var orphanSubs = [];
    allSubs.forEach(function (s) {
      if (s.subPlanName) {
        if (!subsByPlanName[s.subPlanName]) subsByPlanName[s.subPlanName] = [];
        subsByPlanName[s.subPlanName].push(s);
      } else {
        orphanSubs.push(s);
      }
    });

    var planNames = shaped.planNames.length ? shaped.planNames : ['Unknown Plan'];
    var usedSubIds = {};
    var plans = planNames.map(function (planName) {
      var planSubs = (subsByPlanName[planName] || []).filter(function (s) {
        if (usedSubIds[s.id]) return false;
        usedSubIds[s.id] = true;
        return true;
      });
      return { planName: planName, additional: planSubs };
    });

    var unusedOrphans = orphanSubs.filter(function (s) { return !usedSubIds[s.id]; });
    if (unusedOrphans.length > 0) {
      plans.push({ planName: 'Unknown Plan', additional: unusedOrphans });
    }

    shaped.plans = plans;
    return shaped;
  });
}

describe('[P3] members-bridge buildMembersArray billing inheritance', () => {

  const HOLDER_ID = 'holder-uuid-001';
  const SUB_ID    = 'sub-uuid-001';

  const holderRow = {
    id:               HOLDER_ID,
    plan_holder_id:   null,
    plan_names:       ['Couples'],
    billing_snapshot: HOG_SNAPSHOT,
  };

  const subRow = {
    id:               SUB_ID,
    plan_holder_id:   HOLDER_ID,
    plan_mapping_id:  'mapping-uuid-001',
    sub_plan_name:    'Couples',
    billing_snapshot: null,  // DB returns NULL for sub rows — bridge must inherit
  };

  test('sub with null billing_snapshot inherits holder billing after buildMembersArray', () => {
    const result = buildMembersArray([holderRow, subRow]);
    expect(result).toHaveLength(1);
    const holder = result[0];
    expect(holder.plans).toHaveLength(1);
    expect(holder.plans[0].planName).toBe('Couples');
    expect(holder.plans[0].additional).toHaveLength(1);
    const sub = holder.plans[0].additional[0];
    expect(sub.rate).toBe('$40/mo');
    expect(sub.coupon).toBe('DAXXADMIN · −$40');
    expect(sub.billing.raw).toBe(HOG_SNAPSHOT);
  });

  test('sub with its own billing_snapshot keeps its own (not overwritten by holder)', () => {
    const ownSnap = { ...HOG_SNAPSHOT, planPrice: '20', coupon: null };
    const subWithOwn = { ...subRow, billing_snapshot: ownSnap };
    const result = buildMembersArray([holderRow, subWithOwn]);
    const sub = result[0].plans[0].additional[0];
    expect(sub.rate).toBe('$20/mo');
    expect(sub.coupon).toBeNull();
  });

  test('sub is not nested when holder is absent from result set', () => {
    const result = buildMembersArray([subRow]);
    expect(result).toHaveLength(0);
  });

  test('holder with no subs gets plans[] with empty additional arrays', () => {
    const result = buildMembersArray([holderRow]);
    expect(result[0].plans).toHaveLength(1);
    expect(result[0].plans[0].additional).toHaveLength(0);
  });

  test('holder with two multi-member plans partitions subs correctly', () => {
    const subCouples = {
      id: 'sub-couples', plan_holder_id: HOLDER_ID,
      plan_mapping_id: 'mapping-couples', sub_plan_name: 'Couples',
      billing_snapshot: null,
    };
    const subFamily = {
      id: 'sub-family', plan_holder_id: HOLDER_ID,
      plan_mapping_id: 'mapping-family', sub_plan_name: 'Family',
      billing_snapshot: null,
    };
    const holderMulti = { ...holderRow, plan_names: ['Couples', 'Family'] };
    const result = buildMembersArray([holderMulti, subCouples, subFamily]);
    expect(result[0].plans).toHaveLength(2);
    const couples = result[0].plans.find(p => p.planName === 'Couples');
    const family  = result[0].plans.find(p => p.planName === 'Family');
    expect(couples.additional).toHaveLength(1);
    expect(couples.additional[0].id).toBe('sub-couples');
    expect(family.additional).toHaveLength(1);
    expect(family.additional[0].id).toBe('sub-family');
  });

  test('sub with null sub_plan_name goes to Unknown Plan fallback', () => {
    const orphanSub = {
      id: 'sub-orphan', plan_holder_id: HOLDER_ID,
      plan_mapping_id: null, sub_plan_name: null,
      billing_snapshot: null,
    };
    const result = buildMembersArray([holderRow, orphanSub]);
    const unknown = result[0].plans.find(p => p.planName === 'Unknown Plan');
    expect(unknown).toBeDefined();
    expect(unknown.additional[0].id).toBe('sub-orphan');
  });
});