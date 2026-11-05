/**
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  PRIORITY 2 — OPERATOR SETUP                                            │
 * │  Scenario: before a Plan Mapping save takes doors away, the gym sees    │
 * │  how many members lose them in Kisi — in the same words on both screens │
 * │                                                                         │
 * │  Daxx, 2026-11-03: keep "removing a door revokes it in Kisi", and add a │
 * │  confirmation step. The count comes from GET …/door-change-impact (the  │
 * │  rules the save runs — real-db-plan-mapping-kisi-sync.test.js); the     │
 * │  sentence comes from ONE function (admin/public/door-change-copy.js)    │
 * │  that the classic page and the wire view both call.                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { describe: say } = require('../../admin/public/door-change-copy');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('[P2] door-change confirmation — the sentence', () => {
  test('a door taken off: who loses it in Kisi, and who keeps it through another plan', () => {
    expect(say({ planName: 'Monthly', removed: ['Pool'], added: [], off: false }, { losing: 37, keeping: 2, gaining: 0 }))
      .toBe('Removing Pool from Monthly takes it away from 37 members in Kisi. 2 members keep it through another plan.');
    expect(say({ planName: 'Monthly', removed: ['Pool'], added: [], off: false }, { losing: 1, keeping: 0, gaining: 0 }))
      .toBe('Removing Pool from Monthly takes it away from 1 member in Kisi.');
  });

  test('the plan left with no doors (switched off)', () => {
    expect(say({ planName: 'Yoga', removed: ['Studio'], added: [], off: true }, { losing: 18, keeping: 1, gaining: 0 }))
      .toBe('Yoga will have no doors left: this takes Studio away from 18 members in Kisi. 1 member keeps it through another plan.');
  });

  test('a remap: who gets the new door, who loses the old one', () => {
    expect(say({ planName: 'Family', removed: ['Front Door'], added: ['Sauna'], off: false }, { losing: 11, keeping: 1, gaining: 12 }))
      .toBe('Moving Family from Front Door to Sauna: 12 members get Sauna, and Front Door is taken away from 11 members in Kisi. 1 member keeps it through another plan.');
    expect(say({ planName: 'Family', removed: ['Front Door', 'Pool'], added: ['Sauna'], off: false }, { losing: 2, keeping: 0, gaining: 2 }))
      .toMatch(/Front Door and Pool are taken away from 2 members in Kisi\.$/);
  });

  test('when the count could not be read it says so — never a made-up number', () => {
    expect(say({ planName: 'Monthly', removed: ['Pool'], added: [], off: false }, null))
      .toBe('AccessSync couldn’t count the members this affects. Saving will still update them in Kisi.');
  });
});

describe('[P2] door-change confirmation — both screens use the one definition', () => {
  const page  = read('admin/views/pages/plan-mapping.ejs');
  const panel = read('admin/svelte/panels/PlanMappingPanel.svelte');

  test('the classic page loads the shared copy and asks door-change-impact before either save path sends', () => {
    expect(page).toMatch(/<script src="\/door-change-copy\.js"><\/script>/);
    expect(page).toMatch(/DoorChangeCopy\.describe\(/);
    expect(page).toMatch(/\/door-change-impact\?/);
    // Both saveChanges (the static one and the live-data override) go through the confirmation.
    expect((page.match(/confirmDoorChanges\(clientId, function\(\) \{/g) || []).length).toBe(2);
    // The remap call after saving is gone: the PATCH itself moves the members.
    expect(page).not.toMatch(/\/remap'/);
  });

  test('the wire view asks door-change-impact and shows ConfirmModal, not the browser confirm()', () => {
    expect(panel).toMatch(/window\.DoorChangeCopy\.describe\(/);
    expect(panel).toMatch(/\/door-change-impact\?remove=/);
    expect(panel).toMatch(/<ConfirmModal bind:open=\{confirmOpen\}/);
    expect(panel).not.toMatch(/\bconfirm\(msg\)/);
  });

  test('neither screen writes its own copy of the sentence', () => {
    for (const src of [page, panel]) {
      expect(src).not.toMatch(/away from ' \+|keep(s)? it through another plan/);
    }
  });
});
