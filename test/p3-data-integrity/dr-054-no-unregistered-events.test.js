/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  DR-054 — every info-level event emitted in production is registered    │
 * │                                                                         │
 * │  The gap this closes: core/logger.js persists warn+ by default and      │
 * │  DROPS info unless EVENT_REGISTRY.json says otherwise. An absent entry  │
 * │  is therefore indistinguishable from "we decided this is noise" — so a  │
 * │  load-bearing info event can be added and silently never reach          │
 * │  diagnostic_log, making it invisible in the Trace Timeline.             │
 * │                                                                         │
 * │  That is not hypothetical. DR-050 shipped revoke.billing_cancelled      │
 * │  (the event recording that a member's billing flipped to cancelled)     │
 * │  and it never persisted. Nobody noticed until an audit 2026-08-04.      │
 * │  DR-052's email.member.* events had the same fault a month earlier.     │
 * │                                                                         │
 * │  This test fails when a NEW info-level event name appears in production │
 * │  code without a matching EVENT_REGISTRY.json entry. Registering it      │
 * │  persist:false is a perfectly good answer — the point is that somebody  │
 * │  decided, and the decision is written down.                             │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_JSON_PATH = path.join(ROOT, 'core', 'EVENT_REGISTRY.json');

// Directories holding production code that emits log events.
const SCAN_DIRS = ['core', 'adapters', 'admin'];

// Matches log.info('event.name' / logger.info("event.name") / sweepLogger.info(`...`)
// across every logger binding used in the codebase. Only `.info(` is scanned:
// warn/error/critical persist by default, so an absent entry is harmless there.
const EMIT_RE = /(?:log|logger|sweepLogger|_log)\s*\.\s*info\s*\(\s*['"`]([a-z][a-zA-Z0-9_.]*)['"`]/g;

function walk(dir, out) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    if (name.name === 'node_modules' || name.name.startsWith('.')) continue;
    const full = path.join(dir, name.name);
    if (name.isDirectory()) walk(full, out);
    else if (name.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Blank out comments so documentation examples don't register as real emit
 * sites. core/logger.js's own header shows `log.info('grant.complete', …)` as
 * usage; without this the scanner reports it as an unregistered event.
 *
 * Newlines are preserved (comments are replaced space-for-space) so the
 * line numbers reported in failures still point at the real source line.
 * Only whole-line `//` comments are stripped — a trailing `//` is left alone
 * so URLs inside string literals survive untouched.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
  return noBlocks
    .split('\n')
    .map(line => (/^\s*(\/\/|\*)/.test(line) ? '' : line))
    .join('\n');
}

function collectEmittedInfoEvents() {
  const files = SCAN_DIRS
    .map(d => path.join(ROOT, d))
    .filter(d => fs.existsSync(d))
    .reduce((acc, d) => walk(d, acc), []);

  const found = new Map(); // eventName → first "relative/path.js:line"
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    let m;
    EMIT_RE.lastIndex = 0;
    while ((m = EMIT_RE.exec(src)) !== null) {
      const eventName = m[1];
      if (found.has(eventName)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      found.set(eventName, `${path.relative(ROOT, file).replace(/\\/g, '/')}:${line}`);
    }
  }
  return found;
}

/**
 * TRIAGE BACKLOG — untriaged as of DR-054 (2026-08-04).
 *
 * DR-054 audited and ruled on the 28 events that surfaced at runtime during a
 * test:deploy run. This static scan then found 103. The difference is not a
 * contradiction: the [logger] warning only fires for code paths a test actually
 * executes, so it under-reports. The scan is exhaustive.
 *
 * These are NOT approved as suppressed. They are "known, not yet ruled on" —
 * which is a materially different state from an absent registry entry, because
 * the list is named, dated, and enforced: nothing may be ADDED to it. A new
 * info event fails the test below and must be ruled on when it is written.
 *
 * Retiring this list is its own scoped pass: classify each event persist:true
 * (with humanize.js copy in both name forms) or persist:false, add an
 * EVENT_REGISTRY.md row, and delete it from here. The list should only shrink.
 */
const TRIAGE_BACKLOG = new Set([
  'adapter.complete_grant.seat_suppressed_holder_released', 'adapter.finalize_revoke.access_still_active',
  'adapter.finalize_revoke.already_deleted', 'adapter.finalize_revoke.delete_kisi_user_start',
  'adapter.finalize_revoke.no_hardware_user', 'adapter.first_grant_email_sent',
  'adapter.first_grant_no_email', 'adapter.identity.create_409_recovered',
  'adapter.identity_cache_hit', 'adapter.park_pending_hardware.no_mappings',
  'admin.started', 'auth.oauth_callback_attempt', 'auth.oauth_callback_success',
  'auth.pin_login_success', 'health.alert_sent', 'health.archived_plan_alert_sent',
  'health.check_complete', 'health.check_start', 'health.group_names_synced',
  'health.group_recovered', 'health.groups_orphaned', 'health.groups_recovered',
  'health.groups_skipped', 'health.key_valid', 'health.orphan_alert_sent',
  'health.wix_plan_archived', 'health.wix_plan_recovered', 'health.wix_plans_archived',
  'hmac.alert.sent', 'kisi.list_users.fetched', 'kisi.managed_assignments.fetched',
  'kisi.role.already_exists', 'kisi.role.assigned', 'kisi.role.assigning',
  'kisi.role.remove_skipped_already_gone', 'kisi.role.removed', 'kisi.role.removing',
  'kisi.user.enabled', 'kisi.user.enabling', 'kisi.user.suspended', 'kisi.user.suspending',
  'location.already_cancelled', 'location.lapse_complete', 'location.no_active_members',
  'operator.email_branding.logo_uploaded', 'operator.email_branding.test_sent',
  'operator.email_branding.updated', 'queue.grant.parked.pending_start',
  'queue.grant.recovered.complete', 'queue.grant.started.complete',
  'queue.grant.started.parked.no_api_key', 'queue.job.completed',
  'queue.job.stalled.lock_released', 'queue.job.stalled.no_lock', 'queue.revoke.complete',
  'queue.revoke.finalize.result', 'queue.revoke.hardware_calls_complete',
  'queue.revoke.lock_acquired', 'queue.worker.started', 'reconcileMember.grant_queued',
  'reconcileMember.integrity_blocked', 'reconcileMember.ok', 'reconcileMember.repair_queued',
  'reconcileMember.revoke_queued', 'reconcileMember.untraceable',
  'reconciliation.actionable_records', 'reconciliation.client_sync_complete',
  'reconciliation.digest', 'reconciliation.digest_empty', 'reconciliation.digest_sent',
  'reconciliation.grant_queued', 'reconciliation.holder_seat_released_enforced',
  'reconciliation.kisi_user_disappeared_first_sighting', 'reconciliation.kisi_user_recovered',
  'reconciliation.pass_1_2_complete', 'reconciliation.pass_1_5_complete',
  'reconciliation.pass_3_complete', 'reconciliation.pass_3_skipped_unsupported_platform',
  'reconciliation.revoke_queued', 'reconciliation.role_assignment_backfilled',
  'reconciliation.sanity_gate_resolved_proceed', 'reconciliation.skipped',
  'reconciliation.source_inserted_from_wix', 'reconciliation.source_promoted_from_cancelled',
  'reconciliation.sweep_complete', 'reconciliation.wix_sync_complete',
  'reconciliation.wix_sync_start', 'retry.notify.sent', 'revoke.skipped.never_provisioned',
  'source_retry.candidate_found', 'source_retry.run_complete', 'source_retry.run_start',
  'tenant.auto_wired', 'tenant.source_site_id_registered', 'webhook.duplicate',
  'webhook.enqueued', 'webhook.received', 'webhook.unrecognised_type',
  'wix.active_orders.fetched', 'wix.booking_services.fetched',
  'wix.confirmed_bookings.fetched', 'wix.pricing_plans.fetched',
  'wix_app_market.stub.received',
]);

describe('[P3] DR-054 — no unregistered info-level events in production code', () => {
  test('every info event emitted in core/, adapters/, admin/ has an EVENT_REGISTRY.json entry', () => {
    const registry  = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, 'utf8'));
    const overrides = registry.overrides || {};
    const emitted   = collectEmittedInfoEvents();

    // Sanity: the scanner actually found emit sites. If this trips, the regex
    // or the directory list drifted and the test is silently passing on nothing.
    expect(emitted.size).toBeGreaterThan(20);

    const unregistered = [...emitted.entries()]
      .filter(([name]) => !(name in overrides))
      .filter(([name]) => !TRIAGE_BACKLOG.has(name));

    if (unregistered.length > 0) {
      throw new Error([
        'Info-level events emitted in production with no EVENT_REGISTRY.json entry:',
        ...unregistered.map(([name, loc]) => `  - ${name}   (${loc})`),
        '',
        'Info events are DROPPED unless registered, so these never reach diagnostic_log',
        'and are invisible in the Trace Timeline.',
        '',
        'Fix: add each to core/EVENT_REGISTRY.json —',
        '  { "persist": true }   if it explains why a member did or did not get access',
        '                        (then also add plain-English copy to admin/public/humanize.js,',
        '                         BOTH the dotted and UPPERCASE_UNDERSCORE forms)',
        '  { "persist": false }  if it is a per-job progress breadcrumb',
        '',
        'Also add a row to core/EVENT_REGISTRY.md (DR-038 two-canon rule).',
      ].join('\n'));
    }
  });

  test('the triage backlog only shrinks — no stale entries, no dead names', () => {
    const registry  = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, 'utf8'));
    const overrides = registry.overrides || {};
    const emitted   = collectEmittedInfoEvents();

    // Once an event is ruled on, it must leave the backlog — otherwise the list
    // rots into a permanent excuse and stops meaning "untriaged".
    const ruledButStillListed = [...TRIAGE_BACKLOG].filter(n => n in overrides);
    expect(ruledButStillListed).toEqual([]);

    // An event that no longer exists in the codebase must also leave the list,
    // so the backlog reflects real outstanding work rather than history.
    const deadNames = [...TRIAGE_BACKLOG].filter(n => !emitted.has(n));
    expect(deadNames).toEqual([]);
  });

  test('the 12 DR-054 promoted events are still set to persist', () => {
    const registry = JSON.parse(fs.readFileSync(REGISTRY_JSON_PATH, 'utf8'));
    // These answer "why did or didn't this member get through the door".
    // If a refactor flips one to false, operator diagnosis silently degrades.
    const mustPersist = [
      'queue.grant.parked.no_mapping',
      'queue.grant.parked.no_api_key',
      'adapter.identity.parked',
      'adapter.identity.gate2_recovered',
      'revoke.billing_cancelled',
      'revoke.billing_status_preserved',
      'revoke.group.skipped',
      'grant.role.source_exists',
      'grant.role.reused',
      'kisi.user.created',
      'kisi.user.deleted',
      'kisi.user.delete_skipped_already_gone',
    ];
    for (const name of mustPersist) {
      expect(registry.overrides[name]).toBeDefined();
      expect(registry.overrides[name].persist).toBe(true);
    }
  });

  test('every promoted event has plain-English copy in humanize.js, in both name forms', () => {
    // Persisting without copy reproduces the exact bug the Builder caught on
    // 2026-08-04: EMAIL_MEMBER_SKIPPED_DISABLED rendered as
    // "(plain English not yet defined)" in a real trace. diagnostic_log
    // surfaces event names as UPPERCASE_UNDERSCORE, so both forms must match.
    const humanize = fs.readFileSync(path.join(ROOT, 'admin', 'public', 'humanize.js'), 'utf8');
    const promoted = [
      'queue.grant.parked.no_mapping',
      'queue.grant.parked.no_api_key',
      'adapter.identity.parked',
      'adapter.identity.gate2_recovered',
      'revoke.billing_cancelled',
      'revoke.billing_status_preserved',
      'revoke.group.skipped',
      'grant.role.source_exists',
      'grant.role.reused',
      'kisi.user.created',
      'kisi.user.deleted',
      'kisi.user.delete_skipped_already_gone',
    ];
    const missing = [];
    for (const name of promoted) {
      const upper = name.replace(/\./g, '_').toUpperCase();
      if (!humanize.includes(`'${name}'`)) missing.push(`${name} (dotted form)`);
      if (!humanize.includes(`'${upper}'`)) missing.push(`${upper} (uppercase form)`);
    }
    expect(missing).toEqual([]);
  });

  test('grant./revoke. promoted events sit ABOVE the generic prefix fallbacks', () => {
    // humanize.js has catch-alls: `if (e.indexOf('grant.') === 0) return 'Grant step: …'`
    // Any specific grant.*/revoke.* entry placed below them is dead code — the
    // fallback wins and the timeline shows "Grant step: role reused." instead.
    const humanize = fs.readFileSync(path.join(ROOT, 'admin', 'public', 'humanize.js'), 'utf8');
    const grantFallbackIdx  = humanize.indexOf("e.indexOf('grant.') === 0");
    const revokeFallbackIdx = humanize.indexOf("e.indexOf('revoke.') === 0");
    expect(grantFallbackIdx).toBeGreaterThan(-1);
    expect(revokeFallbackIdx).toBeGreaterThan(-1);

    for (const name of ['grant.role.source_exists', 'grant.role.reused']) {
      expect(humanize.indexOf(`'${name}'`)).toBeLessThan(grantFallbackIdx);
    }
    for (const name of ['revoke.billing_cancelled', 'revoke.billing_status_preserved', 'revoke.group.skipped']) {
      expect(humanize.indexOf(`'${name}'`)).toBeLessThan(revokeFallbackIdx);
    }
  });
});
