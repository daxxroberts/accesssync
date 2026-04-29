/**
 * stores/toast.js
 * Svelte writable store for toast notifications.
 * Import showToast() anywhere to trigger a toast.
 */
import { writable } from 'svelte/store';

export const toasts = writable([]);

/**
 * showToast(message, type)
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 */
// Monotonic counter — guarantees no two toasts share an id even when
// fired in the same millisecond (Date.now resolution would collide and
// trip Svelte's {#each (key)} duplicate-key detection).
let _toastSeq = 0;

export function showToast(message, type = 'info') {
  _toastSeq = (_toastSeq + 1) >>> 0;
  const id = `${Date.now()}-${_toastSeq}-${Math.random().toString(36).slice(2, 9)}`;
  toasts.update(all => [...all, { id, message, type }]);
  setTimeout(() => {
    toasts.update(all => all.filter(t => t.id !== id));
  }, 3500);
}
