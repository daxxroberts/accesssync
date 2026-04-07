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
    { label: 'System Config',                         href: '/locations',     key: 'config' },
    { label: 'Admin',                               href: '/admin-panel',   key: 'admin' },
  ];

  container.innerHTML = '';
  tabs.forEach(function(tab) {
    var a = document.createElement('a');
    a.href = tab.href + window.location.search;
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

// ── Breadcrumb renderer ───────────────────────────────────────────
function renderBreadcrumb() {
  var container = document.getElementById('subNav');
  if (!container) return;
  var activeKey = container.dataset.active || '';
  var labels = { overview: 'Overview', members: 'Members', 'plan-mapping': 'Plan Mapping', access: 'Access', config: 'System Config', admin: 'Admin' };
  var label = labels[activeKey] || '';
  if (!label) return;
  var bc = document.createElement('div');
  bc.className = 'breadcrumb';
  bc.innerHTML = '<a href="/dashboard' + window.location.search + '">Dashboard</a> <span class="bc-sep">/</span> <span>' + label + '</span>';
  container.parentNode.insertBefore(bc, container.nextSibling);
}

document.addEventListener('DOMContentLoaded', function() { renderNav(); renderBreadcrumb(); });

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

// ── Logout ─────────────────────────────────────────────────────────
function doLogout() {
  fetch('/auth/logout', { method: 'POST', credentials: 'include' })
    .then(function() { window.location.href = '/OwnerDashboard'; })
    .catch(function() { window.location.href = '/OwnerDashboard'; });
}

// ── Session-expired modal ─────────────────────────────────────────
function showSessionExpiredModal() {
  if (document.getElementById('session-expired-overlay')) return;
  var overlay = document.createElement('div');
  overlay.id = 'session-expired-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML =
    '<div style="background:var(--surface,#fff);border-radius:12px;padding:2rem;max-width:360px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.25)">' +
      '<h3 style="margin:0 0 .5rem">Session Expired</h3>' +
      '<p style="margin:0 0 1.25rem;color:var(--muted,#888)">Your session has expired. Please sign in again.</p>' +
      '<button onclick="window.location.href=\'/OwnerDashboard\'" style="padding:.5rem 1.5rem;border:none;border-radius:6px;background:var(--brand,#E94560);color:#fff;cursor:pointer;font-weight:600">Sign In</button>' +
    '</div>';
  document.body.appendChild(overlay);
}

// ── Global API fetch wrapper (catches 401) ────────────────────────
function apiFetch(url, options) {
  options = Object.assign({ credentials: 'include' }, options || {});
  return fetch(url, options).then(function(res) {
    if (res.status === 401) {
      showSessionExpiredModal();
      throw new Error('Session expired');
    }
    return res;
  });
}

// ── Keyboard shortcuts ────────────────────────────────────────────
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    // Close any open drawers
    document.querySelectorAll('.drawer.open, .drawer.visible, [class*="drawer"][style*="translateX(0)"]').forEach(function(el) {
      el.classList.remove('open', 'visible');
      el.style.transform = '';
    });
    // Close overlays
    var overlay = document.getElementById('session-expired-overlay');
    if (overlay) overlay.remove();
    // Close any open modals
    document.querySelectorAll('.modal-overlay.visible, .modal.open').forEach(function(el) {
      el.classList.remove('visible', 'open');
    });
  }
});

// ── HTML escape ────────────────────────────────────────────────────
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
