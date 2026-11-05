/**
 * @file door-change-copy.js
 * @layer admin/public
 * @role shared-copy
 * @exports window.DoorChangeCopy.describe (and module.exports, for tests)
 *
 * The sentence a gym reads before a Plan Mapping save takes doors away: how many members lose a
 * door in Kisi, and how many keep it through another plan. The counts come from
 * GET /operator/:clientId/plan-mappings/:mappingId/door-change-impact — the rules the save itself
 * runs. Both Plan Mapping screens use this one function (the classic page, plan-mapping.ejs, and
 * the wire view, admin/svelte/panels/PlanMappingPanel.svelte), so they always say the same thing.
 */
(function (root) {
  'use strict';

  function list(names) {
    if (names.length <= 1) return names[0] || '';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  function members(n) { return n + ' member' + (n === 1 ? '' : 's'); }

  /**
   * @param {{ planName: string, removed: string[], added: string[], off: boolean }} change
   *        door NAMES; `off` = the plan is left with no doors (switched off)
   * @param {{ losing: number, keeping: number, gaining: number } | null} impact
   *        null when the count could not be read
   */
  function describe(change, impact) {
    var plan = change.planName || 'this plan';
    var removed = list(change.removed || []);
    var added = list(change.added || []);
    if (!impact) {
      return 'AccessSync couldn’t count the members this affects. Saving will still update them in Kisi.';
    }
    var keep = impact.keeping > 0
      ? ' ' + members(impact.keeping) + ' keep' + (impact.keeping === 1 ? 's' : '') + ' it through another plan.'
      : '';
    var many = (change.removed || []).length > 1;
    if (change.off) {
      return plan + ' will have no doors left: this takes ' + removed + ' away from '
        + members(impact.losing) + ' in Kisi.' + keep;
    }
    if (added) {
      return 'Moving ' + plan + ' from ' + removed + ' to ' + added + ': ' + members(impact.gaining)
        + ' get ' + added + ', and ' + removed + (many ? ' are' : ' is') + ' taken away from '
        + members(impact.losing) + ' in Kisi.' + keep;
    }
    return 'Removing ' + removed + ' from ' + plan + ' takes ' + (many ? 'them' : 'it') + ' away from '
      + members(impact.losing) + ' in Kisi.' + keep;
  }

  var api = { describe: describe };
  root.DoorChangeCopy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
