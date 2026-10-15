/**
 * admin/public/app.js
 * AccessSync Owner dashboard — shell logic.
 *
 * Owns: login (Google OAuth redirect + PIN), the sidebar, which panel is visible, and deep links
 * (?panel=<name>, ?openTrace=<uuid>). Panel content is Svelte (admin/svelte/main.js) except Trace
 * Timeline, a React island (logs-app.jsx). Panels mount on first open; nothing polls while hidden.
 */

'use strict';

const PANEL_NAMES = ['hub', 'errors', 'members', 'gyms', 'logs'];

// ── Auth ───────────────────────────────────────────────────────────
function showLogin() {
  document.getElementById('dashboard').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
  initGoogleSignIn();
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
}

let _googleInitialized = false;

async function initGoogleSignIn() {
  if (_googleInitialized) return;
  _googleInitialized = true;
  try {
    const res = await fetch('/auth/config');
    if (!res.ok) throw new Error(`Config endpoint failed: ${res.status}`);
    const { clientId } = await res.json();
    if (!clientId) {
      showLoginError('Auth not configured — GOOGLE_CLIENT_ID missing on server.');
      return;
    }
    // OAuth redirect flow — the GIS popup flow breaks with FedCM.
    const btnEl = document.getElementById('google-signin-btn');
    if (btnEl.querySelector('.fallback-signin-btn')) return;
    btnEl.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn btn-accent fallback-signin-btn';
    btn.style = 'width:288px;padding:10px 16px;font-size:14px;';
    btn.textContent = 'Sign in with Google';
    btn.addEventListener('click', () => {
      const redirectUri = encodeURIComponent(window.location.origin + '/auth/google/callback');
      const scope = encodeURIComponent('openid email profile');
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}&prompt=select_account`;
    });
    btnEl.appendChild(btn);
  } catch (err) {
    console.error('[Owner] Google Sign-In init failed:', err.message);
    showLoginError('Failed to load sign-in. Refresh and try again.');
    _googleInitialized = false;
  }
}

function showLoginError(msg) {
  const el = document.getElementById('login-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function submitPin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (!pin) return;
  document.getElementById('login-error').classList.add('hidden');
  try {
    const res = await fetch('/auth/pin', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    if (res.ok) {
      document.getElementById('pin-input').value = '';
      showDashboard();
      initDashboard();
    } else {
      const json = await res.json().catch(() => ({}));
      showLoginError(json.error === 'Invalid PIN' ? 'Incorrect PIN.' : (json.error || 'Sign-in failed. Try again.'));
    }
  } catch {
    showLoginError('Network error. Try again.');
  }
}

document.getElementById('pin-submit').addEventListener('click', submitPin);
document.getElementById('pin-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST', credentials: 'include' });
  window.location.href = '/OwnerDashboard';
});

// ── Panel navigation ───────────────────────────────────────────────
document.querySelectorAll('.nav-item[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => switchPanel(btn.dataset.panel, true));
});

function switchPanel(panel, pushUrl) {
  if (!PANEL_NAMES.includes(panel)) panel = 'hub';
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.panel === panel));
  document.querySelectorAll('.panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${panel}`));
  if (typeof window.mountSveltePanel === 'function') window.mountSveltePanel(panel);
  window.dispatchEvent(new CustomEvent('panel:shown', { detail: panel }));
  if (pushUrl) {
    const url = new URL(window.location.href);
    url.searchParams.set('panel', panel);
    url.searchParams.delete('openTrace');
    history.replaceState(null, '', url.pathname + url.search);
  }
}

async function initDashboard() {
  const params = new URLSearchParams(window.location.search);
  // ?openTrace=<uuid> jumps to the Trace Timeline; the React island reads the same param.
  const panel = params.get('openTrace') ? 'logs' : (params.get('panel') || 'hub');
  switchPanel(panel, false);
}

// A 401 from any panel means the session ended: back to login.
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason && e.reason.message === 'Unauthorized') { e.preventDefault(); showLogin(); }
});

// ── App start ──────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/auth/check', { credentials: 'include' });
    if (res.ok) { showDashboard(); initDashboard(); }
    else showLogin();
  } catch {
    showLogin();
  }
})();
