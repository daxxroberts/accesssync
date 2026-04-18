/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: wix-members-api.getMemberById resolves full identity         │
 * │                                                                         │
 * │  Business consequence: OB-89 Gate 2 depends on this function returning  │
 * │  real email + name. If it drops fields, members get parked as           │
 * │  pending_identity even when Wix has their data.                         │
 * │                                                                         │
 * │  Wix data model (verified against HOG prod 2026-04-18): Members API     │
 * │  returns an identity stub with contactId pointer. The deliverable       │
 * │  fields (email, phone, name) live on the Contacts record. Two API       │
 * │  calls required.                                                         │
 * │                                                                         │
 * │  Also enforces: @users.wix.com synthetic addresses are rejected so      │
 * │  Kisi onboarding invites don't go to unreachable Wix-internal inboxes.  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// Rate limiter would delay each test 100ms+. Mock to a no-op for speed.
jest.mock('../../core/rate-limiter', () => ({
  RateLimiter: class {
    constructor() {}
    async acquire() {}
    currentCount() { return 0; }
  },
}));

const { getMemberById } = require('../../adapters/wix/wix-members-api');

/**
 * Stub global.fetch to route by URL pattern:
 *   /members/v1/members/{id}  → memberResponse
 *   /contacts/v4/contacts/{id} → contactResponse (or null for 404)
 * Pass contactResponse = 404 to simulate a missing contact record.
 */
function stubFetchPair(memberResponse, contactResponse) {
  global.fetch = jest.fn(async (url) => {
    if (url.includes('/members/v1/members/')) {
      return {
        ok: memberResponse !== 404,
        status: memberResponse === 404 ? 404 : 200,
        json: async () => memberResponse,
        text: async () => '',
      };
    }
    if (url.includes('/contacts/v4/contacts/')) {
      if (contactResponse === 404) {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => contactResponse,
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch URL in test: ${url}`);
  });
}

afterEach(() => {
  delete global.fetch;
  jest.clearAllMocks();
});

describe('[P3] wix-members-api — Members → Contacts two-call pattern', () => {

  test('resolves full identity from Contacts API when Members returns only a stub', async () => {
    // Real shape observed in HOG production 2026-04-18 for a Google OAuth member.
    stubFetchPair(
      { member: { id: 'm1', status: 'UNKNOWN', contactId: 'c1', profile: { nickname: 'Daxx Roberts' } } },
      { contact: {
        id: 'c1',
        primaryInfo: { email: 'daxxroberts@gmail.com', phone: '4796512096' },
        info: {
          name: { first: 'Daxx', last: 'Roberts' },
          emails: { items: [{ tag: 'UNTAGGED', email: 'daxxroberts@gmail.com', primary: true }] },
        },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm1');
    expect(r.email).toBe('daxxroberts@gmail.com');
    expect(r.firstName).toBe('Daxx');
    expect(r.lastName).toBe('Roberts');
    expect(r.name).toBe('Daxx Roberts');
    expect(r.phone).toBe('4796512096');
    expect(r.contactId).toBe('c1');
  });

  test('falls back to Members profile nickname when Contacts has no name fields', async () => {
    stubFetchPair(
      { member: { id: 'm2', status: 'ACTIVE', contactId: 'c2', profile: { nickname: 'Jane Smith' } } },
      { contact: { id: 'c2', primaryInfo: { email: 'jane@example.com' }, info: {} } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm2');
    expect(r.email).toBe('jane@example.com');
    expect(r.firstName).toBe('Jane');
    expect(r.lastName).toBe('Smith');
    expect(r.name).toBe('Jane Smith');
  });

  test('returns partial result when Contacts API 404s (contact deleted or never created)', async () => {
    stubFetchPair(
      { member: { id: 'm3', status: 'ACTIVE', contactId: 'c3', profile: { nickname: 'Solo Member' } } },
      404
    );
    const r = await getMemberById('api-key', 'site-id', 'm3');
    // Email unresolved but name falls back to nickname; memberId + status preserved.
    expect(r.email).toBeNull();
    expect(r.name).toBe('Solo Member');
    expect(r.contactId).toBe('c3');
  });

  test('returns partial result when Members API has no contactId pointer at all', async () => {
    stubFetchPair(
      { member: { id: 'm4', status: 'ACTIVE', profile: { nickname: 'No Contact' } } },
      null // never called
    );
    const r = await getMemberById('api-key', 'site-id', 'm4');
    expect(r.email).toBeNull();
    expect(r.contactId).toBeNull();
    expect(r.name).toBe('No Contact');
  });
});

describe('[P3] wix-members-api — synthetic email rejection', () => {

  test('rejects @users.wix.com primary email, falls through to info.emails[]', async () => {
    stubFetchPair(
      { member: { id: 'm5', status: 'ACTIVE', contactId: 'c5' } },
      { contact: {
        id: 'c5',
        primaryInfo: { email: 'uuid@users.wix.com' },
        info: {
          name: { first: 'Real', last: 'Fallback' },
          emails: {
            items: [
              { email: 'uuid@users.wix.com', primary: true },
              { email: 'real@example.com', primary: false },
            ],
          },
        },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm5');
    expect(r.email).toBe('real@example.com');
  });

  test('rejects mixed-case @Users.Wix.Com (regex is case-insensitive)', async () => {
    stubFetchPair(
      { member: { id: 'm6', status: 'ACTIVE', contactId: 'c6' } },
      { contact: {
        id: 'c6',
        primaryInfo: { email: 'SomeUUID@Users.Wix.Com' },
        info: { name: { first: 'Case', last: 'Test' } },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm6');
    expect(r.email).toBeNull();
  });

  test('real email passes through unchanged', async () => {
    stubFetchPair(
      { member: { id: 'm7', status: 'ACTIVE', contactId: 'c7' } },
      { contact: {
        id: 'c7',
        primaryInfo: { email: 'real@example.com' },
        info: { name: { first: 'Real', last: 'User' } },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm7');
    expect(r.email).toBe('real@example.com');
  });

  test('non-synthetic domain that merely contains "wix" passes through', async () => {
    // The regex is @users.wix.com$ specifically — not any *.wix.* domain.
    stubFetchPair(
      { member: { id: 'm8', status: 'ACTIVE', contactId: 'c8' } },
      { contact: {
        id: 'c8',
        primaryInfo: { email: 'owner@mywixstore.com' },
        info: { name: { first: 'Owner', last: 'Store' } },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm8');
    expect(r.email).toBe('owner@mywixstore.com');
  });

  test('all candidates synthetic → returns null email', async () => {
    stubFetchPair(
      { member: { id: 'm9', status: 'ACTIVE', contactId: 'c9' } },
      { contact: {
        id: 'c9',
        primaryInfo: { email: 'primary@users.wix.com' },
        info: {
          emails: { items: [{ email: 'backup@users.wix.com', primary: false }] },
        },
      } }
    );
    const r = await getMemberById('api-key', 'site-id', 'm9');
    expect(r.email).toBeNull();
  });
});
