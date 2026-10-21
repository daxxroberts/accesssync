/**
 * PRIORITY 3 — the HMAC attack alert can actually fire (BOT review 2026-10-19).
 *
 * core/hmac-monitor.js called redis.lpush() on the result of getRedisConnection(), which is a
 * {host, port, password} CONFIG object for BullMQ, not a client. Every call threw, the catch
 * swallowed it as hmac.monitor.internal_error, and the "3 failures in 5 minutes" email could
 * never send. The existing tests mocked getRedisConnection() to return a client, so they hid it.
 *
 * Here only `ioredis` itself is faked (an in-memory list/string store); the real redis-utils
 * builds the client, so a regression to the config object fails this test.
 */

'use strict';

jest.mock('ioredis', () => {
  const store = new Map();
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    lpush: jest.fn(async (k, v) => { const l = store.get(k) || []; l.unshift(String(v)); store.set(k, l); return l.length; }),
    ltrim: jest.fn(async (k, a, b) => { store.set(k, (store.get(k) || []).slice(a, b + 1)); return 'OK'; }),
    expire: jest.fn(async () => 1),
    lrange: jest.fn(async (k) => store.get(k) || []),
    get: jest.fn(async (k) => (store.has(k) ? store.get(k) : null)),
    set: jest.fn(async (k, v) => { store.set(k, v); return 'OK'; }),
    ping: jest.fn(async () => 'PONG'),
  }));
});
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../core/operator-mailer', () => ({ sendOperatorEmail: jest.fn().mockResolvedValue({ sent: true }) }));

const IORedis = require('ioredis');
const { log } = require('../../core/logger');
const { sendOperatorEmail } = require('../../core/operator-mailer');
const { getRedisConnection, getRedisClient } = require('../../core/redis-utils');
const { recordFailure } = require('../../core/hmac-monitor');

beforeAll(() => { process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL = 'owner@example.test'; });
afterAll(() => { delete process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL; });

test('getRedisConnection() is a config object; getRedisClient() is a real client built from it, once', () => {
  expect(typeof getRedisConnection().lpush).toBe('undefined');
  const a = getRedisClient();
  const b = getRedisClient();
  expect(a).toBe(b);
  expect(typeof a.lpush).toBe('function');
  expect(IORedis).toHaveBeenCalledTimes(1);
  expect(IORedis.mock.calls[0][0]).toEqual(expect.objectContaining({ host: expect.any(String), port: expect.any(Number), commandTimeout: expect.any(Number) }));
});

test('three failures in five minutes send exactly one alert email, with no internal error', async () => {
  await recordFailure('probe-a');
  await recordFailure('probe-a');
  expect(sendOperatorEmail).not.toHaveBeenCalled();

  await recordFailure('probe-a');
  expect(sendOperatorEmail).toHaveBeenCalledTimes(1);
  expect(log.warn).toHaveBeenCalledWith('hmac.failure_spike', expect.objectContaining({ count: 3 }), expect.any(Error));

  await recordFailure('probe-a');                     // inside the 10-minute cooldown
  expect(sendOperatorEmail).toHaveBeenCalledTimes(1);

  expect(log.error).not.toHaveBeenCalledWith('hmac.monitor.internal_error', expect.anything(), expect.anything());
});
