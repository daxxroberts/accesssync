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
    expect(r.text).toMatch(/https:\/\/accesssync-admin\.up\.railway\.app\/(locations|plan-mapping|errors)/);
    // The prose-navigation pattern this replaced
    expect(r.text).not.toMatch(/log in to.*dashboard.*→/i);
  });

  test.each(Object.keys(renders))('%s contains no machine-shaped values', (name) => {
    assertHumanReadable(renders[name]());
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
