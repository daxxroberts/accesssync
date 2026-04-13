<!--
  WebhookPanel.svelte
  @panel Webhook Inspector
  @route /OwnerDashboard → panel-webhooks
  @api GET /admin/webhooks/recent, GET /admin/webhooks/:id
  @polling 10s, pause/resume toggle
  @components PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Drawer
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  import PillBadge    from '../components/PillBadge.svelte';
  import CodeChip     from '../components/CodeChip.svelte';
  import TimeStamp    from '../components/TimeStamp.svelte';
  import LoadingState from '../components/LoadingState.svelte';
  import EmptyState   from '../components/EmptyState.svelte';
  import DataTable    from '../components/DataTable.svelte';
  import Drawer       from '../components/Drawer.svelte';
  import { showToast } from '../stores/toast.js';

  const COLUMNS = ['Received', 'Client', 'Event Type', 'HMAC', 'Dedup', 'Error'];

  // ── State ──────────────────────────────────────────────────────────
  let rows          = [];
  let loading       = true;
  let polling       = true;
  let lastTimestamp = null;
  let pollTimer;

  let drawerOpen    = false;
  let drawerTitle   = 'Webhook Detail';
  let drawerLoading = false;
  let detail        = null;

  // ── API ────────────────────────────────────────────────────────────
  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function loadInitial() {
    loading = true;
    try {
      const res  = await apiFetch('/admin/webhooks/recent?limit=50');
      const json = await res.json();
      rows = json.data || [];
      if (rows.length) lastTimestamp = rows[0].received_at;
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast('Failed to load webhooks', 'error');
    } finally {
      loading = false;
    }
  }

  async function poll() {
    if (!polling) return;
    try {
      const params = lastTimestamp
        ? `?since=${encodeURIComponent(lastTimestamp)}&limit=50`
        : '?limit=50';
      const res     = await apiFetch(`/admin/webhooks/recent${params}`);
      const json    = await res.json();
      const newRows = json.data || [];
      if (newRows.length) {
        rows          = [...newRows, ...rows].slice(0, 200);
        lastTimestamp = rows[0].received_at;
      }
    } catch (err) {
      if (err.message === 'Unauthorized') clearInterval(pollTimer);
    }
  }

  function togglePolling() {
    polling = !polling;
    if (polling) {
      startPollTimer();
    } else {
      clearInterval(pollTimer);
    }
  }

  function startPollTimer() {
    clearInterval(pollTimer);
    pollTimer = setInterval(poll, 10000);
  }

  async function openDetail(row) {
    drawerTitle   = 'Webhook Detail';
    drawerLoading = true;
    drawerOpen    = true;
    detail        = null;
    try {
      const res = await apiFetch(`/admin/webhooks/${row.id}`);
      detail = await res.json();
    } catch {
      showToast('Failed to load webhook detail', 'error');
      drawerOpen = false;
    } finally {
      drawerLoading = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  onMount(() => {
    loadInitial();
    startPollTimer();
  });

  onDestroy(() => clearInterval(pollTimer));
</script>

<!-- ── Panel Actions (Pause/Live indicator) ──────────────────────── -->
<div class="panel-actions" style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
  <span class="poll-indicator">
    <span class="poll-dot" class:paused={!polling}></span>
    {polling ? 'Live' : 'Paused'}
  </span>
  <button class="btn btn-secondary btn-sm" on:click={togglePolling}>
    {polling ? 'Pause' : 'Resume'}
  </button>
</div>

<!-- ── Loading / Empty / Table ───────────────────────────────────── -->
<LoadingState message="Loading webhooks…" hidden={!loading} />

{#if !loading && rows.length === 0}
  <EmptyState message="No webhook events received yet">
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

{#if !loading && rows.length > 0}
  <DataTable {COLUMNS}>
    {#each rows as row (row.id)}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <tr class="clickable-row" on:click={() => openDetail(row)}>
        <td><TimeStamp iso={row.received_at} /></td>
        <td>{row.client_name || '—'}</td>
        <td><CodeChip text={row.event_type} /></td>
        <td><PillBadge text={row.hmac_status} /></td>
        <td>
          {#if row.dedup_status}
            <PillBadge text={row.dedup_status} />
          {:else}
            <span class="muted">—</span>
          {/if}
        </td>
        <td class="reason-cell" title={row.error_detail || ''}>
          {row.error_detail || '—'}
        </td>
      </tr>
    {/each}
  </DataTable>
{/if}

<!-- ── Detail Drawer ──────────────────────────────────────��──────── -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />
  {:else if detail}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Received</span><TimeStamp iso={detail.received_at} /></div>
      <div class="detail-row"><span class="detail-label">Client</span><span>{detail.client_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Event ID</span><CodeChip text={detail.event_id} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Event Type</span><CodeChip text={detail.event_type} full={true} /></div>
      <div class="detail-row"><span class="detail-label">HMAC Status</span><PillBadge text={detail.hmac_status} /></div>
      <div class="detail-row">
        <span class="detail-label">Dedup Status</span>
        {#if detail.dedup_status}
          <PillBadge text={detail.dedup_status} />
        {:else}
          <span class="muted">—</span>
        {/if}
      </div>
      {#if detail.error_detail}
        <div class="detail-row"><span class="detail-label">Error</span><span class="danger">{detail.error_detail}</span></div>
      {/if}
    </div>

    {#if detail.raw_payload}
      <div class="detail-section">
        <div class="detail-section-title">Raw Payload</div>
        <pre class="code-block">{JSON.stringify(detail.raw_payload, null, 2)}</pre>
      </div>
    {/if}

    {#if detail.normalized_payload}
      <div class="detail-section">
        <div class="detail-section-title">Normalized Payload</div>
        <pre class="code-block">{JSON.stringify(detail.normalized_payload, null, 2)}</pre>
      </div>
    {/if}
  {/if}
</Drawer>
