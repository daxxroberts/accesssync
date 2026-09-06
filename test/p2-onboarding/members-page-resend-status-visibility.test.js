/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR ONBOARDING                                       │
 * │  Members page — resend-welcome-email status visibility (static scan)    │
 * │                                                                         │
 * │  2026-09-06: Daxx clicked "Resend welcome email," the email actually    │
 * │  sent, but the "Sending… / Sent / Failed" inline status never appeared. │
 * │  Root cause: admin/views/pages/members.ejs:436-437 sets .row-actions to │
 * │  opacity:0 except on row-hover or with an explicit .open class — the    │
 * │  action menu closes (setOpenMenu(null)) the instant a menu item fires,  │
 * │  so the status span was rendering correctly but invisibly the moment    │
 * │  the mouse left the row. No React-render harness exists for this repo's │
 * │  Babel-standalone JSX components (no bundler/test-DOM setup) — a static │
 * │  scan of the source is the established pattern here (see the           │
 * │  queue-worker.js static-scan tests in member-email-hooks.test.js).      │
 * │                                                                         │
 * │  What CANNOT regress:                                                   │
 * │    resendStatus[m.id] forces the .open class on .row-actions, so the    │
 * │    status indicator stays visible regardless of hover/menu state.       │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs = require('fs');
const path = require('path');

describe('[P2] Members page — resend-welcome-email status stays visible after the menu closes', () => {
  const appSrc = fs.readFileSync(path.join(__dirname, '../../admin/public/members-app.jsx'), 'utf8');
  const ejsSrc = fs.readFileSync(path.join(__dirname, '../../admin/views/pages/members.ejs'), 'utf8');

  test('members.ejs still gates .row-actions visibility on hover or .open (guards the premise of this test)', () => {
    expect(ejsSrc).toMatch(/\.row-actions\s*\{[^}]*opacity:\s*0/);
    expect(ejsSrc).toMatch(/\.row-actions\.open\s*\{\s*opacity:\s*1/);
  });

  test('the .row-actions className expression includes resendStatus[m.id] alongside openMenu/openError', () => {
    const classExprMatch = appSrc.match(/className=\{`row-actions \$\{([^}]*)\}`\}/);
    expect(classExprMatch).not.toBeNull();
    const condition = classExprMatch[1];
    expect(condition).toContain('openMenu === m.id');
    expect(condition).toContain('openError === m.id');
    expect(condition).toContain('resendStatus[m.id]');
  });

  test('resend status is still cleared after a few seconds (does not force .open forever)', () => {
    expect(appSrc).toMatch(/setTimeout\(\(\) => \{[\s\S]{0,200}delete next\[m\.id\][\s\S]{0,100}\}, 3000\)/);
  });
});
