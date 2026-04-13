<!--
  ErrorQueuePanel.svelte
  @panel Error Queue
  @route /OwnerDashboard → panel-errors
  @api GET /admin/errors, GET /admin/errors/:id, POST /admin/errors/:id/retry,
       POST /admin/errors/:id/dismiss, POST /admin/errors/bulk-retry
  @components PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Pagination, Drawer, ConfirmModal
-->
<script>
  import { onMount }    from 'svelte';
  import PillBadge      from '../components/PillBadge.svelte';
  import CodeChip       from '../components/CodeChip.svelte';
  import TimeStamp      from '../components/TimeStamp.svelte';
  import LoadingState   from '../components/LoadingState.svelte';
  import EmptyState     from '../components/EmptyState.svelte';
  import DataTable      from '../components/DataTable.svelte';
  import Pagination     from '../components/Pagination.svelte';
  import Drawer         from '../components/Drawer.svelte';
  import ConfirmModal   from '../components/ConfirmModal.svelte';
  import { showToast }  from '../stores/toast.js';

  const COLUMNS = ['', 'Client', 'Member', 'Event Type', 'Reason', 'Status', 'Created', 'Actions'];

  // ── State ──────────────────────────────────────────────────────────
  let statusFilter = 'failed';
  let limit        = 50;
  let offset       = 0;
  let total        = 0;
  let rows         = [];
  let loading      = false;
  let selected     = new Set();

  let drawerOpen    = false;
  let drawerLoading = false;
  let detail        = null;

  // Modal state — one modal handles retry, dismiss, and bulk retry
  let modalOpen  = false;
  let modalTitle = '';
  let modalBody  = '';
  let modalNote  = false;
  let modalAction = null;

  $: selectedCount = selected.size;
  $: allChecked    = rows.length > 0 && rows.every(r => selected.has(r.id));

  // ── Nav badge helper ───────────────────────────────────────────────
  function updateNavBadge(count) {
    const badge = document.getElementById('nav-errors-badge');
    if (!badge) return;
    if (count > 0) {
      badge.textContent = count > 99 ? '99+' : count;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ── API ────────────────────────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function load() {
    loading  = true;
    rows     = [];
    selected = new Set();
    try {
      const params = new URLSearchParams({ status: statusFilter, limit, offset });
      const res    = await apiFetch(`/admin/errors?${params}`);
      const json   = await res.json();
      rows  = json.data  || [];
      total = json.total || 0;
      updateNavBadge(rows.filter(r => r.status === 'failed').length);
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast('Failed to load errors', 'error');
    } finally {
      loading = false;
    }
  }

  async function openDetail(row) {
    drawerOpen    = true;
    drawerLoading = true;
    detail        = null;
    try {
      const res = await apiFetch(`/admin/errors/${row.id}`);
      detail = await res.json();
    } catch {
      showToast('Failed to load error detail', 'error');
      drawerOpen = false;
    } finally {
      drawerLoading = false;
    }
  }

  // ── Modal helpers ──────────────────────────────────────────────────
  function confirmRetry(id) {
    modalTitle  = 'Retry Job';
    modalBody   = 'Re-queue this job to BullMQ? The error will be marked as resolved.';
    modalNote   = false;
    modalAction = async () => {
      const res = await apiFetch(`/admin/errors/${id}/retry`, { method: 'POST' });
      if (res.ok) { showToast('Job re-queued successfully', 'success'); drawerOpen = false; load(); }
      else { const j = await res.json(); showToast(`Retry failed: ${j.error}`, 'error'); }
    };
    modalOpen = true;
  }

  function confirmDismiss(id) {
    modalTitle  = 'Dismiss Error';
    modalBody   = 'Mark this error as resolved? You can add an optional note.';
    modalNote   = true;
    modalAction = async ({ note } = {}) => {
      const res = await apiFetch(`/admin/errors/${id}/dismiss`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note }),
      });
      if (res.ok) { showToast('Error dismissed', 'success'); drawerOpen = false; load(); }
      else { const j = await res.json(); showToast(`Dismiss failed: ${j.error}`, 'error'); }
    };
    modalOpen = true;
  }

  function confirmBulkRetry() {
    const ids = Array.from(selected);
    modalTitle  = 'Bulk Retry';
    modalBody   = `Re-queue ${ids.length} selected job(s)? All will be marked as resolved.`;
    modalNote   = false;
    modalAction = async () => {
      const res  = await apiFetch('/admin/errors/bulk-retry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      const json = await res.json();
      showToast(`Queued: ${json.queued}, Failed: ${json.failed}`, json.failed ? 'warning' : 'success');
      selected = new Set();
      load();
    };
    modalOpen = true;
  }

  async function handleModalConfirm(e) {
    try { await modalAction(e.detail); }
    catch { showToast('Action failed', 'error'); }
  }

  // ── Checkbox helpers ───────────────────────────────────────────────
  function toggleRow(id, checked) {
    selected = new Set(selected);
    checked ? selected.add(id) : selected.delete(id);
  }

  function toggleAll(checked) {
    selected = checked ? new Set(rows.map(r => r.id)) : new Set();
  }

  function onPageChange(e) {
    offset = e.detail.offset;
    load();
  }

  onMount(load);
</script>

<!-- ── Toolbar ────────────────────────────────────────────────────── -->
<div class="panel-actions" style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
  <select class="select-sm" bind:value={statusFilter} on:change={() => { offset = 0; load(); }}>
    <option value="failed">Failed</option>
    <option value="resolved">Resolved</option>
    <option value="all">All</option>
  </select>
  <button class="btn btn-secondary btn-sm" on:click={load}>Refresh</button>
  <button
    class="btn btn-accent btn-sm"
    disabled={selectedCount === 0}
    on:click={confirmBulkRetry}
  >
    {selectedCount > 0 ? `Retry Selected (${selectedCount})` : 'Retry Selected'}
  </button>
</div>

<!-- ── Loading / Empty / Table ───────────────────────────────────── -->
<LoadingState message="Loading errors…" hidden={!loading} />

{#if !loading && rows.length === 0}
  <EmptyState message="No errors found">
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

{#if !loading && rows.length > 0}
  <DataTable columns={COLUMNS}>
    <svelte:fragment slot="head">
      <tr>
        <th class="col-check">
          <input type="checkbox" checked={allChecked} on:change={e => toggleAll(e.target.checked)} />
        </th>
        {#each COLUMNS.slice(1) as col}<th>{col}</th>{/each}
      </tr>
    </svelte:fragment>
    {#each rows as row (row.id)}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <tr class="clickable-row" on:click={e => { if (!e.target.closest('.actions-cell,input')) openDetail(row); }}>
        <td class="col-check" on:click|stopPropagation>
          <input type="checkbox"
            checked={selected.has(row.id)}
            on:change={e => toggleRow(row.id, e.target.checked)}
          />
        </td>
        <td>{row.client_name || '<span class="muted">Unknown</span>'}</td>
        <td>
          <div>{row.member_display_name || '—'}</div>
          {#if row.member_email}<div class="cell-sub">{row.member_email}</div>{/if}
        </td>
        <td><CodeChip text={row.event_type} /></td>
        <td class="reason-cell" title={row.error_reason || ''}>{row.error_reason || '—'}</td>
        <td><PillBadge text={row.status} /></td>
        <td><TimeStamp iso={row.created_at} /></td>
        <td class="actions-cell" on:click|stopPropagation>
          {#if row.status === 'failed'}
            <button class="btn btn-sm btn-accent"     on:click={() => confirmRetry(row.id)}>Retry</button>
            <button class="btn btn-sm btn-secondary"  on:click={() => confirmDismiss(row.id)}>Dismiss</button>
          {:else}
            <span class="muted">—</span>
          {/if}
        </td>
      </tr>
    {/each}
  </DataTable>

  <Pagination {offset} {limit} {total} on:change={onPageChange} />
{/if}

<!-- ── Detail Drawer ──────────────────────────────────────────────── -->
<Drawer bind:open={drawerOpen} title="Error Detail">
  {#if drawerLoading}
    <LoadingState message="Loading…" />
  {:else if detail}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Status</span><PillBadge text={detail.status} /></div>
      <div class="detail-row"><span class="detail-label">Client</span><span>{detail.client_name || '—'}</span></div>
      <div class="detail-row">
        <span class="detail-label">Member</span>
        <span>{detail.member_display_name || '—'}{#if detail.member_email} <span class="muted">({detail.member_email})</span>{/if}</span>
      </div>
      <div class="detail-row"><span class="detail-label">Platform ID</span><CodeChip text={detail.platform_member_id} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Event Type</span><CodeChip text={detail.event_type} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Attempts</span><span>{detail.retry_count ?? '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Error Reason</span><span class="reason-text">{detail.error_reason || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Created</span><TimeStamp iso={detail.created_at} /></div>
      {#if detail.resolved_at}
        <div class="detail-row"><span class="detail-label">Resolved</span><TimeStamp iso={detail.resolved_at} /></div>
      {/if}
      {#if detail.dismiss_note}
        <div class="detail-row"><span class="detail-label">Note</span><span>{detail.dismiss_note}</span></div>
      {/if}
    </div>
    {#if detail.payload}
      <div class="detail-section">
        <div class="detail-section-title">Payload</div>
        <pre class="code-block">{JSON.stringify(typeof detail.payload === 'string' ? JSON.parse(detail.payload) : detail.payload, null, 2)}</pre>
      </div>
    {/if}
    {#if detail.status === 'failed'}
      <div class="drawer-footer-actions">
        <button class="btn btn-accent"    on:click={() => confirmRetry(detail.id)}>Retry Job</button>
        <button class="btn btn-secondary" on:click={() => confirmDismiss(detail.id)}>Dismiss</button>
      </div>
    {/if}
  {/if}
</Drawer>

<!-- ── Confirm Modal ──────────────────────────────────────────────── -->
<ConfirmModal
  bind:open={modalOpen}
  title={modalTitle}
  body={modalBody}
  showNote={modalNote}
  on:confirm={handleModalConfirm}
/>
