# Step 4 — Express Middleware: Trace + Actor Mint on Every Request

**Owner:** NOVA (writes) · LENS (verifies via test endpoint)
**Estimated time:** 1.5 hours
**Blocks:** Steps 7, 9, 10, 11
**Prerequisite:** Steps 1, 2, 3 complete

---

## What this step delivers

Express middleware that:
1. Reads or mints a trace ID for every incoming request
2. Resolves the actor from existing auth context (`req.admin`, JWT, member token, or anonymous)
3. Wraps the request handler in `runWith({ traceId, actor }, next)` so every downstream log call inherits the context
4. Sets `x-trace-id` response header so client-side errors can correlate

Mounted on both `admin/server.js` (admin/operator routes) and `server.js` (core engine routes — webhook + member API).

---

## Output files

- `admin/middleware/trace-context.js` — new middleware
- Updated `admin/server.js` — mounts middleware
- Updated `server.js` — mounts middleware (core engine)
- `test/p2-onboarding/trace-middleware.test.js` — integration tests

---

## Spec — `admin/middleware/trace-context.js`

```javascript
/**
 * @file trace-context.js
 * @layer admin/middleware
 * @role logging-context
 * @reads x-trace-id header (inbound), JWT cookie (req.admin), Wix instance (req.wixInstance), member token
 * @writes x-trace-id header (outbound)
 * @calls core/trace-context (runWith, mintTraceId, setActor)
 * @dr DR-036
 *
 * Mints a trace ID on every request and binds an actor based on existing auth context.
 * Wraps the request lifecycle in AsyncLocalStorage so every downstream log.* call
 * automatically inherits trace_id + actor.
 *
 * MUST mount AFTER cookieParser and AFTER auth middleware that populates req.admin / req.wixInstance.
 * MUST mount BEFORE any route handler.
 *
 * Honors inbound x-trace-id header so internal admin → core proxy calls can chain traces.
 */

'use strict';

const { runWith, mintTraceId } = require('../../core/trace-context');

const VALID_TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function resolveActor(req) {
  // Priority order — most specific first
  if (req.admin && req.admin.email) {
    // ADMIN_ALLOWED_EMAIL is the owner. Any other authenticated admin is an operator.
    const isOwner = req.admin.email === process.env.ADMIN_ALLOWED_EMAIL;
    return { type: isOwner ? 'owner' : 'operator', id: req.admin.email };
  }
  if (req.admin && req.admin.role === 'operator' && req.admin.clientId) {
    // Wix-portal-authenticated operator (Chad)
    return { type: 'operator', id: `wix:${req.admin.clientId}` };
  }
  if (req.wixInstance && req.wixInstance.instanceId) {
    return { type: 'operator', id: `wix-instance:${req.wixInstance.instanceId}` };
  }
  if (req.member && req.member.id) {
    return { type: 'member', id: req.member.id };
  }
  // Webhook entry — wix-connector mounts this differently (see server.js spec below)
  if (req.path.startsWith('/webhook')) {
    return { type: 'webhook', id: req.path };
  }
  // Public/anonymous (member portal pre-auth, health checks, login pages)
  return { type: 'system', id: 'anonymous' };
}

function traceContextMiddleware(req, res, next) {
  // Honor inbound trace ID if present and valid (admin → core proxy chain case)
  const inbound = req.headers['x-trace-id'];
  const traceId = (inbound && VALID_TRACE_ID.test(inbound)) ? inbound : mintTraceId();

  const actor = resolveActor(req);

  // Echo trace ID back for client-side correlation
  res.setHeader('x-trace-id', traceId);

  // Wrap the rest of the request lifecycle in the context
  runWith({ traceId, actor }, () => {
    next();
  });
}

module.exports = { traceContextMiddleware, resolveActor };
```

---

## Spec — Mount in `admin/server.js`

Insert AFTER `cookieParser()` and the auth middleware blocks, BEFORE any route mounts.

```javascript
// Existing:
app.use(cookieParser());
// ... auth middleware that populates req.admin ...

// NEW:
const { traceContextMiddleware } = require('./middleware/trace-context');
app.use(traceContextMiddleware);

// Existing routes mount below
app.use('/auth', authRoutes);
app.use('/admin/errors',   requireAuth, errorsRoutes);
// ... etc
```

> **CRITICAL:** Order matters. The middleware reads `req.admin` populated by auth middleware. If trace middleware runs before auth resolves, the actor will be `system:anonymous` for authenticated requests. AXIOM gates this — verify mount order in PR review.

---

## Spec — Mount in `server.js` (core engine)

Core engine has webhook entry + member API. Webhook flow already mints traceId in `wix-connector.js` — that flow is preserved but adapted to use `runWith` instead of passing through job payload only.

```javascript
// Existing:
app.use(express.json({ verify: rawBodySaver }));

// NEW:
const { traceContextMiddleware } = require('./admin/middleware/trace-context');
app.use(traceContextMiddleware);

// Existing routes mount below
```

The webhook handler in `adapters/wix/wix-connector.js` ALREADY generates a traceId. Refactor: instead of generating internally, READ from ALS via `getTraceId()` (it'll already be set by the middleware). This eliminates the duplicate-trace bug where the request had one ID and the queue job had another.

Step 5 (BullMQ context) handles the propagation from web request → queue job.

---

## Test cases — `test/p2-onboarding/trace-middleware.test.js`

```javascript
describe('[P2] trace-context middleware', () => {

  test('mints traceId when no inbound header present', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-trace-id']).toMatch(uuidV4Regex);
  });

  test('honors valid inbound x-trace-id header', async () => {
    const inbound = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const res = await request(app).get('/health').set('x-trace-id', inbound);
    expect(res.headers['x-trace-id']).toBe(inbound);
  });

  test('rejects malformed inbound trace ID and mints fresh', async () => {
    const res = await request(app).get('/health').set('x-trace-id', 'not-a-uuid');
    expect(res.headers['x-trace-id']).toMatch(uuidV4Regex);
    expect(res.headers['x-trace-id']).not.toBe('not-a-uuid');
  });

  test('actor=owner when ADMIN_ALLOWED_EMAIL JWT present', async () => {
    const token = signTestJwt({ email: process.env.ADMIN_ALLOWED_EMAIL });
    const res = await request(app).get('/admin/errors').set('Cookie', `admin_jwt=${token}`);
    // Verify via a test handler that echoes getActor()
    expect(res.body.actor).toEqual({ type: 'owner', id: process.env.ADMIN_ALLOWED_EMAIL });
  });

  test('actor=operator when non-owner authenticated', async () => {
    const token = signTestJwt({ email: 'chad@hog.com' });
    const res = await request(app).get('/admin/errors').set('Cookie', `admin_jwt=${token}`);
    expect(res.body.actor).toEqual({ type: 'operator', id: 'chad@hog.com' });
  });

  test('actor=operator with wix-instance prefix when Wix-portal-authed', async () => {
    // Simulate req.wixInstance set by wix-instance middleware
  });

  test('actor=system:anonymous on public routes', async () => {
    const res = await request(app).get('/health');
    expect(res.body.actor).toEqual({ type: 'system', id: 'anonymous' });
  });

  test('downstream log.* calls inherit trace context', async () => {
    // Make request, intercept stdout, verify log lines contain x-trace-id from response
  });

  test('concurrent requests do not leak context', async () => {
    // Fire 50 parallel requests, each with distinct trace IDs
    // Verify each request's log lines contain only its own trace ID
  });

});
```

---

## LENS verification protocol

LENS spins up the dev server (or hits the deployed Railway endpoint after merge) and verifies:

- [ ] `curl -i https://accesssync-admin.up.railway.app/health` returns `x-trace-id` header with a valid UUID
- [ ] `curl -i -H 'x-trace-id: aaaaaaaa-...' https://...` echoes the inbound trace ID
- [ ] `curl -i -H 'x-trace-id: garbage' https://...` returns a fresh UUID (rejects invalid)
- [ ] After one authenticated dashboard load, `SELECT trace_id, actor_type, actor_id FROM diagnostic_log WHERE trace_id = '<from-curl>' LIMIT 5` returns rows with the expected actor

---

## FELIX validation checklist

- [ ] Middleware mounts in correct order (after cookieParser + auth, before routes) on both `admin/server.js` and `server.js`
- [ ] Inbound `x-trace-id` header validation regex matches RFC 4122
- [ ] Outbound `x-trace-id` always set
- [ ] All 9 test cases pass
- [ ] No regression: 90/90 deploy-safe still passes
- [ ] Front matter on new file complete

---

## Sign-off format

```
STEP 04 COMPLETE — Express middleware mounted on admin + core servers
- Trace ID minted/honored on every request
- Actor resolved from req.admin / req.wixInstance / req.member / fallback
- x-trace-id response header set
- 9 middleware tests passing
- LENS verification: <link to curl evidence>
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 4 → 🟢
