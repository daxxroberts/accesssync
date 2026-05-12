/**
 * @file bundle-assembler.js
 * @layer core/ai
 * @role bundle-assembly
 * @reads v_trace_timeline, trace_context, member_master, member_access,
 *        member_access_sources, plan_mappings,
 *        core/ai/static/*.md, core/EVENT_REGISTRY.md
 * @exports buildTraceBundle(traceId), buildMemberBundle(memberId)
 *
 * Assembles paste-ready text bundles for use with external AI tools (Claude.ai,
 * etc.). Trace bundles cover one trace; member bundles cover up to the last
 * 100 traces for one member. No AI calls are made by this module — it just
 * concatenates database results, filtered static documents, and recent
 * context into a single string.
 *
 * Output format is plain UTF-8 text designed to paste cleanly into a chat UI.
 * The instruction block at the top tells the receiving AI what's in the bundle
 * and what shape to return its response in.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const cp   = require('node:child_process');
const db   = require('../../db');

const STATIC_DIR = path.join(__dirname, 'static');
const REPO_ROOT  = path.join(__dirname, '..', '..');
const VAULT_GAP_LOG_PATH_HINT =
  'AccessSync/00_Vault_Control/bundle_gap_log.md (vault — written via vault-write helper, not directly by Railway runtime)';

const MAX_MEMBER_TRACES = 100;

// ─── Static document loaders ─────────────────────────────────────────
// Read once at module load, cache in memory. The bundle assembler is
// stateless beyond this — it doesn't watch for file changes. KEEPER's
// protocol is: edit the file, redeploy. Cheap on Railway.

function readStatic(name) {
  const p = path.join(STATIC_DIR, name);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

const INSTRUCTION_BLOCK = readStatic('BUNDLE_INSTRUCTION_BLOCK.md');
const LAYER_MAP_RAW     = readStatic('LAYER_TO_FILE_MAP.md');
const DR_LEDGER_RAW     = readStatic('DR_LEDGER_CONDENSED.md');
const EVENT_REGISTRY_RAW = (() => {
  const p = path.join(REPO_ROOT, 'core', 'EVENT_REGISTRY.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
})();

/**
 * Extracts the canonical prompt body from BUNDLE_INSTRUCTION_BLOCK.md by
 * pulling the text between the BUNDLE-INSTRUCTION-START and -END markers.
 * The rest of the file is documentation about the prompt; we don't paste it.
 */
function extractInstructionBody(raw) {
  if (!raw) return '';
  const m = raw.match(/<!-- BUNDLE-INSTRUCTION-START -->([\s\S]*?)<!-- BUNDLE-INSTRUCTION-END -->/);
  return m ? m[1].trim() : raw;
}

/**
 * Reads the template_version from BUNDLE_INSTRUCTION_BLOCK.md frontmatter.
 * Returns 'unknown' if the file or field is missing.
 */
function templateVersion() {
  if (!INSTRUCTION_BLOCK) return 'unknown';
  const m = INSTRUCTION_BLOCK.match(/^template_version:\s*([\w.-]+)/m);
  return m ? m[1] : 'unknown';
}

// ─── Layer-to-file map filtering ─────────────────────────────────────
// The map has sections marked with markdown headers; we extract the
// relevant subsections for the trace's source/hardware platforms and
// always include the SHARED + ADMIN sections.

function filterLayerMap(sourcePlatform, hardwarePlatform) {
  if (!LAYER_MAP_RAW) return '(layer map unavailable)';

  const out = [];
  const sp = (sourcePlatform || '').toLowerCase();
  const hp = (hardwarePlatform || '').toLowerCase();

  // Source platform section — match heading like "### wix"
  const sourceSection = matchSubsection(LAYER_MAP_RAW, '## Source platform layers', `### ${sp}`);
  if (sourceSection) {
    out.push(`## Source platform: ${sp}`);
    out.push(sourceSection.trim());
  } else if (sp) {
    out.push(`## Source platform: ${sp} (not in map — only shared layers shown below)`);
  }

  // Hardware platform section
  const hwSection = matchSubsection(LAYER_MAP_RAW, '## Hardware platform layers', `### ${hp}`);
  if (hwSection) {
    out.push(`## Hardware platform: ${hp}`);
    out.push(hwSection.trim());
  } else if (hp) {
    out.push(`## Hardware platform: ${hp} (not in map — only shared layers shown below)`);
  }

  // Always include shared + admin sections, lifted whole
  const shared = matchTopSection(LAYER_MAP_RAW, '## Shared layers (always included regardless of platform pair)');
  if (shared) out.push('## Shared layers\n' + shared.trim());
  const admin  = matchTopSection(LAYER_MAP_RAW, '## Admin layers (UI / API for operators and owner)');
  if (admin) out.push('## Admin layers\n' + admin.trim());

  return out.join('\n\n');
}

function matchTopSection(text, heading) {
  // Lift everything from `heading` until the next `##` header (or EOF)
  const idx = text.indexOf(heading);
  if (idx < 0) return null;
  const tail = text.slice(idx + heading.length);
  const next = tail.search(/\n##\s/);
  return next < 0 ? tail : tail.slice(0, next);
}

function matchSubsection(text, parentHeading, subHeading) {
  // Lift the body of `subHeading` within the `parentHeading` block
  const parent = matchTopSection(text, parentHeading);
  if (!parent) return null;
  const idx = parent.indexOf(subHeading);
  if (idx < 0) return null;
  const tail = parent.slice(idx + subHeading.length);
  const next = tail.search(/\n###\s/);
  return next < 0 ? tail : tail.slice(0, next);
}

// ─── DR ledger filtering ─────────────────────────────────────────────
// Pull only DRs that the bundle's events plausibly touch. For v1, we ship
// the full ledger every time — it's already condensed and small (~3500
// chars for 40 DRs). Optimization for filter-by-event comes later if
// bundle size becomes a problem.

function fullDrLedger() {
  if (!DR_LEDGER_RAW) return '(DR ledger unavailable)';
  // Strip the frontmatter and authoring docs at the top; keep from "## Active Decisions"
  const idx = DR_LEDGER_RAW.indexOf('## Active Decisions');
  return idx >= 0 ? DR_LEDGER_RAW.slice(idx) : DR_LEDGER_RAW;
}

// ─── EVENT_REGISTRY filtering ────────────────────────────────────────
// Find which event names appear in the bundle's events, then pull the
// matching rows from EVENT_REGISTRY. Event names in the registry sit in
// markdown table rows; match them by literal substring.

function filterEventRegistry(eventNames) {
  if (!EVENT_REGISTRY_RAW) return '(EVENT_REGISTRY unavailable)';
  if (!eventNames || eventNames.size === 0) return '(no events in this bundle to filter the registry against)';

  const lines = EVENT_REGISTRY_RAW.split('\n');
  const out = [];
  // Always include the header / namespaces section so the AI knows the catalog's structure
  let inHeader = true;
  for (const line of lines) {
    if (inHeader) {
      out.push(line);
      // Stop the header dump once we hit the first event-table separator
      if (line.startsWith('## Grant') || line.startsWith('## Queue') || line.startsWith('## ')) {
        if (out.length > 8) inHeader = false;
      }
      continue;
    }
    // From here on, only include lines that match an event in our set,
    // plus their section headers.
    if (line.startsWith('## ')) { out.push('\n' + line); continue; }
    for (const name of eventNames) {
      if (line.includes('`' + name + '`') || line.includes(name)) {
        out.push(line); break;
      }
    }
  }
  return out.join('\n');
}

// ─── Recent context loaders ──────────────────────────────────────────

function recentCommits(limit = 10) {
  try {
    const out = cp.execSync(`git log --oneline -${limit}`, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 3000 });
    return out.trim();
  } catch (_) {
    return '(git log unavailable in this environment)';
  }
}

function recentClosedObs(limit = 5) {
  // open_items.md is in the vault. The Railway server doesn't have the vault.
  // For runtime, we expose recent OBs through a small helper file kept in the
  // repo if/when KEEPER mirrors them. For now, no-op gracefully.
  // NOTE: when Daxx wants this enabled, KEEPER mirrors the relevant section
  // to core/ai/static/RECENT_CLOSED_OBS.md and we read from there.
  const p = path.join(STATIC_DIR, 'RECENT_CLOSED_OBS.md');
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, 'utf8').trim();
  }
  return '(closed-OB mirror not yet provided — vault-only resource. KEEPER can mirror the last 5 closed OBs to core/ai/static/RECENT_CLOSED_OBS.md when desired.)';
}

function recentChangelogEntry() {
  const p = path.join(STATIC_DIR, 'RECENT_CHANGELOG_ENTRY.md');
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, 'utf8').trim();
  }
  return '(changelog mirror not yet provided — vault-only resource. KEEPER can mirror the last vault changelog entry to core/ai/static/RECENT_CHANGELOG_ENTRY.md when desired.)';
}

// ─── Dynamic context loaders (live SQL) ──────────────────────────────

async function loadTraceContext(traceId) {
  const r = await db.query(
    `SELECT trace_id, started_at, client_id, client_name,
            member_id, member_name, member_email, platform_member_id,
            source_platform, hardware_platform, hardware_user_id,
            plan_name, door_name, mapping_id,
            actor_type, actor_id, entry_point
     FROM trace_context WHERE trace_id = $1`,
    [traceId]
  );
  return r.rows[0] || null;
}

async function loadTraceEvents(traceId) {
  const r = await db.query(
    `SELECT trace_id, ts, source, actor_type, actor_id, event,
            target_type, target_id, result, detail, client_id,
            client_name, member_name, member_email,
            source_platform, hardware_platform, hardware_user_id,
            plan_name, door_name, entry_point
     FROM v_trace_timeline
     WHERE trace_id = $1
     ORDER BY ts ASC`,
    [traceId]
  );
  return r.rows;
}

async function loadWebhookPayloads(traceId) {
  // For traces with webhook events, pull both raw_payload and normalized_payload
  // so the AI can see what Wix actually sent vs how Layer 2 normalized it.
  const r = await db.query(
    `SELECT id, event_id, received_at, hmac_status, dedup_status, event_type,
            raw_payload, normalized_payload, error_detail
     FROM webhook_log
     WHERE trace_id = $1
     ORDER BY received_at ASC`,
    [traceId]
  );
  return r.rows;
}

async function loadMemberSnapshot(memberId) {
  // memberId is member_access.id.
  // Returns:
  //   master  — member_master columns (person identity: email, name, platform_member_id, source_tag)
  //   access  — member_access columns (the seat: status, hardware_user_id, hardware_platform, etc.)
  //   sources — member_access_sources rows (the receipts justifying the seat, with plan/door denormalized)
  const row = await db.query(
    `SELECT mm.id           AS master_id,
            mm.email,
            mm.first_name,
            mm.last_name,
            mm.display_name,
            mm.platform_member_id,
            mm.source_platform,
            mm.source_tag,
            ma.id            AS access_id,
            ma.client_id,
            ma.hardware_user_id,
            ma.hardware_platform,
            ma.status,
            ma.provisioned_at,
            ma.scheduled_start_date,
            ma.pending_plan_id,
            ma.sub_master_id,
            ma.created_at    AS access_created_at,
            ma.updated_at    AS access_updated_at
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
      WHERE ma.id = $1`, [memberId]
  );
  if (!row.rows.length) return null;
  const r = row.rows[0];

  const sources = await db.query(
    `SELECT mas.id,
            mas.role_assignment_id,
            mas.hardware_group_id,
            mas.source_type,
            mas.source_plan_id,
            mas.mapping_id,
            mas.effective_start,
            mas.valid_until,
            mas.created_at,
            pm.plan_name,
            pm.door_name
       FROM member_access_sources mas
       LEFT JOIN plan_mappings pm ON pm.id = mas.mapping_id
      WHERE mas.access_id = $1
      ORDER BY mas.created_at ASC`, [memberId]
  );

  return {
    master: {
      id:                 r.master_id,
      email:              r.email,
      first_name:         r.first_name,
      last_name:          r.last_name,
      display_name:       r.display_name,
      platform_member_id: r.platform_member_id,
      source_platform:    r.source_platform,
      source_tag:         r.source_tag,
    },
    access: {
      id:                   r.access_id,
      client_id:            r.client_id,
      hardware_user_id:     r.hardware_user_id,
      hardware_platform:    r.hardware_platform,
      status:               r.status,
      provisioned_at:       r.provisioned_at,
      scheduled_start_date: r.scheduled_start_date,
      pending_plan_id:      r.pending_plan_id,
      sub_master_id:        r.sub_master_id,
      created_at:           r.access_created_at,
      updated_at:           r.access_updated_at,
    },
    sources: sources.rows,
  };
}

async function loadMemberTraces(memberId, limit = MAX_MEMBER_TRACES) {
  // Pull the most recent N traces that touched this member, oldest first
  // within the window (so chronological reading is natural).
  // name/email come from member_master via JOIN through member_access.
  const r = await db.query(
    `SELECT DISTINCT trace_id, MIN(ts) AS first_ts
       FROM v_trace_timeline
      WHERE member_name = (SELECT mm.display_name
                             FROM member_access ma
                             JOIN member_master mm ON mm.id = ma.member_master_id
                            WHERE ma.id = $1)
         OR member_email = (SELECT mm.email
                              FROM member_access ma
                              JOIN member_master mm ON mm.id = ma.member_master_id
                             WHERE ma.id = $1)
      GROUP BY trace_id
      ORDER BY first_ts DESC
      LIMIT $2`,
    [memberId, limit]
  );
  return r.rows.map(x => x.trace_id);
}

// ─── Bundle assemblers ───────────────────────────────────────────────

async function buildTraceBundle(traceId) {
  const ctx = await loadTraceContext(traceId);
  const events = await loadTraceEvents(traceId);
  if (events.length === 0) {
    const err = new Error('Trace not found or has no events.');
    err.statusCode = 404;
    throw err;
  }

  const sourcePlatform   = ctx?.source_platform   || (events[0] && events[0].source_platform)   || null;
  const hardwarePlatform = ctx?.hardware_platform || (events[0] && events[0].hardware_platform) || null;

  const eventNames = new Set(events.map(e => e.event).filter(Boolean));

  const webhooks = await loadWebhookPayloads(traceId);

  const out = [];
  out.push(renderHeader('trace', traceId, sourcePlatform, hardwarePlatform));
  out.push(extractInstructionBody(INSTRUCTION_BLOCK)
    .replace(/\{source_platform\}/g, sourcePlatform || 'unknown')
    .replace(/\{hardware_platform\}/g, hardwarePlatform || 'unknown')
    .replace(/\{source_layer_files\}/g, summarizeLayers(sourcePlatform, 'source'))
    .replace(/\{hardware_layer_files\}/g, summarizeLayers(hardwarePlatform, 'hardware'))
    .replace(/\{bundle_type\}/g, 'trace')
    .replace(/\{generated_at_iso\}/g, new Date().toISOString())
    .replace(/\{template_version\}/g, templateVersion()));

  out.push('\n\n=== Trace context ===\n' + JSON.stringify(ctx, null, 2));

  out.push('\n\n=== Trace events (chronological) ===');
  events.forEach((e, i) => {
    const dt = i === 0 ? 0 : Math.round(new Date(e.ts).getTime() - new Date(events[0].ts).getTime());
    out.push(`\n[${i + 1}/${events.length}] +${dt}ms  ${e.ts.toISOString()}`);
    out.push(`  source:  ${e.source}`);
    out.push(`  event:   ${e.event}`);
    out.push(`  result:  ${e.result || ''}`);
    out.push(`  actor:   ${e.actor_type || '?'}/${e.actor_id || '?'}`);
    if (e.detail !== null && e.detail !== undefined) {
      out.push('  detail:');
      JSON.stringify(e.detail, null, 2).split('\n').forEach(ln => out.push('    ' + ln));
    }
  });

  if (webhooks.length > 0) {
    out.push('\n\n=== Webhook payloads (raw + normalized) ===');
    webhooks.forEach((w, i) => {
      out.push(`\n[Webhook ${i + 1}] ${w.received_at.toISOString()}  event_type=${w.event_type}  hmac=${w.hmac_status}`);
      out.push('  raw_payload:');
      JSON.stringify(w.raw_payload, null, 2).split('\n').forEach(ln => out.push('    ' + ln));
      out.push('  normalized_payload:');
      JSON.stringify(w.normalized_payload, null, 2).split('\n').forEach(ln => out.push('    ' + ln));
      if (w.error_detail) out.push(`  error_detail: ${w.error_detail}`);
    });
  }

  out.push('\n\n=== EVENT_REGISTRY (filtered to events in this bundle) ===');
  out.push(filterEventRegistry(eventNames));

  out.push('\n\n=== DR ledger ===');
  out.push(fullDrLedger());

  out.push('\n\n=== Layer-to-file map ===');
  out.push(filterLayerMap(sourcePlatform, hardwarePlatform));

  out.push('\n\n=== Recent context ===');
  out.push('\n--- Last 10 commits ---');
  out.push(recentCommits(10));
  out.push('\n--- Last 5 closed OBs ---');
  out.push(recentClosedObs(5));
  out.push('\n--- Last vault changelog entry ---');
  out.push(recentChangelogEntry());

  out.push('\n\n=== End bundle ===');

  const body = out.join('\n');
  return {
    type:      'trace',
    trace_id:  traceId,
    text:      body,
    chars:     body.length,
    template_version: templateVersion(),
    generated_at: new Date().toISOString(),
  };
}

async function buildMemberBundle(memberId) {
  const snapshot = await loadMemberSnapshot(memberId);
  if (!snapshot) {
    const err = new Error('Member not found.');
    err.statusCode = 404;
    throw err;
  }

  const sourcePlatform   = snapshot.master.source_platform || null;
  const hardwarePlatform = snapshot.access.hardware_platform || null;

  const traceIds = await loadMemberTraces(memberId);

  // Pull events for all traces in one query, then group by trace_id
  let eventsByTrace = {};
  let allEventNames = new Set();
  if (traceIds.length > 0) {
    const r = await db.query(
      `SELECT trace_id, ts, source, actor_type, actor_id, event,
              target_type, target_id, result, detail
       FROM v_trace_timeline
       WHERE trace_id = ANY($1::text[])
       ORDER BY ts ASC`,
      [traceIds]
    );
    r.rows.forEach(e => {
      (eventsByTrace[e.trace_id] = eventsByTrace[e.trace_id] || []).push(e);
      if (e.event) allEventNames.add(e.event);
    });
  }

  // Pull webhook payloads for all those traces in one query
  let webhooksByTrace = {};
  if (traceIds.length > 0) {
    const r = await db.query(
      `SELECT trace_id, event_id, received_at, hmac_status, dedup_status, event_type,
              raw_payload, normalized_payload, error_detail
       FROM webhook_log
       WHERE trace_id = ANY($1::text[])
       ORDER BY received_at ASC`,
      [traceIds]
    );
    r.rows.forEach(w => {
      (webhooksByTrace[w.trace_id] = webhooksByTrace[w.trace_id] || []).push(w);
    });
  }

  const out = [];
  out.push(renderHeader('member', memberId, sourcePlatform, hardwarePlatform));
  out.push(extractInstructionBody(INSTRUCTION_BLOCK)
    .replace(/\{source_platform\}/g, sourcePlatform || 'unknown')
    .replace(/\{hardware_platform\}/g, hardwarePlatform || 'unknown')
    .replace(/\{source_layer_files\}/g, summarizeLayers(sourcePlatform, 'source'))
    .replace(/\{hardware_layer_files\}/g, summarizeLayers(hardwarePlatform, 'hardware'))
    .replace(/\{bundle_type\}/g, 'member')
    .replace(/\{generated_at_iso\}/g, new Date().toISOString())
    .replace(/\{template_version\}/g, templateVersion()));

  out.push('\n\n=== Member (master) ===\n' + JSON.stringify(snapshot.master, null, 2));
  out.push('\n\n=== Member access ===\n'    + JSON.stringify(snapshot.access, null, 2));
  out.push('\n\n=== Member access sources ===\n' + JSON.stringify(snapshot.sources, null, 2));

  out.push(`\n\n=== Member's last ${traceIds.length} trace(s), oldest first ===`);
  if (traceIds.length === 0) {
    out.push('\n(no traces found for this member)');
  } else {
    // We pulled trace_ids ordered DESC by first_ts, so reverse for chronological display
    const tracesChronological = traceIds.slice().reverse();
    tracesChronological.forEach((tid, traceIdx) => {
      const evs = eventsByTrace[tid] || [];
      out.push(`\n--- Trace ${traceIdx + 1}/${tracesChronological.length}: ${tid} ---`);
      evs.forEach((e, i) => {
        const dt = i === 0 ? 0 : Math.round(new Date(e.ts).getTime() - new Date(evs[0].ts).getTime());
        out.push(`  [${i + 1}/${evs.length}] +${dt}ms  ${e.ts.toISOString()}`);
        out.push(`    source: ${e.source}  event: ${e.event}  result: ${e.result || ''}`);
        if (e.detail !== null && e.detail !== undefined) {
          out.push('    detail:');
          JSON.stringify(e.detail, null, 2).split('\n').forEach(ln => out.push('      ' + ln));
        }
      });
      const wh = webhooksByTrace[tid] || [];
      if (wh.length > 0) {
        wh.forEach((w, i) => {
          out.push(`  [Webhook ${i + 1}] ${w.received_at.toISOString()}  event_type=${w.event_type}  hmac=${w.hmac_status}`);
          out.push('    raw_payload:');
          JSON.stringify(w.raw_payload, null, 2).split('\n').forEach(ln => out.push('      ' + ln));
          out.push('    normalized_payload:');
          JSON.stringify(w.normalized_payload, null, 2).split('\n').forEach(ln => out.push('      ' + ln));
        });
      }
    });
  }

  out.push('\n\n=== EVENT_REGISTRY (filtered to events across this member\'s traces) ===');
  out.push(filterEventRegistry(allEventNames));

  out.push('\n\n=== DR ledger ===');
  out.push(fullDrLedger());

  out.push('\n\n=== Layer-to-file map ===');
  out.push(filterLayerMap(sourcePlatform, hardwarePlatform));

  out.push('\n\n=== Recent context ===');
  out.push('\n--- Last 10 commits ---');
  out.push(recentCommits(10));
  out.push('\n--- Last 5 closed OBs ---');
  out.push(recentClosedObs(5));
  out.push('\n--- Last vault changelog entry ---');
  out.push(recentChangelogEntry());

  out.push('\n\n=== End bundle ===');

  const body = out.join('\n');
  return {
    type:      'member',
    member_id: memberId,
    text:      body,
    chars:     body.length,
    trace_count: traceIds.length,
    template_version: templateVersion(),
    generated_at: new Date().toISOString(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function renderHeader(bundleType, id, sourcePlatform, hardwarePlatform) {
  return [
    '=== AccessSync ' + (bundleType === 'trace' ? 'Trace' : 'Member') + ' Bundle ===',
    `bundle_type:        ${bundleType}`,
    `${bundleType}_id:           ${id}`,
    `source_platform:    ${sourcePlatform || 'unknown'}`,
    `hardware_platform:  ${hardwarePlatform || 'unknown'}`,
    `generated_at:       ${new Date().toISOString()}`,
    `template_version:   ${templateVersion()}`,
    '',
    'Bundle gap log destination: ' + VAULT_GAP_LOG_PATH_HINT,
    '',
  ].join('\n');
}

function summarizeLayers(platform, kind) {
  // Returns a comma-separated short list of file paths for that platform's layers.
  // Used to fill {source_layer_files} / {hardware_layer_files} in the prompt.
  if (!platform || !LAYER_MAP_RAW) return 'unknown';
  const heading = kind === 'source' ? '## Source platform layers' : '## Hardware platform layers';
  const sub = matchSubsection(LAYER_MAP_RAW, heading, `### ${platform.toLowerCase()}`);
  if (!sub) return `${platform} (no files documented)`;
  const files = [];
  sub.split('\n').forEach(ln => {
    const m = ln.match(/(?:adapters|core|admin)\/[\w./-]+\.\w+/);
    if (m) files.push(m[0]);
  });
  return files.length > 0 ? files.join(', ') : `${platform} (no files documented)`;
}

module.exports = {
  buildTraceBundle,
  buildMemberBundle,
  // exposed for testing
  _internals: { templateVersion, filterLayerMap, filterEventRegistry, summarizeLayers, matchTopSection, matchSubsection },
};
