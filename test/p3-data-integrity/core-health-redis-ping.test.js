/**
 * PRIORITY 3 — Core /health reports the job queue too (BOT review 2026-10-19).
 *
 * /health only checked the DB, so with Redis down it said "ok" while every Wix webhook was
 * failing to queue. It now PINGs Redis as well and answers 503 when either is unreachable, so
 * Railway and the outside uptime checker see the outage.
 */

'use strict';

const request = require('supertest');

jest.mock('../../db', () => ({ healthCheck: jest.fn(), query: jest.fn() }));
jest.mock('../../core/redis-utils', () => ({ pingRedis: jest.fn(), getRedisConnection: jest.fn(() => ({})) }));
jest.mock('../../core/queue-worker', () => ({ startWorker: jest.fn() }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() } }));
jest.mock('../../adapters/wix/wix-connector', () => ({ handleWebhook: jest.fn() }));
jest.mock('../../core/wix-app-market', () => ({ handleAppMarketWebhook: jest.fn() }));
jest.mock('../../core/member-sync-api', () => ({ getAccessStatus: jest.fn() }));
jest.mock('../../core/day-pass-api', () => ({ handleLookup: jest.fn(), handleQrImage: jest.fn() }));
jest.mock('../../admin/middleware/trace-context', () => ({ traceContextMiddleware: (req, res, next) => next() }));

process.env.PORT = '0';
const db = require('../../db');
const { pingRedis } = require('../../core/redis-utils');
const { app, serverInstance } = require('../../server');

afterAll(() => new Promise((resolve) => serverInstance.close(resolve)));

describe('[P3] GET /health checks the DB and Redis', () => {
  test('both up → 200 ok', async () => {
    db.healthCheck.mockResolvedValue(true);
    pingRedis.mockResolvedValue(true);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected', redis: 'connected' });
  });

  test('Redis down → 503 naming Redis (webhooks cannot be queued)', async () => {
    db.healthCheck.mockResolvedValue(true);
    pingRedis.mockResolvedValue(false);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'connected', redis: 'unreachable' });
  });

  test('DB down → 503 naming the DB', async () => {
    db.healthCheck.mockResolvedValue(false);
    pingRedis.mockResolvedValue(true);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('unreachable');
  });
});

describe('[P3] pingRedis never throws', () => {
  test('PONG → true; a rejected command (Redis down, 2s timeout) → false', async () => {
    jest.resetModules();
    jest.doMock('ioredis', () => jest.fn().mockImplementation(() => ({ on: jest.fn(), ping: mockPing })));
    const mockPing = jest.fn().mockResolvedValueOnce('PONG').mockRejectedValueOnce(new Error('Command timed out'));
    const real = jest.requireActual('../../core/redis-utils');
    await expect(real.pingRedis()).resolves.toBe(true);
    await expect(real.pingRedis()).resolves.toBe(false);
  });
});
