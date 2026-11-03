/**
 * PRIORITY 3 — the dashboard (admin/public/humanize.js) words finalizeRevoke's DR-045 delete-guard
 * refusals in plain English, the same meaning as core/operator-email-templates.js describeConfigAlert.
 * They used to fall through to the raw alert code (SAGE review 2026-10-26).
 */
'use strict';

global.window = {};
require('../../admin/public/humanize.js');
const { humanize } = global.window.AccessSyncHumanize;

const alert = (event, extra = {}) =>
  ({ source: 'alert', event, result: 'success', detail: null, ts: '2026-10-26T00:00:00.000Z', ...extra });

describe('[P3] humanize — finalize_revoke_refused_* alerts', () => {
  test.each([
    ['finalize_revoke_refused_unowned_user',    /no AccessSync ownership label/],
    ['finalize_revoke_refused_client_mismatch', /different AccessSync account/],
    ['finalize_revoke_refused_elevated_role',   /admin, manager or owner rights/],
  ])('%s: the door part is done, the account was kept, and why', (event, why) => {
    const text = humanize(alert(event, { member_name: 'Drew Roberts', client_name: 'House of Gains' }));
    expect(text).toContain("AccessSync removed Drew Roberts's door access at House of Gains but didn't delete their Kisi account");
    expect(text).toMatch(why);
    expect(text).not.toContain(event);
    expect(text).not.toMatch(/did ?n'?t create|created by/i);
  });

  test('reads fine with no member or client name', () => {
    const text = humanize(alert('finalize_revoke_refused_unowned_user'));
    expect(text).toMatch(/^AccessSync removed a member's door access but didn't delete their Kisi account/);
    expect(text).not.toMatch(/\bnull\b|undefined/);
  });
});
