/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING                                               │
 * │  Scenario: Middleware actor resolution edge cases + cron ALS isolation  │
 * │                                                                         │
 * │  Business consequence: If the wrong actor type is assigned to an        │
 * │  operator request, audit logs misattribute every action that operator   │
 * │  takes. If two cron runs share trace context, reconciliation diffs      │
 * │  are impossible to attribute. Both paths must be airtight.             │
 * │                                                                         │
 * │  Governed by: DR-037 (Observability Architecture)                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const { resolveActor, traceContextMiddleware } = require('../../admin/middleware/trace-context');
const { runWith, mintTraceId, getTraceId, getActor } = require('../../core/trace-context');

// ── resolveActor — comprehensive input shapes ─────────────────────────────────

describe('[P2] resolveActor: all actor resolution paths', () => {

  const OWNER_EMAIL = 'daxxroberts@gmail.com';

  beforeEach(() => {
    process.env.ADMIN_ALLOWED_EMAIL = OWNER_EMAIL;
  });

  afterEach(() => {
    delete process.env.ADMIN_ALLOWED_EMAIL;
  });

  // Owner path
  test('resolves owner when req.admin.email matches ADMIN_ALLOWED_EMAIL', () => {
    const actor = resolveActor({ admin: { email: OWNER_EMAIL }, path: '/admin/dashboard' });
    expect(actor.type).toBe('owner');
    expect(actor.id).toBe(OWNER_EMAIL);
  });

  // Operator via email (non-owner)
  test('resolves operator when req.admin.email does not match owner email', () => {
    const actor = resolveActor({ admin: { email: 'other-admin@acme.com' }, path: '/admin/members' });
    expect(actor.type).toBe('operator');
    expect(actor.id).toBe('other-admin@acme.com');
  });

  // Operator via role + clientId (no email)
  test('resolves operator with wix: prefix from admin.role + clientId', () => {
    const actor = resolveActor({ admin: { role: 'operator', clientId: 'client-hog-001' }, path: '/' });
    expect(actor.type).toBe('operator');
    expect(actor.id).toBe('wix:client-hog-001');
  });

  // wixOperator path
  test('resolves operator with wix-uid: prefix from wixOperator.uid', () => {
    const actor = resolveActor({ wixOperator: { uid: 'uid-wix-abc' }, path: '/' });
    expect(actor.type).toBe('operator');
    expect(actor.id).toBe('wix-uid:uid-wix-abc');
  });

  // Member path
  test('resolves member from req.member.id', () => {
    const actor = resolveActor({ member: { id: 'member-uuid-001' }, path: '/member/status' });
    expect(actor.type).toBe('member');
    expect(actor.id).toBe('member-uuid-001');
  });

  // Webhook path
  test('resolves webhook actor on /webhook path', () => {
    const actor = resolveActor({ path: '/webhook/wix' });
    expect(actor.type).toBe('webhook');
    expect(actor.id).toBe('/webhook/wix');
  });

  test('resolves webhook actor on /webhook/payments path', () => {
    const actor = resolveActor({ path: '/webhook/payments' });
    expect(actor.type).toBe('webhook');
  });

  // Anonymous fallback
  test('resolves system:anonymous when no auth context present', () => {
    const actor = resolveActor({ path: '/health' });
    expect(actor.type).toBe('system');
    expect(actor.id).toBe('anonymous');
  });

  test('resolves system:anonymous on /sync-status (public member route pre-auth)', () => {
    const actor = resolveActor({ path: '/sync-status' });
    expect(actor.type).toBe('system');
    expect(actor.id).toBe('anonymous');
  });

  // Priority ordering: admin.email beats admin.role
  test('admin.email takes priority over admin.role + clientId', () => {
    const actor = resolveActor({
      admin: { email: OWNER_EMAIL, role: 'operator', clientId: 'c-1' },
      path: '/',
    });
    expect(actor.type).toBe('owner');
    expect(actor.id).toBe(OWNER_EMAIL);
  });

  // Priority: admin beats wixOperator
  test('admin.email takes priority over wixOperator', () => {
    const actor = resolveActor({
      admin: { email: 'op@test.com' },
      wixOperator: { uid: 'wix-uid-should-not-win' },
      path: '/',
    });
    expect(actor.type).toBe('operator');
    expect(actor.id).toBe('op@test.com');
  });

  // Priority: wixOperator beats member
  test('wixOperator takes priority over member', () => {
    const actor = resolveActor({
      wixOperator: { uid: 'wix-uid-abc' },
      member: { id: 'member-should-not-win' },
      path: '/',
    });
    expect(actor.type).toBe('operator');
    expect(actor.id).toBe('wix-uid:wix-uid-abc');
  });

  // Edge: admin object exists but email is missing
  test('admin without email falls through to next priority check', () => {
    const actor = resolveActor({ admin: {}, path: '/admin/dashboard' });
    // No email, no role+clientId → falls to system:anonymous
    expect(actor.type).toBe('system');
    expect(actor.id).toBe('anonymous');
  });

  // Edge: admin.role is operator but clientId is missing
  test('admin.role=operator without clientId falls through', () => {
    const actor = resolveActor({ admin: { role: 'operator' }, path: '/' });
    expect(actor.type).toBe('system');
    expect(actor.id).toBe('anonymous');
  });

});

// ── traceContextMiddleware: inbound x-trace-id validation ─────────────────────

describe('[P2] traceContextMiddleware: x-trace-id header security', () => {

  function runMiddleware(req) {
    return new Promise((resolve) => {
      const res = { setHeader: jest.fn() };
      traceContextMiddleware(req, res, () => {
        resolve({ traceId: getTraceId(), actor: getActor(), res });
      });
    });
  }

  test('uppercase UUID is accepted as valid inbound trace ID', async () => {
    const upperUUID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
    const { traceId } = await runMiddleware({ headers: { 'x-trace-id': upperUUID }, path: '/api/test' });
    expect(traceId.toLowerCase()).toBe(upperUUID.toLowerCase());
  });

  test('UUID with invalid variant digit (version 6) is rejected, fresh ID minted', async () => {
    const invalidVersion = 'aaaaaaaa-aaaa-6aaa-8aaa-aaaaaaaaaaaa';
    const { traceId } = await runMiddleware({ headers: { 'x-trace-id': invalidVersion }, path: '/api/test' });
    expect(traceId.toLowerCase()).not.toBe(invalidVersion.toLowerCase());
  });

  test('null x-trace-id header causes fresh ID mint', async () => {
    const { traceId } = await runMiddleware({ headers: { 'x-trace-id': null }, path: '/api/test' });
    expect(typeof traceId).toBe('string');
    expect(traceId.length).toBeGreaterThan(0);
  });

  test('x-trace-id set to array is rejected, fresh ID minted', async () => {
    const { traceId } = await runMiddleware({
      headers: { 'x-trace-id': ['id1', 'id2'] },
      path: '/api/test',
    });
    // Array.test() would be falsy — should mint fresh
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(traceId).toMatch(UUID_V4);
  });

  test('response header x-trace-id is always set regardless of inbound header', async () => {
    const { res } = await runMiddleware({ headers: {}, path: '/api/test' });
    expect(res.setHeader).toHaveBeenCalledWith('x-trace-id', expect.any(String));
  });

  test('response header matches the trace ID bound in ALS', async () => {
    const { traceId, res } = await runMiddleware({ headers: {}, path: '/api/test' });
    const headerCall = res.setHeader.mock.calls.find(c => c[0] === 'x-trace-id');
    expect(headerCall[1]).toBe(traceId);
  });

});

// ── Cron ALS isolation ────────────────────────────────────────────────────────

describe('[P2] cron ALS isolation: concurrent runs never share trace context', () => {

  test('three concurrent cron runs each see their own traceId', async () => {
    const traces = [mintTraceId(), mintTraceId(), mintTraceId()];
    const actors = [
      { type: 'system', id: 'reconciliation-cron' },
      { type: 'system', id: 'hardware-health-check-cron' },
      { type: 'system', id: 'reconciliation-cron' },
    ];

    const seen = await Promise.all(traces.map((traceId, i) =>
      runWith({ traceId, actor: actors[i] }, async () => {
        await Promise.resolve();
        return { traceId: getTraceId(), actor: getActor() };
      })
    ));

    expect(seen[0].traceId).toBe(traces[0]);
    expect(seen[1].traceId).toBe(traces[1]);
    expect(seen[2].traceId).toBe(traces[2]);
    expect(seen[0].traceId).not.toBe(seen[1].traceId);
    expect(seen[1].traceId).not.toBe(seen[2].traceId);
  });

  test('each cron run sees its own actor id (not the other cron)', async () => {
    const traceA = mintTraceId();
    const traceB = mintTraceId();

    const [resultA, resultB] = await Promise.all([
      runWith({ traceId: traceA, actor: { type: 'system', id: 'reconciliation-cron' } }, async () => {
        await Promise.resolve();
        return getActor();
      }),
      runWith({ traceId: traceB, actor: { type: 'system', id: 'hardware-health-check-cron' } }, async () => {
        await Promise.resolve();
        return getActor();
      }),
    ]);

    expect(resultA.id).toBe('reconciliation-cron');
    expect(resultB.id).toBe('hardware-health-check-cron');
  });

  test('10 concurrent cron runs all return distinct trace IDs', async () => {
    const runs = Array.from({ length: 10 }, (_, i) => {
      const traceId = mintTraceId();
      return runWith({ traceId, actor: { type: 'system', id: `cron-${i}` } }, async () => {
        await Promise.resolve();
        return getTraceId();
      });
    });

    const results = await Promise.all(runs);
    const unique = new Set(results);
    expect(unique.size).toBe(10);
  });

});
