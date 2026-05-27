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
  // S-11/DR-046: API effective_status comes from operator.js members SQL:
  //   active        — access row status='active' AND ≥1 source row active
  //   holder_only   — access row status='active' but no active sources of own (sub-members only)
  //   inactive      — access row status='inactive', no active source
  //   partial       — access row status='inactive' AND has source rows (e.g. pending_hardware)
  //   pending_identity — never resolved; kept as "pending"
  //   in_flight     — actively being processed (lock state)
  //   recovery_pending — stale in_flight lock cleared, awaiting retry (OB-202)
  function mapStatus(effectiveStatus) {
    var map = {
      active:            "active",
      holder_only:       "active",
      partial:           "pending",
      inactive:          "suspended",
      pending_identity:  "pending",
      in_flight:         "pending",
      recovery_pending:  "pending",
    };
    return map[effectiveStatus] || "pending";
  }

  function mapAccessStatus(effectiveStatus, role) {
    if (effectiveStatus === "holder_only") return "Holder";
    if (effectiveStatus === "active" && role === "holder") return "Holder";
    if (effectiveStatus === "active") return "Active";
    if (effectiveStatus === "recovery_pending") return "Recovery Pending";
    if (effectiveStatus === "partial" || effectiveStatus === "pending_identity" || effectiveStatus === "in_flight") return "Pending Setup";
    if (effectiveStatus === "inactive") return "Inactive";
    if (role === "sub") return "Active";
    return "Pending";
  }

  function deriveExpiresLabel(member) {
    if (member.effective_status === "inactive") return "Payment failed";
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

  // Build the same display shape from a v_active_members row (already-extracted columns,
  // no JSON parsing). The view returns numeric strings for plan_price/monthly_rate/coupon_amount.
  function shapeBillingFromView(pb) {
    if (!pb) return shapeBilling(null);
    // Reuse formatRate by reconstructing the snapshot shape it expects.
    var pseudoSnap = {
      planPrice:         pb.planPrice,
      cycleUnit:         pb.cycleUnit,
      cycleCount:        1,
      currency:          pb.currency,
      autoRenewCanceled: pb.autoRenew === false,  // view returns auto_renew=true means NOT cancelled
      lastPaymentStatus: pb.lastPaymentStatus,
      coupon:            pb.couponCode ? { code: pb.couponCode, amount: pb.couponAmount } : null,
    };
    return {
      raw:               pseudoSnap,
      rate:              formatRate(pseudoSnap),
      coupon:            formatCouponLine(pseudoSnap),
      autoRenewCanceled: pseudoSnap.autoRenewCanceled,
      lastPaymentStatus: pb.lastPaymentStatus,
      subscriptionId:    null,  // view doesn't expose; subscription tracking lives elsewhere
      orderId:           null,
      monthlyRate:       pb.monthlyRate,  // NEW: normalized cross-cycle comparison value
      beginDate:         pb.beginDate,
      endDate:           pb.endDate,
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

      // S-11/DR-046/OB-185 A13: one access row per person, with plan_names[] / plan_ids[] arrays
      // containing every distinct plan the person holds (aggregated server-side from
      // member_access_sources). Iterate the ARRAY, not group.rows — group.rows now has
      // exactly 1 entry post-S-11 (per-person cardinality).
      var plans = [];
      var billingForFallback = null;

      group.rows.forEach(function (accessRow) {
        var billing = shapeBilling(accessRow.billing_snapshot);
        if (!billingForFallback && billing.raw) billingForFallback = billing;

        // Pull the per-plan arrays. plan_names + plan_ids + plan_valid_untils are positionally aligned
        // (ARRAY_AGG with the same ORDER BY in the SQL). plan_names is authoritative for "how many
        // plans" — if it's empty, fall back to sub_plan_name (sub-member single-plan case) or
        // a single "Unknown Plan" entry so the row still renders.
        // OB-223: prefer accessRow.plan_names_disambiguated[] when present — it's aggregated over
        // distinct plan_mapping_ids (not collapsed by plan_name) so duplicate-named mappings each
        // get their own entry, with " (…xxxxxx)" suffix applied server-side. Falls back to
        // plan_names for older payloads or no-collision cases where shape is identical.
        var planNamesDisambig = Array.isArray(accessRow.plan_names_disambiguated)
          ? accessRow.plan_names_disambiguated.filter(Boolean)
          : null;
        var planNames = (planNamesDisambig && planNamesDisambig.length > 0)
          ? planNamesDisambig
          : (Array.isArray(accessRow.plan_names) ? accessRow.plan_names.filter(Boolean) : []);
        var planIds   = Array.isArray(accessRow.plan_ids)   ? accessRow.plan_ids   : [];
        var validUntils = Array.isArray(accessRow.plan_valid_untils) ? accessRow.plan_valid_untils : [];

        if (planNames.length === 0) {
          var fallback = accessRow.sub_plan_name || accessRow.plan_name || "Unknown Plan";
          planNames = [fallback];
          planIds = [accessRow.plan_ids && accessRow.plan_ids[0] || null];
          validUntils = [null];
        }

        // Billing Member: holder if sub-access, else self
        var billingMemberName;
        if (accessRow.plan_holder_id) {
          billingMemberName = accessRow.holder_name || accessRow.holder_email || "Holder";
        } else {
          billingMemberName = (personRow.first + " " + personRow.last).trim() || personRow.email || "—";
        }

        // One plan entry per name in the array. Per-plan billing comes from
        // accessRow.plan_billings[] — an array of structured billing objects from
        // v_active_members (DB view, no client-side JSON parsing). Indexed by plan name
        // (both arrays ORDER BY plan_name). Falls back to legacy person-level snapshot
        // for sub-member rows where the view filter excludes them.
        var planBillingsByName = {};
        if (Array.isArray(accessRow.plan_billings)) {
          accessRow.plan_billings.forEach(function (pb) {
            if (pb && pb.planName) planBillingsByName[pb.planName] = pb;
          });
        }
        planNames.forEach(function (name, idx) {
          // OB-223: when disambiguated, name is "Base Name (…xxxxxx)". plan_billings is keyed
          // by raw plan_name from v_active_members, so strip the suffix for lookup.
          var lookupName = name.replace(/\s*\(…[a-f0-9]{6}\)\s*$/i, '');
          var pb = planBillingsByName[name] || planBillingsByName[lookupName] || null;
          var planBilling;
          if (pb) {
            planBilling = shapeBillingFromView(pb);
          } else {
            // Legacy fallback — sub-member rows, inactive members not in v_active_members.
            planBilling = shapeBilling(accessRow.billing_snapshot || null);
          }
          plans.push({
            accessId:          accessRow.id,
            planName:          name,
            planSourceId:      planIds[idx] || null,
            planMappingId:     accessRow.plan_mapping_id || null,
            rate:              planBilling.rate,
            coupon:            planBilling.coupon,
            autoRenewCanceled: planBilling.autoRenewCanceled,
            billing:           planBilling,
            addedAt:           formatDate(accessRow.provisioned_at),
            validUntil:        validUntils[idx] || null,
            accessStatus:      mapAccessStatus(accessRow.effective_status, accessRow.role),
            rawStatus:         accessRow.effective_status,
            billingMemberName: billingMemberName,
            isSubAccess:       !!accessRow.plan_holder_id,
          });
        });
      });

      // Sort plans alphabetically by plan name for stable, readable order
      plans.sort(function (a, b) {
        return (a.planName || "").localeCompare(b.planName || "");
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

    // Plan type count — derive from unique plan names across all members' plans[] arrays.
    // S-11/OB-185: each person can now hold multiple plans; sum all distinct plan_names.
    var planSet = new Set();
    var billingSet = new Set(); // distinct billing identities (subscriptionId or orderId)
    nested.forEach(function (m) {
      (m.plans || []).forEach(function (p) {
        if (p.planName && p.planName !== "Unknown Plan") planSet.add(p.planName);
        var billKey = (p.billing && (p.billing.subscriptionId || p.billing.orderId)) || null;
        if (billKey) billingSet.add(billKey);
      });
      (m.additional || []).forEach(function (a) {
        (a.plans || []).forEach(function (p) {
          if (p.planName && p.planName !== "Unknown Plan") planSet.add(p.planName);
          var billKey = (p.billing && (p.billing.subscriptionId || p.billing.orderId)) || null;
          if (billKey) billingSet.add(billKey);
        });
      });
    });

    window.MEMBERS = nested;
    window.__MEMBERS_CONTEXT = {
      clientName: clientName,
      lastSyncedLabel: lastSyncedLabel,
      planTypeCount: planSet.size,
      uniqueBillingCount: billingSet.size,
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
