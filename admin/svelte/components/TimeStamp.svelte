<!--
  TimeStamp.svelte
  Replaces: fmt(isoString) + title="${iso}" pattern used in every table cell
  Props:
    iso  {string}  — ISO date string
-->
<script>
  export let iso = null;

  function fmt(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  $: display = fmt(iso);
</script>

<span title={iso || ''}>{display}</span>
