/**
 * PRIORITY 3 — a forged webhook cannot write to another gym's log.
 *
 * A request whose signature FAILED still carries an x-accesssync-client-id header, which anyone can set to any
 * uuid. core/hmac-monitor.js used to pass that as `clientId` to log.warn(), and the logger persists ctx.clientId as
 * diagnostic_log.client_id — so an attacker could put warnings (and trigger spike alerts) on a victim gym's log.
 * The header is now only ever free text (`clientHint`).
 */

'use strict';

jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('../../core/redis-utils', () => ({
  getRedisConnection: jest.fn(() => ({
    lpush: jest.fn().mockResolvedValue(1), ltrim: jest.fn().mockResolvedValue(), expire: jest.fn().mockResolvedValue(),
    lrange: jest.fn().mockResolvedValue([String(Math.floor(Date.now() / 1000)), String(Math.floor(Date.now() / 1000)), String(Math.floor(Date.now() / 1000))]),
    get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK'),
  })),
}));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: true }) }));

const { log } = require('../../core/logger');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const { recordFailure } = require('../../core/hmac-monitor');

const VICTIM = '11111111-1111-4111-8111-111111111111';

test('a forged client-id header is never stored as the client of a log row, in any hmac event (incl. the spike alert path)', async () => {
  process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'owner@example.test';
  await recordFailure(VICTIM);     // 3 recent failures in the mocked window → spike → alert path too

  const hmacCalls = [...log.warn.mock.calls, ...log.error.mock.calls, ...log.info.mock.calls]
    .filter(c => String(c[0]).startsWith('hmac.'));
  expect(hmacCalls.map(c => c[0])).toEqual(expect.arrayContaining(['hmac.failure', 'hmac.failure_spike']));
  for (const [, ctx] of hmacCalls) {
    expect(ctx).not.toHaveProperty('clientId');
    expect(ctx).not.toHaveProperty('tenantId');
    expect(ctx.clientHint).toBe(VICTIM);               // still available as free text for an investigator
  }
  // ...nor in the email logging context or the email's own link
  const sent = sendOperatorEmail.mock.calls[0][0];
  expect(sent.logContext).not.toHaveProperty('clientId');
  expect(sent.renderArgs).toEqual({});
});
