/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: every INSERT into a log table includes trace_id              │
 * │                                                                         │
 * │  Business consequence: When an INSERT into webhook_log / diagnostic_log │
 * │  / member_access_log / error_queue / config_alert_log / adapter_admin_  │
 * │  log writes a row WITHOUT trace_id, that row is invisible to the        │
 * │  v_trace_timeline view (the view filters WHERE trace_id IS NOT NULL).   │
 * │  The Admin Trace Timeline UI would silently miss those events.          │
 * │  Debugging a production incident becomes a Where's-Waldo exercise       │
 * │  across 7 disconnected log tables.                                      │
 * │                                                                         │
 * │  Pre-fix audit (2026-04-28) found 92–100% null trace_id rates in        │
 * │  diagnostic_log / member_access_log / error_queue / config_alert_log    │
 * │  / webhook_log production data. Root cause: 14 INSERT statements        │
 * │  across 8 files omitted trace_id from their column list.                │
 * │                                                                         │
 * │  Convention: every INSERT INTO <log table> in core/ or admin/ must      │
 * │  include trace_id in its column list. Enforced here so the regression  │
 * │  cannot recur — a new contributor adding a log INSERT without          │
 * │  trace_id fails this gate before it reaches Railway.                    │
 * │                                                                         │
 * │  Runtime impact: ~50ms filesystem scan. Zero production impact.         │
 * │  Governed by: DR-037 (Observability Architecture)                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_TABLES = [
  'webhook_log',
  'diagnostic_log',
  'member_access_log',
  'error_queue',
  'config_alert_log',
  'adapter_admin_log',
  // activity_event is fully governed by admin/middleware/activity.js — exempt
  // from this scan because every call site goes through one helper that already
  // includes trace_id.
];

const SCAN_ROOTS = [
  path.join(__dirname, '..', '..', 'core'),
  path.join(__dirname, '..', '..', 'adapters'),
  path.join(__dirname, '..', '..', 'admin'),
];

const SKIP_FILES = new Set([
  // seed.js writes mock data — trace_ids would be synthetic. Exempt.
  'seed.js',
]);

function collectJsFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.js')) files.push(full);
    }
  }
  walk(root);
  return files;
}

/**
 * Returns array of { file, line, statement } for every INSERT into a log table
 * that does NOT include trace_id in its column list.
 *
 * INSERTs may span multiple lines — we capture the column list between
 * "INTO <table> (" and the first ")" that closes it.
 */
function findOffenders(file) {
  const src = fs.readFileSync(file, 'utf8');
  const offenders = [];

  for (const table of LOG_TABLES) {
    // Match: INSERT INTO <table> ( ... )
    // Permissive about whitespace and template-literal backticks.
    const re = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)`, 'gm');
    let m;
    while ((m = re.exec(src)) !== null) {
      const columnList = m[1];
      // Compute line number of the match start
      const before = src.slice(0, m.index);
      const line = before.split('\n').length;

      if (!/\btrace_id\b/.test(columnList)) {
        offenders.push({
          file: path.relative(path.join(__dirname, '..', '..'), file),
          line,
          table,
          columnList: columnList.trim().replace(/\s+/g, ' ').slice(0, 120),
        });
      }
    }
  }
  return offenders;
}

describe('log table INSERTs include trace_id', () => {
  test('every INSERT into a log table includes trace_id in its column list', () => {
    const allFiles = SCAN_ROOTS.flatMap(collectJsFiles)
      .filter((f) => !SKIP_FILES.has(path.basename(f)));

    const offenders = [];
    for (const f of allFiles) {
      offenders.push(...findOffenders(f));
    }

    if (offenders.length > 0) {
      const msg = offenders
        .map((o) => `  ${o.file}:${o.line}  INSERT INTO ${o.table} (${o.columnList})`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} INSERT(s) into a log table without trace_id:\n${msg}\n\n` +
        `Fix: add trace_id, actor_type, actor_id to the column list and pull values\n` +
        `from getTraceId() / getActor() in core/trace-context.js. See activity.js for pattern.`
      );
    }
    expect(offenders.length).toBe(0);
  });
});
