/**
 * stores/toast.js
 * Svelte writable store for toast notifications.
 * Import showToast() anywhere to trigger a toast.
 */
import { writable } from 'svelte/store';

export const toasts = writable([]);

let idCounter = 0;

/**
 * showToast(message, type)
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 */
export function showToast(message, type = 'info') {
  const id = ++idCounter;
  toasts.update(all => [...all, { id, message, type }]);
  setTimeout(() => {
    toasts.update(all => all.filter(t => t.id !== id));
  }, 3500);
}
