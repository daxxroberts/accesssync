/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — ONBOARDING / OPERATOR SURFACE                              │
 * │  core/operator-email-templates.js — pure render layer                    │
 * │                                                                          │
 * │  Builder complaint 2026-07-25: the operator alert emails were "not in    │
 * │  any way branded", "very coded and very code-driven", and gave no clear  │
 * │  action items. The live nightly digest that prompted it rendered:        │
 * │      Failed Jobs (in error_queue): 1                                     │
 * │        - [null] member: null | QUEUE_JOB_MISSING_TRACE_ID                │
 * │                                                                          │
 * │  What CANNOT regress:                                                    │
 * │    1. No raw `null`, column names, or ISO timestamps reach the body      │
 * │    2. Every alert_type and event_type resolves to a real sentence,       │
 * │       including unknown/null values                                      │
 * │    3. Hostile location/plan names are HTML-escaped (Wix/Kisi-sourced)    │
 * │    4. Every email carries a real Admin Hub link, not prose navigation    │
 * │    5. A plain-text alternative always exists (deliverability)            │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const T = require('../../core/operator-email-templates');

const ALL_ALERT_TYPES = [
  'lockdown_detected', 'group_not_found', 'missing_group',
  'api_key_invalid_after_rotation', 'wix_api_unavailable', 'wix_snapshot_anomaly',
  'kisi_api_unavailable', 'hardware_api_unavailable',
  'untraceable_hardware_access', 'member_deleted_review',
  'notification_delivery_failed', 'system', 'unknown',
];

/** The whole point of the redesign — nothing machine-shaped in operator-facing copy. */
function assertHumanReadable(rendered) {
  for (const part of [rendered.subject, rendered.text]) {
    expect(part).not.toMatch(/\bnull\b/);
    expect(part).not.toMatch(/undefined/);
    expect(part).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamp
    expect(part).not.toMatch(/error_queue|config_alert_log|client_id|member_id|hardware_ref/);
  }
}

describe('[P2] operator-email-templates — shared contract', () => {
  const renders = {
    hardwareKey: () => T.renderHardwareKeyAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      platform: 'Kisi', diagnosis: 'Your key was rejected.', errorType: 'invalid_key',
    }),
    orphanedGroups: () => T.renderOrphanedGroupsAlert({
      locationName: 'Main Gym', clientName: 'House of Gains', platform: 'Kisi',
      groups: [{ planName: 'Family', affectedMembers: 3 }],
    }),
    archivedPlans: () => T.renderArchivedPlansAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      plans: [{ planName: 'Student', affectedMembers: 1 }],
    }),
    hmac: () => T.renderHmacAlert(),
    memberFailure: () => T.renderMemberFailureAlert({
      userMessage: 'Drew didn’t get their door access.', actionText: 'Retry it.',
      memberName: 'Drew', planName: 'Family',
    }),
    digest: () => T.renderNightlyDigest({
      configAlerts: [{ alert_type: 'group_not_found', locationName: 'Main Gym', doorName: 'Front Door' }],
      failedJobs: [{ event_type: 'plan.purchased', memberName: 'Drew', plan_name: 'Family' }],
    }),
  };

  test.each(Object.keys(renders))('%s returns subject + html + text', (name) => {
    const r = renders[name]();
    expect(typeof r.subject).toBe('string');
    expect(r.subject.length).toBeGreaterThan(0);
    expect(r.html).toContain('<!DOCTYPE html>');
    expect(typeof r.text).toBe('string');
    expect(r.text.length).toBeGreaterThan(0);
  });

  test.each(Object.keys(renders))('%s is AccessSync-branded', (name) => {
    const r = renders[name]();
    expect(r.html).toContain('#4F6EF7');       // DR-014 indigo, AccessSync's own brand
    expect(r.html).toContain('>AccessSync<');
  });

  test.each(Object.keys(renders))('%s states an action verdict', (name) => {
    const r = renders[name]();
    expect(r.text).toMatch(/^(ACTION NEEDED|NO ACTION NEEDED)/);
  });

  test.each(Object.keys(renders))('%s links to a real Admin Hub page', (name) => {
    const r = renders[name]();
    // digest is cross-tenant (spans every client with an open issue) and links to
    // /admin-errors, the owner's cross-tenant view — every other alert is scoped to
    // one client and links to /locations, /plan-mapping, or /errors with ?clientId=.
    expect(r.text).toMatch(/https:\/\/accesssync-admin\.up\.railway\.app\/(locations|plan-mapping|errors|admin-errors)/);
    // The prose-navigation pattern this replaced
    expect(r.text).not.toMatch(/log in to.*dashboard.*→/i);
  });

  test.each(Object.keys(renders))('%s contains no machine-shaped values', (name) => {
    assertHumanReadable(renders[name]());
  });
});

/**
 * Builder complaint 2026-09-07: clicking "View your plans" in an archived-plans
 * alert landed on the owner hub instead of the client's plan-mapping page. Root
 * cause — the CTA link never carried clientId, and every operator page under
 * /admin reads it client-side via URLSearchParams; with none in the URL an owner
 * session (unlike a scoped operator session) has no client context to render
 * against. Fixed by threading clientId through to hubLink(). This block pins that
 * fix so a future edit can't silently drop the query param again.
 */
describe('[P2] operator-email-templates — clientId deep links (2026-09-07 fix)', () => {
  const CLIENT_ID = '15962eac-c767-46ad-8056-094f35a4a193';

  test('renderHardwareKeyAlert carries clientId to /locations', () => {
    const r = T.renderHardwareKeyAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      platform: 'Kisi', diagnosis: 'Your key was rejected.', errorType: 'invalid_key',
      clientId: CLIENT_ID,
    });
    expect(r.text).toContain('/locations?clientId=' + CLIENT_ID);
  });

  test('renderOrphanedGroupsAlert carries clientId to /plan-mapping', () => {
    const r = T.renderOrphanedGroupsAlert({
      locationName: 'Main Gym', clientName: 'House of Gains', platform: 'Kisi',
      groups: [{ planName: 'Family', affectedMembers: 3 }],
      clientId: CLIENT_ID,
    });
    expect(r.text).toContain('/plan-mapping?clientId=' + CLIENT_ID);
  });

  test('renderArchivedPlansAlert carries clientId to /plan-mapping — the exact bug reported', () => {
    const r = T.renderArchivedPlansAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      plans: [{ planName: 'Student', affectedMembers: 1 }],
      clientId: CLIENT_ID,
    });
    expect(r.text).toContain('/plan-mapping?clientId=' + CLIENT_ID);
  });

  test('renderMemberFailureAlert carries clientId to /errors', () => {
    const r = T.renderMemberFailureAlert({
      userMessage: 'Drew didn’t get their door access.', actionText: 'Retry it.',
      memberName: 'Drew', planName: 'Family',
      clientId: CLIENT_ID,
    });
    expect(r.text).toContain('/errors?clientId=' + CLIENT_ID);
  });

  test('renderHmacAlert carries clientId to /errors when a tenant was resolved', () => {
    const r = T.renderHmacAlert({ clientId: CLIENT_ID });
    expect(r.text).toContain('/errors?clientId=' + CLIENT_ID);
  });

  test('renderHmacAlert falls back to the bare /errors link when no tenant could be resolved', () => {
    // hmac-monitor.js passes clientId=null for failures that predate tenant resolution —
    // must not throw and must not emit "clientId=null" in the URL.
    const r = T.renderHmacAlert({ clientId: null });
    expect(r.text).toContain('/errors');
    expect(r.text).not.toContain('clientId=null');
  });

  test('renderNightlyDigest always links to /admin-errors — cross-tenant, no single clientId applies', () => {
    const r = T.renderNightlyDigest({
      configAlerts: [{ alert_type: 'group_not_found', locationName: 'Main Gym', doorName: 'Front Door' }],
      failedJobs: [],
    });
    expect(r.text).toContain('/admin-errors');
    expect(r.text).not.toContain('/admin-errors?clientId=');
  });

  test('omitting clientId falls back to the bare route rather than throwing', () => {
    expect(() => T.renderArchivedPlansAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      plans: [{ planName: 'Student', affectedMembers: 1 }],
    })).not.toThrow();
    const r = T.renderArchivedPlansAlert({
      locationName: 'Main Gym', clientName: 'House of Gains',
      plans: [{ planName: 'Student', affectedMembers: 1 }],
    });
    expect(r.text).toContain('/plan-mapping');
    expect(r.text).not.toContain('clientId=');
  });
});

describe('[P2] operator-email-templates — escaping', () => {
  test('hostile location and plan names are escaped', () => {
    const hostile = '<script>alert("x")</script>';
    const r = T.renderOrphanedGroupsAlert({
      locationName: hostile, clientName: hostile, platform: 'Kisi',
      groups: [{ planName: hostile, affectedMembers: 1 }],
    });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  test('escapeHtml handles null and undefined', () => {
    expect(T.escapeHtml(null)).toBe('');
    expect(T.escapeHtml(undefined)).toBe('');
  });
});

describe('[P2] describeConfigAlert', () => {
  test.each(ALL_ALERT_TYPES)('%s produces a real sentence', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType, locationName: 'Main Gym' });
    expect(s).toMatch(/[a-z]/);
    expect(s.trim()).toMatch(/\.$/);
    expect(s).not.toMatch(/\bnull\b|undefined/);
  });

  test('an uncataloged alert_type falls back loudly but readably', () => {
    const s = T.describeConfigAlert({ alert_type: 'brand_new_thing', locationName: 'Main Gym' });
    expect(s).toContain('brand_new_thing'); // gap stays visible rather than silently dropped
    expect(s).toContain('Main Gym');
  });

  test('a missing location does not render "null"', () => {
    const s = T.describeConfigAlert({ alert_type: 'group_not_found' });
    expect(s).not.toMatch(/\bnull\b|undefined/);
  });

  test('affected member count is pluralized, not "member(s)"', () => {
    expect(T.describeConfigAlert({ alert_type: 'group_not_found', affectedMembers: 1 })).toContain('1 member ');
    expect(T.describeConfigAlert({ alert_type: 'group_not_found', affectedMembers: 3 })).toContain('3 members');
  });
});

/**
 * Phase 1 "stop the bleeding" (2026-09-10): the reconciliation sweep and the
 * finalize-revoke guards now HOLD removals and alert instead of acting. Each
 * alert must tell a gym owner, in plain English, whether anyone lost access and
 * what to do. For these types config_alert_log.hardware_ref (which the digest
 * passes as doorName) carries machine detail — "proposed=12", Kisi user ids —
 * and must never reach the email.
 */
describe('[P2] describeConfigAlert — removal-safety alerts (Phase 1)', () => {
  const REMOVAL_SAFETY_ALERT_TYPES = [
    'revoke_batch_mass_revoke', 'wix_snapshot_anomaly', 'revoke_invalid_proposal',
    'finalize_refused_other_assignments', 'finalize_refused_shared_user',
    'sweep_repair_pending', 'sweep_removal_pending', 'revoke_holder_lapse_pending',
    'revoke_held_payment_state', 'kisi_api_unavailable', 'hardware_api_unavailable',
  ];
  // Raw detail a hardware_ref can hold for these types.
  const RAW_DETAIL = 'proposed=12 managed=20 kisi_user=98765';

  test.each(REMOVAL_SAFETY_ALERT_TYPES)('%s produces a real plain-English sentence', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType, locationName: 'House of Gains' });
    expect(s).toMatch(/[a-z]/);
    expect(s.trim()).toMatch(/\.$/);
    expect(s).not.toMatch(/\bnull\b|undefined/);
    expect(s).toContain('House of Gains');
    expect(s).not.toContain(alertType); // cataloged — not the generic "(raw_type)" fallback
  });

  test.each(REMOVAL_SAFETY_ALERT_TYPES)('%s never leaks the raw hardware_ref detail string', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType, locationName: 'House of Gains', doorName: RAW_DETAIL });
    expect(s).not.toContain('proposed=');
    expect(s).not.toContain('98765');
    expect(s).not.toMatch(/=/);
  });

  test.each(REMOVAL_SAFETY_ALERT_TYPES)('%s says whether anyone lost access', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType, locationName: 'House of Gains' });
    // Repair-pending is the one case where someone IS missing access — it says so.
    if (alertType === 'sweep_repair_pending') {
      expect(s).toMatch(/door access .* is missing in Kisi/);
    } else {
      expect(s).toMatch(/Nobody lost access|nothing was removed/);
    }
  });

  test.each(REMOVAL_SAFETY_ALERT_TYPES)('%s reads fine with no member name (the digest passes none today)', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType });
    expect(s).not.toMatch(/\bnull\b|undefined|  /);
    expect(s.trim()).toMatch(/\.$/);
  });

  test('revoke_batch_mass_revoke: stopped, removed no one, says what to check', () => {
    const s = T.describeConfigAlert({ alert_type: 'revoke_batch_mass_revoke', locationName: 'House of Gains', doorName: 'proposed=12' });
    expect(s).toMatch(/removed no one/);
    expect(s).toMatch(/Nobody lost access/);
    expect(s).toMatch(/Wix/);
  });

  test('wix_snapshot_anomaly now says nobody lost access (reworded)', () => {
    const s = T.describeConfigAlert({ alert_type: 'wix_snapshot_anomaly', locationName: 'House of Gains' });
    expect(s).toMatch(/Nobody lost access/);
    expect(s).toMatch(/paused removals/);
  });

  test('revoke_invalid_proposal: internal problem, nothing changed', () => {
    const s = T.describeConfigAlert({ alert_type: 'revoke_invalid_proposal', locationName: 'House of Gains' });
    expect(s).toMatch(/stopped before changing anything/);
    expect(s).toMatch(/Nobody lost access/);
  });

  test("finalize_refused_other_assignments: names the person, says the account wasn't deleted and nothing was removed", () => {
    const s = T.describeConfigAlert({
      alert_type: 'finalize_refused_other_assignments', locationName: 'House of Gains', memberName: 'Drew Roberts',
    });
    expect(s).toContain('AccessSync didn’t delete Drew Roberts’s Kisi account because they still have door access');
    expect(s).toContain('wasn’t added by AccessSync');
    expect(s).toContain('nothing was removed');
  });

  test('finalize_refused_shared_user: shared Kisi account, nothing removed', () => {
    const s = T.describeConfigAlert({
      alert_type: 'finalize_refused_shared_user', locationName: 'House of Gains', memberName: 'Drew Roberts',
    });
    expect(s).toContain('Drew Roberts’s Kisi account');
    expect(s).toMatch(/same Kisi account/);
    expect(s).toContain('nothing was removed');
  });

  test('sweep_repair_pending: paying member missing in Kisi; restored once repair is on; re-add meanwhile', () => {
    const s = T.describeConfigAlert({ alert_type: 'sweep_repair_pending', locationName: 'House of Gains' });
    expect(s).toMatch(/paying member/);
    expect(s).toMatch(/missing in Kisi/);
    expect(s).toMatch(/once automatic repair is switched on/);
    expect(s).toMatch(/re-add it in Kisi/);
  });

  test('sweep_removal_pending: no longer paying in Wix; removal paused; nothing removed', () => {
    const s = T.describeConfigAlert({ alert_type: 'sweep_removal_pending', locationName: 'House of Gains' });
    expect(s).toMatch(/no longer shows as paying in Wix/);
    expect(s).toMatch(/Automatic removal is paused while AccessSync’s safety checks roll out/);
    expect(s).toMatch(/nothing was removed/);
  });

  test('revoke_holder_lapse_pending: main member lapsed; removal paused; nothing removed', () => {
    const s = T.describeConfigAlert({ alert_type: 'revoke_holder_lapse_pending', locationName: 'House of Gains' });
    expect(s).toMatch(/main member no longer shows as paying in Wix/);
    expect(s).toMatch(/nothing was removed/);
  });

  test('revoke_held_payment_state: declined/pending/unrecognized payment; access left alone; nobody lost access', () => {
    const s = T.describeConfigAlert({ alert_type: 'revoke_held_payment_state', locationName: 'House of Gains' });
    expect(s).toContain('A member’s Wix payment at House of Gains is declined, pending or unrecognized');
    expect(s).toContain('AccessSync is leaving their door access alone');
    expect(s).toMatch(/Nobody lost access/);
    expect(s).toMatch(/remove their access in Kisi/);
    // Names the person when the caller has one.
    const named = T.describeConfigAlert({
      alert_type: 'revoke_held_payment_state', locationName: 'House of Gains', memberName: 'Drew Roberts',
    });
    expect(named).toContain('Drew Roberts’s Wix payment at House of Gains');
  });

  test('kisi_api_unavailable (F11): couldn’t reach Kisi, stopped, changed nothing, nobody lost access', () => {
    const s = T.describeConfigAlert({
      alert_type: 'kisi_api_unavailable', locationName: 'House of Gains', doorName: 'status=503 code=KISI_PAGE_INTEGRITY',
    });
    expect(s).toContain('AccessSync couldn’t reach Kisi for House of Gains during a sync — it stopped and changed nothing.');
    expect(s).toMatch(/Nobody lost access/);
    expect(s).not.toMatch(/status=|KISI_PAGE_INTEGRITY|503/);
  });

  test('hardware_api_unavailable (F11): names the platform when given, generic otherwise; nobody lost access', () => {
    const s = T.describeConfigAlert({
      alert_type: 'hardware_api_unavailable', locationName: 'House of Gains', platform: 'Seam', doorName: 'status=unknown code=ETIMEDOUT',
    });
    expect(s).toContain('AccessSync couldn’t reach Seam for House of Gains during a sync — it stopped and changed nothing.');
    expect(s).toMatch(/Nobody lost access/);
    expect(s).not.toMatch(/status=|ETIMEDOUT/);
    const generic = T.describeConfigAlert({ alert_type: 'hardware_api_unavailable', locationName: 'House of Gains' });
    expect(generic).toContain('couldn’t reach your access system for House of Gains');
  });

  test('a hostile member name is escaped when the digest renders it', () => {
    const r = T.renderNightlyDigest({
      configAlerts: [{ alert_type: 'finalize_refused_other_assignments', locationName: 'Main Gym', memberName: '<script>x</script>' }],
      failedJobs: [],
    });
    expect(r.html).not.toContain('<script>x</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  test('the nightly digest renders every removal-safety alert as readable prose with no raw detail', () => {
    const r = T.renderNightlyDigest({
      configAlerts: REMOVAL_SAFETY_ALERT_TYPES.map(alert_type => ({
        alert_type, locationName: 'House of Gains', doorName: RAW_DETAIL,
      })),
      failedJobs: [],
    });
    assertHumanReadable(r);
    for (const part of [r.text, r.html]) {
      expect(part).not.toContain('proposed=');
      for (const t of REMOVAL_SAFETY_ALERT_TYPES) expect(part).not.toContain(t);
    }
  });
});

/**
 * F13 (2026-09-10 fix round): the v2 removal gate's alert aliases were removed
 * from describeConfigAlert — no code writes them (core/reconciliation.js maps
 * every anomaly hold to revoke_invalid_proposal / wix_snapshot_anomaly /
 * revoke_batch_mass_revoke and raises no alert for mode or observation-only
 * holds), and none ever shipped. This pins that they are no longer cataloged,
 * and that a stray row still reads as a sentence rather than crashing.
 */
describe('[P2] describeConfigAlert — dead v2 alert aliases are not cataloged (F13)', () => {
  const DEAD_V2_ALIASES = [
    'revoke_batch_would_revoke_all', 'revoke_revalidation_failed',
    'revoke_mass_revoke', 'revoke_snapshot_unstable',
    'revoke_auto_revoke_off', 'revoke_auto_revoke_disabled',
    'revoke_dry_run', 'revoke_observation_only', 'revoke_strike_pending',
  ];

  test.each(DEAD_V2_ALIASES)('%s falls through to the generic sentence', (alertType) => {
    const s = T.describeConfigAlert({ alert_type: alertType, locationName: 'House of Gains' });
    expect(s).toBe('AccessSync logged an issue at House of Gains (' + alertType + ').');
  });

  test('no dead alias appears as a case label in the source', () => {
    const src = require('fs').readFileSync(require.resolve('../../core/operator-email-templates'), 'utf8');
    for (const t of DEAD_V2_ALIASES) expect(src).not.toContain("case '" + t + "'");
  });
});

describe('[P2] describeFailedJob', () => {
  test('prefers the user_message written at throw time', () => {
    const s = T.describeFailedJob({
      event_type: 'plan.purchased',
      user_message: 'Kisi rejected the request.',
      action_text: 'Check your key.',
    });
    expect(s).toBe('Kisi rejected the request. Check your key.');
  });

  test('falls back to the event_type map when user_message is null', () => {
    const s = T.describeFailedJob({ event_type: 'plan.purchased', memberName: 'Drew', plan_name: 'Family' });
    expect(s).toContain('Drew');
    expect(s).toContain('Family');
  });

  test('THE SCREENSHOT CASE: null event_type + null member never renders "[null] member: null"', () => {
    const s = T.describeFailedJob({
      event_type: null, member_id: null, user_message: null, action_text: null,
    });
    expect(s).not.toMatch(/\bnull\b/);
    expect(s).toBe('A background job didn’t finish. No member lost access because of it.');
  });

  test('an unknown event_type still produces a sentence', () => {
    const s = T.describeFailedJob({ event_type: 'some.future.event' });
    expect(s).not.toMatch(/\bnull\b|undefined/);
    expect(s.trim()).toMatch(/\.$/);
  });
});

describe('[P2] renderNightlyDigest', () => {
  test('summarizes the count in plain English, singular and plural', () => {
    const one = T.renderNightlyDigest({ configAlerts: [{ alert_type: 'system' }], failedJobs: [] });
    expect(one.subject).toBe('[AccessSync] 1 thing needs a look');

    const many = T.renderNightlyDigest({
      configAlerts: [{ alert_type: 'system' }],
      failedJobs: [{ event_type: null }, { event_type: null }],
    });
    expect(many.subject).toBe('[AccessSync] 3 things need a look');
  });

  test('renders the exact live digest that prompted the redesign as readable prose', () => {
    const r = T.renderNightlyDigest({
      configAlerts: [],
      failedJobs: [{ event_type: null, user_message: null, action_text: null }],
    });
    expect(r.text).not.toContain('[null]');
    expect(r.text).not.toContain('QUEUE_JOB_MISSING_TRACE_ID');
    expect(r.text).toContain('A background job didn’t finish');
  });

  test('tells the operator how to stop an item from recurring', () => {
    const r = T.renderNightlyDigest({ configAlerts: [{ alert_type: 'system' }], failedJobs: [] });
    expect(r.text).toMatch(/dismiss/i);
  });

  test('tolerates missing arrays', () => {
    expect(() => T.renderNightlyDigest({})).not.toThrow();
  });
});

describe('[P2] renderHmacAlert — audience split', () => {
  test('carries no security jargon the operator cannot act on', () => {
    const r = T.renderHmacAlert();
    for (const jargon of ['HMAC', 'Secrets Manager', 'Railway', 'signature', 'replay', 'IP']) {
      expect(r.subject).not.toContain(jargon);
      expect(r.text).not.toContain(jargon);
    }
  });

  test('says no action is needed and names the escalation path', () => {
    const r = T.renderHmacAlert();
    expect(r.text).toMatch(/^NO ACTION NEEDED/);
    expect(r.text).toMatch(/reply to it/i);
  });
});

describe('[P2] adminHubUrl', () => {
  afterEach(() => { delete process.env.ADMIN_HUB_URL; });

  test('defaults to the live Admin Hub when unset', () => {
    expect(T.adminHubUrl()).toBe('https://accesssync-admin.up.railway.app');
  });

  test('honors ADMIN_HUB_URL and strips a trailing slash', () => {
    process.env.ADMIN_HUB_URL = 'https://staging.example.com/';
    expect(T.adminHubUrl()).toBe('https://staging.example.com');
  });

  test('ignores a non-URL value rather than emitting a broken link', () => {
    process.env.ADMIN_HUB_URL = 'not-a-url';
    expect(T.adminHubUrl()).toBe('https://accesssync-admin.up.railway.app');
  });
});
