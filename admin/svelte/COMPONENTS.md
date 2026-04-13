# Svelte Component Library — AccessSync Owner Dashboard

**Rule: Read this file before building any panel. If a pattern exists here, use it. If a new pattern emerges, add it here before the next panel.**

Source: `admin/svelte/components/`
Build output: `admin/public/dist/bundle.js` + `bundle.css`
Build command: `npm run build`

---

## Primitives

### `PillBadge.svelte`
Replaces: `pill()` function in `app.js` (used 15+ times across all panels)

```svelte
<PillBadge text="active" />
<PillBadge text="failed" />
<PillBadge text="waiting" type="warning" />  <!-- override auto-map -->
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `text` | string | `''` | Display text; auto-maps to color class |
| `type` | string? | auto | Override: `success`, `danger`, `warning`, `info`, `muted` |

Auto color map: `active/accepted/resolved/granted → success` · `failed/rejected/cancelled → danger` · `waiting/in-progress → warning` · `new/delayed → info` · everything else → `muted`

---

### `StatCard.svelte`
Replaces: `.stat-card` divs in Queue Monitor and Member Sync panels

```svelte
<StatCard label="Waiting" value={counts.waiting} />
<StatCard label="Failed"  value={counts.failed}  color="danger" />
<StatCard label="Active"  value={counts.active}  color="success" />
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `label` | string | `''` | Card label text |
| `value` | any | `'—'` | Displayed number or string |
| `color` | string? | `''` | `success`, `danger`, `accent`, or blank (muted) |

---

### `CodeChip.svelte`
Replaces: `<code class="code-sm">` pattern in every table cell

```svelte
<CodeChip text={row.event_type} />
<CodeChip text={row.id} full={false} />  <!-- truncates to 20 chars by default -->
<CodeChip text={row.payload} full={true} />
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `text` | string | `''` | Monospace text to display |
| `full` | boolean | `false` | If false, truncates to 20 chars with `…` |

---

### `TimeStamp.svelte`
Replaces: `fmt(iso)` + `title="${iso}"` pattern in every table cell

```svelte
<TimeStamp iso={row.created_at} />
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `iso` | string | `null` | ISO date string; renders `—` if falsy |

Renders formatted date with full ISO as `title` tooltip on hover.

---

## Layout

### `LoadingState.svelte`
Replaces: `<div class="loading-state">` in every panel

```svelte
<LoadingState />
<LoadingState message="Searching…" hidden={!isLoading} />
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `message` | string | `'Loading…'` | Loading text |
| `hidden` | boolean | `false` | Hides component when true |

---

### `EmptyState.svelte`
Replaces: `<div class="empty-state">` in every panel

```svelte
<EmptyState message="No errors found" hidden={data.length > 0} />

<!-- With custom icon: -->
<EmptyState message="No webhook events received yet">
  <svelte:fragment slot="icon">
    <svg>...</svg>
  </svelte:fragment>
</EmptyState>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `message` | string | `'Nothing here yet.'` | Empty state message |
| `hidden` | boolean | `false` | Hides component when true |

Slot `icon`: optional SVG. Defaults to checkmark circle.

---

### `DataTable.svelte`
Replaces: `<table class="data-table">` shell in every panel

```svelte
<DataTable columns={['Client', 'Member', 'Event Type', 'Status', 'Created', 'Actions']}>
  {#each rows as row}
    <tr>...</tr>
  {/each}
</DataTable>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `columns` | string[] | `[]` | Column header labels |

Default slot: `<tr>` rows rendered inside `<tbody>`.

---

### `Pagination.svelte`
Replaces: Prev/Next + page info in Error Queue and Member Sync panels

```svelte
<Pagination
  offset={state.offset}
  limit={state.limit}
  total={state.total}
  on:change={e => { state.offset = e.detail.offset; loadData(); }}
/>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `offset` | number | `0` | Current 0-based offset |
| `limit` | number | `50` | Page size |
| `total` | number | `0` | Total record count |

Event `change`: `{ offset: number }` — fired on Prev/Next click. Hidden when `total <= limit`.

---

## Interactive

### `SearchBar.svelte`
Replaces: `.search-bar-wrap` pattern in Debug Center and Clients panels

```svelte
<SearchBar
  placeholder="Search by email, name, or member ID…"
  bind:value={query}
  on:search={e => doSearch(e.detail.query)}
/>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `placeholder` | string | `'Search…'` | Input placeholder |
| `debounce` | number | `300` | Ms delay before firing event |
| `value` | string | `''` | Bindable — two-way |

Event `search`: `{ query: string }` — fired after debounce.

---

### `Drawer.svelte`
Replaces: `openDrawer()` / `closeDrawer()` + `#drawer` + overlay in `app.js`

```svelte
<Drawer bind:open={drawerOpen} title={drawerTitle} on:close={() => drawerOpen = false}>
  <!-- Detail content here -->
  <div class="detail-section">...</div>
</Drawer>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `open` | boolean | `false` | Bindable — controls visibility |
| `title` | string | `'Detail'` | Drawer header title |

Event `close`: fired on X button or overlay click. Escape key also closes.
Default slot: rendered inside `.drawer-body`.

---

### `ConfirmModal.svelte`
Replaces: `showModal()` + `#modal-overlay` in `app.js`

```svelte
<ConfirmModal
  bind:open={modalOpen}
  title="Retry Job"
  body="Re-queue this job to BullMQ? The error will be marked as resolved."
  on:confirm={handleConfirm}
  on:cancel={() => modalOpen = false}
/>

<!-- With note field: -->
<ConfirmModal
  bind:open={modalOpen}
  title="Dismiss Error"
  body="Mark this error as resolved?"
  showNote={true}
  on:confirm={e => handleDismiss(e.detail.note)}
/>
```

| Prop | Type | Default | Notes |
|------|------|---------|-------|
| `open` | boolean | `false` | Bindable — controls visibility |
| `title` | string | `'Confirm Action'` | Modal title |
| `body` | string | `''` | Modal body text |
| `showNote` | boolean | `false` | Show optional note input |

Event `confirm`: `{ note?: string }` — note is present when `showNote=true`.
Event `cancel`: fired on Cancel button, overlay click, or Escape key.

---

### `Toast.svelte`
Replaces: `toast()` function + `#toast-container` in `app.js`

Mount once at app root. Trigger from any panel via the store:

```svelte
<!-- App root (once): -->
<Toast />

<!-- Any panel: -->
import { showToast } from '../stores/toast.js';
showToast('Job re-queued', 'success');
showToast('Retry failed', 'error');
```

Store: `admin/svelte/stores/toast.js` — exports `toasts` (readable) and `showToast(message, type)`.
Types: `info` · `success` · `error` · `warning`
Auto-dismisses after 3.5s.

---

## File Structure

```
admin/svelte/
  main.js                    ← Vite entry point
  COMPONENTS.md              ← This file (read before building panels)
  components/
    PillBadge.svelte
    StatCard.svelte
    CodeChip.svelte
    TimeStamp.svelte
    LoadingState.svelte
    EmptyState.svelte
    DataTable.svelte
    Pagination.svelte
    SearchBar.svelte
    Drawer.svelte
    ConfirmModal.svelte
    Toast.svelte
  stores/
    toast.js
  panels/                    ← One file per Owner Dashboard panel (not yet built)
    QueuePanel.svelte        ← Phase 2: first to migrate
    WebhookPanel.svelte
    DebugCenterPanel.svelte
    ErrorQueuePanel.svelte
    MemberSyncPanel.svelte
    ClientsPanel.svelte
```

## Migration Order (Panel Phase)

Build simplest → most complex. Each panel is independently shippable.

1. **QueuePanel** — stat cards + job table, read-only, no mutations
2. **WebhookPanel** — table + live polling, no user actions
3. **DebugCenterPanel** — search + table
4. **ErrorQueuePanel** — table + retry/dismiss + bulk actions
5. **MemberSyncPanel** — cascading selects + table + pagination
6. **ClientsPanel** — full CRUD + drawer + modals (most complex)
