/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                             │
 * │  Scenario: Wix reports a new login email as unverified for a few        │
 * │  seconds, then verifies it (trace 435a2a4e, 2026-11-11)                 │
 * │                                                                         │
 * │  Business consequence: the first updates dead-letter as                 │
 * │  LOGIN_EMAIL_UNVERIFIED. Wix then confirms the email and the swap goes  │
 * │  through, but the failed row stayed on the Errors page for good — a     │
 * │  member who is fine looked broken. A verified success must close that   │
 * │  member's stale row, and nothing else.                                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../core/trace-context', () => ({ getTraceId: jest.fn(() => 't'), getActor: jest.fn(() => ({ type: 'system', id: 'queue-worker' })) }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn() }));

const db = require('../../db');
const { log } = require('../../core/logger');
const engine = require('../../core/retry-engine');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const args = { tenantId: CLIENT, platformMemberId: 'wix-m-1', errorCode: 'LOGIN_EMAIL_UNVERIFIED', resolvedBy: 'auto-email-verified' };

beforeEach(() => { jest.clearAllMocks(); db.query.mockResolvedValue({ rowCount: 1, rows: [] }); });

describe('[P1] retry-engine.resolveStaleErrors', () => {
  test('closes only still-failed rows of that code, for that gym and that Wix member', async () => {
    await expect(engine.resolveStaleErrors(args)).resolves.toBe(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET status = 'resolved', resolved_at = NOW\(\), dismissed_by = \$4/);
    expect(sql).toMatch(/client_id = \$1 AND status = 'failed' AND error_code = \$3/);
    expect(sql).toMatch(/payload->>'platformMemberId' = \$2/);
    expect(params).toEqual([CLIENT, 'wix-m-1', 'LOGIN_EMAIL_UNVERIFIED', 'auto-email-verified']);
  });

  test('reports how many rows it closed (0 when nothing was open)', async () => {
    db.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(engine.resolveStaleErrors(args)).resolves.toBe(0);
  });

  test.each([
    ['no gym', { tenantId: null }],
    ['no Wix member', { platformMemberId: null }],
    ['no error code', { errorCode: null }],
  ])('%s → touches nothing (never a gym-wide or code-wide sweep)', async (_n, over) => {
    await expect(engine.resolveStaleErrors({ ...args, ...over })).resolves.toBe(0);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a database failure is swallowed with a warning: housekeeping never fails the job', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(engine.resolveStaleErrors(args)).resolves.toBe(0);
    expect(log.warn).toHaveBeenCalledWith('retry.resolve_stale_failed', expect.objectContaining({ errorCode: 'LOGIN_EMAIL_UNVERIFIED' }), expect.any(Error));
  });
});
