/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 1 — CRITICAL PATH                                              │
 * │  DR-052 — member email pipeline safety (core/member-mailer.js +          │
 * │  queue-worker seams)                                                     │
 * │                                                                         │
 * │  What CANNOT regress:                                                    │
 * │    1. Ship-dark gate — no member email when member_emails_enabled=false  │
 * │    2. Allow-list suppression — reconcile drift / self-heals / holder     │
 * │       self-release / member.deleted NEVER email members                  │
 * │    3. Atomic dedup — ON CONFLICT DO NOTHING = once-only sends            │
 * │    4. Never-throws contract — a mailer failure must not fail grant/      │
 * │       revoke jobs                                                        │
 * │    5. PII-purge ordering — the access-removed recipient is captured      │
 * │       between completeRevoke and finalizeRevoke (DR-044 NULLs the        │
 * │       address in the same awaited job)                                   │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

jest.mock('../../db', () => ({ query: jest.fn() }));
jest.mock('../../core/logger', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../core/trace-context', () => ({
  getTraceId: jest.fn(() => 'trace-dr052'),
}));

const mockResendSend = jest.fn();
jest.mock('resend', () => ({
  Resend: jest.fn(() => ({ emails: { send: mockResendSend } })),
}));

const db = require('../../db');
const mailer = require('../../core/member-mailer');

const CLIENT = 'client-052';
const ACCESS = 'access-052';

const ENABLED_CLIENT_ROW = {
  name: 'House of Gains', notification_email: 'chad@hog.com',
  member_emails_enabled: true,
  email_logo_url: 'https://x/logo.png', email_primary_color: '#112233', email_secondary_color: '#445566',
};

/** SQL-dispatch mock — robust to call ordering. */
function mockDb({ clientRow = ENABLED_CLIENT_ROW, dedupHit = false, memberRow, planRows, holderRow } = {}) {
  db.query.mockImplementation((sql) => {
    if (/FROM clients WHERE id/.test(sql))                     return Promise.resolve({ rows: clientRow ? [clientRow] : [] });
    if (/INSERT INTO member_email_log/.test(sql))              return Promise.resolve({ rows: dedupHit ? [] : [{ id: 'log-1' }] });
    if (/UPDATE member_email_log/.test(sql))                   return Promise.resolve({ rows: [] });
    if (/FROM member_access ma JOIN member_master mm/.test(sql)) return Promise.resolve({ rows: memberRow ? [memberRow] : [] });
    if (/FROM plan_mappings WHERE id = ANY/.test(sql))         return Promise.resolve({ rows: planRows || [] });
    if (/FROM plan_mappings WHERE source_plan_id/.test(sql))   return Promise.resolve({ rows: planRows || [] });
    if (/SELECT first_name, last_name, display_name FROM member_master/.test(sql)) return Promise.resolve({ rows: holderRow ? [holderRow] : [] });
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResendSend.mockResolvedValue({ data: { id: 'resend-abc' }, error: null });
  process.env.RESEND_API_KEY = 'test-key';
  process.env.RESEND_MEMBER_FROM_EMAIL = 'members@accesssync.io';
});

// ════════════════════════════════════════════════════════════════════════════
// sendMemberEmail — gate, dedup, FROM shape, never-throws
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 sendMemberEmail', () => {
  const templates = require('../../core/email-templates');
  const baseArgs = {
    clientId: CLIENT, memberMasterId: 'mm-1', emailType: 'access_ready',
    dedupKey: 'k1', recipient: 'member@x.com',
    render: templates.renderAccessReady,
    renderArgs: { member: { firstName: 'Jane' }, plans: [{ planName: 'Monthly', doorName: 'Front' }] },
  };

  test('ship-dark gate: member_emails_enabled=false → no dedup INSERT, no send', async () => {
    mockDb({ clientRow: Object.assign({}, ENABLED_CLIENT_ROW, { member_emails_enabled: false }) });
    const r = await mailer.sendMemberEmail(baseArgs);
    expect(r).toEqual({ sent: false, reason: 'disabled' });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(db.query.mock.calls.some(c => /INSERT INTO member_email_log/.test(c[0]))).toBe(false);
  });

  test('bypassEnabledGate=true sends even when the toggle is off (operator test-send)', async () => {
    mockDb({ clientRow: Object.assign({}, ENABLED_CLIENT_ROW, { member_emails_enabled: false }) });
    const r = await mailer.sendMemberEmail(Object.assign({}, baseArgs, { bypassEnabledGate: true }));
    expect(r.sent).toBe(true);
    expect(mockResendSend).toHaveBeenCalledTimes(1);
  });

  test('atomic dedup: ON CONFLICT no-row → suppressed, no send', async () => {
    mockDb({ dedupHit: true });
    const r = await mailer.sendMemberEmail(baseArgs);
    expect(r).toEqual({ sent: false, reason: 'duplicate' });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  test('FROM is gym display-name branding; Reply-To is the admin contact', async () => {
    mockDb({});
    await mailer.sendMemberEmail(baseArgs);
    const payload = mockResendSend.mock.calls[0][0];
    expect(payload.from).toBe('House of Gains <members@accesssync.io>');
    expect(payload.reply_to).toBe('chad@hog.com');
    expect(payload.to).toBe('member@x.com');
    expect(payload.html).toContain('Powered by AccessSync');
    expect(typeof payload.text).toBe('string');
  });

  // 2026-07-09: confirmed live against Resend that accesssync.io is NOT a verified
  // sending domain (403 "domain is not verified") — RESEND_FROM_EMAIL was never even
  // set as an env var, so every send fell back to a bare-quoted 'alerts@accesssync.io'
  // and was silently rejected. With neither env var set, the fallback must be Resend's
  // own onboarding sender — needs no domain verification — not the unverified domain.
  test('with no FROM env vars set, falls back to onboarding@resend.dev (not the unverified accesssync.io domain)', async () => {
    delete process.env.RESEND_MEMBER_FROM_EMAIL;
    delete process.env.RESEND_FROM_EMAIL;
    mockDb({});
    await mailer.sendMemberEmail(baseArgs);
    const payload = mockResendSend.mock.calls[0][0];
    expect(payload.from).toBe('House of Gains <onboarding@resend.dev>');
    expect(payload.from).not.toContain('accesssync.io');
  });

  test('Resend result.error → sent:false + delivery_status flipped, never throws', async () => {
    mockDb({});
    mockResendSend.mockResolvedValueOnce({ data: null, error: { message: 'quota' } });
    const r = await mailer.sendMemberEmail(baseArgs);
    expect(r).toEqual({ sent: false, reason: 'resend_error' });
    expect(db.query.mock.calls.some(c => /delivery_status = 'failed'/.test(c[0]))).toBe(true);
  });

  test('DB explosion → resolves { sent:false }, NEVER throws (grant/revoke jobs unaffected)', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(mailer.sendMemberEmail(baseArgs)).resolves.toEqual({ sent: false, reason: 'exception' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// maybeSendGrantEmail — allow-list + sub-member detection
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 maybeSendGrantEmail — allow-list suppression', () => {
  const MEMBER = { member_master_id: 'mm-1', email: 'member@x.com', first_name: 'Jane', sub_master_id: null };
  const ASSIGNMENTS = [{ mappingId: 'map-1', planName: 'Monthly', sourcePlanId: 'sp-1', wixOrderId: 'ord-1' }];

  test('real webhook grant → access_ready email sent', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Monthly', door_name: 'Front' }] });
    const r = await mailer.maybeSendGrantEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased', planId: 'sp-1' },
      assignments: ASSIGNMENTS, eventKey: 'evt-1',
    });
    expect(r.sent).toBe(true);
    const insert = db.query.mock.calls.find(c => /INSERT INTO member_email_log/.test(c[0]));
    expect(insert[1][2]).toBe('access_ready');                     // email_type
    expect(insert[1][3]).toBe(`${ACCESS}:sp-1:ord-1`);            // dedup key: renewal-safe (same order suppressed)
  });

  test('reconcile-sourced synthetic → suppressed, no member lookup at all', async () => {
    mockDb({ memberRow: MEMBER });
    const r = await mailer.maybeSendGrantEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased', synthetic: true, syntheticSource: 'reconciliation.true_source_sync' },
      assignments: ASSIGNMENTS,
    });
    expect(r).toEqual({ sent: false, reason: 'synthetic_source' });
    expect(mockResendSend).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();                       // suppressed before any I/O
  });

  test('UNTAGGED synthetic → suppressed (fail-quiet default for unknown synthetics)', async () => {
    mockDb({ memberRow: MEMBER });
    const r = await mailer.maybeSendGrantEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased', synthetic: true },
      assignments: ASSIGNMENTS,
    });
    expect(r.reason).toBe('synthetic_source');
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  test('multi-member.holder_claim synthetic → allowed (holder chose to join)', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Couples', door_name: 'Front' }] });
    const r = await mailer.maybeSendGrantEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased', synthetic: true, syntheticSource: 'multi-member.holder_claim', planId: 'sp-1' },
      assignments: ASSIGNMENTS,
    });
    expect(r.sent).toBe(true);
  });

  test('sub-member (sub_master_id set) → sub_member_invite copy with holder name', async () => {
    mockDb({
      memberRow: Object.assign({}, MEMBER, { sub_master_id: 'holder-mm' }),
      planRows: [{ plan_name: 'Family', door_name: 'Front' }],
      holderRow: { first_name: 'Daxx', last_name: 'Roberts', display_name: null },
    });
    const r = await mailer.maybeSendGrantEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased', synthetic: true, syntheticSource: 'multi-member.submit', planId: 'sp-1' },
      assignments: ASSIGNMENTS,
    });
    expect(r.sent).toBe(true);
    const insert = db.query.mock.calls.find(c => /INSERT INTO member_email_log/.test(c[0]));
    expect(insert[1][2]).toBe('sub_member_invite');
    const payload = mockResendSend.mock.calls[0][0];
    expect(payload.subject).toContain('Daxx Roberts added you to');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// captureAccessRemovedContext — suppression + pre-purge capture
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 access-removed capture — suppression matrix', () => {
  const MEMBER = { member_master_id: 'mm-1', email: 'member@x.com', first_name: 'Jane' };

  test('real plan.cancelled → context captured (email + plan name)', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Couples' }] });
    const ctx = await mailer.captureAccessRemovedContext({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.cancelled', planId: 'sp-1' },
    });
    expect(ctx).toEqual({ memberMasterId: 'mm-1', email: 'member@x.com', firstName: 'Jane', planName: 'Couples' });
  });

  test('holder self-release → null (they clicked Leave — no alarm email)', async () => {
    mockDb({ memberRow: MEMBER });
    const ctx = await mailer.captureAccessRemovedContext({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.cancelled', synthetic: true, syntheticSource: 'multi-member.holder_release' },
    });
    expect(ctx).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  test('holder removing a sub-member → captured (real access loss for the sub)', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Family' }] });
    const ctx = await mailer.captureAccessRemovedContext({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.cancelled', synthetic: true, syntheticSource: 'multi-member.remove_sub', planId: 'sp-1' },
    });
    expect(ctx).not.toBeNull();
  });

  test('reconcile-sourced revoke → null', async () => {
    const ctx = await mailer.captureAccessRemovedContext({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.cancelled', synthetic: true, syntheticSource: 'reconciliation.reconcile_member' },
    });
    expect(ctx).toBeNull();
  });

  test('member.deleted → null (not a cancellation event type)', async () => {
    const ctx = await mailer.captureAccessRemovedContext({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'member.deleted' },
    });
    expect(ctx).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// maybeSendAccessSuspendedEmail / maybeSendAccessRestoredEmail — M4/M5
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 M4/M5 — access-suspended / access-restored', () => {
  const MEMBER = { member_master_id: 'mm-1', email: 'member@x.com', first_name: 'Jane' };

  test('payment.failed → access_suspended email sent', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Couples' }] });
    const r = await mailer.maybeSendAccessSuspendedEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'payment.failed', planId: 'sp-1' },
      eventKey: 'evt-1',
    });
    expect(r.sent).toBe(true);
    const insert = db.query.mock.calls.find(c => /INSERT INTO member_email_log/.test(c[0]));
    expect(insert[1][2]).toBe('access_suspended');
    const payload = mockResendSend.mock.calls[0][0];
    expect(payload.subject).toBe('Your Couples access at House of Gains is paused');
  });

  test('payment.recovered → access_restored email sent', async () => {
    mockDb({ memberRow: MEMBER, planRows: [{ plan_name: 'Couples' }] });
    const r = await mailer.maybeSendAccessRestoredEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'payment.recovered', planId: 'sp-1' },
      eventKey: 'evt-2',
    });
    expect(r.sent).toBe(true);
    const insert = db.query.mock.calls.find(c => /INSERT INTO member_email_log/.test(c[0]));
    expect(insert[1][2]).toBe('access_restored');
    const payload = mockResendSend.mock.calls[0][0];
    expect(payload.subject).toBe('Your Couples access at House of Gains is back');
  });

  test('wrong eventType on the suspend hook → suppressed, no lookup at all', async () => {
    mockDb({ memberRow: MEMBER });
    const r = await mailer.maybeSendAccessSuspendedEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.cancelled' },
    });
    expect(r).toEqual({ sent: false, reason: 'not_allowed' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('wrong eventType on the restore hook → suppressed, no lookup at all', async () => {
    mockDb({ memberRow: MEMBER });
    const r = await mailer.maybeSendAccessRestoredEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'plan.purchased' },
    });
    expect(r).toEqual({ sent: false, reason: 'not_allowed' });
    expect(db.query).not.toHaveBeenCalled();
  });

  test('synthetic payment.failed → suppressed (no allowed-synthetic source defined yet)', async () => {
    mockDb({ memberRow: MEMBER });
    const r = await mailer.maybeSendAccessSuspendedEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'payment.failed', synthetic: true, syntheticSource: 'reconciliation.true_source_sync' },
    });
    expect(r).toEqual({ sent: false, reason: 'not_allowed' });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  test('no recipient (member has no email) → skipped, never throws', async () => {
    mockDb({ memberRow: { member_master_id: 'mm-1', email: null, first_name: 'Jane' } });
    const r = await mailer.maybeSendAccessSuspendedEmail({
      clientId: CLIENT, accessId: ACCESS,
      standardEvent: { eventType: 'payment.failed', planId: 'sp-1' },
    });
    expect(r).toEqual({ sent: false, reason: 'no_recipient' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Static ordering guards — the seams in queue-worker.js
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 queue-worker seams — PII-purge ordering (static scan)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../core/queue-worker.js'), 'utf8');

  test('access-removed capture sits AFTER completeRevoke and BEFORE finalizeRevoke', () => {
    const completeIdx = src.indexOf('standardAdapter.completeRevoke(memberId, tenantId, targetStatus)');
    const captureIdx  = src.indexOf('captureAccessRemovedContext');
    const finalizeIdx = src.indexOf('standardAdapter.finalizeRevoke(');
    expect(completeIdx).toBeGreaterThan(-1);
    expect(captureIdx).toBeGreaterThan(-1);
    expect(finalizeIdx).toBeGreaterThan(-1);
    // DR-044: finalizeRevoke NULLs member PII in the same awaited job — the recipient
    // MUST be captured in between, or the address is gone before the email exists.
    expect(captureIdx).toBeGreaterThan(completeIdx);
    expect(captureIdx).toBeLessThan(finalizeIdx);
  });

  test('capture is awaited (synchronous in the job), the send is fire-and-forget', () => {
    expect(src).toMatch(/await memberMailer\.captureAccessRemovedContext\(/);
    expect(src).toMatch(/memberMailer\.maybeSendAccessRemovedEmail\([\s\S]*?\)\.catch\(/);
  });

  test('grant email hooks are fire-and-forget (never block the grant job)', () => {
    const matches = src.match(/memberMailer\.maybeSendGrantEmail\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // main grant + plan.started
    const catches = src.match(/memberMailer\.maybeSendGrantEmail\([\s\S]*?\)\.catch\(\(\) => \{\}\)/g) || [];
    expect(catches.length).toBe(matches.length);
  });

  test('M4/M5 access-suspended/restored hooks exist, are fire-and-forget, and sit on the right branch', () => {
    // M4 — suspend fires on the revoke path's targetStatus==='disabled' branch,
    // a sibling of the existing targetStatus==='inactive' (M2) branch.
    expect(src).toMatch(/targetStatus === 'disabled'[\s\S]{0,400}memberMailer\.maybeSendAccessSuspendedEmail\([\s\S]*?\)\.catch\(\(\) => \{\}\)/);
    // M5 — restore fires on the payment.recovered early-exit grant branch, after
    // completeRevoke(memberId, tenantId, 'active').
    expect(src).toMatch(/completeRevoke\(memberId, tenantId, 'active'\)[\s\S]{0,600}memberMailer\.maybeSendAccessRestoredEmail\([\s\S]*?\)\.catch\(\(\) => \{\}\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Static — multi-member synthetic events carry syntheticSource tags
// ════════════════════════════════════════════════════════════════════════════
describe('[P1] DR-052 multi-member synthetic events are source-tagged (static scan)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../admin/routes/multi-member.js'), 'utf8');
  test('all four synthetic sources tagged', () => {
    expect(src).toContain("'multi-member.submit'");
    expect(src).toContain("'multi-member.holder_claim'");
    expect(src).toContain("'multi-member.holder_release'");
    expect(src).toContain("'multi-member.remove_sub'");
  });
});
