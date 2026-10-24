/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: DR-043 regression — kisi-adapter.createUser explicit flags   │
 * │                                                                         │
 * │  Business consequence: If send_emails ever reverts to hardcoded false,  │
 * │  invited-pattern members stop receiving the Kisi app email. The bug     │
 * │  is silent — access looks provisioned but members can't open doors.     │
 * │                                                                         │
 * │  What this tests: the Layer 6 adapter body — send_emails and confirm    │
 * │  are always emitted explicitly and follow the pattern logic exactly.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const kisiConnector = require('../../adapters/kisi/kisi-connector');
const kisiAdapter   = require('../../adapters/kisi/kisi-adapter');

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));

const API_KEY = 'test-kisi-key-p3';
const EMAIL   = 'member@test.com';
const NAME    = 'Test Member';
const KISI_USER_ID = 'kisi-user-p3-001';
const CLIENT_ID = 'test-client-p3';

beforeEach(() => {
  jest.clearAllMocks();
  kisiConnector.makeRequest.mockResolvedValue({ id: KISI_USER_ID });
});

describe('[P3] DR-043 kisi-adapter.createUser — send_emails and confirm flags', () => {

  it('sends send_emails: true and confirm: true for invited pattern', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'invited', clientId: CLIENT_ID });

    const [path, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    expect(path).toBe('/users');
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(true);
    expect(body.user.confirm).toBe(true);
  });

  it('sends send_emails: false and confirm: true for managed pattern', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'managed', clientId: CLIENT_ID });

    const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(false);
    expect(body.user.confirm).toBe(true);
  });

  it('defaults to invited (send_emails: true) when only clientId is provided', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { clientId: CLIENT_ID });

    const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(true);
    expect(body.user.confirm).toBe(true);
  });

  it('confirm is always true regardless of pattern — Kisi requires server-side confirmation', async () => {
    for (const pattern of ['invited', 'managed']) {
      kisiConnector.makeRequest.mockClear();
      await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: pattern, clientId: CLIENT_ID });
      const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
      const body = JSON.parse(reqOpts.body);
      expect(body.user.confirm).toBe(true);
    }
  });

  it('returns the Kisi user ID from the API response', async () => {
    const result = await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'invited', clientId: CLIENT_ID });
    expect(result).toBe(KISI_USER_ID);
  });

  it('writes the AccessSync ownership marker in metadata, and nothing in notes (DR-045 phase 2)', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { clientId: CLIENT_ID });
    const body = JSON.parse(kisiConnector.makeRequest.mock.calls[0][1].body);
    expect(kisiAdapter.parseOwnershipMetadata(body.user.metadata)).toMatchObject({ clientId: CLIENT_ID });
    expect(body.user).not.toHaveProperty('notes');
  });

  it('refuses to create without clientId (ownership marker would be missing)', async () => {
    await expect(
      kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'invited' })
    ).rejects.toThrow(/clientId.*ownership marker/i);
    expect(kisiConnector.makeRequest).not.toHaveBeenCalled();
  });

});

describe('[P3] kisi-adapter.createUser — member name reaches Kisi', () => {
  // Without a name Kisi shows the email in its Name column, so the gym can't
  // tell members apart at a glance.

  const bodyFor = async (name) => {
    await kisiAdapter.createUser(API_KEY, EMAIL, name, { clientId: CLIENT_ID });
    return JSON.parse(kisiConnector.makeRequest.mock.calls[0][1].body);
  };

  it('sends the member name', async () => {
    expect((await bodyFor(NAME)).user.name).toBe(NAME);
  });

  it('collapses stray whitespace (e.g. a missing last name)', async () => {
    expect((await bodyFor('  Jane   ')).user.name).toBe('Jane');
  });

  it('omits name when there is none, so Kisi keeps its default', async () => {
    for (const blank of [null, undefined, '', '   ', 'null']) {
      kisiConnector.makeRequest.mockClear();
      expect((await bodyFor(blank)).user).not.toHaveProperty('name');
    }
  });

  it('never sends the email as the name', async () => {
    expect((await bodyFor(EMAIL.toUpperCase())).user).not.toHaveProperty('name');
  });
});

describe('[P3] kisi-adapter.setUserName — rename only AccessSync-created users', () => {
  const MANAGED = { id: 999, metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID) };

  it('PATCHes name only — metadata, notes and access untouched', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce(MANAGED).mockResolvedValueOnce({});
    await kisiAdapter.setUserName(API_KEY, 999, 'Daxx Roberts', { clientId: CLIENT_ID });

    const [path, opts] = kisiConnector.makeRequest.mock.calls[1];
    expect(path).toBe('/users/999');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ user: { name: 'Daxx Roberts' } });
  });

  it('refuses a user with no AccessSync marker (the gym\'s own user)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 999, notes: '' });
    await expect(kisiAdapter.setUserName(API_KEY, 999, 'X Y', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'NOT_ACCESSSYNC_MANAGED' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  it('refuses a user marked for a different client', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 999, metadata: kisiAdapter.buildOwnershipMetadata('other') });
    await expect(kisiAdapter.setUserName(API_KEY, 999, 'X Y', { clientId: CLIENT_ID }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('[P3] kisi-adapter.deleteUser — two-layer ownership guard', () => {

  it('refuses to DELETE when the user carries no AccessSync marker', async () => {
    // GET returns a user with no marker (e.g. manually created Kisi user)
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 999, notes: '' });

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: 'UNOWNED_USER', userId: 999 });

    // Only the GET should have fired; DELETE must not have been issued.
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
    expect(kisiConnector.makeRequest.mock.calls[0][1].method).toBe('GET');
  });

  it('refuses to DELETE cross-tenant when marker clientId mismatches', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata('other-tenant'),
    });

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({
      code: 'CLIENT_MISMATCH',
      ownerClientId: 'other-tenant',
      requestingClientId: CLIENT_ID,
    });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  it('fires DELETE when marker is present, clientId matches, and no elevated roles attached', async () => {
    // GET /users/:id → user with marker
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    // GET /role_assignments → only group_basic, no elevated roles
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'group_basic', scope: 'group', applies_to: { name: 'Front Door' } },
    ]);
    // DELETE /users/:id → success
    kisiConnector.makeRequest.mockResolvedValueOnce({});

    await kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID });

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(3);
    expect(kisiConnector.makeRequest.mock.calls[0][1].method).toBe('GET');
    expect(kisiConnector.makeRequest.mock.calls[0][0]).toBe('/users/999');
    expect(kisiConnector.makeRequest.mock.calls[1][1].method).toBe('GET');
    expect(kisiConnector.makeRequest.mock.calls[1][0]).toMatch(/^\/role_assignments\?user_id=999/);
    expect(kisiConnector.makeRequest.mock.calls[2][1].method).toBe('DELETE');
  });

  it('treats 404 on GET as idempotent success (user already gone)', async () => {
    const err = new Error('not found');
    err.statusCode = 404;
    kisiConnector.makeRequest.mockRejectedValueOnce(err);

    await expect(kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })).resolves.toBeUndefined();
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  it('skips clientId mismatch check when options.clientId is not supplied', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata('some-tenant'),
    });
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'group_basic', scope: 'group' },
    ]);
    kisiConnector.makeRequest.mockResolvedValueOnce({});

    await kisiAdapter.deleteUser(API_KEY, 999);

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(3);
    expect(kisiConnector.makeRequest.mock.calls[2][1].method).toBe('DELETE');
  });

});

describe('[P3] kisi-adapter.deleteUser — Layer C elevated-role guard', () => {

  it('refuses to DELETE when user holds an organization-scoped role (admin)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'group_basic', scope: 'group', applies_to: { name: 'Front Door' } },
      { role_id: 'administrator', scope: 'organization', applies_to: { name: 'House of Gains' } },
    ]);

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({
      code: 'ELEVATED_ROLE_ATTACHED',
      userId: 999,
      elevatedAssignments: [
        { role_id: 'administrator', scope: 'organization', applies_to: 'House of Gains' },
      ],
    });

    // GET /users + GET /role_assignments fired; DELETE must NOT have fired.
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);
    const lastCall = kisiConnector.makeRequest.mock.calls[1];
    expect(lastCall[1].method).toBe('GET');
  });

  it('refuses to DELETE when user holds a place-scoped role (place_manager)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'place_manager', scope: 'place', applies_to: { name: 'HOG Roland' } },
    ]);

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({
      code: 'ELEVATED_ROLE_ATTACHED',
      elevatedAssignments: [
        { role_id: 'place_manager', scope: 'place', applies_to: 'HOG Roland' },
      ],
    });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);
  });

  it('refuses to DELETE when user holds the org owner role', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'owner', scope: 'organization', applies_to: { name: 'House of Gains' } },
    ]);

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({
      code: 'ELEVATED_ROLE_ATTACHED',
    });
  });

  it('refuses to DELETE on an unknown role_id (defensive — Kisi may add roles)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    // Hypothetical future Kisi role we don't know about
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'super_special_new_role', scope: 'group' },
    ]);

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: 'ELEVATED_ROLE_ATTACHED' });
  });

  it('falls back to applies_to_type when scope field is absent (defensive)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    // Some Kisi responses may not include scope field — use applies_to_type as fallback
    kisiConnector.makeRequest.mockResolvedValueOnce([
      { role_id: 'administrator', applies_to_type: 'Organization', applies_to: { name: 'X' } },
    ]);

    await expect(
      kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID })
    ).rejects.toMatchObject({ code: 'ELEVATED_ROLE_ATTACHED' });
  });

  it('proceeds to DELETE when user has zero role assignments (no elevated roles to find)', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 999,
      metadata: kisiAdapter.buildOwnershipMetadata(CLIENT_ID),
    });
    kisiConnector.makeRequest.mockResolvedValueOnce([]);
    kisiConnector.makeRequest.mockResolvedValueOnce({});

    await kisiAdapter.deleteUser(API_KEY, 999, { clientId: CLIENT_ID });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(3);
    expect(kisiConnector.makeRequest.mock.calls[2][1].method).toBe('DELETE');
  });

});

describe('[P3] kisi-adapter.findElevatedAssignments helper', () => {

  it('returns empty array for non-array input', () => {
    expect(kisiAdapter.findElevatedAssignments(null)).toEqual([]);
    expect(kisiAdapter.findElevatedAssignments(undefined)).toEqual([]);
    expect(kisiAdapter.findElevatedAssignments('not an array')).toEqual([]);
  });

  it('returns empty array when only group_basic roles present', () => {
    const result = kisiAdapter.findElevatedAssignments([
      { role_id: 'group_basic', scope: 'group' },
      { role_id: 'group_basic', scope: 'group' },
    ]);
    expect(result).toEqual([]);
  });

  it('flags org-scoped assignments regardless of role_id', () => {
    const elevated = { role_id: 'group_basic', scope: 'organization' };
    expect(kisiAdapter.findElevatedAssignments([elevated])).toEqual([elevated]);
  });

  it('flags role_ids outside the allowed member set', () => {
    const elevated = { role_id: 'manager', scope: 'group' };
    expect(kisiAdapter.findElevatedAssignments([elevated])).toEqual([elevated]);
  });

  it('returns only the elevated subset, not the whole list', () => {
    const member = { role_id: 'group_basic', scope: 'group' };
    const admin = { role_id: 'administrator', scope: 'organization' };
    const result = kisiAdapter.findElevatedAssignments([member, admin]);
    expect(result).toEqual([admin]);
  });

});

describe('[P3] kisi-adapter marker helpers', () => {

  it('buildAccessSyncMarker emits the canonical format', () => {
    const out = kisiAdapter.buildAccessSyncMarker('client-abc', 'reason text');
    expect(out).toMatch(/^\[AS\|managed\|client-abc\|[\d\-T:.Z]+\] reason text$/);
  });

  it('parseAccessSyncMarker round-trips a built marker', () => {
    const built = kisiAdapter.buildAccessSyncMarker('client-xyz', 'hello');
    const parsed = kisiAdapter.parseAccessSyncMarker(built);
    expect(parsed.clientId).toBe('client-xyz');
    expect(parsed.reason).toBe('hello');
  });

  it('parseAccessSyncMarker returns null for missing / malformed input', () => {
    expect(kisiAdapter.parseAccessSyncMarker(null)).toBeNull();
    expect(kisiAdapter.parseAccessSyncMarker('')).toBeNull();
    expect(kisiAdapter.parseAccessSyncMarker('random user note')).toBeNull();
    expect(kisiAdapter.parseAccessSyncMarker('[AS|wrong-prefix]')).toBeNull();
  });

});
