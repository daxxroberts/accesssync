/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: DR-045 Layer B lives in Kisi user metadata (phase 2)         │
 * │                                                                         │
 * │  Business consequence: the ownership marker is what stops AccessSync    │
 * │  from deleting a gym's own Kisi users (staff, the owner, hand-added     │
 * │  members). If a new user is created without it, or a guard reads it    │
 * │  wrong, either a member's Kisi account is never cleaned up or — worse — │
 * │  someone who is not ours is deleted. And since phase 2 an operator's    │
 * │  own notes on a member must never be written or trusted.                │
 * │                                                                         │
 * │  What this tests: createUser writes flat metadata (Kisi limits) and no  │
 * │  notes, and fails visibly rather than create an unmarked user;          │
 * │  deleteUser / setUserName trust metadata only — a notes marker alone is │
 * │  no longer ownership — with the error codes finalizeRevoke maps to a    │
 * │  clean refusal; Layer C still refuses elevated users; suspend / enable  │
 * │  patch access only; stampOwnershipMetadata merges, never overwrites     │
 * │  another client, confirms on re-read; listAllUsers reports the owner.   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const kisiConnector = require('../../adapters/kisi/kisi-connector');
const kisiAdapter   = require('../../adapters/kisi/kisi-adapter');

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));

const API_KEY   = 'test-kisi-key-p1';
const CLIENT_ID = 'client-hog-p1';
const OTHER     = 'client-other-p1';
const K = kisiAdapter.OWNERSHIP_METADATA_KEYS;

const meta = (clientId, extra = {}) => ({
  [K.MANAGED]: true, [K.CLIENT_ID]: clientId, [K.CREATED_AT]: '2026-10-24T00:00:00.000Z', [K.VERSION]: 1, ...extra,
});
// The retired text marker, as old users still carry it until clear-notes runs.
const legacyNotes = (clientId) => `[AS|managed|${clientId}|2026-05-13T00:00:00Z] Created by AccessSync`;
const call = (i) => kisiConnector.makeRequest.mock.calls[i];
const bodyOf = (i) => JSON.parse(call(i)[1].body);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[P1] createUser writes the metadata marker, never notes', () => {
  test('sends four flat metadata keys naming the client and no notes field', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 501 });
    await kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID });

    const { user } = bodyOf(0);
    expect(user.metadata).toEqual({
      [K.MANAGED]: true,
      [K.CLIENT_ID]: CLIENT_ID,
      [K.CREATED_AT]: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      [K.VERSION]: 1,
    });
    expect(user).not.toHaveProperty('notes');
  });

  test('stays inside Kisi metadata limits: flat primitives, keys <= 50 chars, values <= 500, <= 50 keys', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 502 });
    await kisiAdapter.createUser(API_KEY, 'a@b.com', null, { clientId: CLIENT_ID });
    const { metadata } = bodyOf(0).user;
    const entries = Object.entries(metadata);
    expect(entries.length).toBeLessThanOrEqual(50);
    for (const [k, v] of entries) {
      expect(k.length).toBeLessThanOrEqual(50);
      expect(['string', 'number', 'boolean'].includes(typeof v) || v === null).toBe(true);
      if (typeof v === 'string') expect(v.length).toBeLessThanOrEqual(500);
    }
  });

  test('if Kisi rejects the metadata field the create fails — never an unmarked user', async () => {
    const rejected = Object.assign(new Error('Kisi 422'), {
      statusCode: 422, body: { errors: { metadata: ['is not permitted'] } },
    });
    kisiConnector.makeRequest.mockRejectedValueOnce(rejected);
    await expect(
      kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })
    ).rejects.toBe(rejected);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('[P1] deleteUser Layer B trusts metadata only', () => {
  const noRoles = [{ role_id: 'group_basic', scope: 'group' }];

  test('metadata marker for this client → DELETE fires', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID), notes: null })
      .mockResolvedValueOnce(noRoles)
      .mockResolvedValueOnce({});
    await kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID });
    expect(call(2)[1].method).toBe('DELETE');
  });

  test('a notes marker alone is no longer ownership → UNOWNED_USER, no DELETE', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, notes: legacyNotes(CLIENT_ID) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'UNOWNED_USER' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test("whatever notes say is ignored: our metadata + another client's old notes line → DELETE fires", async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID), notes: legacyNotes(OTHER) })
      .mockResolvedValueOnce(noRoles)
      .mockResolvedValueOnce({});
    await kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID });
    expect(call(2)[1].method).toBe('DELETE');
  });

  test('metadata naming another client → CLIENT_MISMATCH, no DELETE', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(OTHER), notes: legacyNotes(CLIENT_ID) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH', ownerClientId: OTHER });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('accesssync_managed not true → no marker → UNOWNED_USER', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID, { [K.MANAGED]: false }) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'UNOWNED_USER' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('Layer C still refuses an elevated user that carries our metadata marker', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID) })
      .mockResolvedValueOnce([{ role_id: 'administrator', scope: 'organization' }]);
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'ELEVATED_ROLE_ATTACHED' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);
  });
});

describe('[P1] setUserName ownership check', () => {
  test('metadata owner → PATCHes name only', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID) })
      .mockResolvedValueOnce({});
    await kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID });
    expect(bodyOf(1)).toEqual({ user: { name: 'Ann Bee' } });
  });

  test('a notes marker alone → NOT_ACCESSSYNC_MANAGED, no PATCH', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, notes: legacyNotes(CLIENT_ID) });
    await expect(kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'NOT_ACCESSSYNC_MANAGED' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('metadata naming another client → CLIENT_MISMATCH', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(OTHER) });
    await expect(kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH' });
  });
});

describe('[P1] suspend / enable never write notes', () => {
  test('suspendAccess PATCHes access_enabled:false only', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({});
    await kisiAdapter.suspendAccess(API_KEY, 9, 'Payment failed', { clientId: CLIENT_ID });
    expect(bodyOf(0)).toEqual({ user: { access_enabled: false } });
  });

  test('enableAccess PATCHes access_enabled:true only', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({});
    await kisiAdapter.enableAccess(API_KEY, 9, { clientId: CLIENT_ID });
    expect(bodyOf(0)).toEqual({ user: { access_enabled: true } });
  });
});

describe('[P1] ownership helpers', () => {
  test('readUserOwnership reads metadata only', () => {
    expect(kisiAdapter.readUserOwnership({ metadata: meta(CLIENT_ID) }))
      .toEqual({ clientId: CLIENT_ID, createdAt: '2026-10-24T00:00:00.000Z', source: 'metadata' });
    expect(kisiAdapter.readUserOwnership({ notes: legacyNotes(CLIENT_ID) })).toBeNull();
    expect(kisiAdapter.readUserOwnership({ metadata: {}, notes: 'VIP — comp access' })).toBeNull();
    expect(kisiAdapter.readUserOwnership(null)).toBeNull();
  });

  test('parseOwnershipMetadata accepts "true" as a string, rejects a blank client id and non-objects', () => {
    expect(kisiAdapter.parseOwnershipMetadata(meta(CLIENT_ID, { [K.MANAGED]: 'true' }))).toMatchObject({ clientId: CLIENT_ID });
    expect(kisiAdapter.parseOwnershipMetadata(meta('  '))).toBeNull();
    expect(kisiAdapter.parseOwnershipMetadata([])).toBeNull();
    expect(kisiAdapter.parseOwnershipMetadata(null)).toBeNull();
  });

  test('mergeOwnershipMetadata keeps foreign keys and refuses to exceed 50 keys', () => {
    const merged = kisiAdapter.mergeOwnershipMetadata({ city: 'Austin' }, CLIENT_ID, '2026-01-01T00:00:00.000Z');
    expect(merged).toMatchObject({ city: 'Austin', [K.CLIENT_ID]: CLIENT_ID, [K.CREATED_AT]: '2026-01-01T00:00:00.000Z' });

    const crowded = Object.fromEntries(Array.from({ length: 47 }, (_, i) => [`k${i}`, i]));
    expect(() => kisiAdapter.mergeOwnershipMetadata(crowded, CLIENT_ID)).toThrow(
      expect.objectContaining({ code: 'KISI_METADATA_FULL' })
    );
  });
});

describe('[P1] stampOwnershipMetadata (backfill write)', () => {
  test('merges into existing metadata, PATCHes metadata only, confirms on re-read', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: { city: 'Austin' }, notes: legacyNotes(CLIENT_ID) }) // GET
      .mockResolvedValueOnce(undefined)                                                             // PATCH (204)
      .mockResolvedValueOnce({ id: 9, metadata: { city: 'Austin', ...meta(CLIENT_ID) } });          // re-GET

    const res = await kisiAdapter.stampOwnershipMetadata(API_KEY, 9, CLIENT_ID, { createdAt: '2026-05-13T00:00:00Z' });

    expect(res.status).toBe('written');
    expect(call(1)[0]).toBe('/users/9');
    expect(call(1)[1].method).toBe('PATCH');
    const sent = bodyOf(1);
    expect(Object.keys(sent.user)).toEqual(['metadata']);
    expect(sent.user.metadata).toMatchObject({ city: 'Austin', [K.CLIENT_ID]: CLIENT_ID, [K.CREATED_AT]: '2026-05-13T00:00:00Z' });
  });

  test('already marked for this client → no PATCH', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID) });
    const res = await kisiAdapter.stampOwnershipMetadata(API_KEY, 9, CLIENT_ID);
    expect(res.status).toBe('already');
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('metadata names another client → CLIENT_MISMATCH, never overwritten', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(OTHER) });
    await expect(kisiAdapter.stampOwnershipMetadata(API_KEY, 9, CLIENT_ID))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('a re-read without the marker → KISI_METADATA_NOT_PERSISTED', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: {} })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 9, metadata: {} });
    await expect(kisiAdapter.stampOwnershipMetadata(API_KEY, 9, CLIENT_ID))
      .rejects.toMatchObject({ code: 'KISI_METADATA_NOT_PERSISTED' });
  });
});

describe('[P1] listAllUsers reports the metadata owner', () => {
  test('metadata owners are labelled; a notes line alone is not ownership', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { id: 1, email: 'a@x', name: 'A', metadata: meta(CLIENT_ID) },
      { id: 2, email: 'b@x', name: 'B', notes: legacyNotes(CLIENT_ID) },
      { id: 3, email: 'c@x', name: 'C' },
    ]);
    const users = await kisiAdapter.listAllUsers(API_KEY);
    expect(users).toEqual([
      { id: 1, email: 'a@x', name: 'A', ownerClientId: CLIENT_ID, ownershipSource: 'metadata' },
      { id: 2, email: 'b@x', name: 'B', ownerClientId: null, ownershipSource: null },
      { id: 3, email: 'c@x', name: 'C', ownerClientId: null, ownershipSource: null },
    ]);
  });
});
