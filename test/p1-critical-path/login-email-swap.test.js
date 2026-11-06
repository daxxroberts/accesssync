/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  DR-056 — a changed Wix login email swaps the member's Kisi user        │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    1. The member is never without door access: the new Kisi user is     │
 * │       created and given every door BEFORE the old one is deleted.       │
 * │    2. Nothing changes until every safety check has passed (switch,      │
 * │       verified email, shared login, 30-day limit, live day pass, new    │
 * │       email free, old user ours).                                       │
 * │    3. A failure after the new user exists deletes the new user and      │
 * │       leaves our records and the old user untouched. No half-moved      │
 * │       member.                                                           │
 * │    4. Both emails go out only after the swap finished cleanly, to the   │
 * │       right addresses, with the new address masked in the notice.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../adapters/standard-adapter', () => ({
  completeLoginEmailSwap: jest.fn(),
  storeLoginEmail: jest.fn(),
}));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-056'),
  getActor: jest.fn(() => ({ type: 'system', id: 'queue-worker' })),
}));
jest.mock('../../adapters/hardware-adapter', () => ({
  findUserByEmail: jest.fn(),
  assertUserDeletable: jest.fn(),
  createUser: jest.fn(),
  assignRole: jest.fn(),
  suspendAccess: jest.fn(),
  deleteUser: jest.fn(),
}));
jest.mock('../../core/member-mailer', () => ({ sendMemberEmail: jest.fn() }));

const db = require('../../db');
const hw = require('../../adapters/hardware-adapter');
const l3 = require('../../adapters/standard-adapter');
const mailer = require('../../core/member-mailer');
const templates = require('../../core/email-templates');
const { log } = require('../../core/logger');
const { runLoginEmailSwap, SwapBlocked, _groupsToMove } = require('../../core/login-email-swap');

const CLIENT = 'client-056';
const OLD_USER = '111';
const NEW_USER = '222';

const PERSON = {
  member_master_id: 'mm-1', email: 'old@x.com', first_name: 'Terrill', last_name: 'Wise', display_name: null,
  access_id: 'acc-1', hardware_user_id: OLD_USER, hardware_platform: 'kisi', status: 'active',
};
const EVENT = { platformMemberId: 'wix-1', email: 'New@X.com', loginEmailVerified: true };
const SOURCES = [
  { id: 's1', hardware_group_id: 'g-main', role_assignment_id: 'ra-old-1', valid_until: null, mapping_id: 'pm-1' },
  { id: 's2', hardware_group_id: 'g-pool', role_assignment_id: 'ra-old-2', valid_until: null, mapping_id: 'pm-1' },
];

let order;          // the sequence of side effects, to prove create-first / delete-last
let world;

function setWorld(over = {}) {
  world = {
    settings: { notification_email: 'chad@hog.com' },
    person: PERSON, shared: [], recent: [], dayPass: [], sources: SOURCES,
    plans: [{ plan_name: 'Monthly', door_name: 'Front Door' }],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  order = [];
  setWorld();
  db.query.mockImplementation((sql) => {
    if (/FROM clients WHERE id/.test(sql)) return world.settingsError ? Promise.reject(world.settingsError) : Promise.resolve({ rows: [world.settings] });
    if (/FROM member_master mm/.test(sql)) return Promise.resolve({ rows: world.person ? [world.person] : [] });
    if (/FROM member_access WHERE client_id = \$1 AND hardware_user_id/.test(sql)) return Promise.resolve({ rows: world.shared });
    if (/FROM member_access_log/.test(sql)) return Promise.resolve({ rows: world.recent });
    if (/source_type = 'day_pass'/.test(sql)) return Promise.resolve({ rows: world.dayPass });
    if (/FROM member_access_sources/.test(sql)) return Promise.resolve({ rows: world.sources });
    if (/FROM connector_subscriptions/.test(sql)) return Promise.resolve({ rows: [{ kisi_user_pattern: 'invited' }] });
    if (/FROM plan_mappings/.test(sql)) return Promise.resolve({ rows: world.plans });
    return Promise.resolve({ rows: [] });
  });
  l3.storeLoginEmail.mockImplementation(async () => { order.push('l3:storeLoginEmail'); });
  l3.completeLoginEmailSwap.mockImplementation(async () => {
    order.push('l3:completeLoginEmailSwap');
    if (world.commitFails) throw new Error('commit boom');
  });

  hw.findUserByEmail.mockResolvedValue(null);
  hw.assertUserDeletable.mockResolvedValue({ user: { id: OLD_USER, email: 'old@x.com', access_enabled: true }, marker: { clientId: CLIENT } });
  hw.createUser.mockImplementation(async () => { order.push('createUser'); return NEW_USER; });
  hw.assignRole.mockImplementation(async (_p, _k, _u, groupId) => {
    order.push(`assignRole:${groupId}`);
    if (world.assignFails === groupId) throw new Error('kisi 500');
    return `ra-new-${groupId}`;
  });
  hw.suspendAccess.mockImplementation(async () => { order.push('suspendAccess'); });
  hw.deleteUser.mockImplementation(async (_p, _k, userId) => {
    order.push(`deleteUser:${userId}`);
    if (userId === OLD_USER && world.oldDeleteFails) { const e = new Error('kisi down'); e.statusCode = 500; throw e; }
  });
  mailer.sendMemberEmail.mockImplementation(async (p) => { order.push(`email:${p.emailType}`); return { sent: true }; });
});

const run = (event = EVENT) => runLoginEmailSwap({
  tenantId: CLIENT, standardEvent: event, eventId: 'evt-1', logger: log, getApiKey: jest.fn().mockResolvedValue('key'),
});
const expectNothingChangedInKisi = () => {
  expect(hw.createUser).not.toHaveBeenCalled();
  expect(hw.assignRole).not.toHaveBeenCalled();
  expect(hw.deleteUser).not.toHaveBeenCalled();
  expect(mailer.sendMemberEmail).not.toHaveBeenCalled();
};

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 the happy path: create first, delete last', () => {
  test('order is create → assign every door → one transaction → delete old → emails', async () => {
    const res = await run();
    expect(res).toEqual({ status: 'swapped' });
    expect(order).toEqual([
      'createUser', 'assignRole:g-main', 'assignRole:g-pool',
      'l3:completeLoginEmailSwap',
      `deleteUser:${OLD_USER}`,
      'email:access_ready', 'email:login_email_changed',
    ]);
  });

  test('the new Kisi user carries the new email, the member name and our ownership (clientId)', async () => {
    await run();
    expect(hw.createUser).toHaveBeenCalledWith('kisi', 'key', 'New@X.com', 'Terrill Wise', { userPattern: 'invited', clientId: CLIENT });
    expect(hw.deleteUser).toHaveBeenCalledWith('kisi', 'key', OLD_USER, { clientId: CLIENT });
  });

  test('records move through Layer 3 in ONE call: new role ids per door, the new Kisi user id, the new email, and the audit event', async () => {
    await run();
    expect(l3.completeLoginEmailSwap).toHaveBeenCalledTimes(1);
    expect(l3.completeLoginEmailSwap).toHaveBeenCalledWith({
      accessId: 'acc-1', memberMasterId: 'mm-1', tenantId: CLIENT,
      newEmail: 'New@X.com', newHardwareUserId: NEW_USER, auditEventType: 'login_email_swapped',
      sourceMoves: [
        { sourceIds: ['s1'], roleAssignmentId: 'ra-new-g-main' },
        { sourceIds: ['s2'], roleAssignmentId: 'ra-new-g-pool' },
      ],
    });
  });

  test('this module itself never writes the member tables (DR-023): its only writes are via Layer 3', async () => {
    await run();
    const writes = db.query.mock.calls.filter(c => /^\s*(INSERT|UPDATE|DELETE)/i.test(c[0]));
    expect(writes).toEqual([]);
  });

  test('two plans on one door get ONE role assignment; permanent beats a dated source', async () => {
    const groups = _groupsToMove([
      { id: 'a', hardware_group_id: 'g1', valid_until: '2026-12-01T00:00:00Z', mapping_id: 'pm-1' },
      { id: 'b', hardware_group_id: 'g1', valid_until: null, mapping_id: 'pm-2' },
      { id: 'c', hardware_group_id: 'g2', valid_until: '2026-12-01T00:00:00Z', mapping_id: 'pm-1' },
      { id: 'd', hardware_group_id: 'g2', valid_until: '2027-01-01T00:00:00Z', mapping_id: 'pm-1' },
    ]);
    const g1 = groups.find(g => g.groupId === 'g1');
    const g2 = groups.find(g => g.groupId === 'g2');
    expect(g1.validUntil).toBeNull();
    expect(g1.sourceIds).toEqual(['a', 'b']);
    expect(new Date(g2.validUntil).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  test('a suspended member stays suspended on the new user', async () => {
    hw.assertUserDeletable.mockResolvedValue({ user: { id: OLD_USER, email: 'old@x.com', access_enabled: false }, marker: {} });
    await run();
    expect(hw.suspendAccess).toHaveBeenCalledWith('kisi', 'key', NEW_USER, 'Access suspended', { clientId: CLIENT });
    expect(order.indexOf('suspendAccess')).toBeLessThan(order.indexOf('l3:completeLoginEmailSwap'));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 the emails', () => {
  test('access_ready goes to the NEW address; the notice goes to the OLD address with the new one masked', async () => {
    await run();
    const [ready, notice] = mailer.sendMemberEmail.mock.calls.map(c => c[0]);
    expect(ready).toMatchObject({ emailType: 'access_ready', recipient: 'New@X.com', clientId: CLIENT, memberMasterId: 'mm-1' });
    expect(ready.dedupKey).toBe('acc-1:swap:evt-1');
    expect(ready.renderArgs.plans).toEqual([{ planName: 'Monthly', doorName: 'Front Door' }]);
    expect(notice).toMatchObject({ emailType: 'login_email_changed', recipient: 'old@x.com' });
    expect(notice.dedupKey).toBe('acc-1:evt-1');
    expect(notice.renderArgs.newEmailMasked).toBe('Ne***@X.com');
    expect(JSON.stringify(notice.renderArgs)).not.toMatch(/New@X\.com/);
  });

  test('stored email missing: the notice goes to the address Kisi had', async () => {
    setWorld({ person: { ...PERSON, email: null } });
    await run();
    const notice = mailer.sendMemberEmail.mock.calls.map(c => c[0]).find(p => p.emailType === 'login_email_changed');
    expect(notice.recipient).toBe('old@x.com');
  });

  test('no emails at all when the swap fails before it finishes', async () => {
    setWorld({ assignFails: 'g-pool' });
    await expect(run()).rejects.toThrow('kisi 500');
    expect(mailer.sendMemberEmail).not.toHaveBeenCalled();
  });

  test('a gym with no admin contact still swaps, and says so in the log', async () => {
    setWorld({ settings: { notification_email: null } });
    await expect(run()).resolves.toEqual({ status: 'swapped' });
    expect(log.warn).toHaveBeenCalledWith('login_email_swap.no_admin_contact', expect.any(Object));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 nothing changes until every check passes', () => {
  test('the admin-contact lookup failing after the swap does not fail the swap', async () => {
    setWorld({ settingsError: new Error('clients read failed') });
    await expect(run()).resolves.toEqual({ status: 'swapped' });
    expect(hw.deleteUser).toHaveBeenCalledWith('kisi', 'key', OLD_USER, expect.anything());
  });

  test('email did not change (ordinary profile edit, different case) → skipped', async () => {
    await expect(run({ ...EVENT, email: 'OLD@x.com' })).resolves.toMatchObject({ status: 'skipped', reason: 'unchanged' });
    expect(hw.findUserByEmail).not.toHaveBeenCalled();
    expectNothingChangedInKisi();
  });

  test('member we have never seen → skipped', async () => {
    setWorld({ person: null });
    await expect(run()).resolves.toMatchObject({ status: 'skipped', reason: 'unknown_member' });
    expectNothingChangedInKisi();
  });

  test('Wix has not verified the new email → blocked, flagged, nothing touched', async () => {
    await expect(run({ ...EVENT, loginEmailVerified: false })).rejects.toMatchObject({ code: 'LOGIN_EMAIL_UNVERIFIED', statusCode: 409 });
    await expect(run({ ...EVENT, loginEmailVerified: undefined })).rejects.toBeInstanceOf(SwapBlocked);
    expect(hw.findUserByEmail).not.toHaveBeenCalled();
    expectNothingChangedInKisi();
  });

  test('member has no Kisi user yet → only the stored email is updated', async () => {
    setWorld({ person: { ...PERSON, hardware_user_id: null } });
    await expect(run()).resolves.toEqual({ status: 'email_stored' });
    expect(order).toEqual(['l3:storeLoginEmail']);
    expect(l3.storeLoginEmail).toHaveBeenCalledWith('mm-1', CLIENT, 'New@X.com');
    expectNothingChangedInKisi();
  });

  test('another member shares this Kisi login → blocked', async () => {
    setWorld({ shared: [{ '?column?': 1 }] });
    await expect(run()).rejects.toMatchObject({ code: 'LOGIN_EMAIL_SHARED_USER' });
    expectNothingChangedInKisi();
  });

  test('already swapped in the last 30 days → blocked', async () => {
    setWorld({ recent: [{ '?column?': 1 }] });
    await expect(run()).rejects.toMatchObject({ code: 'LOGIN_EMAIL_RATE_LIMITED' });
    expectNothingChangedInKisi();
  });

  test('a live day pass → deferred until it ends, nothing touched', async () => {
    const ends = new Date(Date.now() + 3 * 3600 * 1000).toISOString();
    setWorld({ dayPass: [{ valid_until: ends }] });
    const res = await run();
    expect(res.status).toBe('deferred');
    expect(res.delayMs).toBeGreaterThan(3 * 3600 * 1000);
    expect(res.delayMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expectNothingChangedInKisi();
  });

  test('a day pass with no end date waits an hour, never forever', async () => {
    setWorld({ dayPass: [{ valid_until: null }] });
    const res = await run();
    expect(res.delayMs).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(res.delayMs).toBeGreaterThan(0);
  });

  test('the new email already belongs to a DIFFERENT Kisi user → blocked, never merged', async () => {
    hw.findUserByEmail.mockResolvedValue('999');
    await expect(run()).rejects.toMatchObject({ code: 'LOGIN_EMAIL_IN_USE' });
    expectNothingChangedInKisi();
  });

  test('Kisi already shows the new email on this same user → only our copy is updated', async () => {
    hw.findUserByEmail.mockResolvedValue(OLD_USER);
    await expect(run()).resolves.toEqual({ status: 'email_stored' });
    expectNothingChangedInKisi();
  });

  test.each(['UNOWNED_USER', 'CLIENT_MISMATCH', 'ELEVATED_ROLE_ATTACHED'])(
    'old Kisi user fails the DR-045 guard (%s) → blocked BEFORE the new user is created', async (code) => {
      hw.assertUserDeletable.mockRejectedValue(Object.assign(new Error('guard'), { code }));
      await expect(run()).rejects.toMatchObject({ code: 'LOGIN_EMAIL_USER_NOT_OURS' });
      expectNothingChangedInKisi();
    });

  test('an unreadable guard (Kisi outage) is NOT read as "not ours": it propagates to retry', async () => {
    hw.assertUserDeletable.mockRejectedValue(Object.assign(new Error('503'), { statusCode: 503 }));
    await expect(run()).rejects.toThrow('503');
    expectNothingChangedInKisi();
  });

  test('old Kisi user already gone → swap still builds the new user and skips the delete', async () => {
    hw.assertUserDeletable.mockResolvedValue(null);
    await expect(run()).resolves.toEqual({ status: 'swapped' });
    expect(hw.createUser).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 a failure never leaves a half-moved member', () => {
  test('granting a door to the new user fails → new user deleted, DB never touched, old user kept, no emails', async () => {
    setWorld({ assignFails: 'g-pool' });
    await expect(run()).rejects.toThrow('kisi 500');
    expect(order).toEqual(['createUser', 'assignRole:g-main', 'assignRole:g-pool', `deleteUser:${NEW_USER}`]);
    expect(l3.completeLoginEmailSwap).not.toHaveBeenCalled();
    expect(hw.deleteUser).not.toHaveBeenCalledWith('kisi', 'key', OLD_USER, expect.anything());
    expect(mailer.sendMemberEmail).not.toHaveBeenCalled();
  });

  test('Layer 3\'s transaction fails → new user deleted, old user kept, no emails', async () => {
    setWorld({ commitFails: true });
    await expect(run()).rejects.toThrow('commit boom');
    expect(order[order.length - 1]).toBe(`deleteUser:${NEW_USER}`);
    expect(hw.deleteUser).not.toHaveBeenCalledWith('kisi', 'key', OLD_USER, expect.anything());
    expect(mailer.sendMemberEmail).not.toHaveBeenCalled();
  });

  test('creating the new user fails → nothing to undo, nothing else touched', async () => {
    hw.createUser.mockRejectedValue(new Error('create failed'));
    await expect(run()).rejects.toThrow('create failed');
    expect(hw.assignRole).not.toHaveBeenCalled();
    expect(hw.deleteUser).not.toHaveBeenCalled();
    expect(l3.completeLoginEmailSwap).not.toHaveBeenCalled();
  });

  test('the rollback delete itself fails → original error still thrown, loud log, old user still untouched', async () => {
    setWorld({ assignFails: 'g-main' });
    hw.deleteUser.mockRejectedValue(new Error('cannot delete new'));
    await expect(run()).rejects.toThrow('kisi 500');
    expect(log.error).toHaveBeenCalledWith('login_email_swap.rollback_failed', expect.any(Object), expect.any(Error));
  });

  test('old-user delete fails AFTER the move → member stays moved, flagged, and NO emails', async () => {
    setWorld({ oldDeleteFails: true });
    await expect(run()).rejects.toMatchObject({ code: 'LOGIN_EMAIL_OLD_USER_NOT_REMOVED', statusCode: 409 });
    expect(order).toContain('l3:completeLoginEmailSwap');
    expect(hw.deleteUser).not.toHaveBeenCalledWith('kisi', 'key', NEW_USER, expect.anything());
    expect(mailer.sendMemberEmail).not.toHaveBeenCalled();
  });

  test('no email address appears in any log line', async () => {
    await run();
    const lines = JSON.stringify([...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls]);
    expect(lines).not.toMatch(/old@x\.com/i);
    expect(lines).not.toMatch(/new@x\.com/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-056 the old-address notice (wording approved 2026-11-05)', () => {
  const branding = templates.brandingFromClientRow({
    name: 'House of Gains', notification_email: 'chad@hog.com',
    email_primary_color: '#333333', email_secondary_color: '#ffdb29',
  });

  test('says what was approved, masks the new address, offers the That wasn\'t me button', () => {
    const r = templates.renderLoginEmailChanged({ branding, member: { firstName: 'Terrill' }, newEmailMasked: templates.maskEmail('terrill@gmail.com') });
    expect(r.subject).toBe('Your House of Gains door login email was changed');
    for (const part of [
      'Your door login email changed', 'Hi Terrill,',
      'The email on your House of Gains door login was just changed to te***@gmail.com. Your sign-in link for the Kisi app is on its way to that address.',
      "If you made the change, you're set. Nothing else to do, and your door access works the same.",
      "If you didn't, tell us right away. We'll lock it down.",
      "That wasn't me: mailto:chad@hog.com",
    ]) expect(r.text).toContain(part);
    expect(r.html).toContain('mailto:chad@hog.com');
    expect(r.html).toContain('#ffdb29');
    expect(r.text + r.html).not.toContain('terrill@gmail.com');
  });

  test('no first name → "Hi there,"; no admin contact → no button', () => {
    const bare = templates.brandingFromClientRow({ name: 'Iron Works' });
    const r = templates.renderLoginEmailChanged({ branding: bare, member: {}, newEmailMasked: 'a***@x.com' });
    expect(r.text).toContain('Hi there,');
    expect(r.text).not.toContain("That wasn't me");
  });

  test('the member name and gym name are escaped in the HTML', () => {
    const evil = templates.brandingFromClientRow({ name: 'A<b>&Co', notification_email: 'x@y.com' });
    const r = templates.renderLoginEmailChanged({ branding: evil, member: { firstName: '<script>' }, newEmailMasked: 'a***@x.com' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).not.toContain('A<b>&Co');
  });

  test('maskEmail', () => {
    expect(templates.maskEmail('olivia@gmail.com')).toBe('ol***@gmail.com');
    expect(templates.maskEmail('al@x.com')).toBe('a***@x.com');
    expect(templates.maskEmail('nonsense')).toBe('***');
    expect(templates.maskEmail(null)).toBe('***');
  });
});
