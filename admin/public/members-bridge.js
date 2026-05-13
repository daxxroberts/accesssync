/**
 * members-bridge.js
 * @file admin/public/members-bridge.js
 * @layer admin/public
 * @role members-page-data-adapter
 * @reads /operator/:clientId/members, /operator/:clientId/error-summary, /operator/:clientId/locations
 * @writes window.MEMBERS, window.__MEMBERS_CONTEXT, document event 'membersLoaded'
 * @consumed-by members-app.jsx (React)
 *
 * Bridges the operator API response shape (flat rows, snake_case) to the
 * shape the React members page expects (nested holder/additional, camelCase).
 * Runs once on page load. Fires 'membersLoaded' when window.MEMBERS is ready.
 */

(function () {
  "use strict";

  // ── Status mapping ─────────────────────────────────────────────────
  // API effective_status → prototype status enum (active/suspended/pending/expired)
  function mapStatus(effectiveStatus) {
    var map = {
      active:           "active",
      holder_only:      "active",
      pending:          "pending",
      pending_hardware: "pending",
      partial:          "active",
      failed:           "suspended",
      suspended:        "suspended",
      revoked:          "suspended",
    };
    return map[effectiveStatus] || "pending";
  }

  function mapAccessStatus(effectiveStatus, role) {
    if (effectiveStatus === "holder_only") return "Holder";
    if (effectiveStatus === "active" && role === "holder") return "Holder";
    if (effectiveStatus === "active") return "Active";
    if (effectiveStatus === "pending" || effectiveStatus === "pending_hardware") return "Pending Setup";
    if (effectiveStatus === "suspended" || effectiveStatus === "failed" || effectiveStatus === "revoked") return "Suspended";
    // partial coverage or unknown — treat active sub-member as active
    if (role === "sub") return "Active";
    return "Pending";
  }

  function deriveExpiresLabel(member) {
    if (member.effective_status === "suspended" || member.effective_status === "failed") return "Payment failed";
    if (member.effective_status === "revoked") return "Access revoked";
    return "No expiry";
  }

  // ── Billing formatting (DR-042) ────────────────────────────────────
  // Snapshot shape: { planPrice, cycleUnit, cycleCount, currency, total, subtotal,
  //   discount, coupon: { code, amount } | null, autoRenewCanceled, lastPaymentStatus,
  //   subscriptionId, orderMethod, orderId, capturedAt }
  function formatRate(snap) {
    if (!snap || !snap.planPrice) return "—";
    var amount = parseFloat(snap.planPrice);
    if (!isFinite(amount)) return "—";
    var symbol = snap.currency === "USD" || !snap.currency ? "$" : snap.currency + " ";
    var amountStr = amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2);
    var unit = (snap.cycleUnit || "MONTH").toLowerCase();
    var count = snap.cycleCount || 1;
    var period;
    if (count === 1) {
      period = unit.indexOf("year") === 0 ? "yr"
             : unit.indexOf("week") === 0 ? "wk"
             : unit.indexOf("day")  === 0 ? "day"
             : "mo";
    } else {
      period = count + " " + unit + "s";
    }
    return symbol + amountStr + "/" + period;
  }

  function formatCouponLine(snap) {
    if (!snap || !snap.coupon || !snap.coupon.code) return null;
    var amt = snap.coupon.amount ? parseFloat(snap.coupon.amount) : null;
    var amtStr = (amt != null && isFinite(amt))
      ? "−$" + (amt % 1 === 0 ? amt.toFixed(0) : amt.toFixed(2))
      : "discount";
    return snap.coupon.code + " · " + amtStr;
  }

  function shapeBilling(rawSnap) {
    var snap = rawSnap || null;
    return {
      raw:               snap,
      rate:              formatRate(snap),
      coupon:            formatCouponLine(snap),
      autoRenewCanceled: !!(snap && snap.autoRenewCanceled),
      lastPaymentStatus: snap ? snap.lastPaymentStatus : null,
      subscriptionId:    snap ? snap.subscriptionId : null,
      orderId:           snap ? snap.orderId : null,
    };
  }

  function formatDate(ts) {
    if (!ts) return "—";
    try {
      return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch (e) { return "—"; }
  }

  function relativeAgo(ts) {
    if (!ts) return null;
    var d = new Date(ts).getTime();
    if (isNaN(d)) return null;
    var sec = Math.max(0, Math.round((Date.now() - d) / 1000));
    if (sec < 60)      return sec + "s ago";
    if (sec < 3600)    return Math.round(sec / 60) + " min ago";
    if (sec < 86400)   return Math.round(sec / 3600) + " hr ago";
    return Math.round(sec / 86400) + " days ago";
  }

  // ── Per-row shape ──────────────────────────────────────────────────
  function shapeMember(r) {
    var billing = shapeBilling(r.billing_snapshot);
    return {
      id:                r.id,
      first:             r.first_name || "",
      last:              r.last_name  || "",
      email:             r.email      || "",
      // plan_names[] is the full list for holder rows; plan_name is the first.
      // Sub rows carry sub_plan_name (joined from plan_mappings via plan_mapping_id).
      planNames:         Array.isArray(r.plan_names) ? r.plan_names : (r.plan_name ? [r.plan_name] : []),
      plan:              r.plan_name  || "Unknown Plan",
      planType:          "Pricing Plan",
      planMappingId:     r.plan_mapping_id || null,
      subPlanName:       r.sub_plan_name   || null,
      role:              r.role === "holder" ? "Plan Holder" : "Additional Member",
      status:            mapStatus(r.effective_status),
      accessStatus:      mapAccessStatus(r.effective_status, r.role),
      since:             formatDate(r.provisioned_at),
      expiresLabel:      deriveExpiresLabel(r),
      rate:              billing.rate,
      coupon:            billing.coupon,
      autoRenewCanceled: billing.autoRenewCanceled,
      lastPaymentStatus: billing.lastPaymentStatus,
      subscriptionId:    billing.subscriptionId,
      orderId:           billing.orderId,
      billing:           billing,
      lastVisit:         "—",
      visits30d:         0,
      error:             null,
      plans:             [],   // populated by buildMembersArray for holder rows
      _raw:              r,
    };
  }

  // ── Flat rows → person-rows ────────────────────────────────────────
  // Person-row model (2026-05-13 redesign):
  //   - Top-level rows are PEOPLE (one row per master member, holders + subs both)
  //   - Each person has a plans[] array, one entry per plan-access this person holds
  //   - Each plan entry carries: planName, rate, addedAt, accessStatus, autoRenew, billingMemberName
  //   - billingMemberName is the holder of that plan — themselves if they're the holder, the holder's name if they're a sub
  //   - Top-level person row shows NO status badge by default (quiet UI); errors surface via .error
  //
  // The API returns one row per member_access. A person with 3 plans = 3 rows, all sharing
  // the same member_master id (mm.id, exposed as r.member_master_id when added — falls back
  // to r.id matching). We group by member_master to collapse 3 access-rows into 1 person row.
  function buildMembersArray(flatRows) {
    if (!Array.isArray(flatRows)) return [];

    // Group flat rows by master person. For a holder row, the master is the holder
    // themselves (no sub_master). For a sub row, the master is whoever the access
    // row points at (the sub themselves, not the holder — sub IS a master record).
    //
    // Identity key: prefer mm.platform_member_id when present (stable across access
    // rows); fall back to email; finally fall back to access.id as last resort.
    var groups = {};         // key → { masterRow, accessRows[] }
    var holderInfoById = {}; // master_id-ish key → { name, email } so subs can resolve their holder name

    function personKeyFor(r) {
      return r.platform_member_id
          || r.email
          || ("__access_" + r.id);
    }

    // Pass 1: index every row by its person key + build holder lookup.
    // A "row" from the API == one member_access row, with member_master fields joined.
    // For sub rows, holder_name / holder_email are denormalized on the row already.
    for (var i = 0; i < flatRows.length; i++) {
      var r = flatRows[i];
      var key = personKeyFor(r);
      if (!groups[key]) groups[key] = { rows: [], firstRow: r };
      groups[key].rows.push(r);

      // Track holder info so we can resolve billingMemberName for sub-plan entries.
      // For holder rows, we know the holder's own identity from mm fields.
      // For sub rows, holder_name / holder_email come from the API JOIN on sub_master_id.
      if (r.role === "holder" || !r.plan_holder_id) {
        // This row is for a holder — record their info under the same key.
        holderInfoById[key] = {
          name:  (r.display_name || ((r.first_name || "") + " " + (r.last_name || "")).trim() || r.email || "Unknown"),
          email: r.email || null,
        };
      }
    }

    // Pass 2: collapse each person's access rows into a single person record with plans[].
    var people = [];

    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      var firstRow = group.firstRow;
      var personRow = shapeMember(firstRow);

      // Compose plans[] — one entry per access row this person holds.
      // Each access row may map to a single plan_mapping; collect those into per-person plans.
      var plans = [];
      var billingForFallback = null; // first non-empty billing snapshot, used for subs without their own

      group.rows.forEach(function (accessRow) {
        var billing = shapeBilling(accessRow.billing_snapshot);
        if (!billingForFallback && billing.raw) billingForFallback = billing;

        // Resolve plan name: prefer single sub_plan_name (when set via plan_mapping_id JOIN),
        // else first entry of plan_names[], else "Unknown Plan".
        var planName = accessRow.sub_plan_name
                    || (Array.isArray(accessRow.plan_names) && accessRow.plan_names[0])
                    || accessRow.plan_name
                    || "Unknown Plan";

        // Billing Member = whoever pays. If this access row is a sub_master_id !== null
        // (sub-member access), billing is the holder's. Otherwise it's the person themselves.
        var billingMemberName;
        if (accessRow.plan_holder_id) {
          // sub-access — holder paid
          billingMemberName = accessRow.holder_name || accessRow.holder_email || "Holder";
        } else {
          billingMemberName = (personRow.first + " " + personRow.last).trim() || personRow.email || "—";
        }

        plans.push({
          accessId:          accessRow.id,
          planName:          planName,
          planSourceId:      Array.isArray(accessRow.plan_ids) ? accessRow.plan_ids[0] : null,
          planMappingId:     accessRow.plan_mapping_id || null,
          rate:              billing.rate,
          coupon:            billing.coupon,
          autoRenewCanceled: billing.autoRenewCanceled,
          billing:           billing,
          addedAt:           formatDate(accessRow.provisioned_at),
          accessStatus:      mapAccessStatus(accessRow.effective_status, accessRow.role),
          rawStatus:         accessRow.effective_status,
          billingMemberName: billingMemberName,
          isSubAccess:       !!accessRow.plan_holder_id,
        });
      });

      // Sort plans by addedAt date ascending (oldest plan first — common reading order)
      plans.sort(function (a, b) {
        var ta = new Date(a._sortKey || 0).getTime() || 0;
        var tb = new Date(b._sortKey || 0).getTime() || 0;
        return ta - tb;
      });

      personRow.plans = plans;
      personRow.planCount = plans.length;
      // Has any plan in an error/suspended state? Drives the top-row error badge.
      personRow.hasError = plans.some(function (p) {
        return p.rawStatus === "suspended" || p.rawStatus === "failed" || p.rawStatus === "revoked";
      });

      // Top-row role: "holder" if any of their access rows is a holder; else "sub"
      personRow.role = group.rows.some(function (r) { return !r.plan_holder_id; })
        ? "holder"
        : "sub";

      // Linked-to-holder label for pure-sub people: pull from any sub access row
      var subAccess = group.rows.find(function (r) { return r.plan_holder_id; });
      if (personRow.role === "sub" && subAccess) {
        personRow.linkedHolder = {
          id:    subAccess.holder_id,
          name:  subAccess.holder_name || subAccess.holder_email,
          email: subAccess.holder_email,
        };
      } else {
        personRow.linkedHolder = null;
      }

      people.push(personRow);
    });

    return people;
  }

  // ── Error attachment ───────────────────────────────────────────────
  function attachErrors(members, errorList) {
    if (!Array.isArray(errorList) || !errorList.length) return members;
    var byMember = {};
    for (var i = 0; i < errorList.length; i++) {
      var e = errorList[i];
      if (e.member_id) byMember[e.member_id] = e;
    }
    return members.map(function (m) {
      var err = byMember[m.id];
      if (!err) return m;
      m.error = {
        code:    err.error_code || err.event_type || "unknown_error",
        message: err.message    || err.error_message || "An error occurred.",
        at:      formatDate(err.created_at),
      };
      return m;
    });
  }

  // ── clientId resolution ────────────────────────────────────────────
  function resolveClientId() {
    if (window.__CLIENT_ID && window.__CLIENT_ID.length) return window.__CLIENT_ID;
    // Fallback patterns used by other operator pages
    var meta = document.querySelector("meta[name='client-id']");
    if (meta && meta.content) return meta.content;
    var bodyAttr = document.body && document.body.getAttribute("data-client-id");
    if (bodyAttr) return bodyAttr;
    var urlParam = new URLSearchParams(window.location.search).get("clientId");
    if (urlParam) return urlParam;
    return null;
  }

  // ── Fetch helpers ──────────────────────────────────────────────────
  async function fetchJSON(url) {
    var res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
    return res.json();
  }

  // ── Main ───────────────────────────────────────────────────────────
  async function loadMembers() {
    var clientId = resolveClientId();
    if (!clientId) {
      console.warn("[members-bridge] No clientId resolved — skipping fetch");
      window.MEMBERS = [];
      window.__MEMBERS_CONTEXT = { clientName: "—", lastSyncedLabel: null, planTypeCount: 0 };
      document.dispatchEvent(new CustomEvent("membersLoaded"));
      return;
    }

    var membersUrl = "/operator/" + encodeURIComponent(clientId) + "/members?limit=200";
    var errorsUrl  = "/operator/" + encodeURIComponent(clientId) + "/error-summary";
    var clientUrl  = "/admin/clients/" + encodeURIComponent(clientId);

    // Members fetch is required; the others are best-effort.
    var membersResp;
    try {
      membersResp = await fetchJSON(membersUrl);
    } catch (e) {
      console.error("[members-bridge] Members fetch failed:", e);
      window.MEMBERS = [];
      window.__MEMBERS_CONTEXT = { clientName: window.__CLIENT_NAME || "—", lastSyncedLabel: null, planTypeCount: 0, error: String(e) };
      document.dispatchEvent(new CustomEvent("membersLoaded"));
      return;
    }

    var rows = (membersResp && membersResp.members) || [];
    var nested = buildMembersArray(rows);

    // Best-effort: error summary
    try {
      var errResp = await fetchJSON(errorsUrl);
      var errorList = (errResp && (errResp.errors || errResp.items)) || (Array.isArray(errResp) ? errResp : []);
      nested = attachErrors(nested, errorList);
    } catch (e) {
      // Non-blocking: errors are a nice-to-have.
    }

    // Best-effort: client metadata for breadcrumb + sync timestamp
    var clientName = window.__CLIENT_NAME || "—";
    var lastSyncedLabel = null;
    try {
      var clientResp = await fetchJSON(clientUrl);
      if (clientResp) {
        clientName = clientResp.name || clientResp.client_name || clientName;
        lastSyncedLabel = relativeAgo(clientResp.last_wix_webhook_at);
      }
    } catch (e) { /* non-blocking */ }

    // Plan type count — derive from unique plan names across all members + their subs
    var planSet = new Set();
    nested.forEach(function (m) {
      if (m.plan && m.plan !== "Unknown Plan") planSet.add(m.plan);
      (m.additional || []).forEach(function (a) {
        if (a.plan && a.plan !== "Unknown Plan" && a.plan !== "Linked to holder") planSet.add(a.plan);
      });
    });

    window.MEMBERS = nested;
    window.__MEMBERS_CONTEXT = {
      clientName: clientName,
      lastSyncedLabel: lastSyncedLabel,
      planTypeCount: planSet.size,
    };
    document.dispatchEvent(new CustomEvent("membersLoaded"));
  }

  // Expose for debugging + manual refresh
  window.__membersBridge = {
    loadMembers: loadMembers,
    shapeMember: shapeMember,
    buildMembersArray: buildMembersArray,
    mapStatus: mapStatus,
    mapAccessStatus: mapAccessStatus,
    formatRate: formatRate,
    formatCouponLine: formatCouponLine,
  };

  // Auto-run on script load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadMembers);
  } else {
    loadMembers();
  }
})();
