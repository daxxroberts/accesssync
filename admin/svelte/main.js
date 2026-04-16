/**
 * admin/svelte/main.js
 * Svelte entry point — mounts panels into the Owner Dashboard.
 *
 * Each panel targets a <div id="svelte-*"> injected into index.html
 * alongside the existing vanilla JS panel shells. Svelte takes over
 * the inner content; the outer panel/nav structure stays in app.js.
 *
 * Migration order (per COMPONENTS.md):
 *   1. QueuePanel       ✅ mounted
 *   2. WebhookPanel     ✅ mounted
 *   3. DebugCenterPanel ✅ mounted
 *   4. ErrorQueuePanel  ✅ mounted
 *   5. MemberSyncPanel  ✅ mounted
 *   6. ClientsPanel     ✅ mounted
 */

import { mount } from 'svelte';
import QueuePanel       from './panels/QueuePanel.svelte';
import WebhookPanel     from './panels/WebhookPanel.svelte';
import DebugCenterPanel from './panels/DebugCenterPanel.svelte';
import ErrorQueuePanel  from './panels/ErrorQueuePanel.svelte';
import MemberSyncPanel  from './panels/MemberSyncPanel.svelte';
import ClientsPanel     from './panels/ClientsPanel.svelte';

// mountPanels() is called by app.js after auth is confirmed — not on page load.
// This prevents panels from making 401 API calls before the user is logged in,
// which was causing Google Sign-In postMessage errors.
let _mounted = false;

window.mountSveltePanels = function () {
  if (_mounted) return;
  _mounted = true;

  const queueTarget = document.getElementById('svelte-queue');
  if (queueTarget) mount(QueuePanel, { target: queueTarget });

  const webhookTarget = document.getElementById('svelte-webhooks');
  if (webhookTarget) mount(WebhookPanel, { target: webhookTarget });

  const debugTarget = document.getElementById('svelte-debug');
  if (debugTarget) mount(DebugCenterPanel, { target: debugTarget });

  const errorsTarget = document.getElementById('svelte-errors');
  if (errorsTarget) mount(ErrorQueuePanel, { target: errorsTarget });

  const membersyncTarget = document.getElementById('svelte-membersync');
  if (membersyncTarget) mount(MemberSyncPanel, { target: membersyncTarget });

  const clientsTarget = document.getElementById('svelte-clients');
  if (clientsTarget) mount(ClientsPanel, { target: clientsTarget });
};

// Self-trigger: if app.js already ran showDashboard() before this module loaded
// (race condition — ES modules are always deferred, plain scripts are not),
// mount the panels now rather than waiting for a call that already happened.
const dashboard = document.getElementById('dashboard');
if (dashboard && !dashboard.classList.contains('hidden')) {
  window.mountSveltePanels();
}
