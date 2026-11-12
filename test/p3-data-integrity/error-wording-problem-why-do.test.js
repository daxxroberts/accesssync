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

describe('[P3] the Errors page says it once', () => {
  const ejs = fs.readFileSync(path.join(__dirname, '../../admin/views/pages/errors.ejs'), 'utf8');

  test('when guidance owns a card, the older connector / reason / consequence lines are not stacked under it', () => {
    expect(ejs).toMatch(/var staticOk\s*=\s*!g;/);
  });

  test('the card shows the guidance why, and a single step as one "Do:" line', () => {
    expect(ejs).toMatch(/g\.why \? '<div class="err-card-reason">Why: '/);
    expect(ejs).toMatch(/<strong>Do:<\/strong>/);
  });
});

describe('[P3] the alert email: Problem / Why / Do, and who', () => {
  const g = guidanceFor({ error_code: 'LOGIN_EMAIL_UNVERIFIED' });
  const render = (over = {}) => T.renderMemberFailureAlert({
    userMessage: g.headline, why: g.why, title: g.title, actionText: g.steps.join(' '), owner: g.owner, retry: g.retry,
    memberName: 'Callie Bring', planName: 'Monthly', clientId: 'c1', ...over,
  });

  test('three labelled lines, in order, in both html and text', () => {
    const r = render();
    expect(r.text).toMatch(/Problem: .*\nWhy: .*\nDo: /);
    expect(r.html.indexOf('>Problem<')).toBeGreaterThan(-1);
    expect(r.html.indexOf('>Problem<')).toBeLessThan(r.html.indexOf('>Why<'));
    expect(r.html.indexOf('>Why<')).toBeLessThan(r.html.indexOf('>Do<'));
  });

  test('names the member in the heading and subject, and the plan under it', () => {
    const r = render();
    expect(r.subject).toBe('[AccessSync] Action needed: Callie Bring’s new login email isn’t confirmed');
    expect(r.text).toContain('Callie Bring’s new login email isn’t confirmed');
    expect(r.text).toContain('Monthly');
  });

  test('a normal access failure keeps the "didn’t get access" heading', () => {
    const r = T.renderMemberFailureAlert({ userMessage: 'Kisi rejected the saved API key.', actionText: 'Replace it.', memberName: 'Drew', owner: 'gym', retry: 'after_fix' });
    expect(r.subject).toBe('[AccessSync] Action needed: Drew didn’t get access');
  });

  test('no why → no empty "Why" line; no member → "A member"', () => {
    const r = T.renderMemberFailureAlert({ userMessage: 'Something broke.', actionText: 'Do X.' });
    expect(r.text).not.toMatch(/Why:/);
    expect(r.subject).toContain('A member didn’t get access');
  });

  test('member and plan names are escaped in the html', () => {
    const r = render({ memberName: 'A <b>B', planName: 'P & Q' });
    expect(r.html).not.toContain('<b>B');
    expect(r.html).toContain('P &amp; Q');
  });

  test('every email is much shorter than the old two-paragraph version for the same error', () => {
    const lines = render().text.split('\n').filter((l) => /^(Problem|Why|Do):/.test(l)).join(' ');
    expect(words(lines)).toBeLessThanOrEqual(60);
  });
});
