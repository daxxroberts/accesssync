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
    const res = await fetch('/auth/config');
    if (!res.ok) throw new Error('Config endpoint failed');
    const { clientId } = await res.json();

    if (!clientId) {
      showLoginError('Auth not configured — GOOGLE_CLIENT_ID missing on server.');
      return;
    }

    await waitForGoogle();

    google.accounts.id.initialize({
      client_id:             clientId,
      callback:              handleGoogleCredential,
      auto_select:           false,
      cancel_on_tap_outside: true,
    });

    google.accounts.id.renderButton(
      document.getElementById('google-signin-btn'),
      { theme: 'outline', size: 'large', text: 'sign_in_with', width: 288 }
    );

  } catch (err) {
    console.error('[Admin] Google Sign-In init failed:', err.message);
    showLoginError('Failed to load sign-in. Refresh and try again.');
    _googleInitialized = false; // allow retry on next showLogin()
  }
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

// ══ ERROR QUEUE PANEL ═══════════════════════════════════════════════

async function loadErrors() {
  const { status, limit, offset } = state.errors;

  document.getElementById('errors-loading').classList.remove('hidden');
  document.getElementById('errors-table-wrap').classList.add('hidden');
  document.getElementById('errors-empty').classList.add('hidden');
  document.getElementById('errors-pagination').classList.add('hidden');

  try {
    const params = new URLSearchParams({ status, limit, offset });
    const res = await apiFetch(`/admin/errors?${params}`);
    const json = await res.json();

    state.errors.data = json.data || [];
    state.errors.total = json.total || 0;

    renderErrors();
  } catch (err) {
    if (err.message !== 'Unauthorized') toast('Failed to load errors', 'error');
  } finally {
    document.getElementById('errors-loading').classList.add('hidden');
  }
}

function renderErrors() {
  const { data, total, limit, offset } = state.errors;
  const tbody = document.getElementById('errors-tbody');

  if (!data.length) {
    document.getElementById('errors-empty').classList.remove('hidden');
    document.getElementById('errors-table-wrap').classList.add('hidden');
    updateNavBadge('errors', 0);
    return;
  }

  const failedCount = data.filter(r => r.status === 'failed').length;
  updateNavBadge('errors', failedCount);

  tbody.innerHTML = data.map(row => `
    <tr data-id="${row.id}" class="clickable-row">
      <td class="col-check"><input type="checkbox" class="error-check" data-id="${row.id}" ${state.errors.selected.has(row.id) ? 'checked' : ''} /></td>
      <td>${esc(row.client_name) || '<span class="muted">Unknown</span>'}</td>
      <td>
        <div>${esc(row.member_display_name) || '<span class="muted">—</span>'}</div>
        <div class="cell-sub">${esc(row.member_email) || ''}</div>
      </td>
      <td><code class="code-sm">${esc(row.event_type)}</code></td>
      <td class="reason-cell" title="${esc(row.error_reason)}">${esc(row.error_reason) || '—'}</td>
      <td>${pill(row.status)}</td>
      <td><span title="${esc(row.created_at)}">${fmt(row.created_at)}</span></td>
      <td class="actions-cell" onclick="event.stopPropagation()">
        ${row.status === 'failed' ? `
          <button class="btn btn-sm btn-accent" onclick="retryError('${row.id}')">Retry</button>
          <button class="btn btn-sm btn-secondary" onclick="dismissError('${row.id}')">Dismiss</button>
        ` : `<span class="muted">—</span>`}
      </td>
    </tr>
  `).join('');

  // Row click → drawer detail
  tbody.querySelectorAll('.clickable-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.actions-cell, input[type="checkbox"]')) return;
      const id = row.dataset.id;
      openErrorDetail(id);
    });
  });

  // Checkboxes
  tbody.querySelectorAll('.error-check').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.errors.selected.add(cb.dataset.id);
      else state.errors.selected.delete(cb.dataset.id);
      updateBulkRetryBtn();
    });
  });

  document.getElementById('errors-table-wrap').classList.remove('hidden');

  // Pagination
  const pageInfo = document.getElementById('errors-page-info');
  const start = offset + 1;
  const end = Math.min(offset + limit, total);
  pageInfo.textContent = `${start}–${end} of ${total}`;
  document.getElementById('errors-prev-btn').disabled = offset === 0;
  document.getElementById('errors-next-btn').disabled = offset + limit >= total;
  document.getElementById('errors-pagination').classList.remove('hidden');
}

function updateNavBadge(panel, count) {
  const badge = document.getElementById(`nav-${panel}-badge`);
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function updateBulkRetryBtn() {
  const btn = document.getElementById('errors-bulk-retry-btn');
  btn.disabled = state.errors.selected.size === 0;
  btn.textContent = state.errors.selected.size > 0
    ? `Retry Selected (${state.errors.selected.size})`
    : 'Retry Selected';
}

async function openErrorDetail(id) {
  openDrawer('Error Detail', '<div class="loading-state">Loading...</div>');
  try {
    const res = await apiFetch(`/admin/errors/${id}`);
    const row = await res.json();
    openDrawer('Error Detail', renderErrorDetail(row));
  } catch {
    openDrawer('Error Detail', '<div class="error-state">Failed to load detail</div>');
  }
}

function renderErrorDetail(row) {
  return `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Status</span>${pill(row.status)}</div>
      <div class="detail-row"><span class="detail-label">Client</span><span>${esc(row.client_name) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Member</span><span>${esc(row.member_display_name) || '—'} ${row.member_email ? `<span class="muted">(${esc(row.member_email)})</span>` : ''}</span></div>
      <div class="detail-row"><span class="detail-label">Platform ID</span><code>${esc(row.platform_member_id) || '—'}</code></div>
      <div class="detail-row"><span class="detail-label">Event Type</span><code>${esc(row.event_type)}</code></div>
      <div class="detail-row"><span class="detail-label">Attempts</span><span>${row.retry_count ?? '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Error Reason</span><span class="reason-text">${esc(row.error_reason) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Created</span><span>${fmt(row.created_at)}</span></div>
      ${row.resolved_at ? `<div class="detail-row"><span class="detail-label">Resolved</span><span>${fmt(row.resolved_at)}</span></div>` : ''}
      ${row.dismiss_note ? `<div class="detail-row"><span class="detail-label">Note</span><span>${esc(row.dismiss_note)}</span></div>` : ''}
    </div>
    ${row.payload ? `
      <div class="detail-section">
        <div class="detail-section-title">Payload</div>
        <pre class="code-block">${esc(JSON.stringify(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload, null, 2))}</pre>
      </div>
    ` : ''}
    ${row.status === 'failed' ? `
      <div class="drawer-footer-actions">
        <button class="btn btn-accent" onclick="retryError('${row.id}')">Retry Job</button>
        <button class="btn btn-secondary" onclick="dismissError('${row.id}')">Dismiss</button>
      </div>
    ` : ''}
  `;
}

async function retryError(id) {
  showModal({
    title: 'Retry Job',
    body: 'Re-queue this job to BullMQ? The error will be marked as resolved.',
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/admin/errors/${id}/retry`, { method: 'POST' });
        if (res.ok) {
          toast('Job re-queued successfully', 'success');
          closeDrawer();
          loadErrors();
        } else {
          const j = await res.json();
          toast(`Retry failed: ${j.error}`, 'error');
        }
      } catch {
        toast('Retry failed', 'error');
      }
    },
  });
}

async function dismissError(id) {
  showModal({
    title: 'Dismiss Error',
    body: 'Mark this error as resolved? You can add an optional note.',
    showNote: true,
    onConfirm: async (note) => {
      try {
        const res = await apiFetch(`/admin/errors/${id}/dismiss`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        });
        if (res.ok) {
          toast('Error dismissed', 'success');
          closeDrawer();
          loadErrors();
        } else {
          const j = await res.json();
          toast(`Dismiss failed: ${j.error}`, 'error');
        }
      } catch {
        toast('Dismiss failed', 'error');
      }
    },
  });
}

// Bulk retry
document.getElementById('errors-bulk-retry-btn').addEventListener('click', () => {
  const ids = Array.from(state.errors.selected);
  if (!ids.length) return;
  showModal({
    title: 'Bulk Retry',
    body: `Re-queue ${ids.length} selected job(s)? All will be marked as resolved.`,
    onConfirm: async () => {
      try {
        const res = await apiFetch('/admin/errors/bulk-retry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        const json = await res.json();
        toast(`Queued: ${json.queued}, Failed: ${json.failed}`, json.failed ? 'warning' : 'success');
        state.errors.selected.clear();
        updateBulkRetryBtn();
        loadErrors();
      } catch {
        toast('Bulk retry failed', 'error');
      }
    },
  });
});

// Select all
document.getElementById('errors-select-all').addEventListener('change', (e) => {
  const checks = document.querySelectorAll('.error-check');
  checks.forEach(cb => {
    cb.checked = e.target.checked;
    if (e.target.checked) state.errors.selected.add(cb.dataset.id);
    else state.errors.selected.delete(cb.dataset.id);
  });
  updateBulkRetryBtn();
});

// Refresh
document.getElementById('errors-refresh-btn').addEventListener('click', () => loadErrors());

// Status filter
document.getElementById('errors-status-filter').addEventListener('change', (e) => {
  state.errors.status = e.target.value;
  state.errors.offset = 0;
  state.errors.selected.clear();
  loadErrors();
});

// Pagination
document.getElementById('errors-prev-btn').addEventListener('click', () => {
  state.errors.offset = Math.max(0, state.errors.offset - state.errors.limit);
  loadErrors();
});
document.getElementById('errors-next-btn').addEventListener('click', () => {
  state.errors.offset += state.errors.limit;
  loadErrors();
});

// ══ DEBUG CENTER PANEL ═══════════════════════════════════════════════

const searchInput = document.getElementById('members-search');
searchInput.addEventListener('input', () => {
  clearTimeout(state.members.searchTimer);
  state.members.searchTimer = setTimeout(doMemberSearch, 300);
});

async function doMemberSearch() {
  const q = searchInput.value.trim();
  const loadingEl = document.getElementById('members-loading');
  const emptyEl   = document.getElementById('members-empty');
  const tableWrap = document.getElementById('members-table-wrap');

  if (!q) {
    loadingEl.classList.add('hidden');
    tableWrap.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    emptyEl.querySelector('p').textContent = 'Enter a search term to find members';
    return;
  }

  loadingEl.classList.remove('hidden');
  tableWrap.classList.add('hidden');
  emptyEl.classList.add('hidden');

  try {
    const res = await apiFetch(`/admin/members/search?q=${encodeURIComponent(q)}`);
    const json = await res.json();
    const data = json.data || [];

    if (!data.length) {
      emptyEl.querySelector('p').textContent = `No members found for "${q}"`;
      emptyEl.classList.remove('hidden');
    } else {
      renderMembers(data);
      tableWrap.classList.remove('hidden');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') toast('Search failed', 'error');
  } finally {
    loadingEl.classList.add('hidden');
  }
}

function renderMembers(data) {
  const tbody = document.getElementById('members-tbody');
  tbody.innerHTML = data.map(m => `
    <tr>
      <td>
        <div>${esc(m.display_name) || '<span class="muted">No name</span>'}</div>
        <div class="cell-sub">${esc(m.email) || '<span class="muted">No email</span>'}</div>
        <div class="cell-sub"><code>${esc(m.platform_member_id)}</code></div>
      </td>
      <td>${esc(m.client_name) || '—'}</td>
      <td>
        <div>${esc(m.source_platform)}</div>
        <div class="cell-sub">${esc(m.hardware_platform)}</div>
      </td>
      <td>${pill(m.access_status || 'unknown')}</td>
      <td><span title="${esc(m.updated_at)}">${fmt(m.updated_at)}</span></td>
      <td class="actions-cell">
        <button class="btn btn-sm btn-secondary" onclick="openMemberTimeline('${m.id}', '${esc(m.display_name || m.platform_member_id)}')">Timeline</button>
        <button class="btn btn-sm btn-accent" onclick="retryMember('${m.id}')">Retry</button>
      </td>
    </tr>
  `).join('');
}

async function openMemberTimeline(id, name) {
  openDrawer(`Timeline: ${name}`, '<div class="loading-state">Loading timeline...</div>');
  try {
    const res = await apiFetch(`/admin/members/${id}/timeline`);
    const json = await res.json();
    openDrawer(`Timeline: ${name}`, renderTimeline(json));
  } catch {
    openDrawer(`Timeline: ${name}`, '<div class="error-state">Failed to load timeline</div>');
  }
}

function renderTimeline({ member, timeline }) {
  const memberSection = `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Client</span><span>${esc(member.client_name) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access Status</span>${pill(member.access_status || 'unknown')}</div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>${esc(member.source_platform)} / ${esc(member.hardware_platform)}</span></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><span>${fmt(member.provisioned_at)}</span></div>
    </div>
  `;

  if (!timeline || !timeline.length) {
    return memberSection + '<div class="empty-state"><p>No timeline events found</p></div>';
  }

  const rows = timeline.map(ev => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-content">
        <div class="timeline-header">
          <code class="code-sm">${esc(ev.event_type)}</code>
          <span class="pill pill-muted">${esc(ev.source)}</span>
          <span class="timeline-time">${fmt(ev.created_at)}</span>
        </div>
        ${ev.detail ? `<div class="timeline-detail">${esc(ev.detail)}</div>` : ''}
      </div>
    </div>
  `).join('');

  return memberSection + `<div class="detail-section"><div class="detail-section-title">Event History</div><div class="timeline">${rows}</div></div>`;
}

async function retryMember(id) {
  showModal({
    title: 'Retry Member',
    body: 'Re-queue the latest failed job for this member?',
    onConfirm: async () => {
      try {
        const res = await apiFetch(`/admin/members/${id}/retry`, { method: 'POST' });
        const json = await res.json();
        if (res.ok) {
          toast(`Queued: ${json.queued}`, 'success');
        } else {
          toast(`Retry failed: ${json.error}`, 'error');
        }
      } catch {
        toast('Retry failed', 'error');
      }
    },
  });
}

// ══ WEBHOOK INSPECTOR PANEL ══════════════════════════════════════════

function startWebhookPolling() {
  if (!state.webhooks.data.length) loadWebhooksInitial();
  clearInterval(state.webhooks.pollTimer);
  if (state.webhooks.polling) {
    state.webhooks.pollTimer = setInterval(pollWebhooks, 10000);
  }
}

async function loadWebhooksInitial() {
  document.getElementById('webhooks-loading').classList.remove('hidden');
  document.getElementById('webhooks-table-wrap').classList.add('hidden');
  document.getElementById('webhooks-empty').classList.add('hidden');

  try {
    const res = await apiFetch('/admin/webhooks/recent?limit=50');
    const json = await res.json();
    state.webhooks.data = json.data || [];
    if (state.webhooks.data.length) {
      state.webhooks.lastTimestamp = state.webhooks.data[0].received_at;
    }
    renderWebhooks();
  } catch (err) {
    if (err.message !== 'Unauthorized') toast('Failed to load webhooks', 'error');
  } finally {
    document.getElementById('webhooks-loading').classList.add('hidden');
  }
}

async function pollWebhooks() {
  if (!state.webhooks.polling) return;
  try {
    const params = state.webhooks.lastTimestamp
      ? `?since=${encodeURIComponent(state.webhooks.lastTimestamp)}&limit=50`
      : '?limit=50';
    const res = await apiFetch(`/admin/webhooks/recent${params}`);
    const json = await res.json();
    const newRows = json.data || [];
    if (newRows.length) {
      state.webhooks.data = [...newRows, ...state.webhooks.data].slice(0, 200);
      state.webhooks.lastTimestamp = state.webhooks.data[0].received_at;
      renderWebhooks();
    }
  } catch { /* silent poll failure */ }
}

function renderWebhooks() {
  const tbody = document.getElementById('webhooks-tbody');
  const data = state.webhooks.data;

  if (!data.length) {
    document.getElementById('webhooks-empty').classList.remove('hidden');
    document.getElementById('webhooks-table-wrap').classList.add('hidden');
    return;
  }

  tbody.innerHTML = data.map(row => `
    <tr class="clickable-row" data-id="${row.id}" onclick="openWebhookDetail('${row.id}')">
      <td><span title="${esc(row.received_at)}">${fmt(row.received_at)}</span></td>
      <td>${esc(row.client_name) || '<span class="muted">—</span>'}</td>
      <td>${row.event_type ? `<code class="code-sm">${esc(row.event_type)}</code>` : '<span class="muted">—</span>'}</td>
      <td>${pill(row.hmac_status)}</td>
      <td>${row.dedup_status ? pill(row.dedup_status) : '<span class="muted">—</span>'}</td>
      <td class="reason-cell" title="${esc(row.error_detail)}">${esc(row.error_detail) || '<span class="muted">—</span>'}</td>
    </tr>
  `).join('');

  document.getElementById('webhooks-table-wrap').classList.remove('hidden');
  document.getElementById('webhooks-empty').classList.add('hidden');
}

async function openWebhookDetail(id) {
  openDrawer('Webhook Detail', '<div class="loading-state">Loading...</div>');
  try {
    const res = await apiFetch(`/admin/webhooks/${id}`);
    const row = await res.json();
    openDrawer('Webhook Detail', renderWebhookDetail(row));
  } catch {
    openDrawer('Webhook Detail', '<div class="error-state">Failed to load detail</div>');
  }
}

function renderWebhookDetail(row) {
  return `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Received</span><span>${fmt(row.received_at)}</span></div>
      <div class="detail-row"><span class="detail-label">Client</span><span>${esc(row.client_name) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Event ID</span><code>${esc(row.event_id) || '—'}</code></div>
      <div class="detail-row"><span class="detail-label">Event Type</span><code>${esc(row.event_type) || '—'}</code></div>
      <div class="detail-row"><span class="detail-label">HMAC Status</span>${pill(row.hmac_status)}</div>
      <div class="detail-row"><span class="detail-label">Dedup Status</span>${row.dedup_status ? pill(row.dedup_status) : '<span class="muted">—</span>'}</div>
      ${row.error_detail ? `<div class="detail-row"><span class="detail-label">Error</span><span class="danger">${esc(row.error_detail)}</span></div>` : ''}
    </div>
    ${row.raw_payload ? `
      <div class="detail-section">
        <div class="detail-section-title">Raw Payload</div>
        <pre class="code-block">${esc(JSON.stringify(row.raw_payload, null, 2))}</pre>
      </div>
    ` : ''}
    ${row.normalized_payload ? `
      <div class="detail-section">
        <div class="detail-section-title">Normalized Payload</div>
        <pre class="code-block">${esc(JSON.stringify(row.normalized_payload, null, 2))}</pre>
      </div>
    ` : ''}
  `;
}

// Pause/resume polling
document.getElementById('webhooks-pause-btn').addEventListener('click', () => {
  const btn = document.getElementById('webhooks-pause-btn');
  const dot = document.querySelector('#webhooks-poll-indicator .poll-dot');
  if (state.webhooks.polling) {
    state.webhooks.polling = false;
    clearInterval(state.webhooks.pollTimer);
    btn.textContent = 'Resume';
    dot.classList.add('paused');
  } else {
    state.webhooks.polling = true;
    startWebhookPolling();
    btn.textContent = 'Pause';
    dot.classList.remove('paused');
  }
});

// ══ QUEUE MONITOR PANEL ══════════════════════════════════════════════

function startQueuePolling() {
  loadQueueCounts();
  clearInterval(state.queue.pollTimer);
  state.queue.pollTimer = setInterval(loadQueueCounts, 5000);
  loadQueueJobs(state.queue.currentTab);
}

async function loadQueueCounts() {
  try {
    const res = await apiFetch('/admin/queue/counts');
    const counts = await res.json();
    state.queue.counts = counts;
    renderQueueCounts(counts);

    // Update nav badge with failed count
    if (state.currentPanel !== 'errors') {
      updateNavBadge('errors', counts.failed || 0);
    }
  } catch { /* silent */ }
}

function renderQueueCounts(counts) {
  const ids = ['waiting', 'active', 'completed', 'failed', 'delayed', 'paused'];
  ids.forEach(key => {
    const el = document.getElementById(`stat-${key}`);
    if (el) el.textContent = counts[key] ?? '0';
  });
}

async function loadQueueJobs(queueState) {
  state.queue.currentTab = queueState;

  document.querySelectorAll('.queue-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.state === queueState);
  });

  const loadingEl  = document.getElementById('queue-jobs-loading');
  const emptyEl    = document.getElementById('queue-jobs-empty');
  const tableWrap  = document.getElementById('queue-jobs-table-wrap');

  loadingEl.classList.remove('hidden');
  tableWrap.classList.add('hidden');
  emptyEl.classList.add('hidden');

  try {
    const res = await apiFetch(`/admin/queue/jobs?state=${queueState}`);
    const json = await res.json();
    const jobs = json.data || [];

    if (!jobs.length) {
      emptyEl.classList.remove('hidden');
    } else {
      renderQueueJobs(jobs);
      tableWrap.classList.remove('hidden');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') toast('Failed to load jobs', 'error');
  } finally {
    loadingEl.classList.add('hidden');
  }
}

function renderQueueJobs(jobs) {
  const tbody = document.getElementById('queue-jobs-tbody');
  tbody.innerHTML = jobs.map(j => `
    <tr>
      <td><code class="code-sm">${esc(String(j.id).slice(0, 20))}…</code></td>
      <td>${pill(j.name)}</td>
      <td><code class="code-sm">${esc(j.tenantId) || '—'}</code></td>
      <td>${j.eventType ? `<code class="code-sm">${esc(j.eventType)}</code>` : '—'}</td>
      <td><code class="code-sm">${esc(j.memberId) || '—'}</code></td>
      <td>${j.attemptsMade ?? '—'}</td>
      <td>${fmt(j.processedOn ? new Date(j.processedOn).toISOString() : null)}</td>
      <td class="reason-cell" title="${esc(j.failedReason)}">${esc(j.failedReason) || '—'}</td>
    </tr>
  `).join('');
}

// Queue tabs
document.querySelectorAll('.queue-tab').forEach(tab => {
  tab.addEventListener('click', () => loadQueueJobs(tab.dataset.state));
});

// ══ CLIENTS PANEL ═════════════════════════════════════════════════════

async function loadClients() {
  document.getElementById('clients-loading').classList.remove('hidden');
  document.getElementById('clients-table-wrap').classList.add('hidden');
  document.getElementById('clients-empty').classList.add('hidden');

  try {
    const res  = await apiFetch('/admin/clients');
    const json = await res.json();
    const data = json.data || [];

    if (!data.length) {
      document.getElementById('clients-empty').classList.remove('hidden');
    } else {
      renderClients(data);
      document.getElementById('clients-table-wrap').classList.remove('hidden');
    }
  } catch (err) {
    if (err.message !== 'Unauthorized') toast('Failed to load clients', 'error');
  } finally {
    document.getElementById('clients-loading').classList.add('hidden');
  }
}

function renderClients(data) {
  const tbody = document.getElementById('clients-tbody');
  tbody.innerHTML = data.map(c => `
    <tr class="clickable-row" onclick="openClientDetail('${c.id}')">
      <td>
        <div>${esc(c.name)}</div>
        ${c.site_name ? `<div class="cell-sub">${esc(c.site_name)}</div>` : ''}
        ${c.site_id   ? `<div class="cell-sub"><code>${esc(c.site_id)}</code></div>` : ''}
      </td>
      <td>${c.platform ? `<span class="pill pill-info">${esc(c.platform)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${c.hardware_platform ? `<span class="pill pill-muted">${esc(c.hardware_platform)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${c.tier || '<span class="muted">—</span>'}</td>
      <td>
        <span title="${c.active_count} active">${c.member_count} total</span>
        ${c.active_count > 0 ? `<span class="cell-sub">${c.active_count} active</span>` : ''}
      </td>
      <td>${pill(c.status || 'active')}</td>
      <td><span title="${esc(c.last_sync_at)}">${fmt(c.last_sync_at)}</span></td>
      <td class="actions-cell" onclick="event.stopPropagation()">
        <button class="btn btn-sm btn-secondary" onclick="openClientEdit('${c.id}')">Edit</button>
        <button class="btn btn-sm btn-accent" onclick="openOperatorDashboard('${c.id}', '${esc(c.name)}')">Dashboard</button>
      </td>
    </tr>
  `).join('');
}

function openClientDetail(id) {
  Promise.all([
    apiFetch('/admin/clients').then(r => r.json()),
    apiFetch(`/admin/clients/${id}/api-key/status`).then(r => r.json()).catch(() => ({ hasKey: null })),
  ]).then(([json, keyStatus]) => {
    const c = (json.data || []).find(x => x.id === id);
    if (!c) return;
    openDrawer(`Client: ${c.name}`, renderClientDetail(c, keyStatus.hasKey));
  }).catch(() => {});
}

function renderClientDetail(c, hasKey) {
  const keyLabel = hasKey === true ? '••••••••' : (hasKey === false ? 'Not set' : '—');
  const keyLabelClass = hasKey === false ? 'style="opacity:0.5"' : '';
  const keyBtnLabel = hasKey ? 'Rotate Key' : 'Set Key';
  return `
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Name</span><span>${esc(c.name)}</span></div>
      <div class="detail-row"><span class="detail-label">Status</span>${pill(c.status || 'active')}</div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>${esc(c.platform) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Hardware</span><span>${esc(c.hardware_platform) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Tier</span><span>${esc(c.tier) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Site ID</span><code>${esc(c.site_id) || '—'}</code></div>
      <div class="detail-row"><span class="detail-label">Site Name</span><span>${esc(c.site_name) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Notification Email</span><span>${esc(c.notification_email) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Members</span><span>${c.member_count} total, ${c.active_count} active</span></div>
      <div class="detail-row"><span class="detail-label">Last Sync</span><span>${fmt(c.last_sync_at)}</span></div>
      <div class="detail-row"><span class="detail-label">Created</span><span>${fmt(c.created_at)}</span></div>
      <div class="detail-row">
        <span class="detail-label">Kisi API Key</span>
        <span ${keyLabelClass}>${keyLabel}</span>
        <button class="btn btn-sm btn-secondary" style="margin-left:auto" onclick="openApiKeyForm('${c.id}', '${esc(c.name)}')">${keyBtnLabel}</button>
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" onclick="openClientEdit('${c.id}')">Edit Client</button>
      <button class="btn btn-accent" onclick="openOperatorDashboard('${c.id}', '${esc(c.name)}')">Open Dashboard</button>
    </div>
  `;
}

function openApiKeyForm(clientId, clientName) {
  openDrawer(`API Key: ${clientName}`, `
    <div class="detail-section">
      <p style="font-size:0.85rem;color:var(--neutral-500);margin-bottom:1rem;">
        Write-only. Once saved, the key cannot be viewed — only rotated. The key is encrypted at rest (AES-256-GCM).
      </p>
      <div class="form-field">
        <label>Kisi API Key</label>
        <input type="password" id="api-key-input" class="form-input" placeholder="Paste Kisi API key…" autocomplete="off" />
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" onclick="openClientDetail('${clientId}')">Back</button>
      <button class="btn btn-accent" onclick="saveApiKey('${clientId}')">Save Key</button>
    </div>
  `);
  // Auto-focus the input after the drawer renders
  setTimeout(() => { const el = document.getElementById('api-key-input'); if (el) el.focus(); }, 50);
}

async function saveApiKey(clientId) {
  const input = document.getElementById('api-key-input');
  const key = input ? input.value.trim() : '';
  if (!key) { toast('API key cannot be empty', 'error'); return; }

  try {
    const res = await apiFetch(`/admin/clients/${clientId}/api-key`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ apiKey: key }),
    });
    if (res.ok) {
      toast('API key saved', 'success');
      openClientDetail(clientId); // reload detail with updated key status
    } else {
      const j = await res.json().catch(() => ({}));
      toast(`Save failed: ${j.error || 'unknown error'}`, 'error');
    }
  } catch {
    toast('Save failed', 'error');
  }
}

function openClientEdit(id) {
  apiFetch('/admin/clients').then(r => r.json()).then(json => {
    const c = (json.data || []).find(x => x.id === id);
    if (!c) return;
    openDrawer(`Edit: ${c.name}`, renderClientEditForm(c));
  }).catch(() => {});
}

function renderClientEditForm(c) {
  return `
    <div class="detail-section">
      <div class="form-field">
        <label>Name</label>
        <input type="text" id="edit-name" value="${esc(c.name)}" class="form-input" />
      </div>
      <div class="form-field">
        <label>Hardware Platform</label>
        <select id="edit-hardware_platform" class="form-input">
          <option value="">— Select —</option>
          <option value="kisi"  ${c.hardware_platform === 'kisi'  ? 'selected' : ''}>Kisi</option>
          <option value="seam"  ${c.hardware_platform === 'seam'  ? 'selected' : ''}>Seam</option>
        </select>
      </div>
      <div class="form-field">
        <label>Tier</label>
        <select id="edit-tier" class="form-input">
          <option value="">— Select —</option>
          <option value="Base"    ${c.tier === 'Base'    ? 'selected' : ''}>Base</option>
          <option value="Pro"     ${c.tier === 'Pro'     ? 'selected' : ''}>Pro</option>
          <option value="Connect" ${c.tier === 'Connect' ? 'selected' : ''}>Connect</option>
        </select>
      </div>
      <div class="form-field">
        <label>Site Name</label>
        <input type="text" id="edit-site_name" value="${esc(c.site_name || '')}" class="form-input" />
      </div>
      <div class="form-field">
        <label>Site ID</label>
        <input type="text" id="edit-site_id" value="${esc(c.site_id || '')}" class="form-input" />
      </div>
      <div class="form-field">
        <label>Notification Email</label>
        <input type="email" id="edit-notification_email" value="${esc(c.notification_email || '')}" class="form-input" />
      </div>
      <div class="form-field">
        <label>Status</label>
        <select id="edit-status" class="form-input">
          <option value="active"    ${c.status === 'active'    ? 'selected' : ''}>Active</option>
          <option value="cancelled" ${c.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
        </select>
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" onclick="closeDrawer()">Cancel</button>
      <button class="btn btn-accent" onclick="saveClientEdit('${c.id}')">Save Changes</button>
    </div>
  `;
}

async function saveClientEdit(id) {
  const fields = ['name', 'hardware_platform', 'tier', 'site_name', 'site_id', 'notification_email', 'status'];
  const body = {};
  for (const f of fields) {
    const el = document.getElementById(`edit-${f}`);
    if (el) body[f] = el.value.trim();
  }

  try {
    const res = await apiFetch(`/admin/clients/${id}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (res.ok) {
      toast('Client updated', 'success');
      closeDrawer();
      loadClients();
    } else {
      const j = await res.json();
      toast(`Save failed: ${j.error}`, 'error');
    }
  } catch {
    toast('Save failed', 'error');
  }
}

function openOperatorDashboard(id, name) {
  // Operator Dashboard (FORGE/OB-06) — not yet built.
  // When live, this will link to the operator-facing dashboard for this client.
  toast(`Operator Dashboard for ${name} coming soon (OB-06)`, 'info');
}

document.getElementById('clients-refresh-btn').addEventListener('click', () => loadClients());

// ══ Member Sync Panel ══════════════════════════════════════════════

const msState = {
  clients:    [],
  page:       1,
  limit:      50,
  total:      0,
};

async function initMemberSync() {
  // Populate client selector
  try {
    const res = await apiFetch('/admin/clients');
    const j   = await res.json();
    msState.clients = j.data || [];
    const sel = document.getElementById('ms-client-select');
    sel.innerHTML = '<option value="">— Select Client —</option>' +
      msState.clients.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  } catch { /* ignore */ }
}

async function loadMemberSyncLocations(clientId) {
  const sel = document.getElementById('ms-location-select');
  sel.innerHTML = '<option value="">All Locations</option>';
  if (!clientId) return;
  try {
    const res = await apiFetch(`/admin/clients/${clientId}/locations`);
    const j   = await res.json();
    sel.innerHTML = '<option value="">All Locations</option>' +
      (j.data || []).map(l => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  } catch { /* ignore */ }
}

async function loadMemberSync() {
  const clientId  = document.getElementById('ms-client-select').value;
  const locationId = document.getElementById('ms-location-select').value;
  const status    = document.getElementById('ms-status-select').value;

  if (!clientId) {
    document.getElementById('ms-empty').classList.remove('hidden');
    document.getElementById('ms-table-wrap').classList.add('hidden');
    document.getElementById('ms-stat-cards').classList.add('hidden');
    document.getElementById('ms-pagination').classList.add('hidden');
    return;
  }

  document.getElementById('ms-loading').classList.remove('hidden');
  document.getElementById('ms-empty').classList.add('hidden');
  document.getElementById('ms-table-wrap').classList.add('hidden');

  try {
    const params = new URLSearchParams({
      client_id: clientId,
      page:      msState.page,
      limit:     msState.limit,
    });
    if (locationId) params.set('location_id', locationId);
    if (status && status !== 'all') params.set('status', status);

    const res = await apiFetch(`/admin/members/by-client?${params}`);
    const j   = await res.json();

    msState.total = j.total || 0;
    renderMemberSyncStats(j.breakdown || {}, j.total || 0);
    renderMemberSyncTable(j.data || []);

    // Pagination
    const totalPages = Math.ceil(msState.total / msState.limit);
    const pageInfo   = document.getElementById('ms-page-info');
    if (pageInfo) pageInfo.textContent = `Page ${msState.page} of ${Math.max(1, totalPages)}`;
    const pg = document.getElementById('ms-pagination');
    pg.classList.toggle('hidden', msState.total <= msState.limit);
    document.getElementById('ms-prev-btn').disabled = msState.page <= 1;
    document.getElementById('ms-next-btn').disabled = msState.page >= totalPages;

  } catch (err) {
    toast(`Member Sync load failed: ${err.message}`, 'error');
  } finally {
    document.getElementById('ms-loading').classList.add('hidden');
  }
}

function renderMemberSyncStats(breakdown, total) {
  document.getElementById('ms-stat-cards').classList.remove('hidden');
  document.getElementById('ms-stat-active').textContent   = breakdown.active   || 0;
  document.getElementById('ms-stat-disabled').textContent = breakdown.disabled  || 0;
  document.getElementById('ms-stat-failed').textContent   = breakdown.failed    || 0;
  document.getElementById('ms-stat-pending').textContent  = (breakdown.pending_sync || 0) + (breakdown.in_flight || 0);
  document.getElementById('ms-stat-total').textContent    = total;
}

function renderMemberSyncTable(rows) {
  const tbody = document.getElementById('ms-tbody');
  if (!rows.length) {
    document.getElementById('ms-empty').classList.remove('hidden');
    document.getElementById('ms-table-wrap').classList.add('hidden');
    document.getElementById('ms-empty').querySelector('p').textContent = 'No members match the current filters';
    return;
  }

  tbody.innerHTML = rows.map(m => {
    const lastEvt = m.last_event_type
      ? `<span title="${fmt(m.last_event_at)}">${esc(m.last_event_type)}</span>`
      : '—';
    return `
      <tr>
        <td><code style="font-size:11px">${esc(m.platform_member_id)}</code></td>
        <td>${esc(m.source_platform) || '—'}</td>
        <td>${esc(m.hardware_platform) || '—'}</td>
        <td>${pill(m.access_status || 'unknown')}</td>
        <td>${fmt(m.provisioned_at)}</td>
        <td>${lastEvt}</td>
        <td>
          <button class="btn btn-sm btn-secondary" onclick="openMemberDetail('${m.id}')">Timeline</button>
          ${m.access_status === 'failed' || m.access_status === 'disabled'
            ? `<button class="btn btn-sm btn-accent" onclick="retryMember('${m.id}')" style="margin-left:4px">Retry</button>`
            : ''}
        </td>
      </tr>`;
  }).join('');

  document.getElementById('ms-table-wrap').classList.remove('hidden');
}

async function retryMember(memberId) {
  try {
    const res = await apiFetch(`/admin/members/${memberId}/retry`, { method: 'POST' });
    if (res.ok) {
      toast('Retry queued', 'success');
      loadMemberSync();
    } else {
      const j = await res.json().catch(() => ({}));
      toast(`Retry failed: ${j.error || 'unknown'}`, 'error');
    }
  } catch {
    toast('Retry failed', 'error');
  }
}

// Wire up Member Sync controls
document.getElementById('ms-client-select').addEventListener('change', async (e) => {
  msState.page = 1;
  await loadMemberSyncLocations(e.target.value);
  loadMemberSync();
});
document.getElementById('ms-location-select').addEventListener('change', () => { msState.page = 1; loadMemberSync(); });
document.getElementById('ms-status-select').addEventListener('change',   () => { msState.page = 1; loadMemberSync(); });
document.getElementById('ms-refresh-btn').addEventListener('click',      () => loadMemberSync());
document.getElementById('ms-prev-btn').addEventListener('click', () => { msState.page--; loadMemberSync(); });
document.getElementById('ms-next-btn').addEventListener('click', () => { msState.page++; loadMemberSync(); });

// ── Stop all polling ────────────────────────────────────────────────
function stopPolling() {
  clearInterval(state.webhooks.pollTimer);
  clearInterval(state.queue.pollTimer);
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
