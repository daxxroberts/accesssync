/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: a Wix list that is silently SHORT must throw, never return   │
 * │                                                                         │
 * │  Business consequence: the nightly sweep reads "member missing from     │
 * │  the Wix list" as "member stopped paying". Before this change the       │
 * │  order walk did `data.orders || []` — a `{}` body from Wix was read as  │
 * │  "this site has zero orders", and the bookings walk stopped on the      │
 * │  first page that lacked a cursor even when the page was full. Either    │
 * │  one hands the sweep a partial list that looks like a mass lapse.       │
 * │                                                                         │
 * │  Now every walk throws a WIX_PAGE_INTEGRITY error on: a body without    │
 * │  the list array, a duplicate id (offset drift), a full bookings page    │
 * │  with no next cursor, or more than 200 pages. reconciliation already   │
 * │  fails closed on a throw (aborts the client's sync).                    │
 * │                                                                         │
 * │  No network: global.fetch is mocked. No DB. Rate limiter is stubbed so  │
 * │  the 200-page cap tests don't wait on the real 10 req/sec bucket.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../core/logger', () => ({
  log: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));
jest.mock('../../core/rate-limiter', () => ({
  RateLimiter: jest.fn().mockImplementation(() => ({ acquire: jest.fn().mockResolvedValue(undefined) })),
}));

const { log } = require('../../core/logger');
const wixPlansApi = require('../../adapters/wix/wix-plans-api');
const { listActiveOrders, listOrdersClassified, listConfirmedBookings } = wixPlansApi;

const API_KEY = 'test-wix-key';
const SITE_ID = 'site-1';

function okResponse(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function errResponse(status, text = 'nope') {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

function order(id, overrides = {}) {
  return {
    id,
    status: 'ACTIVE',
    lastPaymentStatus: 'PAID',
    planId: 'plan-1',
    buyer: { memberId: `member-${id}`, contactId: `contact-${id}` },
    ...overrides,
  };
}
function fullOrdersPage(startIndex, size = 50) {
  return { orders: Array.from({ length: size }, (_, i) => order(`o${startIndex + i}`)) };
}
function booking(id, overrides = {}) {
  return {
    booking: {
      id,
      status: 'CONFIRMED',
      contactId: `contact-${id}`,
      bookedEntity: { serviceId: 'svc-1' },
      contactDetails: { email: `${id}@example.com`, firstName: 'First', lastName: 'Last' },
      ...overrides,
    },
  };
}
function fullBookingsPage(startIndex, size, next) {
  return {
    extendedBookings: Array.from({ length: size }, (_, i) => booking(`b${startIndex + i}`)),
    pagingMetadata: { cursors: next ? { next } : {} },
  };
}

beforeEach(() => {
  global.fetch = jest.fn();
});
afterAll(() => {
  delete global.fetch;
});

// ─── Orders: listActiveOrders + listOrdersClassified (shared _fetchAllOrders) ───

describe('[P3] Wix orders walk — integrity failures throw WIX_PAGE_INTEGRITY', () => {
  test.each([
    ['listActiveOrders', listActiveOrders],
    ['listOrdersClassified', listOrdersClassified],
  ])('%s: a {} page throws — it is NOT "zero orders"', async (_name, fn) => {
    global.fetch.mockResolvedValueOnce(okResponse({}));
    await expect(fn(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('orders: null throws', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: null }));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('orders as a non-array object throws', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: { 0: order('o0') } }));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a null JSON body throws', async () => {
    global.fetch.mockResolvedValueOnce(okResponse(null));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a {} on the SECOND page throws — a partial list is never returned', async () => {
    global.fetch
      .mockResolvedValueOnce(okResponse(fullOrdersPage(0)))
      .mockResolvedValueOnce(okResponse({}));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('a null entry inside the orders array throws WIX_PAGE_INTEGRITY', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: [order('o0'), null] }));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('duplicate order id across pages (offset drift) throws', async () => {
    const page2 = { orders: [order('o49'), order('o50')] }; // o49 already seen on page 1
    global.fetch
      .mockResolvedValueOnce(okResponse(fullOrdersPage(0)))
      .mockResolvedValueOnce(okResponse(page2));
    await expect(listOrdersClassified(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('duplicate detection also keys on _id when id is absent', async () => {
    const page1 = { orders: Array.from({ length: 50 }, (_, i) => ({ ...order(null), id: undefined, _id: `x${i}` })) };
    const page2 = { orders: [{ ...order(null), id: undefined, _id: 'x0' }] };
    global.fetch
      .mockResolvedValueOnce(okResponse(page1))
      .mockResolvedValueOnce(okResponse(page2));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('more than 200 pages throws after exactly 200 fetches', async () => {
    let n = 0;
    global.fetch.mockImplementation(async () => okResponse(fullOrdersPage((n++) * 50)));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
    expect(global.fetch).toHaveBeenCalledTimes(200);
  });

  test('exactly 200 pages (last one short) is accepted — the cap is > 200, not >= 200', async () => {
    let n = 0;
    global.fetch.mockImplementation(async () => {
      const page = n++;
      return okResponse(page < 199 ? fullOrdersPage(page * 50) : { orders: [order('last')] });
    });
    const result = await listActiveOrders(API_KEY, SITE_ID);
    expect(global.fetch).toHaveBeenCalledTimes(200);
    expect(result).toHaveLength(199 * 50 + 1);
  });

  test('integrity failure is logged as the existing fetch_failed error carrying the code', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({}));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      'wix.active_orders.fetch_failed',
      expect.objectContaining({ siteId: SITE_ID }),
      expect.objectContaining({ code: 'WIX_PAGE_INTEGRITY' })
    );
  });

  test('HTTP errors still throw with the mapped code (unchanged)', async () => {
    global.fetch.mockResolvedValueOnce(errResponse(401));
    await expect(listActiveOrders(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_KEY_INVALID', statusCode: 401 });
    global.fetch.mockResolvedValueOnce(errResponse(503));
    await expect(listOrdersClassified(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_API_ERROR', statusCode: 503 });
  });
});

describe('[P3] listActiveOrders — contract unchanged (ACTIVE-only, same shape)', () => {
  test('keeps every ACTIVE order regardless of payment status, drops the rest, pages by offset', async () => {
    const page1 = fullOrdersPage(0); // 50 ACTIVE/PAID
    const page2 = {
      orders: [
        order('unpaid', { lastPaymentStatus: 'UNPAID' }),  // ACTIVE → still returned (filter unchanged)
        order('ended',  { status: 'ENDED' }),
        order('paused', { status: 'PAUSED' }),
        order('nobuyer', { buyer: {} }),                   // ACTIVE, no member → still returned with null memberId
      ],
    };
    global.fetch
      .mockResolvedValueOnce(okResponse(page1))
      .mockResolvedValueOnce(okResponse(page2));

    const result = await listActiveOrders(API_KEY, SITE_ID);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toBe('https://www.wixapis.com/pricing-plans/v2/orders?limit=50&offset=0');
    expect(global.fetch.mock.calls[1][0]).toBe('https://www.wixapis.com/pricing-plans/v2/orders?limit=50&offset=50');

    expect(result).toHaveLength(52);
    const unpaid = result.find(r => r.rawOrder.id === 'unpaid');
    expect(unpaid).toEqual({
      memberId: 'member-unpaid', planId: 'plan-1', email: null, name: null, rawOrder: page2.orders[0],
    });
    expect(result.find(r => r.rawOrder.id === 'ended')).toBeUndefined();
    expect(result.find(r => r.rawOrder.id === 'paused')).toBeUndefined();
    expect(result.find(r => r.rawOrder.id === 'nobuyer').memberId).toBeNull();
    expect(Object.keys(result[0]).sort()).toEqual(['email', 'memberId', 'name', 'planId', 'rawOrder']);
  });

  test('falls back to buyer.contactId when memberId is absent', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: [order('c', { buyer: { contactId: 'contact-only' } })] }));
    const [row] = await listActiveOrders(API_KEY, SITE_ID);
    expect(row.memberId).toBe('contact-only');
  });

  test('{ orders: [] } is a legitimate empty site', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: [] }));
    await expect(listActiveOrders(API_KEY, SITE_ID)).resolves.toEqual([]);
  });
});

describe('[P3] listOrdersClassified — every order, classified', () => {
  test('returns all statuses with the pinned shape and classification', async () => {
    const raw = [
      order('paid'),
      order('unpaid',   { lastPaymentStatus: 'UNPAID' }),
      order('failed',   { lastPaymentStatus: 'FAILED' }),
      order('paused',   { status: 'PAUSED' }),
      order('ended',    { status: 'ENDED', endDate: '2026-09-01T00:00:00.000Z', autoRenewCanceled: true }),
      order('draft',    { status: 'DRAFT', lastPaymentStatus: 'UNPAID' }),
      order('na',       { lastPaymentStatus: 'NOT_APPLICABLE' }),
    ];
    global.fetch.mockResolvedValueOnce(okResponse({ orders: raw }));

    const result = await listOrdersClassified(API_KEY, SITE_ID);

    expect(result).toHaveLength(7);
    const byId = Object.fromEntries(result.map(r => [r.orderId, r]));
    expect(byId.paid.classification).toBe('PAYING');
    expect(byId.unpaid.classification).toBe('PENDING');
    expect(byId.failed.classification).toBe('DECLINED');
    expect(byId.paused.classification).toBe('DECLINED');
    expect(byId.ended.classification).toBe('ENDED');
    expect(byId.draft.classification).toBe('PENDING');
    expect(byId.na.classification).toBe('UNKNOWN');

    expect(byId.ended).toEqual({
      orderId: 'ended',
      memberId: 'member-ended',
      planId: 'plan-1',
      classification: 'ENDED',
      status: 'ENDED',
      lastPaymentStatus: 'PAID',
      autoRenewCanceled: true,
      endDate: '2026-09-01T00:00:00.000Z',
      rawOrder: raw[4],
    });
    expect(byId.paid.autoRenewCanceled).toBeNull(); // absent → null, not false
    expect(byId.paid.endDate).toBeNull();
  });

  test('orderId falls back to _id', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: [{ ...order(null), id: undefined, _id: 'legacy-id' }] }));
    const [row] = await listOrdersClassified(API_KEY, SITE_ID);
    expect(row.orderId).toBe('legacy-id');
  });

  test('orders with no memberId/contactId are skipped and counted in ONE warn per call', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({
      orders: [order('a'), order('b', { buyer: {} }), order('c', { buyer: undefined }), order('d')],
    }));
    const result = await listOrdersClassified(API_KEY, SITE_ID);

    expect(result.map(r => r.orderId)).toEqual(['a', 'd']);
    const warns = log.warn.mock.calls.filter(c => c[0] === 'wix.orders.no_member_id');
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toEqual({ siteId: SITE_ID, count: 2 });
  });

  test('no warn when every order has a member', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ orders: [order('a')] }));
    await listOrdersClassified(API_KEY, SITE_ID);
    expect(log.warn.mock.calls.filter(c => c[0] === 'wix.orders.no_member_id')).toHaveLength(0);
  });
});

// ─── Bookings: listConfirmedBookings ───────────────────────────────────────────

describe('[P3] Wix bookings walk — integrity failures throw WIX_PAGE_INTEGRITY', () => {
  test('a {} body (no extendedBookings, no bookings) throws', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({}));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('non-array extendedBookings with no bookings array throws', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ extendedBookings: {} }));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a FULL page (== limit) with no next cursor throws — the walk was truncated', async () => {
    global.fetch.mockResolvedValueOnce(okResponse(fullBookingsPage(0, 100, null)));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a FULL page with no cursor AND hasNext:true throws', async () => {
    const page = fullBookingsPage(0, 100, null);
    page.pagingMetadata.hasNext = true;
    global.fetch.mockResolvedValueOnce(okResponse(page));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a FULL last page with an explicit hasNext:false is a legitimate end (exact multiple of 100)', async () => {
    const page = fullBookingsPage(0, 100, null);
    page.pagingMetadata.hasNext = false;
    global.fetch.mockResolvedValueOnce(okResponse(page));
    const result = await listConfirmedBookings(API_KEY, SITE_ID);
    expect(result).toHaveLength(100);
  });

  test('duplicate booking id across pages throws', async () => {
    const page2 = { extendedBookings: [booking('b99'), booking('b100')], pagingMetadata: { cursors: {} } };
    global.fetch
      .mockResolvedValueOnce(okResponse(fullBookingsPage(0, 100, 'cur-2')))
      .mockResolvedValueOnce(okResponse(page2));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('duplicates are caught even among non-CONFIRMED bookings', async () => {
    const page = {
      extendedBookings: [booking('dup', { status: 'CANCELED' }), booking('dup', { status: 'CANCELED' })],
      pagingMetadata: { cursors: {} },
    };
    global.fetch.mockResolvedValueOnce(okResponse(page));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('a null entry inside the bookings array throws WIX_PAGE_INTEGRITY', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ extendedBookings: [null], pagingMetadata: {} }));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
  });

  test('more than 200 pages throws after exactly 200 fetches', async () => {
    let n = 0;
    global.fetch.mockImplementation(async () => {
      const page = n++;
      return okResponse(fullBookingsPage(page * 100, 100, `cur-${page + 1}`));
    });
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_PAGE_INTEGRITY' });
    expect(global.fetch).toHaveBeenCalledTimes(200);
  });

  test('integrity failure is logged as the existing fetch_failed error carrying the code', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({}));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toThrow();
    expect(log.error).toHaveBeenCalledWith(
      'wix.confirmed_bookings.fetch_failed',
      expect.objectContaining({ siteId: SITE_ID }),
      expect.objectContaining({ code: 'WIX_PAGE_INTEGRITY' })
    );
  });

  test('HTTP errors still throw with the mapped code (unchanged)', async () => {
    global.fetch.mockResolvedValueOnce(errResponse(403));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).rejects.toMatchObject({ code: 'WIX_KEY_PERMISSIONS', statusCode: 403 });
  });
});

describe('[P3] listConfirmedBookings — contract unchanged', () => {
  test('walks cursors, keeps CONFIRMED (and status-less) bookings, same shape', async () => {
    const page1 = fullBookingsPage(0, 100, 'cur-2');
    const page2 = {
      extendedBookings: [
        booking('cancelled', { status: 'CANCELED' }),
        booking('nostatus',  { status: undefined }),
        booking('confirmed'),
      ],
      pagingMetadata: { cursors: {} },
    };
    global.fetch
      .mockResolvedValueOnce(okResponse(page1))
      .mockResolvedValueOnce(okResponse(page2));

    const result = await listConfirmedBookings(API_KEY, SITE_ID);

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ query: { cursorPaging: { limit: 100 } } });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ query: { cursorPaging: { limit: 100, cursor: 'cur-2' } } });

    expect(result).toHaveLength(102);
    expect(result.find(r => r.memberId === 'contact-cancelled')).toBeUndefined();
    expect(result.find(r => r.memberId === 'contact-confirmed')).toEqual({
      memberId: 'contact-confirmed', planId: 'svc-1', email: 'confirmed@example.com', name: 'First Last',
    });
    expect(result.find(r => r.memberId === 'contact-nostatus')).toBeDefined();
  });

  test('legacy `bookings` key is still accepted', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ bookings: [{ id: 'flat-1', status: 'CONFIRMED', contactId: 'c-1', serviceId: 's-1' }] }));
    const result = await listConfirmedBookings(API_KEY, SITE_ID);
    expect(result).toEqual([{ memberId: 'c-1', planId: 's-1', email: null, name: null }]);
  });

  test('{ extendedBookings: [] } is a legitimate empty site', async () => {
    global.fetch.mockResolvedValueOnce(okResponse({ extendedBookings: [] }));
    await expect(listConfirmedBookings(API_KEY, SITE_ID)).resolves.toEqual([]);
  });
});

describe('[P3] wix-plans-api exports', () => {
  test('listOrdersClassified is exported alongside the existing exports', () => {
    expect(Object.keys(wixPlansApi).sort()).toEqual([
      'listActiveOrders', 'listAllMappable', 'listBookingServices', 'listConfirmedBookings',
      'listOrdersClassified', 'listPricingPlans', 'testApiKey',
    ]);
  });
});
