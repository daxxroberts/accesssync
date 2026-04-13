<!--
  ConfirmModal.svelte
  Replaces: showModal() function + #modal-overlay in app.js
  Props:
    open      {boolean}  — controls visibility (bind:open)
    title     {string}   — modal title
    body      {string}   — modal body text
    showNote  {boolean}  — show optional note input (default false)
  Events:
    confirm  — dispatched with { note?: string } on confirm click
    cancel   — dispatched on cancel or overlay click
-->
<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();

  export let open     = false;
  export let title    = 'Confirm Action';
  export let body     = '';
  export let showNote = false;

  let note = '';

  function confirm() {
    open = false;
    dispatch('confirm', { note: showNote ? note.trim() : undefined });
    note = '';
  }

  function cancel() {
    open = false;
    dispatch('cancel');
    note = '';
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && open) cancel();
  }
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="modal-overlay" on:click={cancel}>
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
    <div class="modal" on:click|stopPropagation>
      <h3>{title}</h3>
      <p>{body}</p>
      {#if showNote}
        <div class="modal-note-wrap">
          <label for="modal-note-input">Note (optional)</label>
          <input id="modal-note-input" type="text" bind:value={note} placeholder="Add a note…" />
        </div>
      {/if}
      <div class="modal-actions">
        <button class="btn btn-secondary" on:click={cancel}>Cancel</button>
        <button class="btn btn-accent" on:click={confirm}>Confirm</button>
      </div>
    </div>
  </div>
{/if}
