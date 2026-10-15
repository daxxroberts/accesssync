/**
 * PRIORITY 3 — a Kisi validation error keeps its body.
 *
 * Kisi's 422 responses do not use `message`; the detail sits under other keys. From 2026-09-30 to
 * 2026-10-05 a grant dead-lettered twelve times and every row said "Kisi 422: unknown" — nobody
 * could tell what Kisi had objected to. The connector now keeps the raw body (capped at 1000
 * chars) on the log row and in the thrown error for every NON-recoverable response. Recoverable
 * 409/404 shapes stay lean: the adapter resolves those on the next line.
 */

'use strict';

jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { log } = require('../../core/logger');
const connector = require('../../adapters/kisi/kisi-connector');

const respond = (status, body) => ({ ok: false, status, statusText: 'unknown', json: async () => body });
const errorLogCtx = () => log.error.mock.calls.find(c => c[0] === 'kisi.response.error')[1];
const infoLogCtx  = () => log.info.mock.calls.find(c => c[0] === 'kisi.response.error')[1];

beforeEach(() => { jest.clearAllMocks(); connector.lastRequestTimes = []; });
afterEach(() => { delete global.fetch; });

describe('[P3] Kisi 422 body is captured', () => {
  test('a 422 with no `message` lands its body on the log row AND in the error message', async () => {
    const body = { errors: { role: ['is not available for this user'] } };
    global.fetch = jest.fn().mockResolvedValue(respond(422, body));

    const err = await connector.makeRequest('/role_assignments', { method: 'POST' }, 'key').catch(e => e);

    expect(err.statusCode).toBe(422);
    expect(err.code).toBe('HARDWARE_VALIDATION_ERROR');
    expect(err.message).toContain('is not available for this user');
    expect(err.message).not.toMatch(/unknown$/);
    expect(errorLogCtx().kisiBody).toBe(JSON.stringify(body));
  });

  test('a 422 WITH a `message` still prefers it, and keeps the body alongside', async () => {
    const body = { code: '000422', message: 'Email has already been taken' };
    global.fetch = jest.fn().mockResolvedValue(respond(422, body));

    const err = await connector.makeRequest('/users', { method: 'POST' }, 'key').catch(e => e);

    expect(err.message).toBe('Kisi 422: Email has already been taken');
    expect(errorLogCtx()).toMatchObject({ kisiMessage: 'Email has already been taken', kisiBody: JSON.stringify(body) });
  });

  test('an empty body falls back to statusText and records no kisiBody', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(500, {}));
    const err = await connector.makeRequest('/users', { method: 'POST' }, 'key').catch(e => e);
    expect(err.message).toBe('Kisi 500: unknown');
    expect(errorLogCtx().kisiBody).toBeNull();
  });

  test('the body is capped at 1000 characters', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(422, { detail: 'x'.repeat(5000) }));
    await connector.makeRequest('/users', { method: 'POST' }, 'key').catch(() => {});
    expect(errorLogCtx().kisiBody).toHaveLength(1000);
  });

  test('a recoverable 409 does not carry the body (the adapter resolves it; keep the row lean)', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond(409, { code: '000409', message: 'The record already exists.' }));
    await connector.makeRequest('/users', { method: 'POST' }, 'key').catch(() => {});
    expect(infoLogCtx()).toMatchObject({ recoverable: true, kisiBody: null });
  });
});
