<!--
  PillBadge.svelte
  Replaces: pill() function in app.js (used 15+ times)
  Props:
    text   {string}  — display text
    type   {string?} — override color class (auto-mapped if omitted)
-->
<script>
  export let text = '';
  export let type = null;

  const colorMap = {
    accepted:    'success',
    rejected:    'danger',
    new:         'info',
    duplicate:   'muted',
    failed:      'danger',
    resolved:    'success',
    'in-progress': 'warning',
    active:      'success',
    waiting:     'warning',
    delayed:     'info',
    completed:   'muted',
    paused:      'muted',
    granted:     'success',
    revoked:     'muted',
    unknown:     'muted',
    archived:    'muted',
    cancelled:   'danger',
  };

  $: cls = type || colorMap[text] || 'muted';
</script>

<span class="pill pill-{cls}">{text || '—'}</span>
