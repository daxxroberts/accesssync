---
type: vault_control
domain: ai_bundle
status: active
owner: keeper
related_systems: [bundle_assembly, trace_timeline]
last_updated: 2026-04-29
governs_dr: DR-022
---

# Layer-to-File Map

> **Maps each architectural layer (DR-022 7-layer model) to its source files. Used by the bundle assembler to filter file paths to only the platforms in a given trace, so the AI sees only files relevant to the bundle. KEEPER maintains. The bundle reads this file at button-click time and emits the filtered subset into every bundle's instruction block.**

> **Why filtering matters:** if a trace is `wix → kisi`, the AI doesn't need to know `seam-adapter.js` exists. Including it pollutes the file path universe and increases the chance the AI guesses wrong about location. Filtered map = cleaner reasoning.

---

## Authoring rules (read before editing)

1. **Pure architecture, no opinion.** This file documents which file is at which layer per DR-022. It does not editorialize about what a file does (that's frontmatter / EVENT_REGISTRY's job).
2. **Source platforms and hardware platforms are independent.** A trace pairs one of each. The map filters them independently and joins the result with the SHARED section.
3. **List every file in the relevant `adapters/`, `core/`, and `admin/` directories.** Even files like `seam-adapter.js` (stub) — they exist as paths the AI might reasonably suggest.
4. **Keep file paths repo-relative**, starting from the AccessSync GitHub repo root. No leading slashes.
5. **When a file moves or is added, this map updates in the same commit.** Stale paths cause the AI to invent fixes for files that don't exist.

---

## Source platform layers (Layer 1 + Layer 2)

> *Layer 1: Connector — raw HTTP handler. HMAC verification. Hands payload to Layer 2.*
> *Layer 2: Adapter — payload parsing. Returns standard event object. Zero business logic.*

### wix

```
L1 wix-connector.js              adapters/wix/wix-connector.js
L2 wix-adapter.js                adapters/wix/wix-adapter.js
L2 wix-members-api.js            adapters/wix/wix-members-api.js
L2 wix-plans-api.js              adapters/wix/wix-plans-api.js
```

> *Backward-compat shim:* `adapters/wix-adapter.js` → `adapters/wix/wix-connector.js` (kept for old import paths; not the canonical location).

### squarespace, mindbody, etc.

Not yet implemented. When added, list under their own subsection here. The bundle filter handles unknown source platforms by emitting only the SHARED section.

---

## Hardware platform layers (Layer 6 + Layer 7)

> *Layer 6: Hardware-specific adapter — business methods (assignRole, removeRole, getLocks). Calls Layer 7.*
> *Layer 7: Hardware connector — HTTP client, rate limiting, auth headers.*

### kisi

```
L6 kisi-adapter.js               adapters/kisi/kisi-adapter.js
L7 kisi-connector.js             adapters/kisi/kisi-connector.js
```

### seam (stubbed, post-V1)

```
L6 seam-adapter.js               adapters/seam/seam-adapter.js
L7 seam-connector.js             adapters/seam/seam-connector.js
```

> *Both seam files are stubs as of v1. Listed here so traces that ever reference Seam don't get blank file paths in the bundle.*

> *Backward-compat shims:* `adapters/kisi-adapter.js`, `adapters/seam-adapter.js` exist as re-exports. Not canonical locations.

---

## Shared layers (always included regardless of platform pair)

> *L3 owns identity + state writes (DR-023). L4 is the orchestrator. L5 routes to the right hardware adapter.*

### Layer 3 — Standard Adapter

```
L3 standard-adapter.js           adapters/standard-adapter.js
```

### Layer 4 — Core Engine

```
L4 webhook-processor.js          core/webhook-processor.js
L4 queue-worker.js               core/queue-worker.js
L4 grant-revoke.js               core/grant-revoke.js
L4 plan-mapping-resolver.js      core/plan-mapping-resolver.js
L4 retry-engine.js               core/retry-engine.js
L4 reconciliation.js             core/reconciliation.js
L4 location-lapse.js             core/location-lapse.js
L4 hardware-health-check.js      core/hardware-health-check.js
L4 hmac-monitor.js               core/hmac-monitor.js
L4 member-sync-api.js            core/member-sync-api.js
L4 billing-snapshot.js           core/billing-snapshot.js
L4 tenant-resolver.js            core/tenant-resolver.js
```

### Layer 5 — Hardware Standard Adapter

```
L5 hardware-adapter.js           adapters/hardware-adapter.js
```

### Cross-cutting (not a layer; supports all layers)

```
S  trace-context.js              core/trace-context.js          (DR-037 ALS context)
S  logger.js                     core/logger.js                 (structured logging to diagnostic_log)
S  log-redaction.js              core/log-redaction.js          (DR-039 PII allowlist enforcement)
S  redaction-allowlist.json      core/redaction-allowlist.json  (DR-039)
S  rate-limiter.js               core/rate-limiter.js
S  redis-utils.js                core/redis-utils.js
S  crypto-utils.js               core/crypto-utils.js           (DR-028 API key encryption)
S  diagnostics.js                core/diagnostics.js            (per-member diagnose + timeline)
S  EVENT_REGISTRY.md             core/EVENT_REGISTRY.md         (DR-038 event taxonomy)
```

---

## Admin layers (UI / API for operators and owner)

> *Not part of the 7-layer grant pipeline, but included so the AI can localize bugs in admin-side code (operator pages, owner dashboard, REST endpoints).*

### Admin server + middleware

```
A  admin/server.js
A  admin/middleware/auth.js
A  admin/middleware/trace-context.js
A  admin/middleware/activity.js
A  admin/middleware/audit.js
A  admin/middleware/wix-instance.js
```

### Admin routes (REST endpoints)

```
A  admin/routes/auth.js
A  admin/routes/clients.js
A  admin/routes/errors.js
A  admin/routes/logs.js
A  admin/routes/members.js
A  admin/routes/operator.js
A  admin/routes/portal.js
A  admin/routes/queue.js
A  admin/routes/webhooks.js
A  admin/routes/multi-member.js
```

### Admin pages (EJS / React island)

```
A  admin/views/pages/dashboard.ejs
A  admin/views/pages/members.ejs            (React island — Members page v2)
A  admin/views/pages/plan-mapping.ejs
A  admin/views/pages/access.ejs             (hidden 2026-04-29; route + file dormant)
A  admin/views/pages/locations.ejs
A  admin/views/pages/errors.ejs
A  admin/views/pages/logs.ejs               (React island — Trace Timeline)
A  admin/views/pages/admin-panel.ejs
A  admin/views/pages/onboard.ejs
A  admin/views/pages/portal-setup.ejs
A  admin/views/pages/sync-status.ejs
A  admin/views/pages/multi-member.ejs
A  admin/views/pages/member-hub.ejs
```

### Admin frontend assets

```
A  admin/public/app.js                       (Owner Dashboard vanilla JS)
A  admin/public/index.html                   (Owner Dashboard shell)
A  admin/public/operator-nav.js              (operator subnav)
A  admin/public/operator-styles.css
A  admin/public/logs-app.jsx                 (Trace Timeline React island)
A  admin/public/logs-panel.css               (Trace Timeline CSS, scoped)
A  admin/public/humanize.js                  (Plain English event humanizer, shared)
A  admin/public/member-incident-drawer.js    (Errors page incident drawer)
A  admin/public/members-app.jsx              (Members v2 React island)
A  admin/public/members-bridge.js            (Members v2 API adapter)
A  admin/public/members-data.jsx
A  admin/public/members-icons.jsx
A  admin/public/members-parts.jsx
```

### Owner Dashboard Svelte panels

```
A  admin/svelte/main.js
A  admin/svelte/panels/QueuePanel.svelte
A  admin/svelte/panels/WebhookPanel.svelte
A  admin/svelte/panels/DebugCenterPanel.svelte
A  admin/svelte/panels/ErrorQueuePanel.svelte
A  admin/svelte/panels/MemberSyncPanel.svelte
A  admin/svelte/panels/ClientsPanel.svelte
A  admin/svelte/panels/PlanMappingPanel.svelte
A  admin/svelte/components/Toast.svelte
A  admin/svelte/stores/toast.js
```

---

## Filter logic (how the bundle assembler reads this file)

Pseudocode — the bundle assembler implements this:

```
function filterMap(sourcePlatform, hardwarePlatform):
  output = []
  output.push(parseSection("Source platform layers", sourcePlatform))
  output.push(parseSection("Hardware platform layers", hardwarePlatform))
  output.push(parseAllShared())
  output.push(parseAllAdmin())
  return output.flatten()
```

When the source or hardware platform isn't found in the map, emit a comment noting it (`# unknown source platform: X — only shared layers shown`) so the AI knows the bundle is partial and can flag it as a gap.

---

## Change history

| Version | Date | Change |
|---|---|---|
| v0.1.0 | 2026-04-29 | Initial draft. Wix + Kisi covered; Seam stubbed. Includes admin layer for completeness. |
