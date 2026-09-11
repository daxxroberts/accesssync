/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Phase 1 (I-4) — Kisi reads are fail-closed and exact         │
 * │                                                                         │
 * │  Business consequence: the reconcile sweep decides who has a door from  │
 * │  these reads. getManagedRoleAssignments used to return [] on ANY Kisi   │
 * │  error, which the sweep read as "nobody has a door" — every paying      │
 * │  member looked role-drifted (the Pass 3 mass-revoke risk). A short,     │
 * │  malformed or duplicated page has the same effect. findUserByEmail took │
 * │  Kisi's first search hit blindly, which can bind a member to someone    │
 * │  else's Kisi account. The assignRole 409 recovery took the first row of │
 * │  an unverified group filter, which can adopt a different assignment.    │
 * │                                                                         │
 * │  What this tests: every bulk list throws KISI_PAGE_INTEGRITY / the HTTP │
 * │  error instead of guessing; findUserByEmail requires an exact email     │
 * │  match; 409 recovery matches (user, group, group_basic) client-side;    │
 * │  getUserById distinguishes 404 (null) from everything else (throw).     │
 * │                                                                         │
 * │  Fix round: F7 — getRoleAssignmentsForUser throws KISI_PAGE_INTEGRITY   │
 * │  on a non-array 2xx (was [] = "no other doors", so Guard D and DR-045   │
 * │  Layer C both let the Kisi user delete through). P-4 — an unresolved    │
 * │  409 throws KISI_ROLE_CONFLICT_UNRESOLVED (status kept at 409).         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Only the F7 cross-layer finalizeRevoke test below touches these (real
// standard-adapter → real hardware-adapter → real kisi-adapter → mocked
// connector). No real database or vendor is ever reached.
jest.mock('../../db', () => ({
  query:     jest.fn(),
  getClient: jest.fn(),
}));

jest.mock('../../core/trace-context', () => ({
  getTraceId:      jest.fn().mockReturnValue('trace-f7'),
  setTraceContext: jest.fn(),
  getActor:        jest.fn().mockReturnValue(null),
}));

const kisiConnector   = require('../../adapters/kisi/kisi-connector');
const { log }         = require('../../core/logger');
const kisiAdapter     = require('../../adapters/kisi/kisi-adapter');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const seamAdapter     = require('../../adapters/seam/seam-adapter');
const db              = require('../../db');
const standardAdapter = require('../../adapters/standard-adapter');

const API_KEY = 'test-kisi-key-i4';

function httpError(statusCode, message = `Kisi ${statusCode}`) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/** A full page (100 items) of role assignments with ids starting at `startId`. */
function assignmentPage(startId, size = 100) {
  return Array.from({ length: size }, (_, i) => ({
    id: startId + i, user_id: 1000 + startId + i, group_id: 7, role_id: 'group_basic',
  }));
}

/** A page of users with ids starting at `startId`. */
function userPage(startId, size = 100) {
  return Array.from({ length: size }, (_, i) => ({
    id: startId + i, email: `u${startId + i}@example.test`, name: `User ${startId + i}`,
  }));
}

function warnEvents() {
  return log.warn.mock.calls.map(c => c[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  kisiConnector.makeRequest.mockReset();
});

// ─── getManagedRoleAssignments ──────────────────────────────────────────────

describe('[P3] I-4 getManagedRoleAssignments — throws instead of returning []', () => {

  it('returns the unchanged shape across pages on a clean read', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(assignmentPage(1))
      .mockResolvedValueOnce([
        { id: 501, user: { id: 42 }, group: { id: 9 } },
      ]);

    const out = await kisiAdapter.getManagedRoleAssignments(API_KEY);

    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({ userId: 1001, groupId: 7, roleAssignmentId: 1 });
    expect(out[100]).toEqual({ userId: 42, groupId: 9, roleAssignmentId: 501 });
    expect(kisiConnector.makeRequest.mock.calls[0][0]).toBe('/role_assignments?limit=100&offset=0');
    expect(kisiConnector.makeRequest.mock.calls[1][0]).toBe('/role_assignments?limit=100&offset=100');
  });

  it('an empty org is a legitimate [] (single empty page)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([]);
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY)).resolves.toEqual([]);
  });

  it('THROWS the HTTP error on a Kisi outage (no silent [])', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(503));
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(log.error).toHaveBeenCalledWith(
      'kisi.managed_assignments.fetch_failed',
      expect.objectContaining({ statusCode: 503 }),
      expect.any(Error)
    );
  });

  it('THROWS when a LATER page fails — a partial list is never returned', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(assignmentPage(1))
      .mockRejectedValueOnce(httpError(500));
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it('non-array page → KISI_PAGE_INTEGRITY', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ data: [] });
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'non_array_page' });
    expect(warnEvents()).toContain('kisi.page_integrity_failed');
  });

  it('null body (e.g. 204) → KISI_PAGE_INTEGRITY', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce(null);
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'non_array_page' });
  });

  it('non-array SECOND page → KISI_PAGE_INTEGRITY (not a truncated success)', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(assignmentPage(1))
      .mockResolvedValueOnce('<html>gateway</html>');
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'non_array_page' });
  });

  it('duplicate assignment id across pages → KISI_PAGE_INTEGRITY', async () => {
    // Page 2 repeats id 100 (offset drift: a row shifted between requests)
    kisiConnector.makeRequest
      .mockResolvedValueOnce(assignmentPage(1))
      .mockResolvedValueOnce([{ id: 100, user_id: 5, group_id: 7 }]);
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'duplicate_id', duplicateId: '100' });
  });

  it('duplicate id is detected across string/number forms', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([{ id: 5 }, { id: '5' }]);
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'duplicate_id' });
  });

  it('more than 100 pages → KISI_PAGE_INTEGRITY, and no 101st request is made', async () => {
    for (let p = 0; p < 100; p++) {
      kisiConnector.makeRequest.mockResolvedValueOnce(assignmentPage(1 + p * 100));
    }
    await expect(kisiAdapter.getManagedRoleAssignments(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'page_cap_exceeded' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(100);
  });

  it('exactly 100 pages where the last is short is a clean read', async () => {
    for (let p = 0; p < 99; p++) {
      kisiConnector.makeRequest.mockResolvedValueOnce(assignmentPage(1 + p * 100));
    }
    kisiConnector.makeRequest.mockResolvedValueOnce(assignmentPage(1 + 99 * 100, 3));
    const out = await kisiAdapter.getManagedRoleAssignments(API_KEY);
    expect(out).toHaveLength(9903);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(100);
  });

  it('missing apiKey keeps its existing behaviour ([] + warn, no HTTP call)', async () => {
    await expect(kisiAdapter.getManagedRoleAssignments(null)).resolves.toEqual([]);
    expect(kisiConnector.makeRequest).not.toHaveBeenCalled();
    expect(warnEvents()).toContain('kisi.get_role_assignments_no_key');
  });

  it('hardware-adapter propagates the throw (no swallowing at Layer 5)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(502));
    await expect(hardwareAdapter.getManagedRoleAssignments('kisi', API_KEY))
      .rejects.toMatchObject({ statusCode: 502 });
  });
});

// ─── listAllUsers ───────────────────────────────────────────────────────────

describe('[P3] I-4 listAllUsers — pagination integrity', () => {

  it('returns the unchanged { id, email, name } shape across pages', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(userPage(1))
      .mockResolvedValueOnce([{ id: 999, email: null }]);
    const out = await kisiAdapter.listAllUsers(API_KEY);
    expect(out).toHaveLength(101);
    expect(out[0]).toEqual({ id: 1, email: 'u1@example.test', name: 'User 1' });
    expect(out[100]).toEqual({ id: 999, email: null, name: null });
    expect(kisiConnector.makeRequest.mock.calls[0][0]).toBe('/users?limit=100&offset=0');
    expect(kisiConnector.makeRequest.mock.calls[1][0]).toBe('/users?limit=100&offset=100');
  });

  it('HTTP error still throws (Pass 3 outage short-circuit)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(500));
    await expect(kisiAdapter.listAllUsers(API_KEY)).rejects.toMatchObject({ statusCode: 500 });
  });

  it('non-array page → KISI_PAGE_INTEGRITY (was silently [] = "every user deleted")', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ error: 'unexpected' });
    await expect(kisiAdapter.listAllUsers(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'non_array_page' });
    expect(log.error).toHaveBeenCalledWith(
      'kisi.list_users_failed',
      expect.objectContaining({ code: 'KISI_PAGE_INTEGRITY' }),
      expect.any(Error)
    );
  });

  it('non-array later page → KISI_PAGE_INTEGRITY', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(userPage(1))
      .mockResolvedValueOnce(undefined);
    await expect(kisiAdapter.listAllUsers(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY' });
  });

  it('duplicate user id across pages → KISI_PAGE_INTEGRITY', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(userPage(1))
      .mockResolvedValueOnce([{ id: 50, email: 'dup@example.test' }]);
    await expect(kisiAdapter.listAllUsers(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'duplicate_id', duplicateId: '50' });
  });

  it('more than 100 pages → KISI_PAGE_INTEGRITY, no 101st request', async () => {
    for (let p = 0; p < 100; p++) {
      kisiConnector.makeRequest.mockResolvedValueOnce(userPage(1 + p * 100));
    }
    await expect(kisiAdapter.listAllUsers(API_KEY))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY', integrityReason: 'page_cap_exceeded' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(100);
  });

  it('integrity warn never carries user emails', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(userPage(1))
      .mockResolvedValueOnce([{ id: 50, email: 'dup@example.test' }]);
    await expect(kisiAdapter.listAllUsers(API_KEY)).rejects.toBeDefined();
    const integrityCall = log.warn.mock.calls.find(c => c[0] === 'kisi.page_integrity_failed');
    expect(integrityCall).toBeDefined();
    expect(JSON.stringify(integrityCall[1])).not.toMatch(/@/);
  });
});

// ─── findUserByEmail ────────────────────────────────────────────────────────

describe('[P3] I-4 findUserByEmail — exact case-insensitive match only', () => {

  it('returns the exact match even when it is NOT the first search hit', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { id: 11, email: 'chad.smith@example.test' },     // fuzzy hit, different person
      { id: 22, email: 'chad@example.test' },           // the real match
    ]);
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBe(22);
  });

  it('matches case- and whitespace-insensitively', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([{ id: 33, email: '  Chad@Example.TEST ' }]);
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test ')).resolves.toBe(33);
  });

  it('returns null (never data[0]) when results exist but none match exactly', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { id: 11, email: 'chad.smith@example.test' },
      { id: 12, email: 'richard@example.test' },
    ]);
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBeNull();

    const call = log.warn.mock.calls.find(c => c[0] === 'kisi.user.find_no_exact_match');
    expect(call).toBeDefined();
    expect(call[1]).toEqual({ resultCount: 2 });              // count only
    expect(JSON.stringify(call[1])).not.toMatch(/@/);          // no emails logged
  });

  it('a result without an email field is not a match', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([{ id: 44, name: 'Chad' }]);
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBeNull();
  });

  it('empty result → null, no no-match warn', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([]);
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBeNull();
    expect(warnEvents()).not.toContain('kisi.user.find_no_exact_match');
  });

  it('single-object response: exact email → id; different email → null', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 55, email: 'CHAD@example.test' });
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBe(55);

    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 56, email: 'someone.else@example.test' });
    await expect(kisiAdapter.findUserByEmail(API_KEY, 'chad@example.test')).resolves.toBeNull();
  });

  it('still queries Kisi with the encoded email', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([]);
    await kisiAdapter.findUserByEmail(API_KEY, 'a+b@example.test');
    expect(kisiConnector.makeRequest.mock.calls[0][0]).toBe('/users?query=a%2Bb%40example.test');
  });
});

// ─── assignRole 409 recovery ────────────────────────────────────────────────

describe('[P3] I-4 assignRole 409 recovery — client-side (user, group, group_basic) match', () => {
  const USER = 4242;
  const GROUP = 838622;

  function conflict() {
    return httpError(409, 'Kisi 409: The record already exists');
  }

  /**
   * Fix round P-4: an unresolved recovery throws KISI_ROLE_CONFLICT_UNRESOLVED
   * (not the raw 409). statusCode stays 409 so queue-worker still dead-letters
   * an all-failed grant exactly as it did the raw 409; the original is on
   * `cause`; the code is never HARDWARE_RESOURCE_NOT_FOUND (grant-revoke's
   * "user or group gone" branch, which can flag a group's health).
   */
  async function expectUnresolved(promise, originalErr, extra = {}) {
    let thrown;
    try { await promise; } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBe(originalErr);
    expect(thrown).toMatchObject({
      code: 'KISI_ROLE_CONFLICT_UNRESOLVED', statusCode: 409, userId: USER, groupId: GROUP, ...extra,
    });
    expect(thrown.cause).toBe(originalErr);
    expect(thrown.message).toMatch(/KISI_ROLE_CONFLICT_UNRESOLVED/);
    expect(warnEvents()).toContain('kisi.role.conflict_unresolvable');
    return thrown;
  }

  it('lists the user\'s assignments (no group_id filter) and returns the matching one, not the first', async () => {
    kisiConnector.makeRequest
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce([
        { id: 1, user_id: USER, group_id: 111,   role_id: 'group_basic' },  // other door
        { id: 2, user_id: USER, group_id: GROUP, role_id: 'group_basic' },  // the one
      ]);

    await expect(kisiAdapter.assignRole(API_KEY, USER, GROUP)).resolves.toBe(2);

    const recoveryPath = kisiConnector.makeRequest.mock.calls[1][0];
    expect(recoveryPath).toBe(`/role_assignments?user_id=${USER}&limit=100`);
    expect(recoveryPath).not.toMatch(/group_id=/);
  });

  it('matches across string/number id forms and applies_to_id fallback', async () => {
    kisiConnector.makeRequest
      .mockRejectedValueOnce(conflict())
      .mockResolvedValueOnce([
        { id: 9, user_id: String(USER), applies_to_type: 'Group', applies_to_id: GROUP, role_id: 'group_basic' },
      ]);
    await expect(kisiAdapter.assignRole(API_KEY, USER, String(GROUP))).resolves.toBe(9);
  });

  it('never adopts an elevated role on the same group', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce([
        { id: 3, user_id: USER, group_id: GROUP, role_id: 'group_manager' },
      ]);
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err, {
      candidateCount: 1, reason: 'no_matching_assignment',
    });
  });

  it('never adopts another user\'s assignment even if Kisi ignores the user_id filter', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce([
        { id: 4, user_id: 9999, group_id: GROUP, role_id: 'group_basic' },
      ]);
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err);
  });

  it('never adopts a Team grant to the same group (user_id null, assignee_id = team)', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce([
        { id: 5, user_id: null, assignee_type: 'Team', assignee_id: USER, group_id: GROUP, role_id: 'group_basic', scope: 'group' },
      ]);
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err);
  });

  it('never adopts a place-scoped assignment whose applies_to_id collides with the group id', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce([
        { id: 6, user_id: USER, applies_to_type: 'Place', applies_to_id: GROUP, scope: 'place' },
      ]);
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err);
  });

  // Fix round P-4: was "original 409 rethrown" — the raw 409 is now wrapped as
  // KISI_ROLE_CONFLICT_UNRESOLVED (original kept on `cause`, status kept at 409).
  it('non-array recovery body → no match → conflict_unresolvable + KISI_ROLE_CONFLICT_UNRESOLVED', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ id: 7, user_id: USER, group_id: GROUP });
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err, { candidateCount: 0 });
    const call = log.warn.mock.calls.find(c => c[0] === 'kisi.role.conflict_unresolvable');
    expect(call[1]).toEqual(expect.objectContaining({
      userId: USER, groupId: GROUP, candidateCount: 0, reason: 'no_matching_assignment',
    }));
  });

  it('a FULL recovery page with no match is still unresolved (never guessed from page 1)', async () => {
    const err = conflict();
    const otherDoors = Array.from({ length: 100 }, (_, i) => ({
      id: 10 + i, user_id: USER, group_id: 500 + i, role_id: 'group_basic',
    }));
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(otherDoors);
    await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err, { candidateCount: 100 });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);   // no further read, no write
  });

  it('recovery read 404 → KISI_ROLE_CONFLICT_UNRESOLVED, never HARDWARE_RESOURCE_NOT_FOUND (no group flag downstream)', async () => {
    const err = conflict();
    const recovery404 = httpError(404);
    recovery404.code = 'HARDWARE_RESOURCE_NOT_FOUND';   // what kisi-connector stamps on a 404
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(recovery404);
    const thrown = await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err, {
      candidateCount: 0, reason: 'recovery_read_not_found',
    });
    expect(thrown.code).not.toBe('HARDWARE_RESOURCE_NOT_FOUND');
    const call = log.warn.mock.calls.find(c => c[0] === 'kisi.role.conflict_unresolvable');
    expect(call[1]).toEqual(expect.objectContaining({ reason: 'recovery_read_not_found' }));
  });

  it.each([429, 500, 503])('recovery read %i propagates unchanged (transient — same as before Phase 1)', async (status) => {
    const err = conflict();
    const recoveryErr = httpError(status);
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(recoveryErr);
    await expect(kisiAdapter.assignRole(API_KEY, USER, GROUP)).rejects.toBe(recoveryErr);
    expect(warnEvents()).not.toContain('kisi.role.conflict_unresolvable');
  });

  it('unresolved error carries plain-English operator copy and no grant is recorded', async () => {
    const err = conflict();
    kisiConnector.makeRequest
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce([]);
    const thrown = await expectUnresolved(kisiAdapter.assignRole(API_KEY, USER, GROUP), err);
    expect(thrown.userMessage).toMatch(/Nothing was changed/);
    expect(thrown.action).toMatch(/Kisi/);
    expect(log.info.mock.calls.map(c => c[0])).not.toContain('kisi.role.recovery_succeeded');
    expect(log.info.mock.calls.map(c => c[0])).not.toContain('kisi.role.assigned');
  });

  it('non-409 errors are unchanged: rethrown with no recovery GET', async () => {
    const err = httpError(404);
    kisiConnector.makeRequest.mockRejectedValueOnce(err);
    await expect(kisiAdapter.assignRole(API_KEY, USER, GROUP)).rejects.toBe(err);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });
});

// ─── getUserById ────────────────────────────────────────────────────────────

describe('[P3] I-4 getUserById — null only on 404', () => {

  it('returns the user object', async () => {
    const user = { id: 77, email: 'x@example.test', notes: null };
    kisiConnector.makeRequest.mockResolvedValueOnce(user);
    await expect(kisiAdapter.getUserById(API_KEY, 77)).resolves.toBe(user);
    expect(kisiConnector.makeRequest).toHaveBeenCalledWith('/users/77', { method: 'GET' }, API_KEY);
  });

  it('404 → null (user is gone)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(404));
    await expect(kisiAdapter.getUserById(API_KEY, 77)).resolves.toBeNull();
  });

  it.each([401, 403, 429, 500, 503])('%i → throws (ambiguous is never "gone")', async (status) => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(status));
    await expect(kisiAdapter.getUserById(API_KEY, 77)).rejects.toMatchObject({ statusCode: status });
  });

  it('network error without a status → throws', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(kisiAdapter.getUserById(API_KEY, 77)).rejects.toThrow('fetch failed');
  });

  it.each([
    ['null (204)', null],
    ['array', [{ id: 77 }]],
    ['object without id', { email: 'x@example.test' }],
  ])('2xx with %s body → throws KISI_RESPONSE_INTEGRITY, never null', async (_label, body) => {
    kisiConnector.makeRequest.mockResolvedValueOnce(body);
    await expect(kisiAdapter.getUserById(API_KEY, 77))
      .rejects.toMatchObject({ code: 'KISI_RESPONSE_INTEGRITY' });
  });
});

describe('[P3] I-4 hardware-adapter getUserById routing', () => {

  it('routes to the Kisi adapter with (apiKey, userId)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 88 });
    await expect(hardwareAdapter.getUserById('kisi', API_KEY, 88)).resolves.toEqual({ id: 88 });
    expect(kisiConnector.makeRequest).toHaveBeenCalledWith('/users/88', { method: 'GET' }, API_KEY);
  });

  it('passes a 404 null through unchanged', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(404));
    await expect(hardwareAdapter.getUserById('kisi', API_KEY, 88)).resolves.toBeNull();
  });

  it.each([null, undefined, '', '   '])('Gate 1 rejects userId=%p before any Kisi call', async (userId) => {
    await expect(hardwareAdapter.getUserById('kisi', API_KEY, userId)).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      missingFields: ['userId'],
      attemptedOperation: 'getUserById',
    });
    expect(kisiConnector.makeRequest).not.toHaveBeenCalled();
  });

  it('getRoleAssignmentsForUser (I-5 Guard D) routes to Kisi with (apiKey, userId)', async () => {
    const rows = [{ id: 1, user_id: 88, group_id: 7, role_id: 'group_basic' }];
    kisiConnector.makeRequest.mockResolvedValueOnce(rows);
    await expect(hardwareAdapter.getRoleAssignmentsForUser('kisi', API_KEY, 88)).resolves.toEqual(rows);
    expect(kisiConnector.makeRequest).toHaveBeenCalledWith(
      '/role_assignments?user_id=88&limit=100', { method: 'GET' }, API_KEY
    );
  });

  it('getRoleAssignmentsForUser propagates non-404 errors (Guard D fails closed on throw)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(500));
    await expect(hardwareAdapter.getRoleAssignmentsForUser('kisi', API_KEY, 88))
      .rejects.toMatchObject({ statusCode: 500 });
  });

  it.each([null, undefined, ''])('getRoleAssignmentsForUser Gate 1 rejects userId=%p (no unfiltered list read)', async (userId) => {
    await expect(hardwareAdapter.getRoleAssignmentsForUser('kisi', API_KEY, userId)).rejects.toMatchObject({
      code: 'INVALID_HARDWARE_REQUEST',
      attemptedOperation: 'getRoleAssignmentsForUser',
    });
    expect(kisiConnector.makeRequest).not.toHaveBeenCalled();
  });

  it('Seam stub throws "not implemented" (never a silent null)', async () => {
    await expect(seamAdapter.getUserById(API_KEY, 88)).rejects.toThrow('Seam adapter not implemented');
    await expect(hardwareAdapter.getUserById('seam', API_KEY, 88)).rejects.toThrow('Seam adapter not implemented');
  });
});

// ─── F7: getRoleAssignmentsForUser can fail closed ──────────────────────────

const NON_ARRAY_2XX_BODIES = [
  ['null (204)', null],
  ['undefined', undefined],
  ['object wrapper', { data: [{ id: 1, role_id: 'administrator', scope: 'organization' }] }],
  ['single object', { id: 1, role_id: 'group_basic' }],
  ['HTML string', '<html>gateway</html>'],
  ['empty string', ''],
  ['number', 0],
  ['boolean', false],
];

describe('[P3] F7 getRoleAssignmentsForUser — non-array 2xx throws, [] only on 404', () => {
  const USER_ID = 31337;

  it('returns the array unchanged on a clean read', async () => {
    const rows = [{ id: 1, user_id: USER_ID, group_id: 7, role_id: 'group_basic' }];
    kisiConnector.makeRequest.mockResolvedValueOnce(rows);
    await expect(kisiAdapter.getRoleAssignmentsForUser(API_KEY, USER_ID)).resolves.toBe(rows);
    expect(kisiConnector.makeRequest).toHaveBeenCalledWith(
      `/role_assignments?user_id=${USER_ID}&limit=100`, { method: 'GET' }, API_KEY
    );
  });

  it('a genuinely empty array is still []', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([]);
    await expect(kisiAdapter.getRoleAssignmentsForUser(API_KEY, USER_ID)).resolves.toEqual([]);
  });

  it('HTTP 404 → [] (the one case kept)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(404));
    await expect(kisiAdapter.getRoleAssignmentsForUser(API_KEY, USER_ID)).resolves.toEqual([]);
    expect(warnEvents()).not.toContain('kisi.page_integrity_failed');
  });

  it.each([401, 403, 409, 429, 500, 503])('HTTP %i → throws the HTTP error', async (status) => {
    kisiConnector.makeRequest.mockRejectedValueOnce(httpError(status));
    await expect(kisiAdapter.getRoleAssignmentsForUser(API_KEY, USER_ID))
      .rejects.toMatchObject({ statusCode: status });
  });

  it.each(NON_ARRAY_2XX_BODIES)('2xx with %s body → KISI_PAGE_INTEGRITY (never [])', async (_label, body) => {
    kisiConnector.makeRequest.mockResolvedValueOnce(body);
    await expect(kisiAdapter.getRoleAssignmentsForUser(API_KEY, USER_ID)).rejects.toMatchObject({
      code: 'KISI_PAGE_INTEGRITY', integrityReason: 'non_array_page', userId: USER_ID,
    });
    const call = log.warn.mock.calls.find(c => c[0] === 'kisi.page_integrity_failed');
    expect(call).toBeDefined();
    expect(call[1]).toEqual(expect.objectContaining({ reason: 'non_array_page', userId: USER_ID }));
  });

  it('hardware-adapter (Guard D entry point) propagates KISI_PAGE_INTEGRITY', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ data: [] });
    await expect(hardwareAdapter.getRoleAssignmentsForUser('kisi', API_KEY, USER_ID))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY' });
  });
});

describe('[P3] F7 deleteUser Layer C — an unreadable role lookup aborts the delete', () => {
  const USER_ID = 999;
  const CLIENT_ID = 'client-f7';
  const ownedUser = () => ({
    id: USER_ID,
    notes: `[AS|managed|${CLIENT_ID}|2026-05-13T00:00:00Z] Created by AccessSync`,
  });

  function methods() {
    return kisiConnector.makeRequest.mock.calls.map(c => (c[1] && c[1].method) || 'GET');
  }

  it.each(NON_ARRAY_2XX_BODIES)('role lookup returns %s → KISI_PAGE_INTEGRITY thrown, DELETE never fires', async (_label, body) => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(ownedUser())   // Layer B: marker present, tenant matches
      .mockResolvedValueOnce(body)          // Layer C: unreadable answer
      .mockResolvedValueOnce({});           // a DELETE, if it (wrongly) fired

    await expect(kisiAdapter.deleteUser(API_KEY, USER_ID, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'KISI_PAGE_INTEGRITY' });

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);
    expect(methods()).not.toContain('DELETE');
    expect(log.info.mock.calls.map(c => c[0])).not.toContain('kisi.user.deleting');
  });

  it('an object wrapper that HIDES an admin role is refused, not deleted (was fail-open)', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(ownedUser())
      .mockResolvedValueOnce({ data: [{ role_id: 'administrator', scope: 'organization' }] })
      .mockResolvedValueOnce({});
    await expect(kisiAdapter.deleteUser(API_KEY, USER_ID, { clientId: CLIENT_ID })).rejects.toBeDefined();
    expect(methods()).not.toContain('DELETE');
  });

  it('role lookup 5xx → the HTTP error aborts the delete', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(ownedUser())
      .mockRejectedValueOnce(httpError(503))
      .mockResolvedValueOnce({});
    await expect(kisiAdapter.deleteUser(API_KEY, USER_ID, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(methods()).not.toContain('DELETE');
  });

  it('the thrown error is none of the DR-045 refusal codes (finalizeRevoke rethrows it → no PII purge)', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(ownedUser())
      .mockResolvedValueOnce(null);
    let thrown;
    try { await kisiAdapter.deleteUser(API_KEY, USER_ID, { clientId: CLIENT_ID }); } catch (e) { thrown = e; }
    expect(thrown).toBeDefined();
    expect(['UNOWNED_USER', 'CLIENT_MISMATCH', 'ELEVATED_ROLE_ATTACHED']).not.toContain(thrown.code);
  });
});

describe('[P1] F7 cross-layer — finalizeRevoke Guard D fails closed on a non-array 2xx', () => {
  // Real standard-adapter → real hardware-adapter → real kisi-adapter; only the
  // Kisi connector and db are mocked. Before F7 the non-array body became [],
  // Guard D passed, deleteUser ran and the PII purge transaction committed.
  const TENANT_ID        = 'client-f7-x';
  const MEMBER_ACCESS_ID = 'access-f7-x';
  const HARDWARE_USER_ID = '55501';

  function sqlCalls() {
    return db.query.mock.calls.map(c => (typeof c[0] === 'string' ? c[0] : ''));
  }

  beforeEach(() => {
    db.query.mockReset();
    db.getClient.mockReset();
    // Match on SQL text, not call position: only the finalize status re-check
    // returns a row; everything else (Guard E sharers, etc.) is empty.
    db.query.mockImplementation(async (sql) => {
      if (/FROM member_access ma\s+JOIN member_master mm/.test(sql)) {
        return { rows: [{
          status: 'inactive', hardware_user_id: HARDWARE_USER_ID,
          member_master_id: 'master-f7-x', source_tag: 'accesssync',
        }] };
      }
      return { rows: [] };
    });
    db.getClient.mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() });
  });

  it.each(NON_ARRAY_2XX_BODIES)('Guard D lookup returns %s → assignment_check_failed; no Kisi DELETE, no purge', async (_label, body) => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce(body)   // Guard D: GET /role_assignments?user_id=
      .mockResolvedValue({});        // anything after (a delete path) — must not be reached

    const result = await standardAdapter.finalizeRevoke(
      MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID
    );

    expect(result).toEqual({ finalized: false, reason: 'assignment_check_failed' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
    expect(kisiConnector.makeRequest.mock.calls[0][0])
      .toBe(`/role_assignments?user_id=${HARDWARE_USER_ID}&limit=100`);
    expect(kisiConnector.makeRequest.mock.calls.map(c => c[1] && c[1].method)).not.toContain('DELETE');
    expect(db.getClient).not.toHaveBeenCalled();   // purge transaction never opened
    for (const sql of sqlCalls()) {
      expect(sql).not.toMatch(/UPDATE member_access\b/);
      expect(sql).not.toMatch(/UPDATE member_master/);
    }
    expect(warnEvents()).toContain('adapter.finalize_revoke.assignment_check_failed');
  });

  it('control: a clean [] still lets the existing finalize proceed (behaviour unchanged)', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce([])   // Guard D: no other assignments
      .mockResolvedValueOnce({ id: HARDWARE_USER_ID, notes: `[AS|managed|${TENANT_ID}|2026-05-13T00:00:00Z] x` })
      .mockResolvedValueOnce([])   // Layer C
      .mockResolvedValueOnce({});  // DELETE

    const result = await standardAdapter.finalizeRevoke(
      MEMBER_ACCESS_ID, TENANT_ID, 'kisi', API_KEY, HARDWARE_USER_ID
    );
    expect(result).toEqual({ finalized: true, reason: 'ok' });
  });
});
