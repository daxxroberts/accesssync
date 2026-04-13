<!--
  QueuePanel.svelte
  @panel Queue Monitor
  @route /OwnerDashboard → panel-queue
  @api GET /admin/queue/counts, GET /admin/queue/jobs?state=
  @polling 5s for counts
  @components StatCard, PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  import StatCard     from '../components/StatCard.svelte';
  import PillBadge    from '../components/PillBadge.svelte';
  import CodeChip     from '../components/CodeChip.svelte';
  import TimeStamp    from '../components/TimeStamp.svelte';
  import LoadingState from '../components/LoadingState.svelte';
  import EmptyState   from '../components/EmptyState.svelte';
  import DataTable    from '../components/DataTable.svelte';
  import { showToast } from '../stores/toast.js';

  // ── State ──────────────────────────────────────────────────────────
  const TABS = ['waiting', 'active', 'failed', 'completed', 'delayed'];

  let counts     = { waiting: '—', active: '—', completed: '—', failed: '—', delayed: '—', paused: '—' };
  let currentTab = 'waiting';
  let jobs       = [];
  let loading    = false;
  let pollTimer;

  const JOB_COLUMNS = ['Job ID', 'Name', 'Tenant', 'Event Type', 'Member ID', 'Attempts', 'Processed', 'Failure Reason'];

  // ── API ────────────────────────────────────────────────────────────
  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function loadCounts() {
    try {
      const res    = await apiFetch('/admin/queue/counts');
      const data   = await res.json();
      counts = {
        waiting:   data.waiting   ?? '0',
        active:    data.active    ?? '0',
        completed: data.completed ?? '0',
        failed:    data.failed    ?? '0',
        delayed:   data.delayed   ?? '0',
        paused:    data.paused    ?? '0',
      };
    } catch (err) {
      if (err.message === 'Unauthorized') clearInterval(pollTimer);
    }
  }

  async function loadJobs(tab) {
    currentTab = tab;
    loading    = true;
    jobs       = [];
    try {
      const res  = await apiFetch(`/admin/queue/jobs?state=${tab}`);
      const json = await res.json();
      jobs = json.data || [];
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast('Failed to load jobs', 'error');
    } finally {
      loading = false;
    }
  }

  function processedAt(j) {
    return j.processedOn ? new Date(j.processedOn).toISOString() : null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────
  onMount(() => {
    loadCounts();
    loadJobs(currentTab);
    pollTimer = setInterval(loadCounts, 5000);
  });

  onDestroy(() => clearInterval(pollTimer));
</script>

<!-- ── Stat Cards ──────────────────────────────────────────────── -->
<div class="stat-cards">
  <StatCard label="Waiting"   value={counts.waiting} />
  <StatCard label="Active"    value={counts.active}    color="accent" />
  <StatCard label="Completed" value={counts.completed} color="success" />
  <StatCard label="Failed"    value={counts.failed}    color="danger" />
  <StatCard label="Delayed"   value={counts.delayed} />
  <StatCard label="Paused"    value={counts.paused} />
</div>

<!-- ── Tab Bar ─────────────────────────────────────────────────── -->
<div class="queue-jobs-section">
  <div class="queue-tabs">
    {#each TABS as tab}
      <button
        class="queue-tab"
        class:active={currentTab === tab}
        on:click={() => loadJobs(tab)}
      >
        {tab.charAt(0).toUpperCase() + tab.slice(1)}
      </button>
    {/each}
  </div>

  <!-- ── Loading / Empty / Table ──────────────────────────────── -->
  <LoadingState message="Loading jobs…" hidden={!loading} />

  {#if !loading && jobs.length === 0}
    <EmptyState message="No jobs in this state" />
  {/if}

  {#if !loading && jobs.length > 0}
    <DataTable columns={JOB_COLUMNS}>
      {#each jobs as j (j.id)}
        <tr>
          <td><CodeChip text={String(j.id)} /></td>
          <td><PillBadge text={j.name} /></td>
          <td><CodeChip text={j.tenantId} /></td>
          <td><CodeChip text={j.eventType} /></td>
          <td><CodeChip text={j.memberId} /></td>
          <td>{j.attemptsMade ?? '—'}</td>
          <td><TimeStamp iso={processedAt(j)} /></td>
          <td class="reason-cell" title={j.failedReason || ''}>{j.failedReason || '—'}</td>
        </tr>
      {/each}
    </DataTable>
  {/if}
</div>
