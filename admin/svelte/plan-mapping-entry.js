/**
 * admin/svelte/plan-mapping-entry.js
 * Svelte entry point for the operator plan-mapping page.
 * Mounts PlanMappingPanel into <div id="svelte-plan-mapping"> in plan-mapping.ejs.
 * Built separately from main.js → dist/plan-mapping.js
 */

import { mount } from 'svelte';
import PlanMappingPanel from './panels/PlanMappingPanel.svelte';
import Toast from './components/Toast.svelte';

const target = document.getElementById('svelte-plan-mapping');
if (target) {
  mount(PlanMappingPanel, { target });
}

// Mount toast at body level so it floats above everything
const toastTarget = document.getElementById('svelte-toast-pm');
if (toastTarget) {
  mount(Toast, { target: toastTarget });
}
