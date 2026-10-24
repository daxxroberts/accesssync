/**
 * P3 — scripts/kisi-ownership-migrate.js classification (DR-045 metadata transition).
 *
 * The verify step's verdict ("READY FOR PHASE 2") is what allows the notes fallback
 * to be removed from the delete guard. If a notes-only user were miscounted as done,
 * phase 2 would leave that member's Kisi account undeletable; if a user with no
 * marker were offered to backfill, AccessSync would gain the power to delete an
 * account it never created. These tests pin both.
 */

jest.mock('../../db', () => ({ query: jest.fn(), pool: { end: jest.fn() } }));
jest.mock('../../core/crypto-utils', () => ({ decryptApiKey: jest.fn() }));

const kisiAdapter = require('../../adapters/kisi/kisi-adapter');
const { classifyUsers } = require('../../scripts/kisi-ownership-migrate');

const ME = 'client-hog';
const OTHER = 'client-other';
const meta = (c, createdAt = '2026-05-13T00:00:00Z') => kisiAdapter.buildOwnershipMetadata(c, createdAt);
const notes = (c, createdAt = '2026-05-13T00:00:00Z') => `[AS|managed|${c}|${createdAt}] Created by AccessSync`;
const idsOf = (list) => list.map(x => x.id);

describe('[P3] kisi-ownership-migrate classifyUsers', () => {
  const users = [
    { id: 1, metadata: meta(ME), notes: notes(ME) },                     // agree
    { id: 2, metadata: meta(ME) },                                       // metadata only
    { id: 3, notes: notes(ME, '2026-06-01T10:00:00Z') },                 // notes only → backfill
    { id: 4, metadata: meta(ME), notes: notes(OTHER) },                  // conflict involving me
    { id: 5, metadata: meta(OTHER) },                                    // foreign
    { id: 6, notes: 'Front desk staff' },                                // no marker, operator text
    { id: 7 },                                                           // no marker, linked to a member
    { id: 8, metadata: meta(ME, '2026-05-13T00:00:00Z'), notes: notes(ME, '2026-05-14T00:00:00Z') }, // agree, ts differ
    { id: 9, metadata: meta(OTHER), notes: notes('client-third') },      // conflict not involving me → foreign
  ];
  const c = classifyUsers(users, ME, new Set(['7', '1']));

  test('every user lands in exactly one ownership bucket', () => {
    expect(c.total).toBe(9);
    expect(idsOf(c.agree)).toEqual(['1', '8']);
    expect(idsOf(c.metadataOnly)).toEqual(['2']);
    expect(idsOf(c.notesOnly)).toEqual(['3']);
    expect(idsOf(c.conflict)).toEqual(['4']);
    expect(idsOf(c.foreign)).toEqual(['5', '9']);
    expect(idsOf(c.none)).toEqual(['6', '7']);
  });

  test('backfill carries the notes marker\'s own timestamp', () => {
    expect(c.notesOnly[0]).toEqual({ id: '3', createdAt: '2026-06-01T10:00:00Z' });
  });

  test('a member-linked user with no marker is reported, never offered to backfill', () => {
    expect(idsOf(c.noneLinked)).toEqual(['7']);
    expect(idsOf(c.notesOnly)).not.toContain('7');
  });

  test('conflicts name both clients; timestamp drift is informational only', () => {
    expect(c.conflict[0]).toEqual({ id: '4', metadataClientId: ME, notesClientId: OTHER });
    expect(c.createdAtDiffers).toEqual([{ id: '8', metadata: '2026-05-13T00:00:00Z', notes: '2026-05-14T00:00:00Z' }]);
  });

  test('ready for phase 2 only when nothing is notes-only or conflicting', () => {
    const done = classifyUsers([
      { id: 1, metadata: meta(ME), notes: notes(ME) },
      { id: 2, metadata: meta(ME) },
      { id: 3 },
    ], ME);
    expect(done.notesOnly).toHaveLength(0);
    expect(done.conflict).toHaveLength(0);
  });
});
