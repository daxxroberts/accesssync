/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Scenario: the owner daily email (owner hub proposal 2026-10-15 §3)     │
 * │                                                                         │
 * │  - subject = the Hub's verdict line; sent every day INCLUDING all-clear │
 * │  - one line per problem: gym, what, who acts, since; counts only        │
 * │  - once per Central day during the configured hour; a restart in the    │
 * │    hour does not send twice (the logger's sent row is the guard)        │
 * │  - the gym daily goes to the gym's own notification email               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/owner-health', () => ({ computeOwnerHealth: jest.fn(), verdictLine: jest.requireActual('../../core/owner-health').verdictLine }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: true }) }));

const db = require('../../db');
const { log } = require('../../core/logger');
const { computeOwnerHealth } = require('../../core/owner-health');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const T = require('../../core/operator-email-templates');
const daily = require('../../core/owner-daily-email');

const H = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const GREEN = {
  verdict: 'green', check_failed: null,
  summary: { gyms_total: 1, gyms_ok: 1, gyms_need_you: 0, gyms_need_gym: 0, gyms_setting_up: 0, gyms_inactive: 0 },
  problems: [], platform: [],
  healthy: [{ client_id: 'c1', client_name: 'House of Gains', last_webhook_at: H(2), last_success_at: H(1) }],
};
const RED = {
  verdict: 'red', check_failed: null,
  summary: { gyms_total: 2, gyms_ok: 0, gyms_need_you: 1, gyms_need_gym: 1, gyms_setting_up: 0, gyms_inactive: 0 },
  problems: [
    { client_id: 'c1', client_name: 'House of Gains', kind: 'errors_you', owner: 'you', severity: 'red', text: "2 members can't get in: AccessSync must fix", since: H(30), link: '/errors?clientId=c1' },
    { client_id: 'c2', client_name: '918 Fitness', kind: 'errors_gym', owner: 'gym', severity: 'amber', text: "1 member can't get in: the gym must fix (not acted on for 3d)", since: H(72), link: '/errors?clientId=c2' },
  ],
  platform: [{ kind: 'key_check', owner: 'you', severity: 'amber', text: 'The 6-hourly Kisi key check has never run' }],
  healthy: [],
};

beforeEach(() => {
  jest.clearAllMocks();
  daily._resetForTests();
  process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
  db.query.mockResolvedValue({ rows: [] });
  sendOperatorEmail.mockResolvedValue({ sent: true });
});
afterAll(() => { delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL; });

describe('[P2] renderOwnerDaily', () => {
  test('all clear: subject is the verdict, no action chip, says the email arrives every day', () => {
    const r = T.renderOwnerDaily({ ...GREEN, verdict_line: 'Your 1 gym is OK' });
    expect(r.subject).toBe('[AccessSync] Your 1 gym is OK');
    expect(r.html).toContain('No action needed');
    expect(r.text).toMatch(/Nothing needs you today/);
    expect(r.text).toMatch(/House of Gains — last sale 2h ago, last sync 1h ago/);
    expect(r.html).toContain('/OwnerDashboard');
  });

  test('problems: one line per problem with gym, reason, who acts and since; platform rows; action chip', () => {
    const r = T.renderOwnerDaily({ ...RED, verdict_line: '1 of 2 gyms needs you · 1 waiting on the gym' });
    expect(r.subject).toBe('[AccessSync] 1 of 2 gyms needs you · 1 waiting on the gym');
    expect(r.html).toContain('Action needed');
    expect(r.text).toMatch(/House of Gains — 2 members can't get in: AccessSync must fix \(you, since 30h ago\)/);
    expect(r.text).toMatch(/918 Fitness — 1 member can't get in: the gym must fix \(not acted on for 3d\) \(the gym, since 3d ago\)/);
    expect(r.text).toMatch(/Platform\n  • The 6-hourly Kisi key check has never run/);
    expect(r.text).toContain('/errors?clientId=c1');
    expect(r.text).toMatch(/3 things to look at today/);
  });

  test('a failed health query is said up front, never hidden', () => {
    const r = T.renderOwnerDaily({ ...GREEN, check_failed: 'Health check could not run sync runs: timeout', verdict_line: 'Your 1 gym is OK' });
    expect(r.text).toContain('Health check could not run sync runs: timeout');
  });

  test('tolerates a missing or empty health object', () => {
    expect(() => T.renderOwnerDaily({})).not.toThrow();
    expect(() => T.renderOwnerDaily()).not.toThrow();
  });
});

describe('[P2] sendOwnerDaily', () => {
  test('sends the verdict line as the subject, including an all-clear', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    const r = await daily.sendOwnerDaily();
    expect(r.sent).toBe(true);
    const call = sendOperatorEmail.mock.calls[0][0];
    expect(call.toEmail).toBe('daxx@accesssync.io');
    expect(call.render).toBe(T.renderOwnerDaily);
    expect(call.renderArgs.verdict_line).toBe('Your 1 gym is OK');
    expect(log.info).toHaveBeenCalledWith('email.owner_daily.sent', expect.objectContaining({ verdict: 'green', problems: 0 }));
  });

  test('no owner address → warns, sends nothing', async () => {
    delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
    const r = await daily.sendOwnerDaily();
    expect(r).toEqual({ sent: false, reason: 'no_recipient' });
    expect(sendOperatorEmail).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('email.owner_daily.no_recipient', {});
  });

  test('a send failure is logged as failed, not sent', async () => {
    computeOwnerHealth.mockResolvedValue({ ...RED });
    sendOperatorEmail.mockResolvedValue({ sent: false, reason: 'domain is not verified' });
    await daily.sendOwnerDaily();
    expect(log.error).toHaveBeenCalledWith('email.owner_daily.failed', expect.objectContaining({ reason: 'domain is not verified' }));
    expect(log.info).not.toHaveBeenCalledWith('email.owner_daily.sent', expect.anything());
  });
});

describe('[P2] maybeSendOwnerDaily — once a day during the hour, in Central time (never UTC)', () => {
  // 2026-10-15 is CDT (UTC-5): 7:00 Central = 12:00Z. 2026-12-15 is CST (UTC-6): 7:00 Central = 13:00Z.
  const z = (iso) => new Date(iso);

  test('defaults: 7:00 America/Chicago; 12:00Z in October is the hour, 11:59Z is not', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    expect(await daily.maybeSendOwnerDaily({ now: z('2026-10-15T11:59:00Z') })).toEqual({ sent: false, reason: 'not_the_hour' });
    expect((await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:05:00Z') })).sent).toBe(true);
  });

  test('daylight saving is handled: in December 7:00 Central is 13:00Z', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    expect(await daily.maybeSendOwnerDaily({ now: z('2026-12-15T12:05:00Z') })).toEqual({ sent: false, reason: 'not_the_hour' });
    expect((await daily.maybeSendOwnerDaily({ now: z('2026-12-15T13:05:00Z') })).sent).toBe(true);
  });

  test('the second tick in the same hour is skipped', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    expect((await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:05:00Z') })).sent).toBe(true);
    expect(await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:20:00Z') })).toEqual({ sent: false, reason: 'already_sent_today' });
    expect(sendOperatorEmail).toHaveBeenCalledTimes(1);
  });

  test('after a restart the logger\'s sent row is the guard, judged on the Central calendar day', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ created_at: '2026-10-15T12:07:00Z' }] });   // sent 7:07 Central today
    expect(await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:35:00Z') })).toEqual({ sent: false, reason: 'already_sent_today' });
    expect(sendOperatorEmail).not.toHaveBeenCalled();
    expect(String(db.query.mock.calls[0][0])).toMatch(/EMAIL_OWNER_DAILY_SENT/);
  });

  test('a row from yesterday Central (even if the same UTC day) does not block today', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    db.query.mockResolvedValueOnce({ rows: [{ created_at: '2026-10-15T03:30:00Z' }] });   // 22:30 Central on the 14th
    expect((await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:05:00Z') })).sent).toBe(true);
  });

  test('a new day sends again', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    await daily.maybeSendOwnerDaily({ now: z('2026-10-15T12:05:00Z') });
    await daily.maybeSendOwnerDaily({ now: z('2026-10-16T12:05:00Z') });
    expect(sendOperatorEmail).toHaveBeenCalledTimes(2);
  });

  test('OWNER_DAILY_HOUR and OWNER_DAILY_TZ override the defaults', async () => {
    computeOwnerHealth.mockResolvedValue({ ...GREEN });
    expect((await daily.maybeSendOwnerDaily({ hour: 9, timeZone: 'America/New_York', now: z('2026-10-15T13:10:00Z') })).sent).toBe(true);
  });

  test('localParts: Central day and hour from a UTC instant', () => {
    expect(daily.localParts(z('2026-10-15T03:30:00Z'), 'America/Chicago')).toEqual({ day: '2026-10-14', hour: 22 });
    expect(daily.DEFAULT_TZ).toBe('America/Chicago');
    expect(daily.DEFAULT_HOUR).toBe(7);
  });
});

describe('[P2] renderNightlyDigest is the gym\'s daily', () => {
  test('with a clientId the CTA opens that gym\'s Errors page', () => {
    const r = T.renderNightlyDigest({ configAlerts: [{ alert_type: 'system' }], failedJobs: [], clientId: 'c1' });
    expect(r.text).toContain('/errors?clientId=c1');
    expect(r.text).not.toContain('/admin-errors');
  });
  test('without a clientId (rows tied to no gym, sent to the owner) it keeps the cross-tenant view', () => {
    const r = T.renderNightlyDigest({ configAlerts: [{ alert_type: 'system' }], failedJobs: [] });
    expect(r.text).toContain('/admin-errors');
  });
});
