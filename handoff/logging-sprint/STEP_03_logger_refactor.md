# Step 3 — Refactor `core/logger.js` to Auto-Read Context from ALS

**Owner:** NOVA (writes) · FELIX (validates)
**Estimated time:** 1.5 hours
**Blocks:** Steps 4-12
**Prerequisite:** Steps 1, 2 complete

---

## What this step delivers

`core/logger.js` is updated so every log call automatically picks up trace_id, actor_type, actor_id from the AsyncLocalStorage context. The existing `withTrace()` API is kept for backward compatibility but becomes the rare case, not the standard pattern.

The runtime regex backstop for secret/PII redaction is also installed here (E3 mitigation).

After this step: every existing `log.info(...)`, `log.warn(...)`, `log.error(...)` call site automatically benefits from trace propagation. No call-site changes anywhere in the codebase.

---

## Output files

- `core/logger.js` — refactored
- `core/log-redaction.js` — new module: redaction allowlist + runtime regex backstop
- Updated `test/p3-data-integrity/logger.test.js` (or new) — verifies auto-context + redaction

---

## Spec — `core/logger.js` changes

### Add: import trace context

```javascript
const { getTraceId, getActor } = require('./trace-context');
const { redact } = require('./log-redaction');
```

### Modify: `emit(level, event, ctx, err, traceId)`

Current behavior: emits a single JSON line with provided fields.

New behavior:
1. If `traceId` arg is not provided, read from ALS via `getTraceId()`.
2. Read actor from ALS via `getActor()`. Add `actor_type` + `actor_id` to entry.
3. Run `redact()` on the entry before stdout write AND before persist-to-DB.
4. Persist to `diagnostic_log` now also writes `actor_type`, `actor_id` columns (in addition to `trace_id`).

```javascript
function emit(level, event, ctx = {}, err = null, traceId = null) {
  if (level === 'debug' && PRODUCTION) return;

  // Auto-pull from ALS if not explicitly passed
  const effectiveTraceId = traceId || getTraceId();
  const actor = getActor();

  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...ctx,
  };

  if (effectiveTraceId) entry.traceId = effectiveTraceId;
  if (actor) {
    entry.actor_type = actor.type;
    entry.actor_id   = actor.id;
  }

  if (err) {
    entry.error = {
      message: err.message,
      code:    err.code       || null,
      status:  err.statusCode || null,
      stack:   PRODUCTION ? undefined : err.stack,
    };
    if (err.code && KEDB[err.code]) entry.kedb = KEDB[err.code];
    if (err.userMessage) entry.userMessage = err.userMessage;
    if (err.resolution)  entry.resolution  = err.resolution;
  }

  // Redaction — applied before stdout AND before DB write
  const safeEntry = redact(entry);

  process.stdout.write(JSON.stringify(safeEntry) + '\n');

  if (level === 'warn' || level === 'error' || level === 'critical') {
    persistToDiagnosticLog(level, event, safeEntry, err, effectiveTraceId, actor);
  }
}
```

### Modify: `persistToDiagnosticLog`

Update INSERT statement to include `actor_type` and `actor_id` columns:

```javascript
db.query(
  `INSERT INTO diagnostic_log
   (client_id, service, level, error_code, message, context, trace_id, actor_type, actor_id)
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
  [clientId, service, level, errorCode, message, JSON.stringify(context), traceId, actor?.type, actor?.id]
)
```

### Keep: `withTrace(traceId)` API

Backward compat. Still exported. Still works. Just becomes the rare-case escape hatch when an explicit override is needed (e.g., reconciliation cron starts a sub-span with a child trace).

---

## Spec — `core/log-redaction.js`

This module enforces DR-038 (redaction allowlist + runtime backstop).

```javascript
/**
 * @file log-redaction.js
 * @layer core/shared
 * @role logging-redaction
 * @exports redact, REDACTED, registerSecretField
 * @dr DR-038
 *
 * Schema-driven + runtime regex redaction for log entries.
 *
 * Two layers:
 *   1. Allowlist of known sensitive field names — replaced with [REDACTED] on match
 *   2. Runtime regex backstop — catches secrets that slipped through (Resend, JWT, Kisi, Stripe-shape)
 */

'use strict';

const REDACTED = '[REDACTED]';

// Layer 1 — known sensitive field names (extend as new events register)
const SENSITIVE_FIELDS = new Set([
  'hardware_api_key',
  'wix_api_key',
  'api_key',
  'apiKey',
  'password',
  'secret',
  'webhook_secret',
  'jwt',
  'token',
  'authorization',
  'authToken',
  'access_token',
  'refresh_token',
  'cookie',
  'set-cookie',
  // PII per DR-001
  'email',
  'phone',
  'first_name',
  'last_name',
  'full_name',
  'name',  // catch-all — error if a non-PII 'name' field needs to be logged, AXIOM reviews
]);

// Layer 2 — runtime regex backstop — catches missed secrets
const SECRET_PATTERNS = [
  /\bre_[a-zA-Z0-9_]{20,}/g,                                        // Resend API keys
  /\bsk_(live|test)_[a-zA-Z0-9]{24,}/g,                             // Stripe-shape secret keys
  /\bpk_(live|test)_[a-zA-Z0-9]{24,}/g,                             // Stripe-shape publishable keys
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT shape
  /\bBearer\s+[A-Za-z0-9_.\-]{20,}/gi,                              // Bearer tokens
  /\b[a-zA-Z0-9]{32,64}\b/g,                                        // Long hex/base64-ish — too aggressive? See note below
];

// NOTE on the long-hex pattern: this would mask too many legitimate IDs.
// Refine to require entropy or specific prefixes during step 8 with CIRCUIT review.
// For initial ship, exclude this catch-all pattern.

function redactString(s) {
  if (typeof s !== 'string') return s;
  let out = s;
  for (const pat of SECRET_PATTERNS.slice(0, -1)) {  // exclude the long-hex catch-all for now
    out = out.replace(pat, '[REDACTED_RUNTIME]');
  }
  return out;
}

function redactValue(key, value) {
  if (SENSITIVE_FIELDS.has(key)) return REDACTED;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(v => redactValue(key, v));
  if (value && typeof value === 'object') return redactObject(value);
  return value;
}

function redactObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = redactValue(k, v);
  }
  return out;
}

function redact(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  return redactObject(entry);
}

/**
 * Allow runtime extension of sensitive fields (used by EVENT_REGISTRY).
 */
function registerSecretField(name) {
  SENSITIVE_FIELDS.add(name);
}

module.exports = { redact, REDACTED, registerSecretField, SENSITIVE_FIELDS, SECRET_PATTERNS };
```

---

## Test cases (must all pass)

```javascript
describe('[P3] logger auto-context + redaction', () => {

  test('emit picks up trace_id from ALS automatically', async () => {
    // runWith({ traceId: 'abc' }, () => log.info('test', {})) → stdout line includes traceId: 'abc'
  });

  test('emit picks up actor from ALS automatically', async () => {
    // runWith({ actor: { type: 'operator', id: 'a@b.com' } }, () => log.info('test'))
    //   → stdout includes actor_type:'operator', actor_id:'a@b.com'
  });

  test('emit redacts known sensitive field names', () => {
    // log.info('test', { hardware_api_key: 'real-key' }) → stdout has hardware_api_key: '[REDACTED]'
  });

  test('emit redacts Resend keys via regex backstop', () => {
    // log.info('test', { message: 'Failed: re_abc1234567890123456789012' })
    //   → stdout has '[REDACTED_RUNTIME]'
  });

  test('emit redacts JWT shape via regex backstop', () => {
    // log.info('test', { token: 'eyJabc...xyz.eyJ...xyz.signature123' }) → redacted
  });

  test('persistToDiagnosticLog writes actor_type and actor_id columns', async () => {
    // runWith({ actor }, () => log.error('x'))
    //   → diagnostic_log row has actor_type/actor_id populated
  });

  test('emit works with no ALS context (legacy path)', () => {
    // log.info('test') outside runWith → no traceId, no actor, no crash
  });

  test('explicit traceId arg overrides ALS', () => {
    // runWith({ traceId: 'A' }, () => emit('info', 'x', {}, null, 'B'))
    //   → stdout has traceId: 'B' (explicit wins)
  });

  test('redaction handles nested objects', () => {
    // log.info('x', { config: { hardware_api_key: 'k' } }) → nested key redacted
  });

  test('redaction handles arrays of strings with secrets', () => {
    // log.info('x', { tokens: ['re_abc...xyz', 'safe'] }) → first redacted, second untouched
  });

});
```

---

## FELIX validation checklist

- [ ] All existing `log.*` call sites still work (no breaking changes)
- [ ] Existing `withTrace()` callers in queue-worker.js and reconciliation.js still pass tests
- [ ] Front matter on `core/logger.js` updated with `@dr DR-036, DR-038`
- [ ] Front matter on `core/log-redaction.js` complete
- [ ] All 10 redaction/auto-context tests pass
- [ ] `npm run test:deploy` returns DEPLOY SAFE
- [ ] No raw `console.*` introduced (P3 test enforces)
- [ ] Stdout output of a sample log call manually inspected — verify trace_id and actor fields appear and known secrets are redacted

---

## Sign-off format

```
STEP 03 COMPLETE — logger.js auto-reads ALS context + redaction installed
- ALS auto-pickup: trace_id, actor_type, actor_id propagate to every log call
- Schema-driven redaction (24 fields) + runtime regex backstop (4 patterns) active
- diagnostic_log persistence updated to write actor columns
- 10 new tests passing, all existing tests still green
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 3 → 🟢
