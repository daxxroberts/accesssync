/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: the Owner Hub's one question — "is AccessSync working for    │
 * │  every gym, and is there anything only I can fix?"                      │
 * │                                                                         │
 * │  Covers core/owner-health.js through GET /admin/system-health:          │
 * │    - verdict + verdict_line + summary + problems[] + platform[] +       │
 * │      healthy[] + clients[]                                              │
 * │    - every reason a gym can show up (proposal §2.2) and who acts        │
 * │    - sync freshness from the last SUCCESSFUL run (bug 1)                │
 * │    - stuck members count as "can't get in" (bug 5)                      │
 * │    - platform rows only when something is wrong (bug 6)                 │
 * │    - a failed query is one banner, never a red gym                      │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));

const db = require('../../db');
const router = require('../../admin/routes/system-health');
const { verdictLine } = require('../../core/owner-health');

const app = express();
app.use('/admin/system-health', router);
const get = () => request(app).get('/admin/system-health');
const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();

/**
 * Query order in core/owner-health.js (Promise.all over 8 queries):
 *   1 SELECT 1 · 2 clients (+connector) · 3 runs · 4 webhooks · 5 open errors · 6 stuck · 7 setup · 8 platform errors
 */
const HOG = { id: 'c1', name: 'House of Gains', status: 'active', created_at: H(24 * 190), last_webhook_at: H(1),
  key_last_verified: H(2), key_last_error: null, key_first_failed_at: null, has_hardware_key: true, has_wix_key: true };
const HOG_SETUP = { client_id: 'c1', location_count: 1, plans: 3, plans_with_door: 3, first_door_at: H(24 * 180), has_members: true };
const NEW = { id: 'c2', name: '918 Fitness', status: 'active', created_at: H(5), last_webhook_at: null,
  key_last_verified: null, key_last_error: null, key_first_failed_at: null, has_hardware_key: false, has_wix_key: false };
const NEW_SETUP = { client_id: 'c2', location_count: 0, plans: 0, plans_with_door: 0, first_door_at: null, has_members: false };

function mockWorld({
  clients = [HOG],
  runs = [{ client_id: 'c1', last_success_at: H(1), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(1) }],
  webhooks = [{ client_id: 'c1', first_received_at: H(24 * 180), last_received_at: H(1), count_24h: 9 }],
  errors = [],
  stuck = [],
  setup = [HOG_SETUP],
  platformErrors = 0,
  fail = [],
} = {}) {
  const results = [
    { rows: [{ '?column?': 1 }] }, { rows: clients }, { rows: runs }, { rows: webhooks },
    { rows: errors }, { rows: stuck }, { rows: setup }, { rows: [{ n: platformErrors }] },
  ];
  results.forEach((r, i) => (fail.includes(i + 1) ? db.query.mockRejectedValueOnce(new Error('query ' + (i + 1) + ' failed')) : db.query.mockResolvedValueOnce(r)));
}
const openErr = (over = {}) => ({ client_id: 'c1', error_code: 'HARDWARE_VALIDATION_ERROR', resolution: 'RETRY', http_status: 422, occurred_count: 1, created_at: H(5), ...over });
const gymErr = (over = {}) => openErr({ error_code: 'PLAN_NOT_MAPPED', resolution: 'REMAP_PLAN', http_status: null, ...over });

beforeEach(() => { jest.clearAllMocks(); db.query.mockReset(); });

describe('[P2] GET /admin/system-health — the owner hub contract', () => {
  test('a healthy gym: green, "Your 1 gym is OK", no rows, one healthy chip', async () => {
    mockWorld();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('green');
    expect(res.body.verdict_line).toBe('Your 1 gym is OK');
    expect(res.body.check_failed).toBeNull();
    expect(res.body.problems).toEqual([]);
    expect(res.body.platform).toEqual([]);
    expect(res.body.healthy).toEqual([expect.objectContaining({ client_id: 'c1', client_name: 'House of Gains' })]);
    expect(res.body.summary).toEqual({ gyms_total: 1, gyms_ok: 1, gyms_need_you: 0, gyms_need_gym: 0, gyms_setting_up: 0, gyms_inactive: 0 });
    expect(res.body.clients[0]).toMatchObject({ state: 'green', success_age_hours: 1, open_errors: { total: 0 }, stuck_members: 0 });
    expect(db.query).toHaveBeenCalledTimes(8);
  });

  describe('members who cannot get in', () => {
    test('AccessSync-owned error → red "you" row with count and a link to the gym\'s errors page', async () => {
      mockWorld({ errors: [openErr()] });
      const res = await get();
      expect(res.body.verdict).toBe('red');
      expect(res.body.verdict_line).toBe('1 of 1 gym needs you');
      expect(res.body.problems).toEqual([expect.objectContaining({
        client_id: 'c1', kind: 'errors_you', owner: 'you', severity: 'red', count: 1,
        text: "1 member can't get in: AccessSync must fix", link: '/errors?clientId=c1',
      })]);
    });

    test('gym-owned error → amber "gym" row; escalated text after 48h', async () => {
      mockWorld({ errors: [gymErr({ created_at: H(60) })] });
      const res = await get();
      expect(res.body.verdict).toBe('amber');
      expect(res.body.verdict_line).toBe('1 waiting on the gym');
      expect(res.body.problems[0]).toMatchObject({ kind: 'errors_gym', owner: 'gym', severity: 'amber', text: "1 member can't get in: the gym must fix (not acted on for 2d)" });
      expect(res.body.summary).toMatchObject({ gyms_need_you: 0, gyms_need_gym: 1 });
    });

    test('a fresh gym-owned error is "waiting on the gym" without the escalation', async () => {
      mockWorld({ errors: [gymErr({ created_at: H(3) })] });
      expect((await get()).body.problems[0].text).toBe("1 member can't get in: the gym must fix");
    });

    test('a self-clearing error is not a row and not a verdict', async () => {
      mockWorld({ errors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503 })] });
      const res = await get();
      expect(res.body.problems).toEqual([]);
      expect(res.body.verdict).toBe('green');
      expect(res.body.clients[0].open_errors.self_clearing).toBe(1);
    });

    test('a self-clearing error still open after 24h is AccessSync\'s (red)', async () => {
      mockWorld({ errors: [openErr({ error_code: 'HARDWARE_API_ERROR', resolution: 'RETRY', http_status: 503, created_at: H(30) })] });
      expect((await get()).body.problems[0]).toMatchObject({ kind: 'errors_you', owner: 'you' });
    });

    test('members stuck in an in-between state for 24h+ count as "can\'t get in" (bug 5)', async () => {
      const oldest = H(240);
      mockWorld({ stuck: [{ client_id: 'c1', stuck: 2, oldest }] });
      const res = await get();
      expect(res.body.problems[0]).toMatchObject({ kind: 'errors_you', count: 2, text: "2 members can't get in: AccessSync must fix", since: oldest });
      expect(res.body.clients[0].stuck_members).toBe(2);
    });

    test('the stuck query excludes delayed-start plans still waiting for their own start date', async () => {
      mockWorld();
      await get();
      const sql = String(db.query.mock.calls[5][0]);
      expect(sql).toMatch(/pending_start' AND mas.scheduled_start_date < NOW\(\)/);
      expect(sql).toMatch(/'pending_identity', 'recovery_pending', 'in_flight'/);
      expect(db.query.mock.calls[5][1]).toEqual([24]);
    });

    test('errors and stuck members are summed into one row', async () => {
      mockWorld({ errors: [openErr()], stuck: [{ client_id: 'c1', stuck: 1, oldest: H(30) }] });
      expect((await get()).body.problems[0]).toMatchObject({ count: 2, text: "2 members can't get in: AccessSync must fix" });
    });
  });

  describe('sync with Wix (freshness = last SUCCESSFUL run, bug 1)', () => {
    test('latest run aborted 1h ago, last success 2h ago → amber "you" row naming the reason', async () => {
      mockWorld({ runs: [{ client_id: 'c1', last_success_at: H(2), latest_status: 'aborted', latest_abort_reason: 'wix_api_unavailable', latest_started_at: H(1) }] });
      const res = await get();
      expect(res.body.problems[0]).toMatchObject({ kind: 'sync', owner: 'you', severity: 'amber', text: "Wix couldn't be read during the last sync; last good sync 2h ago", link: '/logs?clientId=c1' });
    });

    test('latest run aborted and no success in 26h+ → red', async () => {
      mockWorld({ runs: [{ client_id: 'c1', last_success_at: H(30), latest_status: 'aborted', latest_abort_reason: 'hardware_api_unavailable', latest_started_at: H(1) }] });
      expect((await get()).body.problems[0]).toMatchObject({ kind: 'sync', severity: 'red', text: "Kisi didn't respond during the last sync; last good sync 30h ago" });
    });

    test.each([[1, 'green'], [12, 'green'], [14, 'amber'], [25, 'amber'], [27, 'red']])('last success %ih ago → %s', async (h, state) => {
      mockWorld({ runs: [{ client_id: 'c1', last_success_at: H(h), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(h) }] });
      const res = await get();
      expect(res.body.clients[0].state).toBe(state);
      if (state !== 'green') expect(res.body.problems[0]).toMatchObject({ kind: 'sync', severity: state, text: `No successful sync with Wix for ${h}h` });
    });

    test('never synced with history to sync → red row', async () => {
      mockWorld({ runs: [] });
      const res = await get();
      expect(res.body.problems[0]).toMatchObject({ kind: 'sync', severity: 'red', text: 'Sync with Wix has never completed for this gym' });
      expect(res.body.platform).toEqual([expect.objectContaining({ kind: 'sync_job', text: 'The nightly sync has never run' })]);
    });

    test('the runs query reads last_success_at only from status = success', async () => {
      mockWorld();
      await get();
      const sql = String(db.query.mock.calls[2][0]);
      expect(sql).toMatch(/FILTER \(WHERE r\.status = 'success'\) AS last_success_at/);
      expect(sql).toMatch(/latest_abort_reason/);
    });
  });

  describe('door key', () => {
    test('Kisi rejected the key → red "gym" row with the error text, since the first failure', async () => {
      const failedAt = H(10);
      mockWorld({ clients: [{ ...HOG, key_last_error: 'Invalid API key — Kisi rejected it', key_first_failed_at: failedAt }] });
      const res = await get();
      expect(res.body.problems[0]).toMatchObject({ kind: 'key', owner: 'gym', severity: 'red', text: 'Door key rejected by Kisi: Invalid API key — Kisi rejected it', since: failedAt, link: '/locations?clientId=c1' });
    });

    test('key not checked for 24h+ while the check runs elsewhere → amber "you" row', async () => {
      mockWorld({ clients: [{ ...HOG, key_last_verified: H(30) }, { ...HOG, id: 'c3', name: 'Other', key_last_verified: H(1) }],
        runs: [{ client_id: 'c1', last_success_at: H(1), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(1) }, { client_id: 'c3', last_success_at: H(1), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(1) }],
        webhooks: [{ client_id: 'c1', last_received_at: H(1), count_24h: 1 }, { client_id: 'c3', last_received_at: H(1), count_24h: 1 }],
        setup: [HOG_SETUP, { ...HOG_SETUP, client_id: 'c3' }] });
      const res = await get();
      expect(res.body.problems).toEqual([expect.objectContaining({ client_id: 'c1', kind: 'key', owner: 'you', severity: 'amber', text: 'Door key not checked for 30h' })]);
    });

    test('no key ever checked anywhere → one platform row, not a row per gym', async () => {
      mockWorld({ clients: [{ ...HOG, key_last_verified: null }] });
      const res = await get();
      expect(res.body.problems).toEqual([]);
      expect(res.body.platform).toEqual([expect.objectContaining({ kind: 'key_check', owner: 'you', severity: 'amber', text: 'The 6-hourly Kisi key check has never run' })]);
      expect(res.body.verdict).toBe('amber');
    });
  });

  describe('purchases', () => {
    test('silence for 48h+ after previous activity → amber "you" row', async () => {
      mockWorld({ clients: [{ ...HOG, last_webhook_at: H(50) }], webhooks: [{ client_id: 'c1', first_received_at: H(900), last_received_at: H(50), count_24h: 0 }] });
      expect((await get()).body.problems[0]).toMatchObject({ kind: 'webhooks', owner: 'you', severity: 'amber', text: 'No purchases from Wix for 2d (was active before)' });
    });

    test('a quiet day is not silence; never received one is not a fault', async () => {
      mockWorld({ clients: [{ ...HOG, last_webhook_at: H(30) }], webhooks: [{ client_id: 'c1', first_received_at: H(900), last_received_at: H(30), count_24h: 0 }] });
      expect((await get()).body.problems).toEqual([]);
    });
  });

  describe('setup', () => {
    test('a brand-new gym with nothing configured → amber "you" row at the missing step, with a setup-link action, never red', async () => {
      mockWorld({ clients: [HOG, NEW], setup: [HOG_SETUP, NEW_SETUP] });
      const res = await get();
      expect(res.body.problems).toEqual([expect.objectContaining({
        client_id: 'c2', kind: 'setup', owner: 'you', severity: 'amber', action: 'invite',
        text: 'Setup not finished: missing Kisi API key, Wix API key, a location',
      })]);
      expect(res.body.clients.find(c => c.client_id === 'c2')).toMatchObject({ state: 'setup', missing: ['Kisi API key', 'Wix API key', 'a location'] });
      expect(res.body.summary).toMatchObject({ gyms_total: 2, gyms_ok: 1, gyms_setting_up: 1 });
      expect(res.body.verdict_line).toBe('1 of 2 gyms needs you · 1 setting up');
    });

    test('keys and location set, no plan mapped to a door yet → setup row linking to Plan Mapping', async () => {
      mockWorld({ clients: [{ ...NEW, has_hardware_key: true, has_wix_key: true, key_last_verified: H(1) }], runs: [], webhooks: [],
        setup: [{ ...NEW_SETUP, location_count: 1, plans: 2, plans_with_door: 0 }] });
      expect((await get()).body.problems[0]).toMatchObject({ kind: 'setup', text: 'Setup not finished: no plan mapped to a door yet', link: '/plan-mapping?clientId=c2' });
    });

    test('everything configured, no sale yet → "waiting for the first sale", no sync or webhook rows', async () => {
      mockWorld({ clients: [{ ...NEW, has_hardware_key: true, has_wix_key: true, key_last_verified: H(1) }], runs: [], webhooks: [],
        setup: [{ ...NEW_SETUP, location_count: 1, plans: 2, plans_with_door: 2 }] });
      const res = await get();
      expect(res.body.problems.map(p => p.kind)).toEqual(['setup']);
      expect(res.body.problems[0].text).toBe('Setup not finished: waiting for the first sale');
    });

    test('an established gym that lost its Kisi key is a red config gap for the gym, and its errors still show', async () => {
      mockWorld({ clients: [{ ...HOG, has_hardware_key: false }], errors: [gymErr()] });
      const res = await get();
      expect(res.body.problems.map(p => p.kind)).toEqual(['config_gap', 'errors_gym']);
      expect(res.body.problems[0]).toMatchObject({ owner: 'gym', severity: 'red', text: 'Was working, now missing Kisi API key', link: '/locations?clientId=c1' });
    });

    test.each(['suspended', 'cancelled'])('a %s gym is inactive: no rows, not counted', async (status) => {
      mockWorld({ clients: [{ ...HOG, status }] });
      const res = await get();
      expect(res.body.problems).toEqual([]);
      expect(res.body.clients[0].state).toBe('inactive');
      expect(res.body.summary).toMatchObject({ gyms_total: 0, gyms_inactive: 1 });
    });
  });

  describe('platform rows (only when something is wrong)', () => {
    test('open errors tied to no gym → red platform row linking to the Errors panel; the gym stays green', async () => {
      mockWorld({ errors: [openErr({ client_id: null })] });
      const res = await get();
      expect(res.body.platform).toEqual([expect.objectContaining({ kind: 'errors_unassigned', severity: 'red', text: '1 open error tied to no gym', link: '/OwnerDashboard?panel=errors' })]);
      expect(res.body.clients[0].state).toBe('green');
      expect(res.body.verdict).toBe('red');
      expect(res.body.verdict_line).toBe('1 platform problem');
    });

    test('a burst of errors tied to no gym (10+ in 24h) → amber platform row; below the threshold nothing shows (bug 6)', async () => {
      mockWorld({ platformErrors: 12 });
      expect((await get()).body.platform).toEqual([expect.objectContaining({ kind: 'error_burst', severity: 'amber', text: '12 errors in 24h tied to no gym' })]);
      db.query.mockReset();
      mockWorld({ platformErrors: 4 });
      expect((await get()).body.platform).toEqual([]);
    });

    test('the database probe failing → red platform row', async () => {
      mockWorld({ fail: [1] });
      const res = await get();
      expect(res.body.platform).toEqual([expect.objectContaining({ kind: 'db', severity: 'red' })]);
      expect(res.body.check_failed).toMatch(/database probe/);
      expect(res.body.db.ok).toBe(false);
    });
  });

  describe('ordering and failed queries', () => {
    test('rows that need you come first, red before amber, then oldest first', async () => {
      mockWorld({
        clients: [HOG, { ...HOG, id: 'c3', name: 'Other' }],
        runs: [{ client_id: 'c1', last_success_at: H(1), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(1) }, { client_id: 'c3', last_success_at: H(20), latest_status: 'success', latest_abort_reason: null, latest_started_at: H(20) }],
        webhooks: [{ client_id: 'c1', last_received_at: H(1), count_24h: 1 }, { client_id: 'c3', last_received_at: H(1), count_24h: 1 }],
        errors: [gymErr({ client_id: 'c1', created_at: H(100) }), openErr({ client_id: 'c3', created_at: H(2) })],
        setup: [HOG_SETUP, { ...HOG_SETUP, client_id: 'c3' }],
      });
      const kinds = (await get()).body.problems.map(p => `${p.client_id}:${p.kind}:${p.owner}`);
      expect(kinds).toEqual(['c3:errors_you:you', 'c3:sync:you', 'c1:errors_gym:gym']);
    });

    test('a failed query is one banner; the gym is not coloured by it', async () => {
      mockWorld({ fail: [3, 6] });
      const res = await get();
      expect(res.body.check_failed).toMatch(/could not run sync runs, stuck members/);
      expect(res.body.problems).toEqual([]);
      expect(res.body.clients[0].state).toBe('green');
    });

    test('the clients query failing is a 500', async () => {
      mockWorld({ fail: [2] });
      const res = await get();
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Failed to load clients list');
    });
  });

  test('verdictLine for several gyms', () => {
    expect(verdictLine({ verdict: 'green', platform: [], summary: { gyms_total: 3, gyms_need_you: 0, gyms_need_gym: 0, gyms_setting_up: 0 } })).toBe('All 3 gyms OK');
    expect(verdictLine({ verdict: 'red', platform: [], summary: { gyms_total: 3, gyms_need_you: 1, gyms_need_gym: 1, gyms_setting_up: 0 } })).toBe('1 of 3 gyms needs you · 1 waiting on the gym');
  });

  test('exports the reconcile thresholds used by /health', () => {
    expect(router.reconcileState(1)).toBe('green');
    expect(router.reconcileState(20)).toBe('amber');
    expect(router.reconcileState(40)).toBe('red');
  });
});
