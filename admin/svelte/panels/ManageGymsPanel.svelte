<!--
  ManageGymsPanel.svelte
  @panel Manage gyms
  @route /OwnerDashboard → panel-gyms
  @api GET /admin/clients, POST /admin/clients, PATCH /admin/clients/:id, POST /admin/clients/:id/invite,
       GET /admin/clients/:id/api-key/status, GET /admin/clients/:id/api-key/test, POST /admin/clients/:id/api-key,
       POST /admin/clients/:id/archive, POST /admin/clients/:id/restore, DELETE /admin/clients/:id, GET /admin/clients/:id/dependencies
  @components SearchBar, PillBadge, CodeChip, TimeStamp, LoadingState, EmptyState, DataTable, Drawer, ConfirmModal, InviteLinkModal

  Account management, not health (health is the Hub). Every client action in one place: New client, Setup link,
  Dashboard, Edit, Key (set / rotate / test), Archive or Restore, Delete (typed confirmation).
  Replaces the Clients panel and the Admin tab's Clients section.
-->
<script>
  import { onMount }     from 'svelte';
  import SearchBar       from '../components/SearchBar.svelte';
  import PillBadge       from '../components/PillBadge.svelte';
  import CodeChip        from '../components/CodeChip.svelte';
  import TimeStamp       from '../components/TimeStamp.svelte';
  import LoadingState    from '../components/LoadingState.svelte';
  import EmptyState      from '../components/EmptyState.svelte';
  import DataTable       from '../components/DataTable.svelte';
  import Drawer          from '../components/Drawer.svelte';
  import ConfirmModal    from '../components/ConfirmModal.svelte';
  import InviteLinkModal from '../components/InviteLinkModal.svelte';
  import { showToast }   from '../stores/toast.js';

  const COLUMNS = ['Gym', 'Tier', 'Members', 'Status', 'Last sync', 'Actions'];
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  let allClients = [];
  let loading = false;
  let statusFilter = 'active';
  let searchQuery = '';
  $: filtered = allClients.filter(c => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return [c.name, c.source_site_name, c.source_site_id, c.notification_email].some(v => (v || '').toLowerCase().includes(q));
  });

  // Drawer: 'detail' | 'edit' | 'apikey'
  let drawerOpen = false, drawerTitle = '', drawerLoading = false, drawerMode = 'detail';
  let activeClient = null, hasKey = null, testingKey = false, apiKeyInput = '';
  let edit = {};

  // Modals
  let modalOpen = false, modalTitle = '', modalBody = '', modalAction = null;
  let newOpen = false, newForm = { name: '', email: '', site: '' }, newError = '', newBusy = false;
  let deleteOpen = false, deleteClient = null, deleteInput = '', deleteSummary = '', deleteBusy = false;
  let inviteOpen = false, inviteClient = { id: '', name: '' };

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, { credentials: 'include', ...options });
    if (res.status === 401) throw new Error('Unauthorized');
    return res;
  }
  const json = (res) => res.json().catch(() => ({})).then(b => ({ ok: res.ok, status: res.status, body: b }));
  const post = (url, body) => apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(json);

  export async function load() {
    loading = true;
    try {
      const r = await apiFetch(`/admin/clients?status=${statusFilter}`).then(json);
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      allClients = r.body.data || [];
    } catch (err) {
      if (err.message !== 'Unauthorized') showToast(`Failed to load gyms: ${err.message}`, 'error');
    } finally { loading = false; }
  }

  // ── Detail ───────────────────────────────────────────────────────
  async function openDetail(client) {
    drawerMode = 'detail'; drawerTitle = client.name; drawerLoading = true; drawerOpen = true;
    activeClient = client; hasKey = null;
    try {
      const r = await apiFetch(`/admin/clients/${client.id}/api-key/status`).then(json);
      hasKey = r.ok ? r.body.hasKey : null;
    } catch { /* non-critical */ } finally { drawerLoading = false; }
  }

  // ── Edit ─────────────────────────────────────────────────────────
  function openEdit(client) {
    activeClient = client; drawerMode = 'edit'; drawerTitle = `Edit ${client.name}`; drawerOpen = true;
    edit = {
      name: client.name || '', notification_email: client.notification_email || '',
      source_site_name: client.source_site_name || '', source_site_id: client.source_site_id || '',
      hardware_platform: (client.connector && client.connector.platform) || '', tier: (client.billing && client.billing.tier) || '',
      status: client.status || 'active',
    };
  }
  async function saveEdit() {
    const c = activeClient;
    if (!edit.name.trim()) return showToast('Name is required', 'error');
    if (edit.notification_email && !EMAIL.test(edit.notification_email)) return showToast('Enter a valid email address', 'error');
    if (edit.source_site_id && !UUID.test(edit.source_site_id)) return showToast('That Wix site ID doesn’t look right', 'error');
    const body = {
      name: edit.name.trim(), notification_email: edit.notification_email.trim() || null,
      source_site_name: edit.source_site_name.trim() || null, source_site_id: edit.source_site_id.trim() || null, status: edit.status,
    };
    if (edit.hardware_platform && edit.hardware_platform !== ((c.connector && c.connector.platform) || '')) body.hardware_platform = edit.hardware_platform;
    if (edit.tier !== ((c.billing && c.billing.tier) || '')) body.tier = edit.tier || null;
    try {
      const r = await apiFetch(`/admin/clients/${c.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(json);
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      showToast('Saved', 'success'); drawerOpen = false; load();
    } catch (e) { showToast(`Save failed: ${e.message}`, 'error'); }
  }

  // ── Key ──────────────────────────────────────────────────────────
  function openApiKey(client) { activeClient = client; drawerMode = 'apikey'; drawerTitle = `Door key · ${client.name}`; drawerOpen = true; apiKeyInput = ''; }
  async function testKey() {
    testingKey = true;
    try {
      const r = await apiFetch(`/admin/clients/${activeClient.id}/api-key/test`).then(json);
      r.body.valid ? showToast('Key valid — Kisi accepted it', 'success') : showToast(`Key rejected: ${r.body.error || 'rejected'}`, 'error');
    } catch { showToast('Test failed', 'error'); } finally { testingKey = false; }
  }
  async function saveApiKey() {
    const key = apiKeyInput.trim();
    if (!key) return showToast('Paste the key first', 'error');
    if (key.length < 20) return showToast('That looks too short to be an API key', 'error');
    try {
      const r = await post(`/admin/clients/${activeClient.id}/api-key`, { apiKey: key });
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      showToast('Key saved', 'success'); openDetail(activeClient);
    } catch (e) { showToast(`Save failed: ${e.message}`, 'error'); }
  }

  // ── Archive / Restore ────────────────────────────────────────────
  function confirmArchive(client) {
    modalTitle = 'Archive gym';
    modalBody = `Archive "${client.name}"? It is hidden from the list and every open setup link stops working. All data is kept and you can restore it later.`;
    modalAction = async () => {
      const r = await post(`/admin/clients/${client.id}/archive`);
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      showToast(`${client.name} archived`, 'success'); drawerOpen = false; load();
    };
    modalOpen = true;
  }
  function confirmRestore(client) {
    modalTitle = 'Restore gym';
    modalBody = `Restore "${client.name}" to active?`;
    modalAction = async () => {
      const r = await post(`/admin/clients/${client.id}/restore`);
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      showToast(`${client.name} restored`, 'success'); drawerOpen = false; load();
    };
    modalOpen = true;
  }
  async function handleModalConfirm() { try { await modalAction(); } catch (e) { showToast(`Failed: ${e.message}`, 'error'); } }

  // ── Delete (typed confirmation) ──────────────────────────────────
  async function openDelete(client) {
    deleteClient = client; deleteInput = ''; deleteSummary = ''; deleteOpen = true;
    try {
      const r = await apiFetch(`/admin/clients/${client.id}/dependencies`).then(json);
      const d = (r.body && r.body.dependencies) || {};
      deleteSummary = [
        d.locations && `${d.locations} location(s)`, d.members && `${d.members} member(s)`,
        d.plan_mappings && `${d.plan_mappings} plan mapping(s)`, d.access_logs && `${d.access_logs} access log(s)`, d.error_queue && `${d.error_queue} error(s)`,
      ].filter(Boolean).join(', ') || 'no related records';
    } catch { deleteSummary = 'could not count related records'; }
  }
  $: deleteExpected = deleteClient ? `DELETE ${deleteClient.name}` : '';
  async function confirmDelete() {
    if (!deleteClient || deleteInput !== deleteExpected) return;
    deleteBusy = true;
    try {
      const r = await apiFetch(`/admin/clients/${deleteClient.id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: deleteExpected }) }).then(json);
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      showToast(`"${deleteClient.name}" permanently deleted`, 'success'); deleteOpen = false; drawerOpen = false; load();
    } catch (e) { showToast(`Delete failed: ${e.message}`, 'error'); } finally { deleteBusy = false; }
  }

  // ── New client + setup link ──────────────────────────────────────
  function openNew() { newForm = { name: '', email: '', site: '' }; newError = ''; newOpen = true; }
  async function submitNew() {
    const name = newForm.name.trim(), email = newForm.email.trim(), site = newForm.site.trim();
    if (!name) return (newError = 'Enter the gym or business name.');
    if (!EMAIL.test(email)) return (newError = 'Enter a valid email address.');
    if (site && !UUID.test(site)) return (newError = 'That Wix site ID doesn’t look right — it should look like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx, or leave it blank.');
    newError = ''; newBusy = true;
    try {
      const r = await post('/admin/clients', { name, notification_email: email, source_site_id: site || null });
      if (!r.ok) throw new Error(r.body.error || `HTTP ${r.status}`);
      newOpen = false; load();
      openInvite(r.body.client);
    } catch (e) {
      newError = e.message === 'Site ID already in use' ? 'That Wix site is already connected to another gym.' : `Could not create the gym: ${e.message}`;
    } finally { newBusy = false; }
  }
  function openInvite(client) { inviteClient = { id: client.id, name: client.name }; inviteOpen = true; }

  function onShown(e) { if (e.detail === 'gyms') load(); }
  function onKeydown(e) { if (e.key === 'Escape') { newOpen = false; deleteOpen = false; } }
  onMount(() => { load(); window.addEventListener('panel:shown', onShown); return () => window.removeEventListener('panel:shown', onShown); });
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Toolbar -->
<div class="panel-actions gyms-toolbar">
  <SearchBar placeholder="Search gyms…" bind:value={searchQuery} on:search={e => searchQuery = e.detail.query} />
  <select class="select-sm" bind:value={statusFilter} on:change={load}>
    <option value="active">Active</option>
    <option value="archived">Archived</option>
    <option value="all">All</option>
  </select>
  <button class="btn btn-secondary btn-sm" on:click={load}>Refresh</button>
  <button class="btn btn-accent btn-sm" on:click={openNew}>New gym</button>
</div>

<LoadingState message="Loading gyms…" hidden={!loading} />

{#if !loading && filtered.length === 0}
  <EmptyState message={statusFilter === 'archived' ? 'No archived gyms' : 'No gyms yet — press New gym'} />
{/if}

{#if !loading && filtered.length > 0}
  <DataTable columns={COLUMNS}>
    {#each filtered as c (c.id)}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
      <tr class="clickable-row" on:click={e => { if (!e.target.closest('.actions-cell')) openDetail(c); }}>
        <td>
          <div>{c.name}</div>
          {#if c.source_site_name}<div class="cell-sub">{c.source_site_name}</div>{/if}
          <div class="cell-sub">{c.platform || '—'} · {(c.connector && c.connector.platform) || 'no door system'}</div>
        </td>
        <td>{(c.billing && c.billing.tier) || '—'}</td>
        <td>
          <span>{c.active_count} active</span>
          {#if c.member_count > c.active_count}<div class="cell-sub">{c.member_count - c.active_count} pending</div>{/if}
        </td>
        <td><PillBadge text={c.status || 'active'} /></td>
        <td><TimeStamp iso={c.last_sync_at} /></td>
        <td class="actions-cell" on:click|stopPropagation>
          {#if c.status === 'archived'}
            <button class="btn btn-sm btn-secondary" on:click={() => confirmRestore(c)}>Restore</button>
            <button class="btn btn-sm btn-danger" on:click={() => openDelete(c)}>Delete</button>
          {:else}
            <button class="btn btn-sm btn-accent" on:click={() => openInvite(c)}>Setup link</button>
            <a class="btn btn-sm btn-secondary" href={'/dashboard?clientId=' + encodeURIComponent(c.id)}>Dashboard</a>
            <button class="btn btn-sm btn-secondary" on:click={() => openEdit(c)}>Edit</button>
            <button class="btn btn-sm btn-secondary" on:click={() => openApiKey(c)}>Key</button>
          {/if}
        </td>
      </tr>
    {/each}
  </DataTable>
{/if}

<!-- Drawer -->
<Drawer bind:open={drawerOpen} title={drawerTitle}>
  {#if drawerLoading}
    <LoadingState message="Loading…" />
  {:else if drawerMode === 'detail' && activeClient}
    <div class="detail-section">
      <div class="detail-row"><span class="detail-label">Status</span><PillBadge text={activeClient.status || 'active'} />
        {#if activeClient.archived_at}<span class="muted" style="margin-left:8px;font-size:11px">archived <TimeStamp iso={activeClient.archived_at} /></span>{/if}</div>
      <div class="detail-row"><span class="detail-label">Platform</span><span>{activeClient.platform || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Door system</span><span>{(activeClient.connector && activeClient.connector.platform) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Tier</span><span>{(activeClient.billing && activeClient.billing.tier) || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Wix site ID</span><CodeChip text={activeClient.source_site_id} full={true} /></div>
      <div class="detail-row"><span class="detail-label">Wix site</span><span>{activeClient.source_site_name || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Notification email</span><span>{activeClient.notification_email || '—'}</span></div>
      <div class="detail-row"><span class="detail-label">Members</span><span>{activeClient.active_count} active, {activeClient.member_count} managed</span></div>
      <div class="detail-row"><span class="detail-label">Last sync</span><TimeStamp iso={activeClient.last_sync_at} /></div>
      <div class="detail-row"><span class="detail-label">Created</span><TimeStamp iso={activeClient.created_at} /></div>
      <div class="detail-row">
        <span class="detail-label">Door key</span>
        <span class:muted={hasKey === false}>{hasKey === true ? '••••••••' : hasKey === false ? 'Not set' : '—'}</span>
        <div style="margin-left:auto;display:flex;gap:6px;">
          {#if hasKey}<button class="btn btn-sm btn-secondary" on:click={testKey} disabled={testingKey}>{testingKey ? 'Testing…' : 'Test key'}</button>{/if}
          <button class="btn btn-sm btn-secondary" on:click={() => openApiKey(activeClient)}>{hasKey ? 'Replace key' : 'Set key'}</button>
        </div>
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => openEdit(activeClient)}>Edit</button>
      <a class="btn btn-accent" href={'/dashboard?clientId=' + encodeURIComponent(activeClient.id)}>Open dashboard</a>
      {#if activeClient.status === 'archived'}
        <button class="btn btn-sm btn-secondary" on:click={() => confirmRestore(activeClient)}>Restore</button>
      {:else}
        <button class="btn btn-sm btn-secondary" on:click={() => confirmArchive(activeClient)}>Archive</button>
      {/if}
      <button class="btn btn-sm btn-danger" on:click={() => openDelete(activeClient)}>Delete</button>
    </div>

  {:else if drawerMode === 'edit' && activeClient}
    <div class="detail-section">
      <div class="form-field"><label for="edit-name">Name</label><input id="edit-name" type="text" class="form-input" bind:value={edit.name} /></div>
      <div class="form-field"><label for="edit-email">Notification email</label><input id="edit-email" type="email" class="form-input" bind:value={edit.notification_email} /></div>
      <div class="form-field"><label for="edit-sitename">Wix site name</label><input id="edit-sitename" type="text" class="form-input" bind:value={edit.source_site_name} /></div>
      <div class="form-field"><label for="edit-siteid">Wix site ID</label><input id="edit-siteid" type="text" class="form-input mono" bind:value={edit.source_site_id} /></div>
      <div class="form-field"><label for="edit-hw">Door system</label>
        <select id="edit-hw" class="form-input" bind:value={edit.hardware_platform}><option value="">— Not set —</option><option value="kisi">Kisi</option><option value="seam">Seam</option></select>
        <div class="cell-sub">Cannot be changed once members are provisioned.</div></div>
      <div class="form-field"><label for="edit-tier">Tier</label>
        <select id="edit-tier" class="form-input" bind:value={edit.tier}><option value="">— Not set —</option><option value="Base">Base</option><option value="Pro">Pro</option><option value="Connect">Connect</option></select></div>
      <div class="form-field"><label for="edit-status">Status</label>
        <select id="edit-status" class="form-input" bind:value={edit.status}><option value="active">Active</option><option value="suspended">Suspended</option><option value="cancelled">Cancelled</option></select>
        <div class="cell-sub">Suspended and cancelled gyms are not synced. Use Archive to hide a gym.</div></div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => openDetail(activeClient)}>Cancel</button>
      <button class="btn btn-accent" on:click={saveEdit}>Save changes</button>
    </div>

  {:else if drawerMode === 'apikey' && activeClient}
    <div class="detail-section">
      <p class="muted" style="font-size:12.5px;margin-bottom:14px;">Write-only. Once saved, the key cannot be viewed, only replaced. Encrypted at rest (AES-256-GCM).</p>
      <div class="form-field">
        <label for="api-key-input">Kisi API key</label>
        <input id="api-key-input" type="password" class="form-input mono" bind:value={apiKeyInput} placeholder="Paste the key…" autocomplete="off" />
      </div>
    </div>
    <div class="drawer-footer-actions">
      <button class="btn btn-secondary" on:click={() => openDetail(activeClient)}>Back</button>
      <button class="btn btn-accent" on:click={saveApiKey}>Save key</button>
    </div>
  {/if}
</Drawer>

<ConfirmModal bind:open={modalOpen} title={modalTitle} body={modalBody} on:confirm={handleModalConfirm} />
<InviteLinkModal bind:open={inviteOpen} clientId={inviteClient.id} clientName={inviteClient.name} />

<!-- New gym -->
{#if newOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-overlay" on:click={() => newOpen = false}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <h3>New gym</h3>
      <p>Create the account, then send the gym a setup link. They add their own keys and doors.</p>
      {#if newError}<div class="modal-error">{newError}</div>{/if}
      <div class="form-field"><label for="nc-name">Gym / business name *</label><input id="nc-name" type="text" class="form-input" bind:value={newForm.name} placeholder="e.g. House of Gains" /></div>
      <div class="form-field"><label for="nc-email">Their email *</label><input id="nc-email" type="email" class="form-input" bind:value={newForm.email} placeholder="owner@theirgym.com" />
        <div class="cell-sub">Alerts for this gym go here. Also used to address the setup-link email draft.</div></div>
      <div class="form-field"><label for="nc-site">Wix site ID (optional)</label><input id="nc-site" type="text" class="form-input mono" bind:value={newForm.site} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
        <div class="cell-sub">Leave blank and they enter it during setup.</div></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={() => newOpen = false}>Cancel</button>
        <button class="btn btn-accent" disabled={newBusy} on:click={submitNew}>Create and get setup link</button>
      </div>
    </div>
  </div>
{/if}

<!-- Delete: typed confirmation -->
{#if deleteOpen && deleteClient}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-overlay" on:click={() => deleteOpen = false}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <h3>Delete {deleteClient.name}?</h3>
      <div class="modal-warning">This permanently deletes this gym AND all its data ({deleteSummary || 'counting…'}). This cannot be undone.</div>
      <div class="form-field"><label for="del-input">Type <code>{deleteExpected}</code> to confirm</label>
        <input id="del-input" type="text" class="form-input mono" bind:value={deleteInput} placeholder={deleteExpected} autocomplete="off" spellcheck="false" /></div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={() => deleteOpen = false}>Cancel</button>
        <button class="btn btn-danger" disabled={deleteInput !== deleteExpected || deleteBusy} on:click={confirmDelete}>Delete forever</button>
      </div>
    </div>
  </div>
{/if}
