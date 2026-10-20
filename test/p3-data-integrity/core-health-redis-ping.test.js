/**
 * PRIORITY 3 — Core health checks report the job queue too (BOT review 2026-10-19).
 *
 * /health only checked the DB, so with Redis down it said "ok" while every Wix webhook was
 * failing to queue. SAGE ruling: two endpoints.
 *   /health       Railway's deploy check. 503 only for the DB, as before, so a Redis outage never
 *                 blocks deploying a fix. Redis is reported in the body.
 *   /health/full  The outside uptime checker's URL. 503 when the DB or Redis is down.
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

describe('[P3] GET /health/full (uptime checker) fails on the DB or Redis', () => {
  test('both up → 200 ok', async () => {
    db.healthCheck.mockResolvedValue(true);
    pingRedis.mockResolvedValue(true);
    const res = await request(app).get('/health/full');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected', redis: 'connected' });
  });

  test('Redis down → 503 naming Redis (webhooks cannot be queued)', async () => {
    db.healthCheck.mockResolvedValue(true);
    pingRedis.mockResolvedValue(false);
    const res = await request(app).get('/health/full');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'connected', redis: 'unreachable' });
  });

  test('DB down → 503 naming the DB', async () => {
    db.healthCheck.mockResolvedValue(false);
    pingRedis.mockResolvedValue(true);
    const res = await request(app).get('/health/full');
    expect(res.status).toBe(503);
    expect(res.body.db).toBe('unreachable');
  });
});

describe('[P3] GET /health (Railway deploy check) keeps its old pass/fail rule', () => {
  test('Redis down → still 200, Redis reported in the body (a fix can still deploy)', async () => {
    db.healthCheck.mockResolvedValue(true);
    pingRedis.mockResolvedValue(false);
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'connected', redis: 'unreachable' });
  });

  test('DB down → 503, as before', async () => {
    db.healthCheck.mockResolvedValue(false);
    pingRedis.mockResolvedValue(true);
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'error', db: 'unreachable', redis: 'connected' });
  });

  test('railway.toml still points the deploy check at /health', () => {
    const toml = require('fs').readFileSync(require('path').join(__dirname, '../../railway.toml'), 'utf8');
    expect(toml).toMatch(/healthcheckPath\s*=\s*"\/health"/);
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
