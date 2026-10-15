/**
 * PRIORITY 3 — GET /member/access-status rejects a malformed clientId before it reaches the DB.
 *
 * 2026-10-12: a caller sent clientId "41377ole-U477-34UC-2358-875I55Y1m845". clients.id is a uuid, so
 * Postgres refused it (22P02) — nine error rows in diagnostic_log for one bad request, and the caller
 * got a 500 instead of being told what was wrong. Now a 400 with no query issued.
 *
 * platformMemberId is deliberately NOT uuid-checked: sub-member ids end in '###as…' (DR-029).
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../../core/logger', () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const db = require('../../db');
const memberSyncApi = require('../../core/member-sync-api');

const run = async (query) => {
  const req = { headers: {}, query };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  await memberSyncApi.getAccessStatus(req, res);
  return res;
};

beforeEach(() => jest.clearAllMocks());

describe('[P3] member-sync-api clientId validation', () => {
  test('the live malformed id gets a 400 and never reaches the database', async () => {
    const res = await run({ platformMemberId: 'abc', clientId: '41377ole-U477-34UC-2358-875I55Y1m845' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'clientId must be a UUID' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('a well-formed clientId passes the gate (case-insensitive) and the lookup runs', async () => {
    const res = await run({ platformMemberId: 'abc###as959cf8', clientId: '15962EAC-C767-46AD-8056-094F35A4A193' });
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(db.query).toHaveBeenCalled();
  });

  test('a missing clientId still gets the existing "required" 400, not the uuid message', async () => {
    const res = await run({ platformMemberId: 'abc' });
    expect(res.json).toHaveBeenCalledWith({ error: 'platformMemberId and clientId are required' });
  });
});
