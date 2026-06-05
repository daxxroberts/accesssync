/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING                                                │
 * │  Scenario: OB-240 — source-level pending_hardware retry probe          │
 * │                                                                         │
 * │  Covers:                                                                │
 * │    - Selection query includes the four filter conditions:               │
 * │        status enum, parent access.status='active', retry_count<3,       │
 * │        staleness                                                         │
 * │    - pending_start with future scheduled_start_date is excluded         │
 * │    - Success path: UPDATE flips status='active', stamps                 │
 * │      role_assignment_id, recomputes parent access rollup                │
 * │    - Failure path: UPDATE bumps retry_count, writes failure_reason     │
 * │    - Exhaustion (retry_count 2 → 3): status='failed' AND error_queue   │
 * │      row INSERTed with code='SOURCE_RETRY_EXHAUSTED'                    │
 * │    - Members with NULL hardware_user_id are skipped (no assignRole)    │
 * │    - One row failing does not abort the batch                           │
 * │                                                                         │
 * │  DR-023 carve-out: the probe writes directly to member_access_sources  │
 * │  rather than routing through standard-adapter.completeGrant — recovery │
 * │  primitive only, see core/source-retry-probe.js header.                 │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({ query: jest.fn() }));

jest.mock('../../adapters/hardware-adapter', () => ({
  assignRole: jest.fn(),
}));

jest.mock('../../core/crypto-utils', () => ({
  decryptApiKey: jest.fn(enc => `plain-${enc}`),
}));

jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), critical: jest.fn() },
}));

jest.mock('../../core/trace-context', () => ({
  runWith:     jest.fn((ctx, fn) => fn()),
  mintTraceId: jest.fn(() => 'trace-ob240-001'),
  getTraceId:  jest.fn(() => 'trace-ob240-001'),
  getActor:    jest.fn(() => ({ type: 'system', id: 'source-retry-probe-cron' })),
}));

const db              = require('../../db');
const hardwareAdapter = require('../../adapters/hardware-adapter');
const { log }         = require('../../core/logger');
const { runProbe }    = require('../../core/source-retry-probe');

const CLIENT_ID   = 'client-hog-001';
const ACCESS_ID   = 'ma-uuid-001';
const SOURCE_ID_A = 'mas-uuid-001';
const SOURCE_ID_B = 'mas-uuid-002';
const MM_ID       = 'mm-uuid-001';
const HW_USER_ID  = '100560021';
const GROUP_ID    = '838622';

function candidateRow(overrides = {}) {
  return {
    source_id:           SOURCE_ID_A,
    access_id:           ACCESS_ID,
    client_id:           CLIENT_ID,
    source_status:       'pending_hardware',
    hardware_group_id:   GROUP_ID,
    valid_until:         null,
    retry_count:         0,
    scheduled_start_date: null,
    member_master_id:    MM_ID,
    access_row_id:       ACCESS_ID,
    hardware_user_id:    HW_USER_ID,
    hardware_api_key:    'enc-key',
    hardware_platform:   'kisi',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Selection query shape ────────────────────────────────────────────────

describe('[P2] OB-240 — selection query filters', () => {
  test('selection query includes the four required filter conditions', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // selection — no candidates

    await runProbe();

    const selectionSql = db.query.mock.calls[0][0];
    // Status enum
    expect(selectionSql).toMatch(/mas\.status\s+IN\s*\(\s*'pending_hardware'\s*,\s*'pending_start'\s*\)/i);
    // Parent member_access.status = 'active'
    expect(selectionSql).toMatch(/ma\.status\s*=\s*'active'/i);
    // retry_count < 3 — actually parameterized as $1 with value 3
    expect(selectionSql).toMatch(/mas\.retry_count\s*<\s*\$1/);
    expect(db.query.mock.calls[0][1]).toEqual([3]);
    // Staleness gate
    expect(selectionSql).toMatch(/mas\.last_retry_at\s+IS\s+NULL/i);
    expect(selectionSql).toMatch(/INTERVAL\s+'15 minutes'/);
    // Future-dated pending_start exclusion
    expect(selectionSql).toMatch(/scheduled_start_date\s*<=\s*NOW\(\)/i);
  });
});

// ─── Success path ─────────────────────────────────────────────────────────

describe('[P2] OB-240 — success path', () => {
  test('UPDATE flips status to active and stamps role_assignment_id', async () => {
    db.query
      // 1: selection
      .mockResolvedValueOnce({ rows: [candidateRow()] })
      // 2: UPDATE mas success
      .mockResolvedValueOnce({ rowCount: 1 })
      // 3: count active siblings (rollup)
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })
      // 4: UPDATE member_access rollup
      .mockResolvedValueOnce({ rowCount: 1 });

    hardwareAdapter.assignRole.mockResolvedValueOnce({ roleAssignmentId: 'kisi-ra-99' });

    await runProbe();

    // Check the UPDATE mas success query
    const successUpdate = db.query.mock.calls[1];
    expect(successUpdate[0]).toMatch(/UPDATE\s+member_access_sources/i);
    expect(successUpdate[0]).toMatch(/status\s*=\s*'active'/i);
    expect(successUpdate[0]).toMatch(/role_assignment_id\s*=\s*\$2/);
    expect(successUpdate[0]).toMatch(/retry_count\s*=\s*retry_count\s*\+\s*1/i);
    expect(successUpdate[0]).toMatch(/failure_reason\s*=\s*NULL/i);
    expect(successUpdate[1]).toEqual([SOURCE_ID_A, 'kisi-ra-99']);

    // Parent rollup recompute
    const rollupUpdate = db.query.mock.calls[3];
    expect(rollupUpdate[0]).toMatch(/UPDATE\s+member_access/i);
    expect(rollupUpdate[1]).toEqual([ACCESS_ID, 'active']);

    expect(log.info).toHaveBeenCalledWith(
      'source_retry.success',
      expect.objectContaining({ sourceId: SOURCE_ID_A, parentStatus: 'active' })
    );
  });

  test('parent rollup flips to inactive when no active siblings remain', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [candidateRow()] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // no active siblings — shouldn't happen on success but tests rollup logic
      .mockResolvedValueOnce({ rowCount: 1 });
    hardwareAdapter.assignRole.mockResolvedValueOnce({ roleAssignmentId: 'ra-1' });

    await runProbe();

    expect(db.query.mock.calls[3][1]).toEqual([ACCESS_ID, 'inactive']);
  });
});

// ─── Failure path (not yet exhausted) ─────────────────────────────────────

describe('[P2] OB-240 — failure path (retries remain)', () => {
  test('UPDATE bumps retry_count and writes failure_reason; status NOT flipped', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [candidateRow({ retry_count: 1 })] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const err = new Error('Kisi 500 transient');
    hardwareAdapter.assignRole.mockRejectedValueOnce(err);

    await runProbe();

    const failureUpdate = db.query.mock.calls[1];
    expect(failureUpdate[0]).toMatch(/UPDATE\s+member_access_sources/i);
    expect(failureUpdate[0]).toMatch(/retry_count\s*=\s*retry_count\s*\+\s*1/i);
    expect(failureUpdate[0]).toMatch(/failure_reason\s*=\s*\$2/);
    // status NOT in the SET list
    expect(failureUpdate[0]).not.toMatch(/SET[\s\S]*status\s*=/i);
    expect(failureUpdate[1]).toEqual([SOURCE_ID_A, 'Kisi 500 transient']);

    expect(log.warn).toHaveBeenCalledWith(
      'source_retry.failed',
      expect.objectContaining({ recoverable: true, retryCount: 2 }),
      err
    );
  });

  test('failure_reason is truncated to 500 chars', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [candidateRow({ retry_count: 0 })] })
      .mockResolvedValueOnce({ rowCount: 1 });

    const longMsg = 'x'.repeat(2000);
    hardwareAdapter.assignRole.mockRejectedValueOnce(new Error(longMsg));

    await runProbe();

    const failureUpdate = db.query.mock.calls[1];
    expect(failureUpdate[1][1].length).toBe(500);
  });
});

// ─── Exhaustion ───────────────────────────────────────────────────────────

describe('[P2] OB-240 — exhaustion (retry_count 2 → 3)', () => {
  test('status=failed AND error_queue INSERT fires with SOURCE_RETRY_EXHAUSTED', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [candidateRow({ retry_count: 2 })] })
      .mockResolvedValueOnce({ rowCount: 1 }) // UPDATE mas (failed)
      .mockResolvedValueOnce({ rowCount: 1 }); // INSERT error_queue

    const err = new Error('Kisi 401 invalid key');
    hardwareAdapter.assignRole.mockRejectedValueOnce(err);

    await runProbe();

    const failedUpdate = db.query.mock.calls[1];
    expect(failedUpdate[0]).toMatch(/UPDATE\s+member_access_sources/i);
    expect(failedUpdate[0]).toMatch(/status\s*=\s*'failed'/i);

    const errorQueueInsert = db.query.mock.calls[2];
    expect(errorQueueInsert[0]).toMatch(/INSERT\s+INTO\s+error_queue/i);
    const params = errorQueueInsert[1];
    expect(params).toContain(CLIENT_ID);
    expect(params).toContain(ACCESS_ID);
    expect(params).toContain('SOURCE_RETRY_EXHAUSTED');
    // payload is JSON-encoded — find by parsing
    const payload = params.find(p => typeof p === 'string' && p.startsWith('{'));
    expect(payload).toBeTruthy();
    const parsed = JSON.parse(payload);
    expect(parsed.sourceId).toBe(SOURCE_ID_A);
    expect(parsed.hardwareGroupId).toBe(GROUP_ID);
    expect(parsed.retryCount).toBe(3);

    expect(log.error).toHaveBeenCalledWith(
      'source_retry.exhausted',
      expect.objectContaining({ retryCount: 3 }),
      err
    );
  });
});

// ─── NULL hardware_user_id skip ───────────────────────────────────────────

describe('[P2] OB-240 — skipped_no_kisi_user', () => {
  test('member with NULL hardware_user_id is skipped — no assignRole call', async () => {
    db.query.mockResolvedValueOnce({
      rows: [candidateRow({ hardware_user_id: null })],
    });

    await runProbe();

    expect(hardwareAdapter.assignRole).not.toHaveBeenCalled();
    // No UPDATEs to mas (only the selection query ran)
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'source_retry.skipped_no_kisi_user',
      expect.objectContaining({ sourceId: SOURCE_ID_A })
    );
  });
});

// ─── Batch resilience ─────────────────────────────────────────────────────

describe('[P2] OB-240 — one failing row does not abort the batch', () => {
  test('next row still processed after first row throws', async () => {
    const rowA = candidateRow({ source_id: SOURCE_ID_A, retry_count: 0 });
    const rowB = candidateRow({ source_id: SOURCE_ID_B, access_id: 'ma-uuid-002', retry_count: 0 });

    db.query
      .mockResolvedValueOnce({ rows: [rowA, rowB] }) // selection
      // Row A: failure path — UPDATE fails to simulate DB error
      .mockRejectedValueOnce(new Error('db update boom — row A'))
      // Row B: success path
      .mockResolvedValueOnce({ rowCount: 1 })        // UPDATE mas active
      .mockResolvedValueOnce({ rows: [{ n: 1 }] })   // siblings count
      .mockResolvedValueOnce({ rowCount: 1 });       // UPDATE access rollup

    hardwareAdapter.assignRole
      .mockRejectedValueOnce(new Error('Kisi network — row A'))
      .mockResolvedValueOnce({ roleAssignmentId: 'ra-row-b' });

    await runProbe();

    // Both rows should have had their candidate_found log emitted
    const candidateLogs = log.info.mock.calls.filter(c => c[0] === 'source_retry.candidate_found');
    expect(candidateLogs.length).toBe(2);

    // Row B success log emitted despite row A blowing up
    expect(log.info).toHaveBeenCalledWith(
      'source_retry.success',
      expect.objectContaining({ sourceId: SOURCE_ID_B })
    );

    // Row A surfaced an unhandled-error log
    expect(log.error).toHaveBeenCalledWith(
      'source_retry.row_unhandled_error',
      expect.objectContaining({ sourceId: SOURCE_ID_A }),
      expect.any(Error)
    );
  });
});

// ─── Future-dated pending_start exclusion ────────────────────────────────

describe('[P2] OB-240 — pending_start future-dated exclusion', () => {
  test('the SQL filter excludes pending_start rows with future scheduled_start_date', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });

    await runProbe();

    const sql = db.query.mock.calls[0][0];
    // The combined OR-condition: NOT pending_start OR scheduled_start_date IS NULL OR <= NOW()
    expect(sql).toMatch(/mas\.status\s*<>\s*'pending_start'/i);
    expect(sql).toMatch(/mas\.scheduled_start_date\s+IS\s+NULL/i);
    expect(sql).toMatch(/mas\.scheduled_start_date\s*<=\s*NOW\(\)/i);
  });
});

// ─── Run-level logs ───────────────────────────────────────────────────────

describe('[P2] OB-240 — run lifecycle logs', () => {
  test('emits run_start and run_complete', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await runProbe();
    expect(log.info).toHaveBeenCalledWith('source_retry.run_start', expect.any(Object));
    expect(log.info).toHaveBeenCalledWith(
      'source_retry.run_complete',
      expect.objectContaining({ candidates: 0, succeeded: 0, failed: 0, exhausted: 0 })
    );
  });
});
