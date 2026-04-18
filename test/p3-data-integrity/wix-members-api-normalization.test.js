/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: wix-members-api.getMemberById normalizes synthetic emails    │
 * │                                                                         │
 * │  Business consequence: Wix issues placeholder <uuid>@users.wix.com      │
 * │  emails to social-login members. These addresses accept no mail. If     │
 * │  AccessSync treats them as real, Kisi creates a user with an            │
 * │  unreachable email and the Kisi onboarding invite goes nowhere — the    │
 * │  member pays and gets no access.                                        │
 * │                                                                         │
 * │  Contract: getMemberById normalises any @users.wix.com loginEmail to    │
 * │  null so Gate 2's recovery ladder treats the member as unqualified      │
 * │  and either finds a real email in the DB cache or parks as              │
 * │  pending_identity.                                                      │
 * │                                                                         │
 * │  Standards register: AccessSync/STANDARDS.md → Best Practices (synthetic │
 * │  email handling is a 2026-04-17 Builder decision).                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// Rate limiter would otherwise delay each test 100ms+. Mock it to a no-op so
// the normalization tests run instantly and don't consume the real window.
jest.mock('../../core/rate-limiter', () => ({
  RateLimiter: class {
    constructor() {}
    async acquire() {}
    currentCount() { return 0; }
  },
}));

const { getMemberById } = require('../../adapters/wix/wix-members-api');

function stubFetch(responseJson) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    json: async () => responseJson,
  }));
}

afterEach(() => {
  delete global.fetch;
});

describe('[P3] wix-members-api — synthetic email normalization', () => {

  test('rejects @users.wix.com loginEmail (lowercase)', async () => {
    stubFetch({
      member: {
        id: 'wix-member-abc',
        loginEmail: 'abc-uuid@users.wix.com',
        contact: { firstName: 'Alex', lastName: 'Example' },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-abc');
    expect(result.email).toBeNull();
    // Name is still preserved even when email is rejected.
    expect(result.name).toBe('Alex Example');
  });

  test('rejects @Users.Wix.Com loginEmail (mixed case — regex is case-insensitive)', async () => {
    stubFetch({
      member: {
        id: 'wix-member-abc',
        loginEmail: 'SomeUUID@Users.Wix.Com',
        contact: { firstName: 'Case', lastName: 'Insensitive' },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-abc');
    expect(result.email).toBeNull();
  });

  test('real email passes through unchanged', async () => {
    stubFetch({
      member: {
        id: 'wix-member-xyz',
        loginEmail: 'real@example.com',
        contact: { firstName: 'Real', lastName: 'User' },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-xyz');
    expect(result.email).toBe('real@example.com');
  });

  test('email that merely contains "wix.com" elsewhere passes through (not synthetic)', async () => {
    stubFetch({
      member: {
        id: 'wix-member-xyz',
        loginEmail: 'owner@mywixstore.com',
        contact: { firstName: 'Owner', lastName: 'Store' },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-xyz');
    // The regex is @users.wix.com$ specifically — random .com TLD is fine.
    expect(result.email).toBe('owner@mywixstore.com');
  });

  test('falls back to contact.emails[0] when loginEmail is missing', async () => {
    stubFetch({
      member: {
        id: 'wix-member-xyz',
        loginEmail: null,
        contact: {
          firstName: 'Contact', lastName: 'Fallback',
          emails: ['contact-fallback@example.com'],
        },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-xyz');
    expect(result.email).toBe('contact-fallback@example.com');
  });

  test('synthetic loginEmail + real contact email → picks the real one (not null)', async () => {
    // Regression guard. Prior ordering — `m.loginEmail || m.contact?.emails?.[0]`
    // — short-circuited on the truthy synthetic and then got null'd by the
    // _isSyntheticEmail check, dropping the real fallback entirely. Correct
    // behaviour: filter synthetics FIRST, then pick the first real candidate.
    stubFetch({
      member: {
        id: 'wix-member-social',
        loginEmail: 'social-uuid@users.wix.com',       // ← synthetic, ignored
        contact: {
          firstName: 'Social', lastName: 'Member',
          emails: ['real-member@example.com'],          // ← this should win
        },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-social');
    expect(result.email).toBe('real-member@example.com');
  });

  test('synthetic loginEmail AND only synthetic contact emails → returns null', async () => {
    // Edge case: even the contact array is full of Wix-internal placeholders.
    // Nothing deliverable exists — result.email must be null so Gate 2 parks.
    stubFetch({
      member: {
        id: 'wix-member-all-synthetic',
        loginEmail: 'primary@users.wix.com',
        contact: {
          firstName: 'All', lastName: 'Synthetic',
          emails: ['backup@users.wix.com'],
        },
        status: 'ACTIVE',
      },
    });
    const result = await getMemberById('api-key', 'site-id', 'wix-member-all-synthetic');
    expect(result.email).toBeNull();
  });
});
