<!--
  ClientsPanel.svelte
  @panel Clients
  @route /OwnerDashboard → panel-clients
  @api GET /admin/clients, GET /admin/clients/:id/api-key/status, GET /admin/clients/:id/audit,
       PATCH /admin/clients/:id, POST /admin/clients/:id/api-key, GET /admin/clients/:id/api-key/test,
       POST /admin/clients/:id/archive, POST /admin/clients/:id/restore, DELETE /admin/clients/:id,
       GET /admin/clients/:id/dependencies
  @components SearchBar, PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Drawer, ConfirmModal
-->
<script>
  import { onMount }   from 'svelte';
  import SearchBar     from '../components/SearchBar.svelte';
  import PillBadge     from '../components/PillBadge.svelte';
  import CodeChip      from '../components/CodeChip.svelte';
  import TimeStamp     from '../components/TimeStamp.svelte';
  import LoadingState  from '../components/LoadingState.svelte';
  import EmptyState    from '../components/EmptyState.svelte';
  import DataTable     from '../components/DataTable.svelte';
  import Drawer        from '../components/Drawer.svelte';
  import ConfirmModal  from '../components/ConfirmModal.svelte';
  import { showToast } from '../stores/toast.js';

  const COLUMNS = ['Client', 'Platform', 'Hardware', 'Tier', 'Members', 'Status', 'Last Sync', 'Actions'];

  // ── State ──────────────────────────────────────────────────────────
  let allClients   = [];
  let filtered     = [];
  let loading      = false;
  let statusFilter = 'active';
  let searchQuery  = '';

  // Drawer modes: 'detail' | 'edit' | 'apikey'
  let drawerOpen    = false;
  let drawerTitle   = '';
  let drawerLoading = false;
  let drawerMode    = 'detail';
  let activeClient  = null;
  let hasKey        = null;
  let auditEntries  = [];

  // Edit form fields
  let editName              = '';
  let editHardwarePlatform  = '';
  let editTier              = '';
  let editSiteName          = '';
  let editSiteId            = '';
  let editNotificationEmail = '';
  let editStatus            = '';

  // API key form
  let apiKeyInput   = '';
  let testingKey    = false;

  // Confirm modal
  let modalOpen   = false;
  let modalTitle  = '';
  let modalBody   = '';
  let modalAction = null;

  // ── Filter logic ───────────────────────────────────────────────────
  $: filtered = allClients.filter(c => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (c.name || '').toLowerCase().includes(q)
      || (c.source_site_name || '').toLowerCase().includes(q)
      || (c.source_site_id || '').toLowerCase().includes(q)
      || (c.notification_email || '').toLowerCase().includes(q);
  });

  // ── API ────────────────────────────────────────────────────────────
  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }

  async function load() {
    loading    = true;
    allClients = [];
    try {
      const res  = await apiFetch(`/admin/clients?status=${statusFilter}`);
      const json = await res.json();
      allClients = json.data || [];
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast('Failed to load clients', 'error');
    } finally {
      loading = false;
    }
  }

  // ── Detail Drawer ──────────────────────────────────────────────────
  async function openDetail(client) {
    drawerMode    = 'detail';
    drawerTitle   = `Client: ${client.name}`;
    drawerLoading = true;
    drawerOpen    = true;
    activeClient  = client;
    hasKey        = null;
    auditEntries  = [];
    try {
      const [keyRes, auditRes] = await Promise.all([
        apiFetch(`/admin/clients/${client.id}/api-key/status`).then(r => r.json()).catch(() => ({ hasKey: null })),
        apiFetch(`/admin/clients/${client.id}/audit?limit=10`).then(r => r.json()).catch(() => ({ data: [] })),
      ]);
      hasKey       = keyRes.hasKey;
      auditEntries = auditRes.data || [];
    } catch { /* non-critical */ } finally {
      drawerLoading = false;
    }
  }

  // ── Edit Drawer ────────────────────────────────────────────────────
  function openEdit(client) {
    activeClient          = client;
    drawerMode            = 'edit';
    drawerTitle           = `Edit: ${client.name}`;
    drawerOpen            = true;
    editName              = client.name              || '';
    editHardwarePlatform  = (client.connector && client.connector.platform) || '';
    editTier              = (client.billing && client.billing.tier) || '';
    editSiteName          = client.source_site_name   || '';
    editSiteId            = client.source_site_id           || '';
    editNotificationEmail = client.notification_email || '';
    editStatus            = client.status            || 'active';
  }

  async function saveEdit() {
    try {
      const res = await apiFetch(`/admin/clients/${activeClient.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editName, hardware_platform: editHardwarePlatform, tier: editTier,
          source_site_name: editSiteName, source_site_id: editSiteId,
          notification_email: editNotificationEmail, status: editStatus,
        }),
      });
      if (res.ok) { showToast('Client updated', 'success'); drawerOpen = false; load(); }
      else { const j = await res.json(); showToast(`Save failed: ${j.error}`, 'error'); }
    } catch { showToast('Save failed', 'error'); }
  }

  // ── API Key Drawer ─────────────────────────────────────────────────
  function openApiKey(client) {
    activeClient = client;
    drawerMode   = 'apikey';
    drawerTitle  = `API Key: ${client.name}`;
    drawerOpen   = true;
    apiKeyInput  = '';
  }

  async function testKey() {
    testingKey = true;
    try {
      const res = await apiFetch(`/admin/clients/${activeClient.id}/api-key/test`);
      const j   = await res.json();
      j.valid
        ? showToast('✓ Key valid — connected successfully', 'success')
        : showToast(`✗ Key invalid — ${j.error || 'rejected'}`, 'error');
    } catch { showToast('Test failed', 'error'); }
    finally { testingKey = false; }
  }

  async function saveApiKey() {
    if (!apiKeyInput.trim()) { showToast('API key cannot be empty', 'error'); return; }
    try {
      const res = await apiFetch(`/admin/clients/${activeClient.id}/api-key`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKeyInput.trim() }),
      });
      if (res.ok) { showToast('API key saved', 'success'); openDetail(activeClient); }
      else { const j = await res.json().catch(() => ({})); showToast(`Save failed: ${j.error || 'unknown'}`, 'error'); }
    } catch { showToast('Save failed', 'error'); }
  }

  // ── Archive / Restore / Delete ─────────────────────────────────────
  function confirmArchive(client) {
    modalTitle  = 'Archive Client';
    modalBody   = `Archive "${client.name}"? The client will be hidden from the default list but all data is preserved. You can restore it later.`;
    modalAction = async () => {
      const res = await apiFetch(`/admin/clients/${client.id}/archive`, { method: 'POST' });
      if (res.ok) { showToast(`${client.name} archived`, 'success'); drawerOpen = false; load(); }
      else { const j = await res.json().catch(() => ({})); showToast(`Archive failed: ${j.error || 'unknown'}`, 'error'); }
    };
    modalOpen = true;
  }

  function confirmRestore(client) {
    modalTitle  = 'Restore Client';
    modalBody   = `Restore "${client.name}" to active status?`;
    modalAction = async () => {
      const res = await apiFetch(`/admin/clients/${client.id}/restore`, { method: 'POST' });
      if (res.ok) { showToast('Client restored', 'success'); drawerOpen = false; load(); }
      else { const j = await res.json().catch(() => ({})); showToast(`Restore failed: ${j.error || 'unknown'}`, 'error'); }
    };
    modalOpen = true;
  }

  async function confirmDelete(client) {
    try {
      const depRes = await apiFetch(`/admin/clients/${client.id}/dependencies`);
      const deps   = await depRes.json();
      const d      = deps.dependencies || {};
      const summary = [
        d.locations    && `${d.locations} location(s)`,
        d.members      && `${d.members} member(s)`,
        d.plan_mappings && `${d.plan_mappings} plan mapping(s)`,
        d.access_logs  && `${d.access_logs} access log(s)`,
        d.error_queue  && `${d.error_queue} error(s)`,
      ].filter(Boolean).join(', ');

      const confirmStr = `DELETE ${client.name}`;
      // Use native prompt for delete — requires exact string match
      const input = prompt(
        `PERMANENT DELETION\n\nThis will permanently delete "${client.name}" and all related data:\n${summary || 'No related records'}\n\nThis cannot be undone. Type "${confirmStr}" to confirm:`
      );
      if (!input || input !== confirmStr) {
        if (input !== null) showToast('Deletion cancelled — confirmation text did not match', 'error');
        return;
      }
      const res = await apiFetch(`/admin/clients/${client.id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmStr }),
      });
      if (res.ok) { showToast(`"${client.name}" permanently deleted`, 'success'); drawerOpen = false; load(); }
      else { const j = await res.json().catch(() => ({})); showToast(`Delete failed: ${j.error || 'unknown'}`, 'error'); }
    } catch { showToast('Delete failed', 'error'); }
  }

  async function handleModalConfirm() {
    try { await modalAction(); } catch { showToast('Action failed', 'error'); }
  }

  onMount(load);
</script>

<!-- ── Toolbar ────────────────────────────────────────────────────── -->
<div style="display:flex;gap:10px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
  <SearchBar
    placeholder="Search clients…"
    bind:value={searchQuery}
    on:search={e => searchQuery = e.detail.query}
    style="flex:1;max-width:320px;"
  />
  <select class="form-input" style="width:auto;padding:8px 12px;font-size:13px;"
    bind:value={statusFilter} on:change={() => load()}>
    <option value="active">Active</option>
    <option value="archived">Archived</option>
    <option value="all">All</option>
  </select>
  <button class="btn btn-secondary btn-sm" on:click={load}>Refresh</button>
  <a href="/onboard.html" class="btn btn-accent btn-sm">Generate invite link</a>
</div>

<!-- ── Loading / Empty / Table ───────────────────────────────────── -->
<LoadingState message="Loading clients…" hidden={!loading} />

{#if !loading && filtered.length === 0}
  <EmptyState message="No clients found">
    <svelte:fragment slot="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      </svg>
    </svelte:fragment>
  </EmptyState>
{/if}

{#if !loading && filtered.length > 0}
  <DataTable columns={COLUMNS}>
    {#each filtered as c (c.id)}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <tr class="clickable-row" on:click={e => { if (!e.target.closest('.actions-cell')) openDetail(c); }}>
        <td>
          <div>{c.name}</div>
          {#if c.source_site_name}<div class="cell-sub">{c.source_site_name}</div>{/if}
          {#if c.source_site_id}<div class="cell-sub"><CodeChip text={c.source_site_id} /></div>{/if}
        </td>
        <td>{#if c.platform}<PillBadge text={c.platform} type="info" />{:else}<span class="muted">—</span>{/if}</td>
        <td>{#if c.connector && c.connector.platform}<PillBadge text={c.connector.platform} type="muted" />{:else}<span class="muted">—</span>{/if}</td>
        <td>{(c.billing && c.billing.tier) || '—'}</td>
        <td>
          <span title="{c.active_count} active">{c.member_count} total</span>
          {#if c.active_count > 0}<div class="cell-sub">{c.active_count} active</div>{/if}
        </td>
        <td><PillBadge text={c.status || 'active'} /></td>
        <td><TimeStamp iso={c.last_sync_at} /></td>
        <td class="actions-cell" on:click|stopPropagation>
          <button class="btn btn-sm btn-secondary" on:click={() => openEdit(c)}>Edit</button>
          <button class="btn btn-sm btn-accent"
            on:click={() => window.open(`/dashboard?clientId=${encodeURIComponent(c.id)}`, '_blank')}>
            Dashboard
          </button>
        </td>
      </tr>
    {/each}
  </DataTable>
{/if}

<!-- ── Drawer ─────────────────────────────────────────────────────── -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />

  {:else if drawerMode === 'detail' && activeClient}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Name</span><span>{activeClient.name}</span></div>
      <div class="detail-row">
        <span class="detail-label">Status</span>
        <PillBadge text={activeClient.status || 'active'} />
        {#if activeClient.archived_at}
          <span style="font-size:11px;color:var(--neutral-400);margin-left:8px;">
            Archived <TimeStamp iso={activeClient.archived_at} />
          </span>
        {/if}
      </div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>{activeClient.platform || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Hardware</span><span>{(activeClient.connector && activeClient.connector.platform) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Tier</span><span>{(activeClient.billing && activeClient.billing.tier) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Site ID</span><CodeChip text={activeClient.source_site_id} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Site Name</span><span>{activeClient.source_site_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Notification Email</span><span>{activeClient.notification_email || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Members</span><span>{activeClient.member_count} total, {activeClient.active_count} active</span></div>
      <div class="detail-row"><span class="detail-label">Last Sync</span><TimeStamp iso={activeClient.last_sync_at} /></div>
      <div class="detail-row"><span class="detail-label">Created</span><TimeStamp iso={activeClient.created_at} /></div>
      <div class="detail-row">
        <span class="detail-label">API Key</span>
        <span style={hasKey === false ? 'opacity:0.5' : ''}>
          {hasKey === true ? '••••••••' : hasKey === false ? 'Not set' : '—'}
        </span>
        <div style="margin-left:auto;display:flex;gap:6px;">
          {#if hasKey}
            <button class="btn btn-sm btn-secondary" on:click={testKey} disabled={testingKey}>
              {testingKey ? 'Testing…' : 'Test Key'}
            </button>
          {/if}
          <button class="btn btn-sm btn-secondary" on:click={() => openApiKey(activeClient)}>
            {hasKey ? 'Rotate Key' : 'Set Key'}
          </button>
        </div>
      </div>
    </div>

    {#if auditEntries.length > 0}
      <div class="detail-section" style="margin-top:16px;">
        <div style="font-size:12px;font-weight:700;color:var(--neutral-400);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Audit History</div>
        {#each auditEntries as a (a.id)}
          <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--neutral-100);font-size:12px;">
            <span style="color:var(--neutral-600)">{a.admin_action || a.event_type}</span>
            <span style="color:var(--neutral-400)"><TimeStamp iso={a.created_at} /></span>
          </div>
        {/each}
      </div>
    {/if}

    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => openEdit(activeClient)}>Edit Client</button>
      <button class="btn btn-accent"
        on:click={() => window.open(`/dashboard?clientId=${encodeURIComponent(activeClient.id)}`, '_blank')}>
        Open Dashboard
      </button>
      {#if activeClient.status === 'archived'}
        <button class="btn btn-sm btn-secondary" on:click={() => confirmRestore(activeClient)}>Restore</button>
      {:else}
        <button class="btn btn-sm btn-secondary" style="color:var(--amber-600)"
          on:click={() => confirmArchive(activeClient)}>Archive</button>
      {/if}
      <button class="btn btn-sm" style="background:var(--red-50);color:var(--red-600)"
        on:click={() => confirmDelete(activeClient)}>Delete</button>
    </div>

  {:else if drawerMode === 'edit' && activeClient}
    <div class="detail-section">
      <div class="form-field"><label for="edit-name">Name</label>
        <input id="edit-name" type="text" class="form-input" bind:value={editName} /></div>
      <div class="form-field"><label for="edit-hw">Hardware Platform</label>
        <select id="edit-hw" class="form-input" bind:value={editHardwarePlatform}>
          <option value="">— Select —</option>
          <option value="kisi">Kisi</option>
          <option value="seam">Seam</option>
        </select></div>
      <div class="form-field"><label for="edit-tier">Tier</label>
        <select id="edit-tier" class="form-input" bind:value={editTier}>
          <option value="">— Select —</option>
          <option value="Base">Base</option>
          <option value="Pro">Pro</option>
          <option value="Connect">Connect</option>
        </select></div>
      <div class="form-field"><label for="edit-sitename">Site Name</label>
        <input id="edit-sitename" type="text" class="form-input" bind:value={editSiteName} /></div>
      <div class="form-field"><label for="edit-siteid">Site ID</label>
        <input id="edit-siteid" type="text" class="form-input" bind:value={editSiteId} /></div>
      <div class="form-field"><label for="edit-email">Notification Email</label>
        <input id="edit-email" type="email" class="form-input" bind:value={editNotificationEmail} /></div>
      <div class="form-field"><label for="edit-status">Status</label>
        <select id="edit-status" class="form-input" bind:value={editStatus}>
          <option value="active">Active</option>
          <option value="cancelled">Cancelled</option>
          <option value="archived">Archived</option>
        </select></div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => drawerOpen = false}>Cancel</button>
      <button class="btn btn-accent" on:click={saveEdit}>Save Changes</button>
    </div>

  {:else if drawerMode === 'apikey' && activeClient}
    <div class="detail-section">
      <p style="font-size:0.85rem;color:var(--neutral-500);margin-bottom:1rem;">
        Write-only. Once saved, the key cannot be viewed — only rotated. Encrypted at rest (AES-256-GCM).
      </p>
      <div class="form-field">
        <label for="api-key-input">Hardware API Key</label>
        <input id="api-key-input" type="password" class="form-input" bind:value={apiKeyInput}
          placeholder="Paste API key…" autocomplete="off" />
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => openDetail(activeClient)}>Back</button>
      <button class="btn btn-accent" on:click={saveApiKey}>Save Key</button>
    </div>
  {/if}
</Drawer>

<!-- ── Confirm Modal ──────────────────────────────────────────────── -->
<ConfirmModal
  bind:open={modalOpen}
  title={modalTitle}
  body={modalBody}
  on:confirm={handleModalConfirm}
/>
