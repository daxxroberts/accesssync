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

beforeEach(() => {
  jest.clearAllMocks();
  kisiConnector.makeRequest.mockResolvedValue({ id: KISI_USER_ID });
});

describe('[P3] DR-043 kisi-adapter.createUser — send_emails and confirm flags', () => {

  it('sends send_emails: true and confirm: true for invited pattern', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'invited' });

    const [path, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    expect(path).toBe('/users');
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(true);
    expect(body.user.confirm).toBe(true);
  });

  it('sends send_emails: false and confirm: true for managed pattern', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'managed' });

    const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(false);
    expect(body.user.confirm).toBe(true);
  });

  it('defaults to invited (send_emails: true) when no options provided', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME);

    const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(true);
    expect(body.user.confirm).toBe(true);
  });

  it('defaults to invited (send_emails: true) when options object provided but userPattern is missing', async () => {
    await kisiAdapter.createUser(API_KEY, EMAIL, NAME, {});

    const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
    const body = JSON.parse(reqOpts.body);
    expect(body.user.send_emails).toBe(true);
  });

  it('confirm is always true regardless of pattern — Kisi requires server-side confirmation', async () => {
    for (const pattern of ['invited', 'managed', undefined]) {
      kisiConnector.makeRequest.mockClear();
      await kisiAdapter.createUser(API_KEY, EMAIL, NAME, pattern ? { userPattern: pattern } : undefined);
      const [, reqOpts] = kisiConnector.makeRequest.mock.calls[0];
      const body = JSON.parse(reqOpts.body);
      expect(body.user.confirm).toBe(true);
    }
  });

  it('returns the Kisi user ID from the API response', async () => {
    const result = await kisiAdapter.createUser(API_KEY, EMAIL, NAME, { userPattern: 'invited' });
    expect(result).toBe(KISI_USER_ID);
  });

});
