# Step 8 — `core/EVENT_REGISTRY.md` Initial Taxonomy + Redaction Allowlist

**Owner:** CIRCUIT (drafts) · AXIOM (audits) · SAGE (approves)
**Estimated time:** 2 hours
**Blocks:** Step 9
**Prerequisite:** Steps 1-7 complete

---

## What this step delivers

The canonical event taxonomy for AccessSync. Every event name used by the system has a documented entry: meaning, context fields, actor types that emit it, KEDB code if applicable, sensitive-field flags. AXIOM-gated PRs from this point forward.

Plus the schema-driven redaction allowlist is finalized — every field name that could contain a secret or PII is registered.

This is the AI-readability foundation. Without a stable, documented vocabulary, downstream AI agents can't reliably reason over the logs.

---

## Output files

- `core/EVENT_REGISTRY.md` — canonical taxonomy
- `core/redaction-allowlist.json` — machine-readable list of sensitive field names (loaded by `core/log-redaction.js` at startup)
- Updated `core/log-redaction.js` to read the JSON file at module load instead of hard-coded `SENSITIVE_FIELDS` set

---

## Spec — `core/EVENT_REGISTRY.md` structure

```markdown
# AccessSync Event Registry

**Status:** Living document. AXIOM gates every PR that adds, modifies, or removes an event.

## Format

Every event is one section. Sections are organized by domain (alphabetical).
Required fields per entry:

- **Event name** — dot-namespaced, lowercase, format `<domain>.<subject>.<verb_past_tense>`
- **Description** — one sentence, what the event represents
- **Emitter actor types** — which actors emit this (owner | operator | member | system | webhook)
- **Required context fields** — fields always present
- **Optional context fields** — fields sometimes present
- **Result values** — for activity_event, valid `result` values
- **KEDB code** — if applicable, links to known-error documentation
- **Sensitive fields** — flagged for redaction (must also appear in redaction-allowlist.json)

---

## Domain: mapping

### `mapping.group.added`
- **Description:** Operator linked a hardware group to a plan mapping
- **Emitter actor types:** operator
- **Required context fields:** `mapping_id`, `hardware_group_id`, `client_id`
- **Optional context fields:** `door_name`
- **Result values:** success, failure
- **KEDB:** —
- **Sensitive fields:** none

### `mapping.group.removed`
- **Description:** Operator disconnected a hardware group from a plan mapping (Interpretation A — future-only, existing members unaffected)
- **Emitter actor types:** operator
- **Required context fields:** `mapping_id`, `hardware_group_id`, `client_id`, `affected_member_count`
- **Optional context fields:** `door_name`
- **Result values:** success, failure
- **KEDB:** —
- **Sensitive fields:** none

### `mapping.created`
### `mapping.updated`
### `mapping.deleted`
### `mapping.activated`
### `mapping.deactivated`

## Domain: member

### `member.access.granted`
### `member.access.revoked`
### `member.access.suspended`
### `member.access.reactivated`
### `member.identity.created`
### `member.identity.linked`

## Domain: hardware

### `hardware.user.created`
### `hardware.user.deleted`
### `hardware.role.assigned`
### `hardware.role.removed`
### `hardware.api.failed`
- **KEDB:** HARDWARE_API_ERROR

## Domain: webhook

### `webhook.received`
- **Sensitive fields:** `raw_payload` (may contain customer PII)
### `webhook.hmac.failed`
- **KEDB:** HMAC_FAILURE
### `webhook.dedup.blocked`

## Domain: queue

### `queue.job.enqueued`
### `queue.job.started`
### `queue.job.completed`
### `queue.job.failed`
### `queue.job.retry`

## Domain: config

### `config.api_key.rotated`
- **Sensitive fields:** `before.hardware_api_key`, `after.hardware_api_key` (must redact)
### `config.api_key.tested`
### `config.notification_email.updated`
- **Sensitive fields:** `before.notification_email`, `after.notification_email` (PII)

## Domain: client

### `client.created`
### `client.archived`
### `client.restored`
### `client.deleted`

## Domain: location

### `location.created`
### `location.updated`
### `location.suspended`
### `location.activated`

## Domain: operator

### `operator.login`
### `operator.logout`
### `operator.session.expired`

## Domain: cron

### `cron.reconciliation.started`
### `cron.reconciliation.completed`
### `cron.reconciliation.flagged_orphan`
### `cron.health_check.started`
### `cron.health_check.completed`
### `cron.health_check.api_key_invalid`

## Domain: system

### `system.startup`
### `system.shutdown`
### `system.error.uncaught`
### `system.error.unhandled_rejection`
```

CIRCUIT delivers the initial registry covering ~40 events that match what the codebase actually emits today. This is NOT an exhaustive future-state list — it's the today-state snapshot that future PRs extend.

---

## Spec — `core/redaction-allowlist.json`

```json
{
  "$schema_version": "1.0",
  "description": "Schema-driven sensitive field allowlist for log redaction. Loaded by core/log-redaction.js at startup. Governed by DR-038. AXIOM gates additions.",
  "secrets": [
    "hardware_api_key",
    "wix_api_key",
    "api_key",
    "apiKey",
    "password",
    "secret",
    "webhook_secret",
    "jwt",
    "token",
    "authorization",
    "authToken",
    "access_token",
    "refresh_token",
    "cookie",
    "set-cookie",
    "OPERATOR_INVITE_TOKEN",
    "OWNER_PIN",
    "RESEND_API_KEY",
    "ADMIN_JWT_SECRET",
    "API_KEY_ENCRYPTION_KEY",
    "WIX_WEBHOOK_SECRET"
  ],
  "pii": [
    "email",
    "phone",
    "first_name",
    "last_name",
    "full_name",
    "address",
    "street_address",
    "zip_code",
    "postal_code",
    "ssn",
    "date_of_birth"
  ],
  "borderline_pii": [
    "ip_address",
    "user_agent"
  ],
  "borderline_pii_policy": "ip_address and user_agent are captured in activity_event.request_meta for audit purposes per DR-038. They are NOT redacted in audit context. They ARE redacted when appearing in non-audit log contexts."
}
```

The `borderline_pii_policy` documents AXIOM's ruling on the gray-zone fields. The redaction logic checks the file format and uses `secrets` + `pii` for default redaction, leaves `borderline_pii` alone but documents why.

---

## Spec — `core/log-redaction.js` update

Replace the hard-coded `SENSITIVE_FIELDS` set with a load from JSON:

```javascript
const fs = require('node:fs');
const path = require('node:path');

const allowlistPath = path.join(__dirname, 'redaction-allowlist.json');
const allowlist = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));

const SENSITIVE_FIELDS = new Set([
  ...allowlist.secrets,
  ...allowlist.pii,
]);
```

This way: AXIOM updates the JSON file in a PR, no code change needed. CI lints the JSON for unexpected schema changes.

---

## AXIOM audit checklist

AXIOM gates step 8 with these checks:

- [ ] Every event currently emitted by the codebase has an entry in EVENT_REGISTRY.md (cross-check via `grep -rh "log\.\(info\|warn\|error\|critical\)('[a-z_]*\.[a-z_]*'" core/ adapters/ admin/`)
- [ ] No event names use camelCase or contain spaces
- [ ] Every event with a `Sensitive fields` line has those fields in `redaction-allowlist.json`
- [ ] No PII fields are missing from `redaction-allowlist.json` (`email`, `phone`, `first_name`, `last_name` are required)
- [ ] `borderline_pii_policy` is signed off by SAGE before merge
- [ ] DR-037 references this file as the canonical source

---

## CIRCUIT review

CIRCUIT verifies the registry meets AI-readability standards:

- [ ] Event names follow consistent grammar (`<domain>.<subject>.<verb_past_tense>`)
- [ ] No two events have overlapping meaning (semantic deduplication)
- [ ] Required vs. optional fields are separated and unambiguous
- [ ] KEDB codes that exist in `core/logger.js` are referenced correctly
- [ ] An AI agent given just this file can answer "what events fire when an operator changes a plan mapping?" in one search

---

## SAGE approval

SAGE reviews the full file + AXIOM/CIRCUIT findings. SAGE approves before step 9 begins. Specifically signs off on:

- The borderline_pii_policy ruling
- The 40-event initial scope (not over-engineered, not under-engineered)
- The AXIOM-gated PR process for future event additions

---

## Sign-off format

```
STEP 08 COMPLETE — EVENT_REGISTRY.md + redaction-allowlist.json
- 40 events documented across 11 domains
- Redaction allowlist: 22 secrets + 11 PII fields + 2 borderline (audit-only) fields
- AXIOM gate: passed (event coverage verified against codebase grep)
- CIRCUIT review: passed (AI-readability standards met)
- SAGE approval: <link to approval ruling>
- log-redaction.js loads from JSON at startup
- DEPLOY SAFE: <count>/<count>
```

Update `00_SPRINT_PLAN.md`: Step 8 → 🟢
