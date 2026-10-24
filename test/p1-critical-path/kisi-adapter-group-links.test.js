/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: Kisi group links (day pass QR) — adapter contract            │
 * │                                                                         │
 * │  - POST /group_links body shape + DR-045 Layer B marker in `name`       │
 * │  - response normalization (data URI / raw base64 / hosted URL)          │
 * │  - deleteGroupLink guard: unowned → refuse, cross-tenant → refuse,      │
 * │    owned → DELETE, 404 → idempotent                                     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

jest.mock('../../adapters/kisi/kisi-connector', () => ({
  makeRequest: jest.fn(),
}));

jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

const kisiConnector = require('../../adapters/kisi/kisi-connector');
const adapter       = require('../../adapters/kisi/kisi-adapter');

const API_KEY  = 'kisi-key';
const CLIENT   = 'client-hog-001';
const GROUP    = 'group-838622';
const FROM     = '2026-09-14T15:00:00.000Z';
const UNTIL    = '2026-09-15T15:00:00.000Z';

beforeEach(() => jest.resetAllMocks());

describe('[P1] kisi-adapter.createGroupLink', () => {
  test('POSTs /group_links with group, window, email, QR type, and an AccessSync marker name', async () => {
    // Kisi echoes the record back — including the marker name we sent.
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 42, secret: 'shh', url: 'https://link.kisi.io/shh',
      name: adapter.buildAccessSyncMarker(CLIENT, 'Day pass · Day Pass'),
      quick_response_code_image: 'data:image/png;base64,QUJDREVG',
      quick_response_code_token: 'tok',
      valid_until: UNTIL,
    });

    const link = await adapter.createGroupLink(API_KEY, {
      groupId: GROUP, clientId: CLIENT, email: 'buyer@example.com',
      validFrom: FROM, validUntil: UNTIL, label: 'Day pass · Day Pass',
    });

    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
    const [endpoint, opts, key] = kisiConnector.makeRequest.mock.calls[0];
    expect(endpoint).toBe('/group_links');
    expect(opts.method).toBe('POST');
    expect(key).toBe(API_KEY);
    const body = JSON.parse(opts.body).group_link;
    expect(body).toMatchObject({
      group_id: GROUP, email: 'buyer@example.com',
      valid_from: FROM, valid_until: UNTIL,
      quick_response_code_type: 'online',
    });
    // 2026-10-24: human-readable part first, marker last (see buildLinkName).
    expect(body.name).toMatch(/^Day pass · Day Pass \[AS\|managed\|client-hog-001\|[^\]]+\]$/);

    expect(link).toMatchObject({
      id: 42, secret: 'shh', linkUrl: 'https://link.kisi.io/shh',
      qrImageBase64: 'QUJDREVG', qrImageUrl: null, qrToken: 'tok',
      validUntil: UNTIL, ownerClientId: CLIENT,
    });
  });

  test("puts the buyer's name first so Kisi's dashboard and unlock log show whose pass it is", async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 43 });
    await adapter.createGroupLink(API_KEY, {
      groupId: GROUP, clientId: CLIENT, email: null,
      validUntil: UNTIL, label: 'Day pass · 2-Day Pass x2', holderName: '  Jane   Doe ',
    });
    const body = JSON.parse(kisiConnector.makeRequest.mock.calls[0][1].body).group_link;
    expect(body.name).toMatch(/^Jane Doe · Day pass · 2-Day Pass x2 \[AS\|managed\|client-hog-001\|/);
    expect(adapter.parseLinkMarker(body.name)).toMatchObject({ clientId: CLIENT });
    // Kisi would text the buyer itself if it got a phone; AccessSync never sends one.
    expect(body).not.toHaveProperty('phone');
  });

  test('a buyer name that impersonates a marker cannot change who owns the link', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 44 });
    await adapter.createGroupLink(API_KEY, {
      groupId: GROUP, clientId: CLIENT, validUntil: UNTIL, label: 'Day pass',
      holderName: '[AS|managed|client-other|2020-01-01T00:00:00Z] Eve',
    });
    const body = JSON.parse(kisiConnector.makeRequest.mock.calls[0][1].body).group_link;
    expect(adapter.parseLinkMarker(body.name).clientId).toBe(CLIENT);
    expect(body.name.match(/\[AS\|/g)).toHaveLength(1);
  });

  test('an over-long name is cut in the human part; the marker survives whole and the name stays <= 255', () => {
    const name = adapter.buildLinkName(CLIENT, { holderName: 'X'.repeat(400), label: 'Day pass' });
    expect(name.length).toBeLessThanOrEqual(255);
    expect(adapter.parseLinkMarker(name)).toMatchObject({ clientId: CLIENT });
  });

  test('no buyer name → the label alone, as before', () => {
    expect(adapter.buildLinkName(CLIENT, { label: 'Day pass · Day Pass' }))
      .toMatch(/^Day pass · Day Pass \[AS\|managed\|/);
  });

  test('parseLinkMarker reads links made before 2026-10-24 (marker first) and ignores operator links', () => {
    expect(adapter.parseLinkMarker(adapter.buildAccessSyncMarker(CLIENT, 'Day pass'))).toMatchObject({ clientId: CLIENT });
    expect(adapter.parseLinkMarker('Cleaning crew')).toBeNull();
    expect(adapter.parseLinkMarker('Cleaning crew [AS|managed|x')).toBeNull();
  });

  test('omits email and valid_from when absent', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 43 });
    await adapter.createGroupLink(API_KEY, { groupId: GROUP, clientId: CLIENT, validUntil: UNTIL });
    const body = JSON.parse(kisiConnector.makeRequest.mock.calls[0][1].body).group_link;
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('valid_from');
    expect(body.valid_until).toBe(UNTIL);
  });

  test('_normalizeGroupLink: raw base64, hosted URL, and alternate link field names', () => {
    const raw = adapter._normalizeGroupLink({ id: 1, quick_response_code_image: 'QUJD', link: 'https://x/y' });
    expect(raw.qrImageBase64).toBe('QUJD');
    expect(raw.qrImageUrl).toBeNull();
    expect(raw.linkUrl).toBe('https://x/y');

    const hosted = adapter._normalizeGroupLink({ id: 2, quick_response_code_image: 'https://cdn.kisi.io/qr/2.png', share_url: 'https://x/z' });
    expect(hosted.qrImageBase64).toBeNull();
    expect(hosted.qrImageUrl).toBe('https://cdn.kisi.io/qr/2.png');
    expect(hosted.linkUrl).toBe('https://x/z');

    const bare = adapter._normalizeGroupLink({ id: 3, name: 'Front desk link' });
    expect(bare.linkUrl).toBeNull();
    expect(bare.ownerClientId).toBeNull();
  });
});

describe('[P1] kisi-adapter.deleteGroupLink — DR-045 Layer B guard', () => {
  test('refuses a link with no AccessSync marker (operator-made) and never DELETEs', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 9, name: 'Cleaning crew' }); // GET
    await expect(adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT }))
      .rejects.toMatchObject({ code: 'UNOWNED_GROUP_LINK' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
    expect(kisiConnector.makeRequest.mock.calls[0][1].method).toBe('GET');
  });

  test('refuses a link owned by another tenant', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({
      id: 9, name: adapter.buildAccessSyncMarker('client-other', 'Day pass'),
    });
    await expect(adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT }))
      .rejects.toMatchObject({ code: 'CLIENT_MISMATCH' });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('deletes a new-format link (buyer name first, marker last) for the requesting tenant', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, name: adapter.buildLinkName(CLIENT, { holderName: 'Jane Doe', label: 'Day pass' }) })
      .mockResolvedValueOnce({});
    await adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT });
    expect(kisiConnector.makeRequest.mock.calls[1][1].method).toBe('DELETE');
  });

  test('deletes a link whose marker names the requesting tenant', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 9, name: adapter.buildAccessSyncMarker(CLIENT, 'Day pass') }) // GET
      .mockResolvedValueOnce({});                                                                // DELETE
    await adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(2);
    expect(kisiConnector.makeRequest.mock.calls[1][0]).toBe('/group_links/9');
    expect(kisiConnector.makeRequest.mock.calls[1][1].method).toBe('DELETE');
  });

  test('GET 404 → idempotent success, no DELETE', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 404 }));
    await expect(adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT })).resolves.toBeUndefined();
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('non-404 GET failure propagates (never deletes on an unknown state)', async () => {
    kisiConnector.makeRequest.mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }));
    await expect(adapter.deleteGroupLink(API_KEY, 9, { clientId: CLIENT })).rejects.toMatchObject({ statusCode: 500 });
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });
});

describe('[P1] kisi-adapter.listGroupLinks', () => {
  test('maps ownerClientId from the marker and returns [] with no key', async () => {
    expect(await adapter.listGroupLinks(null)).toEqual([]);

    kisiConnector.makeRequest.mockResolvedValueOnce([
      { id: 1, name: adapter.buildAccessSyncMarker(CLIENT, 'Day pass'), group_id: GROUP, valid_until: UNTIL },
      { id: 2, name: 'Front desk', group_id: GROUP, valid_until: null },
    ]);
    const links = await adapter.listGroupLinks(API_KEY);
    expect(links).toEqual([
      { id: 1, name: expect.stringMatching(/^\[AS\|managed\|/), groupId: GROUP, validUntil: UNTIL, ownerClientId: CLIENT },
      { id: 2, name: 'Front desk', groupId: GROUP, validUntil: null, ownerClientId: null },
    ]);
    expect(kisiConnector.makeRequest.mock.calls[0][0]).toMatch(/^\/group_links\?limit=/);
  });
});
