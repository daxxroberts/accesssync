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
export function showToast(message, type = 'info') {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  toasts.update(all => [...all, { id, message, type }]);
  setTimeout(() => {
    toasts.update(all => all.filter(t => t.id !== id));
  }, 3500);
}
