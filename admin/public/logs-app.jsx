/**
 * @file logs-app.jsx
 * @layer admin/public
 * @role trace-timeline-react-island
 * @reads /admin/logs/events, /admin/logs/typeahead, /admin/logs/trace/:id
 * @stack React 18 + Babel-standalone (CDN)
 * @dr DR-037, DR-041
 *
 * Trace Timeline UI — Sprint 6 Phase 3.
 * Single self-contained React island. Mounts into #logs-root.
 *
 * Features:
 *   - Plain English / Technical voice toggle (cookie-persisted)
 *   - Grouped (by trace_id) / Stream (chronological) layout
 *   - Search typeahead — members, clients, traces, untraced-payload fallback
 *   - Source + severity filters
 *   - Drawer detail view (always Technical — operator inspecting failure wants raw)
 *   - 24h default window, refresh button
 *
 * Drops from prototype: WindowChrome, DesignCanvas, TweaksPanel, Sidebar.
 */

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const SOURCES = {
  activity:      { label: 'activity_event',    short: 'activity',    plain: 'Operator activity', color: 'var(--src-activity)' },
  webhook:       { label: 'webhook_log',       short: 'webhook',     plain: 'Wix webhook',       color: 'var(--src-webhook)' },
  member_access: { label: 'member_access_log', short: 'member',      plain: 'Member access',     color: 'var(--src-member_access)' },
  error_queue:   { label: 'error_queue',       short: 'errors',      plain: 'Job queue',         color: 'var(--src-error_queue)' },
  diagnostic:    { label: 'diagnostic_log',    short: 'diagnostic',  plain: 'Diagnostics',       color: 'var(--src-diagnostic)' },
  admin_audit:   { label: 'adapter_admin_log', short: 'admin',       plain: 'Config history',    color: 'var(--src-admin_audit)' },
  config_alert:  { label: 'config_alert_log',  short: 'alerts',      plain: 'Alerts',            color: 'var(--src-config_alert)' },
};
const ALL_SOURCES = Object.keys(SOURCES);

// Severity derivation: v_trace_timeline.result has different semantics per source.
// Map them to a unified 3-level enum on the client side.
function severityOf(ev) {
  const r = (ev.result || '').toLowerCase();
  if (r === 'error' || r === 'failed' || r === 'rejected' || r === 'critical') return 'error';
  if (r === 'warn' || r === 'warning' || r === 'open') return 'warn';
  return 'info';
}

// Plain English humanizer. Falls back to event name when uncatalogued, with a
// muted hint. Catalog covers events from core/EVENT_REGISTRY.md (DR-038).
function humanize(ev) {
  const c = {
    member: ev.member_name || ev.member_email || null,
    client: ev.client_name || null,
    plan:   ev.plan_name || null,
    door:   ev.door_name || null,
    actor:  ev.actor_id || null,
  };
  const who    = c.member || (c.actor && c.actor !== 'anonymous' ? c.actor : 'Someone');
  const at     = c.client ? ` at ${c.client}` : '';
  const onPlan = c.plan   ? ` on the ${c.plan} plan` : '';
  const door   = c.door   ? ` (${c.door})` : '';
  const e = ev.event || '';

  // Webhook events (event = wixPricingPlans.* / Velo names / our normalized)
  if (e === 'plan.purchased' || e === 'wixPricingPlans.orderPurchased' || e === 'wixPricingPlans.orderUpdated')
    return `${who} subscribed${onPlan}${at} via Wix.`;
  if (e === 'plan.started' || e === 'wixPricingPlans.orderStarted')
    return `${who}'s plan started${onPlan}${at}.`;
  if (e === 'plan.cancelled' || e.includes('orderCanceled') || e.includes('orderEnded'))
    return `${who}'s plan was cancelled${onPlan}${at}.`;
  if (e === 'plan.unpaid_order')
    return `An unpaid Wix order arrived${onPlan} — dropped, no access granted.`;
  if (e === 'booking.confirmed') return `${who} confirmed a booking${at}.`;
  if (e === 'booking.cancelled') return `${who}'s booking was cancelled${at}.`;
  if (e === 'member.deleted')    return `${who} was deleted from Wix${at}.`;

  // Member-access events
  if (e === 'provisioned' || e === 'granted')   return `Set up access for ${who}${door}.`;
  if (e === 'disabled')                         return `Suspended access for ${who}${door} (payment failed or paused).`;
  if (e === 'revoked')                          return `Removed access for ${who}${door}.`;
  if (e === 'deleted')                          return `Deleted ${who}'s hardware user.`;
  if (e === 'location_suspended')               return `Suspended ${who} (location subscription lapsed).`;
  if (e === 'reactivated')                      return `Restored access for ${who}${door}.`;

  // Diagnostic events (most have ALL_CAPS error codes)
  if (e === 'IN_FLIGHT_LOCK')                   return `Concurrent change rejected — already processing ${who}.`;
  if (e === 'ADAPTER_IDENTITY_GATE2_RECOVERY_TRIGGERED') return `Webhook arrived without an email — recovering from Wix.`;
  if (e === 'DB_SLOW_QUERY')                    return `A database query took longer than the threshold.`;
  if (e === 'ADAPTER_NO_IDENTITY')              return `Revoke skipped — no identity record for this member.`;
  if (e === 'QUEUE_REVOKE_NO_IDENTITY')         return `Cancel arrived for a member we never provisioned.`;
  if (e.startsWith('grant.'))                   return `Grant step: ${e.replace('grant.', '').replace(/_/g, ' ')}.`;
  if (e.startsWith('revoke.'))                  return `Revoke step: ${e.replace('revoke.', '').replace(/_/g, ' ')}.`;
  if (e.startsWith('hmac.'))                    return `Webhook signature: ${e.replace('hmac.', '').replace(/_/g, ' ')}.`;

  // Alerts
  if (e === 'no_mapping_found' || e === 'missing_group') return `Plan "${c.plan || 'unknown'}" isn't mapped to a hardware group${at}.`;
  if (e === 'group_not_found')                  return `Hardware group missing — the door it points to no longer exists${at}.`;
  if (e === 'untraceable_hardware_access')      return `${who} has door access but no plan or booking justifies it${at}.`;
  if (e === 'wix_api_unavailable')              return `Wix API didn't respond during reconciliation${at}.`;
  if (e === 'lockdown_detected')                return `A door is currently in lockdown${at}.`;
  if (e === 'api_key_invalid_after_rotation')   return `Hardware API key was rotated but new key is invalid${at}.`;

  // Activity (operator mutations)
  if (e === 'plan_mapping.created')   return `${who || 'An operator'} created a plan mapping${at}.`;
  if (e === 'plan_mapping.updated')   return `${who || 'An operator'} updated a plan mapping${at}.`;
  if (e === 'plan_mapping.deleted')   return `${who || 'An operator'} deleted a plan mapping${at}.`;
  if (e === 'api_key.saved')          return `${who || 'An operator'} saved a hardware API key${at}.`;
  if (e === 'api_key.rotated')        return `${who || 'An operator'} rotated the hardware API key${at}.`;
  if (e === 'location.suspended')     return `${who || 'An operator'} suspended a location${at}.`;
  if (e === 'location.activated')     return `${who || 'An operator'} reactivated a location${at}.`;
  if (e === 'member.synced')          return `${who || 'An operator'} ran a per-member sync${at}.`;
  if (e === 'error.retried')          return `${who || 'An operator'} retried a failed job${at}.`;
  if (e === 'client_deleted')         return `${who || 'An owner'} deleted client ${c.client || ''}.`;

  // Fallback — surface the raw event name + flag missing translation
  return `${e} — (plain English not yet defined)`;
}

function fmtClock(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
}
function fmtRel(iso) {
  const dt = (Date.now() - new Date(iso).getTime()) / 1000;
  if (dt < 60)    return Math.max(0, Math.round(dt)) + 's ago';
  if (dt < 3600)  return Math.round(dt/60) + 'm ago';
  if (dt < 86400) return Math.round(dt/3600) + 'h ago';
  return Math.round(dt/86400) + 'd ago';
}

// Cookie-persist voice toggle
function getVoiceCookie() {
  const m = document.cookie.match(/(?:^|; )as_logs_voice=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : 'plain';
}
function setVoiceCookie(v) {
  document.cookie = `as_logs_voice=${encodeURIComponent(v)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

function SourcePill({ source, plain, on, onClick }) {
  const s = SOURCES[source];
  if (!s) return null;
  const label = plain ? s.plain : s.short;
  const cls = `src-pill ${on ? 'on' : 'off'}`;
  const handler = onClick ? { onClick } : {};
  return (
    <span className={cls} style={{ color: on ? s.color : 'var(--muted)', borderColor: on ? s.color + '55' : 'var(--border)' }} {...handler}>
      <span className="dot" style={{ background: s.color, opacity: on ? 1 : 0.4 }}></span>
      {label}
    </span>
  );
}

function SeverityDot({ sev }) {
  if (sev === 'error') return <span className="sev-dot sev-error" title="error"></span>;
  if (sev === 'warn')  return <span className="sev-dot sev-warn"  title="warn"></span>;
  return <span className="sev-dot sev-info" title="info"></span>;
}

function App() {
  const [voice, setVoice] = useState(getVoiceCookie());
  const [layout, setLayout] = useState('grouped');
  const [activeSources, setActiveSources] = useState(new Set(ALL_SOURCES));
  const [severity, setSeverity] = useState('all');
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [selected, setSelected] = useState(null);
  const [traceDetail, setTraceDetail] = useState(null);
  const [expandedTraces, setExpandedTraces] = useState(new Set());
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [taOpen, setTaOpen] = useState(false);
  const [ta, setTa] = useState(null);
  const [activeMember, setActiveMember] = useState(null); // { id, name }
  const [activeClient, setActiveClient] = useState(null); // { id, name }
  const [role, setRole] = useState(null); // 'owner' | 'operator' — set by first events response

  const plain = voice === 'plain';
  const isOperator = role === 'operator';

  // Persist voice toggle
  useEffect(() => { setVoiceCookie(voice); }, [voice]);

  // Fetch events
  const loadEvents = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (activeClient) params.set('client_id', activeClient.id);
      params.set('limit', '300');
      const res = await fetch('/admin/logs/events?' + params.toString(), { credentials: 'include' });
      if (!res.ok) throw new Error('events ' + res.status);
      const json = await res.json();
      setEvents(json.events || []);
      if (json.role) setRole(json.role);
      // Auto-expand first 3 traces for grouped view
      const traces = [...new Set((json.events || []).map(e => e.trace_id))].slice(0, 3);
      setExpandedTraces(new Set(traces));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [activeClient]);

  useEffect(() => { loadEvents(); }, [loadEvents]);

  // Fetch trace detail when selection changes (drawer)
  useEffect(() => {
    if (!selected) { setTraceDetail(null); return; }
    let off = false;
    fetch('/admin/logs/trace/' + selected.trace_id, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (!off) setTraceDetail(j); })
      .catch(() => {});
    return () => { off = true; };
  }, [selected?.trace_id]);

  // Typeahead
  useEffect(() => {
    if (!query.trim() || query.trim().length < 2) { setTa(null); return; }
    const t = setTimeout(() => {
      fetch('/admin/logs/typeahead?q=' + encodeURIComponent(query.trim()), { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(j => setTa(j))
        .catch(() => setTa(null));
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // Apply filters client-side (server returns broader set; we narrow without re-fetching)
  const filtered = useMemo(() => {
    return events.filter(e => {
      if (!activeSources.has(e.source)) return false;
      if (severity !== 'all' && severityOf(e) !== severity) return false;
      if (activeMember) {
        // Match member rows by member_email present in row's enriched fields
        const hit = (e.member_name && e.member_name === activeMember.name) ||
                    (e.member_email && e.member_email === activeMember.email);
        if (!hit) return false;
      }
      return true;
    });
  }, [events, activeSources, severity, activeMember]);

  // Group by trace_id, ordered by latest event desc
  const groups = useMemo(() => {
    const map = {};
    for (const e of filtered) (map[e.trace_id] ||= []).push(e);
    return Object.entries(map).map(([id, evs]) => {
      const sorted = [...evs].sort((a,b) => new Date(a.ts) - new Date(b.ts));
      const sevs = sorted.map(severityOf);
      const sev = sevs.includes('error') ? 'error' : sevs.includes('warn') ? 'warn' : 'info';
      return { id, events: sorted, sev, last: sorted[sorted.length-1].ts, first: sorted[0].ts, top: sorted[0] };
    }).sort((a,b) => new Date(b.last) - new Date(a.last));
  }, [filtered]);

  const errCount  = filtered.filter(e => severityOf(e) === 'error').length;
  const warnCount = filtered.filter(e => severityOf(e) === 'warn').length;
  const traceCount = new Set(filtered.map(e => e.trace_id)).size;

  const pickResult = (kind, payload) => {
    setTaOpen(false);
    setQuery('');
    if (kind === 'member') setActiveMember({ id: payload.member_id, name: payload.member_name, email: payload.member_email });
    else if (kind === 'client') setActiveClient({ id: payload.client_id, name: payload.client_name });
    else if (kind === 'trace') {
      // Expand and select first event in that trace if present
      setExpandedTraces(new Set([payload.trace_id]));
      const first = events.find(e => e.trace_id === payload.trace_id);
      if (first) setSelected(first);
    }
  };

  const toggleSource = (s) => {
    const ns = new Set(activeSources);
    ns.has(s) ? ns.delete(s) : ns.add(s);
    setActiveSources(ns);
  };

  const toggleTraceExpand = (tid) => {
    const ns = new Set(expandedTraces);
    ns.has(tid) ? ns.delete(tid) : ns.add(tid);
    setExpandedTraces(ns);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{plain ? 'Activity' : 'Trace Timeline'}</h1>
          <div className="page-sub">
            {plain
              ? (isOperator
                  ? 'Plain-English view of every webhook, grant, and alert at your gym in the last 24 hours.'
                  : 'Plain-English view of every webhook, grant, and alert across all clients in the last 24 hours.')
              : (isOperator
                  ? 'v_trace_timeline · scoped to your gym · last 24h'
                  : 'v_trace_timeline · all clients · last 24h')}
          </div>
        </div>
        <div style={{display:'flex',gap:8}}>
          <button className="btn-g" onClick={loadEvents} title="Refresh">↻ Refresh</button>
        </div>
      </div>

      {/* Search box with typeahead */}
      <div style={{position:'relative', marginBottom:12}}>
        <div className="search-box">
          <span style={{color:'var(--muted)',display:'flex'}}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>
          </span>
          <input
            value={query}
            onChange={e => { setQuery(e.target.value); setTaOpen(true); }}
            onFocus={() => setTaOpen(true)}
            onBlur={() => setTimeout(() => setTaOpen(false), 160)}
            placeholder={
              plain
                ? (isOperator ? "Search a member or request" : "Search a member, client, or request")
                : (isOperator ? "Search trace_id, member_id, member email…" : "Search trace_id, member_id, client name…")
            }
          />
          {(activeMember || activeClient) && (
            <button className="btn-g" style={{height:24,padding:'0 8px',fontSize:11.5}}
              onClick={() => { setActiveMember(null); setActiveClient(null); }}>
              Clear filter
            </button>
          )}
          <span className="kbd">⌘K</span>
        </div>
        {taOpen && query && ta && (
          <div className="typeahead">
            {ta.members && ta.members.length > 0 && (
              <>
                <div className="ta-group-label">Members · {ta.members.length}</div>
                {ta.members.map(m => (
                  <button key={m.member_id} className="ta-row" onMouseDown={() => pickResult('member', m)}>
                    <div className="avatar">{(m.member_name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase()}</div>
                    <div style={{flex:1, minWidth:0}}>
                      <div style={{fontSize:13,fontWeight:600}}>{m.member_name} <span style={{color:'var(--muted)',fontWeight:400,fontSize:11.5}}> · {m.client_name}</span></div>
                      <div style={{fontSize:11.5,color:'var(--text2)'}}>{m.member_email}</div>
                    </div>
                  </button>
                ))}
              </>
            )}
            {ta.clients && ta.clients.length > 0 && (
              <>
                <div className="ta-group-label">Clients · {ta.clients.length}</div>
                {ta.clients.map(c => (
                  <button key={c.client_id} className="ta-row" onMouseDown={() => pickResult('client', c)}>
                    <div className="avatar" style={{background:'var(--brand-dim)',color:'var(--brand)'}}>{c.client_name.split(' ').map(w=>w[0]).slice(0,2).join('')}</div>
                    <div style={{fontSize:13,fontWeight:600}}>{c.client_name}</div>
                  </button>
                ))}
              </>
            )}
            {ta.traces && ta.traces.length > 0 && (
              <>
                <div className="ta-group-label">Traces · {ta.traces.length}</div>
                {ta.traces.map(t => (
                  <button key={t.trace_id} className="ta-row" onMouseDown={() => pickResult('trace', t)}>
                    <span style={{width:10,height:10,borderRadius:'50%',background:'var(--brand)',flexShrink:0}}></span>
                    <div style={{flex:1, minWidth:0}}>
                      <div className="mono" style={{fontSize:11.5}}>{t.trace_id}</div>
                      <div style={{fontSize:11.5,color:'var(--muted)'}}>{[t.client_name, t.member_name, t.plan_name].filter(Boolean).join(' · ')}</div>
                    </div>
                  </button>
                ))}
              </>
            )}
            {ta.untraced && ta.untraced.length > 0 && (
              <>
                <div className="ta-group-label">Untraced payloads · {ta.untraced.length}</div>
                {ta.untraced.map((u,i) => (
                  <button key={i} className="ta-row" onMouseDown={() => { setExpandedTraces(new Set([u.trace_id])); setTaOpen(false); setQuery(''); }}>
                    <span style={{width:10,height:10,borderRadius:'50%',background:'var(--amber)',flexShrink:0}}></span>
                    <div style={{flex:1, minWidth:0,fontSize:12}}>{u.event} <span style={{color:'var(--muted)'}}>· {fmtRel(u.ts)}</span></div>
                  </button>
                ))}
              </>
            )}
            {(!ta.members || ta.members.length === 0) && (!ta.clients || ta.clients.length === 0) && (!ta.traces || ta.traces.length === 0) && (!ta.untraced || ta.untraced.length === 0) && (
              <div style={{padding:'14px 16px',fontSize:12.5,color:'var(--muted)',textAlign:'center'}}>No matches.</div>
            )}
          </div>
        )}
      </div>

      {/* Toolbar — voice + layout + filter trigger */}
      <div className="toolbar">
        <div className="seg">
          <button className={voice === 'plain' ? 'on' : ''} onClick={() => setVoice('plain')}>✨ Plain English</button>
          <button className={voice === 'technical' ? 'on' : ''} onClick={() => setVoice('technical')}>Technical</button>
        </div>
        <div className="seg">
          <button className={layout === 'grouped' ? 'on' : ''} onClick={() => setLayout('grouped')}>{plain ? 'By request' : 'Grouped'}</button>
          <button className={layout === 'stream'  ? 'on' : ''} onClick={() => setLayout('stream')}>{plain ? 'As it happened' : 'Stream'}</button>
        </div>

        <div className="seg">
          {[['all','All'],['error',plain?'Failures':'Errors'],['warn','Warnings'],['info','Info']].map(([k,l]) =>
            <button key={k} className={severity === k ? 'on' : ''} onClick={() => setSeverity(k)}>{l}</button>
          )}
        </div>

        <button className="btn-g" onClick={() => setFilterPanelOpen(o => !o)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12M4 8h8M6 12h4"/></svg>
          {plain ? 'Where from' : 'Sources'} <span className="tnum" style={{color:'var(--brand)'}}>{activeSources.size}/{ALL_SOURCES.length}</span>
        </button>

        <div style={{flex:1}}/>

        {(activeMember || activeClient) && (
          <span style={{fontSize:12, color:'var(--text2)'}}>
            Filtered by: {activeMember && <strong>{activeMember.name}</strong>} {activeClient && <strong>{activeClient.name}</strong>}
          </span>
        )}
      </div>

      {filterPanelOpen && (
        <div className="filter-rail">
          {ALL_SOURCES.map(s => (
            <SourcePill key={s} source={s} plain={plain} on={activeSources.has(s)} onClick={() => toggleSource(s)} />
          ))}
        </div>
      )}

      <div className="stat-strip">
        <span style={{color:'var(--muted)',fontSize:11.5,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}}>Last 24h</span>
        <span className="stat"><span className="v">{filtered.length}</span><span className="l">{plain ? 'things happened' : 'events'}</span></span>
        <span className="stat"><span className="v">{traceCount}</span><span className="l">{plain ? 'requests' : 'traces'}</span></span>
        <span className="stat err"><span className="v">{errCount}</span><span className="l">{plain ? 'failures' : 'errors'}</span></span>
        <span className="stat warn"><span className="v">{warnCount}</span><span className="l">warnings</span></span>
      </div>

      {err && <div className="err">Couldn't load events: {err}</div>}

      <div className="body">
        <div className="feed scroll" style={{overflow:'auto', maxHeight:'calc(100vh - 280px)'}}>
          {loading && <div className="loading">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="empty">
              <div style={{fontSize:32,opacity:.4,marginBottom:10}}>—</div>
              <div>No events in the last 24 hours match the current filters.</div>
              <div style={{fontSize:12, color:'var(--muted)', marginTop:8}}>
                Pre-trace-fix history isn't shown — events from before the trace plumbing fix have no trace_id and are invisible to this view.
              </div>
            </div>
          )}

          {!loading && layout === 'grouped' && groups.map(g => (
            <div key={g.id} className="group">
              <div className={'group-head ' + (expandedTraces.has(g.id) ? '' : 'collapsed')} onClick={() => toggleTraceExpand(g.id)}>
                <span style={{color:'var(--muted)'}}>{expandedTraces.has(g.id) ? '▾' : '▸'}</span>
                <span style={{width:8,height:8,borderRadius:'50%',background: g.sev === 'error' ? 'var(--red)' : g.sev === 'warn' ? 'var(--amber)' : 'var(--sage-dark)'}}/>
                {plain ? (
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13.5, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                      {humanize(g.top)}
                    </div>
                    <div style={{fontSize:11, color:'var(--muted)', marginTop:3}}>{fmtRel(g.first)} · {g.events.length} steps</div>
                  </div>
                ) : (
                  <>
                    <span className="mono" style={{fontSize:12,fontWeight:600}}>{g.id.slice(0,8)}</span>
                    <span style={{fontSize:12.5,color:'var(--text2)'}}>· {g.top.client_name || '(no client)'} · {g.top.member_name || g.top.member_email || '—'}</span>
                    <div style={{flex:1}}/>
                  </>
                )}
                <div style={{display:'flex',gap:3}}>
                  {[...new Set(g.events.map(e => e.source))].slice(0,7).map(s => (
                    <span key={s} title={SOURCES[s]?.label} style={{width:7,height:7,borderRadius:'50%',background:SOURCES[s]?.color || 'var(--muted)'}}/>
                  ))}
                </div>
                <span className="tnum" style={{fontSize:11.5,color:'var(--muted)'}}>{g.events.length} events</span>
              </div>
              {expandedTraces.has(g.id) && g.events.map((e,i) => (
                <Row key={i} ev={e} sel={selected && selected.trace_id === e.trace_id && selected.ts === e.ts}
                     onSelect={() => setSelected(e)} relativeTo={g.first} plain={plain} mode="grouped" />
              ))}
            </div>
          ))}

          {!loading && layout === 'stream' && (
            <div className="group">
              <div style={{display:'grid',gridTemplateColumns:'100px 130px 22px minmax(180px,1fr) 130px 70px',gap:10,padding:'9px 14px',background:'var(--surface)',borderBottom:'1px solid var(--border)',fontSize:10.5,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)'}}>
                <span>{plain ? 'When' : 'Time'}</span><span>{plain ? 'Where from' : 'Source'}</span><span/><span>{plain ? 'What' : 'Event'}</span><span>{plain ? 'Request' : 'Trace'}</span><span style={{textAlign:'right'}}>Sev</span>
              </div>
              {filtered.map((e,i) => (
                <Row key={i} ev={e} sel={selected && selected.trace_id === e.trace_id && selected.ts === e.ts}
                     onSelect={() => setSelected(e)} plain={plain} mode="stream" />
              ))}
            </div>
          )}
        </div>

        {selected && <Drawer ev={selected} traceDetail={traceDetail} onClose={() => setSelected(null)} onSelectEvent={setSelected} />}
      </div>
    </>
  );
}

function Row({ ev, sel, onSelect, relativeTo, plain, mode }) {
  const s = SOURCES[ev.source] || { color:'var(--muted)', short: ev.source };
  const sev = severityOf(ev);
  const dt = relativeTo ? Math.round((new Date(ev.ts) - new Date(relativeTo))) : null;
  return (
    <div className={'row ' + (mode === 'stream' ? 'stream-row ' : '') + (sel ? 'sel' : '')} onClick={onSelect}>
      <div className="accent" style={{background: s.color, opacity: sel ? 1 : 0.6}}/>
      {mode === 'grouped' ? (
        <span className="mono tnum" style={{color:'var(--muted)',fontSize:11}}>+{dt}ms</span>
      ) : (
        <span className="mono tnum" style={{color:'var(--muted)',fontSize:11}}>{plain ? fmtRel(ev.ts) : fmtClock(ev.ts)}</span>
      )}
      <span className={plain ? '' : 'mono'} style={{display:'inline-flex',alignItems:'center',gap:5, color: s.color, fontSize: 11, padding:'1px 7px', border:`1px solid ${s.color}55`, borderRadius:5, justifySelf:'start'}}>
        <span style={{width:5,height:5,borderRadius:'50%',background:s.color}}/>
        {plain ? s.plain : s.short}
      </span>
      <span style={{display:'flex',justifyContent:'center'}}><SeverityDot sev={sev}/></span>
      <span style={{color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
        {plain ? humanize(ev) : (
          <>
            <span className="mono" style={{color:s.color,fontSize:11.5,marginRight:8}}>{ev.event}</span>
            <span style={{color:'var(--text2)'}}>{ev.client_name || ''}{ev.member_name ? ' · ' + ev.member_name : ''}</span>
          </>
        )}
      </span>
      {mode === 'stream' && <span className="mono" style={{color:'var(--text2)',fontSize:11}}>{ev.trace_id?.slice(0,10)}</span>}
      <span className="mono tnum" style={{color:'var(--muted)',fontSize:11,textAlign:'right'}}>{ev.result || '—'}</span>
    </div>
  );
}

function Drawer({ ev, traceDetail, onClose, onSelectEvent }) {
  const s = SOURCES[ev.source] || {};
  return (
    <div className="drawer scroll">
      <div className="drawer-section">
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
          <span style={{padding:'1px 7px',borderRadius:5,fontSize:10.5,fontWeight:500,color:s.color,border:`1px solid ${s.color}55`}}>
            {s.short || ev.source}
          </span>
          <span style={{padding:'1px 7px',borderRadius:5,fontSize:10.5,fontWeight:500,
            color: severityOf(ev) === 'error' ? 'var(--red)' : severityOf(ev) === 'warn' ? 'var(--amber)' : 'var(--text2)',
            background: severityOf(ev) === 'error' ? 'var(--red-dim)' : severityOf(ev) === 'warn' ? 'var(--amber-dim)' : 'var(--surface)'}}>
            {ev.result || severityOf(ev)}
          </span>
          <div style={{flex:1}}/>
          <button onClick={onClose} className="btn-g" style={{height:24,padding:'0 8px'}}>✕</button>
        </div>
        <div className="mono" style={{fontSize:13.5,fontWeight:600,wordBreak:'break-word'}}>{ev.event}</div>
        <div style={{fontSize:12.5,color:'var(--text2)',marginTop:6,lineHeight:1.5}}>{humanize(ev)}</div>
        <div style={{display:'flex',gap:14,marginTop:10,fontSize:11.5,color:'var(--muted)'}}>
          <div>actor: <span style={{color:'var(--text2)'}}>{ev.actor_type}/{ev.actor_id}</span></div>
          <div>at: <span className="mono tnum">{fmtClock(ev.ts)}</span></div>
        </div>
      </div>

      {traceDetail?.context && (
        <div className="drawer-section">
          <h3>Context</h3>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'4px 12px',fontSize:12}}>
            {traceDetail.context.client_name && <><span style={{color:'var(--muted)'}}>Client</span><span>{traceDetail.context.client_name}</span></>}
            {traceDetail.context.member_name && <><span style={{color:'var(--muted)'}}>Member</span><span>{traceDetail.context.member_name}</span></>}
            {traceDetail.context.member_email && <><span style={{color:'var(--muted)'}}>Email</span><span className="mono" style={{fontSize:11}}>{traceDetail.context.member_email}</span></>}
            {traceDetail.context.plan_name && <><span style={{color:'var(--muted)'}}>Plan</span><span>{traceDetail.context.plan_name}</span></>}
            {traceDetail.context.door_name && <><span style={{color:'var(--muted)'}}>Door</span><span>{traceDetail.context.door_name}</span></>}
            {traceDetail.context.hardware_user_id && <><span style={{color:'var(--muted)'}}>Hardware ID</span><span className="mono" style={{fontSize:11}}>{traceDetail.context.hardware_user_id}</span></>}
            {traceDetail.context.entry_point && <><span style={{color:'var(--muted)'}}>Entry</span><span>{traceDetail.context.entry_point}</span></>}
          </div>
        </div>
      )}

      {traceDetail?.events && (
        <div className="drawer-section">
          <h3>Trace · {traceDetail.events.length} events</h3>
          <div className="mono" style={{fontSize:11,color:'var(--brand)',marginBottom:10}}>{ev.trace_id}</div>
          {traceDetail.events.map((e,i) => {
            const isSel = e.ts === ev.ts && e.event === ev.event;
            const ss = SOURCES[e.source] || {};
            return (
              <div key={i} onClick={() => onSelectEvent(e)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 0',cursor:'pointer',borderLeft:`2px solid ${ss.color || 'var(--border)'}`,paddingLeft:12,marginLeft:4,background:isSel ? 'var(--brand-dim)' : 'transparent',borderRadius:'0 6px 6px 0'}}>
                <span className="mono tnum" style={{fontSize:10.5,color:'var(--muted)',width:36}}>+{i === 0 ? 0 : Math.round(new Date(e.ts) - new Date(traceDetail.events[0].ts))}ms</span>
                <span className="mono" style={{fontSize:11.5,color: ss.color, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{e.event}</span>
                {severityOf(e) !== 'info' && <SeverityDot sev={severityOf(e)}/>}
              </div>
            );
          })}
        </div>
      )}

      <div className="drawer-section">
        <h3>Payload</h3>
        <pre className="mono scroll" style={{margin:0,padding:'10px 12px',background:'var(--bg)',borderRadius:8,fontSize:11,color:'var(--text2)',lineHeight:1.55,whiteSpace:'pre-wrap',wordBreak:'break-word',maxHeight:200,overflow:'auto'}}>
{JSON.stringify(ev.detail, null, 2)}
        </pre>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('logs-root')).render(<App/>);
