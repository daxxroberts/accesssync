<!--
  StatCard.svelte
  Replaces: .stat-card divs in Queue Monitor and Member Sync panels
  Props:
    label  {string}  — card label (e.g. "Waiting")
    value  {any}     — displayed number or string
    color  {string?} — 'success' | 'danger' | 'accent' | '' (default muted)
-->
<script>
  export let label = '';
  export let value = '—';
  export let color = '';
</script>

<div class="stat-card">
  <div class="stat-label">{label}</div>
  <div class="stat-value {color}">{value ?? '—'}</div>
</div>
