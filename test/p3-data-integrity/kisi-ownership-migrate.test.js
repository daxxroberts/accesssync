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
jest.mock('../../adapters/kisi/kisi-connector', () => ({ makeRequest: jest.fn() }));

const kisiConnector = require('../../adapters/kisi/kisi-connector');
const kisiAdapter = require('../../adapters/kisi/kisi-adapter');
const { classifyUsers, notesClearDecision, clearNotes } = require('../../scripts/kisi-ownership-migrate');

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

  test('a marker line with operator text under it still counts as ours (backfilled, then left as "mixed" by clear-notes)', () => {
    const r = classifyUsers([{ id: 10, notes: notes(ME) + '\nVIP — comps on Fridays' }], ME);
    expect(idsOf(r.notesOnly)).toEqual(['10']);
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

describe('[P3] kisi-ownership-migrate clear-notes', () => {
  beforeEach(() => jest.clearAllMocks());

  test('clears only an exact AccessSync line for this client, and only when metadata names this client', () => {
    expect(notesClearDecision({ metadata: meta(ME), notes: notes(ME) }, ME)).toBe('clear');
    expect(notesClearDecision({ notes: notes(ME) }, ME)).toBe('needs_backfill');
    expect(notesClearDecision({ metadata: meta(OTHER), notes: notes(ME) }, ME)).toBe('needs_backfill');
    expect(notesClearDecision({ metadata: meta(ME), notes: notes(ME) + '\nVIP — comps on Fridays' }, ME)).toBe('mixed');
    expect(notesClearDecision({ metadata: meta(ME), notes: notes(OTHER) }, ME)).toBe('foreign');
    expect(notesClearDecision({ metadata: meta(ME), notes: 'Front desk staff' }, ME)).toBe('operator_text');
    expect(notesClearDecision({ metadata: meta(ME), notes: '   ' }, ME)).toBe('empty');
    expect(notesClearDecision({ metadata: meta(ME) }, ME)).toBe('empty');
  });

  test('re-checks on a fresh read, PATCHes notes:null only, and confirms metadata survived', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 3, metadata: meta(ME), notes: notes(ME) })   // fresh GET
      .mockResolvedValueOnce(undefined)                                         // PATCH
      .mockResolvedValueOnce({ id: 3, metadata: meta(ME), notes: null });       // re-GET
    await expect(clearNotes('key', '3', ME)).resolves.toBe('cleared');
    const [endpoint, opts] = kisiConnector.makeRequest.mock.calls[1];
    expect(endpoint).toBe('/users/3');
    expect(opts.method).toBe('PATCH');
    expect(JSON.parse(opts.body)).toEqual({ user: { notes: null } });
  });

  test('an operator edit between list and clear is respected: no PATCH', async () => {
    kisiConnector.makeRequest.mockResolvedValueOnce({ id: 3, metadata: meta(ME), notes: notes(ME) + '\nkeep this' });
    await expect(clearNotes('key', '3', ME)).resolves.toMatch(/^skipped \(mixed/);
    expect(kisiConnector.makeRequest).toHaveBeenCalledTimes(1);
  });

  test('a re-read that lost the metadata marker is a failure, not a success', async () => {
    kisiConnector.makeRequest
      .mockResolvedValueOnce({ id: 3, metadata: meta(ME), notes: notes(ME) })
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 3, metadata: {}, notes: null });
    await expect(clearNotes('key', '3', ME)).rejects.toThrow(/metadata marker missing/);
  });
});
