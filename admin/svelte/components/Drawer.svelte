<!--
  Drawer.svelte
  Replaces: openDrawer() / closeDrawer() + #drawer + #drawer-overlay in app.js
  Props:
    open   {boolean}  — controls visibility (bind:open)
    title  {string}   — drawer header title
  Slots:
    default — drawer body content
  Events:
    close — dispatched when overlay or X button clicked
-->
<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();

  export let open  = false;
  export let title = 'Detail';

  function close() {
    open = false;
    dispatch('close');
  }

  function onKeydown(e) {
    if (e.key === 'Escape' && open) close();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Overlay -->
{#if open}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="drawer-overlay" on:click={close}></div>
{/if}

<!-- Drawer panel -->
<aside class="drawer" class:hidden={!open}>
  <div class="drawer-header">
    <h3>{title}</h3>
    <button class="drawer-close" aria-label="Close drawer" on:click={close}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  </div>
  <div class="drawer-body">
    <slot />
  </div>
</aside>
