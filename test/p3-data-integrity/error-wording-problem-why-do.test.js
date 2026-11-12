/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 3 — DATA INTEGRITY                                            │
 * │  Scenario: every error says the same three things, briefly              │
 * │                                                                         │
 * │  Business consequence: the Errors page and the alert email were wordy   │
 * │  and repeated themselves (a connector line, a headline, steps, a "why"  │
 * │  and a "consequence" that overlapped). Each error now states the        │
 * │  PROBLEM, WHY it happened and WHAT TO DO — once, in short sentences —   │
 * │  and the alert email names the member and plan.                         │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { guidanceFor } = require('../../core/error-guidance');
const T = require('../../core/operator-email-templates');

const CODES = [
  'IN_FLIGHT_LOCK', 'HARDWARE_KEY_INVALID', 'HARDWARE_KEY_PERMISSIONS', 'HARDWARE_KEY_MISSING',
  'HARDWARE_RESOURCE_NOT_FOUND', 'HARDWARE_VALIDATION_ERROR', 'HARDWARE_API_ERROR', 'KISI_ROLE_CONFLICT_UNRESOLVED',
  'HARDWARE_USER_GONE', 'UNOWNED_USER', 'ELEVATED_ROLE_ATTACHED', 'CLIENT_MISMATCH',
  'LOGIN_EMAIL_UNVERIFIED', 'LOGIN_EMAIL_IN_USE', 'LOGIN_EMAIL_SHARED_USER', 'LOGIN_EMAIL_RATE_LIMITED',
  'LOGIN_EMAIL_USER_NOT_OURS', 'LOGIN_EMAIL_OLD_USER_NOT_REMOVED', 'SOURCE_RETRY_EXHAUSTED', 'INVALID_HARDWARE_REQUEST',
  'WIX_KEY_INVALID', 'WIX_KEY_MISSING', 'WIX_KEY_PERMISSIONS', 'PLAN_NOT_MAPPED', 'SUBSCRIPTION_LAPSED',
];
const words = (s) => String(s).trim().split(/\s+/).length;

describe('[P3] every known error has a short problem, a short why and short steps', () => {
  test.each(CODES)('%s', (code) => {
    const g = guidanceFor({ error_code: code });
    expect(g.headline.length).toBeGreaterThan(0);
    expect(g.why).toEqual(expect.any(String));           // "why it happened" is never missing
    expect(words(g.headline)).toBeLessThanOrEqual(16);   // a sentence, not a paragraph
    expect(words(g.why)).toBeLessThanOrEqual(20);
    expect(g.steps.length).toBeGreaterThan(0);
    expect(g.steps.length).toBeLessThanOrEqual(3);
    for (const st of g.steps) expect(words(st)).toBeLessThanOrEqual(24);
  });

  test('the problem and the why never say the same thing', () => {
    for (const code of CODES) {
      const g = guidanceFor({ error_code: code });
      expect(g.why).not.toBe(g.headline);
    }
  });

  test('computed answers (temporary, refused, unknown, repeating) carry a why too', () => {
    for (const row of [
      { http_status: 503 }, { http_status: 418 }, { error_code: 'ECONNRESET' }, { error_code: 'X' },
      { error_code: 'HARDWARE_API_ERROR', http_status: 500, occurred_count: 6 },
      { error_code: 'IN_FLIGHT_LOCK', occurred_count: 6 },
    ]) {
      expect(guidanceFor(row).why).toEqual(expect.any(String));
    }
  });
});

describe('[P3] the Errors page: collapsed rows grouped by who acts, details on click', () => {
  const ejs = fs.readFileSync(path.join(__dirname, '../../admin/views/pages/errors.ejs'), 'utf8');

  test('rows are grouped by guidance owner: gym first, then AccessSync, then needs-nothing, then resolved', () => {
    const order = ['gym', 'accesssync', 'nobody', 'resolved'].map((k) => ejs.indexOf("key: '" + k + "'"));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(ejs).toMatch(/e\.guidance && buckets\[e\.guidance\.owner\] \? e\.guidance\.owner : 'accesssync'/);
  });

  test('a gym gets no "AccessSync is on it" section: those rows sit with "Nothing for you to do"; only the owner sees Needs AccessSync', () => {
    expect(ejs).toMatch(/if \(key === 'accesssync' && !_isOwnerView\) key = 'nobody';/);
    expect(ejs).toContain("title: _isOwnerView ? 'No action needed' : 'Nothing for you to do'");
    expect(ejs).toContain("'Needs AccessSync'");
  });

  test('the email button (?open=<error id>) opens that row, and a section holding an opened row is never hidden', () => {
    expect(ejs).toMatch(/get\('open'\)/);
    expect(ejs).toMatch(/_openIds\[o\] = true/);
    expect(ejs).toMatch(/holdsOpenRow/);
  });

  test('sections that need a person start open; the needs-nothing one starts closed', () => {
    expect(ejs).toMatch(/key: 'gym'[^\n]*open: true/);
    expect(ejs).toMatch(/key: 'accesssync'[^\n]*open: true/);   // the owner's "Needs AccessSync"
    expect(ejs).toMatch(/key: 'nobody'[^\n]*open: false/);
  });

  test('a row is a one-line summary; details render only inside the expandable panel', () => {
    expect(ejs).toContain('class="err-row"');
    expect(ejs).toContain('class="err-panel"');
    expect(ejs).toMatch(/\.err-card\.open \.err-panel \{ display: block; \}/);
    expect(ejs).toMatch(/\.err-panel \{ display: none;/);
  });

  test('the panel says what happened, why, and what to do; the old stacked static lines are gone', () => {
    for (const label of ['What happened', 'Why', 'What to do']) expect(ejs).toContain('>' + label + '<');
    expect(ejs).not.toMatch(/var reason\s+=\s+staticOk/);
    expect(ejs).not.toContain('err-card-consequence"');
  });

  test('opened rows and sections survive the 30-second refresh and every action', () => {
    expect(ejs).toMatch(/var _openIds = \{\}/);
    expect(ejs).toMatch(/var _sectionOpen = \{\}/);
    expect(ejs).toMatch(/var isOpen\s+= !!_openIds\[e\.id\]/);
    expect(ejs).toMatch(/\(sec\.key in _sectionOpen\) \? _sectionOpen\[sec\.key\] : \(sec\.open \|\| holdsOpenRow\)/);
  });

  test('a summary strip counts what needs the gym, AccessSync, and nothing', () => {
    expect(ejs).toContain('id="err-summary"');
    expect(ejs).toContain('Nothing needs you right now.');
  });

  test('the dot colour says who acts; a gym-owned row with no Retry does not say AccessSync is on it', () => {
    expect(ejs).toContain("' err-dot-' + ((g.owner === 'accesssync' && !_isOwnerView) ? 'nobody' : g.owner)");
    expect(ejs).toMatch(/g\.owner === 'gym' \? \(g\.removal \?/);
  });

  test('a login-email stop is titled for what it is, not "couldn’t get door access"', () => {
    expect(ejs).toMatch(/e\.guidance\.title && e\.status !== 'resolved'/);
  });
});

describe('[P3] the alert email: short — what is wrong, what to do, one button to the details', () => {
  const g = guidanceFor({ error_code: 'LOGIN_EMAIL_UNVERIFIED' });
  const k = guidanceFor({ error_code: 'HARDWARE_KEY_INVALID' });
  const render = (guide, over = {}) => T.renderMemberFailureAlert({
    userMessage: guide.headline, title: guide.title, actionText: guide.steps.join(' '), owner: guide.owner, retry: guide.retry,
    memberName: 'Callie Bring', planName: 'Monthly', clientId: 'c1', errorId: 'e1', ...over,
  });

  test('the heading says what is wrong, so the body does not repeat it; "What to do" is the only other line', () => {
    const r = render(g);
    expect(r.subject).toBe('[AccessSync] Action needed: Callie Bring’s new login email isn’t confirmed');
    expect(r.text).toContain('What to do: Ask them to confirm the new email.');
    expect(r.text).not.toContain(g.headline);          // no second copy of the problem
    expect(r.text).not.toContain(g.why);               // why it happened lives on the page
    expect(r.html).not.toContain('>Why<');
  });

  test('a normal access failure: heading + one problem line + What to do', () => {
    const r = render(k);
    expect(r.subject).toBe('[AccessSync] Action needed: Callie Bring didn’t get access');
    expect(r.text).toContain(k.headline);
    expect(r.text).toMatch(/What to do: Replace the Kisi API Key/);
    expect(r.text).not.toContain(k.why);
  });

  test('the plan sits under the problem; no plan, no empty line', () => {
    expect(render(k).text).toContain('Monthly');
    expect(render(k, { planName: null }).text).not.toMatch(/null|undefined/);
  });

  test('the button opens THIS error already expanded (?open=<error id>) for a gym, and not for the owner copy', () => {
    expect(render(g).text).toContain('/errors?open=e1&clientId=c1');
    expect(render(k, { audience: 'owner', clientName: 'House of Gains' }).text).not.toContain('open=e1');
  });

  test('no error id (older callers) still links to the errors list', () => {
    expect(render(g, { errorId: null }).text).toContain('/errors?clientId=c1');
  });

  test('no member → "A member"; member and plan names are escaped', () => {
    expect(T.renderMemberFailureAlert({ userMessage: 'Something broke.', actionText: 'Do X.' }).subject).toContain('A member didn’t get access');
    const r = render(k, { memberName: 'A <b>B', planName: 'P & Q' });
    expect(r.html).not.toContain('<b>B');
    expect(r.html).toContain('P &amp; Q');
  });

  test('it is short: the visible text stays under 45 words for the heaviest case', () => {
    const body = render(k).text.split('\n').filter((l) => !/^(ACTION NEEDED|--|Sent by|See what|Retry or|https?:)/.test(l)).join(' ');
    expect(words(body)).toBeLessThanOrEqual(45);
  });
});
