/**
 * PRIORITY 3 — every log row says which client it belongs to.
 *
 * Before: diagnostic_log.client_id came only from a ctx field each call site had to remember to pass.
 * The Kisi connector's HTTP error log never receives the tenant, so 28 errors and 350 warnings a day
 * had client_id NULL and appeared on no client's health card. The client is now carried by the trace
 * context (queue job, webhook, admin request, per-client sweep), picked up by the logger, and — for a
 * row that still has none — filled from trace_context at INSERT time.
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
const db = require('../../db');
const { log } = require('../../core/logger');
const tc = require('../../core/trace-context');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const actor = { type: 'system', id: 'test' };
const flush = () => new Promise(r => setImmediate(r));
const inserts = () => db.query.mock.calls.filter(c => String(c[0]).includes('INSERT INTO diagnostic_log'));
const clientOfLastRow = () => { const r = inserts(); return r[r.length - 1][1][0]; };

beforeEach(() => db.query.mockClear());

describe('[P3] trace context carries the client', () => {
  test('runWith({ clientId }) binds it; getClientId reads it; no context → undefined', () => {
    expect(tc.getClientId()).toBeUndefined();
    tc.runWith({ traceId: 't1', actor, clientId: A }, () => expect(tc.getClientId()).toBe(A));
    tc.runWith({ traceId: 't1', actor }, () => expect(tc.getClientId()).toBeUndefined());
  });

  test('setClientId binds it after the fact (webhook tenant resolves late); no-op outside a context', () => {
    expect(() => tc.setClientId(A)).not.toThrow();
    tc.runWith({ traceId: 't2', actor }, () => { tc.setClientId(B); expect(tc.getClientId()).toBe(B); });
  });

  test('only a real uuid is accepted: a mistyped path param can never break the log INSERT (uuid column)', () => {
    tc.runWith({ traceId: 't3', actor, clientId: 'not-a-uuid' }, () => expect(tc.getClientId()).toBeUndefined());
    tc.runWith({ traceId: 't3', actor }, () => {
      tc.setClientId('../../etc'); tc.setClientId(''); tc.setClientId(null); tc.setClientId(42);
      expect(tc.getClientId()).toBeUndefined();
    });
  });

  test('withClient: child context keeps trace + actor, is bound to ONE client, and the parent is untouched', async () => {
    await tc.runWith({ traceId: 'sweep', actor }, async () => {
      await tc.withClient(A, async () => {
        expect(tc.getTraceId()).toBe('sweep');
        expect(tc.getActor()).toEqual(actor);
        expect(tc.getClientId()).toBe(A);
      });
      expect(tc.getClientId()).toBeUndefined();          // back in the sweep-level context
    });
  });

  test('two clients interleaving across awaits never see each other\'s id (no cross-tenant stamping)', async () => {
    const seen = [];
    const work = (id, ms) => tc.withClient(id, async () => {
      seen.push([id, tc.getClientId()]);
      await new Promise(r => setTimeout(r, ms));
      seen.push([id, tc.getClientId()]);
    });
    await tc.runWith({ traceId: 'sweep', actor }, () => Promise.all([work(A, 15), work(B, 5)]));
    for (const [expected, actual] of seen) expect(actual).toBe(expected);
    expect(seen).toHaveLength(4);
  });

  test('withClient with no context, or a bad id, just runs the function', () => {
    expect(tc.withClient(A, () => 'ran')).toBe('ran');
    tc.runWith({ traceId: 't4', actor }, () => expect(tc.withClient('nope', () => tc.getClientId())).toBeUndefined());
  });
});

describe('[P3] the logger stamps the client on diagnostic_log rows', () => {
  test('a call site that never passes the client (the Kisi connector) still lands on the right client', async () => {
    await tc.runWith({ traceId: 'job-1', actor, clientId: A }, async () => {
      log.error('kisi.response.error', { method: 'POST', endpoint: '/users', statusCode: 422 });   // no clientId in ctx
    });
    await flush();
    expect(clientOfLastRow()).toBe(A);
  });

  test('an explicit ctx client wins over the context', async () => {
    tc.runWith({ traceId: 'job-2', actor, clientId: A }, () => log.warn('some.event', { clientId: B }));
    await flush();
    expect(clientOfLastRow()).toBe(B);
  });

  test('tenantId (the other convention) also wins', async () => {
    tc.runWith({ traceId: 'job-3', actor, clientId: A }, () => log.warn('some.event', { tenantId: B }));
    await flush();
    expect(clientOfLastRow()).toBe(B);
  });

  test('two different clients\' jobs in flight each stamp their own rows', async () => {
    await Promise.all([A, B].map((id, i) => tc.runWith({ traceId: `job-${i}`, actor, clientId: id }, async () => {
      await new Promise(r => setTimeout(r, i ? 1 : 10));
      log.error('kisi.response.error', { statusCode: 500 });
    })));
    await flush();
    expect(inserts().map(c => c[1][0]).sort()).toEqual([A, B]);
  });

  test('no client anywhere: the row falls back to trace_context at INSERT time (and never invents one)', async () => {
    tc.runWith({ traceId: 'job-5', actor }, () => log.error('kisi.response.error', { statusCode: 500 }));
    await flush();
    const [sql, params] = inserts()[0];
    expect(params[0]).toBeNull();                                            // nothing invented
    expect(params[6]).toBe('job-5');                                         // trace id is $7
    expect(sql).toMatch(/COALESCE\(\$1::uuid, \(SELECT tc\.client_id FROM trace_context tc WHERE tc\.trace_id = \$7::text LIMIT 1\)\)/);
  });
});

describe('[P3] the sweep trace is never attributed through trace_context', () => {
  test('a client-less row written by the nightly sweep actor uses the PLAIN client param (no trace_context fallback)', async () => {
    const sweepActor = { type: 'system', id: 'reconciliation-railway-cron' };
    tc.runWith({ traceId: 'sweep-1', actor: sweepActor }, () => log.error('kisi.response.error', { statusCode: 500 }));
    await flush();
    const [sql, params] = inserts()[0];
    expect(sql).not.toMatch(/trace_context/);
    expect(sql).toMatch(/VALUES \(\$1::uuid,/);
    expect(params[0]).toBeNull();                                   // stays client-less: no wrong-tenant stamp
  });

  test('...but a sweep row whose call site names the client (or that runs inside withClient) still carries it', async () => {
    const sweepActor = { type: 'system', id: 'reconciliation-railway-cron' };
    await tc.runWith({ traceId: 'sweep-2', actor: sweepActor }, async () => {
      await tc.withClient(A, async () => { log.error('some.event', { statusCode: 500 }); });
      log.error('other.event', { clientId: B });
    });
    await flush();
    expect(inserts().map(c => c[1][0]).sort()).toEqual([A, B]);
  });

  test('every other actor keeps the fallback', async () => {
    tc.runWith({ traceId: 'job-9', actor: { type: 'system', id: 'queue-worker' } }, () => log.error('kisi.response.error', {}));
    await flush();
    expect(inserts()[0][0]).toMatch(/trace_context/);
  });
});

describe('[P3] the entry points bind the client', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');

  test('queue worker: the job context carries the job\'s tenant', () => {
    expect(read('core/queue-worker.js')).toMatch(/actor: \{ type: 'system', id: 'queue-worker' \}, clientId: tenantId \|\| null \},\s*\(\) => _processJobBody/);
  });

  test('admin requests: the trace middleware binds the resolved client', () => {
    expect(read('admin/middleware/trace-context.js')).toMatch(/runWith\(\{ traceId, actor, clientId \}/);
  });

  test('nightly sweep: each client\'s work runs in withClient(); manual sync and reconcileMember bind their client', () => {
    const src = read('core/reconciliation.js');
    expect(src).toMatch(/await withClient\(client\.id, \(\) => this\._syncClient\(client,/);
    expect(src).toMatch(/actor: \{ type: 'system', id: 'reconcileMember' \}, clientId \}/);
    expect(read('admin/routes/operator.js')).toMatch(/actor: \{ type: 'operator', id: String\(operatorActor\) \}, clientId \}/);
  });
});
