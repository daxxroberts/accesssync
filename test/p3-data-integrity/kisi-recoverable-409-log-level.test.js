/**
 * PRIORITY 3 — a Kisi response the adapter layer recovers from is not an ERROR.
 *
 * `POST /users` 409 ("the record already exists", the user was created between the lookup and the create) is
 * recovered by standard-adapter.js, ~18 a day for House of Gains. Logged at ERROR it kept the owner panel's
 * Diagnostics card permanently amber and buried real failures. Real connector; only fetch and the logger are faked.
 */

'use strict';

jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { log } = require('../../core/logger');
const connector = require('../../adapters/kisi/kisi-connector');

const respond = (status, body = { message: 'x' }) => ({ ok: false, status, statusText: 'err', json: async () => body });
const levelOf = () => (log.error.mock.calls.some(c => c[0] === 'kisi.response.error') ? 'error'
  : log.warn.mock.calls.some(c => c[0] === 'kisi.response.error') ? 'warn' : 'none');

beforeEach(() => { jest.clearAllMocks(); connector.lastRequestTimes = []; });
afterEach(() => { delete global.fetch; });

const call = async (method, endpoint, status) => {
  global.fetch = jest.fn().mockResolvedValue(respond(status));
  await expect(connector.makeRequest(endpoint, { method }, 'key')).rejects.toMatchObject({ statusCode: status });
};

describe('[P3] Kisi connector log level for recoverable responses', () => {
  test.each([
    ['POST', '/users', 409],                   // new: user already exists → adapter reuses it
    ['POST', '/role_assignments', 409],        // existing
    ['DELETE', '/role_assignments/123', 404],  // existing
  ])('%s %s %i is logged at WARN and flagged recoverable', async (method, endpoint, status) => {
    await call(method, endpoint, status);
    expect(levelOf()).toBe('warn');
    expect(log.warn.mock.calls.find(c => c[0] === 'kisi.response.error')[1]).toMatchObject({ recoverable: true });
  });

  test.each([
    ['POST', '/users', 422], ['POST', '/users', 401], ['POST', '/users', 500],
    ['POST', '/role_assignments', 422],
    ['GET', '/users', 409],                    // a 409 on a read is not the create race
    ['POST', '/groups', 409],                  // nor on an unrelated endpoint
    ['DELETE', '/role_assignments/123', 403],
  ])('%s %s %i stays an ERROR (a real failure the operator must see)', async (method, endpoint, status) => {
    await call(method, endpoint, status);
    expect(levelOf()).toBe('error');
    expect(log.error.mock.calls.find(c => c[0] === 'kisi.response.error')[1]).toMatchObject({ recoverable: false });
  });

  test('the thrown error is unchanged (the adapter still sees the 409 and recovers)', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(409));
    await expect(connector.makeRequest('/users', { method: 'POST' }, 'key')).rejects.toMatchObject({ statusCode: 409, code: 'HARDWARE_API_ERROR' });
  });
});
