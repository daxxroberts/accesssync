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

  function fmtDuration(seconds) {
    if (seconds == null) return '—';
    if (seconds < 60)  return seconds + 's';
    if (seconds < 3600) return Math.round(seconds / 60) + 'm ' + (seconds % 60) + 's';
    return Math.round(seconds / 3600) + 'h ' + Math.round((seconds % 3600) / 60) + 'm';
  }

  function latencyColor(seconds) {
    if (seconds == null) return '';
    if (seconds <= 10)  return 'color:var(--success)';
    if (seconds <= 30)  return 'color:var(--accent)';
    return 'color:var(--danger)';
  }

  const COLUMNS = ['Member', 'Platform', 'Hardware', 'Status', 'Plans', 'Provisioned', 'Total Time', 'Last Event', 'Actions'];

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
  let drawerMode    = 'timeline'; // 'timeline' | 'diagnose' | 'plans'
  let timeline      = null;
  let timelineMember = null;
  let diagnose      = null;
  let plans         = null;

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

  function memberLabel(m) {
    return m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.platform_member_id;
  }

  async function openTimeline(member) {
    drawerMode     = 'timeline';
    drawerTitle    = `Timeline: ${memberLabel(member)}`;
    drawerLoading  = true;
    drawerOpen     = true;
    timeline       = null;
    timelineMember = null;
    diagnose       = null;
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

  async function openPlans(member) {
    drawerMode     = 'plans';
    drawerTitle    = `Plans: ${memberLabel(member)}`;
    drawerLoading  = true;
    drawerOpen     = true;
    plans          = null;
    timeline       = null;
    timelineMember = null;
    diagnose       = null;
    try {
      const res  = await apiFetch(`/admin/members/${member.id}/plans`);
      const json = await res.json();
      plans = json.plans || [];
    } catch {
      showToast('Failed to load plans', 'error');
      drawerOpen = false;
    } finally {
      drawerLoading = false;
    }
  }

  async function openDiagnose(member) {
    drawerMode     = 'diagnose';
    drawerTitle    = `Diagnose: ${memberLabel(member)}`;
    drawerLoading  = true;
    drawerOpen     = true;
    diagnose       = null;
    timeline       = null;
    timelineMember = null;
    try {
      const res  = await apiFetch(`/admin/members/${member.id}/diagnose`);
      diagnose = await res.json();
    } catch {
      showToast('Failed to load diagnostic data', 'error');
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
        <td>
          {#if m.display_name || m.first_name}
            <div style="font-weight:600;font-size:13px;">{m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ')}</div>
            {#if m.email}<div class="cell-sub">{m.email}</div>{/if}
            <div class="cell-sub"><CodeChip text={m.platform_member_id} full={true} /></div>
          {:else}
            <CodeChip text={m.platform_member_id} full={true} />
            {#if m.email}<div class="cell-sub">{m.email}</div>{/if}
          {/if}
        </td>
        <td>{m.source_platform   || '—'}</td>
        <td>{m.hardware_platform || '—'}</td>
        <td><PillBadge text={m.access_status || 'unknown'} /></td>
        <td>
          {#if m.plan_count > 0}
            <button class="plan-count-badge" on:click={() => openPlans(m)}>
              {m.plan_count} {m.plan_count === 1 ? 'plan' : 'plans'}
            </button>
          {:else}
            <span style="color:var(--muted);font-size:12px;">—</span>
          {/if}
        </td>
        <td><TimeStamp iso={m.provisioned_at} /></td>
        <td style={latencyColor(m.total_s)} title={m.total_s != null ? `Ingest: ${fmtDuration(m.ingest_s)} · Processing: ${fmtDuration(m.processing_s)}` : 'No timing data'}>
          {fmtDuration(m.total_s)}
        </td>
        <td>
          {#if m.last_event_type}
            <span title={m.last_event_at || ''}>{m.last_event_type}</span>
          {:else}—{/if}
        </td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" on:click={() => openTimeline(m)}>Timeline</button>
          <button class="btn btn-sm btn-secondary" on:click={() => openDiagnose(m)}>Diagnose</button>
          {#if m.access_status === 'failed' || m.access_status === 'disabled'}
            <button class="btn btn-sm btn-accent" on:click={() => openRetryModal(m.id)}>Retry</button>
          {/if}
        </td>
      </tr>
    {/each}
  </DataTable>
  <Pagination {offset} {limit} {total} on:change={onPageChange} />
{/if}

<!-- ── Timeline / Diagnose Drawer ────────────────────────────────── -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />
  {:else if drawerMode === 'diagnose' && diagnose}
    <!-- Verdict banner -->
    <div class="verdict-banner verdict-{diagnose.verdict}">
      {#if diagnose.verdict === 'healthy'}✓ Healthy
      {:else if diagnose.verdict === 'degraded'}⚠ Degraded
      {:else if diagnose.verdict === 'failed'}✗ Failed
      {:else}⚠ Mismatch{/if}
    </div>

    <!-- Findings -->
    <div class="detail-section">
      <div class="detail-section-title">Findings</div>
      {#each diagnose.findings as f}
        <div class="finding-row">
          <span class="finding-level finding-level-{f.level}">{f.level}</span>
          <span class="finding-msg"><strong>{f.code}</strong> — {f.message}</span>
        </div>
      {/each}
    </div>

    <!-- State summary -->
    {#if diagnose.member}
      <div class="detail-section">
        <div class="detail-section-title">State Summary</div>
        <div class="detail-row"><span class="detail-label">Access status</span><PillBadge text={diagnose.member.access_status || 'unknown'} /></div>
        <div class="detail-row"><span class="detail-label">Role assignments</span><span>{diagnose.roles?.length ?? 0}</span></div>
        <div class="detail-row"><span class="detail-label">Access sources</span><span>{diagnose.sources?.length ?? 0}</span></div>
        {#if diagnose.member.provisioned_at}
          <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={diagnose.member.provisioned_at} /></div>
        {/if}
      </div>
    {/if}

  {:else if drawerMode === 'plans' && plans}
    {#if plans.length === 0}
      <EmptyState message="No active plan assignments found for this member" />
    {:else}
      <div class="detail-section">
        <div class="detail-section-title">Active Plans ({plans.length})</div>
        {#each plans as p}
          <div class="plan-row">
            <div class="plan-row-main">
              <span class="plan-name">{p.plan_name || '—'}</span>
              <PillBadge text={p.status || 'unknown'} />
            </div>
            <div class="plan-row-meta">
              {#if p.door_name}<span class="plan-meta-item">Door: {p.door_name}</span>{/if}
              {#if p.location_name}<span class="plan-meta-item">Location: {p.location_name}</span>{/if}
              {#if p.access_type}<span class="plan-meta-item">{p.access_type}</span>{/if}
              {#if p.granted_at}<span class="plan-meta-item">Granted <TimeStamp iso={p.granted_at} /></span>{/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}

  {:else if drawerMode === 'timeline' && timelineMember}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Client</span><span>{timelineMember.client_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access Status</span><PillBadge text={timelineMember.access_status || 'unknown'} /></div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>{timelineMember.source_platform} / {timelineMember.hardware_platform}</span></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={timelineMember.provisioned_at} /></div>
    </div>

    {#if timelineMember.webhook_received_at}
      <div class="detail-section">
        <div class="detail-section-title">Provisioning Latency</div>
        <div class="latency-timeline">
          <div class="latency-step">
            <div class="latency-dot"></div>
            <div class="latency-info">
              <span class="latency-label">Purchase received</span>
              <span class="latency-time"><TimeStamp iso={timelineMember.webhook_received_at} /></span>
            </div>
          </div>
          <div class="latency-gap" title="Webhook → queue">
            <span class="latency-gap-label">Ingest: {fmtDuration(timelineMember.ingest_s)}</span>
          </div>
          <div class="latency-step">
            <div class="latency-dot"></div>
            <div class="latency-info">
              <span class="latency-label">Job enqueued</span>
              <span class="latency-time"><TimeStamp iso={timelineMember.enqueued_at} /></span>
            </div>
          </div>
          <div class="latency-gap" title="Queue → Kisi confirmed">
            <span class="latency-gap-label">Processing: {fmtDuration(timelineMember.processing_s)}</span>
          </div>
          <div class="latency-step">
            <div class="latency-dot latency-dot-end"></div>
            <div class="latency-info">
              <span class="latency-label">Access confirmed</span>
              <span class="latency-time"><TimeStamp iso={timelineMember.kisi_confirmed_at} /></span>
            </div>
          </div>
        </div>
        <div class="latency-total" style={latencyColor(timelineMember.total_s)}>
          Total: {fmtDuration(timelineMember.total_s)} end-to-end
        </div>
      </div>
    {/if}
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

<style>
  .plan-count-badge { background: rgba(79,110,247,0.12); color: var(--brand, #4F6EF7); border: 1px solid rgba(79,110,247,0.25); border-radius: 12px; padding: 2px 10px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .plan-count-badge:hover { background: rgba(79,110,247,0.2); }
  .plan-row { padding: 10px 0; border-bottom: 1px solid var(--border, #e5e7eb); }
  .plan-row:last-child { border-bottom: none; }
  .plan-row-main { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .plan-name { font-size: 13px; font-weight: 600; color: var(--text); }
  .plan-row-meta { display: flex; flex-wrap: wrap; gap: 8px; }
  .plan-meta-item { font-size: 11px; color: var(--muted); }
  .verdict-banner { border-radius: 8px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; font-weight: 600; }
  .verdict-healthy  { background: rgba(74,222,128,0.12); color: var(--success, #16a34a); border: 1px solid rgba(74,222,128,0.3); }
  .verdict-degraded { background: rgba(245,158,11,0.12); color: var(--accent,  #d97706); border: 1px solid rgba(245,158,11,0.3); }
  .verdict-failed   { background: rgba(239,68,68,0.12);  color: var(--danger,  #dc2626); border: 1px solid rgba(239,68,68,0.3); }
  .verdict-mismatch { background: rgba(239,68,68,0.12);  color: var(--danger,  #dc2626); border: 1px solid rgba(239,68,68,0.3); }
  .finding-row { display: flex; gap: 8px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--border, #e5e7eb); font-size: 12px; }
  .finding-row:last-child { border-bottom: none; }
  .finding-level { flex-shrink: 0; font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 2px 6px; border-radius: 4px; letter-spacing: 0.04em; }
  .finding-level-error { background: rgba(239,68,68,0.12); color: var(--danger, #dc2626); }
  .finding-level-warn  { background: rgba(245,158,11,0.12); color: var(--accent, #d97706); }
  .finding-level-ok    { background: rgba(74,222,128,0.12); color: var(--success, #16a34a); }
  .finding-msg { color: var(--text, #111); line-height: 1.5; }
  .latency-timeline { display: flex; flex-direction: column; gap: 0; margin: 8px 0; }
  .latency-step { display: flex; align-items: flex-start; gap: 10px; }
  .latency-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--brand); flex-shrink: 0; margin-top: 3px; }
  .latency-dot-end { background: var(--success, #22c55e); }
  .latency-info { display: flex; flex-direction: column; gap: 1px; padding-bottom: 2px; }
  .latency-label { font-size: 12px; font-weight: 600; color: var(--text); }
  .latency-time { font-size: 11px; color: var(--muted); }
  .latency-gap { display: flex; align-items: center; padding: 2px 0 2px 4px; margin-left: 4px; border-left: 2px dashed var(--border); }
  .latency-gap-label { font-size: 11px; color: var(--muted); margin-left: 10px; font-style: italic; }
  .latency-total { margin-top: 10px; font-size: 13px; font-weight: 700; padding: 8px 12px; background: var(--surface); border-radius: 8px; border: 1px solid var(--border); }
</style>

<!-- ── Retry Modal ────────────────────────────────────────────────── -->
<ConfirmModal
  bind:open={modalOpen}
  title="Retry Member"
  body="Re-queue the latest failed job for this member?"
  on:confirm={handleRetry}
/>
