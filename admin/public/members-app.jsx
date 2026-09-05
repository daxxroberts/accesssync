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
  // Resend-welcome-email feedback, keyed by member id — 'sending' | 'sent' | 'error'.
  // Self-contained (not the shared toast() helper — see spawn_task note: that helper
  // isn't actually loaded on every operator page today) so this action's feedback
  // can't silently disappear the way an undefined global would.
  const [resendStatus, setResendStatus] = useState({});
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
    if (filter === "holder") rows = rows.filter(m => m.role === "holder");
    else if (filter === "sub") rows = rows.filter(m => m.role === "sub");
    else if (filter === "suspended") rows = rows.filter(m => m.hasError);

    const q = query.trim().toLowerCase();
    if (q) {
      rows = rows.filter(m => {
        if (memberFullName(m).toLowerCase().includes(q)) return true;
        if ((m.email || "").toLowerCase().includes(q)) return true;
        if ((m.plans || []).some(p => (p.planName || "").toLowerCase().includes(q))) return true;
        // Also match by linked holder name (so searching "Daxx" surfaces Drew + Brittany as subs of Daxx)
        if (m.linkedHolder && (m.linkedHolder.name || "").toLowerCase().includes(q)) return true;
        return false;
      });
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
    active: members.filter(m => !m.hasError).length,
    holder: members.filter(m => m.role === "holder").length,
    sub: members.filter(m => m.role === "sub").length,
    suspended: members.filter(m => m.hasError).length,
    pending: 0,
  }), [members]);

  // Subs are now first-class top-level people. The "additional members" framing is retired;
  // we keep the variable as the sub count so existing references keep working.
  const totalAdditional = counts.sub;

  const errorMembers = useMemo(
    () => members.filter(m => m.error),
    [members]
  );

  const handleRemove = (m) => {
    setRemoveTarget(null);
    // In a real app, you'd POST to an API. Here we just close.
  };

  const handleResendWelcomeEmail = (m) => {
    const clientId = window.__CLIENT_ID;
    if (!clientId) return;
    setResendStatus(s => ({ ...s, [m.id]: "sending" }));
    apiFetch(`/operator/${encodeURIComponent(clientId)}/members/${encodeURIComponent(m.id)}/resend-welcome-email`, {
      method: "POST",
    })
      .then(res => res.json().then(data => ({ ok: res.ok, data })))
      .then(({ ok, data }) => {
        setResendStatus(s => ({ ...s, [m.id]: ok && data.ok ? "sent" : "error" }));
      })
      .catch(() => {
        setResendStatus(s => ({ ...s, [m.id]: "error" }));
      })
      .finally(() => {
        setTimeout(() => {
          setResendStatus(s => {
            const next = { ...s };
            delete next[m.id];
            return next;
          });
        }, 3000);
      });
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
            {members.length} {members.length === 1 ? "member" : "members"} · {counts.holder} plan {counts.holder === 1 ? "holder" : "holders"} · {counts.sub} sub-{counts.sub === 1 ? "member" : "members"}{pageContext.lastSyncedLabel ? ` · synced ${pageContext.lastSyncedLabel}` : ""}
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
            <div className="stat-value tabular">{counts.active}</div>
            <div className="stat-meta"><span>{counts.holder} holders + {counts.sub} sub-members</span></div>
          </div>
          <div className="stat">
            <div className="stat-label">Plan holders</div>
            <div className="stat-value tabular">{counts.holder}</div>
            <div className="stat-meta">
              <span>
                {pageContext.uniqueBillingCount
                  ? `in ${pageContext.uniqueBillingCount} unique ${pageContext.uniqueBillingCount === 1 ? "billing" : "billings"}`
                  : (pageContext.planTypeCount
                      ? `across ${pageContext.planTypeCount} plan ${pageContext.planTypeCount === 1 ? "type" : "types"}`
                      : "—")}
              </span>
            </div>
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
        {/*
          Person-row layout (2026-05-13 redesign):
          - Each row is one PERSON (holder OR sub-member, both top-level).
          - No status pill on the row in normal state — only an error chip when something
            actually needs operator attention.
          - Click the row to expand: shows a nested plans table with one row per plan,
            including Plan / Rate / Added / Access / Auto-renew / Billing Member.
          - Sub-member rows show a "linked to <holder>" tag inline; they expand the same way.
        */}
        <table className="members-tbl">
          <thead>
            <tr>
              <th style={{width:"56%"}}>
                <button className={`sort-btn ${sort.key==="name"?"sorted":""}`} onClick={() => handleSort("name")}>
                  Member <span className="sort-arrow">{sortIcon("name")}</span>
                </button>
              </th>
              <th style={{width:"18%",textAlign:"center"}}>Plans</th>
              <th style={{width:"16%"}}>
                <button className={`sort-btn ${sort.key==="since"?"sorted":""}`} onClick={() => handleSort("since")}>
                  Added <span className="sort-arrow">{sortIcon("since")}</span>
                </button>
              </th>
              <th style={{width:"10%",textAlign:"right"}}></th>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr><td colSpan="4"><div className="empty">No members match your search.</div></td></tr>
            )}
            {pageRows.flatMap(m => {
              const plans         = m.plans || [];
              const expandKey     = `person_${m.id}`;
              const isOpen        = expandedPlans.has(expandKey);
              const rows          = [];

              const isHolder = m.role === "holder" || m.role === "Plan Holder";
              const linkedHolder = m.linkedHolder || null;

              // Avatar shading: muted by default — pull status only if there's an error,
              // since we don't want a colored pill cluttering the quiet state.
              const avatarKind = m.hasError ? "suspended" : "active";

              // Top-level person row
              rows.push(
                <tr key={`p-${m.id}`} className={`row-main ${m.hasError ? "has-error" : ""}`}>
                  <td>
                    <div className="member-cell">
                      <Avatar member={m} kind={avatarKind} />
                      <div style={{minWidth:0}}>
                        <div className="member-name" onClick={() => setDrawerId(m.id)}>
                          <span className="name-link">{memberFullName(m)}</span>
                          {m.hasError && (
                            <span className="member-tag" style={{background:"var(--rose-dim, #fde8eb)",color:"var(--rose, #b42044)",borderColor:"rgba(180,32,68,.22)"}}>
                              Needs attention
                            </span>
                          )}
                        </div>
                        <div className="member-email">{m.email}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{textAlign:"center"}}>
                    <button
                      className={`plan-group-details-btn ${isOpen ? "open" : ""}`}
                      onClick={(e)=>{ e.stopPropagation(); togglePlan(expandKey); }}
                      style={{padding:"4px 10px"}}
                    >
                      {plans.length} {plans.length === 1 ? "plan" : "plans"} <span className="chev">▼</span>
                    </button>
                  </td>
                  <td className="tabular" style={{color:"var(--muted)",fontSize:12.5}}>{m.since}</td>
                  <td style={{textAlign:"right"}}>
                    <div className={`row-actions ${openMenu === m.id || openError === m.id ? "open" : ""}`} style={{display:"flex",alignItems:"center",justifyContent:"flex-end",gap:6}}>
                      {resendStatus[m.id] && (
                        <span style={{
                          fontSize: 11, whiteSpace: "nowrap",
                          color: resendStatus[m.id] === "error" ? "var(--red)" : "var(--muted)",
                        }}>
                          {resendStatus[m.id] === "sending" && "Sending…"}
                          {resendStatus[m.id] === "sent" && "✓ Sent"}
                          {resendStatus[m.id] === "error" && "✗ Failed"}
                        </span>
                      )}
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
                            if (a === "resend_welcome") handleResendWelcomeEmail(m);
                          }}
                          member={m}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );

              // Expanded plans table — one row per plan-access this person holds.
              // Compact layout: full-width across the screen, narrow column widths so no cell
              // wraps, tighter row padding so multi-plan members don't push the whole table
              // off the viewport. nowrap on tabular cells locks date / rate / access onto
              // single lines; Plan badge cell stays minimal width with the badge sitting flush.
              if (isOpen) {
                const compactCell = { padding: "6px 10px", fontSize: 12.5, whiteSpace: "nowrap", lineHeight: 1.4 };
                rows.push(
                  <tr key={`pd-${m.id}`} className="plan-detail-row-wrap">
                    <td colSpan="4">
                      <div className="plan-detail-card" style={{padding:"8px 12px"}}>
                        {plans.length === 0 ? (
                          <div className="empty" style={{padding:"12px"}}>No plan information available.</div>
                        ) : (
                          <table className="members-tbl" style={{boxShadow:"none",margin:0,width:"100%",tableLayout:"auto"}}>
                            <thead>
                              <tr>
                                <th style={{...compactCell, width:"22%"}}>Plan</th>
                                <th style={{...compactCell, width:"12%"}}>Rate</th>
                                <th style={{...compactCell, width:"14%"}}>Added</th>
                                <th style={{...compactCell, width:"15%"}}>Access</th>
                                <th style={{...compactCell, width:"15%"}}>Auto-renew</th>
                                <th style={{...compactCell, width:"22%"}}>Billing Member</th>
                              </tr>
                            </thead>
                            <tbody>
                              {plans.map((plan, pIdx) => (
                                <tr key={`plan-${m.id}-${pIdx}`}>
                                  <td style={compactCell}><PlanBadge plan={plan.planName} /></td>
                                  <td style={{...compactCell}} className="tabular">
                                    {plan.rate}
                                    {plan.coupon && (<span style={{fontSize:11,color:"var(--muted)",marginLeft:6}}>{plan.coupon}</span>)}
                                  </td>
                                  <td style={{...compactCell, color:"var(--muted)"}} className="tabular">{plan.addedAt}</td>
                                  <td style={compactCell}><StatusPill status={
                                    plan.rawStatus === "active" ? "active"
                                    : plan.rawStatus === "suspended" || plan.rawStatus === "failed" || plan.rawStatus === "revoked" ? "suspended"
                                    : "pending"
                                  } label={plan.accessStatus} /></td>
                                  <td style={{...compactCell, color: plan.autoRenewCanceled ? "var(--amber, #d97706)" : "var(--text2)"}}>
                                    {plan.autoRenewCanceled ? "Cancels at end" : "On"}
                                  </td>
                                  <td style={compactCell}>{plan.billingMemberName}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                );
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
