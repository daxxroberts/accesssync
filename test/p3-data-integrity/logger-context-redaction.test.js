/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: logger auto-reads ALS context + redaction is applied         │
 * │                                                                         │
 * │  Business consequence: If trace_id / actor fields don't auto-propagate, │
 * │  log rows are unqueryable. If redaction fails, secrets or PII reach     │
 * │  Railway logs or diagnostic_log — credibility-ending at HOG launch.    │
 * │                                                                         │
 * │  Governed by: DR-037 (auto-context), DR-039 (redaction)                │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const db = require('../../db');
const { runWith, mintTraceId } = require('../../core/trace-context');
const { log, withTrace }       = require('../../core/logger');
const { REDACTED, REDACTED_RUNTIME } = require('../../core/log-redaction');

// Capture stdout writes
let stdoutLines = [];
let originalWrite;

beforeAll(() => {
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    if (typeof chunk === 'string' && chunk.trim().startsWith('{')) {
      stdoutLines.push(JSON.parse(chunk.trim()));
    }
    return true;
  };
});

afterAll(() => {
  process.stdout.write = originalWrite;
});

beforeEach(() => {
  stdoutLines = [];
  db.query.mockClear();
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
});

afterEach(() => {
  jest.useRealTimers();
});

const ACTOR_OPERATOR = { type: 'operator', id: 'test@accesssync.io' };

// ── Auto-context from ALS ─────────────────────────────────────────────────────

describe('[P3] logger: auto-context from ALS (DR-037)', () => {

  test('emit picks up trace_id from ALS automatically', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_OPERATOR }, async () => {
      log.info('test.event', { clientId: 'c1' });
    });

    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0].traceId).toBe(traceId);
  });

  test('emit picks up actor_type and actor_id from ALS automatically', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_OPERATOR }, async () => {
      log.info('test.event', {});
    });

    expect(stdoutLines[0].actor_type).toBe('operator');
    expect(stdoutLines[0].actor_id).toBe('test@accesssync.io');
  });

  test('emit works with no ALS context — no crash, no traceId, no actor', () => {
    // Called outside any runWith
    expect(() => log.info('test.event.no.context', { clientId: 'c1' })).not.toThrow();
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0].traceId).toBeUndefined();
    expect(stdoutLines[0].actor_type).toBeUndefined();
  });

  test('explicit traceId arg via withTrace overrides ALS', async () => {
    const alsTraceId      = mintTraceId();
    const explicitTraceId = mintTraceId();

    await runWith({ traceId: alsTraceId, actor: ACTOR_OPERATOR }, async () => {
      const logger = withTrace(explicitTraceId);
      logger.info('test.event', {});
    });

    expect(stdoutLines[0].traceId).toBe(explicitTraceId);
  });

  test('withTrace still works with no ALS context (legacy path)', () => {
    const traceId = mintTraceId();
    const logger  = withTrace(traceId);
    expect(() => logger.info('test.legacy', {})).not.toThrow();
    expect(stdoutLines[0].traceId).toBe(traceId);
  });

});

// ── Redaction — allowlist (Layer 1) ──────────────────────────────────────────

describe('[P3] logger: redaction — allowlist layer (DR-039)', () => {

  test('redacts hardware_api_key at top level', () => {
    log.info('config.test', { hardware_api_key: 'actual-secret-key-abc123', clientId: 'c1' });
    expect(stdoutLines[0].hardware_api_key).toBe(REDACTED);
    expect(stdoutLines[0].clientId).toBe('c1');
  });

  test('redacts nested sensitive fields (e.g. config.hardware_api_key)', () => {
    log.info('config.test', { config: { hardware_api_key: 'secret', door: 'entrance' } });
    expect(stdoutLines[0].config.hardware_api_key).toBe(REDACTED);
    expect(stdoutLines[0].config.door).toBe('entrance');
  });

  test('redacts PII email field (DR-001)', () => {
    log.info('member.test', { email: 'member@gym.com', memberId: 'abc-123' });
    expect(stdoutLines[0].email).toBe(REDACTED);
    expect(stdoutLines[0].memberId).toBe('abc-123');
  });

  test('redacts auth token field', () => {
    log.info('auth.test', { token: 'eyJsome.jwt.token', userId: 'u1' });
    expect(stdoutLines[0].token).toBe(REDACTED);
  });

});

// ── Redaction — regex backstop (Layer 2) ─────────────────────────────────────

describe('[P3] logger: redaction — runtime regex backstop (DR-039)', () => {

  test('redacts Resend API key embedded in a message string', () => {
    log.info('email.test', { message: 'Resend failed: re_abc1234567890123456789012' });
    expect(stdoutLines[0].message).toContain(REDACTED_RUNTIME);
    expect(stdoutLines[0].message).not.toContain('re_abc');
  });

  test('redacts JWT shape via regex backstop', () => {
    log.info('auth.test', { details: 'token=eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SomeSignatureHere123456' });
    expect(stdoutLines[0].details).toContain(REDACTED_RUNTIME);
  });

  test('redacts Bearer token via regex backstop', () => {
    log.info('auth.test', { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SomeSignatureHere123456' });
    // 'authorization' is in allowlist → Layer 1 catches it first
    expect(stdoutLines[0].authorization).toBe(REDACTED);
  });

  test('redacts array values containing secrets via regex', () => {
    log.info('test', { keys: ['re_abc1234567890123456789012', 'safe-string'] });
    expect(stdoutLines[0].keys[0]).toContain(REDACTED_RUNTIME);
    expect(stdoutLines[0].keys[1]).toBe('safe-string');
  });

});

// ── diagnostic_log persistence — actor columns ────────────────────────────────

describe('[P3] logger: diagnostic_log writes actor columns (DR-037)', () => {

  test('persistToDiagnosticLog includes actor_type and actor_id', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_OPERATOR }, async () => {
      log.error('hardware.api.failed', { clientId: 'c1' }, new Error('timeout'));
    });

    // Let setImmediate flush
    await new Promise(resolve => setImmediate(resolve));

    expect(db.query).toHaveBeenCalled();
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toContain('actor_type');
    expect(sql).toContain('actor_id');
    // actor_type is $8, actor_id is $9
    expect(params[7]).toBe('operator');
    expect(params[8]).toBe('test@accesssync.io');
  });

  test('persistToDiagnosticLog writes NULL actor columns when no context', async () => {
    log.error('hardware.api.failed', { clientId: 'c1' }, new Error('timeout'));

    await new Promise(resolve => setImmediate(resolve));

    expect(db.query).toHaveBeenCalled();
    const [, params] = db.query.mock.calls[0];
    expect(params[7]).toBeNull();
    expect(params[8]).toBeNull();
  });

  test('persistToDiagnosticLog includes trace_id when ALS context present', async () => {
    const traceId = mintTraceId();
    await runWith({ traceId, actor: ACTOR_OPERATOR }, async () => {
      log.warn('test.warn', { clientId: 'c2' });
    });

    await new Promise(resolve => setImmediate(resolve));

    const [, params] = db.query.mock.calls[0];
    expect(params[6]).toBe(traceId);
  });

});
