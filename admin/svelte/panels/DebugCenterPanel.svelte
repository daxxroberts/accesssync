<!--
  DebugCenterPanel.svelte
  @panel Debug Center
  @route /OwnerDashboard → panel-members
  @api GET /admin/members/search?q=, GET /admin/members/:id/timeline, POST /admin/members/:id/retry
  @components SearchBar, PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Drawer, ConfirmModal
-->
<script>
  import SearchBar    from '../components/SearchBar.svelte';
  import PillBadge    from '../components/PillBadge.svelte';
  import CodeChip     from '../components/CodeChip.svelte';
  import TimeStamp    from '../components/TimeStamp.svelte';
  import LoadingState from '../components/LoadingState.svelte';
  import EmptyState   from '../components/EmptyState.svelte';
  import DataTable    from '../components/DataTable.svelte';
  import Drawer       from '../components/Drawer.svelte';
  import ConfirmModal from '../components/ConfirmModal.svelte';
  import { showToast } from '../stores/toast.js';

  const COLUMNS = ['Member', 'Client', 'Platform', 'Access Status', 'Last Updated', 'Actions'];

  // ── State ──────────────────────────────────────────────────────────
  let query        = '';
  let results      = [];
  let loading      = false;
  let searched     = false;

  let drawerOpen    = false;
  let drawerTitle   = '';
  let drawerLoading = false;
  let timeline      = null;
  let timelineMember = null;
  let drawerMode    = 'timeline'; // 'timeline' | 'diagnose'
  let diagnosis     = null;

  let modalOpen    = false;
  let retryMemberId = null;

  // ── API ──���─────────────────────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function doSearch({ detail }) {
    query = detail.query;
    if (!query) { results = []; searched = false; return; }

    loading  = true;
    searched = true;
    results  = [];
    try {
      const res  = await apiFetch(`/admin/members/search?q=${encodeURIComponent(query)}`);
      const json = await res.json();
      results = json.data || [];
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast('Search failed', 'error');
    } finally {
      loading = false;
    }
  }

  async function openTimeline(member) {
    drawerTitle    = `Timeline: ${member.display_name || member.platform_member_id}`;
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

  async function openDiagnose(member) {
    drawerTitle    = `Diagnose: ${member.display_name || member.platform_member_id}`;
    drawerMode     = 'diagnose';
    drawerLoading  = true;
    drawerOpen     = true;
    diagnosis      = null;
    timeline       = null;
    timelineMember = null;
    try {
      const res  = await apiFetch(`/admin/members/${member.id}/diagnose`);
      diagnosis  = await res.json();
    } catch {
      showToast('Failed to load diagnosis', 'error');
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
      const res  = await apiFetch(`/admin/members/${retryMemberId}/retry`, { method: 'POST' });
      const json = await res.json();
      if (res.ok) {
        showToast(`Queued: ${json.queued}`, 'success');
      } else {
        showToast(`Retry failed: ${json.error}`, 'error');
      }
    } catch {
      showToast('Retry failed', 'error');
    }
  }

  const VERDICT_LABEL = { healthy: 'Healthy', degraded: 'Degraded', failed: 'Failed', mismatch: 'Mismatch' };
  const VERDICT_COLOR = { healthy: 'green', degraded: 'amber', failed: 'red', mismatch: 'red' };
  const FINDING_COLOR = { ok: 'green', warn: 'amber', error: 'red' };
</script>

<!-- ── Search Bar ─────────────────────────────────────────────────── -->
<SearchBar
  placeholder="Search by email, name, or member ID…"
  bind:value={query}
  on:search={doSearch}
/>

<!-- ── Loading ──��────────────────────────────────────────────────── -->
<LoadingState message="Searching…" hidden={!loading} />

<!-- ── Empty States ──────────────────────────────────────────────── -->
{#if !loading && !searched}
  <EmptyState message="Enter a search term to find members">
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

{#if !loading && searched && results.length === 0}
  <EmptyState message={`No members found for "${query}"`}>
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

<!-- ── Results Table ─────────────────────────────────────────────── -->
{#if !loading && results.length > 0}
  <DataTable columns={COLUMNS}>
    {#each results as m (m.id)}
      <tr>
        <td>
          <div>{m.display_name || '<span class="muted">No name</span>'}</div>
          <div class="cell-sub">{m.email || ''}</div>
          <div class="cell-sub"><CodeChip text={m.platform_member_id} full={true} /></div>
        </td>
        <td>{m.client_name || '—'}</td>
        <td>
          <div>{m.source_platform || '—'}</div>
          <div class="cell-sub">{m.hardware_platform || ''}</div>
        </td>
        <td><PillBadge text={m.access_status || 'unknown'} /></td>
        <td><TimeStamp iso={m.updated_at} /></td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-secondary" on:click={() => openTimeline(m)}>Timeline</button>
          <button class="btn btn-sm btn-secondary" on:click={() => openDiagnose(m)}>Diagnose</button>
          <button class="btn btn-sm btn-accent"     on:click={() => openRetryModal(m.id)}>Retry</button>
        </td>
      </tr>
    {/each}
  </DataTable>
{/if}

<!-- ── Drawer (Timeline or Diagnose) ─────────────────────────────── -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />

  {:else if drawerMode === 'diagnose' && diagnosis}
    <!-- ── Verdict banner ── -->
    <div class="detail-section">
      <div class="verdict-banner verdict-{VERDICT_COLOR[diagnosis.verdict]}">
        <strong>{VERDICT_LABEL[diagnosis.verdict]}</strong>
        — {diagnosis.findings.length} finding{diagnosis.findings.length !== 1 ? 's' : ''}
      </div>
    </div>

    <!-- ── Member summary ── -->
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Name</span><span>{diagnosis.member.display_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Email</span><span>{diagnosis.member.email || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Access Status</span><PillBadge text={diagnosis.member.access_status || 'unknown'} /></div>
      <div class="detail-row"><span class="detail-label">Hardware User</span><CodeChip text={diagnosis.member.hardware_user_id || '—'} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Provisioned</span><TimeStamp iso={diagnosis.member.provisioned_at} /></div>
    </div>

    <!-- ── Findings ── -->
    <div class="detail-section">
      <div class="detail-section-title">Findings</div>
      {#each diagnosis.findings as f}
        <div class="finding finding-{FINDING_COLOR[f.level]}">
          <CodeChip text={f.code} full={true} />
          <div class="finding-msg">{f.message}</div>
          {#if f.at}<div class="finding-time"><TimeStamp iso={f.at} /></div>{/if}
          {#if f.context}
            <details class="timeline-context">
              <summary>Context</summary>
              <pre>{JSON.stringify(f.context, null, 2)}</pre>
            </details>
          {/if}
        </div>
      {/each}
    </div>

    <!-- ── Sources ── -->
    {#if diagnosis.sources.length > 0}
      <div class="detail-section">
        <div class="detail-section-title">Access Sources ({diagnosis.sources.length})</div>
        {#each diagnosis.sources as src}
          <div class="detail-row">
            <span class="detail-label">{src.plan_name || src.source_plan_id}</span>
            <span><PillBadge text={src.mapping_status || 'ok'} /></span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- ── Roles ── -->
    {#if diagnosis.roles.length > 0}
      <div class="detail-section">
        <div class="detail-section-title">Hardware Roles ({diagnosis.roles.length})</div>
        {#each diagnosis.roles as role}
          <div class="detail-row">
            <span class="detail-label">{role.plan_name || role.mapping_id}</span>
            <CodeChip text={role.role_assignment_id} full={true} />
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
                {#if ev.detail}
                  <div class="timeline-detail">{ev.detail}</div>
                {/if}
                {#if ev.context && ev.source === 'diagnostic_log'}
                  <details class="timeline-context">
                    <summary>Context</summary>
                    <pre>{JSON.stringify(ev.context, null, 2)}</pre>
                  </details>
                {/if}
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

<!-- ── Retry Confirm Modal ───────────────────────────────────────── -->
<ConfirmModal
  bind:open={modalOpen}
  title="Retry Member"
  body="Re-queue the latest failed job for this member?"
  on:confirm={handleRetry}
/>
