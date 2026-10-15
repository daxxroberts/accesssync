<!--
  InviteLinkModal.svelte
  Setup link for a gym: created on open (POST /admin/clients/:id/invite), copy it or open an email draft.
  Used by HubPanel ("Send setup link" on a setup row) and ManageGymsPanel (per-card button, after New client).
  Props:
    open        {boolean}  — bind:open
    clientId    {string}
    clientName  {string}
  Events:
    close
-->
<script>
  import { createEventDispatcher } from 'svelte';
  import { showToast } from '../stores/toast.js';
  const dispatch = createEventDispatcher();

  export let open = false;
  export let clientId = '';
  export let clientName = '';

  let sub = '';
  let url = '';
  let mailto = '#';
  let error = '';
  let loadedFor = null;

  $: if (open && clientId && loadedFor !== clientId) create();
  $: if (!open) loadedFor = null;

  async function create() {
    loadedFor = clientId;
    sub = 'Creating link…'; url = ''; mailto = '#'; error = '';
    try {
      const res = await fetch(`/admin/clients/${encodeURIComponent(clientId)}/invite`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } });
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b.error || `HTTP ${res.status}`);
      url = b.url;
      const name = b.clientName || clientName;
      sub = `Send this to the gym. They open it, press Start setup, and finish onboarding themselves. Works for ${b.ttlHours} hours (until ${new Date(b.expiresAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}).`;
      const subject = `Set up AccessSync for ${name}`;
      const body = `Hi,\n\nHere is your AccessSync setup link. Open it and press “Start setup” — it takes about five minutes.\n\n${b.url}\n\nThe link works for ${b.ttlHours} hours. If it expires, tell me and I’ll send a new one.`;
      mailto = `mailto:${encodeURIComponent(b.notificationEmail || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    } catch (e) {
      sub = '';
      error = `Could not create a setup link: ${e.message}`;
    }
  }

  async function copy() {
    if (!url) return;
    try { await navigator.clipboard.writeText(url); showToast('Setup link copied', 'success'); }
    catch { error = 'Copy failed — select the link and copy it manually.'; }
  }

  function close() { open = false; dispatch('close'); }
  function onKeydown(e) { if (e.key === 'Escape' && open) close(); }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-overlay" on:click={close}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal modal-wide" on:click|stopPropagation>
      <h3>Setup link for {clientName}</h3>
      <p>{sub}</p>
      {#if error}<div class="modal-error">{error}</div>{/if}
      <div class="invite-link-row">
        <input type="text" class="form-input mono" value={url} readonly aria-label="Setup link" />
        <button class="btn btn-accent" disabled={!url} on:click={copy}>Copy</button>
      </div>
      <div class="invite-note">
        <strong>Send it any way that reaches them</strong> — text, chat or email. If they don't get it, just make a new one.
        Opening the link doesn't use it up, so it's safe if an email scanner clicks it first. It only ever opens <em>this</em> gym's setup.
        To cancel every link for a gym, archive it.
      </div>
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={close}>Done</button>
        <a class="btn btn-secondary" href={mailto} class:disabled={!url}>Open email draft</a>
      </div>
    </div>
  </div>
{/if}
