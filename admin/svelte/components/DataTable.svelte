<!--
  DataTable.svelte
  Replaces: <table class="data-table"> shell repeated in every panel
  Props:
    columns  {string[]}  — column header labels
  Slots:
    default  — <tr> rows go here (inside the <tbody>)
    empty    — shown when no rows (optional — falls back to EmptyState)
-->
<script>
  export let columns = [];
</script>

<div class="table-wrap">
  <table class="data-table">
    <thead>
      <tr>
        {#each columns as col}
          <th>{col}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      <slot />
    </tbody>
  </table>
</div>
