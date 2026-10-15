<!--
  MembersPanel.svelte
  @panel Members
  @route /OwnerDashboard → panel-members
  @api GET /admin/members/search?q=&client_id=, GET /admin/members/by-client, GET /admin/clients,
       GET /admin/members/:id/timeline, GET /admin/members/:id/diagnose, GET /admin/members/:id/plans, POST /admin/members/:id/retry
  @components SearchBar, PillBadge, CodeChip, TimeStamp, StatCard, LoadingState, EmptyState, DataTable, Pagination, Drawer, ConfirmModal

  Debug Center and Member Sync merged (owner hub review 2026-10-15): one place to find any member at any gym.
    - no filter: the 25 most recently updated members across all gyms
    - a search: by email, name or member ID (optionally within one gym)
    - a gym chosen, no search: that gym's members with status breakdown, plan count and provisioning latency
  Retry is offered only for members who are not active (it re-queues their latest failed job).
-->
<script>
  import { onMount }    from 'svelte';
  import SearchBar      from '../components/SearchBar.svelte';
  import PillBadge      from '../components/PillBadge.svelte';
  import CodeChip       from '../components/CodeChip.svelte';
  import TimeStamp      from '../components/TimeStamp.svelte';
  import StatCard       from '../components/StatCard.svelte';
  import LoadingState   from '../components/LoadingState.svelte';
  import EmptyState     from '../components/EmptyState.svelte';
  import DataTable      from '../components/DataTable.svelte';
  import Pagination     from '../components/Pagination.svelte';
  import Drawer         from '../components/Drawer.svelte';
  import ConfirmModal   from '../components/ConfirmModal.svelte';
  import { showToast }  from '../stores/toast.js';

  // member_access.status enum since S-11 (DR-046)
  const STATUSES = ['active', 'inactive', 'in_flight', 'pending_identity', 'recovery_pending'];
  const STATUS_LABEL = { active: 'Active', inactive: 'Inactive', in_flight: 'In flight', pending_identity: 'Pending identity', recovery_pending: 'Recovering' };

  let clients = [];
  let query = '';
  let clientId = '';
  let statusFilter = 'all';
  let page = 1;
  const limit = 50;
  let total = 0;
  let rows = [];
  let breakdown = null;
  let mode = 'recent';     // 'recent' | 'search' | 'client'
  let loading = false;

  let drawerOpen = false, drawerTitle = '', drawerLoading = false, drawerMode = 'timeline';
  let timeline = null, timelineMember = null, diagnosis = null, plans = null;
  let modalOpen = false, retryMemberId = null;

  $: offset = (page - 1) * limit;
  $: showsClientColumns = mode === 'client';

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function loadClients() {
    try { const r = await apiFetch('/admin/clients'); clients = (await r.json()).data || []; } catch { /* non-fatal */ }
  }

  export async function load() {
    loading = true; rows = [];
    try {
      let url;
      if (query.trim()) {
        mode = 'search';
        url = `/admin/members/search?q=${encodeURIComponent(query.trim())}${clientId ? '&client_id=' + encodeURIComponent(clientId) : ''}`;
      } else if (clientId) {
        mode = 'client';
        const p = new URLSearchParams({ client_id: clientId, page, limit });
        if (statusFilter !== 'all') p.set('status', statusFilter);
        url = `/admin/members/by-client?${p}`;
      } else {
        mode = 'recent';
        url = '/admin/members/search';
      }
      const res = await apiFetch(url);
      const j = await res.json();
      rows = j.data || [];
      total = j.total || rows.length;
      breakdown = mode === 'client' ? (j.breakdown || {}) : null;
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast(`Could not load members: ${err.message}`, 'error');
    } finally { loading = false; }
  }

  function memberLabel(m) { return m.display_name || [m.first_name, m.last_name].filter(Boolean).join(' ') || m.platform_member_id; }
  function fmtDuration(s) {
    if (s == null) return '—';
    if (s < 60) return s + 's';
    if (s < 3600) return Math.round(s / 60) + 'm ' + (s % 60) + 's';
    return Math.round(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
  }
  function latencyColor(s) { return s == null ? '' : s <= 10 ? 'color:var(--green)' : s <= 30 ? 'color:var(--amber)' : 'color:var(--red)'; }

  async function openDrawer(m, which) {
    drawerMode = which;
    drawerTitle = `${which === 'timeline' ? 'Timeline' : which === 'diagnose' ? 'Diagnose' : 'Plans'}: ${memberLabel(m)}`;
    drawerLoading = true; drawerOpen = true;
    timeline = null; timelineMember = null; diagnosis = null; plans = null;
    try {
      const res = await apiFetch(`/admin/members/${m.id}/${which === 'timeline' ? 'timeline' : which}`);
      const j = await res.json();
      if (which === 'timeline') { timeline = j.timeline || []; timelineMember = j.member; }
      else if (which === 'diagnose') diagnosis = j;
      else plans = j.plans || [];
    } catch {
      showToast('Could not load', 'error'); drawerOpen = false;
    } finally { drawerLoading = false; }
  }

  function openRetryModal(id) { retryMemberId = id; modalOpen = true; }
  async function handleRetry() {
    try {
      const res = await apiFetch(`/admin/members/${retryMemberId}/retry`, { method: 'POST' });
      const j = await res.json().catch(() => ({}));
      if (res.ok) { showToast(`Queued: ${j.queued ?? 1}`, 'success'); load(); }
      else showToast(`Retry refused: ${j.error || 'unknown'}`, 'error');
    } catch { showToast('Retry failed', 'error'); }
  }

  const VERDICT_LABEL = { healthy: 'Healthy', degraded: 'Degraded', failed: 'Failed', mismatch: 'Mismatch' };
  const VERDICT_COLOR = { healthy: 'green', degraded: 'amber', failed: 'red', mismatch: 'red' };
  const FINDING_COLOR = { ok: 'green', warn: 'amber', error: 'red' };

  onMount(async () => { await loadClients(); load(); });
</script>

<div class="panel-actions members-toolbar">
  <SearchBar placeholder="Search by email, name, or member ID…" bind:value={query} on:search={() => { page = 1; load(); }} />
  <select class="select-sm" bind:value={clientId} on:change={() => { page = 1; load(); }}>
    <option value="">All gyms</option>
    {#each clients as c (c.id)}<option value={c.id}>{c.name}</option>{/each}
  </select>
  <select class="select-sm" bind:value={statusFilter} disabled={mode !== 'client'} title={mode !== 'client' ? 'Choose a gym to filter by status' : ''} on:change={() => { page = 1; load(); }}>
    <option value="all">All statuses</option>
    {#each STATUSES as s}<option value={s}>{STATUS_LABEL[s]}</option>{/each}
  </select>
  <button class="btn btn-secondary btn-sm" on:click={load}>Refresh</button>
</div>

{#if breakdown && !loading}
  <div class="stat-cards stat-cards-5">
    <StatCard label="Active"           value={breakdown.active || 0}           color="success" />
    <StatCard label="Inactive"         value={breakdown.inactive || 0} />
    <StatCard label="In flight"        value={breakdown.in_flight || 0}        color="accent" />
    <StatCard label="Pending identity" value={breakdown.pending_identity || 0} color="accent" />
    <StatCard label="Recovering"       value={breakdown.recovery_pending || 0} color="danger" />
  </div>
{/if}

<LoadingState message="Loading members…" hidden={!loading} />

{#if !loading && mode === 'recent' && rows.length > 0}
  <div class="muted" style="font-size:12px;padding:8px 20px 0;">Showing the 25 most recently updated members across all gyms — search or pick a gym to narrow.</div>
{/if}

{#if !loading && rows.length === 0}
  <EmptyState message={mode === 'search' ? `No members found for "${query}"` : 'No members match'} />
{/if}

{#if !loading && rows.length > 0}
  <DataTable columns={showsClientColumns ? ['Member', 'Status', 'Plans', 'Provisioned', 'Time to door', 'Last event', 'Actions'] : ['Member', 'Gym', 'Status', 'Provisioned', 'Last updated', 'Actions']}>
    {#each rows as m (m.id)}
      <tr>
        <td>
          <div>{#if m.display_name || m.first_name}{memberLabel(m)}{:else}<span class="muted">No name</span>{/if}</div>
          {#if m.email}<div class="cell-sub">{m.email}</div>{/if}
          <div class="cell-sub"><CodeChip text={m.platform_member_id} full={true} /></div>
        </td>
        {#if !showsClientColumns}<td>{m.client_name || '—'}</td>{/if}
        <td><PillBadge text={m.access_status || 'unknown'} /></td>
        {#if showsClientColumns}
          <td>{#if m.plan_count > 0}<button class="plan-count-badge" on:click={() => openDrawer(m, 'plans')}>{m.plan_count} {m.plan_count === 1 ? 'plan' : 'plans'}</button>{:else}<span class="muted">—</span>{/if}</td>
        {/if}
        <td><TimeStamp iso={m.provisioned_at} /></td>
        {#if showsClientColumns}
          <td style={latencyColor(m.total_s)} title={m.total_s != null ? `Ingest ${fmtDuration(m.ingest_s)} · processing ${fmtDuration(m.processing_s)}` : 'No timing data'}>{fmtDuration(m.total_s)}</td>
          <td>{#if m.last_event_type}<span title={m.last_event_at || ''}>{m.last_event_type}</span>{:else}—{/if}</td>
        {:else}
          <td><TimeStamp iso={m.updated_at} /></td>
        {/if}
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" on:click={() => openDrawer(m, 'timeline')}>Timeline</button>
          <button class="btn btn-sm btn-secondary" on:click={() => openDrawer(m, 'diagnose')}>Diagnose</button>
          {#if m.access_status && m.access_status !== 'active'}
            <button class="btn btn-sm btn-accent" on:click={() => openRetryModal(m.id)}>Retry</button>
          {/if}
        </td>
      </tr>
    {/each}
  </DataTable>
  {#if mode === 'client'}<Pagination {offset} {limit} {total} on:change={e => { page = Math.floor(e.detail.offset / limit) + 1; load(); }} />{/if}
{/if}

<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />

  {:else if drawerMode === 'diagnose' && diagnosis}
    <div class="detail-section">
      <div class="verdict-banner verdict-{VERDICT_COLOR[diagnosis.verdict]}">
        <strong>{VERDICT_LABEL[diagnosis.verdict]}</strong> — {diagnosis.findings.length} finding{diagnosis.findings.length !== 1 ? 's' : ''}
      </div>
    </div>
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Name</span><span>{diagnosis.member.display_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Email</span><span>{diagnosis.member.email || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access status</span><PillBadge text={diagnosis.member.access_status || 'unknown'} /></div>
      <div class="detail-row"><span class="detail-label">Door user</span><CodeChip text={diagnosis.member.hardware_user_id || '—'} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={diagnosis.member.provisioned_at} /></div>
    </div>
    <div class="detail-section">
      <div class="detail-section-title">Findings</div>
      {#each diagnosis.findings as f}
        <div class="finding finding-{FINDING_COLOR[f.level]}">
          <CodeChip text={f.code} full={true} />
          <div class="finding-msg">{f.message}</div>
          {#if f.at}<div class="finding-time"><TimeStamp iso={f.at} /></div>{/if}
          {#if f.context}<details class="timeline-context"><summary>Context</summary><pre>{JSON.stringify(f.context, null, 2)}</pre></details>{/if}
        </div>
      {/each}
    </div>
    {#if diagnosis.sources.length}
      <div class="detail-section">
        <div class="detail-section-title">Access sources ({diagnosis.sources.length})</div>
        {#each diagnosis.sources as src}
          <div class="detail-row"><span class="detail-label">{src.plan_name || src.source_plan_id}</span><PillBadge text={src.source_status || src.mapping_status || 'ok'} /></div>
        {/each}
      </div>
    {/if}
    {#if diagnosis.roles.length}
      <div class="detail-section">
        <div class="detail-section-title">Door roles ({diagnosis.roles.length})</div>
        {#each diagnosis.roles as role}
          <div class="detail-row"><span class="detail-label">{role.plan_name || role.mapping_id}</span><CodeChip text={role.role_assignment_id} full={true} /></div>
        {/each}
      </div>
    {/if}

  {:else if drawerMode === 'plans' && plans}
    {#if plans.length === 0}
      <EmptyState message="No active plan assignments for this member" />
    {:else}
      <div class="detail-section">
        <div class="detail-section-title">Active plans ({plans.length})</div>
        {#each plans as p}
          <div class="plan-row">
            <div class="plan-row-main"><span class="plan-name">{p.plan_name || '—'}</span><PillBadge text={p.status || 'unknown'} /></div>
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
      <div class="detail-row"><span class="detail-label">Gym</span><span>{timelineMember.client_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access status</span><PillBadge text={timelineMember.access_status || 'unknown'} /></div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>{timelineMember.source_platform} / {timelineMember.hardware_platform}</span></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={timelineMember.provisioned_at} /></div>
    </div>
    {#if timelineMember.webhook_received_at}
      <div class="detail-section">
        <div class="detail-section-title">Purchase to door</div>
        <div class="latency-timeline">
          <div class="latency-step"><div class="latency-dot"></div><div class="latency-info"><span class="latency-label">Purchase received</span><span class="latency-time"><TimeStamp iso={timelineMember.webhook_received_at} /></span></div></div>
          <div class="latency-gap"><span class="latency-gap-label">Ingest: {fmtDuration(timelineMember.ingest_s)}</span></div>
          <div class="latency-step"><div class="latency-dot"></div><div class="latency-info"><span class="latency-label">Job queued</span><span class="latency-time"><TimeStamp iso={timelineMember.enqueued_at} /></span></div></div>
          <div class="latency-gap"><span class="latency-gap-label">Processing: {fmtDuration(timelineMember.processing_s)}</span></div>
          <div class="latency-step"><div class="latency-dot latency-dot-end"></div><div class="latency-info"><span class="latency-label">Door confirmed</span><span class="latency-time"><TimeStamp iso={timelineMember.kisi_confirmed_at} /></span></div></div>
        </div>
        <div class="latency-total" style={latencyColor(timelineMember.total_s)}>Total: {fmtDuration(timelineMember.total_s)} end to end</div>
      </div>
    {/if}
    {#if timeline && timeline.length}
      <div class="detail-section">
        <div class="detail-section-title">Event history</div>
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
                {#if ev.context && ev.source === 'diagnostic_log'}<details class="timeline-context"><summary>Context</summary><pre>{JSON.stringify(ev.context, null, 2)}</pre></details>{/if}
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

<ConfirmModal bind:open={modalOpen} title="Retry member" body="Re-queue the latest failed job for this member?" on:confirm={handleRetry} />

<style>
  .plan-count-badge { background: rgba(26,111,196,0.10); color: var(--blue); border: 1px solid rgba(26,111,196,0.25); border-radius: 12px; padding: 2px 10px; font-size: 12px; font-weight: 600; cursor: pointer; white-space: nowrap; font-family: inherit; }
  .plan-count-badge:hover { background: rgba(26,111,196,0.18); }
  .plan-row { padding: 10px 0; border-bottom: 1px solid var(--border); }
  .plan-row:last-child { border-bottom: none; }
  .plan-row-main { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .plan-name { font-size: 13px; font-weight: 600; color: var(--text); }
  .plan-row-meta { display: flex; flex-wrap: wrap; gap: 8px; }
  .plan-meta-item { font-size: 11px; color: var(--muted); }
  .latency-timeline { display: flex; flex-direction: column; margin: 8px 0; }
  .latency-step { display: flex; align-items: flex-start; gap: 10px; }
  .latency-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--blue); flex-shrink: 0; margin-top: 3px; }
  .latency-dot-end { background: var(--green); }
  .latency-info { display: flex; flex-direction: column; gap: 1px; padding-bottom: 2px; }
  .latency-label { font-size: 12px; font-weight: 600; color: var(--text); }
  .latency-time { font-size: 11px; color: var(--muted); }
  .latency-gap { display: flex; align-items: center; padding: 2px 0 2px 4px; margin-left: 4px; border-left: 2px dashed var(--border); }
  .latency-gap-label { font-size: 11px; color: var(--muted); margin-left: 10px; font-style: italic; }
  .latency-total { margin-top: 10px; font-size: 13px; font-weight: 700; padding: 8px 12px; background: var(--bg); border-radius: 8px; border: 1px solid var(--border); }
</style>
