/**
 * PRIORITY 3 — DR-045 step 1 (SAGE, 2026-10-26): the evidence is measurable and readable.
 *
 * The DR-045 confidence scorecard counts suspend / re-enable and reconcile Pass 3 runs in
 * diagnostic_log. Until this step those info events were unregistered, so the logger
 * dropped them ("[logger] unregistered event"). This pins that they persist, that each
 * reads as a sentence on the dashboard (both name forms — diagnostic_log surfaces
 * UPPERCASE_UNDERSCORE), and that the new "label missing" warn and alert say the door
 * works, the label is missing, and how to fix it.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

global.window = {};
require('../../admin/public/humanize.js');
const { humanize } = global.window.AccessSyncHumanize;
const { describeConfigAlert } = require('../../core/operator-email-templates');

const ROOT = path.join(__dirname, '..', '..');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'EVENT_REGISTRY.json'), 'utf8'));

const PROMOTED = [
  'kisi.user.suspending',
  'kisi.user.suspended',
  'kisi.user.enabling',
  'kisi.user.enabled',
  'reconciliation.pass_3_complete',
];

const diag = (event, extra = {}) =>
  ({ source: 'diagnostic', event, result: 'success', detail: null, ts: '2026-10-26T00:00:00.000Z', ...extra });

describe('[P3] DR-045 step 1 — evidence events persist', () => {
  test.each(PROMOTED)('%s is registered persist:true', (name) => {
    expect(registry.overrides[name]).toEqual({ persist: true });
  });

  test('kisi.user.deleted stays persisted (it now carries ownershipSource)', () => {
    expect(registry.overrides['kisi.user.deleted']).toEqual({ persist: true });
  });

  test('kisi.user.create_metadata_missing is a warn and rides the warn default (no override suppresses it)', () => {
    expect(registry.overrides['kisi.user.create_metadata_missing']).toBeUndefined();
  });
});

describe('[P3] DR-045 step 1 — dashboard copy', () => {
  test.each([...PROMOTED, 'kisi.user.create_metadata_missing'])('%s reads as a sentence in both name forms', (name) => {
    const upper = name.replace(/\./g, '_').toUpperCase();
    for (const e of [name, upper]) {
      const text = humanize(diag(e, { member_name: 'Drew Roberts', client_name: 'House of Gains' }));
      expect(text).toBeTruthy();
      expect(text).not.toContain(name);
      expect(text).not.toMatch(/not yet defined|\bundefined\b|\bnull\b/);
    }
  });

  test('suspend / enable name the member and say it is door access in Kisi', () => {
    expect(humanize(diag('kisi.user.suspended', { member_name: 'Drew Roberts' })))
      .toBe("Turned off Drew Roberts's door access in Kisi. Their door groups are kept, so it can be turned back on.");
    expect(humanize(diag('KISI_USER_ENABLED', { member_name: 'Drew Roberts' })))
      .toBe("✓ Turned Drew Roberts's door access back on in Kisi.");
  });

  test('pass 3 reports the account count, or that it was skipped on an outage', () => {
    expect(humanize(diag('reconciliation.pass_3_complete', { client_name: 'House of Gains', payload: { totalKisiUsersFetched: 144 } })))
      .toBe('Reconcile checked 144 Kisi accounts against AccessSync at House of Gains.');
    expect(humanize(diag('RECONCILIATION_PASS_3_COMPLETE', { payload: { outage: true } })))
      .toMatch(/couldn't read the Kisi account list, so it skipped the account check and changed nothing/);
  });

  test('the label-missing warn: door works, label missing, how to fix', () => {
    const text = humanize(diag('KISI_USER_CREATE_METADATA_MISSING', { member_name: 'Drew Roberts' }));
    expect(text).toMatch(/^Drew Roberts's door access works, but the AccessSync label didn't save/);
    expect(text).toContain('node scripts/kisi-ownership-migrate.js verify');
  });
});

describe('[P3] DR-045 step 1 — the kisi_create_metadata_missing alert', () => {
  test('operator email: door works, nobody lost access, run verify; never prints the machine ref', () => {
    const text = describeConfigAlert({
      alert_type: 'kisi_create_metadata_missing',
      hardware_ref: 'kisi_user_id=603 code=503',
      locationName: 'Main St',
    });
    expect(text).toBe('A new member’s door access works at Main St, but the AccessSync label didn’t save on their new Kisi account. '
      + 'Nobody lost access. To fix it, run node scripts/kisi-ownership-migrate.js verify.');
    expect(text).not.toMatch(/kisi_user_id|code=/);
  });

  test('dashboard alert row says the same thing', () => {
    const text = humanize({ source: 'alert', event: 'kisi_create_metadata_missing', result: 'success', detail: null,
      ts: '2026-10-26T00:00:00.000Z', client_name: 'House of Gains' });
    expect(text).toMatch(/^A new member's door access works at House of Gains, but the AccessSync label didn't save/);
    expect(text).toContain('Nobody lost access');
    expect(text).toContain('node scripts/kisi-ownership-migrate.js verify');
  });
});
