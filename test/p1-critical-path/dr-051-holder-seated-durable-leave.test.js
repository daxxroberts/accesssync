/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                              │
 * │  DR-051 — Durable "Leave this plan" via member_billing.holder_seated    │
 * │                                                                         │
 * │  holder_seated records whether the plan HOLDER occupies their OWN seat  │
 * │  on this plan. Orthogonal to member_billing.status. It is the single    │
 * │  source of truth that makes "Leave this plan" stick: renewals (the      │
 * │  standard-adapter grant guard) and the 6-hour reconcile both read it    │
 * │  and refuse to re-seat a holder who released their seat.                 │
 * │                                                                         │
 * │  Behavioral coverage (adapters/standard-adapter.js completeGrant):      │
 * │    A. renewal carry-forward keeps holder_seated=false across a new cycle │
 * │       AND the returned false suppresses the seat re-create               │
 * │    B. renewal carry-forward keeps holder_seated=true → seat re-created   │
 * │    C. fresh purchase (cycle 1) defaults true → auto-seat                 │
 * │    D. no billing row (sub-member / no wix order) → fail-open, seat made  │
 * │    E. no billing INSERT but live flag=false → fallback read suppresses   │
 * │  Static coverage (reconciliation.js, multi-member.js, migration):       │
 * │    skip-re-add + self-heal, Leave/Join toggles, badge reads flag, DDL.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Mocks (mirror standard-adapter-new-schema.test.js) ──────────────────────

jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(),
  createUser:      jest.fn(),
  assignRole:      jest.fn(),
  removeRole:      jest.fn(),
  suspendAccess:   jest.fn(),
  enableAccess:    jest.fn(),
  deleteUser:      jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId:      jest.fn().mockReturnValue(null),
  setTraceContext: jest.fn(),
}));

jest.mock('../../adapters/wix/wix-members-api', () => ({ getMemberById: jest.fn() }));

jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn(k => k + '_decrypted') }));

jest.mock('resend', () => ({ Resend: jest.fn(() => ({ emails: { send: jest.fn() } })) }));

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TENANT_ID        = 'client-uuid-001';
const MEMBER_MASTER_ID = 'master-uuid-001';
const MEMBER_ACCESS_ID = 'access-uuid-001';
const BILLING_ID       = 'billing-uuid-001';
const PLAN_MAPPING_ID  = 'mapping-uuid-001';
const SOURCE_PLAN_ID   = 'plan-couples-001';

const db      = require('../../db');
const adapter = require('../../adapters/standard-adapter');

function baseAssignment(overrides = {}) {
  return {
    mappingId:        PLAN_MAPPING_ID,
    roleAssignmentId: 'ra-001',
    hardwareGroupId:  'hg-001',
    sourcePlanId:     SOURCE_PLAN_ID,
    sourceType:       'plan',
    planEndDate:      null,
    wixOrderId:       'wix-order-001',
    wixSubscriptionId: 'sub-001',
    cycleIndex:       1,
    planId:           SOURCE_PLAN_ID,
    planName:         'Couples',
    effectiveStart:   null,
    effectiveEnd:     null,
    billingSnapshot:  null,
    ...overrides,
  };
}

const findCall  = (calls, re) => calls.find(c => re.test(c[0]));
const hasSeatInsert = calls => calls.some(c => /INSERT INTO member_access_sources/.test(c[0]));

beforeEach(() => jest.clearAllMocks());

// ════════════════════════════════════════════════════════════════════════════
// A — Renewal carry-forward keeps holder_seated=false, and the returned false
//     suppresses the seat re-create. This is the core durability guarantee.
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 completeGrant — renewal carries holder_seated=false forward and suppresses re-seat', () => {
  it('cycle 2 renewal of a LEFT plan: writes holder_seated=false and creates NO member_access_sources row', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // resolve member_master_id
      .mockResolvedValueOnce({ rows: [] })                                        // OB-242 close prior cycles
      .mockResolvedValueOnce({ rows: [{ holder_seated: false }] })               // DR-051 prior-cycle carry-forward read
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID, holder_seated: false }] })// INSERT member_billing RETURNING id, holder_seated
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access rollup
      .mockResolvedValue({ rows: [] });                                           // _incrementActivity / email

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment({
      cycleIndex: 2, wixSubscriptionId: 'sub-001', effectiveStart: '2026-08-01T00:00:00Z',
    })]);

    const calls = db.query.mock.calls;

    // Carry-forward read happened (prior cycle, scoped by cycle_index < $3)
    const priorRead = findCall(calls, /SELECT holder_seated FROM member_billing[\s\S]*cycle_index < \$3/);
    expect(priorRead).toBeDefined();

    // Billing INSERT carried the flag forward as $10 (index 9), snapshot stays last
    const billing = findCall(calls, /INSERT INTO member_billing/);
    expect(billing[0]).toContain('holder_seated');
    expect(billing[0]).toContain('RETURNING id, holder_seated');
    expect(billing[1][9]).toBe(false);

    // holder_seated must NOT be in the ON CONFLICT SET (idempotent replay preserves stored value)
    expect(billing[0]).not.toMatch(/DO UPDATE[\s\S]*holder_seated\s*=/);

    // Seat suppressed — no member_access_sources INSERT at all
    expect(hasSeatInsert(calls)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// B — Renewal carry-forward keeps holder_seated=true → seat IS re-created.
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 completeGrant — renewal of a SEATED holder keeps the seat', () => {
  it('cycle 2 renewal with prior holder_seated=true: writes true and re-creates the seat', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // member_master_id
      .mockResolvedValueOnce({ rows: [] })                                        // OB-242 close prior
      .mockResolvedValueOnce({ rows: [{ holder_seated: true }] })                // carry-forward read
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID, holder_seated: true }] })// INSERT member_billing
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access rollup
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment({
      cycleIndex: 2, wixSubscriptionId: 'sub-001',
    })]);

    const calls = db.query.mock.calls;
    const billing = findCall(calls, /INSERT INTO member_billing/);
    expect(billing[1][9]).toBe(true);
    expect(hasSeatInsert(calls)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C — Fresh purchase (cycle 1) defaults holder_seated=true → auto-seat on buy.
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 completeGrant — fresh purchase auto-seats (default true)', () => {
  it('cycle 1: no carry-forward read, writes holder_seated=true, creates the seat', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // member_master_id
      .mockResolvedValueOnce({ rows: [{ id: BILLING_ID, holder_seated: true }] })// INSERT member_billing (no OB-242, no carry-forward at cycle 1)
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access rollup
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment({ cycleIndex: 1 })]);

    const calls = db.query.mock.calls;
    // No prior-cycle carry-forward read at cycle 1
    expect(findCall(calls, /cycle_index < \$3/)).toBeUndefined();
    const billing = findCall(calls, /INSERT INTO member_billing/);
    expect(billing[1][9]).toBe(true);
    expect(hasSeatInsert(calls)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// D — No billing row (sub-member / synthetic grant with no wix order): the
//     fallback read finds nothing → seat provisions normally (fail-open).
//     This is how the guard scopes itself to holders only.
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 completeGrant — no billing row fails OPEN (sub-members unaffected)', () => {
  it('assignment with no wixOrderId + no billing row: fallback read empty → seat created', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // member_master_id
      .mockResolvedValueOnce({ rows: [] })                                        // DR-051 fallback read → no billing row
      .mockResolvedValueOnce({ rows: [] })                                        // INSERT member_access_sources
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access rollup
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment({ wixOrderId: null })]);

    const calls = db.query.mock.calls;
    // fallback read used (member_master_id + plan_id, NOT scoped by cycle_index < $3)
    const fallback = findCall(calls, /SELECT holder_seated FROM member_billing\s+WHERE member_master_id = \$1 AND plan_id = \$2/);
    expect(fallback).toBeDefined();
    expect(hasSeatInsert(calls)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E — No billing INSERT this call, but the live flag is false: the fallback
//     read suppresses the seat (guard works on the claim-less path too).
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 completeGrant — fallback read of a live false flag suppresses the seat', () => {
  it('no wixOrderId but holder_seated=false in DB: fallback read → no seat created', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ member_master_id: MEMBER_MASTER_ID }] }) // member_master_id
      .mockResolvedValueOnce({ rows: [{ holder_seated: false }] })               // DR-051 fallback read → false
      .mockResolvedValueOnce({ rows: [] })                                        // UPDATE member_access rollup
      .mockResolvedValue({ rows: [] });

    await adapter.completeGrant(MEMBER_ACCESS_ID, TENANT_ID, [baseAssignment({ wixOrderId: null })]);

    expect(hasSeatInsert(db.query.mock.calls)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Static — reconciliation.js skip-re-add + self-heal
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 reconciliation — skips re-add and self-heals when holder_seated=false', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../core/reconciliation.js'), 'utf8');

  it('reads holder_seated for the (member × plan) before the seat backfill loop', () => {
    expect(src).toMatch(/SELECT mb\.holder_seated[\s\S]*mm\.platform_member_id = \$2 AND mb\.plan_id = \$3/);
  });

  it('self-heals a lingering active holder seat by marking it cancelled, DB-only (no removeRole)', () => {
    expect(src).toMatch(/UPDATE member_access_sources mas\s+SET status = 'cancelled'/);
    // scoped to the holder's own access row + this plan's source_plan_id
    expect(src).toMatch(/ma\.sub_master_id IS NULL[\s\S]*mas\.source_plan_id = \$3/);
    expect(src).toMatch(/reconciliation\.holder_seat_released_enforced/);
  });

  it('skips the seat backfill (continue) after enforcing the released state', () => {
    // The DR-051 branch must `continue` so the targets.rows backfill loop does not re-add.
    expect(src).toMatch(/holder_seated === false[\s\S]*continue;/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Static — multi-member.js Leave/Join toggles + badge reads the flag
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 multi-member — Leave/Join toggle the flag; badge reads it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../admin/routes/multi-member.js'), 'utf8');

  it('holder-release-slot sets holder_seated=false (Leave)', () => {
    expect(src).toMatch(/UPDATE member_billing SET holder_seated = false/);
  });

  it('holder-claim-slot sets holder_seated=true (Join)', () => {
    expect(src).toMatch(/UPDATE member_billing SET holder_seated = true/);
  });

  it('widget-data surfaces mb.holder_seated and drives the badge from it', () => {
    expect(src).toMatch(/mb\.holder_seated/);
    expect(src).toMatch(/holderHasSlot:\s*p\.holder_seated/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Static — migration DDL
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-051 migration — additive holder_seated column, default true', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../migrations/dr-051.sql'), 'utf8');

  it('adds holder_seated boolean NOT NULL DEFAULT true to member_billing (idempotent)', () => {
    expect(migration).toMatch(/ALTER TABLE member_billing/);
    expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS holder_seated boolean NOT NULL DEFAULT true/);
  });
});
