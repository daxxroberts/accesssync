/**
 * operator-nav.js
 * AccessSync Operator Dashboard — Shared Navigation & Dark Mode
 * Loaded on every operator page. Reads active tab from data-active
 * attribute on #subNav so no per-page JS is needed.
 */

'use strict';

// ── Platform config ────────────────────────────────────────────────
var PLATFORM_CONFIG = { name: 'Kisi', groupLabel: 'Access Group' };
function platformName() { return PLATFORM_CONFIG.name; }

// ── Dark mode ──────────────────────────────────────────────────────
function toggleDarkMode() {
  var html = document.documentElement;
  var newMode = html.getAttribute('data-mode') === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-mode', newMode);
  localStorage.setItem('accesssync-dark-mode', newMode);
}

(function applyStoredDarkMode() {
  var saved = localStorage.getItem('accesssync-dark-mode') || 'light';
  document.documentElement.setAttribute('data-mode', saved);
})();

// ── Sub-nav renderer ───────────────────────────────────────────────
function renderNav() {
  var container = document.getElementById('subNav');
  if (!container) return;

  var activeKey = container.dataset.active || '';

  // Badges are static mock values; replace with API data when live
  var tabs = [
    { label: 'Overview',                            href: '/dashboard',     key: 'overview' },
    { label: 'Members',                             href: '/members',       key: 'members',      badge: 2 },
    { label: 'Plan Mapping',                        href: '/plan-mapping',  key: 'plan-mapping', badge: 1 },
    { label: 'Access',                              href: '/access',        key: 'access' },
    { label: platformName() + ' Config',            href: '/locations',     key: 'config' },
    { label: 'Admin',                               href: '/admin-panel',   key: 'admin' },
  ];

  container.innerHTML = '';
  tabs.forEach(function(tab) {
    var a = document.createElement('a');
    a.href = tab.href;
    a.className = 'sub-nav-link' + (tab.key === activeKey ? ' active' : '');
    a.textContent = tab.label;
    if (tab.badge > 0) {
      var badge = document.createElement('span');
      badge.className = 'sub-nav-badge';
      badge.textContent = tab.badge;
      a.appendChild(badge);
    }
    container.appendChild(a);
  });
}

document.addEventListener('DOMContentLoaded', renderNav);

// ── Toast ──────────────────────────────────────────────────────────
var _toastTimer;
function showToast(type, msg) {
  var t = document.getElementById('toast');
  if (!t) return;
  var icons = { success: '&#10003;', error: '&#10005;', info: '&#8505;' };
  t.className = 'toast ' + type;
  t.innerHTML = (icons[type] || '') + ' ' + msg;
  t.classList.add('visible');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function() { t.classList.remove('visible'); }, 3000);
}

// ── HTML escape ────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
