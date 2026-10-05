/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: a member's grant/removal is dead-lettered (REAL retry-engine)│
 * │                                                                         │
 * │  Business consequence: alerts must reach the operator exactly once per  │
 * │  problem, say who has to act, and never become an inbox flood or a      │
 * │  silent dead end. Before: a repeat failure re-emailed on every sweep    │
 * │  (the "skip duplicate email" return only skipped the row write), a      │
 * │  rotated key emailed once per member, and Retry / Mark resolved        │
 * │  re-alerted. Only the database and the mailer are faked here.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/trace-context', () => ({ getTraceId: jest.fn(() => 'trace-1'), getActor: jest.fn(() => ({ type: 'system', id: 'queue-worker' })) }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: true }) }));

const db = require('../../db');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const engine = require('../../core/retry-engine');
const { renderMemberFailureAlert } = require('../../core/operator-email-templates');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '33333333-3333-4333-8333-333333333333';

/** The error shape adapters/kisi/kisi-connector.js throws, wrapped as queue-worker wraps a 4xx. */
const kisiError = (over = {}) => Object.assign(new Error('Non-retryable hardware error (422): Kisi 422: unknown'), {
  name: 'UnrecoverableError', statusCode: 422, code: 'HARDWARE_VALIDATION_ERROR',
  userMessage: 'Your door system rejected the request — the data may be malformed or the user already exists.',
  action: 'Try retrying. If it keeps failing, contact AccessSync support.', resolution: 'RETRY', ...over,
});
const job = (over = {}) => ({
  id: 'j1',
  data: { tenantId: CLIENT, standardEvent: { eventType: 'plan.purchased', platformMemberId: 'wix-m-1', planId: 'plan-1', traceId: 't1', ...over } },
});

let world;
beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL;
  world = { memberRow: [{ id: MEMBER }], existing: [], sameCause: [], clientRow: { name: 'House of Gains', notification_email: 'chad@gym.example' }, insertThrows: false };
  db.query.mockImplementation(async (sql, params) => {
    if (/FROM member_master/.test(sql)) return { rows: world.memberRow };
    if (/FROM plan_mappings/.test(sql)) return { rows: [] };
    if (/SELECT id FROM error_queue/.test(sql)) return { rows: world.existing };
    if (/\(created_at, id\) </.test(sql)) return { rows: world.sameCause };
    if (/INSERT INTO error_queue/.test(sql)) { if (world.insertThrows) throw new Error('db down'); return { rows: [{ id: 'row-new' }] }; }
    if (/UPDATE error_queue/.test(sql)) return { rows: [] };
    if (/SELECT notification_email FROM clients/.test(sql)) return { rows: [{ notification_email: world.clientRow.notification_email }] };
    if (/SELECT name, notification_email FROM clients/.test(sql)) return { rows: [world.clientRow] };
    return { rows: [] };
  });
});

const sqls = (frag) => db.query.mock.calls.filter(([s]) => String(s).includes(frag));
const emails = () => sendOperatorEmail.mock.calls.map(([a]) => a);

describe('[P1] first occurrence: one row, one email, saying who acts', () => {
  test('writes one error_queue row and sends one email to the client contact', async () => {
    await engine.handleFailure(job(), kisiError());
    expect(sqls('INSERT INTO error_queue')).toHaveLength(1);
    expect(emails()).toHaveLength(1);
    expect(emails()[0].toEmail).toBe('chad@gym.example');
  });

  test('the stored next-step text comes from the guidance — NOT the connector\'s "Try retrying"', async () => {
    await engine.handleFailure(job(), kisiError());
    const params = sqls('INSERT INTO error_queue')[0][1];
    const actionText = params[8];
    expect(actionText).toMatch(/AccessSync support can see this/);
    expect(actionText).not.toMatch(/retrying/i);
    expect(params[6]).toContain('Your door system rejected');   // the connector's own user_message is still stored as-is
  });

  test('an AccessSync-owned error is emailed as "AccessSync is looking into it", not "Action needed"', async () => {
    await engine.handleFailure(job(), kisiError());
    const { subject, html } = renderMemberFailureAlert(emails()[0].renderArgs);
    expect(emails()[0].renderArgs).toMatchObject({ owner: 'accesssync', retry: 'none' });
    expect(subject).toMatch(/AccessSync is looking into it/);
    expect(subject).not.toMatch(/Action needed/);
    expect(html).not.toMatch(/Retry or dismiss/);
  });

  test('a gym-fixable error IS "Action needed" and offers Retry after the fix', async () => {
    await engine.handleFailure(job(), kisiError({ code: 'HARDWARE_KEY_INVALID', statusCode: 401, resolution: 'ROTATE_API_KEY' }));
    const args = emails()[0].renderArgs;
    expect(args).toMatchObject({ owner: 'gym', retry: 'after_fix' });
    expect(args.actionText).toMatch(/System Config/);
    const { subject, html } = renderMemberFailureAlert(args);
    expect(subject).toMatch(/Action needed/);
    expect(html).toMatch(/Retry or dismiss/);
  });

  test('a removal (revoke) is never offered Retry in the email', async () => {
    await engine.handleFailure(job({ eventType: 'plan.cancelled' }), kisiError({ code: 'HARDWARE_KEY_INVALID', statusCode: 401, resolution: 'ROTATE_API_KEY' }));
    expect(emails()[0].renderArgs.retry).toBe('none');
    expect(renderMemberFailureAlert(emails()[0].renderArgs).html).not.toMatch(/Retry or dismiss/);
  });
});

describe('[P1] a repeat of the same problem never re-emails', () => {
  test('same member + same code, row still open → counted up, NO second row, NO email', async () => {
    world.existing = [{ id: 'row-open' }];
    await engine.handleFailure(job(), kisiError());
    expect(sqls('INSERT INTO error_queue')).toHaveLength(0);
    const upd = sqls('UPDATE error_queue');
    expect(upd).toHaveLength(1);
    expect(String(upd[0][0])).toMatch(/occurred_count\s+=\s+COALESCE\(occurred_count, 0\) \+ 1/);
    expect(emails()).toHaveLength(0);
  });

  test('a row resolved in the last 24h (Retry / Mark resolved, then it failed again) is RE-OPENED, with no new email', async () => {
    world.existing = [{ id: 'row-resolved-recently' }];
    await engine.handleFailure(job(), kisiError());
    const dedupeSql = String(sqls('SELECT id FROM error_queue')[0][0]);
    expect(dedupeSql).toMatch(/status = 'failed' OR \(status = 'resolved' AND resolved_at > NOW\(\) - INTERVAL '24 hours'\)/);
    expect(String(sqls('UPDATE error_queue')[0][0])).toMatch(/status\s+=\s+'failed',\s+resolved_at\s+=\s+NULL/);   // back on the panel
    expect(emails()).toHaveLength(0);
  });

  test('resolved longer ago than that matches nothing: a genuinely new alert (row + email)', async () => {
    world.existing = [];                    // the 24h window excluded it
    await engine.handleFailure(job(), kisiError());
    expect(sqls('INSERT INTO error_queue')).toHaveLength(1);
    expect(emails()).toHaveLength(1);
  });

  test('member not in member_master yet: dedupes on the Wix member id in the payload instead of inserting every run', async () => {
    world.memberRow = [];
    world.existing = [{ id: 'row-open' }];
    await engine.handleFailure(job(), kisiError({ code: 'PLAN_NOT_MAPPED', statusCode: null, resolution: null }));
    const [dedupeSql, params] = sqls('SELECT id FROM error_queue')[0];
    expect(String(dedupeSql)).toMatch(/member_id IS NULL AND payload->>'platformMemberId' = \$2/);
    expect(params).toEqual([CLIENT, 'wix-m-1', 'PLAN_NOT_MAPPED']);
    expect(sqls('INSERT INTO error_queue')).toHaveLength(0);
    expect(emails()).toHaveLength(0);
  });

  test('an error with no code dedupes on its text, so a code-less failure cannot flood either', async () => {
    world.existing = [{ id: 'row-open' }];
    const err = Object.assign(new Error('boom'), { statusCode: 400 });
    await engine.handleFailure(job(), err);
    const [dedupeSql, params] = sqls('SELECT id FROM error_queue')[0];
    expect(String(dedupeSql)).toMatch(/error_reason = \$3/);
    expect(params).toEqual([CLIENT, MEMBER, 'boom']);
    expect(emails()).toHaveLength(0);
  });
});

describe('[P1] one cause across many members is ONE email', () => {
  test('a second member failing for the same cause within the hour gets its row but no email', async () => {
    world.sameCause = [{ event_type: 'plan.purchased', error_code: 'HARDWARE_KEY_INVALID', resolution: 'ROTATE_API_KEY', http_status: 401 }];   // another member's row, same client + code, <1h old
    await engine.handleFailure(job({ platformMemberId: 'wix-m-2' }), kisiError({ code: 'HARDWARE_KEY_INVALID', statusCode: 401, resolution: 'ROTATE_API_KEY' }));
    expect(sqls('INSERT INTO error_queue')).toHaveLength(1);       // the page still lists every affected member
    expect(emails()).toHaveLength(0);
    const [throttleSql, params] = sqls('(created_at, id) <')[0];
    expect(String(throttleSql)).toMatch(/client_id = \$1 AND id <> \$2/);
    // Only OLDER rows count, so two members failing at the same instant cannot suppress each other (both silent).
    expect(String(throttleSql)).toMatch(/\(created_at, id\) < \(SELECT created_at, id FROM error_queue WHERE id = \$2\)/);
    expect(String(throttleSql)).toMatch(/error_code = \$3/);
    expect(String(throttleSql)).toMatch(/INTERVAL '1 hour'/);
    expect(params).toEqual([CLIENT, 'row-new', 'HARDWARE_KEY_INVALID']);
  });

  test('the same code on a removal is AccessSync\'s, not the gym\'s: an older gym-owned row does not hide it', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.example';
    // older row: a GRANT hit 404 (gym must re-map the door group)
    world.sameCause = [{ event_type: 'plan.purchased', error_code: 'HARDWARE_RESOURCE_NOT_FOUND', resolution: 'REMAP_PLAN', http_status: 404 }];
    await engine.handleFailure(job({ eventType: 'plan.cancelled' }),
      kisiError({ code: 'HARDWARE_RESOURCE_NOT_FOUND', statusCode: 404, resolution: 'REMAP_PLAN' }));
    expect(emails().map(e => e.toEmail)).toContain('daxx@accesssync.example');   // AccessSync's copy still goes out
  });

  test('a different cause for the same client is still emailed', async () => {
    world.sameCause = [];
    await engine.handleFailure(job(), kisiError({ code: 'PLAN_NOT_MAPPED', statusCode: null, resolution: null }));
    expect(emails()).toHaveLength(1);
  });

  test('if the throttle lookup itself fails, the alert is sent (an alert is never lost to a bookkeeping error)', async () => {
    db.query.mockImplementation(async (sql) => {
      if (/\(created_at, id\) </.test(sql)) throw new Error('boom');
      if (/INSERT INTO error_queue/.test(sql)) return { rows: [{ id: 'row-new' }] };
      if (/SELECT notification_email FROM clients/.test(sql)) return { rows: [{ notification_email: 'chad@gym.example' }] };
      return { rows: [] };
    });
    await engine.handleFailure(job(), kisiError());
    expect(emails()).toHaveLength(1);
  });
});

describe('[P1] the AccessSync owner is told about AccessSync-owned errors', () => {
  test('owner copy goes to ACCESSSYNC_OWNER_NOTIFICATION_EMAIL, naming the client, when it differs from the gym contact', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.example';
    await engine.handleFailure(job(), kisiError());
    expect(emails().map(e => e.toEmail)).toEqual(['chad@gym.example', 'daxx@accesssync.example']);
    const ownerArgs = emails()[1].renderArgs;
    expect(ownerArgs).toMatchObject({ audience: 'owner', clientName: 'House of Gains', owner: 'accesssync' });
    const { subject } = renderMemberFailureAlert(ownerArgs);
    expect(subject).toMatch(/House of Gains/);
    expect(subject).toMatch(/needs AccessSync/);
  });

  test('no duplicate when the gym contact IS the owner address (House of Gains today)', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'CHAD@gym.example';
    await engine.handleFailure(job(), kisiError());
    expect(emails()).toHaveLength(1);
  });

  test('a gym-fixable error does not go to the owner', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.example';
    await engine.handleFailure(job(), kisiError({ code: 'PLAN_NOT_MAPPED', statusCode: null, resolution: null }));
    expect(emails().map(e => e.toEmail)).toEqual(['chad@gym.example']);
  });

  test('a repeat of an AccessSync-owned error does not re-email the owner either', async () => {
    process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'daxx@accesssync.example';
    world.existing = [{ id: 'row-open' }];
    await engine.handleFailure(job(), kisiError());
    expect(emails()).toHaveLength(0);
  });
});

describe('[P1] failure handling never loses an alert or crashes the worker', () => {
  test('if the row cannot be written, the operator is still told (and the worker does not throw)', async () => {
    world.insertThrows = true;
    await expect(engine.handleFailure(job(), kisiError())).resolves.toBeUndefined();
    expect(emails()).toHaveLength(1);
  });

  test('a failed email falls back to a config alert row instead of throwing', async () => {
    sendOperatorEmail.mockResolvedValueOnce({ sent: false, reason: 'resend down' });
    await expect(engine.handleFailure(job(), kisiError())).resolves.toBeUndefined();
    expect(sqls('INSERT INTO config_alert_log')).toHaveLength(1);
  });
});
