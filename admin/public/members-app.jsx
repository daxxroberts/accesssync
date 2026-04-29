// Main Members app

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "density": "regular",
  "showStats": true,
  "submemberStyle": "expand"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [members, setMembers] = useState(() => window.MEMBERS || []);
  const [pageContext, setPageContext] = useState(() => window.__MEMBERS_CONTEXT || {});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState({ key: "since", dir: "desc" });
  const [expandedPlans, setExpandedPlans] = useState(() => new Set());
  const [expandedSubs, setExpandedSubs] = useState(() => new Set());
  const [openMenu, setOpenMenu] = useState(null);
  const [openError, setOpenError] = useState(null);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [drawerId, setDrawerId] = useState(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 8;

  // Bridge populates window.MEMBERS asynchronously and fires 'membersLoaded'.
  useEffect(() => {
    function onLoaded() {
      setMembers([...(window.MEMBERS || [])]);
      setPageContext({ ...(window.__MEMBERS_CONTEXT || {}) });
    }
    document.addEventListener("membersLoaded", onLoaded);
    if (window.MEMBERS && window.MEMBERS.length) onLoaded();
    return () => document.removeEventListener("membersLoaded", onLoaded);
  }, []);

  // Apply theme + density (brand color is locked per design system DR-014)
  useEffect(() => {
    document.documentElement.setAttribute("data-mode", t.theme);
    document.documentElement.setAttribute("data-density", t.density);
  }, [t.theme, t.density]);

  const filtered = useMemo(() => {
    let rows = members;
    if (filter === "active") rows = rows.filter(m => m.status === "active");
    else if (filter === "holder") rows = rows.filter(m => m.role === "Plan Holder");
    else if (filter === "suspended") rows = rows.filter(m => m.status === "suspended" || m.status === "expired");
    else if (filter === "pending") rows = rows.filter(m => m.status === "pending");

    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(m =>
        memberFullName(m).toLowerCase().includes(q) ||
        m.email.toLowerCase().includes(q) ||
        m.plan.toLowerCase().includes(q) ||
        (m.additional || []).some(a => memberFullName(a).toLowerCase().includes(q) || a.email.toLowerCase().includes(q))
      );
    }

    const dir = sort.dir === "asc" ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (sort.key === "name") { av = memberFullName(a); bv = memberFullName(b); }
      if (sort.key === "since") {
        av = Date.parse(a.since); bv = Date.parse(b.since);
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  }, [members, query, filter, sort]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { if (page > totalPages) setPage(1); }, [totalPages, page]);

  const counts = useMemo(() => ({
    all: members.length,
    active: members.filter(m => m.status === "active").length,
    holder: members.filter(m => m.role === "Plan Holder").length,
    suspended: members.filter(m => m.status === "suspended" || m.status === "expired").length,
    pending: members.filter(m => m.status === "pending").length,
  }), [members]);

  const totalAdditional = useMemo(
    () => members.reduce((n, m) => n + (m.additional?.length || 0), 0),
    [members]
  );

  const errorMembers = useMemo(
    () => members.filter(m => m.error),
    [members]
  );

  const handleRemove = (m) => {
    setRemoveTarget(null);
    // In a real app, you'd POST to an API. Here we just close.
  };

  const togglePlan = (id) => {
    const next = new Set(expandedPlans);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedPlans(next);
  };
  const toggleSubs = (id) => {
    const next = new Set(expandedSubs);
    next.has(id) ? next.delete(id) : next.add(id);
    setExpandedSubs(next);
  };

  const handleSort = (key) => {
    setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  };

  const drawerMember = drawerId
    ? members.find(m => m.id === drawerId) ||
      members.flatMap(m => m.additional || []).find(a => a.id === drawerId)
    : null;

  const sortIcon = (key) => sort.key === key ? (sort.dir === "asc" ? "↑" : "↓") : "↕";

  return (
    <div className="page">

      <div className="page-head">
        <div>
          <div className="crumbs">
            <a href="#">Workspace</a>
            <span className="sep">/</span>
            <a href="#">{pageContext.clientName || "—"}</a>
            <span className="sep">/</span>
            <span style={{color:"var(--text2)"}}>Members</span>
          </div>
          <h1 className="title">Members</h1>
          <div className="subtitle">
            {members.length} plan holders · {totalAdditional} additional members{pageContext.lastSyncedLabel ? ` · synced ${pageContext.lastSyncedLabel}` : ""}
          </div>
        </div>
        <div className="head-actions">
          <button className="btn btn-ghost"><Icon name="download" />Export</button>
        </div>
      </div>

      {t.showStats && (
        <div className="stats">
          <div className="stat">
            <div className="stat-label">Active members</div>
            <div className="stat-value tabular">{counts.active + totalAdditional}</div>
            <div className="stat-meta"><span>{members.length} plan holders + {totalAdditional} additional</span></div>
          </div>
          <div className="stat">
            <div className="stat-label">Plan holders</div>
            <div className="stat-value tabular">{counts.holder}</div>
            <div className="stat-meta"><span>{pageContext.planTypeCount ? `across ${pageContext.planTypeCount} plan types` : "—"}</span></div>
          </div>
          <div className="stat">
            <div className="stat-label">Door entries · today</div>
            <div className="stat-value tabular">—</div>
            <div className="stat-meta"><span>not yet wired</span></div>
          </div>
          <div className="stat">
            <div className="stat-label">Needs attention</div>
            <div className="stat-value tabular" style={{color: counts.suspended > 0 ? "var(--red)" : "var(--text)"}}>
              {counts.suspended + counts.pending}
            </div>
            <div className="stat-meta">
              <span>{counts.suspended} suspended · {counts.pending} pending</span>
            </div>
          </div>
        </div>
      )}

      <div className="toolbar">
        <div className="search">
          <Icon name="search" className="ic-16" />
          <input
            type="text"
            placeholder="Search by name, email, or plan…"
            value={query}
            onChange={e => { setQuery(e.target.value); setPage(1); }}
          />
          {!query && <kbd>⌘K</kbd>}
          {query && (
            <button className="btn-icon btn" style={{width:22,height:22}} onClick={() => setQuery("")}>
              <Icon name="x" className="ic-12"/>
            </button>
          )}
        </div>
        <div className="tb-divider" />
        {FILTERS.map(f => (
          <button
            key={f.id}
            className={`filter-chip ${filter === f.id ? "active" : ""}`}
            onClick={() => { setFilter(f.id); setPage(1); }}
          >
            {f.label}
            <span className="count">{counts[f.id]}</span>
          </button>
        ))}
        <div className="tb-divider" />
        <button className="btn btn-ghost"><Icon name="filter" />More filters</button>
      </div>

      <div className="members-card">
        {errorMembers.length > 0 && (
          <div className="err-banner">
            <Icon name="alert" />
            <span className="count-pill">{errorMembers.length}</span>
            <span>{errorMembers.length === 1 ? "member needs attention" : "members need attention"}</span>
            <button className="show-link" onClick={() => setFilter("suspended")}>Show only errors →</button>
          </div>
        )}
        <table className="members-tbl">
          <thead>
            <tr>
              <th style={{width:"30%"}}>
                <button className={`sort-btn ${sort.key==="name"?"sorted":""}`} onClick={() => handleSort("name")}>
                  Member <span className="sort-arrow">{sortIcon("name")}</span>
                </button>
              </th>
              <th style={{width:"22%"}}>Plan</th>
              <th style={{width:"14%"}}>Role</th>
              <th style={{width:"14%"}}>Access</th>
              <th style={{width:"12%"}}>
                <button className={`sort-btn ${sort.key==="since"?"sorted":""}`} onClick={() => handleSort("since")}>
                  Added <span className="sort-arrow">{sortIcon("since")}</span>
                </button>
              </th>
              <th style={{width:"80px",textAlign:"right"}}></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan="6"><div className="empty">No members match your search.</div></td></tr>
            )}
            {pageRows.flatMap(m => {
              const isPlanOpen = expandedPlans.has(m.id);
              const isSubsOpen = expandedSubs.has(m.id);
              const hasSubs = (m.additional?.length || 0) > 0;
              const accessKind = m.status === "active"
                ? (m.role === "Plan Holder" ? "holder" : "active")
                : m.status;

              const rows = [];

              // Main row
              rows.push(
                <tr key={`r-${m.id}`} className={`row-main ${m.error ? "has-error" : ""} ${isSubsOpen && hasSubs ? "is-expanded" : ""}`}>
                  <td>
                    <div className="member-cell">
                      <Avatar member={m} kind={m.status === "active" ? (m.role === "Plan Holder" ? "holder" : "active") : m.status} />
                      <div style={{minWidth:0}}>
                        <div className="member-name" onClick={() => setDrawerId(m.id)}>
                          <span className="name-link">{memberFullName(m)}</span>
                        </div>
                        <div className="member-email">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="plan-cell">
                      <PlanBadge plan={m.plan} />
                      <div style={{display:"flex",gap:14}}>
                        <button className={`plan-meta-btn ${isPlanOpen?"open":""}`} onClick={() => togglePlan(m.id)}>
                          Plan details <span className="chev">▼</span>
                        </button>
                        {hasSubs && (
                          <button className={`plan-meta-btn ${isSubsOpen?"open":""}`} onClick={() => toggleSubs(m.id)}>
                            <Icon name="users" className="ic-12" /> {m.additional.length} additional <span className="chev">▼</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{color:"var(--text2)",fontSize:13}}>{m.role}</td>
                  <td><StatusPill status={accessKind} label={m.accessStatus} /></td>
                  <td className="tabular" style={{color:"var(--muted)",fontSize:12.5}}>{m.since}</td>
                  <td style={{textAlign:"right"}}>
                    <div className={`row-actions ${openMenu === m.id || openError === m.id ? "open" : ""}`}>
                      {m.error && (
                        <div className="menu-anchor">
                          <button
                            className="row-btn"
                            title="See error"
                            style={{color:"var(--red)"}}
                            onClick={(e)=>{e.stopPropagation(); setOpenError(openError === m.id ? null : m.id); setOpenMenu(null);}}
                          >
                            <Icon name="alert" />
                          </button>
                          {openError === m.id && (
                            <ErrorPopover error={m.error} onClose={() => setOpenError(null)} />
                          )}
                        </div>
                      )}
                      <div className="menu-anchor">
                        <button className="row-btn" onClick={(e)=>{e.stopPropagation(); setOpenMenu(openMenu === m.id ? null : m.id); setOpenError(null);}}>
                          <Icon name="more" />
                        </button>
                        <ActionsMenu
                          open={openMenu === m.id}
                          onClose={() => setOpenMenu(null)}
                          onAction={(a) => {
                            setOpenMenu(null);
                            if (a === "error") setOpenError(m.id);
                            if (a === "remove") setRemoveTarget(m);
                          }}
                          member={m}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );

              // Plan detail row (expanded)
              if (isPlanOpen) {
                rows.push(
                  <tr key={`pd-${m.id}`} className="plan-detail-row-wrap">
                    <td colSpan="6">
                      <div className="plan-detail-card">
                        <div className="pd-cell">
                          <div className="pd-label">Plan type</div>
                          <div className="pd-value">{m.planType}</div>
                        </div>
                        <div className="pd-cell">
                          <div className="pd-label">Rate</div>
                          <div className="pd-value tabular">{m.rate}</div>
                          {m.coupon && (
                            <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{m.coupon}</div>
                          )}
                        </div>
                        <div className="pd-cell">
                          <div className="pd-label">Renewal</div>
                          <div className={`pd-value ${m.expiresLabel.startsWith("No") ? "muted" : ""}`}
                            style={{color: m.status === "suspended" ? "var(--rose)" : undefined}}>
                            {m.autoRenewCanceled ? "Cancels at period end" : m.expiresLabel}
                          </div>
                        </div>
                        <div className="pd-cell">
                          <div className="pd-label">Member since</div>
                          <div className="pd-value">{m.since}</div>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              }

              // Sub-member rows
              if (isSubsOpen && hasSubs) {
                m.additional.forEach(a => {
                  rows.push(
                    <tr key={`sub-${a.id}`} className="row-sub">
                      <td>
                        <div className="member-cell">
                          <span className="sub-indent" />
                          <Avatar member={a} kind={a.status} size="sm" />
                          <div style={{minWidth:0}}>
                            <div className="member-name" onClick={() => setDrawerId(a.id)}>
                              <span className="name-link">{memberFullName(a)}</span>
                              <span className="member-tag sub">Additional</span>
                            </div>
                            <div className="member-email">{a.email}</div>
                          </div>
                        </div>
                      </td>
                      <td><PlanBadge plan="Linked to holder" muted /></td>
                      <td style={{color:"var(--muted)",fontSize:12.5}}>Additional Member</td>
                      <td><StatusPill status={a.status} /></td>
                      <td className="tabular" style={{color:"var(--muted)",fontSize:12.5}}>{a.since}</td>
                      <td style={{textAlign:"right"}}>
                        <div className="row-actions">
                          <button className="row-btn" title="Remove member" onClick={(e)=>{e.stopPropagation(); setRemoveTarget(a);}}>
                            <Icon name="trash" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                });
              }

              return rows;
            })}
          </tbody>
        </table>

        <div className="pagination">
          <div>
            Showing <strong style={{color:"var(--text2)",fontWeight:600}}>{(page-1)*PAGE_SIZE + 1}–{Math.min(page*PAGE_SIZE, filtered.length)}</strong> of <strong style={{color:"var(--text2)",fontWeight:600}}>{filtered.length}</strong> members
          </div>
          <div className="pg-controls">
            <button className="pg-btn" disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
              <Icon name="chev-left" className="ic-12" />
            </button>
            {Array.from({length: totalPages}, (_, i) => i + 1).map(p => (
              <button key={p} className={`pg-btn ${page === p ? "active" : ""}`} onClick={() => setPage(p)}>{p}</button>
            ))}
            <button className="pg-btn" disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
              <Icon name="chev-right" className="ic-12" />
            </button>
          </div>
        </div>
      </div>

      <div className="hint">
        <span style={{color:"var(--muted)"}}>Tip ·</span>
        Press <kbd style={{font:"inherit",fontSize:11,padding:"1px 5px",border:"1px solid var(--border)",borderRadius:4,background:"var(--card)"}}>⌘K</kbd> to search, click a member to view their profile.
      </div>

      <MemberDrawer member={drawerMember} open={!!drawerMember} onClose={() => setDrawerId(null)} />
      <RemoveModal member={removeTarget} onCancel={() => setRemoveTarget(null)} onConfirm={() => handleRemove(removeTarget)} />

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio label="Mode" value={t.theme} options={["light","dark"]}
          onChange={v => setTweak("theme", v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["compact","regular","comfy"]}
          onChange={v => setTweak("density", v)} />
        <TweakToggle label="Show stat strip" value={t.showStats}
          onChange={v => setTweak("showStats", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
