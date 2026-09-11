/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: assignRole 404 — is it the GROUP or the USER that's gone?    │
 * │                                                                         │
 * │  Business consequence: Kisi answers POST /role_assignments with 404     │
 * │  both when the door group was deleted AND when the member's Kisi user   │
 * │  was deleted. The old handler assumed "group" every time and flagged    │
 * │  plan_mapping_groups.health_status = 'not_found' + wrote a              │
 * │  group_not_found alert — so ONE member whose Kisi user had been         │
 * │  deleted could mark a working door dead and hide it from every member.  │
 * │                                                                         │
 * │  Fix (Phase 1, spec I-6): on a 404, first ask the door system whether   │
 * │  the user still exists (hardwareAdapter.getUserById):                   │
 * │    null         → user gone: group untouched, throw HARDWARE_USER_GONE  │
 * │    user object  → group really gone: existing handling, unchanged       │
 * │    lookup fails → ambiguous: rethrow the original 404, group untouched  │
 * │                                                                         │
 * │  Fix round (F3/F4): each of those — and an unresolved Kisi 409          │
 * │  (KISI_ROLE_CONFLICT_UNRESOLVED) — is a PARTIAL failure. Whatever was   │
 * │  collected (e.g. a group satisfied by the OB-47 reuse path) is          │
 * │  returned, exactly as HEAD did; the job throws only when nothing was    │
 * │  collected. A thrown grant releases the member's lock as 'failed'       │
 * │  (inactive), so throwing with assignments in hand would be a downgrade. │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../db', () => ({
  query: jest.fn(),
}));

// Mocked wholesale so this suite does not depend on the KISI agent's
// getUserById landing in adapters/hardware-adapter.js first.
jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole:  jest.fn(),
  getUserById: jest.fn(),
}));

jest.mock('../../core/plan-mapping-resolver', () => ({
  resolve: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn((enc) => `plaintext-${enc}`),
}));

jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn().mockReturnValue('trace-grant-user-gone'),
  getActor:   jest.fn().mockReturnValue({ type: 'system', id: 'queue-worker' }),
}));

jest.mock('../../core/member-access-log', () => ({
  logMemberAccessEvent: jest.fn().mockResolvedValue(undefined),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const { log }         = require('../../core/logger');
const grantRevoke     = require('../../core/grant-revoke');

const TENANT_ID  = 'client-hog-001';
const MEMBER_ID  = 'member-access-001';
const HW_USER_ID = 'kisi-user-4242';
const API_KEY    = 'plaintext-key';

const mappingA = {
  mappingId: 'mapping-a', hardwareGroupId: '838622', hardwarePlatform: 'kisi', apiKey: API_KEY,
};
const mappingB = {
  mappingId: 'mapping-b', hardwareGroupId: '999999', hardwarePlatform: 'kisi', apiKey: API_KEY,
};

const wixEvent = {
  eventType: 'plan.purchased',
  planId: 'plan-xyz',
  platformMemberId: 'wix-member-xyz',
};

// Shape mirrors adapters/kisi/kisi-connector.js makeRequest's thrown error for a 404.
function kisi404() {
  const e = new Error('Kisi 404: Not Found');
  e.statusCode = 404;
  e.code = 'HARDWARE_RESOURCE_NOT_FOUND';
  e.resolution = 'REMAP_PLAN';
  return e;
}

// Every SELECT in processGrant's pre-checks returns "no prior source row", so each
// mapping goes to a real assignRole call. Writes resolve with rowCount 1.
function defaultDb() {
  db.query.mockImplementation(async (sql) => {
    if (/^\s*SELECT/i.test(sql)) return { rows: [] };
    return { rows: [], rowCount: 1 };
  });
}

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

function sqlCalls(pattern) {
  return db.query.mock.calls.filter(([sql]) => pattern.test(sql));
}
const groupFlagWrites  = () => sqlCalls(/UPDATE\s+plan_mapping_groups/i);
const groupAlertWrites = () => sqlCalls(/INSERT INTO config_alert_log/i)
  .filter(([sql]) => /group_not_found/.test(sql));
const warnEvents = () => log.warn.mock.calls.map(([event]) => event);

beforeEach(() => {
  jest.clearAllMocks();
  defaultDb();
});

describe('[P1] I-6 — assignRole 404 where the Kisi USER is gone', () => {

  test('getUserById null → throws HARDWARE_USER_GONE naming the user, group NOT flagged, no group_not_found alert', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('HARDWARE_USER_GONE');
    expect(thrown.message).toContain(HW_USER_ID);

    // The whole point: a working door is never marked dead because a USER vanished.
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.user_gone');
    expect(warnEvents()).not.toContain('grant.group_not_found');
  });

  test('getUserById is called with (hardwarePlatform, apiKey, hardwareUserId) of the failing mapping', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toMatchObject({ code: 'HARDWARE_USER_GONE' });

    expect(hardwareAdapter.getUserById).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getUserById).toHaveBeenCalledWith('kisi', API_KEY, HW_USER_ID);
  });

  // Fix round F3: this used to pin "the loop stops — mapping B's pre-grant SELECTs
  // never run". That made the outcome depend on mapping ORDER: a later mapping that
  // HEAD satisfied via the OB-47 reuse path (no hardware call) was never collected,
  // so the job threw and the member went inactive where HEAD kept them active. Now
  // the hardware calls stop (still exactly one assignRole / one getUserById), but
  // the remaining mappings are still reuse-checked (DB reads only).
  test('user gone → no further assignRole on that door account: the next mapping is never sent to Kisi and no group anywhere is flagged', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent)
    ).rejects.toMatchObject({ code: 'HARDWARE_USER_GONE' });
    await flushImmediates();

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith('kisi', API_KEY, HW_USER_ID, mappingA.hardwareGroupId);
    expect(hardwareAdapter.getUserById).toHaveBeenCalledTimes(1);
    // mapping B only ever gets READ (reuse check) — nothing is written for it.
    const mappingBQueries = db.query.mock.calls.filter(([, params]) =>
      Array.isArray(params) && params.includes(mappingB.hardwareGroupId));
    expect(mappingBQueries.length).toBeGreaterThan(0);
    for (const [sql] of mappingBQueries) expect(sql).toMatch(/^\s*SELECT/i);
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
  });

  test('HARDWARE_USER_GONE carries a non-429 4xx statusCode so queue-worker dead-letters it without retries', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent);
    } catch (e) { thrown = e; }

    // Mirrors core/queue-worker.js's classification: statusCode in [400,500) and !== 429
    // → UnrecoverableError (no pointless retries — every retry would 404 the same way).
    expect(thrown.statusCode).toBe(404);
    expect(thrown.statusCode >= 400 && thrown.statusCode < 500 && thrown.statusCode !== 429).toBe(true);
  });

  test('no member_access_log "provisioned" entry and no assignments returned when the user is gone', async () => {
    const { logMemberAccessEvent } = require('../../core/member-access-log');
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toMatchObject({ code: 'HARDWARE_USER_GONE' });

    expect(logMemberAccessEvent).not.toHaveBeenCalled();
  });
});

describe('[P1] I-6 — assignRole 404 where the user EXISTS (group really gone) — existing behaviour unchanged', () => {

  test('getUserById returns a user → group flagged not_found + group_not_found alert, original 404 rethrown when all groups fail', async () => {
    const original = kisi404();
    hardwareAdapter.assignRole.mockRejectedValue(original);
    hardwareAdapter.getUserById.mockResolvedValue({ id: HW_USER_ID, email: 'x@example.com' });

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    expect(thrown).toBe(original);
    expect(warnEvents()).toContain('grant.group_not_found');
    expect(warnEvents()).not.toContain('grant.user_gone');

    const flags = groupFlagWrites();
    expect(flags).toHaveLength(1);
    expect(flags[0][1]).toEqual([mappingA.mappingId, mappingA.hardwareGroupId]);

    const alerts = groupAlertWrites();
    expect(alerts).toHaveLength(1);
    expect(alerts[0][1]).toEqual([TENANT_ID, mappingA.hardwareGroupId, 'trace-grant-user-gone', 'system', 'queue-worker']);
  });

  test('getUserById returns a user → loop continues: remaining group granted, partial success returned', async () => {
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(kisi404())          // mapping A: group deleted
      .mockResolvedValueOnce('kisi-ra-b-123');   // mapping B: fine
    hardwareAdapter.getUserById.mockResolvedValue({ id: HW_USER_ID });

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-b', roleAssignmentId: 'kisi-ra-b-123' });
    expect(warnEvents()).toContain('grant.partial_failure');
    // Only the dead group (A) is flagged — never B.
    const flags = groupFlagWrites();
    expect(flags).toHaveLength(1);
    expect(flags[0][1]).toEqual([mappingA.mappingId, mappingA.hardwareGroupId]);
  });
});

describe('[P1] I-6 — ambiguous 404 (the user lookup cannot answer) fails safe', () => {

  test('getUserById throws → ORIGINAL 404 rethrown, group NOT flagged, warn grant.not_found_ambiguous', async () => {
    const original = kisi404();
    const secondary = kisi404();
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(original)    // mapping A
      .mockRejectedValueOnce(secondary);  // mapping B
    const lookupErr = new Error('Kisi 503: Service Unavailable');
    lookupErr.code = 'HARDWARE_API_ERROR';
    lookupErr.statusCode = 503;
    hardwareAdapter.getUserById.mockRejectedValue(lookupErr);

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    // Nothing collected → the FIRST mapping's original 404 is thrown (HEAD's all-failed rule).
    expect(thrown).toBe(original);
    expect(thrown.code).toBe('HARDWARE_RESOURCE_NOT_FOUND');
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
    expect(warnEvents()).not.toContain('grant.group_not_found');
    // Fix round F3: this used to pin "stops at the ambiguous 404 — mapping B is not
    // attempted". HEAD attempted B here; stopping meant a door that WOULD have been
    // granted was skipped and the job thrown (member → inactive). An ambiguous 404
    // is now a partial failure: B is still attempted, and its own 404 is also
    // recorded without flagging anything.
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
  });

  test('getUserById missing from the adapter (TypeError) → treated as ambiguous, original 404 rethrown, group NOT flagged', async () => {
    const original = kisi404();
    hardwareAdapter.assignRole.mockRejectedValue(original);
    hardwareAdapter.getUserById.mockImplementation(() => { throw new TypeError('getUserById is not a function'); });

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toBe(original);
    await flushImmediates();

    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
  });

  test('getUserById returns undefined (neither null nor a user) → ambiguous, original 404 rethrown, group NOT flagged', async () => {
    const original = kisi404();
    hardwareAdapter.assignRole.mockRejectedValue(original);
    hardwareAdapter.getUserById.mockResolvedValue(undefined);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toBe(original);
    await flushImmediates();

    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
    expect(warnEvents()).not.toContain('grant.user_gone');
  });
});

describe('[P1] I-6 — non-404 errors are untouched', () => {

  test('a non-404 assignRole error never triggers the user lookup and is rethrown as-is', async () => {
    const e500 = new Error('Kisi 500: boom');
    e500.code = 'HARDWARE_API_ERROR';
    e500.statusCode = 500;
    hardwareAdapter.assignRole.mockRejectedValue(e500);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toBe(e500);
    await flushImmediates();

    expect(hardwareAdapter.getUserById).not.toHaveBeenCalled();
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
  });

  test('a successful assignRole never triggers the user lookup', async () => {
    hardwareAdapter.assignRole.mockResolvedValue('kisi-ra-fresh');

    const result = await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent);

    expect(result[0].roleAssignmentId).toBe('kisi-ra-fresh');
    expect(hardwareAdapter.getUserById).not.toHaveBeenCalled();
  });
});

// ─── Fix round F3 — partial success when something was already collected ─────

const mappingC = {
  mappingId: 'mapping-c', hardwareGroupId: '777777', hardwarePlatform: 'kisi', apiKey: API_KEY,
};
// Same member id, but a DIFFERENT door-system account (per-location key, DR-028).
const mappingOtherAccount = {
  mappingId: 'mapping-other', hardwareGroupId: '555555', hardwarePlatform: 'kisi', apiKey: 'plaintext-other-key',
};

// The member already holds a permanent source row (with a Kisi role assignment) on
// `reusedGroupId`, so processGrant's OB-47 pre-grant source check reuses it — no
// hardware call for that mapping. Every other SELECT says "no prior row".
function dbWithReusedGroup(reusedGroupId, priorRaId) {
  db.query.mockImplementation(async (sql, params) => {
    if (/^\s*SELECT/i.test(sql)) {
      if (Array.isArray(params) && params[1] === reusedGroupId) {
        return { rows: [{ source_plan_id: 'plan-older', source_type: 'plan', role_assignment_id: priorRaId, mapping_id: 'mapping-older' }] };
      }
      return { rows: [] };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('[P1] F3 — user-gone / ambiguous 404 with assignments already collected → HEAD partial success', () => {

  test('reused group + user-gone 404 → returns 1 assignment, no throw, no plan_mapping_groups UPDATE', async () => {
    dbWithReusedGroup(mappingA.hardwareGroupId, 'kisi-ra-prior-a');
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-prior-a', hardwareGroupId: mappingA.hardwareGroupId,
    });
    // Only mapping B went to Kisi (A was reused).
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledWith('kisi', API_KEY, HW_USER_ID, mappingB.hardwareGroupId);
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.user_gone');
    expect(warnEvents()).toContain('grant.partial_failure');
    expect(warnEvents()).not.toContain('grant.group_not_found');
    const partial = log.warn.mock.calls.find(([e]) => e === 'grant.partial_failure')[1];
    expect(partial).toMatchObject({ succeeded: 1, failed: 1, failedGroups: [mappingB.hardwareGroupId], failureReasons: ['user_gone'] });
  });

  test('order does not matter: user-gone 404 FIRST, reused group second → still returns the reused assignment', async () => {
    dbWithReusedGroup(mappingB.hardwareGroupId, 'kisi-ra-prior-b');
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-b', roleAssignmentId: 'kisi-ra-prior-b' });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
  });

  test('after user-gone, a later mapping that NEEDS a Kisi call on the same account is skipped (no 2nd assignRole, no 2nd lookup); a later reused group is still collected', async () => {
    dbWithReusedGroup(mappingC.hardwareGroupId, 'kisi-ra-prior-c');
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB, mappingC], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-c', roleAssignmentId: 'kisi-ra-prior-c' });
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(hardwareAdapter.getUserById).toHaveBeenCalledTimes(1);
    expect(groupFlagWrites()).toHaveLength(0);
    const partial = log.warn.mock.calls.find(([e]) => e === 'grant.partial_failure')[1];
    expect(partial).toMatchObject({
      succeeded: 1, failed: 2,
      failedGroups: [mappingA.hardwareGroupId, mappingB.hardwareGroupId],
      failureReasons: ['user_gone', 'user_gone'],
    });
  });

  test('user gone on one door account does not stop a mapping on a DIFFERENT account from being attempted (HEAD attempted it)', async () => {
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(kisi404())            // mapping A (account 1): user gone
      .mockResolvedValueOnce('kisi-ra-other-777'); // mapping on account 2: fine
    hardwareAdapter.getUserById.mockResolvedValueOnce(null);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingOtherAccount], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-other', roleAssignmentId: 'kisi-ra-other-777' });
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(hardwareAdapter.assignRole).toHaveBeenLastCalledWith('kisi', 'plaintext-other-key', HW_USER_ID, mappingOtherAccount.hardwareGroupId);
    expect(groupFlagWrites()).toHaveLength(0);
  });

  test('real assignment first, then user-gone 404 → returns it and still writes the provisioned log entry', async () => {
    const { logMemberAccessEvent } = require('../../core/member-access-log');
    hardwareAdapter.assignRole
      .mockResolvedValueOnce('kisi-ra-a-1')
      .mockRejectedValueOnce(kisi404());
    hardwareAdapter.getUserById.mockResolvedValue(null);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-a-1' });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(logMemberAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'provisioned' }));
  });

  test('reused group + ambiguous 404 (lookup throws) → returns 1 assignment, no throw, no plan_mapping_groups UPDATE', async () => {
    dbWithReusedGroup(mappingA.hardwareGroupId, 'kisi-ra-prior-a');
    hardwareAdapter.assignRole.mockRejectedValue(kisi404());
    const lookupErr = new Error('Kisi 503: Service Unavailable');
    lookupErr.code = 'HARDWARE_API_ERROR';
    lookupErr.statusCode = 503;
    hardwareAdapter.getUserById.mockRejectedValue(lookupErr);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-prior-a' });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
    expect(warnEvents()).not.toContain('grant.group_not_found');
    const partial = log.warn.mock.calls.find(([e]) => e === 'grant.partial_failure')[1];
    expect(partial).toMatchObject({ failureReasons: ['not_found_ambiguous'] });
  });

  test('ambiguous 404 (lookup returns undefined) first, working group second → second group granted, nothing flagged', async () => {
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(kisi404())
      .mockResolvedValueOnce('kisi-ra-b-ok');
    hardwareAdapter.getUserById.mockResolvedValue(undefined);

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-b', roleAssignmentId: 'kisi-ra-b-ok' });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(warnEvents()).toContain('grant.not_found_ambiguous');
  });
});

// ─── Fix round F4 — KISI_ROLE_CONFLICT_UNRESOLVED is a partial failure ────────

// Matched by err.code only — the real error comes from adapters/kisi/kisi-adapter.js
// (P-4), which this suite never loads (hardware-adapter is mocked wholesale).
function conflictUnresolved() {
  const e = new Error('Kisi 409 on assignRole, but no matching (user, group, group_basic) assignment was found');
  e.code = 'KISI_ROLE_CONFLICT_UNRESOLVED';
  e.statusCode = 409;
  return e;
}

describe('[P1] F4 — assignRole throws KISI_ROLE_CONFLICT_UNRESOLVED', () => {

  test('conflict on A, success on B → returns B, warns grant.role.conflict_unresolved, loop continued, no group flagged, no user lookup', async () => {
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(conflictUnresolved())
      .mockResolvedValueOnce('kisi-ra-b-777');

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-b', roleAssignmentId: 'kisi-ra-b-777' });
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(hardwareAdapter.getUserById).not.toHaveBeenCalled();
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);

    const conflictWarn = log.warn.mock.calls.find(([e]) => e === 'grant.role.conflict_unresolved');
    expect(conflictWarn).toBeDefined();
    expect(conflictWarn[1]).toMatchObject({
      clientId: TENANT_ID, memberId: MEMBER_ID, mappingId: 'mapping-a', hardwareGroupId: mappingA.hardwareGroupId,
    });
    expect(conflictWarn[2]).toMatchObject({ code: 'KISI_ROLE_CONFLICT_UNRESOLVED' });
    const partial = log.warn.mock.calls.find(([e]) => e === 'grant.partial_failure')[1];
    expect(partial).toMatchObject({ succeeded: 1, failed: 1, failureReasons: ['role_conflict_unresolved'] });
  });

  test('success on A, conflict on B → returns A (no throw), provisioned log still written', async () => {
    const { logMemberAccessEvent } = require('../../core/member-access-log');
    hardwareAdapter.assignRole
      .mockResolvedValueOnce('kisi-ra-a-1')
      .mockRejectedValueOnce(conflictUnresolved());

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-a-1' });
    expect(groupFlagWrites()).toHaveLength(0);
    expect(logMemberAccessEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'provisioned' }));
  });

  test('reused group + conflict → returns the reused assignment', async () => {
    dbWithReusedGroup(mappingA.hardwareGroupId, 'kisi-ra-prior-a');
    hardwareAdapter.assignRole.mockRejectedValue(conflictUnresolved());

    const result = await grantRevoke.processGrant(
      TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent
    );
    await flushImmediates();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ mappingId: 'mapping-a', roleAssignmentId: 'kisi-ra-prior-a' });
    expect(groupFlagWrites()).toHaveLength(0);
  });

  test('EVERY mapping fails with the conflict → throws (HEAD all-failed path), every mapping attempted, nothing flagged, no provisioned log', async () => {
    const { logMemberAccessEvent } = require('../../core/member-access-log');
    const first = conflictUnresolved();
    hardwareAdapter.assignRole
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(conflictUnresolved());

    let thrown;
    try {
      await grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent);
    } catch (e) { thrown = e; }
    await flushImmediates();

    expect(thrown).toBe(first);
    expect(thrown.code).toBe('KISI_ROLE_CONFLICT_UNRESOLVED');
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(2);
    expect(warnEvents().filter(e => e === 'grant.role.conflict_unresolved')).toHaveLength(2);
    expect(warnEvents()).not.toContain('grant.partial_failure');
    expect(groupFlagWrites()).toHaveLength(0);
    expect(groupAlertWrites()).toHaveLength(0);
    expect(logMemberAccessEvent).not.toHaveBeenCalled();
  });

  test('single mapping conflict → throws the KISI_ROLE_CONFLICT_UNRESOLVED error unchanged', async () => {
    hardwareAdapter.assignRole.mockRejectedValue(conflictUnresolved());

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA], wixEvent)
    ).rejects.toMatchObject({ code: 'KISI_ROLE_CONFLICT_UNRESOLVED' });
    await flushImmediates();

    expect(groupFlagWrites()).toHaveLength(0);
  });

  test('a raw 409 WITHOUT the KISI_ROLE_CONFLICT_UNRESOLVED code is still rethrown immediately (not swallowed)', async () => {
    const raw409 = new Error('Kisi 409: Conflict');
    raw409.statusCode = 409;
    raw409.code = 'HARDWARE_CONFLICT';
    hardwareAdapter.assignRole.mockRejectedValue(raw409);

    await expect(
      grantRevoke.processGrant(TENANT_ID, MEMBER_ID, HW_USER_ID, [mappingA, mappingB], wixEvent)
    ).rejects.toBe(raw409);
    expect(hardwareAdapter.assignRole).toHaveBeenCalledTimes(1);
    expect(warnEvents()).not.toContain('grant.role.conflict_unresolved');
  });
});
