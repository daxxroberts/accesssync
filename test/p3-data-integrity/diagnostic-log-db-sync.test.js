/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: diagnostic_log DB write stays in sync with log output        │
 * │                                                                         │
 * │  Business consequence: If actor_type/actor_id are not written to DB,   │
 * │  v_trace_timeline queries by actor are useless. If trace_id is missing  │
 * │  in the DB row, cross-service timeline reconstruction breaks. These    │
 * │  columns must mirror the stdout log line exactly.                       │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

// We need the real logger but with a mock db so we can inspect DB writes.
// The logger lazy-requires db via getDb() — we mock the module before require.
jest.mock('../../db', () => ({ query: jest.fn() }));

const db             = require('../../db');
const { log }        = require('../../core/logger');
const { runWith, mintTraceId } = require('../../core/trace-context');

// Capture stdout
let stdoutLines = [];
let originalWrite;

beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      try { stdoutLines.push(JSON.parse(chunk.trim())); } catch {}
    }
    return true;
  };
});

afterAll(() => { process.stdout.write = originalWrite; });

beforeEach(() => {
  stdoutLines = [];
  jest.clearAllMocks();
  db.query.mockResolvedValue({ rows: [] });
});

/**
 * Wait for the setImmediate in persistToDiagnosticLog to fire.
 * One microtask tick after the current event-loop turn isn't enough;
 * we need at least one full macrotask flush.
 */
function flushImmediate() {
  return new Promise(resolve => setImmediate(resolve));
}

// ── Column presence and correctness ──────────────────────────────────────────

describe('[P3] diagnostic_log: column values mirror log context (DR-037)', () => {

  test('warn log inserts actor_type and actor_id columns from ALS context', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'operator', id: 'test@example.com' } }, async () => {
      log.warn('test.warn.event', { clientId: 'c-1' });
    });
    await flushImmediate();

    expect(db.query).toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO diagnostic_log/);
    // $8 = actor_type, $9 = actor_id
    expect(params[7]).toBe('operator');
    expect(params[8]).toBe('test@example.com');
  });

  test('error log inserts trace_id column from ALS context', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
      log.error('test.error.event', { clientId: 'c-1' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    // $7 = trace_id
    expect(params[6]).toBe(traceId);
  });

  test('critical log inserts level=critical into DB', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'queue-worker' } }, async () => {
      log.critical('test.critical.event', { clientId: 'c-1' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    // $3 = level
    expect(params[2]).toBe('critical');
  });

  test('info log does NOT write to diagnostic_log (info is stdout only)', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'operator', id: 'op-1' } }, async () => {
      log.info('test.info.event', { clientId: 'c-1' });
    });
    await flushImmediate();

    expect(db.query).not.toHaveBeenCalled();
  });

  test('debug log does NOT write to diagnostic_log', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'test' } }, async () => {
      log.debug('test.debug.event', { clientId: 'c-1' });
    });
    await flushImmediate();

    expect(db.query).not.toHaveBeenCalled();
  });

  test('DB write uses NULL actor columns when no ALS context exists', async () => {
    // Call outside any runWith
    log.warn('test.no_context.event', { clientId: 'c-1' });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[7]).toBeNull(); // actor_type
    expect(params[8]).toBeNull(); // actor_id
  });

  test('DB write uses NULL trace_id when no ALS context exists', async () => {
    log.error('test.no_trace.event', { clientId: 'c-1' });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[6]).toBeNull(); // trace_id
  });

  test('clientId is mapped to $1 in DB insert from tenantId ctx field', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.warn('test.client_mapping', { tenantId: 'tenant-abc' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe('tenant-abc'); // client_id
  });

  test('clientId falls back to ctx.clientId when tenantId absent', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.warn('test.clientid_fallback', { clientId: 'client-xyz' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[0]).toBe('client-xyz');
  });

  test('service is derived from event prefix (queue → queue-worker)', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('queue.job.failed', { clientId: 'c-1' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[1]).toBe('queue-worker'); // service
  });

  test('service is derived from event prefix (grant → grant-revoke)', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('grant.role.failed', { clientId: 'c-1' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[1]).toBe('grant-revoke');
  });

  test('DB write failure is caught and emits logger.diagnostic_log_write_failed to stdout', async () => {
    db.query.mockRejectedValueOnce(new Error('connection refused'));
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('test.db_fail', { clientId: 'c-1' });
    });
    await flushImmediate();
    await flushImmediate(); // give the .catch() callback another tick

    const dbFailLog = stdoutLines.find(l => l.event === 'logger.diagnostic_log_write_failed');
    expect(dbFailLog).toBeDefined();
    expect(dbFailLog.level).toBe('error');
  });

  test('stdout log line and DB trace_id param are the same value', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'operator', id: 'op-sync' } }, async () => {
      log.error('test.sync_check', { clientId: 'c-1' });
    });
    await flushImmediate();

    const stdoutLine = stdoutLines.find(l => l.event === 'test.sync_check');
    const [, params] = db.query.mock.calls[0];
    expect(stdoutLine.traceId).toBe(traceId);
    expect(params[6]).toBe(traceId);
    expect(stdoutLine.traceId).toBe(params[6]);
  });

  test('stdout actor_type matches DB actor_type column', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'webhook', id: '/webhook/wix' } }, async () => {
      log.warn('test.actor_sync', { clientId: 'c-1' });
    });
    await flushImmediate();

    const stdoutLine = stdoutLines.find(l => l.event === 'test.actor_sync');
    const [, params] = db.query.mock.calls[0];
    expect(stdoutLine.actor_type).toBe('webhook');
    expect(params[7]).toBe('webhook');
  });

  test('redacted context (no sensitive fields) is what is written to DB context column', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('test.redact_in_db', { clientId: 'c-1', hardware_api_key: 'secret-key' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    const context = JSON.parse(params[5]); // $6 = context
    expect(context.hardware_api_key).toBe('[REDACTED]');
  });

});

// ── error_code derivation ─────────────────────────────────────────────────────

describe('[P3] diagnostic_log: error_code derivation', () => {

  test('uses err.code when present (KEDB-aligned codes)', async () => {
    const traceId = mintTraceId();
    const err = new Error('key invalid');
    err.code = 'HARDWARE_KEY_INVALID';

    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('hardware.key_check.failed', { clientId: 'c-1' }, err);
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[3]).toBe('HARDWARE_KEY_INVALID'); // error_code
  });

  test('derives error_code from event name when err.code absent', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.warn('queue.grant.plan_unknown', { clientId: 'c-1' });
    });
    await flushImmediate();

    const [, params] = db.query.mock.calls[0];
    expect(params[3]).toBe('QUEUE_GRANT_PLAN_UNKNOWN');
  });

  test('KEDB entry is included in stdout log when err.code matches KEDB', async () => {
    const traceId = mintTraceId();
    const err = new Error('Unauthorized');
    err.code = 'HARDWARE_KEY_INVALID';

    await runWith({ traceId, actor: { type: 'system', id: 'q' } }, async () => {
      log.error('hw.key.check', { clientId: 'c-1' }, err);
    });

    const stdoutLine = stdoutLines.find(l => l.event === 'hw.key.check');
    expect(stdoutLine.kedb).toBeDefined();
    expect(stdoutLine.kedb.doc).toBe('ERR-101');
  });

});
