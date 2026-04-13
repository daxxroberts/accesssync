<!--
  SearchBar.svelte
  Replaces: .search-bar-wrap pattern in Debug Center and Clients panels
  Props:
    placeholder  {string}  — input placeholder text
    debounce     {number}  — ms delay before firing search (default 300)
    value        {string}  — bind:value for two-way binding
  Events:
    search  — dispatched with { query: string } after debounce
-->
<script>
  import { createEventDispatcher } from 'svelte';
  const dispatch = createEventDispatcher();

  export let placeholder = 'Search…';
  export let debounce    = 300;
  export let value       = '';

  let timer;

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(() => dispatch('search', { query: value }), debounce);
  }
</script>

<div class="search-bar-wrap">
  <div class="search-bar">
    <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <input
      type="text"
      bind:value
      {placeholder}
      on:input={onInput}
    />
  </div>
</div>
