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

// Source metadata — color tokens are CSS variables scoped to #panel-logs.
// The labels (short/plain) come from the shared humanize module so the
// Errors-page incident drawer renders the same source pills with identical
// text. SOURCE_LABELS hex values are not used here; we use the var() form
// for theme-aware coloring.
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

// Imported from /humanize.js (shared with member-incident-drawer.js).
// window.AccessSyncHumanize is loaded as a plain <script> before this
// file in both index.html and logs.ejs.
const humanize     = window.AccessSyncHumanize.humanize;
const severityOf   = window.AccessSyncHumanize.severityOf;
const deriveIntent = window.AccessSyncHumanize.deriveIntent;

const INTENT_TONE_COLOR = {
  error:   'var(--red)',
  warn:    'var(--amber)',
  success: 'var(--sage-dark)',
  info:    'var(--brand)',
};

function IntentBadge({ intent }) {
  if (!intent) return null;
  const color = INTENT_TONE_COLOR[intent.tone] || 'var(--muted)';
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, color, background: color + '1a',
      border: `1px solid ${color}55`, borderRadius: 4, padding: '1px 6px',
      flexShrink: 0, whiteSpace: 'nowrap',
    }}>
      {intent.label}
    </span>
  );
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
  if (sev === 'error')   return <span className="sev-dot sev-error"   title="error"></span>;
  if (sev === 'warn')    return <span className="sev-dot sev-warn"    title="warn"></span>;
  if (sev === 'success') return <span className="sev-dot sev-success" title="success"></span>;
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

  // Deep-link support — if URL has ?openTrace=<uuid>, expand that trace once
  // events arrive and select its first event. Used by the Member Incident
  // Drawer's "Open in Trace Timeline" link (owner-only).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tid = params.get('openTrace');
    if (!tid || events.length === 0) return;
    setExpandedTraces(new Set([tid]));
    const first = events.find(e => e.trace_id === tid);
    if (first) setSelected(first);
  }, [events]);

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
      // Severity precedence: error > warn > success > info. A grant that
      // ultimately succeeded is "success" overall even if the lifecycle had
      // informational breadcrumbs in it.
      const sev = sevs.includes('error') ? 'error'
                : sevs.includes('warn')  ? 'warn'
                : sevs.includes('success') ? 'success'
                : 'info';
      const intent = deriveIntent(sorted);
      return { id, events: sorted, sev, last: sorted[sorted.length-1].ts, first: sorted[0].ts, top: sorted[0], intent };
    }).sort((a,b) => new Date(b.last) - new Date(a.last));
  }, [filtered]);

  const errCount     = filtered.filter(e => severityOf(e) === 'error').length;
  const warnCount    = filtered.filter(e => severityOf(e) === 'warn').length;
  const successCount = filtered.filter(e => severityOf(e) === 'success').length;
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
            <button className="btn-g" style={{height:22,padding:'0 7px',fontSize:10.5}}
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
                      <div style={{fontSize:11.5,fontWeight:600}}>{m.member_name} <span style={{color:'var(--muted)',fontWeight:400,fontSize:10.5}}> · {m.client_name}</span></div>
                      <div style={{fontSize:10.5,color:'var(--text2)'}}>{m.member_email}</div>
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
                    <div style={{fontSize:11.5,fontWeight:600}}>{c.client_name}</div>
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
                      <div className="mono" style={{fontSize:10.5}}>{t.trace_id}</div>
                      <div style={{fontSize:10.5,color:'var(--muted)'}}>{[t.client_name, t.member_name, t.plan_name].filter(Boolean).join(' · ')}</div>
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
                    <div style={{flex:1, minWidth:0,fontSize:11}}>{u.event} <span style={{color:'var(--muted)'}}>· {fmtRel(u.ts)}</span></div>
                  </button>
                ))}
              </>
            )}
            {(!ta.members || ta.members.length === 0) && (!ta.clients || ta.clients.length === 0) && (!ta.traces || ta.traces.length === 0) && (!ta.untraced || ta.untraced.length === 0) && (
              <div style={{padding:'12px 14px',fontSize:11,color:'var(--muted)',textAlign:'center'}}>No matches.</div>
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
          {[['all','All'],['success',plain?'Successes':'Success'],['error',plain?'Failures':'Errors'],['warn','Warnings'],['info','Info']].map(([k,l]) =>
            <button key={k} className={severity === k ? 'on' : ''} onClick={() => setSeverity(k)}>{l}</button>
          )}
        </div>

        <button className="btn-g" onClick={() => setFilterPanelOpen(o => !o)}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2 4h12M4 8h8M6 12h4"/></svg>
          {plain ? 'Where from' : 'Sources'} <span className="tnum" style={{color:'var(--brand)'}}>{activeSources.size}/{ALL_SOURCES.length}</span>
        </button>

        <div style={{flex:1}}/>

        {(activeMember || activeClient) && (
          <span style={{fontSize:11, color:'var(--text2)'}}>
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
        <span style={{color:'var(--muted)',fontSize:10.5,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.05em'}}>Last 24h</span>
        <span className="stat"><span className="v">{filtered.length}</span><span className="l">{plain ? 'things happened' : 'events'}</span></span>
        <span className="stat"><span className="v">{traceCount}</span><span className="l">{plain ? 'requests' : 'traces'}</span></span>
        <span className="stat success"><span className="v">{successCount}</span><span className="l">{plain ? 'successes' : 'granted'}</span></span>
        <span className="stat err"><span className="v">{errCount}</span><span className="l">{plain ? 'failures' : 'errors'}</span></span>
        <span className="stat warn"><span className="v">{warnCount}</span><span className="l">warnings</span></span>
      </div>

      {err && <div className="err">Couldn't load events: {err}</div>}

      <div className="body">
        <div className="feed scroll" style={{overflow:'auto', maxHeight:'calc(100vh - 280px)'}}>
          {loading && <div className="loading">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="empty">
              <div style={{fontSize:28,opacity:.4,marginBottom:8}}>—</div>
              <div>No events in the last 24 hours match the current filters.</div>
              <div style={{fontSize:11, color:'var(--muted)', marginTop:7}}>
                Pre-trace-fix history isn't shown — events from before the trace plumbing fix have no trace_id and are invisible to this view.
              </div>
            </div>
          )}

          {!loading && layout === 'grouped' && groups.map(g => (
            <div key={g.id} className="group">
              <div className={'group-head ' + (expandedTraces.has(g.id) ? '' : 'collapsed')} onClick={() => toggleTraceExpand(g.id)}>
                <span style={{color:'var(--muted)'}}>{expandedTraces.has(g.id) ? '▾' : '▸'}</span>
                <span style={{width:8,height:8,borderRadius:'50%',background:
                  g.sev === 'error'   ? 'var(--red)'
                  : g.sev === 'warn'    ? 'var(--amber)'
                  : g.sev === 'success' ? 'var(--sage-dark)'
                  : 'var(--border2)'}}/>
                {plain ? (
                  <div style={{flex:1,minWidth:0, display:'flex', alignItems:'center', gap:7}}>
                    <IntentBadge intent={g.intent} />
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11.5, color:'var(--text)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                        {humanize(g.top)}
                      </div>
                      <div style={{fontSize:10, color:'var(--muted)', marginTop:2}}>{fmtRel(g.first)} · {g.events.length} steps</div>
                    </div>
                  </div>
                ) : (
                  <>
                    <IntentBadge intent={g.intent} />
                    <span className="mono" style={{fontSize:11,fontWeight:600}}>{g.id.slice(0,8)}</span>
                    <span style={{fontSize:11,color:'var(--text2)'}}>· {g.top.client_name || '(no client)'} · {g.top.member_name || g.top.member_email || '—'}</span>
                    <div style={{flex:1}}/>
                  </>
                )}
                <div style={{display:'flex',gap:3}}>
                  {[...new Set(g.events.map(e => e.source))].slice(0,7).map(s => (
                    <span key={s} title={SOURCES[s]?.label} style={{width:7,height:7,borderRadius:'50%',background:SOURCES[s]?.color || 'var(--muted)'}}/>
                  ))}
                </div>
                <span className="tnum" style={{fontSize:10.5,color:'var(--muted)'}}>{g.events.length} {g.events.length === 1 ? 'event' : 'events'}</span>
              </div>
              {expandedTraces.has(g.id) && g.events.map((e,i) => (
                <Row key={i} ev={e} sel={selected && selected.trace_id === e.trace_id && selected.ts === e.ts}
                     onSelect={() => setSelected(e)} relativeTo={g.first} plain={plain} mode="grouped" />
              ))}
            </div>
          ))}

          {!loading && layout === 'stream' && (
            <div className="group">
              <div style={{display:'grid',gridTemplateColumns:'90px 120px 20px minmax(180px,1fr) 120px 64px',gap:9,padding:'8px 12px',background:'var(--surface)',borderBottom:'1px solid var(--border)',fontSize:9.5,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--muted)'}}>
                <span>{plain ? 'When' : 'Time'}</span><span>{plain ? 'Where from' : 'Source'}</span><span/><span>{plain ? 'What' : 'Event'}</span><span>{plain ? 'Request' : 'Trace'}</span><span style={{textAlign:'right'}}>Sev</span>
              </div>
              {filtered.map((e,i) => (
                <Row key={i} ev={e} sel={selected && selected.trace_id === e.trace_id && selected.ts === e.ts}
                     onSelect={() => setSelected(e)} plain={plain} mode="stream" />
              ))}
            </div>
          )}
        </div>

        {selected && <Drawer ev={selected} traceDetail={traceDetail} role={role} onClose={() => setSelected(null)} onSelectEvent={setSelected} />}
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
        <span className="mono tnum" style={{color:'var(--muted)',fontSize:10}}>+{dt}ms</span>
      ) : (
        <span className="mono tnum" style={{color:'var(--muted)',fontSize:10}}>{plain ? fmtRel(ev.ts) : fmtClock(ev.ts)}</span>
      )}
      <span className={plain ? '' : 'mono'} style={{display:'inline-flex',alignItems:'center',gap:4, color: s.color, fontSize: 10, padding:'1px 6px', border:`1px solid ${s.color}55`, borderRadius:4, justifySelf:'start'}}>
        <span style={{width:5,height:5,borderRadius:'50%',background:s.color}}/>
        {plain ? s.plain : s.short}
      </span>
      <span style={{display:'flex',justifyContent:'center'}}><SeverityDot sev={sev}/></span>
      <span style={{color:'var(--text)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
        {plain ? humanize(ev) : (
          <>
            <span className="mono" style={{color:s.color,fontSize:10.5,marginRight:7}}>{ev.event}</span>
            <span style={{color:'var(--text2)'}}>{ev.client_name || ''}{ev.member_name ? ' · ' + ev.member_name : ''}</span>
          </>
        )}
      </span>
      {mode === 'stream' && <span className="mono" style={{color:'var(--text2)',fontSize:10}}>{ev.trace_id?.slice(0,10)}</span>}
      <span className="mono tnum" style={{color:'var(--muted)',fontSize:10,textAlign:'right'}}>{ev.result || '—'}</span>
    </div>
  );
}

// Copy text to clipboard; falls back to a hidden textarea + execCommand for
// non-secure contexts (some Wix iframe nesting can disable navigator.clipboard).
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('execCommand copy failed'));
    } catch (e) { reject(e); }
  });
}

// Small button that flashes "Copied" for 1.5s after a successful copy.
function CopyButton({ label = 'Copy', getText, style }) {
  const [state, setState] = useState('idle'); // idle | done | err
  return (
    <button
      type="button"
      className="btn-g"
      style={{height:22,padding:'0 8px',fontSize:10.5,gap:4,...style}}
      onClick={(e) => {
        e.stopPropagation();
        Promise.resolve(getText())
          .then((t) => copyToClipboard(t))
          .then(() => { setState('done'); setTimeout(() => setState('idle'), 1500); })
          .catch(() => { setState('err'); setTimeout(() => setState('idle'), 1800); });
      }}
    >
      {state === 'done' ? '✓ Copied' : state === 'err' ? 'Copy failed' : '⧉ ' + label}
    </button>
  );
}

// Trace Admin clipboard format (owner-only).
//
// Self-contained handoff that survives session boundaries — anyone with this
// blob + Railway CLI auth can replay the full trace without external lookups.
//
// Lines:
//   1. `trace <id>`                       — short alias-friendly directive
//   2-N. `# context: …`                   — human-readable header
//   N+1. `# CLI: DATABASE_URL=$(...)`     — full shell command, password
//                                           fetched on demand from Railway CLI
//                                           (Option C — no plaintext password
//                                           in clipboard; see DR-028 spirit).
//
// Pastes cleanly into:
//   - A bash terminal (lines 2-N+1 are comments; line 1 runs if `trace` aliased)
//   - The chat with Claude (Claude parses `trace <id>` and runs the CLI itself)
//   - Slack/Linear (renders as plain text)
function buildTraceAdminText(ev, traceDetail) {
  const ctx = traceDetail?.context || {};
  const id = ev.trace_id || '(none)';
  const lines = [];
  lines.push('trace ' + id);
  // Context as comments — ignored by shell, readable by humans + AI
  const ctxParts = [];
  if (ctx.member_name)   ctxParts.push(ctx.member_name + (ctx.member_email ? ' <' + ctx.member_email + '>' : ''));
  if (ctx.client_name)   ctxParts.push(ctx.client_name);
  if (ctx.plan_name)     ctxParts.push(ctx.plan_name);
  if (ctx.started_at)    ctxParts.push(ctx.started_at);
  if (ctxParts.length)   lines.push('# ' + ctxParts.join(' · '));
  if (ev.event)          lines.push('# event: ' + ev.event + (ev.result ? ' [' + ev.result + ']' : ''));
  lines.push('# CLI: trace ' + id);
  return lines.join('\n');
}

// Build a single readable text blob of the entire trace for clipboard paste.
// Header → context fields → events with timing offsets → full payloads per
// event. Plain ASCII so it pastes cleanly into Slack, Linear, etc.
function buildTraceCopyText(ev, traceDetail) {
  const lines = [];
  const ctx = traceDetail?.context || {};
  lines.push('=== AccessSync Trace ===');
  lines.push('trace_id:    ' + (ev.trace_id || '(none)'));
  if (ctx.started_at)        lines.push('started_at:  ' + ctx.started_at);
  if (ctx.client_name)       lines.push('client:      ' + ctx.client_name + (ctx.client_id ? ' (' + ctx.client_id + ')' : ''));
  if (ctx.member_name)       lines.push('member:      ' + ctx.member_name + (ctx.member_email ? ' <' + ctx.member_email + '>' : ''));
  if (ctx.platform_member_id)lines.push('platform_id: ' + ctx.platform_member_id);
  if (ctx.hardware_user_id)  lines.push('hardware_id: ' + ctx.hardware_user_id + (ctx.hardware_platform ? ' (' + ctx.hardware_platform + ')' : ''));
  if (ctx.plan_name)         lines.push('plan:        ' + ctx.plan_name);
  if (ctx.door_name)         lines.push('door:        ' + ctx.door_name);
  if (ctx.entry_point)       lines.push('entry_point: ' + ctx.entry_point);
  if (ctx.actor_type || ctx.actor_id) lines.push('actor:       ' + (ctx.actor_type || '?') + '/' + (ctx.actor_id || '?'));
  lines.push('');

  const events = traceDetail?.events || [];
  if (events.length === 0) {
    lines.push('(no events on this trace)');
  } else {
    const firstTs = new Date(events[0].ts).getTime();
    lines.push('--- Events (' + events.length + ') ---');
    events.forEach((e, i) => {
      const dt = i === 0 ? 0 : Math.round(new Date(e.ts).getTime() - firstTs);
      lines.push('');
      lines.push('[' + (i + 1) + '/' + events.length + '] +' + dt + 'ms  ' + e.ts);
      lines.push('  source:  ' + e.source);
      lines.push('  event:   ' + e.event);
      lines.push('  result:  ' + (e.result || ''));
      lines.push('  actor:   ' + (e.actor_type || '?') + '/' + (e.actor_id || '?'));
      lines.push('  plain:   ' + humanize(e));
      if (e.detail !== null && e.detail !== undefined) {
        lines.push('  payload:');
        const json = JSON.stringify(e.detail, null, 2);
        json.split('\n').forEach((ln) => lines.push('    ' + ln));
      }
    });
  }
  lines.push('');
  lines.push('=== End trace ===');
  return lines.join('\n');
}

function Drawer({ ev, traceDetail, role, onClose, onSelectEvent }) {
  const s = SOURCES[ev.source] || {};
  return (
    <div className="drawer scroll">
      <div className="drawer-section">
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
          <span style={{padding:'1px 6px',borderRadius:4,fontSize:9.5,fontWeight:500,color:s.color,border:`1px solid ${s.color}55`}}>
            {s.short || ev.source}
          </span>
          <span style={{padding:'1px 6px',borderRadius:4,fontSize:9.5,fontWeight:500,
            color:
              severityOf(ev) === 'error'   ? 'var(--red)'
              : severityOf(ev) === 'warn'    ? 'var(--amber)'
              : severityOf(ev) === 'success' ? 'var(--sage-dark)'
              : 'var(--text2)',
            background:
              severityOf(ev) === 'error'   ? 'var(--red-dim)'
              : severityOf(ev) === 'warn'    ? 'var(--amber-dim)'
              : severityOf(ev) === 'success' ? 'var(--sage-dim)'
              : 'var(--surface)'}}>
            {ev.result || severityOf(ev)}
          </span>
          <div style={{flex:1}}/>
          <CopyButton
            label="Copy trace"
            getText={() => buildTraceCopyText(ev, traceDetail)}
          />
          {role === 'owner' && (
            <CopyButton
              label="Trace Admin"
              getText={() => buildTraceAdminText(ev, traceDetail)}
            />
          )}
          <button onClick={onClose} className="btn-g" style={{height:22,padding:'0 7px'}}>✕</button>
        </div>
        <div className="mono" style={{fontSize:12,fontWeight:600,wordBreak:'break-word'}}>{ev.event}</div>
        <div style={{fontSize:11,color:'var(--text2)',marginTop:5,lineHeight:1.5}}>{humanize(ev)}</div>
        <div style={{display:'flex',gap:12,marginTop:8,fontSize:10.5,color:'var(--muted)'}}>
          <div>actor: <span style={{color:'var(--text2)'}}>{ev.actor_type || ev.actor_id ? `${ev.actor_type || ''}${ev.actor_id ? '/' + ev.actor_id : ''}` : '—'}</span></div>
          <div>at: <span className="mono tnum">{fmtClock(ev.ts)}</span></div>
        </div>
      </div>

      {traceDetail?.context && (
        <div className="drawer-section">
          <h3>Context</h3>
          <div style={{display:'grid',gridTemplateColumns:'auto 1fr',gap:'3px 10px',fontSize:10.5}}>
            {traceDetail.context.client_name && <><span style={{color:'var(--muted)'}}>Client</span><span>{traceDetail.context.client_name}</span></>}
            {traceDetail.context.member_name && traceDetail.context.member_name !== traceDetail.context.member_email && <><span style={{color:'var(--muted)'}}>Member</span><span>{traceDetail.context.member_name}</span></>}
            {traceDetail.context.member_email && <><span style={{color:'var(--muted)'}}>Email</span><span className="mono" style={{fontSize:10}}>{traceDetail.context.member_email}</span></>}
            {traceDetail.context.plan_name && <><span style={{color:'var(--muted)'}}>Plan</span><span>{traceDetail.context.plan_name}</span></>}
            {traceDetail.context.door_name && <><span style={{color:'var(--muted)'}}>Door</span><span>{traceDetail.context.door_name}</span></>}
            {traceDetail.context.hardware_user_id && <><span style={{color:'var(--muted)'}}>Hardware ID</span><span className="mono" style={{fontSize:10}}>{traceDetail.context.hardware_user_id}</span></>}
            {traceDetail.context.entry_point && <><span style={{color:'var(--muted)'}}>Entry</span><span>{traceDetail.context.entry_point}</span></>}
          </div>
        </div>
      )}

      {traceDetail?.events && (
        <div className="drawer-section">
          <h3>Trace · {traceDetail.events.length} {traceDetail.events.length === 1 ? 'event' : 'events'}</h3>
          <div className="mono" style={{fontSize:10,color:'var(--brand)',marginBottom:8}}>{ev.trace_id}</div>
          {traceDetail.events.map((e,i) => {
            const isSel = e.ts === ev.ts && e.event === ev.event;
            const ss = SOURCES[e.source] || {};
            return (
              <div key={i} onClick={() => onSelectEvent(e)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 0',cursor:'pointer',borderLeft:`2px solid ${ss.color || 'var(--border)'}`,paddingLeft:12,marginLeft:4,background:isSel ? 'var(--brand-dim)' : 'transparent',borderRadius:'0 6px 6px 0'}}>
                <span className="mono tnum" style={{fontSize:9.5,color:'var(--muted)',width:34}}>+{i === 0 ? 0 : Math.round(new Date(e.ts) - new Date(traceDetail.events[0].ts))}ms</span>
                <span className="mono" style={{fontSize:10.5,color: ss.color, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{e.event}</span>
                {severityOf(e) !== 'info' && <SeverityDot sev={severityOf(e)}/>}
              </div>
            );
          })}
        </div>
      )}

      <div className="drawer-section">
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:7}}>
          <h3 style={{margin:0}}>Payload</h3>
          <div style={{flex:1}}/>
          <CopyButton
            label="Copy"
            getText={() => JSON.stringify(ev.detail, null, 2)}
          />
        </div>
        <pre className="mono scroll" style={{margin:0,padding:'9px 11px',background:'var(--bg)',borderRadius:7,fontSize:10,color:'var(--text2)',lineHeight:1.55,whiteSpace:'pre-wrap',wordBreak:'break-word',maxHeight:180,overflow:'auto'}}>
{JSON.stringify(ev.detail, null, 2)}
        </pre>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('logs-root')).render(<App/>);
