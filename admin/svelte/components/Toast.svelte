<!--
  Toast.svelte
  Replaces: toast() function + #toast-container in app.js
  Usage: mount once in app root, then call the exported show() action via a store.
  Props: none — controlled entirely via toastStore

  Import the store to trigger toasts from any panel:
    import { showToast } from '../stores/toast.js';
    showToast('Saved!', 'success');
-->
<script>
  import { toasts } from '../stores/toast.js';
</script>

<div class="toast-container">
  {#each $toasts as t (t.id)}
    <div class="toast toast-{t.type} toast-visible">{t.message}</div>
  {/each}
</div>
