// Reusable bits: Avatar, StatusPill, PlanBadge, MenuPortal hook, etc.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

const Avatar = ({ member, kind = "active", size = "md" }) => {
  const cls = ["avatar", size === "sm" ? "sm" : "", kind].filter(Boolean).join(" ");
  return <div className={cls} aria-hidden>{memberInitials(member)}</div>;
};

const StatusPill = ({ status, label }) => {
  const map = {
    active:    { cls: "active",    text: label || "Active" },
    holder:    { cls: "holder",    text: label || "Plan Holder" },
    suspended: { cls: "suspended", text: label || "Suspended" },
    pending:   { cls: "pending",   text: label || "Pending" },
    expired:   { cls: "suspended", text: label || "Expired" },
  };
  const m = map[status] || map.pending;
  return (
    <span className={`status-pill ${m.cls}`}>
      <span className="dot" />{m.text}
    </span>
  );
};

const PlanBadge = ({ plan, muted }) => {
  if (muted) return <span className="plan-badge muted">{plan}</span>;
  const cls = plan.toLowerCase().replace(/\s+/g,"-");
  return <span className={`plan-badge ${cls}`}>{plan}</span>;
};

// Click-outside hook
function useClickOutside(ref, onClose) {
  useEffect(() => {
    function onDoc(e) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [ref, onClose]);
}

// Row action menu — operator side: see error (if any) + remove member
const ActionsMenu = ({ open, onClose, onAction, member }) => {
  const ref = useRef(null);
  useClickOutside(ref, () => open && onClose());
  if (!open) return null;
  return (
    <div className="menu" ref={ref} role="menu">
      {member.error && (
        <>
          <button className="menu-item warn" onClick={() => onAction("error")}>
            <Icon name="alert" />See error
          </button>
          <div className="menu-sep"/>
        </>
      )}
      <button className="menu-item danger" onClick={() => onAction("remove")}>
        <Icon name="trash" />Remove member
      </button>
    </div>
  );
};

// Drawer for member detail
const MemberDrawer = ({ member, open, onClose }) => {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    if (open) document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!member) return null;

  return (
    <>
      <div className={`scrim ${open ? "open" : ""}`} onClick={onClose} />
      <aside className={`drawer ${open ? "open" : ""}`} aria-hidden={!open}>
        <div className="drawer-head">
          <div style={{display:"flex",alignItems:"center",gap:14,minWidth:0}}>
            <Avatar member={member} kind={member.status === "active" ? "active" : member.status} />
            <div style={{minWidth:0}}>
              <div style={{fontSize:18,fontWeight:600,letterSpacing:"-.01em",color:"var(--text)"}}>
                {memberFullName(member)}
              </div>
              <div style={{fontSize:12.5,color:"var(--muted)",marginTop:2}}>
                {member.email}
              </div>
            </div>
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <button className="btn-icon btn" onClick={onClose} aria-label="Close">
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="drawer-body">

          <div className="drawer-section">
            <div style={{display:"flex",gap:8,marginBottom:14}}>
              <StatusPill status={member.role === "Plan Holder" ? (member.status === "active" ? "holder" : member.status) : member.status} />
              <PlanBadge plan={member.plan} />
            </div>
            <p style={{margin:0,fontSize:13,color:"var(--text2)",lineHeight:1.55,fontWeight:400}}>
              Member since {member.since}.
            </p>
          </div>

          <div className="drawer-section">
            <h3>Plan & billing</h3>
            <dl className="kv">
              <dt>Plan</dt><dd>{member.plan} <span style={{color:"var(--muted)",fontWeight:400,marginLeft:4}}>· {member.planType}</span></dd>
              <dt>Rate</dt>
              <dd className="tabular">
                {member.rate}
                {member.coupon && (
                  <span style={{display:"block",fontSize:11,color:"var(--muted)",fontWeight:400,marginTop:2}}>{member.coupon}</span>
                )}
              </dd>
              <dt>Role</dt><dd>{member.role}</dd>
              <dt>Member since</dt><dd>{member.since}</dd>
              <dt>Renewal</dt>
              <dd style={{color: member.autoRenewCanceled ? "var(--amber, #d97706)" : (member.status === "suspended" ? "var(--red)" : "var(--text)")}}>
                {member.autoRenewCanceled ? "Cancels at period end" : member.expiresLabel}
              </dd>
              {member.lastPaymentStatus && member.lastPaymentStatus !== "PAID" && (
                <>
                  <dt>Payment</dt>
                  <dd style={{color: member.lastPaymentStatus === "FAILED" ? "var(--red)" : "var(--muted)"}}>
                    {member.lastPaymentStatus.toLowerCase().replace(/_/g, " ")}
                  </dd>
                </>
              )}
              {member.subscriptionId && (
                <>
                  <dt>Wix</dt>
                  <dd>
                    <a href={`https://manage.wix.com/dashboard/_/pricing-plans/orders/${member.orderId || member.subscriptionId}`}
                       target="_blank" rel="noopener noreferrer"
                       style={{color:"var(--brand)",fontSize:12,fontWeight:500}}>
                      View order →
                    </a>
                  </dd>
                </>
              )}
            </dl>
          </div>

          {member.additional && member.additional.length > 0 && (
            <div className="drawer-section">
              <h3>Additional members ({member.additional.length})</h3>
              <div style={{display:"flex",flexDirection:"column",gap:6}}>
                {member.additional.map(a => (
                  <div key={a.id} className="submember-row" style={{maxWidth:"none"}}>
                    <Avatar member={a} kind={a.status} size="sm" />
                    <div style={{flex:1,minWidth:0}}>
                      <div className="name">{memberFullName(a)}</div>
                      <div className="email">{a.email}</div>
                    </div>
                    <StatusPill status={a.status} />
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </aside>
    </>
  );
};

// Error popover — shows the operator the error message inline
const ErrorPopover = ({ error, onClose }) => {
  const ref = useRef(null);
  useClickOutside(ref, onClose);
  return (
    <div className="err-pop" ref={ref}>
      <h4><Icon name="alert" />{error.code.replace(/_/g, " ")}</h4>
      <p>{error.message}</p>
      <div className="meta">Logged {error.at}</div>
    </div>
  );
};

// Remove member confirmation modal
const RemoveModal = ({ member, onCancel, onConfirm }) => {
  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onCancel(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  if (!member) return null;
  const isAdditional = !member.plan;
  return (
    <>
      <div className="scrim open" onClick={onCancel} />
      <div role="dialog" aria-modal="true" style={{
        position:"fixed", inset:0, zIndex:60,
        display:"flex", alignItems:"center", justifyContent:"center",
        pointerEvents:"none"
      }}>
        <div style={{
          pointerEvents:"auto",
          width:"min(440px, 92vw)",
          background:"var(--card)", border:"1px solid var(--border)",
          borderRadius:"var(--r-card)", boxShadow:"var(--shadow-lg)",
          padding:"22px 24px"
        }}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
            <div style={{
              width:32,height:32,borderRadius:8,
              background:"var(--red-dim)",color:"var(--red)",
              display:"flex",alignItems:"center",justifyContent:"center"
            }}>
              <Icon name="trash" />
            </div>
            <h3 style={{margin:0,fontSize:16,fontWeight:600,color:"var(--text)",letterSpacing:"-.01em"}}>
              Remove {memberFullName(member)}?
            </h3>
          </div>
          <p style={{margin:"0 0 18px",fontSize:13.5,color:"var(--text2)",lineHeight:1.5,fontWeight:400}}>
            {isAdditional
              ? "This additional member will lose access immediately. The plan holder will be notified."
              : (member.additional?.length
                  ? `This will remove the plan holder and ${member.additional.length} additional member${member.additional.length>1?"s":""}. All key fobs will be deactivated.`
                  : "This member will lose facility access immediately and be removed from the directory.")}
          </p>
          <div style={{display:"flex",justifyContent:"flex-end",gap:8}}>
            <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
            <button
              className="btn"
              style={{background:"var(--red)",color:"#fff",borderColor:"var(--red)"}}
              onClick={onConfirm}
            >
              <Icon name="trash" />Remove member
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

window.Avatar = Avatar;
window.RemoveModal = RemoveModal;
window.ErrorPopover = ErrorPopover;
window.StatusPill = StatusPill;
window.PlanBadge = PlanBadge;
window.ActionsMenu = ActionsMenu;
window.MemberDrawer = MemberDrawer;
window.useClickOutside = useClickOutside;
