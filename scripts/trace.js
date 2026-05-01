#!/usr/bin/env node
/**
 * scripts/trace.js — Trace replay CLI
 *
 * Pulls the full lifecycle of a single trace_id from both:
 *   - DB log tables (via v_trace_timeline) — the curated audit
 *   - Railway stdout JSON logs — the rich adapter events
 *
 * Merges by timestamp, dedupes, renders chronologically with
 * humanize() copy from EVENT_REGISTRY.md descriptions.
 *
 * Usage:
 *   node scripts/trace.js <trace_id>
 *   node scripts/trace.js <trace_id> --raw    # show raw JSON instead of humanized
 *   node scripts/trace.js --recent            # show 10 most recent traces with names
 *   node scripts/trace.js --check             # verify DB connectivity and pg module
 *
 * No env setup needed — DB URL is hardcoded as fallback.
 * Run from: AccessSync GitHub/accesssync/
 *
 * Daxx-only diagnostic tool. Not for operator use.
 */

'use strict';

const { Pool } = require('pg');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── ANSI colour helpers ────────────────────────────────────────────
const c = {
  dim:    s => `\x1b[2m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  blue:   s => `\x1b[34m${s}\x1b[0m`,
  grey:   s => `\x1b[90m${s}\x1b[0m`,
};

const sevColour = level => ({
  debug:    c.grey,
  info:     s => s,
  warn:     c.yellow,
  error:    c.red,
  critical: c.red,
}[level] || (s => s));

// ── Humanize: parse EVENT_REGISTRY.md once, build event → description map ──
function loadEventRegistry() {
  const registryPath = path.join(__dirname, '..', 'core', 'EVENT_REGISTRY.md');
  const text = fs.readFileSync(registryPath, 'utf8');
  const map = {};
  // Match table rows: | `event.name` | level | description |
  const rowRegex = /^\|\s*`([^`]+)`\s*(?:\/\s*`([^`]+)`)?(?:\s*\/\s*`([^`]+)`)?\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/gm;
  let m;
  while ((m = rowRegex.exec(text)) !== null) {
    const [, e1, e2, e3, level, desc] = m;
    const events = [e1, e2, e3].filter(Boolean);
    const levels = level.split('/').map(s => s.trim());
    events.forEach((evt, i) => {
      // Skip namespace-only rows like `grant.*`
      if (evt.endsWith('.*')) return;
      map[evt] = { level: levels[i] || levels[0] || 'info', desc };
    });
  }
  return map;
}

// DB-lifecycle event_type values from member_access_log — these aren't in the
// EVENT_REGISTRY (which covers code-emitted log events). Provide explicit copy
// so the operator-facing audit row makes sense in plain English.
const DB_EVENT_COPY = {
  provisioned:                'Access provisioned at hardware — member can enter',
  revoked:                    'Access revoked at hardware — member can no longer enter',
  sub_member_soft_deleted:    'Sub-member finalized as deleted — personal info purged, audit lineage preserved (DR-044)',
  cancelled_by_member:        'Plan cancelled by member',
  cancelled_by_system:        'Plan cancelled by system',
  cancelled_expired:          'Plan ended on expiration date',
  cancelled_booking:          'Booking cancelled',
  suspended:                  'Access suspended (payment failed or admin action)',
  reactivated:                'Access reactivated (payment recovered)',
  failed:                     'Provisioning failed',
};

// Overrides for code-emitted events where the EVENT_REGISTRY description is
// terse or shared across multiple events. These produce richer operator-facing
// copy when the trace tool renders them.
const COPY_OVERRIDES = {
  'kisi.role.assigning':           'Calling Kisi to grant access — assignRole started',
  'kisi.role.assigned':            'Kisi confirmed access grant — role assignment created',
  'kisi.role.assign_failed':       'Kisi rejected the access grant — see error details',
  'kisi.role.removing':            'Calling Kisi to revoke access — removeRole started',
  'kisi.role.removed':             'Kisi confirmed access revoke — role assignment deleted',
  'kisi.role.remove_failed':       'Kisi rejected the access revoke — see error details',
  'kisi.role.remove_skipped_already_gone': 'Kisi role was already gone — idempotent skip (no-op)',
  'kisi.role.already_exists':      'Member already had this role at Kisi — reused existing assignment',
  'kisi.user.created':             'New Kisi user account created for this member',
  'kisi.user.suspending':          'Suspending access at Kisi (payment failed flow)',
  'kisi.user.suspended':           'Access suspended at Kisi',
  'kisi.user.enabling':            'Re-enabling access at Kisi (payment recovered flow)',
  'kisi.user.enabled':             'Access re-enabled at Kisi',
  'kisi.user.deleting':            'Deleting Kisi user account (member.deleted flow)',
  'kisi.user.deleted':             'Kisi user account deleted',
  'adapter.identity_found':        'Found existing Kisi user by email — reusing account',
  'adapter.identity_creating':     'No existing Kisi user — creating a new account',
  'adapter.identity_cache_hit':    'Resolved hardware user from local cache (no Kisi call)',
  'revoke.group.skipped':          'Revoke skipped for this hardware group — member still has another active source (multi-source safety)',
  'grant.role.source_exists':      'Member already had access to this group from another source — recorded the new source, no hardware call needed',
  'grant.role.reused':             'Reused an existing role assignment from a prior grant (idempotent retry)',
  'queue.job.start':               'Job picked up by the queue worker',
  'queue.job.completed':           'Job finished successfully',
  'queue.grant.complete':          'Grant flow finished — all hardware calls complete and DB state recorded',
  'queue.revoke.complete':         'Revoke flow finished — all hardware calls complete and DB state recorded',
  'queue.grant.lock_acquired':     'Acquired in-flight lock (prevents concurrent operations on this member)',
  'queue.revoke.lock_acquired':    'Acquired in-flight lock (prevents concurrent operations on this member)',
  'queue.grant.identity_resolved': 'Hardware user identity resolved — ready for hardware calls',
  'queue.grant.mappings_resolved': 'Plan mapped to hardware groups — ready to assign roles',
  'queue.grant.hardware_calls_complete':  'All hardware calls finished — recording DB state',
  'queue.revoke.hardware_calls_complete': 'All hardware calls finished — recording DB state',
  'revoke.start':                  'Starting revoke flow',
  'member.sub_member.soft_deleted':         'Sub-member soft-deleted — DB record kept as audit shell, PII purged (DR-044)',
  'member.sub_member.soft_delete_idempotent_skip': 'Soft-delete already happened — no-op (race or replay)',
};

function humanize(event, registry) {
  if (COPY_OVERRIDES[event]) return COPY_OVERRIDES[event];
  if (DB_EVENT_COPY[event]) return DB_EVENT_COPY[event];
  const entry = registry[event];
  if (entry) return entry.desc;
  // Fallback: convert dot.notation to Title Case
  return event.split('.').map(s => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ')).join(' › ');
}

// ── DB query ───────────────────────────────────────────────────────
// Fallback to Railway public proxy so `node scripts/trace.js <id>` works
// locally without any env setup — no need for `railway variables` lookup.
const RAILWAY_PUBLIC_URL = 'postgresql://postgres:uSfbDjUYlneLoTXwCEEmVuGlBtFVrgFW@gondola.proxy.rlwy.net:27298/railway';

async function queryDb(traceId) {
  const url = process.env.DATABASE_URL || RAILWAY_PUBLIC_URL;
  if (!url) throw new Error('DATABASE_URL env var required');
  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    const res = await pool.query(
      `SELECT ts, source, event, actor_type, actor_id, member_name, member_email,
              client_name, plan_name, door_name, hardware_platform, source_platform,
              hardware_user_id, target_id, target_type, result, detail, entry_point
       FROM v_trace_timeline
       WHERE trace_id = $1
       ORDER BY ts ASC`,
      [traceId]
    );
    const ctx = await pool.query(
      `SELECT trace_id, member_name, member_email, client_name, plan_name,
              hardware_platform, source_platform, hardware_user_id,
              actor_type, actor_id, entry_point, started_at, member_id
       FROM trace_context
       WHERE trace_id = $1`,
      [traceId]
    );
    let context = ctx.rows[0] || null;

    // Fallback: if no trace_context row (revoke path doesn't write one), recover
    // member identity from member_access_log → member_identity directly.
    if (!context) {
      const fallback = await pool.query(
        `SELECT mi.id AS member_id,
                TRIM(CONCAT(mi.first_name, ' ', mi.last_name)) AS member_name,
                mi.email AS member_email,
                mi.hardware_platform, mi.source_platform, mi.hardware_user_id,
                c.name AS client_name,
                mal.actor_type, mal.actor_id,
                mal.created_at AS started_at
         FROM member_access_log mal
         JOIN member_identity mi ON mi.id = mal.member_id
         JOIN clients c ON c.id = mal.client_id
         WHERE mal.trace_id = $1
         LIMIT 1`,
        [traceId]
      );
      if (fallback.rows[0]) {
        context = { ...fallback.rows[0], _fallback: true };
      }
    }

    // Enrich: pull MRA rows for this member so provisioned events show
    // mapping/group even when member_access_log.mapping_id is null (sub-member path gap).
    let mraRows = [];
    if (context && context.member_id) {
      const mra = await pool.query(
        `SELECT mra.role_assignment_id, mra.hardware_group_id, mra.billing_snapshot,
                pm.plan_name, pm.door_name, pm.action
         FROM member_role_assignments mra
         LEFT JOIN plan_mappings pm ON pm.id = mra.mapping_id
         WHERE mra.member_id = $1`,
        [context.member_id]
      );
      mraRows = mra.rows;
    }

    return { events: res.rows, context, mraRows };
  } finally {
    await pool.end();
  }
}

// ── Railway log fetch ──────────────────────────────────────────────
// Uses shell mode so PATH lookup works for the railway shim on Windows + Unix.
// The railway CLI streams logs from its log-shipping endpoint — usually 5-30s of
// recent stdout per invocation. For older traces, the data may not be available.
function fetchRailwayLogs(traceId) {
  return new Promise((resolve, reject) => {
    // Pass the full command string to shell directly to avoid DEP0190 (args + shell: true).
    const cmd = 'railway logs --service accesssync --json';
    const opts = { maxBuffer: 50 * 1024 * 1024, shell: true, windowsHide: true };
    execFile(cmd, [], opts, (err, stdout) => {
      if (err && !stdout) return reject(err);
      const lines = (stdout || '').split('\n').filter(Boolean);
      const matched = [];
      for (const line of lines) {
        if (!line.includes(traceId)) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.traceId === traceId) matched.push(obj);
        } catch (_) { /* skip non-JSON lines */ }
      }
      resolve(matched);
    });
  });
}

// ── Merge + render ─────────────────────────────────────────────────
function buildTimeline(dbEvents, railwayEvents) {
  // DB events come from v_trace_timeline (already-aggregated audit rows).
  // Railway events come from stdout (the full info-level firehose).
  // Many DB events have a parallel Railway event (same trace_id, similar time).
  // We dedupe on (event_name, second-level timestamp) — Railway is canonical for info events.

  const seen = new Set();
  const unified = [];

  // Index DB events by event name + timestamp-second for dedup awareness
  const dbKeys = new Set();
  for (const e of dbEvents) {
    const tsKey = e.ts ? new Date(e.ts).toISOString().slice(0, 19) : '';
    dbKeys.add(`${e.event}|${tsKey}`);
    unified.push({
      ts:     e.ts,
      source: 'db',
      event:  e.event,
      level:  'info',
      actor:  e.actor_type ? `${e.actor_type}/${e.actor_id || '?'}` : null,
      meta:   {
        memberName: e.member_name, memberEmail: e.member_email, planName: e.plan_name,
        doorName: e.door_name, clientName: e.client_name, hardwareUserId: e.hardware_user_id,
        result: e.result, detail: e.detail, sourceTable: e.source,
      },
    });
  }

  for (const e of railwayEvents) {
    const tsRaw = e.ts || e.timestamp;
    const tsKey = tsRaw ? new Date(tsRaw).toISOString().slice(0, 19) : '';
    const dedupKey = `${e.event}|${tsKey}`;
    if (dbKeys.has(dedupKey)) continue;  // DB version already in unified
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    unified.push({
      ts:     tsRaw,
      source: 'railway',
      event:  e.event,
      level:  e.level || 'info',
      actor:  e.actor_type ? `${e.actor_type}/${e.actor_id || '?'}` : null,
      meta:   {
        memberId: e.memberId, platformMemberId: e.platformMemberId,
        userId: e.userId, groupId: e.groupId, roleAssignmentId: e.roleAssignmentId,
        hardwareUserId: e.hardwareUserId, hardwarePlatform: e.hardwarePlatform,
        clientId: e.clientId, planId: e.planId, eventType: e.eventType,
        stage: e.stage, result: e.result, durationMs: e.durationMs, attempt: e.attempt,
        jobId: e.jobId, jobName: e.jobName,
        message: e.message !== e.event ? e.message : null,
      },
    });
  }

  unified.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  return unified;
}

function renderEvent(evt, registry, idx, raw) {
  const ts = evt.ts ? new Date(evt.ts).toISOString().replace('T', ' ').slice(11, 23) : '????????????';
  const colour = sevColour(evt.level);
  const sourceTag = evt.source === 'db' ? c.cyan('[db]') : c.dim('[rwy]');
  const eventName = colour(evt.event);
  const actor = evt.actor ? c.dim(`(${evt.actor})`) : '';

  const human = raw ? '' : '\n     ' + c.dim(humanize(evt.event, registry));

  const metaLines = [];
  const m = evt.meta || {};
  if (m.memberName)        metaLines.push(`member: ${m.memberName}${m.memberEmail ? ` <${m.memberEmail}>` : ''}`);
  if (m.platformMemberId)  metaLines.push(`platform_member_id: ${m.platformMemberId}`);
  if (m.userId)            metaLines.push(`kisi user: ${m.userId}`);
  if (m.hardwareUserId && !m.userId) metaLines.push(`hardware_user_id: ${m.hardwareUserId}`);
  if (m.groupId)           metaLines.push(`kisi group: ${m.groupId}`);
  if (m.roleAssignmentId)  metaLines.push(`role assignment: ${m.roleAssignmentId}`);
  if (m.planName)          metaLines.push(`plan: ${m.planName}`);
  if (m.doorName)          metaLines.push(`door: ${m.doorName}`);
  if (m.clientName)        metaLines.push(`client: ${m.clientName}`);
  if (m.eventType)         metaLines.push(`event_type: ${m.eventType}`);
  if (m.attempt)           metaLines.push(`attempt: ${m.attempt}`);
  if (m.durationMs)        metaLines.push(`duration: ${m.durationMs}ms`);
  if (m.result === 'success' || m.result === 'finalized') metaLines.push(c.green(`result: ${m.result}`));
  if (m.result === 'skipped' || m.result === 'failed')    metaLines.push(c.yellow(`result: ${m.result}`));
  if (m.message)           metaLines.push(`message: ${m.message}`);
  if (m.detail) {
    const detailStr = typeof m.detail === 'object' ? JSON.stringify(m.detail) : String(m.detail);
    if (detailStr && detailStr !== '{}' && detailStr !== '[object Object]') metaLines.push(`detail: ${detailStr}`);
  }

  const meta = metaLines.length ? '\n     ' + c.dim(metaLines.join(' · ')) : '';

  return `${c.dim(String(idx + 1).padStart(3, ' '))}  ${ts}  ${sourceTag} ${eventName} ${actor}${human}${meta}`;
}

function renderContext(ctx) {
  if (!ctx) return c.dim('(no trace_context row — trace started outside enrichment path)');
  const lines = [];
  if (ctx._fallback)        lines.push(c.yellow('Context:    recovered from member_access_log (no trace_context row — revoke path gap)'));
  const memberName = ctx.member_name && ctx.member_name.trim() ? ctx.member_name : null;
  if (memberName)           lines.push(`Member:     ${memberName}${ctx.member_email ? ` <${ctx.member_email}>` : ''}`);
  else if (ctx.member_email) lines.push(`Member:     ${ctx.member_email}`);
  else                      lines.push(`Member:     ${c.dim('(PII purged — soft-deleted)')}`);
  if (ctx.client_name)      lines.push(`Client:     ${ctx.client_name}`);
  if (ctx.plan_name)        lines.push(`Plan:       ${ctx.plan_name}`);
  if (ctx.hardware_platform) lines.push(`Hardware:   ${ctx.hardware_platform}${ctx.hardware_user_id ? ` (user ${ctx.hardware_user_id})` : ''}`);
  if (ctx.source_platform)  lines.push(`Source:     ${ctx.source_platform}`);
  if (ctx.entry_point)      lines.push(`Entry:      ${ctx.entry_point}`);
  if (ctx.actor_type)       lines.push(`Actor:      ${ctx.actor_type}/${ctx.actor_id || '?'}`);
  if (ctx.started_at)       lines.push(`Started:    ${new Date(ctx.started_at).toISOString()}`);
  return lines.map(l => '  ' + l).join('\n');
}

// ── Recent traces helper ───────────────────────────────────────────
async function listRecentTraces(limit = 10) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL || RAILWAY_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  try {
    const res = await pool.query(
      `SELECT trace_id, member_name, client_name, plan_name, started_at, entry_point, actor_type
       FROM trace_context
       WHERE member_name IS NOT NULL OR client_name IS NOT NULL
       ORDER BY started_at DESC
       LIMIT $1`,
      [limit]
    );
    console.log(c.bold(`\n  Recent traces (${res.rows.length}):\n`));
    res.rows.forEach((r, i) => {
      const ts = new Date(r.started_at).toISOString().replace('T', ' ').slice(0, 19);
      const member = r.member_name || c.dim('(no member)');
      const client = r.client_name || c.dim('(no client)');
      console.log(`  ${c.dim(String(i + 1).padStart(2))}  ${c.cyan(r.trace_id)}  ${ts}  ${c.bold(member)}  ${c.dim(client)}  ${r.entry_point ? c.dim('[' + r.entry_point + ']') : ''}`);
    });
    console.log('');
  } finally {
    await pool.end();
  }
}

// ── Setup check ────────────────────────────────────────────────────
async function checkSetup() {
  console.log(c.bold('\n  AccessSync trace.js — setup check\n'));

  // 1. Node version
  const nv = process.version;
  console.log(`  ${c.green('✓')} Node ${nv}`);

  // 2. pg module
  try {
    require('pg');
    console.log(`  ${c.green('✓')} pg module found`);
  } catch (_) {
    console.log(`  ${c.red('✗')} pg module missing — run: npm install`);
    process.exit(1);
  }

  // 3. Working directory — must be inside accesssync/
  const cwd = process.cwd();
  const inRoot = fs.existsSync(path.join(cwd, 'package.json'));
  if (inRoot) {
    console.log(`  ${c.green('✓')} Working directory: ${cwd}`);
  } else {
    console.log(`  ${c.yellow('!')} Working directory: ${cwd}`);
    console.log(`      Expected to be run from AccessSync GitHub/accesssync/`);
  }

  // 4. DB connectivity
  const url = process.env.DATABASE_URL || RAILWAY_PUBLIC_URL;
  const urlDisplay = url.replace(/:([^@]+)@/, ':***@');
  console.log(`  ${c.dim('→')} Connecting to ${urlDisplay} ...`);
  try {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 5000 });
    const r = await pool.query('SELECT COUNT(*) FROM trace_context');
    await pool.end();
    console.log(`  ${c.green('✓')} DB connected — ${r.rows[0].count} trace_context rows`);
  } catch (e) {
    console.log(`  ${c.red('✗')} DB connection failed: ${e.message}`);
    console.log(`      Update RAILWAY_PUBLIC_URL in scripts/trace.js if the proxy URL has rotated`);
    process.exit(1);
  }

  // 5. railway CLI (optional — needed for live log enrichment)
  const { execSync } = require('child_process');
  try {
    execSync('railway --version', { stdio: 'pipe' });
    console.log(`  ${c.green('✓')} railway CLI found`);
  } catch (_) {
    console.log(`  ${c.yellow('!')} railway CLI not found — DB-only mode (no live log enrichment)`);
    console.log(`      Install: npm i -g @railway/cli`);
  }

  console.log(c.bold('\n  All good. Run: node scripts/trace.js --recent\n'));
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const raw = args.includes('--raw');
  const recent = args.includes('--recent');
  const check = args.includes('--check');

  if (check) {
    await checkSetup();
    return;
  }

  if (recent) {
    await listRecentTraces();
    return;
  }

  // Accept a raw paste block as the argument — extract UUID from any of these formats:
  //   f74e7d42-2a45-4b8e-bc58-7973cfe98857
  //   trace f74e7d42-2a45-4b8e-bc58-7973cfe98857
  //   # CLI: DATABASE_URL=... node scripts/trace.js f74e7d42-2a45-4b8e-bc58-7973cfe98857
  const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const rawArg  = args.filter(a => !a.startsWith('--')).join(' ');
  const uuidMatch = rawArg.match(UUID_RE);
  const traceId = uuidMatch ? uuidMatch[0] : null;

  if (!traceId) {
    console.error('Usage:  trace <trace_id>');
    console.error('        trace <trace_id> --raw');
    console.error('        trace --recent');
    console.error('        trace --check');
    console.error('');
    console.error('Also accepts raw paste blocks — just pass the whole "trace <uuid>" line.');
    process.exit(1);
  }

  const registry = loadEventRegistry();

  console.log(c.bold(`\nTrace: ${c.cyan(traceId)}`));
  console.log(c.dim('─'.repeat(80)));

  const [dbResult, railwayEvents] = await Promise.all([
    queryDb(traceId),
    fetchRailwayLogs(traceId).catch(err => {
      console.error(c.yellow(`  (railway fetch failed: ${err.message} — continuing with DB only)`));
      return [];
    }),
  ]);

  console.log(c.bold('\nContext:'));
  console.log(renderContext(dbResult.context));

  const timeline = buildTimeline(dbResult.events, railwayEvents);

  if (timeline.length === 0) {
    console.log(c.yellow('\n  No events found for this trace_id.\n'));
    return;
  }

  console.log(c.bold(`\nTimeline (${timeline.length} events):\n`));
  timeline.forEach((e, i) => console.log(renderEvent(e, registry, i, raw)));

  if (dbResult.mraRows && dbResult.mraRows.length > 0) {
    console.log(c.bold('\nHardware assignments (member_role_assignments):\n'));
    dbResult.mraRows.forEach(r => {
      const parts = [
        r.plan_name  ? `plan: ${r.plan_name}`             : null,
        r.door_name  ? `door: ${r.door_name}`             : null,
        r.hardware_group_id ? `group: ${r.hardware_group_id}` : null,
        r.role_assignment_id ? `role: ${r.role_assignment_id}` : null,
        r.billing_snapshot ? c.green('billing_snapshot: ✓') : c.yellow('billing_snapshot: null'),
      ].filter(Boolean);
      console.log('  ' + c.dim(parts.join(' · ')));
    });
  }

  console.log('');
}

main().catch(err => {
  console.error(c.red('ERROR: ' + err.message));
  if (err.stack) console.error(c.dim(err.stack));
  process.exit(1);
});
