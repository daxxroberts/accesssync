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

import QueuePanel       from './panels/QueuePanel.svelte';
import WebhookPanel     from './panels/WebhookPanel.svelte';
import DebugCenterPanel from './panels/DebugCenterPanel.svelte';
import ErrorQueuePanel  from './panels/ErrorQueuePanel.svelte';
import MemberSyncPanel  from './panels/MemberSyncPanel.svelte';
import ClientsPanel     from './panels/ClientsPanel.svelte';

const queueTarget = document.getElementById('svelte-queue');
if (queueTarget) new QueuePanel({ target: queueTarget });

const webhookTarget = document.getElementById('svelte-webhooks');
if (webhookTarget) new WebhookPanel({ target: webhookTarget });

const debugTarget = document.getElementById('svelte-debug');
if (debugTarget) new DebugCenterPanel({ target: debugTarget });

const errorsTarget = document.getElementById('svelte-errors');
if (errorsTarget) new ErrorQueuePanel({ target: errorsTarget });

const membersyncTarget = document.getElementById('svelte-membersync');
if (membersyncTarget) new MemberSyncPanel({ target: membersyncTarget });

const clientsTarget = document.getElementById('svelte-clients');
if (clientsTarget) new ClientsPanel({ target: clientsTarget });
