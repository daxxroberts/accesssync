<!--
  PlanMappingPanel.svelte
  @panel   Plan Mapping — Wire Graph UI
  @route   /plan-mapping?clientId=
  @api     GET  /operator/:clientId/locations
           GET  /operator/:clientId/locations/:locationId/mappings
           GET  /operator/:clientId/plan-mappings/:mappingId/groups
           GET  /operator/clients/:clientId/kisi-groups
           PATCH /operator/:clientId/plan-mappings/:mappingId
  @design  DR-014: brand indigo #4F6EF7, sage #4ADE80 (active status only)
  @note    Drag right port of a plan → left port of a hardware group to connect.
           Hover a wire → delete button appears at midpoint.
-->
<script>
  import { onMount, onDestroy, afterUpdate, tick } from 'svelte';
  import { showToast } from '../stores/toast.js';

  // ── Constants ───────────────────────────────────────────────────────
  const CLIENT_ID       = new URLSearchParams(window.location.search).get('clientId');
  const BRAND           = '#4F6EF7';
  const SAGE            = '#4ADE80';
  const AMBER           = '#F59E0B';
  const WIRE_W          = 2;
  const WIRE_W_HOVER    = 3;
  const PULSE_DUR       = '2.8s';

  // ── State ───────────────────────────────────────────────────────────
  let plans       = [];   // { mappingId, planName, sourcePlanId, accessType, status, planType, groups: [{id,name}] }
  let groups      = [];   // { id, name }
  let locations   = [];
  let activeLocId = null;
  let loading     = true;
  let loadError   = null;

  // DOM refs
  let canvasEl;
  let planEls   = {};   // mappingId → el
  let groupEls  = {};   // groupId   → el

  // Wire state
  let wires       = [];  // [{ id, planId, planName, groupId, groupName, from, to, status }]
  let hoveredWire = null;
  let svgW        = 0;
  let svgH        = 0;

  // Drag-to-connect
  let drag = null;  // { mappingId, planName, fromX, fromY, toX, toY }

  // Filter
  let filterQ = '';

  // ── Derived ─────────────────────────────────────────────────────────
  $: dimmedPlanIds = filterQ.trim()
    ? new Set(plans.filter(p => !p.planName.toLowerCase().includes(filterQ.toLowerCase())).map(p => p.mappingId))
    : new Set();

  // ── API ─────────────────────────────────────────────────────────────
  async function apiFetch(url, opts = {}) {
    const res = await fetch(url, { credentials: 'include', ...opts });
    // 304 Not Modified is valid — browser returns cached body via res.json()
    if (!res.ok && res.status !== 304) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── Load ─────────────────────────────────────────────────────────────
  async function loadLocations() {
    if (!CLIENT_ID) { loadError = 'No clientId in URL'; loading = false; return; }
    try {
      const data = await apiFetch(`/operator/${CLIENT_ID}/locations`);
      locations = (data.locations || data || []).filter(l => l.subscription_status !== 'inactive');
      if (locations.length) {
        activeLocId = locations[0].id;
        await loadMappings(activeLocId);
      } else {
        loading = false;
      }
    } catch (e) {
      loadError = e.message;
      loading = false;
    }
  }

  async function loadMappings(locId) {
    loading = true;
    loadError = null;
    try {
      const [mappingRes, groupRes] = await Promise.all([
        apiFetch(`/operator/${CLIENT_ID}/locations/${locId}/mappings`),
        apiFetch(`/operator/clients/${CLIENT_ID}/kisi-groups`).catch(() => ({ groups: [] })),
      ]);

      const rawMappings = mappingRes.mappings || mappingRes || [];
      groups = groupRes.groups || groupRes || [];

      // Fetch per-mapping groups sequentially to avoid rate limit bursts
      const resolvedPlans = [];
      for (const m of rawMappings) {
        let mGroups = [];
        try {
          const gd = await apiFetch(`/operator/${CLIENT_ID}/plan-mappings/${m.id}/groups`);
          // Normalize: API returns { hardware_group_id, door_name } — map to { id, name }
          // so wire drawing can match against the Kisi groups array by id
          mGroups = (gd.groups || gd || []).map(g => ({
            id:           g.hardware_group_id,
            name:         g.door_name || groups.find(kg => kg.id === g.hardware_group_id)?.name || g.hardware_group_id,
            healthStatus: g.health_status || 'ok',
          }));
        } catch (_) {}
        resolvedPlans.push({
          ...m, mappingId: m.id,
          planName:  m.plan_name || m.planName || '—',
          wixStatus: m.wix_status || 'active',
          groups:    mGroups,
        });
      }
      plans = resolvedPlans;

      await tick();
      recalcWires();
    } catch (e) {
      loadError = e.message;
    } finally {
      loading = false;
    }
  }

  // ── Wire geometry ────────────────────────────────────────────────────
  function recalcWires() {
    if (!canvasEl) return;
    const cR = canvasEl.getBoundingClientRect();
    svgW = cR.width;
    svgH = Math.max(cR.height, 200);

    const next = [];
    for (const plan of plans) {
      if (dimmedPlanIds.has(plan.mappingId)) continue;
      const pEl = planEls[plan.mappingId];
      if (!pEl) continue;
      const pR = pEl.getBoundingClientRect();
      const fromX = pR.right  - cR.left;
      const fromY = pR.top    - cR.top + pR.height / 2;

      for (const g of (plan.groups || [])) {
        const gEl = groupEls[g.id];
        if (!gEl) continue;
        const gR = gEl.getBoundingClientRect();
        const toX = gR.left - cR.left;
        const toY = gR.top  - cR.top + gR.height / 2;

        next.push({
          id:           `wire-${plan.mappingId}-${g.id}`,
          planId:       plan.mappingId,
          planName:     plan.planName,
          groupId:      g.id,
          groupName:    g.name,
          from:         { x: fromX, y: fromY },
          to:           { x: toX,   y: toY   },
          status:       plan.status,
          healthStatus: g.healthStatus || 'ok',
        });
      }
    }
    wires = next;
  }

  function bezier(from, to) {
    const cp = Math.abs(to.x - from.x) * 0.48;
    return `M ${from.x},${from.y} C ${from.x + cp},${from.y} ${to.x - cp},${to.y} ${to.x},${to.y}`;
  }

  // ── Drag-to-connect ──────────────────────────────────────────────────
  function startDrag(e, plan) {
    e.preventDefault();
    const pEl = planEls[plan.mappingId];
    if (!pEl || !canvasEl) return;
    const pR = pEl.getBoundingClientRect();
    const cR = canvasEl.getBoundingClientRect();
    drag = {
      mappingId: plan.mappingId,
      planName:  plan.planName,
      fromX: pR.right - cR.left,
      fromY: pR.top   - cR.top + pR.height / 2,
      toX:   e.clientX - cR.left,
      toY:   e.clientY - cR.top,
    };
  }

  function onMouseMove(e) {
    if (!drag || !canvasEl) return;
    const cR = canvasEl.getBoundingClientRect();
    drag = { ...drag, toX: e.clientX - cR.left, toY: e.clientY - cR.top };
  }

  async function dropOnGroup(e, group) {
    if (!drag) return;
    e.stopPropagation();
    const { mappingId, planName } = drag;
    drag = null;

    const plan = plans.find(p => p.mappingId === mappingId);
    if (plan?.groups?.some(g => g.id === group.id)) {
      showToast('Already connected', 'warning');
      return;
    }
    try {
      const result = await apiFetch(`/operator/${CLIENT_ID}/plan-mappings/${mappingId}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ addGroupId: group.id }),
      });
      await loadMappings(activeLocId);
      if (result.warning) {
        showToast(result.warning, 'warning');
      } else {
        showToast(`Connected: ${planName} → ${group.name}`, 'success');
      }
    } catch {
      showToast('Failed to connect', 'error');
    }
  }

  function cancelDrag() { drag = null; }

  // ── Disconnect ───────────────────────────────────────────────────────
  async function disconnectWire(wire) {
    // M-6: Fetch affected member count before confirming
    let memberCount = 0;
    try {
      const data = await apiFetch(`/operator/${CLIENT_ID}/plan-mappings/${wire.planId}/groups/${wire.groupId}/affected-members`);
      memberCount = data.count || 0;
    } catch (_) {}

    // K-2: Dead group gets a different confirmation message
    let msg;
    if (wire.healthStatus === 'not_found') {
      msg = `This group is no longer available in your access control system. Removing it will clear ${memberCount} member assignment(s). You can remap this plan to a different group afterward.`;
    } else if (memberCount > 0) {
      msg = `Disconnecting this plan from "${wire.groupName}" will revoke access for ${memberCount} member(s) currently using it.`;
    } else {
      msg = `Disconnect this plan from "${wire.groupName}"? No members are currently assigned.`;
    }
    if (!confirm(msg)) return;

    hoveredWire = null;
    try {
      const res = await fetch(`/operator/${CLIENT_ID}/plan-mappings/${wire.planId}`, {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ removeGroupId: wire.groupId }),
      });
      if (!res.ok && res.status !== 304) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      await loadMappings(activeLocId);
      showToast('Disconnected', 'success');
    } catch (e) {
      console.error('[PlanMapping] disconnect failed:', e.message);
      showToast(`Failed to disconnect: ${e.message}`, 'error');
    }
  }

  // ── Resize observer ──────────────────────────────────────────────────
  let resizeObs;

  function onPanelVisible() {
    // Re-fetch data so the New UI reflects any changes made in Classic View
    if (activeLocId) {
      loadMappings(activeLocId);
    } else {
      recalcWires();
    }
  }

  onMount(async () => {
    await loadLocations();
    if (canvasEl) {
      resizeObs = new ResizeObserver(() => recalcWires());
      resizeObs.observe(canvasEl);
    }
    // Re-calc wires when the outer wrapper becomes visible (toggle from display:none)
    window.addEventListener('pm-panel-shown', onPanelVisible);
  });

  onDestroy(() => {
    resizeObs?.disconnect();
    window.removeEventListener('pm-panel-shown', onPanelVisible);
  });

  afterUpdate(() => recalcWires());
</script>

<svelte:window on:mousemove={onMouseMove} on:mouseup={cancelDrag} />

<div class="pm-root">

  <!-- ── Toolbar ─────────────────────────────────────────────────── -->
  <div class="pm-toolbar">
    <div class="pm-toolbar-left">
      {#each locations as loc}
        <button
          class="pm-loc-tab"
          class:active={loc.id === activeLocId}
          on:click={() => { activeLocId = loc.id; loadMappings(loc.id); }}
        >{loc.name}</button>
      {/each}
    </div>
    <div class="pm-toolbar-right">
      <div class="pm-search-wrap">
        <svg class="pm-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
        </svg>
        <input
          bind:value={filterQ}
          placeholder="Filter plans…"
          class="pm-search-input"
        />
      </div>
    </div>
  </div>

  <!-- ── State: loading / error ──────────────────────────────────── -->
  {#if loading}
    <div class="pm-status-row">
      <div class="pm-spinner"></div>
      <span class="pm-status-text">Loading mappings…</span>
    </div>
  {:else if loadError}
    <div class="pm-error-banner">{loadError}</div>
  {:else}

    <!-- ── Canvas ──────────────────────────────────────────────────── -->
    <div class="pm-canvas" bind:this={canvasEl}>

      <!-- SVG wire layer — sits above everything, pointer-events on paths only -->
      <svg
        class="pm-wire-svg"
        style="width:{svgW}px;height:{svgH}px"
        viewBox="0 0 {svgW} {svgH}"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="pmGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.5" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
          <filter id="pmGlowSoft" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="6" result="blur"/>
            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>

        <!-- Active wires -->
        {#each wires as wire (wire.id)}
          {@const hov   = hoveredWire === wire.id}
          {@const dead  = wire.healthStatus === 'not_found'}
          {@const d     = bezier(wire.from, wire.to)}
          {@const mx    = (wire.from.x + wire.to.x) / 2}
          {@const my    = (wire.from.y + wire.to.y) / 2 - 6}
          {@const color = dead ? AMBER : (wire.status === 'active' ? BRAND : '#555')}
          {@const hovColor = dead ? AMBER : SAGE}

          <g class="pm-wire-group" role="presentation"
            on:mouseenter={() => hoveredWire = wire.id}
            on:mouseleave={() => hoveredWire = null}
          >
            <!-- Invisible hit-area for easy hovering -->
            <path {d} fill="none" stroke="transparent" stroke-width="20"
              style="pointer-events:stroke;cursor:pointer"/>

            <!-- Outer glow -->
            <path {d} fill="none"
              stroke={hov ? hovColor : color}
              stroke-width={hov ? 8 : 5}
              stroke-opacity={hov ? 0.35 : 0.12}
              filter="url(#pmGlowSoft)"
              style="pointer-events:none"
            />

            <!-- Main wire -->
            <path {d} fill="none"
              stroke={hov ? hovColor : color}
              stroke-width={hov ? WIRE_W_HOVER : WIRE_W}
              stroke-opacity={hov ? 1 : 0.65}
              stroke-dasharray={dead || wire.status !== 'active' ? '5 4' : 'none'}
              style="pointer-events:none"
            />

            <!-- Animated pulse (active + healthy only) -->
            {#if wire.status === 'active' && !dead}
              <path id="{wire.id}-mpath" {d} fill="none" stroke="none" style="pointer-events:none"/>
              <circle r="3.5" fill={BRAND} filter="url(#pmGlow)" style="pointer-events:none">
                <animateMotion dur={PULSE_DUR} repeatCount="indefinite">
                  <mpath href="#{wire.id}-mpath"/>
                </animateMotion>
              </circle>
              <!-- Second pulse, offset by half -->
              <circle r="2" fill={BRAND} opacity="0.5" style="pointer-events:none">
                <animateMotion dur={PULSE_DUR} repeatCount="indefinite" begin="-{parseFloat(PULSE_DUR)/2}s">
                  <mpath href="#{wire.id}-mpath"/>
                </animateMotion>
              </circle>
            {/if}

            <!-- Midpoint actions on hover -->
            {#if hov}
              <g transform="translate({mx},{my})" style="cursor:pointer" role="button" tabindex="0" on:click={() => disconnectWire(wire)} on:keydown={e => e.key === "Enter" && disconnectWire(wire)}>
                <circle r="11" fill="#12141E" stroke={dead ? 'rgba(245,158,11,0.6)' : 'rgba(255,80,80,0.6)'} stroke-width="1.5"/>
                <text x="0" y="4.5" text-anchor="middle" font-size="12"
                  fill={dead ? 'rgba(245,158,11,0.9)' : 'rgba(255,100,100,0.9)'} font-family="sans-serif" style="pointer-events:none">✕</text>
              </g>
            {/if}
          </g>
        {/each}

        <!-- Dragging wire (pending connection) -->
        {#if drag}
          {@const dp = bezier({ x: drag.fromX, y: drag.fromY }, { x: drag.toX, y: drag.toY })}
          <path d={dp} fill="none" stroke={BRAND} stroke-width="2"
            stroke-dasharray="6 3" stroke-opacity="0.9" filter="url(#pmGlow)"
            style="pointer-events:none"/>
          <circle cx={drag.toX} cy={drag.toY} r="5"
            fill={BRAND} opacity="0.85" filter="url(#pmGlow)"
            style="pointer-events:none"/>
        {/if}
      </svg>

      <!-- ── Left column: Plans ───────────────────────────────────── -->
      <div class="pm-col pm-col-plans">
        <div class="pm-col-header">
          <span class="pm-col-label">Plans</span>
          <span class="pm-col-count">{plans.length}</span>
        </div>

        {#each plans as plan (plan.mappingId)}
          {@const connected  = plan.groups && plan.groups.length > 0}
          {@const dimmed      = dimmedPlanIds.has(plan.mappingId)}
          {@const archived    = plan.wixStatus === 'archived'}
          {@const deadGroups  = (plan.groups || []).filter(g => g.healthStatus === 'not_found').length}
          <div
            class="pm-node"
            class:pm-node-connected={connected}
            class:pm-node-dimmed={dimmed}
            class:pm-node-inactive={plan.status === 'inactive'}
            class:pm-node-archived={archived}
            bind:this={planEls[plan.mappingId]}
          >
            <div class="pm-node-body">
              <div class="pm-node-icon pm-icon-plan">
                {#if plan.planType === 'booking_service'}📅
                {:else if connected}🔗
                {:else}⚡{/if}
              </div>
              <div class="pm-node-info">
                <div class="pm-node-name">{plan.planName}</div>
                <div class="pm-node-sub">
                  {plan.planType === 'booking_service' ? 'Booking Service' : 'Pricing Plan'}
                </div>
                {#if archived}
                  <div class="pm-node-sub pm-sub-archived">Archived on Wix — members keep access until billing ends</div>
                {/if}
              </div>
              <div class="pm-node-meta">
                {#if archived}
                  <span class="pm-pill pm-pill-warning">Archived</span>
                {/if}
                {#if deadGroups > 0}
                  <span class="pm-pill pm-pill-warning">{deadGroups} missing</span>
                {/if}
                {#if connected}
                  <span class="pm-pill pm-pill-connected">{plan.groups.length}×</span>
                {:else}
                  <span class="pm-pill pm-pill-unmapped">unmapped</span>
                {/if}
              </div>
            </div>
            <!-- Right drag port -->
            <button
              class="pm-port pm-port-right"
              class:pm-port-active={connected}
              on:mousedown={e => startDrag(e, plan)}
              title="Drag to connect a hardware group"
              aria-label="Drag to connect"
            >
              <span class="pm-port-dot"></span>
            </button>
          </div>
        {/each}

        {#if plans.length === 0}
          <div class="pm-empty">No plans for this location.</div>
        {/if}
      </div>

      <!-- ── Right column: Hardware Groups ──────────────────────────── -->
      <div class="pm-col pm-col-hardware">
        <div class="pm-col-header">
          <span class="pm-col-label">Hardware Groups</span>
          <span class="pm-col-count">{groups.length}</span>
        </div>

        {#each groups as group (group.id)}
          {@const connCount = plans.filter(p => p.groups?.some(g => g.id === group.id)).length}
          {@const isDead = plans.some(p => p.groups?.some(g => g.id === group.id && g.healthStatus === 'not_found'))}
          <div
            class="pm-node"
            class:pm-node-connected={connCount > 0}
            class:pm-node-warning={isDead}
            class:pm-drop-target={!!drag}
            bind:this={groupEls[group.id]}
            role="button" tabindex="0" on:mouseup={e => dropOnGroup(e, group)}
          >
            <!-- Left drop port -->
            <button
              class="pm-port pm-port-left"
              class:pm-port-active={connCount > 0}
              class:pm-port-drop={!!drag}
              aria-label="Drop target"
            >
              <span class="pm-port-dot"></span>
            </button>
            <div class="pm-node-body">
              <div class="pm-node-icon pm-icon-hardware">{isDead ? '⚠' : '🏢'}</div>
              <div class="pm-node-info">
                <div class="pm-node-name">{group.name}</div>
                <div class="pm-node-sub">{isDead ? 'Group not found' : 'Access Group'}</div>
              </div>
              {#if connCount > 0}
                <div class="pm-node-meta">
                  {#if isDead}
                    <span class="pm-pill pm-pill-warning">missing</span>
                  {:else}
                    <span class="pm-pill pm-pill-connected">{connCount} plan{connCount !== 1 ? 's' : ''}</span>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {/each}

        {#if groups.length === 0}
          <div class="pm-empty">
            No hardware groups.<br>
            <a href="/locations?clientId={CLIENT_ID}" class="pm-empty-link">Add API key →</a>
          </div>
        {/if}
      </div>

    </div>
  {/if}
</div>

<style>
  /* ── Root ──────────────────────────────────────────────────────────── */
  .pm-root {
    background: #0A0C14;
    min-height: 100%;
    color: #E2E8F0;
    font-family: 'Sora', system-ui, sans-serif;
    padding: 0 0 40px;
  }

  /* ── Toolbar ───────────────────────────────────────────────────────── */
  .pm-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 24px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    flex-wrap: wrap;
  }
  .pm-toolbar-left  { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pm-toolbar-right { display: flex; align-items: center; gap: 12px; }

  .pm-loc-tab {
    padding: 6px 14px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.1);
    background: transparent;
    color: rgba(255,255,255,0.5);
    font-size: 13px;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .pm-loc-tab:hover          { color: #fff; border-color: rgba(255,255,255,0.25); }
  .pm-loc-tab.active         {
    background: rgba(79,110,247,0.15);
    border-color: rgba(79,110,247,0.5);
    color: #4F6EF7;
  }

  .pm-search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }
  .pm-search-icon {
    position: absolute;
    left: 10px;
    color: rgba(255,255,255,0.3);
    pointer-events: none;
  }
  .pm-search-input {
    padding: 7px 12px 7px 30px;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.1);
    background: rgba(255,255,255,0.04);
    color: #fff;
    font-size: 13px;
    font-family: inherit;
    width: 200px;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .pm-search-input::placeholder { color: rgba(255,255,255,0.3); }
  .pm-search-input:focus {
    border-color: rgba(79,110,247,0.5);
    box-shadow: 0 0 0 3px rgba(79,110,247,0.12);
  }

  /* ── Status rows ───────────────────────────────────────────────────── */
  .pm-status-row {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 40px 24px;
    color: rgba(255,255,255,0.4);
    font-size: 14px;
  }
  .pm-status-text { font-size: 13px; }
  .pm-spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(79,110,247,0.25);
    border-top-color: #4F6EF7;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .pm-error-banner {
    margin: 24px;
    padding: 14px 18px;
    border-radius: 10px;
    background: rgba(239,68,68,0.1);
    border: 1px solid rgba(239,68,68,0.25);
    color: #FCA5A5;
    font-size: 13px;
  }

  /* ── Canvas ────────────────────────────────────────────────────────── */
  .pm-canvas {
    position: relative;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
    padding: 24px;
    min-height: 500px;
  }

  /* SVG overlay — covers entire canvas, pointer-events off by default */
  .pm-wire-svg {
    position: absolute;
    top: 0; left: 0;
    pointer-events: none;
    z-index: 2;
    overflow: visible;
  }
  /* Wire groups need pointer-events for hover detection */
  :global(.pm-wire-group) { pointer-events: all; }

  /* ── Columns ───────────────────────────────────────────────────────── */
  .pm-col {
    display: flex;
    flex-direction: column;
    gap: 12px;
    z-index: 1;
  }
  .pm-col-plans    { padding-right: 60px; }
  .pm-col-hardware { padding-left: 60px; }

  .pm-col-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .pm-col-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.35);
  }
  .pm-col-count {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 10px;
    background: rgba(255,255,255,0.07);
    color: rgba(255,255,255,0.4);
  }

  /* ── Nodes ─────────────────────────────────────────────────────────── */
  .pm-node {
    position: relative;
    display: flex;
    align-items: center;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px;
    transition: border-color 0.2s, box-shadow 0.2s, opacity 0.2s;
    overflow: visible;
  }
  .pm-node:hover {
    border-color: rgba(79,110,247,0.3);
    box-shadow: 0 0 0 1px rgba(79,110,247,0.1), 0 4px 20px rgba(0,0,0,0.3);
  }
  .pm-node-connected {
    border-color: rgba(79,110,247,0.25);
    background: rgba(79,110,247,0.05);
  }
  .pm-node-connected:hover {
    border-color: rgba(79,110,247,0.5);
    box-shadow: 0 0 0 1px rgba(79,110,247,0.15), 0 0 20px rgba(79,110,247,0.1);
  }
  .pm-node-dimmed {
    opacity: 0.25;
    pointer-events: none;
  }
  .pm-node-inactive {
    opacity: 0.45;
  }
  .pm-node-warning {
    border-color: rgba(245,158,11,0.5);
    background: rgba(245,158,11,0.06);
  }
  .pm-node-warning:hover {
    border-color: rgba(245,158,11,0.7);
    box-shadow: 0 0 0 1px rgba(245,158,11,0.15), 0 4px 20px rgba(0,0,0,0.3);
  }
  .pm-node-archived {
    border-left: 3px solid rgba(245,158,11,0.5);
  }
  .pm-sub-archived {
    font-size: 10px;
    color: rgba(245,158,11,0.7);
    margin-top: 1px;
  }

  /* Drop target highlight during drag */
  .pm-drop-target {
    border-color: rgba(79,110,247,0.4) !important;
    box-shadow: 0 0 0 2px rgba(79,110,247,0.2), 0 0 30px rgba(79,110,247,0.1) !important;
  }
  .pm-drop-target:hover {
    border-color: rgba(74,222,128,0.5) !important;
    box-shadow: 0 0 0 2px rgba(74,222,128,0.2), 0 0 30px rgba(74,222,128,0.12) !important;
  }

  /* Hardware nodes have left padding for the port */
  .pm-col-hardware .pm-node { flex-direction: row; }

  .pm-node-body {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    flex: 1;
    min-width: 0;
  }

  .pm-node-icon {
    width: 28px; height: 28px;
    border-radius: 7px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px;
    flex-shrink: 0;
  }
  .pm-icon-plan     { background: rgba(79,110,247,0.12); }
  .pm-icon-hardware { background: rgba(74,222,128,0.08); }

  .pm-node-info { flex: 1; min-width: 0; }
  .pm-node-name {
    font-size: 12px;
    font-weight: 600;
    color: rgba(255,255,255,0.9);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pm-node-sub {
    font-size: 10px;
    color: rgba(255,255,255,0.3);
    margin-top: 1px;
  }

  .pm-node-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    flex-shrink: 0;
  }

  /* ── Pills ─────────────────────────────────────────────────────────── */
  .pm-pill {
    font-size: 9px;
    font-weight: 700;
    padding: 2px 5px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .pm-pill-connected { background: rgba(79,110,247,0.15);  color: #7B96F9; }
  .pm-pill-unmapped  { background: rgba(239,68,68,0.12);   color: #F87171; }
  .pm-pill-warning   { background: rgba(245,158,11,0.15);  color: #D97706; }
  .pm-pill-archived  { background: rgba(245,158,11,0.15);  color: #D97706; }

  /* ── Ports ─────────────────────────────────────────────────────────── */
  .pm-port {
    position: absolute;
    top: 50%; transform: translateY(-50%);
    width: 24px; height: 24px;
    display: flex; align-items: center; justify-content: center;
    background: none;
    border: none;
    padding: 0;
    cursor: crosshair;
    z-index: 10;
  }
  .pm-port-right { right: -12px; }
  .pm-port-left  { left: -12px; position: relative; top: auto; transform: none;
                   flex-shrink: 0; align-self: center; cursor: default; }

  .pm-port-dot {
    width: 10px; height: 10px;
    border-radius: 50%;
    background: rgba(79,110,247,0.3);
    border: 2px solid rgba(79,110,247,0.5);
    transition: all 0.15s;
    display: block;
  }
  .pm-port-right:hover .pm-port-dot,
  .pm-port-right:active .pm-port-dot {
    background: #4F6EF7;
    border-color: #7B96F9;
    box-shadow: 0 0 8px rgba(79,110,247,0.6);
    transform: scale(1.3);
  }
  .pm-port-active .pm-port-dot {
    background: rgba(79,110,247,0.5);
    border-color: #4F6EF7;
  }
  .pm-port-drop .pm-port-dot {
    background: rgba(74,222,128,0.4);
    border-color: #4ADE80;
    box-shadow: 0 0 10px rgba(74,222,128,0.5);
    transform: scale(1.4);
  }

  /* ── Empty ─────────────────────────────────────────────────────────── */
  .pm-empty {
    padding: 32px 20px;
    text-align: center;
    color: rgba(255,255,255,0.25);
    font-size: 13px;
    line-height: 1.6;
  }
  .pm-empty-link {
    color: #4F6EF7;
    text-decoration: none;
    font-weight: 600;
  }
  .pm-empty-link:hover { text-decoration: underline; }
</style>
