<!--
  EmptyState.svelte
  Replaces: <div class="empty-state"> in every panel
  Props:
    message  {string}  — message text
    hidden   {boolean} — controls visibility
  Slots:
    icon  — optional SVG icon (defaults to checkmark)
-->
<script>
  export let message = 'Nothing here yet.';
  export let hidden = false;
</script>

{#if !hidden}
  <div class="empty-state">
    <slot name="icon">
      <!-- Default: checkmark circle -->
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
    </slot>
    <p>{message}</p>
  </div>
{/if}
