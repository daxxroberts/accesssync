/**
 * operator-nav.js
 * AccessSync Operator Dashboard — Shared Navigation & Dark Mode
 * Loaded on every operator page. Reads active tab from data-active
 * attribute on #subNav so no per-page JS is needed.
 */

'use strict';

// ── Platform config — populated from API on load ───────────────────
var PLATFORM_CONFIG = { name: '', groupLabel: 'Access Group' };
function platformName() { return PLATFORM_CONFIG.name || 'Hardware'; }

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

  var tabs = [
    { label: 'Overview',      href: '/dashboard',    key: 'overview' },
    { label: 'Members',       href: '/members',      key: 'members' },
    { label: 'Plan Mapping',  href: '/plan-mapping', key: 'plan-mapping' },
    // Access tab hidden 2026-04-29 — superseded by Trace Timeline (logs).
    // The page rendered member_access_log as a chart + table, which is now
    // a strict subset of what /logs surfaces with full enrichment. Route
    // and EJS file kept for now so existing bookmarks don't 404 hard;
    // tab will revisit (or get deleted) post-HOG. See OB-NEW-Access-pivot.
    // { label: 'Access',        href: '/access',       key: 'access' },
    { label: 'Logs',          href: '/logs',         key: 'logs' },
    { label: 'Errors',        href: '/errors',       key: 'errors' },
    { label: 'System Config', href: '/locations',    key: 'config' },
    { label: 'Admin',         href: '/admin-panel',  key: 'admin' },
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
  var labels = { overview: 'Overview', members: 'Members', 'plan-mapping': 'Plan Mapping', access: 'Access', errors: 'Errors', config: 'System Config', admin: 'Admin' };
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
    .then(function() {
      var loginUrl = document.body.dataset.loginUrl;
      if (loginUrl) { window.location.href = loginUrl; }
      else { window.location.reload(); }
    })
    .catch(function() { window.location.reload(); });
}

// ── Session-expired modal ─────────────────────────────────────────
var _sessionExpired = false;
var _abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;

function showSessionExpiredModal() {
  if (_sessionExpired) return;
  _sessionExpired = true;
  if (_abortController) _abortController.abort();
  stopAllPolling();

  var role = document.body.dataset.sessionRole || 'operator';
  var isOwner = role === 'owner';
  var loginUrl = document.body.dataset.loginUrl;

  var overlay = document.createElement('div');
  overlay.id = 'session-expired-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:center;justify-content:center';

  var btn = isOwner && loginUrl
    ? '<button onclick="window.open(\'' + loginUrl + '\',\'_blank\')" style="padding:.5rem 1.5rem;border:none;border-radius:6px;background:var(--brand,#4F6EF7);color:#fff;cursor:pointer;font-weight:600">Sign In</button>'
    : '<button onclick="window.location.reload()" style="padding:.5rem 1.5rem;border:none;border-radius:6px;background:var(--brand,#4F6EF7);color:#fff;cursor:pointer;font-weight:600">Refresh Window</button>';

  var body = isOwner
    ? 'Your owner session has expired. Sign in again in a new tab, then return here and refresh.'
    : 'Your session has expired. Please refresh to continue.';

  overlay.innerHTML =
    '<div style="background:var(--surface,#fff);border-radius:12px;padding:2rem;max-width:360px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.25)">' +
      '<h3 style="margin:0 0 .5rem">Session Expired</h3>' +
      '<p style="margin:0 0 1.25rem;color:var(--muted,#888)">' + body + '</p>' +
      btn +
    '</div>';
  document.body.appendChild(overlay);
}

// ── Stop all polling (called on session expiry) ───────────────────
function stopAllPolling() {
  if (typeof window._pollTimers === 'object') {
    window._pollTimers.forEach(function(t) { clearInterval(t); clearTimeout(t); });
  }
  // Also stop any timers registered by app.js via the shared registry
  if (typeof stopPolling === 'function') { try { stopPolling(); } catch(e) {} }
}

// ── Global API fetch wrapper (catches 401) ────────────────────────
function apiFetch(url, options) {
  if (_sessionExpired) return Promise.reject(new Error('Session expired'));
  options = Object.assign({ credentials: 'include' }, options || {});
  if (_abortController) options.signal = _abortController.signal;
  return fetch(url, options).then(function(res) {
    if (res.status === 401) {
      showSessionExpiredModal();
      throw new Error('Session expired');
    }
    return res;
  }).catch(function(err) {
    if (err.name === 'AbortError') throw new Error('Session expired');
    throw err;
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

// ── DR-025 amendment: plan-name disambiguation ─────────────────────
// When a client has duplicate plan_names (e.g. two "Couples" plans mapped to
// different doors), the operator UI must distinguish them. This helper takes
// a list of plan-mapping rows and returns a Map of { mapping_id → displayName }
// where duplicate names get a last-6-of-source_plan_id suffix appended.
//
// Usage:
//   var nameMap = disambiguatePlanNames(mappings);
//   var label = nameMap.get(m.id) || m.plan_name;
//
// Each input mapping is expected to have { id, plan_name, source_plan_id }.
function disambiguatePlanNames(mappings) {
  if (!Array.isArray(mappings)) return new Map();
  var baseNameFor = function(m) {
    return m.plan_name || ('Plan ' + (m.source_plan_id ? String(m.source_plan_id).slice(-6) : ''));
  };
  var nameCount = {};
  mappings.forEach(function(m) {
    var n = baseNameFor(m);
    nameCount[n] = (nameCount[n] || 0) + 1;
  });
  var out = new Map();
  mappings.forEach(function(m) {
    var n = baseNameFor(m);
    if (nameCount[n] > 1 && m.source_plan_id) {
      out.set(m.id, n + ' (…' + String(m.source_plan_id).slice(-6) + ')');
    } else {
      out.set(m.id, n);
    }
  });
  return out;
}

// ── Jump-to-fix: navigate to destination page with a highlight target ──
function jumpToFix(url) {
  window.location.href = url;
}

// ── On-page: read jumpTo + tip params, scroll to element, pulse + tooltip ──
// Called at DOMContentLoaded by destination pages (locations, plan-mapping).
// Polls for the element because those pages render content via async fetch.
function activateJumpTarget() {
  var params = new URLSearchParams(window.location.search);
  var jumpTo = params.get('jumpTo');
  var tip    = params.get('tip');
  if (!jumpTo) return;

  var attempts = 0;
  var interval = setInterval(function() {
    var el = document.getElementById(jumpTo);
    if (el || attempts++ > 20) {
      clearInterval(interval);
      if (!el) return;

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('jump-highlight');
      setTimeout(function() { el.classList.remove('jump-highlight'); }, 4000);

      if (tip) {
        var bubble = document.createElement('div');
        bubble.className = 'jump-tip';
        bubble.innerHTML =
          '<span class="jump-tip-arrow"></span>' +
          '<span class="jump-tip-text">' + esc(tip) + '</span>' +
          '<button class="jump-tip-close" onclick="this.parentNode.remove()">&#215;</button>';
        el.style.position = 'relative';
        el.appendChild(bubble);
      }
    }
  }, 150);
}
