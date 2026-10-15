/**
 * admin/svelte/main.js
 * Svelte entry point — mounts panels into the Owner dashboard (index.html).
 *
 * Four panels after the 2026-10-15 consolidation:
 *   hub      HubPanel         landing: verdict, one row per problem, healthy chips, platform row when wrong
 *   errors   ErrorQueuePanel  open errors across gyms, retry / dismiss
 *   members  MembersPanel     Debug Center + Member Sync merged
 *   gyms     ManageGymsPanel  account management: new gym, setup link, edit, key, archive, delete
 * (Trace Timeline is the React island in logs-app.jsx, mounted by index.html.)
 *
 * Panels mount on first open, not at login (app.js calls mountSveltePanel(name) from switchPanel), so a
 * hidden panel never fetches or polls. After a panel is shown again, app.js dispatches `panel:shown`
 * and the panel decides whether to reload.
 */

import { mount } from 'svelte';
import HubPanel        from './panels/HubPanel.svelte';
import ErrorQueuePanel from './panels/ErrorQueuePanel.svelte';
import MembersPanel    from './panels/MembersPanel.svelte';
import ManageGymsPanel from './panels/ManageGymsPanel.svelte';
import Toast           from './components/Toast.svelte';

const PANELS = {
  hub:     [HubPanel,        'svelte-hub'],
  errors:  [ErrorQueuePanel, 'svelte-errors'],
  members: [MembersPanel,    'svelte-members'],
  gyms:    [ManageGymsPanel, 'svelte-gyms'],
};
const mounted = {};
let toastMounted = false;

window.mountSveltePanel = function (name) {
  if (!toastMounted) {
    const toastTarget = document.getElementById('svelte-toast');
    if (toastTarget) { mount(Toast, { target: toastTarget }); toastMounted = true; }
  }
  const def = PANELS[name];
  if (!def || mounted[name]) return;
  const target = document.getElementById(def[1]);
  if (!target) return;
  mount(def[0], { target });
  mounted[name] = true;
};

// Self-trigger: if app.js already ran showDashboard() before this module loaded (ES modules are
// deferred, plain scripts are not), mount the current panel now rather than waiting for a call
// that already happened.
const current = document.querySelector('.panel:not(.hidden)');
if (current && document.getElementById('dashboard') && !document.getElementById('dashboard').classList.contains('hidden')) {
  window.mountSveltePanel(current.id.replace(/^panel-/, ''));
}
