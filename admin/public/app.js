/**
 * admin/public/app.js
 * AccessSync Admin Hub — Frontend Logic
 *
 * Panels: Error Queue | Debug Center | Webhook Inspector | Queue Monitor
 * Auth: httpOnly cookie (adminToken) — 401 redirect to login screen
 * Polling: Queue Monitor every 5s, Webhook Inspector every 10s
 */

'use strict';

// ── State ──────────────────────────────────────────────────────────
const state = {
  currentPanel: 'errors',

  errors: {
    status: 'failed',
    limit: 50,
    offset: 0,
    total: 0,
    selected: new Set(),
    data: [],
  },

  webhooks: {
    data: [],
    lastTimestamp: null,
    polling: true,
    pollTimer: null,
  },

  queue: {
    counts: {},
    currentTab: 'waiting',
    pollTimer: null,
  },

  members: {
    searchTimer: null,
  },
};

// ── Helpers ────────────────────────────────────────────────────────

async function apiFetch(url, options = {}) {
  const res = await fetch(url, { credentials: 'include', ...options });
  if (res.status === 401) {
    stopPolling();
    showLogin();
    throw new Error('Unauthorized');
  }
  return res;
}

function fmt(isoString) {
  if (!isoString) return '—';
  const d = new Date(isoString);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function pill(text, type) {
  const map = {
    accepted: 'success', rejected: 'danger',
    new: 'info', duplicate: 'muted',
    failed: 'danger', resolved: 'success', 'in-progress': 'warning',
    active: 'success', waiting: 'warning', delayed: 'info', completed: 'muted', paused: 'muted',
    granted: 'success', revoked: 'muted', unknown: 'muted',
    archived: 'muted', cancelled: 'danger',
  };
  const cls = map[text] || 'muted';
  return `<span class="pill pill-${cls}">${text || '—'}</span>`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Toast ──────────────────────────────────────────────────────────
function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('toast-visible'), 10);
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 300);
  }, 3500);
}

// ── Modal ──────────────────────────────────────────────────────────
function showModal({ title, body, showNote = false, onConfirm }) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent = body;
  document.getElementById('modal-note').value = '';
  const noteWrap = document.getElementById('modal-note-wrap');
  noteWrap.classList.toggle('hidden', !showNote);
  document.getElementById('modal-overlay').classList.remove('hidden');

  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn  = document.getElementById('modal-cancel');

  function cleanup() {
    document.getElementById('modal-overlay').classList.add('hidden');
    confirmBtn.replaceWith(confirmBtn.cloneNode(true));
    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  }

  document.getElementById('modal-confirm').addEventListener('click', () => {
    const note = showNote ? document.getElementById('modal-note').value.trim() : undefined;
    cleanup();
    onConfirm(note);
  });
  document.getElementById('modal-cancel').addEventListener('click', cleanup);
}

// ── Drawer ─────────────────────────────────────────────────────────
function openDrawer(title, bodyHtml) {
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer-body').innerHTML = bodyHtml;
  document.getElementById('drawer').classList.remove('hidden');
  document.getElementById('drawer-overlay').classList.remove('hidden');
}

function closeDrawer() {
  document.getElementById('drawer').classList.add('hidden');
  document.getElementById('drawer-overlay').classList.add('hidden');
}

document.getElementById('drawer-close').addEventListener('click', closeDrawer);
document.getElementById('drawer-overlay').addEventListener('click', closeDrawer);

// ── Auth ───────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  initGoogleSignIn();
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
  if (typeof window.mountSveltePanels === 'function') window.mountSveltePanels();
}

// Returns a promise that resolves once window.google is available (GIS script loaded).
// Gives up after 8 seconds to avoid hanging indefinitely.
function waitForGoogle() {
  return new Promise((resolve, reject) => {
    if (window.google) { resolve(); return; }
    const start = Date.now();
    const t = setInterval(() => {
      if (window.google) { clearInterval(t); resolve(); }
      else if (Date.now() - start > 8000) { clearInterval(t); reject(new Error('Google script timeout')); }
    }, 50);
  });
}

let _googleInitialized = false;

async function initGoogleSignIn() {
  if (_googleInitialized) return;
  _googleInitialized = true;

  try {
    console.log('[Auth] Fetching /auth/config...');
    const res = await fetch('/auth/config');
    if (!res.ok) throw new Error(`Config endpoint failed: ${res.status}`);
    const { clientId } = await res.json();
    console.log('[Auth] clientId received:', clientId ? clientId.slice(0, 20) + '...' : 'MISSING');

    if (!clientId) {
      showLoginError('Auth not configured — GOOGLE_CLIENT_ID missing on server.');
      return;
    }

    console.log('[Auth] Waiting for Google GIS script...');
    await waitForGoogle();
    console.log('[Auth] Google GIS script loaded. Initializing...');

    google.accounts.id.initialize({
      client_id:             clientId,
      callback:              handleGoogleCredential,
      auto_select:           false,
      cancel_on_tap_outside: true,
      error_callback:        (err) => {
        console.error('[Auth] GIS error_callback:', JSON.stringify(err));
        // If button renderer fails due to origin, show manual fallback button
        if (err && err.type === 'unknown') {
          showGoogleFallbackButton(clientId);
        }
      },
    });

    console.log('[Auth] Rendering Google button...');
    const btnEl = document.getElementById('google-signin-btn');
    google.accounts.id.renderButton(btnEl, {
      theme: 'outline', size: 'large', text: 'sign_in_with', width: 288
    });

    // If the button iframe fails to render (origin blocked), show fallback after 2s
    setTimeout(() => {
      const iframe = btnEl.querySelector('iframe');
      if (!iframe) {
        console.warn('[Auth] Google button iframe not rendered — showing fallback');
        showGoogleFallbackButton(clientId);
      } else {
        console.log('[Auth] Google button iframe rendered successfully');
      }
    }, 2000);

  } catch (err) {
    console.error('[Admin] Google Sign-In init failed:', err.message);
    showLoginError('Failed to load sign-in. Refresh and try again.');
    _googleInitialized = false;
  }
}

// Fallback: use Google OAuth redirect flow when GIS button is blocked by origin
function showGoogleFallbackButton(clientId) {
  const btnEl = document.getElementById('google-signin-btn');
  if (btnEl.querySelector('.fallback-signin-btn')) return; // already shown
  btnEl.innerHTML = '';
  const btn = document.createElement('button');
  btn.className = 'btn btn-accent fallback-signin-btn';
  btn.style = 'width:288px;padding:10px 16px;font-size:14px;';
  btn.textContent = 'Sign in with Google';
  btn.addEventListener('click', () => {
    const redirectUri = encodeURIComponent(window.location.origin + '/auth/google/callback');
    const scope = encodeURIComponent('openid email profile');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&access_type=offline&prompt=select_account`;
    console.log('[Auth] Redirecting to Google OAuth...');
    window.location.href = url;
  });
  btnEl.appendChild(btn);
  console.log('[Auth] Fallback button rendered');
}

async function handleGoogleCredential(response) {
  hideLoginError();
  try {
    const res = await fetch('/auth/google', {
      method:      'POST',
      credentials: 'include',
      headers:     { 'Content-Type': 'application/json' },
      body:        JSON.stringify({ credential: response.credential }),
    });

    if (res.ok) {
      showDashboard();
      initDashboard();
    } else {
      const json = await res.json().catch(() => ({}));
      showLoginError(
        json.error === 'Access denied'
          ? 'Access denied — use your authorized Google account.'
          : 'Sign-in failed. Try again.'
      );
    }
  } catch {
    showLoginError('Network error. Try again.');
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function hideLoginError() {
  document.getElementById('login-error').classList.add('hidden');
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  stopPolling();
  showLogin();
});

// ── Panel Navigation ───────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    const panel = btn.dataset.panel;
    switchPanel(panel);
  });
});

function switchPanel(panel) {
  state.currentPanel = panel;

  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-item[data-panel="${panel}"]`).classList.add('active');

  document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
  document.getElementById(`panel-${panel}`).classList.remove('hidden');

  if (panel === 'errors')     loadErrors();
  if (panel === 'webhooks')   startWebhookPolling();
  if (panel === 'queue')      startQueuePolling();
  if (panel === 'clients')    loadClients();
  if (panel === 'membersync') initMemberSync();
}

// ── Dashboard Init ─────────────────────────────────────────────────
async function initDashboard() {
  try {
    const res = await apiFetch('/admin/errors?limit=1');
    if (!res.ok) return;
    loadErrors();
    startQueuePolling(); // background — so queue badge can update
  } catch { /* redirect already handled by apiFetch */ }
}

// ══ ERROR QUEUE PANEL — migrated to Svelte (ErrorQueuePanel.svelte) ══
// Panel content is now rendered by admin/svelte/panels/ErrorQueuePanel.svelte.
// loadErrors() stub kept so switchPanel() / initDashboard() calls safely.

function loadErrors() {
  // No-op — ErrorQueuePanel.svelte owns its own data loading via onMount.
}

function updateNavBadge(panel, count) {
  // Kept for any remaining callers. ErrorQueuePanel.svelte manages the errors badge directly.
  const badge = document.getElementById(`nav-${panel}-badge`);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ══ DEBUG CENTER PANEL — migrated to Svelte (DebugCenterPanel.svelte) ══

// ══ WEBHOOK INSPECTOR PANEL — migrated to Svelte (WebhookPanel.svelte) ══
// Panel content is now rendered by admin/svelte/panels/WebhookPanel.svelte.
// startWebhookPolling() stub kept so switchPanel() still calls it safely.

function startWebhookPolling() {
  // No-op — WebhookPanel.svelte owns its own polling via onMount/onDestroy.
}

// ══ QUEUE MONITOR PANEL — migrated to Svelte (QueuePanel.svelte) ═════
// Panel content is now rendered by admin/svelte/panels/QueuePanel.svelte.
// startQueuePolling() stub kept so switchPanel() still calls it safely.

function startQueuePolling() {
  // No-op — QueuePanel.svelte owns its own polling via onMount/onDestroy.
}

// ══ CLIENTS PANEL — migrated to Svelte (ClientsPanel.svelte) ══════════
// Panel content is now rendered by admin/svelte/panels/ClientsPanel.svelte.
// loadClients() stub kept so switchPanel() calls it safely.

function loadClients() {
  // No-op — ClientsPanel.svelte owns its own data loading via onMount.
}

// ══ MEMBER SYNC PANEL — migrated to Svelte (MemberSyncPanel.svelte) ══
// Panel content is now rendered by admin/svelte/panels/MemberSyncPanel.svelte.
// initMemberSync() stub kept so switchPanel() calls it safely.

function initMemberSync() {
  // No-op — MemberSyncPanel.svelte owns its own data loading via onMount.
}

// ── Stop all polling ────────────────────────────────────────────────
function stopPolling() {
  // Both webhook and queue polling now managed by Svelte panels via onDestroy.
}

// ── App Start ──────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/auth/check', { credentials: 'include' });
    if (res.ok) {
      showDashboard();
      initDashboard();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
