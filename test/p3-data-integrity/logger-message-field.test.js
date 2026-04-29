/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: every log emit has a top-level `message` field               │
 * │                                                                         │
 * │  Business consequence: Railway's log viewer keys off `message`. Without │
 * │  it, the message column is blank for every error and operators cannot   │
 * │  scan logs to triage incidents — slows incident response.               │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

jest.mock('../../db', () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
}));

const { log } = require('../../core/logger');

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
});

describe('[P3] logger: top-level message field for Railway aggregator', () => {

  test('error with Error object surfaces err.message at top level', () => {
    const err = new Error('QUEUE_JOB_MISSING_TRACE_ID');
    log.error('queue.job.exhausted', { jobId: 'x', jobName: 'revoke' }, err);
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0].message).toBe('QUEUE_JOB_MISSING_TRACE_ID');
    expect(stdoutLines[0].event).toBe('queue.job.exhausted');
  });

  test('info without error falls back to event name', () => {
    log.info('reconciliation.sweep_start', { result: 'start' });
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0].message).toBe('reconciliation.sweep_start');
  });

  test('caller-provided ctx.message wins over event and err.message', () => {
    log.error('queue.job.exhausted', { message: 'custom phrase', jobId: 'x' }, new Error('boom'));
    expect(stdoutLines[0].message).toBe('custom phrase');
  });

  test('warn without error falls back to event name', () => {
    log.warn('reconciliation.sanity_gate_triggered', { clientId: 'c1' });
    expect(stdoutLines[0].message).toBe('reconciliation.sanity_gate_triggered');
  });
});
