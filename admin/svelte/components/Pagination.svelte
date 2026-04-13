<!--
  Pagination.svelte
  Replaces: Prev/Next + page info pattern in Error Queue and Member Sync panels
  Props:
    offset  {number}  — current offset (0-based)
    limit   {number}  — page size
    total   {number}  — total record count
  Events:
    change  — dispatched with { offset: number } when page changes
-->
<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();

  export let offset = 0;
  export let limit  = 50;
  export let total  = 0;

  $: start    = total === 0 ? 0 : offset + 1;
  $: end      = Math.min(offset + limit, total);
  $: hasPrev  = offset > 0;
  $: hasNext  = offset + limit < total;
  $: visible  = total > limit;

  function prev() { dispatch('change', { offset: Math.max(0, offset - limit) }); }
  function next() { dispatch('change', { offset: offset + limit }); }
</script>

{#if visible}
  <div class="pagination">
    <button class="btn btn-secondary btn-sm" disabled={!hasPrev} on:click={prev}>Previous</button>
    <span class="page-info">{start}–{end} of {total}</span>
    <button class="btn btn-secondary btn-sm" disabled={!hasNext} on:click={next}>Next</button>
  </div>
{/if}
