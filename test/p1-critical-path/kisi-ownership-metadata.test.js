/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: DR-045 Layer B moves to Kisi user metadata (phase 1)         │
 * │                                                                         │
 * │  Business consequence: the ownership marker is what stops AccessSync    │
 * │  from deleting a gym's own Kisi users (staff, the owner, hand-added     │
 * │  members). If a new user is created without it, or a guard reads it    │
 * │  wrong, either a member's Kisi account is never cleaned up or — worse — │
 * │  someone who is not ours is deleted.                                    │
 * │                                                                         │
 * │  What this tests: createUser writes flat metadata (Kisi limits) plus    │
 * │  the legacy notes marker, and still creates the user if Kisi rejects    │
 * │  metadata; deleteUser / setUserName accept metadata or notes and refuse │
 * │  on no marker, another client, or a metadata-vs-notes conflict, with    │
 * │  the error codes finalizeRevoke already maps to a clean refusal;        │
 * │  Layer C still refuses elevated users; stampOwnershipMetadata merges,   │
 * │  never overwrites another client, and confirms on re-read;              │
 * │  listAllUsers reports owner + marker source for reconcile's count.      │
 * │  DR-045 step 1 (SAGE 2026-10-26): suspend / enable PATCH access only    │
 * │  (no notes); createUser checks the echoed label and heals it on the     │
 * │  spot, and if that fails warns + alerts but still returns the user.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const kisiConnector = require('../../adapters/kisi/kisi-connector');
const kisiAdapter   = require('../../adapters/kisi/kisi-adapter');
const db            = require('../../db');
const { log }       = require('../../core/logger');

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));
jest.mock('../../db', () => ({ query: jest.fn() }));

const API_KEY   = 'test-kisi-key-p1';
const CLIENT_ID = 'client-hog-p1';
const OTHER     = 'client-other-p1';
const K = kisiAdapter.OWNERSHIP_METADATA_KEYS;

const meta = (clientId, extra = {}) => ({
  [K.MANAGED]: true, [K.CLIENT_ID]: clientId, [K.CREATED_AT]: '2026-10-24T00:00:00.000Z', [K.VERSION]: 1, ...extra,
});
const notesFor = (clientId) => `[AS|managed|${clientId}|2026-05-13T00:00:00Z] Created by AccessSync`;
const call = (i) => kisiConnector.makeRequest.mock.calls[i];
const bodyOf = (i) => JSON.parse(call(i)[1].body);
// Kisi's POST /users response echoes the user it made, metadata included (verified live 2026-10-26).
const echoCreate = (id) => (_path, opts) => Promise.resolve({ id, metadata: JSON.parse(opts.body).user.metadata });
const alertInserts = () => db.query.mock.calls.filter(([sql]) => /INSERT INTO config_alert_log/.test(sql));
const warnSpy = jest.spyOn(log, 'warn');
const warned = (event) => warnSpy.mock.calls.filter(([e]) => e === event);

beforeEach(() => {
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

describe('[P1] createUser writes the metadata marker', () => {
  test('sends four flat metadata keys naming the client, alongside the legacy notes marker', async () => {
    kisiConnector.makeRequest.mockImplementationOnce(echoCreate(501));
    await kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID });

    const { user } = bodyOf(0);
    expect(user.metadata).toEqual({
      [K.MANAGED]: true,
      [K.CLIENT_ID]: CLIENT_ID,
      [K.CREATED_AT]: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      [K.VERSION]: 1,
    });
    expect(user.notes).toMatch(new RegExp(`^\\[AS\\|managed\\|${CLIENT_ID}\\|`));
    // One timestamp for both records, so verify can compare them.
    expect(kisiAdapter.parseAccessSyncMarker(user.notes).createdAt).toBe(user.metadata[K.CREATED_AT]);
  });

  test('stays inside Kisi metadata limits: flat primitives, keys <= 50 chars, values <= 500, <= 50 keys', async () => {
    kisiConnector.makeRequest.mockImplementationOnce(echoCreate(502));
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

  test('if Kisi rejects the metadata field, the user is still created (notes marker only), then labelled', async () => {
    const rejected = Object.assign(new Error('Kisi 422'), {
      statusCode: 422, body: { errors: { metadata: ['is not permitted'] } },
    });
    kisiConnector.makeRequest
      .mockRejectedValueOnce(rejected)
      .mockResolvedValueOnce({ id: 503 })                                   // POST without metadata
      .mockResolvedValueOnce({ id: 503, metadata: {} })                     // stamp: GET
      .mockResolvedValueOnce({})                                            // stamp: PATCH
      .mockResolvedValueOnce({ id: 503, metadata: meta(CLIENT_ID) });       // stamp: re-read

    const id = await kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID });

    expect(id).toBe(503);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(5);
    expect(bodyOf(0).user.metadata).toBeDefined();
    expect(bodyOf(1).user.metadata).toBeUndefined();
    expect(bodyOf(1).user.notes).toMatch(/^\[AS\|managed\|/);
    expect(call(3)[0]).toBe('/users/503');
    expect(bodyOf(3).user.metadata[K.CLIENT_ID]).toBe(CLIENT_ID);
    expect(alertInserts()).toHaveLength(0);
  });

  test('a 422 about something else is thrown, never retried', async () => {
    const taken = Object.assign(new Error('Kisi 422'), {
      statusCode: 422, body: { errors: { email: ['has already been taken'] } },
    });
    kisiConnector.makeRequest.mockRejectedValueOnce(taken);
    await expect(
      kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })
    ).rejects.toBe(taken);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('[P1] DR-045 step 1: createUser checks the label and heals it on the spot (access first)', () => {
  test('echoed marker for this client → done: no extra Kisi call, no warn, no alert', async () => {
    kisiConnector.makeRequest.mockImplementationOnce(echoCreate(601));

    await expect(kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })).resolves.toBe(601);

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
    expect(warned('kisi.user.create_metadata_missing')).toHaveLength(0);
    expect(alertInserts()).toHaveLength(0);
  });

  test('marker missing from the echo → stamped right away with the create timestamp; no alert', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 602 })                                   // POST echo without metadata
      .mockResolvedValueOnce({ id: 602, metadata: { city: 'Austin' } })     // stamp: GET
      .mockResolvedValueOnce({})                                            // stamp: PATCH
      .mockResolvedValueOnce({ id: 602, metadata: meta(CLIENT_ID, { city: 'Austin' }) }); // re-read

    await expect(kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })).resolves.toBe(602);

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(4);
    expect(call(2)[0]).toBe('/users/602');
    expect(call(2)[1].method).toBe('PATCH');
    // Metadata only, merged, same createdAt the POST sent — never notes or access.
    expect(bodyOf(2)).toEqual({
      user: { metadata: { city: 'Austin', ...bodyOf(0).user.metadata } },
    });
    expect(warned('kisi.user.create_metadata_missing')).toHaveLength(0);
    expect(alertInserts()).toHaveLength(0);
  });

  test('stamp fails → persisted warn + operator alert, and the grant still gets the user id', async () => {
    const down = Object.assign(new Error('Kisi 503'), { statusCode: 503 });
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 603 })                                   // POST echo without metadata
      .mockRejectedValueOnce(down);                                         // stamp: GET fails

    await expect(kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })).resolves.toBe(603);

    const [[, ctx]] = warned('kisi.user.create_metadata_missing');
    expect(ctx).toMatchObject({ kisiUserId: 603, clientId: CLIENT_ID, statusCode: 503 });
    const alerts = alertInserts();
    expect(alerts).toHaveLength(1);
    const [, params] = alerts[0];
    expect(params[0]).toBe(CLIENT_ID);
    expect(params[1]).toBe('kisi_create_metadata_missing');
    expect(params[2]).toBe('kisi_user_id=603 code=503');
  });

  test('echo names another client → stamp refuses to overwrite it (no PATCH), warn + alert, id returned', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 604, metadata: meta(OTHER) })            // POST echo: someone else's label
      .mockResolvedValueOnce({ id: 604, metadata: meta(OTHER) });           // stamp: GET

    await expect(kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })).resolves.toBe(604);

    expect(kisiConnector.makeRequest.mock.calls.map(([, o]) => o.method)).toEqual(['POST', 'GET']);
    expect(warned('kisi.user.create_metadata_missing')[0][1]).toMatchObject({ code: 'CLIENT_MISMATCH' });
    expect(alertInserts()).toHaveLength(1);
  });

  test('the alert INSERT failing too still never fails the grant', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 605 })
      .mockRejectedValueOnce(Object.assign(new Error('Kisi 500'), { statusCode: 500 }));

    await expect(kisiAdapter.createUser(API_KEY, 'a@b.com', 'Ann Bee', { clientId: CLIENT_ID })).resolves.toBe(605);
    expect(alertInserts()).toHaveLength(1);
  });
});

describe('[P1] DR-045 step 1: suspend / enable never write notes', () => {
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

  test('without a clientId: the same body, and no marker warning (there is no marker to lose)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({}).mockResolvedValueOnce({});
    await kisiAdapter.suspendAccess(API_KEY, 9, 'Location lapsed');
    await kisiAdapter.enableAccess(API_KEY, 9);
    expect(bodyOf(0)).toEqual({ user: { access_enabled: false } });
    expect(bodyOf(1)).toEqual({ user: { access_enabled: true } });
    expect(warned('kisi.user.suspend_without_marker')).toHaveLength(0);
  });
});

describe('[P1] deleteUser Layer B reads metadata first, notes second', () => {
  const noRoles = [{ role_id: 'group_basic', scope: 'group' }];

  test('metadata-only marker for this client → DELETE fires', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID), notes: null })
      .mockResolvedValueOnce(noRoles)
      .mockResolvedValueOnce({});
    await kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID });
    expect(call(2)[1].method).toBe('DELETE');
  });

  test('legacy notes-only marker still passes during the transition', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, notes: notesFor(CLIENT_ID) })
      .mockResolvedValueOnce(noRoles)
      .mockResolvedValueOnce({});
    await kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID });
    expect(call(2)[1].method).toBe('DELETE');
  });

  test('the persisted kisi.user.deleted event says which record the guard trusted (DR-045 step 1)', async () => {
    const infoSpy = jest.spyOn(log, 'info');
    for (const [user, source] of [
      [{ id: 9, metadata: meta(CLIENT_ID) }, 'metadata'],
      [{ id: 9, notes: notesFor(CLIENT_ID) }, 'notes'],
    ]) {
      kisiConnector.makeRequest
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce(noRoles)
        .mockResolvedValueOnce({});
      await kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID });
      const deleted = infoSpy.mock.calls.filter(([e]) => e === 'kisi.user.deleted').pop();
      expect(deleted[1]).toMatchObject({ userId: 9, ownerClientId: CLIENT_ID, ownershipSource: source });
    }
    infoSpy.mockRestore();
  });

  test('metadata naming another client → CLIENT_MISMATCH, no DELETE', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(OTHER) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH', ownerClientId: OTHER });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('metadata and notes naming different clients → CLIENT_MISMATCH (markerConflict), no DELETE', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID), notes: notesFor(OTHER) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH', markerConflict: true });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('a conflict refuses even when the caller passes no clientId', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID), notes: notesFor(OTHER) });
    await expect(kisiAdapter.deleteUser(API_KEY, 9, {}))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH', markerConflict: true });
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
  test('metadata-only owner → PATCHes name only', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, metadata: meta(CLIENT_ID) })
      .mockResolvedValueOnce({});
    await kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID });
    expect(bodyOf(1)).toEqual({ user: { name: 'Ann Bee' } });
  });

  test('conflicting markers → refuses with CLIENT_MISMATCH, no PATCH', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: meta(OTHER), notes: notesFor(CLIENT_ID) });
    await expect(kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH', markerConflict: true });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('no marker → NOT_ACCESSSYNC_MANAGED, as before', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, metadata: {}, notes: '' });
    await expect(kisiAdapter.setUserName(API_KEY, 9, 'Ann Bee', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'NOT_ACCESSSYNC_MANAGED' });
  });
});

describe('[P1] ownership helpers', () => {
  test('readUserOwnership: metadata wins, notes falls back, conflict and none are explicit', () => {
    expect(kisiAdapter.readUserOwnership({ metadata: meta(CLIENT_ID) }))
      .toMatchObject({ clientId: CLIENT_ID, source: 'metadata' });
    expect(kisiAdapter.readUserOwnership({ notes: notesFor(CLIENT_ID) }))
      .toMatchObject({ clientId: CLIENT_ID, source: 'notes' });
    expect(kisiAdapter.readUserOwnership({ metadata: meta(CLIENT_ID), notes: notesFor(CLIENT_ID) }))
      .toMatchObject({ clientId: CLIENT_ID, source: 'metadata' });
    expect(kisiAdapter.readUserOwnership({ metadata: meta(CLIENT_ID), notes: notesFor(OTHER) }))
      .toEqual({ conflict: true, metadataClientId: CLIENT_ID, notesClientId: OTHER });
    expect(kisiAdapter.readUserOwnership({ metadata: {}, notes: 'VIP — comp access' })).toBeNull();
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
      .mockResolvedValueOnce({ id: 9, metadata: { city: 'Austin' }, notes: notesFor(CLIENT_ID) }) // GET
      .mockResolvedValueOnce(undefined)                                                          // PATCH (204)
      .mockResolvedValueOnce({ id: 9, metadata: { city: 'Austin', ...meta(CLIENT_ID) } });       // re-GET

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

describe('[P1] listAllUsers reports owner and marker source (reconcile progress count)', () => {
  test('metadata, notes, conflict and unowned users are labelled', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { id: 1, email: 'a@x', name: 'A', metadata: meta(CLIENT_ID) },
      { id: 2, email: 'b@x', name: 'B', notes: notesFor(CLIENT_ID) },
      { id: 3, email: 'c@x', name: 'C', metadata: meta(CLIENT_ID), notes: notesFor(OTHER) },
      { id: 4, email: 'd@x', name: 'D' },
    ]);
    const users = await kisiAdapter.listAllUsers(API_KEY);
    expect(users).toEqual([
      { id: 1, email: 'a@x', name: 'A', ownerClientId: CLIENT_ID, ownershipSource: 'metadata' },
      { id: 2, email: 'b@x', name: 'B', ownerClientId: CLIENT_ID, ownershipSource: 'notes' },
      { id: 3, email: 'c@x', name: 'C', ownerClientId: null, ownershipSource: 'conflict' },
      { id: 4, email: 'd@x', name: 'D', ownerClientId: null, ownershipSource: null },
    ]);
  });
});
