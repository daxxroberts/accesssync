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
    return "Pending";
  }

  function deriveExpiresLabel(member) {
    if (member.effective_status === "suspended" || member.effective_status === "failed") return "Payment failed";
    if (member.effective_status === "revoked") return "Access revoked";
    return "No expiry";
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
    return {
      id:           r.id,
      first:        r.first_name || "",
      last:         r.last_name  || "",
      email:        r.email      || "",
      plan:         r.plan_name  || "Unknown Plan",
      planType:     "Pricing Plan",
      role:         r.role === "holder" ? "Plan Holder" : "Additional Member",
      status:       mapStatus(r.effective_status),
      accessStatus: mapAccessStatus(r.effective_status, r.role),
      since:        formatDate(r.provisioned_at),
      expiresLabel: deriveExpiresLabel(r),
      rate:         "—",
      lastVisit:    "—",
      visits30d:    0,
      error:        null,
      additional:   [],
      _raw:         r,
    };
  }

  // ── Flat → nested ──────────────────────────────────────────────────
  function buildMembersArray(flatRows) {
    if (!Array.isArray(flatRows)) return [];

    var holders = [];
    var subsByHolder = {};

    for (var i = 0; i < flatRows.length; i++) {
      var r = flatRows[i];
      if (r.plan_holder_id) {
        if (!subsByHolder[r.plan_holder_id]) subsByHolder[r.plan_holder_id] = [];
        subsByHolder[r.plan_holder_id].push(shapeMember(r));
      } else {
        holders.push(r);
      }
    }

    return holders.map(function (h) {
      var shaped = shapeMember(h);
      shaped.additional = subsByHolder[h.id] || [];
      return shaped;
    });
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
  };

  // Auto-run on script load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadMembers);
  } else {
    loadMembers();
  }
})();
