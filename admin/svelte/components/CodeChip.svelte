<!--
  CodeChip.svelte
  Replaces: <code class="code-sm"> pattern used in every table cell
  Props:
    text  {string}  — value to display in monospace
    full  {boolean} — if true, don't truncate (default false — truncates to 20 chars)
-->
<script>
  export let text = '';
  export let full = false;

  $: display = (!full && text && text.length > 20)
    ? text.slice(0, 20) + '…'
    : (text || '—');
</script>

{#if text}
  <code class="code-sm" title={text}>{display}</code>
{:else}
  <span class="muted">—</span>
{/if}
