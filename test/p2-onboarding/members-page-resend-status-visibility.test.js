/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Members page — resend-welcome-email: clientId resolution + feedback    │
 * │  (static scan)                                                          │
 * │                                                                         │
 * │  2026-09-06: Daxx clicked "Resend welcome email" — the menu closed and  │
 * │  NOTHING happened. DB proved the click never reached the backend (zero  │
 * │  member_email_log / diagnostic_log / activity_event rows). Root cause:  │
 * │  admin/server.js renders window.__CLIENT_ID as "" for OWNER sessions    │
 * │  (req.admin?.clientId || '' — only operator tokens carry a clientId).   │
 * │  The member list still renders for owners only because                  │
 * │  members-bridge.js resolveClientId() falls through to the URL           │
 * │  ?clientId= param. The first handler read window.__CLIENT_ID alone, got │
 * │  "", and hit `if (!clientId) return;` BEFORE setting any status — a     │
 * │  silent dead end. (An earlier "fix" targeted .row-actions opacity — a   │
 * │  symptom that never existed, because the handler never got that far.)  │
 * │                                                                         │
 * │  No React-render harness exists for this repo's Babel-standalone JSX   │
 * │  (no bundler / test DOM) — static source scan is the established        │
 * │  pattern (see queue-worker static scans in member-email-hooks.test.js). │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    1. members-bridge.js exposes the RESOLVED clientId on                │
 * │       window.__MEMBERS_CONTEXT (the value the list was loaded with)     │
 * │    2. The handler reads pageContext.clientId first, window.__CLIENT_ID  │
 * │       only as a fallback                                                │
 * │    3. The handler NEVER exits silently — a missing clientId surfaces as │
 * │       an "error" status, and every exit path schedules the auto-clear   │
 * │    4. .row-actions is forced .open while a status is showing (the       │
 * │       container is opacity:0 off-hover — members.ejs:436-437)           │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

const appSrc    = fs.readFileSync(path.join(__dirname, '../../admin/public/members-app.jsx'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(__dirname, '../../admin/public/members-bridge.js'), 'utf8');
const ejsSrc    = fs.readFileSync(path.join(__dirname, '../../admin/views/pages/members.ejs'), 'utf8');
const serverSrc = fs.readFileSync(path.join(__dirname, '../../admin/server.js'), 'utf8');

/** Isolate the handler body so assertions can't be satisfied by unrelated code. */
function handlerBody() {
  const m = appSrc.match(/const handleResendWelcomeEmail = \(m\) => \{([\s\S]*?)\n  \};/);
  if (!m) throw new Error('handleResendWelcomeEmail not found in members-app.jsx');
  return m[1];
}

describe('[P2] Members page resend — clientId resolution (the actual 2026-09-06 root cause)', () => {
  test('premise: the /members route renders window.__CLIENT_ID from req.admin.clientId, which is empty for owners', () => {
    // If this ever changes to also fall back to the URL param, the bug class
    // shrinks but the handler-side guard below must still hold.
    expect(serverSrc).toMatch(/res\.render\('pages\/members',\s*\{[^}]*clientId:\s*req\.admin\?\.clientId \|\| ''/);
  });

  test('members-bridge.js exposes the resolved clientId on window.__MEMBERS_CONTEXT (success path)', () => {
    const ctx = bridgeSrc.match(/window\.MEMBERS = nested;\s*window\.__MEMBERS_CONTEXT = \{([\s\S]*?)\};/);
    expect(ctx).not.toBeNull();
    expect(ctx[1]).toMatch(/\bclientId:\s*clientId\b/);
  });

  test('handler reads pageContext.clientId FIRST, window.__CLIENT_ID only as fallback', () => {
    const body = handlerBody();
    expect(body).toMatch(/pageContext\.clientId\)?\s*\|\|\s*window\.__CLIENT_ID/);
    // Must not read window.__CLIENT_ID as the sole source anywhere in the handler.
    expect(body).not.toMatch(/const clientId = window\.__CLIENT_ID;/);
  });
});

describe('[P2] Members page resend — never fails silently (QUINN dead-end rule)', () => {
  test('a missing clientId surfaces as an "error" status instead of a bare return', () => {
    const body = handlerBody();
    // The original bug, verbatim — must not come back.
    expect(body).not.toMatch(/if \(!clientId\) return;/);
    // The no-clientId branch sets error AND schedules the auto-clear before returning.
    expect(body).toMatch(/if \(!clientId\) \{\s*setResendStatus\(s => \(\{ \.\.\.s, \[m\.id\]: "error" \}\)\);\s*clearLater\(\);\s*return;\s*\}/);
  });

  test('every exit path schedules the 3s auto-clear (does not force .open forever)', () => {
    const body = handlerBody();
    expect(body).toMatch(/const clearLater = \(\) => setTimeout\(\(\) => \{[\s\S]*?delete next\[m\.id\][\s\S]*?\}, 3000\);/);
    expect(body).toMatch(/\.finally\(clearLater\)/);
  });
});

describe('[P2] Members page resend — status stays visible after the menu closes', () => {
  test('premise: members.ejs gates .row-actions visibility on hover or .open', () => {
    expect(ejsSrc).toMatch(/\.row-actions\s*\{[^}]*opacity:\s*0/);
    expect(ejsSrc).toMatch(/\.row-actions\.open\s*\{\s*opacity:\s*1/);
  });

  test('the .row-actions className forces .open while resendStatus[m.id] is set', () => {
    const cls = appSrc.match(/className=\{`row-actions \$\{([^}]*)\}`\}/);
    expect(cls).not.toBeNull();
    expect(cls[1]).toContain('openMenu === m.id');
    expect(cls[1]).toContain('openError === m.id');
    expect(cls[1]).toContain('resendStatus[m.id]');
  });
});
