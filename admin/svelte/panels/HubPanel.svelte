<!--
  HubPanel.svelte
  @panel Owner Hub (landing)
  @route /OwnerDashboard → panel-hub
  @api GET /admin/system-health, GET /admin/queue/counts, POST /admin/clients/:id/invite (via InviteLinkModal)
  @components LoadingState, TimeStamp, InviteLinkModal

  The one question: "Is AccessSync working for every gym, and is there anything only I can fix?"
    1. Verdict line, first thing on the page.
    2. One row per gym that isn't OK: what's broken, who acts (You / The gym), since when, a button that opens the gym.
       Rows that need you come first, then the oldest.
    3. Healthy gyms fold into chips.
    4. Platform row only when something is wrong (database, job queue, background jobs, errors tied to no gym).
  The page grows with the number of problems, not the number of gyms.
-->
<script>
  import { onMount, onDestroy } from 'svelte';
  import LoadingState    from '../components/LoadingState.svelte';
  import TimeStamp       from '../components/TimeStamp.svelte';
  import InviteLinkModal from '../components/InviteLinkModal.svelte';
  import { showToast }   from '../stores/toast.js';

  let h = null;
  let queue = null;
  let loading = true;
  let loadError = null;
  let lastLoaded = 0;
  let checkedAt = null;

  let inviteOpen = false;
  let inviteClient = { id: '', name: '' };

  async function apiFetch(url) {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  export async function load() {
    loading = !h;
    loadError = null;
    try {
      const [hr, qr] = await Promise.all([
        apiFetch('/admin/system-health').then(r => r.json().then(b => ({ ok: r.ok, status: r.status, body: b }))),
        apiFetch('/admin/queue/counts').then(r => r.json().then(b => ({ ok: r.ok, body: b }))).catch(() => ({ ok: false, body: null })),
      ]);
      if (!hr.ok) throw new Error(hr.body.error || `HTTP ${hr.status}`);
      h = hr.body;
      queue = qr.ok ? qr.body : null;
      checkedAt = new Date().toISOString();
      lastLoaded = Date.now();
    } catch (err) {
      if (err.message === 'Unauthorized') return;
      loadError = err.message;
      if (h) showToast(`Could not refresh: ${err.message}`, 'error');
    } finally {
      loading = false;
    }
  }

  // Platform rows the route cannot see: the job queue lives in Redis, read client-side.
  $: queueRows = !queue ? [] : [
    ...(queue.failed > 0 ? [{ kind: 'queue', owner: 'you', severity: 'red', text: `${queue.failed} job${queue.failed === 1 ? '' : 's'} failed in the queue`, link: '/OwnerDashboard?panel=errors' }] : []),
    ...((queue.waiting || 0) + (queue.delayed || 0) > 50 ? [{ kind: 'queue', owner: 'you', severity: 'amber', text: `${(queue.waiting || 0) + (queue.delayed || 0)} jobs waiting in the queue` }] : []),
  ];
  $: platformRows = h ? [...h.platform, ...queueRows] : [];
  $: verdict = !h ? 'unknown' : (platformRows.some(r => r.severity === 'red') ? 'red' : (platformRows.length && h.verdict === 'green' ? 'amber' : h.verdict));

  // "AccessSync must fix" rows are the owner's: open the owner Errors tab, which lists the same members the row
  // counted (GET /admin/errors → listStuckMembers). The gym-facing /errors link stays on the row for the emails.
  const rowLink = (p) => (p.kind === 'errors_you' ? '/OwnerDashboard?panel=errors' : p.link);

  function rel(iso) {
    if (!iso) return '';
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
    const hh = Math.floor(m / 60); if (hh < 48) return `${hh}h ago`;
    const d = Math.floor(hh / 24); if (d < 60) return `${d}d ago`;
    return `${Math.floor(d / 30)}mo ago`;
  }

  function openInvite(row) {
    inviteClient = { id: row.client_id, name: row.client_name };
    inviteOpen = true;
  }

  // Reload when the shell shows this panel again (no polling while hidden).
  function onShown(e) {
    if (e.detail === 'hub' && Date.now() - lastLoaded > 30_000) load();
  }

  onMount(() => { load(); window.addEventListener('panel:shown', onShown); });
  onDestroy(() => window.removeEventListener('panel:shown', onShown));
</script>

<div class="hub">
  {#if loading}
    <LoadingState message="Checking every gym…" />
  {:else if loadError && !h}
    <div class="hub-verdict state-amber">
      <span class="hub-dot"></span>
      <div>
        <div class="hub-verdict-text">Health check could not load</div>
        <div class="hub-verdict-sub">{loadError} · <button class="link-btn" on:click={load}>Try again</button></div>
      </div>
    </div>
  {:else}
    <!-- 1. Verdict -->
    <div class="hub-verdict state-{verdict}">
      <span class="hub-dot"></span>
      <div>
        <div class="hub-verdict-text">{h.verdict_line}</div>
        <div class="hub-verdict-sub">
          Checked {rel(checkedAt)} · <button class="link-btn" on:click={load}>Refresh</button>
          {#if h.summary.gyms_inactive}· {h.summary.gyms_inactive} inactive gym{h.summary.gyms_inactive === 1 ? '' : 's'} not counted{/if}
        </div>
      </div>
    </div>

    {#if h.check_failed}
      <div class="hub-banner">{h.check_failed}</div>
    {/if}

    <!-- 2. One row per problem -->
    {#if h.problems.length}
      <ul class="hub-rows">
        {#each h.problems as p (p.client_id + ':' + p.kind)}
          <li class="hub-row sev-{p.severity}">
            <span class="owner-tag {p.owner}">{p.owner === 'you' ? 'You' : 'The gym'}</span>
            <div class="hub-row-main">
              <div class="hub-row-text">{p.text}</div>
              <div class="hub-row-meta">
                <strong>{p.client_name}</strong>
                {#if p.since}· since <TimeStamp iso={p.since} /> ({rel(p.since)}){/if}
              </div>
            </div>
            {#if p.action === 'invite'}
              <button class="btn btn-sm btn-accent" on:click={() => openInvite(p)}>Send setup link</button>
            {:else if p.link}
              <a class="btn btn-sm btn-secondary" href={rowLink(p)}>Open</a>
            {:else}
              <a class="btn btn-sm btn-secondary" href={'/dashboard?clientId=' + encodeURIComponent(p.client_id)}>Open gym</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <!-- 3. Healthy gyms -->
    {#if h.healthy.length}
      <div class="hub-section-title">{h.problems.length ? 'OK' : 'Every gym'}</div>
      <div class="hub-chips">
        {#each h.healthy as g (g.client_id)}
          <a class="hub-chip" href={'/dashboard?clientId=' + encodeURIComponent(g.client_id)}
             title={'Last sale ' + (g.last_webhook_at ? rel(g.last_webhook_at) : 'never') + ' · last sync ' + (g.last_success_at ? rel(g.last_success_at) : 'never')}>
            ✓ {g.client_name}
          </a>
        {/each}
      </div>
    {/if}

    {#if !h.problems.length && !h.healthy.length && !platformRows.length}
      <div class="hub-empty">No gyms yet. Add one under Manage gyms.</div>
    {/if}

    <!-- 4. Platform, only when something is wrong -->
    {#if platformRows.length}
      <div class="hub-section-title">Platform</div>
      <ul class="hub-rows">
        {#each platformRows as r (r.kind + r.text)}
          <li class="hub-row sev-{r.severity}">
            <span class="owner-tag you">You</span>
            <div class="hub-row-main">
              <div class="hub-row-text">{r.text}</div>
              {#if r.since}<div class="hub-row-meta">since <TimeStamp iso={r.since} /></div>{/if}
            </div>
            {#if r.link}<a class="btn btn-sm btn-secondary" href={r.link}>Open</a>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</div>

<InviteLinkModal bind:open={inviteOpen} clientId={inviteClient.id} clientName={inviteClient.name} />
