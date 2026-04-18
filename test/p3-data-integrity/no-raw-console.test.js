/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: Structured logging convention is enforced across core/       │
 * │  and adapters/                                                          │
 * │                                                                         │
 * │  Business consequence: Raw console.log / console.error bypasses the    │
 * │  structured logger. That means the failure doesn't persist to          │
 * │  diagnostic_log, doesn't get a KEDB lookup, and doesn't carry the      │
 * │  breadcrumb context the Admin Hub + future AI diagnostic agents        │
 * │  depend on. A single offender creates a blind spot in production       │
 * │  observability that won't surface until something breaks on that       │
 * │  code path — which is exactly when you least want a logging gap.       │
 * │                                                                         │
 * │  Convention: every log call goes through core/logger.js. Enforced       │
 * │  here so new contributors (human or AI) can't silently introduce       │
 * │  drift.                                                                 │
 * │                                                                         │
 * │  Runtime impact: ~50ms filesystem scan. Zero production impact — this   │
 * │  test runs only during `npm run test:deploy`.                           │
 * │                                                                         │
 * │  Standards register entry: AccessSync/STANDARDS.md → Logging →          │
 * │  "Never use raw console.* in core/ or adapters/" (2026-04-17).          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const fs = require('fs');
const path = require('path');

/**
 * Recursively collect every .js file under a directory.
 * Skips node_modules defensively even though it shouldn't appear inside src dirs.
 */
function collectJsFiles(root) {
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(full);
    }
  }
  walk(root);
  return files;
}

/**
 * Scan a file for `console.<method>` calls at statement position (any indentation).
 * Returns an array of { line, snippet } for every match.
 *
 * Excluded from match — legitimate uses:
 *   - Inside a single-line or multi-line comment (// ... or /* ... *​/ guarded by a cheap pre-check)
 *   - Stdout-write fallback inside core/logger.js itself (where structured logging would cause infinite recursion)
 */
function findOffenders(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const offenders = [];
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Cheap skip: commented-out lines.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') continue;
    // Match console.log / .error / .warn / .info / .debug at statement position.
    // Allows `await console...` is weird but not realistic — we match .* before console too.
    if (/\bconsole\.(log|error|warn|info|debug)\s*\(/.test(line)) {
      offenders.push({ line: i + 1, snippet: trimmed.slice(0, 100) });
    }
  }
  return offenders;
}

describe('[P3] Structured logging convention — no raw console.* in core/ or adapters/', () => {

  test('core/ uses log.* exclusively', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const coreDir = path.join(repoRoot, 'core');
    const files = collectJsFiles(coreDir);
    expect(files.length).toBeGreaterThan(0);

    // Allow-list: core/logger.js may use process.stdout.write when the structured
    // logger itself fails (logger.js:134). That's a stdout fallback, not a console call.
    // console.* specifically is banned even in logger.js.
    const offenders = [];
    for (const file of files) {
      const hits = findOffenders(file);
      if (hits.length > 0) offenders.push({ file: path.relative(repoRoot, file), hits });
    }

    if (offenders.length > 0) {
      const msg = offenders.map(o =>
        `  ${o.file}:\n${o.hits.map(h => `    line ${h.line}: ${h.snippet}`).join('\n')}`
      ).join('\n');
      throw new Error(
        `Found raw console.* calls in core/. Use log.info / log.warn / log.error from core/logger.js instead.\n${msg}`
      );
    }
  });

  test('adapters/ uses log.* exclusively', () => {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const adaptersDir = path.join(repoRoot, 'adapters');
    const files = collectJsFiles(adaptersDir);
    expect(files.length).toBeGreaterThan(0);

    const offenders = [];
    for (const file of files) {
      const hits = findOffenders(file);
      if (hits.length > 0) offenders.push({ file: path.relative(repoRoot, file), hits });
    }

    if (offenders.length > 0) {
      const msg = offenders.map(o =>
        `  ${o.file}:\n${o.hits.map(h => `    line ${h.line}: ${h.snippet}`).join('\n')}`
      ).join('\n');
      throw new Error(
        `Found raw console.* calls in adapters/. Use log.info / log.warn / log.error from core/logger.js instead.\n${msg}`
      );
    }
  });
});
