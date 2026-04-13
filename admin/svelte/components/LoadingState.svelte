<!--
  LoadingState.svelte
  Replaces: <div class="loading-state"> in every panel
  Props:
    message  {string}  — loading text (default "Loading…")
    hidden   {boolean} — controls visibility
-->
<script>
  export let message = 'Loading…';
  export let hidden = false;
</script>

{#if !hidden}
  <div class="loading-state">{message}</div>
{/if}
