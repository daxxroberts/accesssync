/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: the nightly digest is each GYM's daily, to the gym's own     │
 * │  notification email (owner hub proposal 2026-10-15 §3, Daxx's rule P2)  │
 * │                                                                         │
 * │  Before: one cross-tenant digest, written as if to a gym, sent only to  │
 * │  the AccessSync owner. Now: one email per gym to that gym's address,   │
 * │  once per 24h; rows tied to no gym, and gyms with no email, still go   │
 * │  to the owner.                                                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => {
  const l = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn(), debug: jest.fn() };
  return { log: l, withTrace: () => l, withClient: (_id, fn) => fn() };
});
jest.mock('../../core/redis-utils', () => ({ getRedisConnection: jest.fn(() => ({})) }));
jest.mock('bullmq', () => ({ Queue: jest.fn().mockImplementation(() => ({ add: jest.fn() })) }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: true }) }));

const db = require('../../db');
const { log } = require('../../core/logger');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const reconciliation = require('../../core/reconciliation');

const alert = (client_id, over = {}) => ({ client_id, alert_type: 'sweep_repair_pending', hardware_ref: 'g-1', created_at: new Date().toISOString(), member_name: 'Ava Patel', location_name: 'Main Gym', client_name: 'House of Gains', ...over });
const job = (client_id, over = {}) => ({ client_id, member_id: 'm1', event_type: 'plan.purchased', error_reason: 'Kisi 422', created_at: new Date().toISOString(), user_message: 'Your door system rejected the request.', first_name: 'Noah', last_name: 'Kim', ...over });

function world({ alerts = [], jobs = [], gyms = [], sentRecently = false } = {}) {
  db.query.mockImplementation((sql, params) => {
    const s = String(sql);
    if (s.includes('FROM config_alert_log cal')) return Promise.resolve({ rows: alerts });
    if (s.includes('FROM error_queue eq')) return Promise.resolve({ rows: jobs });
    if (s.includes('FROM clients WHERE id = ANY')) return Promise.resolve({ rows: gyms.filter(g => params[0].includes(g.id)) });
    if (s.includes('EMAIL_GYM_DAILY_SENT')) return Promise.resolve({ rows: sentRecently ? [{ '?column?': 1 }] : [] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.io';
  sendOperatorEmail.mockResolvedValue({ sent: true });
});
afterAll(() => { delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL; });

describe('[P3] _generateAndSendDigest — one daily per gym, to the gym', () => {
  test('a gym with its own email gets its own daily, with its Errors page as the CTA', async () => {
    world({ alerts: [alert('c1')], jobs: [job('c1')], gyms: [{ id: 'c1', name: 'House of Gains', notification_email: 'chad@houseofgains.com' }] });
    await reconciliation._generateAndSendDigest();
    expect(sendOperatorEmail).toHaveBeenCalledTimes(1);
    const call = sendOperatorEmail.mock.calls[0][0];
    expect(call.toEmail).toBe('chad@houseofgains.com');
    expect(call.renderArgs.clientId).toBe('c1');
    expect(call.renderArgs.configAlerts[0].memberName).toBe('Ava Patel');
    expect(call.renderArgs.failedJobs[0].memberName).toBe('Noah Kim');
    expect(call.logContext.alert).toBe('gym_daily');
    expect(log.info).toHaveBeenCalledWith('email.gym_daily.sent', expect.objectContaining({ clientId: 'c1', toEmail: 'chad@houseofgains.com' }));
  });

  test('two gyms → two emails, each with only its own rows; the gym copy names the location without the gym suffix', async () => {
    world({
      alerts: [alert('c1'), alert('c2', { client_name: '918 Fitness', location_name: 'Downtown' })],
      gyms: [{ id: 'c1', name: 'House of Gains', notification_email: 'chad@houseofgains.com' }, { id: 'c2', name: '918 Fitness', notification_email: 'owner@918.com' }],
    });
    await reconciliation._generateAndSendDigest();
    const calls = sendOperatorEmail.mock.calls.map(c => c[0]);
    expect(calls.map(c => c.toEmail).sort()).toEqual(['chad@houseofgains.com', 'owner@918.com']);
    const c2 = calls.find(c => c.toEmail === 'owner@918.com');
    expect(c2.renderArgs.configAlerts).toHaveLength(1);
    expect(c2.renderArgs.configAlerts[0].locationName).toBe('Downtown');
  });

  test('a gym with no notification email falls back to the owner (nothing is dropped)', async () => {
    world({ alerts: [alert('c1')], gyms: [{ id: 'c1', name: 'House of Gains', notification_email: null }] });
    await reconciliation._generateAndSendDigest();
    const call = sendOperatorEmail.mock.calls[0][0];
    expect(call.toEmail).toBe('daxx@accesssync.io');
    expect(call.renderArgs.clientId).toBeNull();
    expect(call.logContext.alert).toBe('nightly_digest');
  });

  test('rows tied to no gym go to the owner with the cross-tenant CTA', async () => {
    world({ jobs: [job(null, { first_name: null, last_name: null })] });
    await reconciliation._generateAndSendDigest();
    const call = sendOperatorEmail.mock.calls[0][0];
    expect(call.toEmail).toBe('daxx@accesssync.io');
    expect(call.renderArgs.clientId).toBeNull();
  });

  test('once per 24h per gym: a gym emailed in the last 23h is skipped this sweep', async () => {
    world({ alerts: [alert('c1')], gyms: [{ id: 'c1', name: 'House of Gains', notification_email: 'chad@houseofgains.com' }], sentRecently: true });
    await reconciliation._generateAndSendDigest();
    expect(sendOperatorEmail).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('reconciliation.digest_gym_skipped', expect.objectContaining({ clientId: 'c1', reason: 'sent_in_last_24h' }));
  });

  test('nothing open → no email at all', async () => {
    world();
    await reconciliation._generateAndSendDigest();
    expect(sendOperatorEmail).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('reconciliation.digest_empty', expect.anything());
  });

  test('a send failure for one gym does not stop the next gym', async () => {
    world({
      alerts: [alert('c1'), alert('c2', { client_name: '918 Fitness' })],
      gyms: [{ id: 'c1', name: 'House of Gains', notification_email: 'chad@houseofgains.com' }, { id: 'c2', name: '918 Fitness', notification_email: 'owner@918.com' }],
    });
    sendOperatorEmail.mockResolvedValueOnce({ sent: false, reason: 'bounce' }).mockResolvedValueOnce({ sent: true });
    await reconciliation._generateAndSendDigest();
    expect(sendOperatorEmail).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith('reconciliation.digest_send_failed', expect.objectContaining({ reason: 'bounce' }));
  });
});
