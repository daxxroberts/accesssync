/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: EVENT_REGISTRY.json overrides exist in EVENT_REGISTRY.md     │
 * │                                                                         │
 * │  Business consequence: EVENT_REGISTRY.md is the canonical event         │
 * │  vocabulary (DR-038). EVENT_REGISTRY.json is the machine-readable       │
 * │  persistence-override mirror (OB-176, Builder ruling 2026-05-25).      │
 * │  If the JSON references an event name that isn't documented in the      │
 * │  markdown, an operator or future agent reading the markdown will see    │
 * │  no record of an event that's actually being persisted (or              │
 * │  suppressed) in production — a documentation blind spot that defeats    │
 * │  the purpose of having an event vocabulary at all.                      │
 * │                                                                         │
 * │  This test guards the JSON → MD direction (every override must exist   │
 * │  in the markdown). It does NOT enforce MD → JSON (events without       │
 * │  overrides are intentional — they ride the level-based default).      │
 * │                                                                         │
 * │  Runtime impact: ~5ms filesystem read + regex parse. Zero production    │
 * │  impact.                                                                │
 * │                                                                         │
 * │  OB-176 ship: 2026-05-26.                                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const fs   = require('fs');
const path = require('path');

const REGISTRY_MD_PATH   = path.join(__dirname, '..', '..', 'core', 'EVENT_REGISTRY.md');
const REGISTRY_JSON_PATH = path.join(__dirname, '..', '..', 'core', 'EVENT_REGISTRY.json');

/**
 * Extract every event name from EVENT_REGISTRY.md.
 *
 * Event names are dot-namespaced identifiers wrapped in backticks inside the
 * table rows, e.g. `grant.role.assigning` or `admin.scheduler.armed`. Some
 * rows pack multiple slash-separated event names into one backtick group
 * (e.g. `kisi.user.suspending` / `kisi.user.suspended`); we split on " / "
 * after extracting each backtick group.
 *
 * The match is intentionally broad — any backtick-wrapped token that looks
 * like a dot-namespaced identifier (lowercase + dots + underscores) counts.
 * Anything else (file paths, function names, status enums) is filtered out.
 */
function extractMarkdownEvents() {
  const md = fs.readFileSync(REGISTRY_MD_PATH, 'utf8');
  const events = new Set();

  // Backtick-wrapped tokens
  const backtickGroups = md.match(/`[^`]+`/g) || [];
  for (const group of backtickGroups) {
    const raw = group.slice(1, -1); // strip backticks
    // Split on " / " for combined entries like `a.b.c` / `a.b.d`
    const candidates = raw.split(/\s*\/\s*/);
    for (const c of candidates) {
      // Event names: at least one dot, lowercase letters/underscores only,
      // no spaces, no slashes, no other punctuation. Disallow leading/trailing dots.
      if (/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/.test(c)) {
        events.add(c);
      }
    }
  }

  return events;
}

describe('[P3] OB-176 — EVENT_REGISTRY.json overrides exist in EVENT_REGISTRY.md', () => {
  test('EVENT_REGISTRY.json is valid JSON with the expected shape', () => {
    const raw = fs.readFileSync(REGISTRY_JSON_PATH, 'utf8');
    let parsed;
    expect(() => { parsed = JSON.parse(raw); }).not.toThrow();
    expect(parsed).toHaveProperty('overrides');
    expect(typeof parsed.overrides).toBe('object');
    expect(parsed.overrides).not.toBeNull();

    // Every override entry has a boolean `persist` field — no other shape
    // tolerated until additive fields are formally ruled (Builder Q7-Q10 c).
    for (const [eventName, entry] of Object.entries(parsed.overrides)) {
      expect(typeof eventName).toBe('string');
      expect(eventName.length).toBeGreaterThan(0);
      expect(entry).toHaveProperty('persist');
      expect(typeof entry.persist).toBe('boolean');
    }
  });

  test('every JSON override key appears as a documented event in EVENT_REGISTRY.md', () => {
    const registry        = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, 'utf8'));
    const overrideKeys    = Object.keys(registry.overrides || {});
    const markdownEvents  = extractMarkdownEvents();

    expect(overrideKeys.length).toBeGreaterThan(0); // sanity: we authored some overrides

    const orphans = overrideKeys.filter(k => !markdownEvents.has(k));
    if (orphans.length > 0) {
      // Build a helpful failure message — surface the missing entries so an
      // operator running test:deploy sees exactly which events need a
      // markdown row.
      const msg = [
        'EVENT_REGISTRY.json references events not documented in EVENT_REGISTRY.md:',
        ...orphans.map(o => `  - ${o}`),
        '',
        'Fix: add a row for each event to EVENT_REGISTRY.md, OR remove the override from EVENT_REGISTRY.json.',
      ].join('\n');
      throw new Error(msg);
    }
  });

  test('overrides cover the scheduler events that OB-197 promoted for persistence', () => {
    // Forward-compat guard: if a future refactor drops the scheduler events
    // back to info level (or someone removes the override), persistence to
    // diagnostic_log silently breaks. Lock the contract here so the test
    // suite fails loud.
    const registry = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, 'utf8'));
    const required = [
      'admin.scheduler.armed',
      'admin.scheduler.reconcile_start',
      'admin.scheduler.reconcile_complete',
      'admin.scheduler.reconcile_failed',
      'reconciliation.stale_reset',
    ];
    for (const eventName of required) {
      expect(registry.overrides[eventName]).toBeDefined();
      expect(registry.overrides[eventName].persist).toBe(true);
    }
  });
});
