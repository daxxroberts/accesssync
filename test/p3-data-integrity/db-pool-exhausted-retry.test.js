/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Supabase pooler is full (EMAXCONNSESSION) for a moment       │
 * │                                                                         │
 * │  Business consequence: seen live 2026-10-05 — a batch of sub-member     │
 * │  grants hit "max clients reached in session mode (pool_size 15)": 15    │
 * │  failed queries, failed jobs and error rows in a second. The refusal    │
 * │  happens while connecting (nothing ran), so db.js now retries it        │
 * │  briefly instead of failing the member's job.                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
'use strict';

process.env.DATABASE_URL = 'postgres://u:p@localhost:5432/x';

const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: mockPoolQuery, connect: mockPoolConnect, on: jest.fn() })) }));
const mockLog = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../core/logger', () => ({ log: mockLog }));

const db = require('../../db');

const exhausted = () => Object.assign(new Error('(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15'), { code: 'XX000' });

beforeEach(() => { jest.clearAllMocks(); mockPoolQuery.mockReset(); mockPoolConnect.mockReset(); });

test('a pool-full refusal is retried and the query succeeds (the member job never sees the error)', async () => {
  mockPoolQuery.mockRejectedValueOnce(exhausted()).mockRejectedValueOnce(exhausted()).mockResolvedValueOnce({ rows: [{ ok: 1 }] });
  const res = await db.query('SELECT 1');
  expect(res.rows).toEqual([{ ok: 1 }]);
  expect(mockPoolQuery).toHaveBeenCalledTimes(3);
  expect(mockLog.error).not.toHaveBeenCalled();
  expect(mockLog.warn).toHaveBeenCalledWith('db.pool_exhausted_recovered', { attempts: 3 });
});

test('if the pooler stays full the error is thrown after 4 tries and logged once', async () => {
  mockPoolQuery.mockRejectedValue(exhausted());
  await expect(db.query('SELECT 1')).rejects.toThrow(/EMAXCONNSESSION/);
  expect(mockPoolQuery).toHaveBeenCalledTimes(4);
  expect(mockLog.error).toHaveBeenCalledTimes(1);
});

test('any other database error is NOT retried (a statement that ran must never run twice)', async () => {
  mockPoolQuery.mockRejectedValue(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
  await expect(db.query('UPDATE x SET y = 1')).rejects.toThrow(/deadlock/);
  expect(mockPoolQuery).toHaveBeenCalledTimes(1);
});

test('getClient (transactions) retries the connect, which has run nothing yet', async () => {
  const client = { release: jest.fn() };
  mockPoolConnect.mockRejectedValueOnce(exhausted()).mockResolvedValueOnce(client);
  await expect(db.getClient()).resolves.toBe(client);
  expect(mockPoolConnect).toHaveBeenCalledTimes(2);
});

test('writing the log row itself never logs about retries (no recursion)', async () => {
  mockPoolQuery.mockRejectedValueOnce(exhausted()).mockResolvedValueOnce({ rows: [] });
  await db.query('INSERT INTO diagnostic_log (message) VALUES ($1)', ['x']);
  expect(mockLog.warn).not.toHaveBeenCalled();
});
