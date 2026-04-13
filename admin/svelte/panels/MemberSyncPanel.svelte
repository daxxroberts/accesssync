<!--
  MemberSyncPanel.svelte
  @panel Member Sync
  @route /OwnerDashboard → panel-membersync
  @api GET /admin/clients, GET /admin/clients/:id/locations, GET /admin/members/by-client,
       GET /admin/members/:id/timeline, POST /admin/members/:id/retry
  @components StatCard, PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Pagination, Drawer, ConfirmModal
-->
<script>
  import { onMount }   from 'svelte';
  import StatCard      from '../components/StatCard.svelte';
  import PillBadge     from '../components/PillBadge.svelte';
  import CodeChip      from '../components/CodeChip.svelte';
  import TimeStamp     from '../components/TimeStamp.svelte';
  import LoadingState  from '../components/LoadingState.svelte';
  import EmptyState    from '../components/EmptyState.svelte';
  import DataTable     from '../components/DataTable.svelte';
  import Pagination    from '../components/Pagination.svelte';
  import Drawer        from '../components/Drawer.svelte';
  import ConfirmModal  from '../components/ConfirmModal.svelte';
  import { showToast } from '../stores/toast.js';

  const COLUMNS = ['Member ID', 'Platform', 'Hardware', 'Status', 'Provisioned', 'Last Event', 'Actions'];

  // ── State ──────────────────────────────────────────────────────────
  let clients      = [];
  let locations    = [];
  let clientId     = '';
  let locationId   = '';
  let statusFilter = 'all';
  let page         = 1;
  let limit        = 50;
  let total        = 0;
  let rows         = [];
  let breakdown    = {};
  let loading      = false;
  let selected     = false; // has a client been chosen

  let drawerOpen    = false;
  let drawerTitle   = '';
  let drawerLoading = false;
  let timeline      = null;
  let timelineMember = null;

  let modalOpen     = false;
  let retryMemberId = null;

  $: offset = (page - 1) * limit;

  // ── API ────────────────────────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function loadClients() {
    try {
      const res = await apiFetch('/admin/clients');
      const j   = await res.json();
      clients = j.data || [];
    } catch { /* ignore */ }
  }

  async function onClientChange() {
    locations  = [];
    locationId = '';
    page       = 1;
    rows       = [];
    breakdown  = {};
    selected   = !!clientId;
    if (!clientId) return;
    try {
      const res = await apiFetch(`/admin/clients/${clientId}/locations`);
      const j   = await res.json();
      locations = j.data || [];
    } catch { /* ignore */ }
    loadMembers();
  }

  async function loadMembers() {
    if (!clientId) return;
    loading = true;
    rows    = [];
    try {
      const params = new URLSearchParams({ client_id: clientId, page, limit });
      if (locationId)                         params.set('location_id', locationId);
      if (statusFilter && statusFilter !== 'all') params.set('status', statusFilter);

      const res = await apiFetch(`/admin/members/by-client?${params}`);
      const j   = await res.json();
      rows      = j.data      || [];
      total     = j.total     || 0;
      breakdown = j.breakdown || {};
    } catch (err) {
      showToast(`Member Sync load failed: ${err.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  async function openTimeline(member) {
    drawerTitle    = `Timeline: ${member.platform_member_id}`;
    drawerLoading  = true;
    drawerOpen     = true;
    timeline       = null;
    timelineMember = null;
    try {
      const res  = await apiFetch(`/admin/members/${member.id}/timeline`);
      const json = await res.json();
      timeline       = json.timeline || [];
      timelineMember = json.member;
    } catch {
      showToast('Failed to load timeline', 'error');
      drawerOpen = false;
    } finally {
      drawerLoading = false;
    }
  }

  function openRetryModal(id) {
    retryMemberId = id;
    modalOpen     = true;
  }

  async function handleRetry() {
    try {
      const res = await apiFetch(`/admin/members/${retryMemberId}/retry`, { method: 'POST' });
      if (res.ok) { showToast('Retry queued', 'success'); loadMembers(); }
      else { const j = await res.json().catch(() => ({})); showToast(`Retry failed: ${j.error || 'unknown'}`, 'error'); }
    } catch { showToast('Retry failed', 'error'); }
  }

  function onPageChange(e) { page = Math.floor(e.detail.offset / limit) + 1; loadMembers(); }

  onMount(loadClients);
</script>

<!-- ── Controls ───────────────────────────────────────────────────── -->
<div class="panel-actions" style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
  <select class="select-sm" bind:value={clientId} on:change={onClientChange}>
    <option value="">— Select Client —</option>
    {#each clients as c (c.id)}
      <option value={c.id}>{c.name}</option>
    {/each}
  </select>
  <select class="select-sm" bind:value={locationId} on:change={() => { page = 1; loadMembers(); }}>
    <option value="">All Locations</option>
    {#each locations as l (l.id)}
      <option value={l.id}>{l.name}</option>
    {/each}
  </select>
  <select class="select-sm" bind:value={statusFilter} on:change={() => { page = 1; loadMembers(); }}>
    <option value="all">All Statuses</option>
    <option value="active">Active</option>
    <option value="disabled">Disabled</option>
    <option value="failed">Failed</option>
    <option value="pending_sync">Pending Sync</option>
    <option value="revoked">Revoked</option>
  </select>
  <button class="btn btn-secondary btn-sm" on:click={loadMembers}>Refresh</button>
</div>

<!-- ── Stat Cards (shown once a client is selected and data loaded) ── -->
{#if selected && !loading && rows.length > 0}
  <div class="stat-cards" style="margin-bottom:12px;">
    <StatCard label="Active"   value={breakdown.active   || 0} color="success" />
    <StatCard label="Disabled" value={breakdown.disabled  || 0} />
    <StatCard label="Failed"   value={breakdown.failed    || 0} color="danger" />
    <StatCard label="Pending"  value={(breakdown.pending_sync || 0) + (breakdown.in_flight || 0)} color="accent" />
    <StatCard label="Total"    value={total} />
  </div>
{/if}

<!-- ── Loading / Empty / Table ───────────────────────────────────── -->
<LoadingState message="Loading members…" hidden={!loading} />

{#if !loading && !selected}
  <EmptyState message="Select a client to view member provisioning state">
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.08"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

{#if !loading && selected && rows.length === 0}
  <EmptyState message="No members match the current filters" />
{/if}

{#if !loading && rows.length > 0}
  <DataTable columns={COLUMNS}>
    {#each rows as m (m.id)}
      <tr>
        <td><CodeChip text={m.platform_member_id} full={true} /></td>
        <td>{m.source_platform   || '—'}</td>
        <td>{m.hardware_platform || '—'}</td>
        <td><PillBadge text={m.access_status || 'unknown'} /></td>
        <td><TimeStamp iso={m.provisioned_at} /></td>
        <td>
          {#if m.last_event_type}
            <span title={m.last_event_at || ''}>{m.last_event_type}</span>
          {:else}—{/if}
        </td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" on:click={() => openTimeline(m)}>Timeline</button>
          {#if m.access_status === 'failed' || m.access_status === 'disabled'}
            <button class="btn btn-sm btn-accent" on:click={() => openRetryModal(m.id)}>Retry</button>
          {/if}
        </td>
      </tr>
    {/each}
  </DataTable>
  <Pagination {offset} {limit} {total} on:change={onPageChange} />
{/if}

<!-- ── Timeline Drawer ───────────────────────────────────────────── -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading timeline…" />
  {:else if timelineMember}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Client</span><span>{timelineMember.client_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access Status</span><PillBadge text={timelineMember.access_status || 'unknown'} /></div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>{timelineMember.source_platform} / {timelineMember.hardware_platform}</span></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={timelineMember.provisioned_at} /></div>
    </div>
    {#if timeline && timeline.length > 0}
      <div class="detail-section">
        <div class="detail-section-title">Event History</div>
        <div class="timeline">
          {#each timeline as ev (ev.id ?? ev.created_at)}
            <div class="timeline-item">
              <div class="timeline-dot"></div>
              <div class="timeline-content">
                <div class="timeline-header">
                  <CodeChip text={ev.event_type} full={true} />
                  <span class="pill pill-muted">{ev.source}</span>
                  <span class="timeline-time"><TimeStamp iso={ev.created_at} /></span>
                </div>
                {#if ev.detail}<div class="timeline-detail">{ev.detail}</div>{/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {:else}
      <EmptyState message="No timeline events found" />
    {/if}
  {/if}
</Drawer>

<!-- ── Retry Modal ────────────────────────────────────────────────── -->
<ConfirmModal
  bind:open={modalOpen}
  title="Retry Member"
  body="Re-queue the latest failed job for this member?"
  on:confirm={handleRetry}
/>
