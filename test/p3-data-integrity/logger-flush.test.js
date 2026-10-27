/**
 * PRIORITY 3 — logger.flush() waits for the fire-and-forget diagnostic_log writes.
 *
 * A short-lived script (scripts/kisi-ownership-migrate.js) ends the pool and exits right
 * after its last log line. The logger's insert is queued on setImmediate and never
 * awaited, so the exit could beat it: the 2026-10-26 metadata backfill lost its final
 * ownership_metadata_stamped row (Kisi user 105368706, whose write did land). flush()
 * is what the script now waits on; these tests pin that it really waits, that it never
 * rejects, and that the script closes the pool only after it.
 */
'use strict';

jest.mock('../../db', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn() }));

const db = require('../../db');
const { log, flush } = require('../../core/logger');
const { finish } = require('../../scripts/kisi-ownership-migrate');

const later = (ms, fn) => new Promise((resolve, reject) => setTimeout(() => {
  try { resolve(fn()); } catch (e) { reject(e); }
}, ms));

let originalWrite;
beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
});
afterAll(() => { process.stdout.write = originalWrite; });

beforeEach(() => {
  jest.clearAllMocks();
});

describe('[P3] logger.flush', () => {
  test('resolves at once when nothing is pending', async () => {
    await expect(flush()).resolves.toBeUndefined();
  });

  test('waits until a slow diagnostic_log insert has settled', async () => {
    let settled = false;
    db.query.mockImplementation(() => later(30, () => { settled = true; return { rows: [] }; }));

    log.warn('test.flush.slow_write', { clientId: null });
    expect(settled).toBe(false);
    await flush();

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toMatch(/INSERT INTO diagnostic_log/);
    expect(settled).toBe(true);
  });

  test('never rejects when the insert fails', async () => {
    db.query.mockImplementation(() => later(5, () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }));
    log.warn('test.flush.failed_write', {});
    await expect(flush()).resolves.toBeUndefined();
  });

  test('also waits for the unknown-client retry insert (23503)', async () => {
    let retrySettled = false;
    db.query
      .mockImplementationOnce(() => later(5, () => { throw Object.assign(new Error('fk'), { code: '23503' }); }))
      .mockImplementationOnce(() => later(20, () => { retrySettled = true; return { rows: [] }; }));

    log.warn('test.flush.retry_write', { clientId: '00000000-0000-0000-0000-000000000000' });
    await flush();

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[1][1][0]).toBeNull();
    expect(retrySettled).toBe(true);
  });
});

describe('[P3] kisi-ownership-migrate finish(): last log line lands before the pool closes', () => {
  test('flushes pending log writes, then ends the pool, then exits with the code', async () => {
    const order = [];
    db.query.mockImplementation(() => later(25, () => { order.push('diagnostic_log insert settled'); return { rows: [] }; }));
    const fakeDb = { pool: { end: jest.fn(async () => { order.push('pool.end'); }) } };
    const exit = jest.fn(() => order.push('exit'));

    // What the backfill's last stamp emits right before main() returns.
    log.info('kisi.user.ownership_metadata_stamped', { userId: 105368706, clientId: null });
    await finish(0, fakeDb, exit);

    expect(order).toEqual(['diagnostic_log insert settled', 'pool.end', 'exit']);
    expect(exit).toHaveBeenCalledWith(0);
  });

  test('a failing pool.end still exits with the run\'s code; no database means no pool.end', async () => {
    const exit = jest.fn();
    await finish(1, { pool: { end: jest.fn().mockRejectedValue(new Error('already closed')) } }, exit);
    expect(exit).toHaveBeenCalledWith(1);

    const exit2 = jest.fn();
    await finish(2, null, exit2);
    expect(exit2).toHaveBeenCalledWith(2);
  });
});
