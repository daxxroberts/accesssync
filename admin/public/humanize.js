/**
 * humanize.js
 * Shared Plain-English event-name humanizer for AccessSync admin surfaces.
 * Used by:
 *   - admin/public/logs-app.jsx       (Trace Timeline)
 *   - admin/public/member-incident-drawer.js (Errors page drawer)
 *
 * Catalog covers ~60 event types from core/EVENT_REGISTRY.md (DR-038).
 * Falls back to the raw event name with a "(plain English not yet defined)"
 * hint when uncatalogued — surfaces translation gaps loudly so they get fixed.
 *
 * No dependencies. Browser global: window.AccessSyncHumanize.
 */

(function () {
  'use strict';

  // Postgres SQLSTATE class + common code translations.
  // Class is the first 2 chars of the 5-char code; full codes that come up
  // in AccessSync hot paths get more specific copy.
  // Reference: https://www.postgresql.org/docs/current/errcodes-appendix.html
  var SQLSTATE_CODES = {
    '42883': 'Postgres rejected a query — operator/type mismatch (e.g. comparing varchar to uuid).',
    '42703': 'Postgres rejected a query — undefined column referenced.',
    '42P01': 'Postgres rejected a query — undefined table referenced.',
    '23505': 'Postgres rejected a write — UNIQUE constraint violated (duplicate row).',
    '23503': 'Postgres rejected a write — FOREIGN KEY constraint violated (referenced row missing).',
    '23502': 'Postgres rejected a write — NOT NULL constraint violated.',
    '23514': 'Postgres rejected a write — CHECK constraint violated.',
    '40001': 'Postgres rolled back a transaction — serialization failure (concurrent write conflict).',
    '40P01': 'Postgres detected a deadlock and rolled back this transaction.',
    '57014': 'Postgres cancelled the query (statement timeout).',
    '53300': 'Postgres rejected the connection — too many clients.',
    '08006': "Postgres connection failed — the database wasn't reachable.",
    '08003': 'Postgres connection was already closed when the query ran.',
  };
  var SQLSTATE_CLASSES = {
    '08': 'Postgres connection problem.',
    '22': 'Postgres rejected the query — bad data value.',
    '23': 'Postgres rejected the query — constraint violation.',
    '40': 'Postgres rolled back a transaction.',
    '42': 'Postgres rejected the query — schema or syntax problem.',
    '53': 'Postgres resource limit hit.',
    '57': 'Postgres operator action (e.g. cancellation, shutdown).',
  };
  function isSqlstate(s) {
    return typeof s === 'string' && /^[0-9A-Z]{5}$/.test(s);
  }
  function describeSqlstate(code) {
    return SQLSTATE_CODES[code] || SQLSTATE_CLASSES[code.slice(0, 2)] || ('Postgres returned SQLSTATE ' + code + '.');
  }

  /**
   * Translate one event row into a Plain-English sentence.
   * @param {Object} ev — must have .event; may have .member_name, .member_email,
   *   .client_name, .plan_name, .door_name, .actor_id, .payload, .detail
   * @returns {string}
   */
  function humanize(ev) {
    if (!ev) return '';
    var c = {
      member: ev.member_name || ev.member_email || null,
      client: ev.client_name || null,
      plan:   ev.plan_name || null,
      door:   ev.door_name || null,
      actor:  ev.actor_id || null,
    };
    var who    = c.member || (c.actor && c.actor !== 'anonymous' ? c.actor : 'Someone');
    var at     = c.client ? ' at ' + c.client : '';
    var onPlan = c.plan ? ' on the ' + c.plan + ' plan' : '';
    var door   = c.door ? ' (' + c.door + ')' : '';

    // Some sources (notably diagnostic_log) carry a 5-char SQLSTATE in the
    // `event` slot when the underlying error is a Postgres failure. The real
    // event name lives one level deeper in detail.event (or payload.event).
    // Prefer the deeper name when present so the catalog matches against
    // structured event strings instead of opaque error codes.
    var e = ev.event || '';
    var inner = (ev.detail && ev.detail.event) || (ev.payload && ev.payload.event) || null;
    if (isSqlstate(e) && inner) {
      e = inner;
    }

    // Webhook events
    if (e === 'plan.purchased' || e === 'wixPricingPlans.orderPurchased' || e === 'wixPricingPlans.orderUpdated')
      return who + ' subscribed' + onPlan + at + ' via Wix.';
    if (e === 'plan.started' || e === 'wixPricingPlans.orderStarted')
      return who + "'s plan started" + onPlan + at + '.';
    if (e === 'plan.cancelled' || e.indexOf('orderCanceled') !== -1 || e.indexOf('orderEnded') !== -1)
      return who + "'s plan was cancelled" + onPlan + at + '.';
    // Auto-renew hotfix (2026-09-10): adapters/wix/wix-adapter.js normalizes
    // orderAutoRenewCanceled to this non-routable type — nothing is queued. The
    // order stays ACTIVE and paid until Wix fires orderEnded (→ plan.cancelled).
    if (e === 'plan.autorenew_cancelled' || e === 'wixPricingPlans.orderAutoRenewCanceled')
      return who + ' turned off auto-renew' + onPlan + at + ". Their plan is still paid until it ends, so their door access stays — AccessSync removes it when Wix says the plan has ended.";
    if (e === 'plan.unpaid_order')
      return 'An unpaid Wix order arrived' + onPlan + ' — dropped, no access granted.';
    if (e === 'booking.confirmed') return who + ' confirmed a booking' + at + '.';
    if (e === 'booking.cancelled') return who + "'s booking was cancelled" + at + '.';
    if (e === 'member.deleted')    return who + ' was deleted from Wix' + at + '.';

    // Member-access events
    if (e === 'provisioned' || e === 'granted')   return '✓ Access granted to ' + who + door + '.';
    if (e === 'disabled')                         return 'Suspended access for ' + who + door + ' (payment failed or paused).';
    if (e === 'revoked')                          return 'Removed access for ' + who + door + '.';
    if (e === 'deleted')                          return "Deleted " + who + "'s hardware user.";
    if (e === 'location_suspended')               return 'Suspended ' + who + ' (location subscription lapsed).';
    if (e === 'reactivated')                      return 'Restored access for ' + who + door + '.';

    // Diagnostic events
    if (e === 'IN_FLIGHT_LOCK')                   return 'Concurrent change rejected — already processing ' + who + '.';
    if (e === 'ADAPTER_IDENTITY_GATE2_RECOVERY_TRIGGERED') return 'Webhook arrived without an email — recovering from Wix.';
    if (e === 'wix.site_id.unresolved' || e === 'WIX_SITE_ID_UNRESOLVED')
      return 'Wix webhook arrived without a site ID — falling back to client-ID header for tenant routing (expected for Velo events.js posts; investigate if it appears on a native REST webhook).';

    // Lifecycle breadcrumbs — gray (info), not yellow. These fire on every successful grant.
    if (e === 'adapter.resolve_and_lock.committed' || e === 'ADAPTER_RESOLVE_AND_LOCK_COMMITTED')
      return 'Identity resolved and locked for ' + who + '.';
    if (e === 'adapter.resolve_and_lock.post_commit_verify' || e === 'ADAPTER_RESOLVE_AND_LOCK_POST_COMMIT_VERIFY')
      return 'Lock verified for ' + who + '.';
    if (e === 'adapter.complete_grant.entry' || e === 'ADAPTER_COMPLETE_GRANT_ENTRY')
      return 'Starting grant for ' + who + ' (handoff to hardware).';
    if (e === 'adapter.complete_grant.lookup' || e === 'ADAPTER_COMPLETE_GRANT_LOOKUP')
      return 'Member record loaded for grant — ' + who + '.';
    if (e === 'wix.parse.unpaid_order_dropped' || e === 'WIX_PARSE_UNPAID_ORDER_DROPPED')
      return 'Unpaid Wix order dropped — no access granted (expected; will retry when payment lands).';

    // Kisi connector + adapter events. 409 on POST /role_assignments is an
    // idempotent-success path (DR-045 recovery) — render the warn line so it
    // reads as expected behavior, not a failure.
    if (e === 'kisi.response.error' || e === 'KISI_RESPONSE_ERROR') {
      var ks = ev.payload && ev.payload.statusCode;
      var kc = ev.payload && ev.payload.kisiCode;
      var km = ev.payload && ev.payload.kisiMessage;
      if (ks === 409 && kc === '000409')
        return 'Kisi reported the role assignment already exists — recovered by reusing it.';
      return 'Kisi API call failed (HTTP ' + (ks || '?') + (kc ? ', code ' + kc : '') + (km ? ': ' + km : '') + ').';
    }
    if (e === 'kisi.role.already_exists' || e === 'KISI_ROLE_ALREADY_EXISTS')
      return 'Kisi already has this role assignment — checking for the existing record.';
    if (e === 'kisi.role.recovery_succeeded' || e === 'KISI_ROLE_RECOVERY_SUCCEEDED')
      return '✓ Kisi role recovery succeeded — reusing existing assignment.';
    if (e === 'kisi.role.conflict_unresolvable' || e === 'KISI_ROLE_CONFLICT_UNRESOLVABLE')
      return "Kisi said this person already has access to a door, but AccessSync couldn't find that access record — so it didn't record it. Nothing was removed. Check their door groups in Kisi.";
    if (e === 'kisi.role.assign_failed' || e === 'KISI_ROLE_ASSIGN_FAILED')
      return 'Kisi rejected the role assignment — ' + who + ' did not receive door access.';
    if (e === 'queue.grant.complete' || e === 'QUEUE_GRANT_COMPLETE')
      return '✓ Grant complete for ' + who + ' — access is now active.';
    if (e === 'DB_SLOW_QUERY')                    return 'A database query took longer than the threshold.';
    if (e === 'ADAPTER_NO_IDENTITY')              return 'Revoke skipped — no identity record for this member.';
    if (e === 'QUEUE_REVOKE_NO_IDENTITY')         return 'Cancel arrived for a member we never provisioned.';

    // DR-054 — info events promoted to persist. These MUST sit above the generic
    // 'grant.' / 'revoke.' prefix fallbacks below, or those swallow them and render
    // "Grant step: role reused." instead of a real sentence. Both name forms are
    // matched: diagnostic_log surfaces events as UPPERCASE_UNDERSCORE.
    //
    // Voice: these answer "why did or didn't this member get in", so they lead with
    // the outcome, not the mechanism.
    if (e === 'queue.grant.parked.no_mapping' || e === 'QUEUE_GRANT_PARKED_NO_MAPPING')
      return who + ' paid' + onPlan + ' but that plan isn\'t mapped to a door yet — no access granted' + at + '.';
    if (e === 'queue.grant.parked.no_api_key' || e === 'QUEUE_GRANT_PARKED_NO_API_KEY')
      return who + ' paid' + onPlan + ' but there\'s no hardware key saved' + at + ' — no access granted.';
    if (e === 'adapter.identity.parked' || e === 'ADAPTER_IDENTITY_PARKED')
      return "Couldn't confirm who this member is — parked until their details resolve. No access yet.";
    if (e === 'adapter.identity.gate2_recovered' || e === 'ADAPTER_IDENTITY_GATE2_RECOVERED')
      return "Recovered a missing email from Wix — " + who + "'s grant carried on normally.";
    if (e === 'revoke.billing_cancelled' || e === 'REVOKE_BILLING_CANCELLED')
      return 'Marked ' + who + "'s billing" + onPlan + ' as cancelled.';
    if (e === 'revoke.billing_status_preserved' || e === 'REVOKE_BILLING_STATUS_PRESERVED')
      return 'Left billing active for ' + who + ' — a seat changed, but the plan is still running on Wix.';
    if (e === 'revoke.group.skipped' || e === 'REVOKE_GROUP_SKIPPED')
      return 'Kept ' + who + "'s door access" + door + ' — another active plan still needs this door.';
    if (e === 'grant.role.source_exists' || e === 'GRANT_ROLE_SOURCE_EXISTS')
      return who + ' already had access to this door' + door + ' — no new hardware call needed.';
    if (e === 'grant.role.reused' || e === 'GRANT_ROLE_REUSED')
      return "Reused " + who + "'s existing door assignment" + door + ' instead of creating a new one.';
    if (e === 'kisi.user.created' || e === 'KISI_USER_CREATED')
      return 'Created ' + who + ' in Kisi.';
    if (e === 'kisi.user.deleted' || e === 'KISI_USER_DELETED')
      return "Deleted " + who + "'s Kisi user.";
    if (e === 'kisi.user.delete_skipped_already_gone' || e === 'KISI_USER_DELETE_SKIPPED_ALREADY_GONE')
      return who + "'s Kisi user was already gone — nothing to delete.";

    // Phase 1 "stop the bleeding" (2026-09-10) — guards and hardened reads outside
    // the sweep. The grant.* entries MUST stay above the 'grant.' prefix fallback
    // below. Voice: a gym owner reading the timeline — say whether anyone lost access.
    // Fix round (2026-09-10, F3/F4): each of these fails ONE door, not the whole
    // grant — doors already recorded are kept and the rest are still tried. The
    // job only fails if no door at all could be recorded.
    if (e === 'grant.user_gone' || e === 'GRANT_USER_GONE')
      return who + "'s Kisi account no longer exists, so AccessSync couldn't add their door access" + onPlan + at +
        '. The door itself is fine and was left alone, and any door access already recorded was kept. Check ' +
        (c.member ? 'their' : 'the member\'s') + ' account in Kisi.';
    if (e === 'grant.not_found_ambiguous' || e === 'GRANT_NOT_FOUND_AMBIGUOUS')
      return 'Kisi said something was missing while adding ' + who + "'s door access" + at +
        ", and AccessSync couldn't tell whether it was the member or the door — so it didn't add that door and left the door alone. Any other doors on the plan were still tried. Check the Errors page.";
    if (e === 'grant.role.conflict_unresolved' || e === 'GRANT_ROLE_CONFLICT_UNRESOLVED')
      return "Couldn't record one of " + who + "'s doors" + door + at + " — Kisi says they already have access to it, but AccessSync couldn't find the matching access record, so it left it alone. Any other doors on the plan were still tried. Check " +
        (c.member ? 'their' : 'the member\'s') + ' door groups in Kisi.';
    if (e === 'adapter.finalize_revoke.refused_shared_user' || e === 'ADAPTER_FINALIZE_REVOKE_REFUSED_SHARED_USER')
      return 'Kept ' + who + "'s Kisi account instead of deleting it — another member uses the same Kisi account" + at +
        '. Nobody else lost access.';
    if (e === 'adapter.finalize_revoke.refused_other_assignments' || e === 'ADAPTER_FINALIZE_REVOKE_REFUSED_OTHER_ASSIGNMENTS')
      return 'Kept ' + who + "'s Kisi account instead of deleting it — it still has door access that AccessSync didn't add" + at +
        '. That access was left alone.';
    if (e === 'adapter.finalize_revoke.assignment_check_failed' || e === 'ADAPTER_FINALIZE_REVOKE_ASSIGNMENT_CHECK_FAILED')
      return 'Kept ' + who + "'s Kisi account instead of deleting it — AccessSync couldn't check what other door access it has, so it didn't delete on a guess. Nothing else was removed.";
    if (e === 'adapter.not_paying.record_failed' || e === 'ADAPTER_NOT_PAYING_RECORD_FAILED')
      return "Couldn't note that a member wasn't paying in Wix during a sync — nothing was removed. The next sync notes it again.";
    if (e === 'adapter.not_paying.clear_failed' || e === 'ADAPTER_NOT_PAYING_CLEAR_FAILED')
      return "Couldn't reset a member's not-paying count after they showed as paying again — nothing was removed. The next sync tries again.";
    if (e === 'adapter.not_paying.columns_missing' || e === 'ADAPTER_NOT_PAYING_COLUMNS_MISSING')
      return "Not-paying tracking isn't switched on in the database yet (update pending) — so nobody can be removed for not paying.";
    if (e === 'kisi.user.find_no_exact_match' || e === 'KISI_USER_FIND_NO_EXACT_MATCH')
      return "Kisi had no account with exactly this member's email — AccessSync didn't reuse a near match, so door access can't land on the wrong person.";
    if (e === 'kisi.page_integrity_failed' || e === 'KISI_PAGE_INTEGRITY_FAILED')
      return "Kisi sent back a list that didn't look complete — AccessSync stopped rather than act on partial data, so nothing was changed or deleted because of it.";
    if (e === 'wix.orders.no_member_id' || e === 'WIX_ORDERS_NO_MEMBER_ID') {
      var nm = (ev.payload || ev.detail || {}).count;
      return (nm != null ? nm + ' Wix ' + (nm === 1 ? 'order' : 'orders') : 'Some Wix orders') +
        ' had no member attached, so a sync skipped ' + (nm === 1 ? 'it' : 'them') + ' — nobody gained or lost access because of ' + (nm === 1 ? 'it.' : 'them.');
    }
    if (e === 'wix.orders_classified.fetch_failed' || e === 'WIX_ORDERS_CLASSIFIED_FETCH_FAILED')
      return "Couldn't read orders from Wix during a sync — AccessSync stopped and changed nothing. Nobody lost access.";
    if (e === 'admin.retry.unroutable_event_type' || e === 'ADMIN_RETRY_UNROUTABLE_EVENT_TYPE')
      return "A retry was refused — this failed job isn't a door-access grant or removal, so there was nothing to re-run. It stays open on the Errors list.";
    if (e === 'admin.retry.unreadable_payload' || e === 'ADMIN_RETRY_UNREADABLE_PAYLOAD')
      return "A retry was refused — the failed job's saved details couldn't be read, so nothing was re-run. It stays open on the Errors list.";
    if (e === 'admin.retry.revoke_disabled' || e === 'ADMIN_RETRY_REVOKE_DISABLED')
      return "A retry was refused — it would have removed someone's door access, and retrying removals is paused while AccessSync's safety checks roll out. " +
        'Nothing was changed and it stays open on the Errors list. If this person should lose access, remove them in Kisi.';

    if (e.indexOf('grant.') === 0)               return 'Grant step: ' + e.replace('grant.', '').replace(/_/g, ' ') + '.';
    if (e.indexOf('revoke.') === 0)               return 'Revoke step: ' + e.replace('revoke.', '').replace(/_/g, ' ') + '.';
    if (e.indexOf('hmac.') === 0)                 return 'Webhook signature: ' + e.replace('hmac.', '').replace(/_/g, ' ') + '.';

    // Alerts
    if (e === 'no_mapping_found' || e === 'missing_group')
      return 'Plan "' + (c.plan || 'unknown') + "\" isn't mapped to a hardware group" + at + '.';
    if (e === 'group_not_found')                  return 'Hardware group missing — the door it points to no longer exists' + at + '.';
    if (e === 'untraceable_hardware_access')      return who + ' has door access but no plan or booking justifies it' + at + '.';
    if (e === 'wix_api_unavailable')              return "Wix API didn't respond during reconciliation" + at + '.';
    if (e === 'wix_snapshot_anomaly')
      return "Wix gave membership numbers that didn't add up" + at + ', so AccessSync paused removals rather than guess. Nobody lost access; the next sync checks again.';
    // Phase 1 (2026-09-10) alert types — core/reconciliation.js + adapters/standard-adapter.js
    // finalizeRevoke. Same meaning as core/operator-email-templates.js describeConfigAlert.
    // Never read the row's hardware_ref here: for these it holds machine detail
    // ("mass_revoke:wix_orders:…", "member:<id>", Kisi user ids), not a door name.
    // Only alert types some code writes are listed. The v2 gate's aliases
    // (revoke_batch_would_revoke_all, revoke_revalidation_failed, revoke_mass_revoke,
    // revoke_snapshot_unstable, revoke_auto_revoke_*, revoke_dry_run,
    // revoke_observation_only, revoke_strike_pending) were removed in the fix round
    // (2026-09-10): nothing writes them and none was ever committed, so no stored
    // row can carry one. revoke_unknown stays — it is reconciliation.js
    // _insertAlertOnce's fallback when an alert type is missing.
    var memberStart = c.member || 'A member';
    if (e === 'kisi_api_unavailable')
      return "Kisi didn't respond during a sync" + at + ' — AccessSync stopped and changed nothing. Nobody lost access; the next sync tries again.';
    if (e === 'hardware_api_unavailable')
      return "The door system didn't respond during a sync" + at + ' — AccessSync stopped and changed nothing. Nobody lost access; the next sync tries again.';
    if (e === 'revoke_batch_mass_revoke')
      return 'A sync was about to remove door access for an unusually large number of members' + at +
        ' at once, so AccessSync stopped and removed no one. Nobody lost access. Check that your plans and memberships in Wix look right.';
    if (e === 'revoke_invalid_proposal' || e === 'revoke_unknown')
      return 'AccessSync ran into an internal problem while checking memberships' + at +
        ' and stopped before changing anything. Nobody lost access.';
    if (e === 'finalize_refused_other_assignments')
      return "AccessSync didn't delete " + (c.member ? c.member + "'s" : "a member's") + ' Kisi account because they still have door access' + at +
        " that wasn't added by AccessSync — nothing was removed. If they shouldn't have that access anymore, remove it in Kisi.";
    if (e === 'finalize_refused_shared_user')
      return "AccessSync didn't delete " + (c.member ? c.member + "'s" : "a member's") + ' Kisi account because another member' + at +
        ' uses the same Kisi account — nothing was removed. Check in Kisi that each person has their own account.';
    if (e === 'sweep_repair_pending')
      return (c.member ? c.member + ' is a paying member, but their door access' : "A paying member's door access") +
        at + ' is missing in Kisi. AccessSync will restore it once automatic repair is switched on; until then you can re-add it in Kisi.';
    if (e === 'sweep_removal_pending')
      return memberStart + at + " no longer shows as paying in Wix. Automatic removal is paused while AccessSync's safety checks roll out, " +
        'so nothing was removed and they can still get in. If they really stopped paying, you can remove their access in Kisi.';
    if (e === 'revoke_holder_lapse_pending')
      return memberStart + at + " is on a shared plan whose main member no longer shows as paying in Wix. Automatic removal is paused while AccessSync's safety checks roll out, " +
        'so nothing was removed and they can still get in.';
    // Fix round (2026-09-10, F2): a declined, pending or unrecognized Wix payment is
    // not a cancellation — the sweep never proposes it for removal. One alert per
    // membership (a family is one alert, naming the main member).
    if (e === 'revoke_held_payment_state')
      return (c.member ? c.member + "'s Wix payment" : "A member's Wix payment") + at +
        ' is declined, pending or unrecognized — AccessSync is leaving their door access alone. Nobody lost access. ' +
        "If the payment doesn't go through and they shouldn't get in, you can remove their access in Kisi.";
    if (e === 'lockdown_detected')               return 'A door is currently in lockdown' + at + '.';
    if (e === 'api_key_invalid_after_rotation')   return 'Hardware API key was rotated but new key is invalid' + at + '.';

    // Activity (operator mutations)
    if (e === 'plan_mapping.created')   return (who || 'An operator') + ' created a plan mapping' + at + '.';
    if (e === 'plan_mapping.updated')   return (who || 'An operator') + ' updated a plan mapping' + at + '.';
    if (e === 'plan_mapping.deleted')   return (who || 'An operator') + ' deleted a plan mapping' + at + '.';
    if (e === 'api_key.saved')          return (who || 'An operator') + ' saved a hardware API key' + at + '.';
    if (e === 'api_key.rotated')        return (who || 'An operator') + ' rotated the hardware API key' + at + '.';
    if (e === 'location.suspended')     return (who || 'An operator') + ' suspended a location' + at + '.';
    if (e === 'location.activated')     return (who || 'An operator') + ' reactivated a location' + at + '.';
    if (e === 'member.synced')          return (who || 'An operator') + ' ran a per-member sync' + at + '.';
    if (e === 'client.synced')          return (who || 'An operator') + ' ran a full sync' + at + '.';
    if (e === 'error.retried')          return (who || 'An operator') + ' retried a failed job' + at + '.';
    if (e === 'client_deleted')         return (who || 'An owner') + ' deleted client ' + (c.client || '') + '.';
    // Passive voice: `who` (member_name) on these events is the SUB-MEMBER being
    // added/removed, not the actor who did it. Active voice ("X added a sub-member")
    // wrongly read as if the sub-member performed the action. The actor lives in a
    // separate actor_id and doesn't reliably resolve to a name (esp. on revoke).
    if (e === 'sub_member.revoke_queued')
      return (who || 'A member') + ' was removed as a sub-member' + onPlan + at + '.';
    if (e === 'sub_member.grant_queued')
      return (who || 'A member') + ' was added as a sub-member' + onPlan + at + '.';
    if (e === 'holder.claim_slot_queued')
      return (who || 'A plan holder') + ' claimed their own access slot' + onPlan + at + '.';
    if (e === 'holder.release_slot_queued')
      return (who || 'A plan holder') + ' released their access slot' + onPlan + at + '.';
    // DR-052 — member-facing branded email pipeline. `who` is the MEMBER the email
    // is about (recipient), never the sender — passive/system voice keeps it honest.
    if (e === 'email.member.sent' || e === 'EMAIL_MEMBER_SENT')
      return 'A branded email was sent to ' + who + at + '.';
    if (e === 'email.member.suppressed' || e === 'EMAIL_MEMBER_SUPPRESSED')
      return 'A member email was skipped — already sent for this event (or a background sync, which never emails members).';
    if (e === 'email.member.skipped_disabled' || e === 'EMAIL_MEMBER_SKIPPED_DISABLED')
      return 'A member email was skipped — member emails are turned off for this gym (or no address on file).';
    if (e === 'email.member.failed' || e === 'EMAIL_MEMBER_FAILED')
      return "A member email failed to send — access itself is unaffected.";
    // DR-053 — AccessSync-branded operator alert emails (hardware key failure, orphaned
    // groups, archived plans, HMAC spike, nightly digest, retry-engine). `who` here would
    // resolve to the sender/actor context, not meaningful for a system-to-operator alert —
    // omitted deliberately.
    if (e === 'email.operator.sent' || e === 'EMAIL_OPERATOR_SENT')
      return 'An AccessSync alert email was sent' + at + '.';
    if (e === 'email.operator.failed' || e === 'EMAIL_OPERATOR_FAILED')
      return 'An AccessSync alert email failed to send' + at + '.';
    if (e === 'email.operator.no_recipient' || e === 'EMAIL_OPERATOR_NO_RECIPIENT')
      return 'An AccessSync alert was skipped — no notification email on file' + at + '.';
    if (e === 'email_branding.updated')
      return (who || 'An operator') + ' updated the member-email branding' + at + '.';
    if (e === 'email_branding.logo_uploaded')
      return (who || 'An operator') + ' uploaded a member-email logo' + at + '.';
    if (e === 'email_branding.test_sent')
      return (who || 'An operator') + ' sent a branded test email' + at + '.';

    if (e === 'sub_member_soft_deleted')
      return 'Sub-member record finalized — personal info purged, audit row preserved.';
    if (e === 'member.sub_member.soft_deleted')
      return 'Sub-member soft-deleted — DB record kept as audit shell, PII purged.';
    if (e === 'member.sub_member.soft_delete_idempotent_skip')
      return 'Soft-delete already done — no-op (race or replay).';

    // OB-237 + OB-238 — Setup Hub activity events.
    if (e === 'admin.setup_hub.snippet_copied') {
      var copiedId = ev.detail?.snippet_id || c.snippet_id || 'a snippet';
      return (who || 'An operator') + ' copied ' + copiedId + ' from the Setup Hub' + at + '.';
    }
    if (e === 'admin.setup_hub.test_connection') {
      var testedId = ev.detail?.snippet_id || c.snippet_id || 'a snippet';
      var testResult = ev.detail?.result || c.result || 'unknown';
      var verdict =
        testResult === 'ok'                       ? 'verified live via telemetry' :
        testResult === 'evidence_without_version' ? 'webhook evidence found but no version header yet (likely pre-v2.1 install OR just-upgraded waiting for next Wix event)' :
        testResult === 'no_telemetry'             ? 'no telemetry yet' :
        testResult === 'no_heartbeat'             ? 'no iframe heartbeat received yet (page may not have been visited by a logged-in member)' :
        testResult === 'no_activity'              ? 'no webhook activity at all from this Wix site' :
        testResult === 'version_mismatch'         ? 'installed version is out of date' :
        testResult === 'stale_telemetry'          ? 'last telemetry is older than the staleness window' :
        testResult === 'hmac_failed'              ? 'recent webhooks failed HMAC verification (secret mismatch between AccessSync and Wix Secrets Manager)' :
        testResult === 'no_verification'          ? 'no automatic verification available for this snippet' :
        testResult;
      return (who || 'An operator') + ' tested the ' + testedId + ' Wix snippet' + at + ' — ' + verdict + '.';
    }
    if (e === 'admin.wix_webhook_secret.rotated')
      return (who || 'An operator') + ' rotated the per-client Wix webhook HMAC secret' + at + '. Wix Secrets Manager must be updated to match.';
    if (e === 'admin.wix_webhook_secret.set_custom')
      return (who || 'An operator') + ' set a custom per-client Wix webhook HMAC secret' + at + '. Wix Secrets Manager must contain the same value.';
    if (e === 'clients.wix_webhook_secret.auto_generated')
      return 'AccessSync auto-generated the per-client Wix webhook HMAC secret on first Setup Hub visit (no manual click required).';
    if (e === 'clients.wix_webhook_secret.rotated')
      return 'Per-client Wix webhook HMAC secret rotated — operator-triggered.';
    if (e === 'clients.wix_webhook_secret.set_custom')
      return 'Per-client Wix webhook HMAC secret set to operator-provided custom value.';

    // Internal infrastructure failures (route handlers + logger fault paths).
    // These bubble up when the system itself can't talk to Postgres or is
    // logging its own crash — important to surface in plain English so the
    // operator knows it's a platform-level issue, not a member-level one.
    if (e === 'db.query_error' || e === 'admin.logs.events_failed') {
      var sqlstate = ev.detail && ev.detail.error && ev.detail.error.code;
      var why = isSqlstate(sqlstate) ? ' ' + describeSqlstate(sqlstate) : '';
      return 'A database query failed.' + why;
    }
    if (e === 'admin.logs.typeahead_failed')      return 'The trace search query failed.';
    if (e === 'admin.logs.trace_failed')          return 'Loading a single trace failed.';
    if (e === 'logger.diagnostic_log_write_failed') return "Couldn't write a diagnostic row to the database (logged to stdout instead).";
    if (e === 'activity.write_failed')            return "Couldn't write an activity row to the database.";
    if (e === 'trace_context.write_failed')       return "Couldn't write trace context (member/plan resolution row).";
    if (e === 'trace_context.update_failed')      return "Couldn't enrich trace context after the fact.";
    if (e === 'admin.unhandled_error')            return 'An unhandled error in the admin server.';
    if (e === 'admin.uncaught_exception')         return 'An uncaught exception in the admin process — investigate immediately.';
    if (e === 'admin.unhandled_rejection')        return 'An unhandled promise rejection in the admin process.';

    // Reconciliation sweep events (long prefix `reconciliation.*` — emitted by
    // core/reconciliation.js). Builder's trace tool surfaced unhandled entries
    // for two of these 2026-05-27; humanizer coverage added per Run #10.
    if (e === 'reconciliation.sweep_start' || e === 'RECONCILIATION_SWEEP_START')
      return 'Reconcile sweep started (cron trigger).';
    if (e === 'reconciliation.sweep_complete' || e === 'RECONCILIATION_SWEEP_COMPLETE')
      return 'Reconcile sweep finished cleanly.';
    if (e === 'reconciliation.sweep_failed' || e === 'RECONCILIATION_SWEEP_FAILED')
      return 'Reconcile sweep threw — investigate cron logs.';
    if (e === 'reconciliation.skipped' || e === 'RECONCILIATION_SKIPPED') {
      var reason = ev.payload && ev.payload.reason;
      return 'Reconcile sweep skipped' + (reason ? ' — ' + reason : '') + '.';
    }
    if (e === 'reconciliation.stale_reset' || e === 'RECONCILIATION_STALE_RESET') {
      var released = ev.payload && ev.payload.releasedCount;
      if (released === 0 || released == null)
        return 'Reconcile sweep checked for stale in_flight locks — none aged out.';
      return 'Reconcile sweep flipped ' + released + ' stale in_flight ' +
        (released === 1 ? 'lock' : 'locks') + ' to recovery_pending (OB-202 retry).';
    }
    if (e === 'reconciliation.actionable_records' || e === 'RECONCILIATION_ACTIONABLE_RECORDS') {
      var count = ev.payload && ev.payload.count;
      return 'Reconcile found ' + (count != null ? count : '?') + ' actionable record' +
        (count === 1 ? '' : 's') + ' to process.';
    }
    if (e === 'reconciliation.wix_sync_start' || e === 'RECONCILIATION_WIX_SYNC_START')
      return 'Reconcile Wix-truth sync started across all clients.';
    if (e === 'reconciliation.wix_sync_complete' || e === 'RECONCILIATION_WIX_SYNC_COMPLETE')
      return 'Reconcile Wix-truth sync finished across all clients.';
    if (e === 'reconciliation.client_sync_complete' || e === 'RECONCILIATION_CLIENT_SYNC_COMPLETE')
      return 'Reconcile finished for client' + at + '.';
    if (e === 'reconciliation.client_sync_failed' || e === 'RECONCILIATION_CLIENT_SYNC_FAILED')
      return 'Reconcile failed for client' + at + ' — see error detail.';
    if (e === 'reconciliation.run_open_failed' || e === 'RECONCILIATION_RUN_OPEN_FAILED')
      return "Couldn't open a reconcile-run row" + at + ' — continuing without run tracking.';
    if (e === 'reconciliation.run_close_failed' || e === 'RECONCILIATION_RUN_CLOSE_FAILED')
      return "Couldn't close the reconcile-run row — run tracking left open.";
    if (e === 'reconciliation.wix_fetch_failed' || e === 'RECONCILIATION_WIX_FETCH_FAILED')
      return "Wix API didn't respond during reconcile" + at + ' — fail-closed, no changes applied.';
    if (e === 'reconciliation.unmanaged_assignment_observed' || e === 'RECONCILIATION_UNMANAGED_ASSIGNMENT_OBSERVED') {
      var groupId = ev.payload && ev.payload.hardwareGroupId;
      var userId = ev.payload && ev.payload.kisiUserId;
      return 'Kisi assignment observed but not managed by AccessSync — ' +
        (userId ? 'user ' + userId + ' ' : '') +
        (groupId ? 'on group ' + groupId : '') +
        '. Preserved per A11 operator-grant safety.';
    }
    if (e === 'reconciliation.source_promoted_from_cancelled' || e === 'RECONCILIATION_SOURCE_PROMOTED_FROM_CANCELLED')
      return 'Reconcile promoted a cancelled source row back to active (Wix shows plan active again).';
    if (e === 'reconciliation.source_promotion_failed' || e === 'RECONCILIATION_SOURCE_PROMOTION_FAILED')
      return 'Reconcile tried to promote a cancelled source row — DB write failed.';
    if (e === 'reconciliation.plan_not_mapped' || e === 'RECONCILIATION_PLAN_NOT_MAPPED')
      return 'Reconcile saw an active Wix plan with no hardware mapping' + at + ' — skipped.';
    if (e === 'reconciliation.billing_backfill_failed' || e === 'RECONCILIATION_BILLING_BACKFILL_FAILED')
      return "Reconcile couldn't backfill member_billing from Wix order state.";
    if (e === 'reconciliation.billing_id_link_failed' || e === 'RECONCILIATION_BILLING_ID_LINK_FAILED')
      return "Reconcile couldn't link the new source row to its billing record.";
    if (e === 'reconciliation.source_inserted_from_wix' || e === 'RECONCILIATION_SOURCE_INSERTED_FROM_WIX')
      return 'Reconcile inserted a missing source row from Wix order state.';
    if (e === 'reconciliation.source_insert_failed' || e === 'RECONCILIATION_SOURCE_INSERT_FAILED')
      return 'Reconcile tried to insert a missing source row — DB write failed.';
    if (e === 'reconciliation.access_rollup_failed' || e === 'RECONCILIATION_ACCESS_ROLLUP_FAILED')
      return "Reconcile couldn't roll up member_access status from source rows.";
    if (e === 'reconciliation.role_assignment_backfilled' || e === 'RECONCILIATION_ROLE_ASSIGNMENT_BACKFILLED')
      return 'Reconcile backfilled a Kisi role-assignment ID onto an existing source row.';
    if (e === 'reconciliation.role_assignment_backfill_failed' || e === 'RECONCILIATION_ROLE_ASSIGNMENT_BACKFILL_FAILED')
      return 'Reconcile tried to backfill a Kisi role-assignment ID — write failed.';
    if (e === 'reconciliation.pass_1_2_complete' || e === 'RECONCILIATION_PASS_1_2_COMPLETE')
      return 'Reconcile finished Pass 1+2 (promote/insert + observe orphans)' + at + '.';
    if (e === 'reconciliation.wix_order_no_plan_id' || e === 'RECONCILIATION_WIX_ORDER_NO_PLAN_ID')
      return 'Reconcile saw a Wix order with no plan ID — skipped (cannot map without plan).';
    if (e === 'reconciliation.grant_skipped_optin' || e === 'RECONCILIATION_GRANT_SKIPPED_OPTIN')
      return 'Reconcile skipped a grant — member opted out of hardware provisioning.';
    if (e === 'reconciliation.grant_queued' || e === 'RECONCILIATION_GRANT_QUEUED')
      return 'Reconcile queued a grant for ' + who + onPlan + at + '.';
    if (e === 'reconciliation.revoke_queued' || e === 'RECONCILIATION_REVOKE_QUEUED')
      return 'Reconcile queued a revoke for ' + who + onPlan + at + '.';
    // sanity_gate_* are retired (2026-09-10, no longer emitted) — kept so older
    // diagnostic_log rows still read as sentences.
    if (e === 'reconciliation.sanity_gate_triggered' || e === 'RECONCILIATION_SANITY_GATE_TRIGGERED')
      return 'Reconcile sanity gate triggered — pending bulk-revoke count exceeded threshold.';
    if (e === 'reconciliation.sanity_gate_requery_failed' || e === 'RECONCILIATION_SANITY_GATE_REQUERY_FAILED')
      return 'Reconcile sanity gate requery against Wix failed — aborting to be safe.';
    if (e === 'reconciliation.sanity_gate_resolved_proceed' || e === 'RECONCILIATION_SANITY_GATE_RESOLVED_PROCEED')
      return 'Reconcile sanity gate cleared on requery — proceeding with revokes.';
    if (e === 'reconciliation.sanity_gate_aborted' || e === 'RECONCILIATION_SANITY_GATE_ABORTED')
      return 'Reconcile sanity gate aborted bulk-revoke pass — operator review required.';
    // Phase 1 "stop the bleeding" (2026-09-10) — core/reconciliation.js + core/revoke-policy.js.
    // The sweep is observation-only: it finds members who look like they should
    // lose access, records them, and removes no one. These say what it found and why
    // nothing happened. Voice: a gym owner — always say whether anyone lost access.
    if (e === 'reconciliation.revokes_held' || e === 'RECONCILIATION_REVOKES_HELD') {
      var rh = ev.payload || ev.detail || {};
      var heldN = rh.heldMembers != null ? rh.heldMembers : rh.heldCount;
      var heldWho = heldN != null ? heldN + (heldN === 1 ? ' member looks' : ' members look') : 'Some members look';
      var heldLead = heldWho + ' like they should lose door access' + at;
      if (rh.reason === 'observation_only')
        return heldLead + ", but automatic removal is paused while AccessSync's safety checks roll out. Nobody lost access.";
      if (rh.reason === 'snapshot_unstable')
        return heldLead + ", but Wix gave two different member lists moments apart, so AccessSync removed no one. Nobody lost access; the next sync checks again.";
      if (rh.reason === 'mass_revoke')
        return heldLead + ", but that's an unusually large share of the gym at once, which points to a data problem, so AccessSync removed no one. Nobody lost access.";
      if (rh.reason === 'invalid_proposal')
        return heldLead + ', but AccessSync hit an internal problem checking them and removed no one. Nobody lost access.';
      if (rh.reason === 'auto_revoke_off')
        return heldLead + ', but automatic removals are switched off for this gym. Nobody lost access.';
      if (rh.reason === 'dry_run')
        return heldLead + ", but automatic removal is paused while AccessSync's safety checks roll out. Nobody lost access.";
      if (rh.reason === 'strike_pending')
        return heldLead + ", but they haven't been unpaid long enough yet to act on. Nobody lost access.";
      return heldLead + ', but AccessSync held back. Nobody lost access.';
    }
    if (e === 'reconciliation.revoke_held' || e === 'RECONCILIATION_REVOKE_HELD') {
      var rp = ev.payload || ev.detail || {};
      var why1 = rp.reason === 'dry_run'
        ? "automatic removal is paused while AccessSync's safety checks roll out"
        : 'automatic removals are switched off for this gym';
      if (rp.path === 'holder_seat_release')
        return 'A plan holder\'s released seat was left in place' + at + ' — ' + why1 + '. The seat will not be re-added.';
      if (rp.path === 'reconcile_member')
        return 'Re-check found a member with no active plan who still has door access' + at + ' — ' + why1 + ', so their access was left in place.';
      return 'A door-access removal was held back' + at + ' — ' + why1 + '. Nobody lost access.';
    }
    // Fix round (2026-09-10, F2): members whose Wix payment is declined, pending or
    // unrecognized (for a sub-member: their main member's) — never proposed for
    // removal; any not-paying count they had is reset. Counted in memberships (a
    // family is one).
    if (e === 'reconciliation.payment_state_held' || e === 'RECONCILIATION_PAYMENT_STATE_HELD') {
      var ph = ev.payload || ev.detail || {};
      var phN = ph.heldUnits != null ? ph.heldUnits : ph.heldCount;
      return (phN != null ? phN + (phN === 1 ? ' membership has' : ' memberships have') : 'Some memberships have') +
        ' a Wix payment that is declined, pending or unrecognized' + at +
        ' — AccessSync is leaving their door access alone. Nobody lost access.';
    }
    if (e === 'reconciliation.holder_seated_read_failed' || e === 'RECONCILIATION_HOLDER_SEATED_READ_FAILED')
      return "Couldn't check whether a plan holder had given up their own seat during a sync" + at +
        ' — that plan was left exactly as it was for this member. Nobody lost access; the next sync checks again.';
    if (e === 'reconcileMember.hardware_fetch_failed' || e === 'RECONCILEMEMBER_HARDWARE_FETCH_FAILED')
      return "Couldn't reach the door system while re-checking " + who + at + ' — no changes were made. Try again in a few minutes.';
    if (e === 'reconciliation.repairs_pending' || e === 'RECONCILIATION_REPAIRS_PENDING') {
      var rr = ev.payload || ev.detail || {};
      var repN = rr.repairMembers != null ? rr.repairMembers : rr.repairCount;
      return (repN != null ? repN + ' paying ' + (repN === 1 ? 'member is' : 'members are') : 'Some paying members are') +
        ' missing door access in Kisi' + at + '. AccessSync will restore it once automatic repair is switched on; until then you can re-add it in Kisi.';
    }
    if (e === 'reconciliation.wix_reads_disagreed' || e === 'RECONCILIATION_WIX_READS_DISAGREED')
      return 'Wix gave two slightly different member lists moments apart' + at + ' — anyone paying in either list was treated as paying. Nobody lost access.';
    if (e === 'reconciliation.kisi_fetch_failed' || e === 'RECONCILIATION_KISI_FETCH_FAILED')
      return "Kisi didn't respond during a sync" + at + ' — AccessSync stopped and changed nothing. Nobody lost access; the next sync tries again.';
    if (e === 'reconciliation.client_sync_skipped_locked' || e === 'RECONCILIATION_CLIENT_SYNC_SKIPPED_LOCKED')
      return 'Skipped a sync' + at + ' — another sync for this gym was already running. Nothing changed.';
    if (e === 'reconciliation.client_lock_unavailable' || e === 'RECONCILIATION_CLIENT_LOCK_UNAVAILABLE')
      return "Couldn't take the sync lock" + at + " — the sync ran anyway. That's safe for now because syncs don't remove anyone.";
    if (e === 'reconciliation.client_lock_release_failed' || e === 'RECONCILIATION_CLIENT_LOCK_RELEASE_FAILED')
      return "Couldn't cleanly release the sync lock" + at + ' — the connection was closed instead, so the next sync is not blocked.';
    if (e === 'reconciliation.active_source_census_failed' || e === 'RECONCILIATION_ACTIVE_SOURCE_CENSUS_FAILED')
      return "Couldn't load the list of members with door access during a sync" + at + ' — the not-paying check was skipped. Nobody lost access.';
    if (e === 'reconciliation.strike_clock_unavailable' || e === 'RECONCILIATION_STRIKE_CLOCK_UNAVAILABLE')
      return "Not-paying tracking isn't switched on in the database yet (update pending) — so nobody can be removed for not paying.";
    if (e === 'reconciliation.strike_read_failed' || e === 'RECONCILIATION_STRIKE_READ_FAILED')
      return "Couldn't read members' not-paying counts during a sync" + at + ' — nothing was removed.';
    if (e === 'reconciliation.strike_record_failed' || e === 'RECONCILIATION_STRIKE_RECORD_FAILED')
      return "Couldn't note that a member wasn't paying" + at + ' — nothing was removed. The next sync notes it again.';
    if (e === 'reconciliation.strike_clear_failed' || e === 'RECONCILIATION_STRIKE_CLEAR_FAILED')
      return "Couldn't reset a member's not-paying count after they showed as paying again" + at + ' — nothing was removed. The next sync tries again.';
    if (e === 'reconciliation.proposal_population_mismatch' || e === 'RECONCILIATION_PROPOSAL_POPULATION_MISMATCH')
      return "A sync's safety check found removal candidates it couldn't account for" + at + ' — they were held. Nobody lost access.';
    if (e === 'reconciliation.flush_ignored_observation_only' || e === 'RECONCILIATION_FLUSH_IGNORED_OBSERVATION_ONLY')
      return 'A sync tried to approve door-access removals' + at + ', but removals are switched off in this version — nothing was removed. Worth a look by AccessSync support.';
    if (e === 'reconciliation.revoke_enqueue_refused_observation_only' || e === 'RECONCILIATION_REVOKE_ENQUEUE_REFUSED_OBSERVATION_ONLY')
      return 'A door-access removal was blocked' + at + ' — removals are switched off in this version. Nobody lost access. Worth a look by AccessSync support.';
    if (e === 'reconciliation.alert_write_failed' || e === 'RECONCILIATION_ALERT_WRITE_FAILED')
      return "Couldn't save an alert during a sync" + at + ' — nothing else was affected.';
    if (e === 'reconciliation.proposal_log_unavailable' || e === 'RECONCILIATION_PROPOSAL_LOG_UNAVAILABLE')
      return "The sync's decision log isn't set up in the database yet (update pending) — the sync carried on. Nothing was removed.";
    if (e === 'reconciliation.proposal_log_failed' || e === 'RECONCILIATION_PROPOSAL_LOG_FAILED')
      return "Couldn't save the sync's decision log" + at + ' — the sync carried on. Nothing was removed.';
    if (e === 'reconciliation.revoke_queue_failed' || e === 'RECONCILIATION_REVOKE_QUEUE_FAILED')
      return "Couldn't queue a door-access removal" + at + ' — the member keeps access for now; the next sync tries again.';
    if (e === 'reconciliation.requeue_skipped_unroutable' || e === 'RECONCILIATION_REQUEUE_SKIPPED_UNROUTABLE') {
      var ru = ev.payload || ev.detail || {};
      return 'A failed job was not retried' + (ru.eventType ? ' — its event type (' + ru.eventType + ')' : ' — its event type') +
        " isn't a grant or a removal, so AccessSync left it alone.";
    }
    if (e === 'reconciliation.requeue_skipped_revoke' || e === 'RECONCILIATION_REQUEUE_SKIPPED_REVOKE')
      return 'A failed door-access removal was not retried — syncs only retry grants right now. Nobody lost access.';
    if (e === 'reconciliation.requeue_skipped_not_paying' || e === 'RECONCILIATION_REQUEUE_SKIPPED_NOT_PAYING') {
      var rn = ev.payload || ev.detail || {};
      if (rn.reason === 'no_wix_read')
        return "A failed door-access grant was not retried — Wix couldn't be checked this sync. It's tried again once Wix shows the member as paying.";
      return "A failed door-access grant was not retried — the member isn't paying for " +
        (rn.reason === 'plan_not_paying' ? 'that plan' : 'a plan') + " in Wix right now. It's tried again once Wix shows them as paying.";
    }
    if (e === 'reconciliation.requeue_skipped_unreadable_payload' || e === 'RECONCILIATION_REQUEUE_SKIPPED_UNREADABLE_PAYLOAD')
      return "A failed job was not retried — its saved details couldn't be read, so AccessSync left it alone.";
    if (e === 'reconciliation.requeue_record_failed' || e === 'RECONCILIATION_REQUEUE_RECORD_FAILED')
      return "A failed job couldn't be re-checked during a sync — skipped; the rest of the sync carried on.";
    if (e === 'reconciliation.kill_switch_read_failed' || e === 'RECONCILIATION_KILL_SWITCH_READ_FAILED')
      return "Couldn't read the automatic-removal setting" + at + ' — removals are paused to be safe. Grants still run.';
    if (e === 'reconciliation.no_api_key' || e === 'RECONCILIATION_NO_API_KEY')
      return 'Reconcile skipped a location — no hardware API key configured.';
    if (e === 'reconciliation.lockdown_alert_failed' || e === 'RECONCILIATION_LOCKDOWN_ALERT_FAILED')
      return "Reconcile couldn't write a lockdown alert row.";
    if (e === 'reconciliation.no_error_entry' || e === 'RECONCILIATION_NO_ERROR_ENTRY')
      return 'Reconcile requeue skipped — no matching error_queue entry found.';
    if (e === 'reconciliation.payload_parse_failed' || e === 'RECONCILIATION_PAYLOAD_PARSE_FAILED')
      return "Reconcile couldn't parse the error_queue payload — requeue skipped.";
    if (e === 'reconciliation.requeued' || e === 'RECONCILIATION_REQUEUED')
      return 'Reconcile requeued a failed job for retry.';
    if (e === 'reconciliation.digest' || e === 'RECONCILIATION_DIGEST')
      return 'Reconcile assembled a per-client digest of config alerts + failed jobs.';
    if (e === 'reconciliation.digest_empty' || e === 'RECONCILIATION_DIGEST_EMPTY')
      return 'Reconcile digest empty — nothing to report.';
    if (e === 'reconciliation.digest_sent' || e === 'RECONCILIATION_DIGEST_SENT')
      return 'Reconcile digest email sent to operator.';
    if (e === 'reconciliation.digest_send_failed' || e === 'RECONCILIATION_DIGEST_SEND_FAILED')
      return 'Reconcile digest email failed to send.';
    if (e === 'reconciliation.no_notification_email' || e === 'RECONCILIATION_NO_NOTIFICATION_EMAIL')
      return 'Reconcile digest skipped — no notification_email configured.';
    if (e === 'reconciliation.fatal' || e === 'RECONCILIATION_FATAL')
      return 'Reconcile threw a fatal error at top level — investigate immediately.';

    // Short-prefix `reconcile.*` events (per-member reconcile + integrity alerts,
    // EVENT_REGISTRY.md lines 191-194).
    if (e === 'reconcile.member.start' || e === 'RECONCILE_MEMBER_START')
      return 'Per-member reconcile started for ' + who + at + '.';
    if (e === 'reconcile.member.complete' || e === 'RECONCILE_MEMBER_COMPLETE')
      return 'Per-member reconcile complete for ' + who + at + '.';
    if (e === 'reconcile.member.no_identity' || e === 'RECONCILE_MEMBER_NO_IDENTITY')
      return 'Per-member reconcile skipped — no identity record for ' + who + '.';
    if (e === 'reconcile.integrity.alert' || e === 'RECONCILE_INTEGRITY_ALERT')
      return 'Reconcile detected an integrity issue — alert written to config_alert_log.';

    // Operator + admin action events — Run #9 added these to EVENT_REGISTRY
    // persist list (2026-05-26). Cover the highest-value entries; remaining
    // low-frequency ones fall back to the default until needed.
    if (e === 'operator.sync.granted' || e === 'OPERATOR_SYNC_GRANTED') {
      var p = ev.payload || {};
      return 'Operator-triggered grant — member ' + (p.memberId || '?') +
        (p.hardwareGroupId ? ' on group ' + p.hardwareGroupId : '') +
        (p.reason ? ' (' + p.reason + ')' : '') + '.';
    }
    if (e === 'operator.sync.revoked' || e === 'OPERATOR_SYNC_REVOKED') {
      var pr = ev.payload || {};
      return 'Operator-triggered revoke — member ' + (pr.memberId || '?') +
        (pr.hardwareGroupId ? ' on group ' + pr.hardwareGroupId : '') +
        (pr.reason ? ' (' + pr.reason + ')' : '') + '.';
    }
    if (e === 'operator.sync.revoke_skipped' || e === 'OPERATOR_SYNC_REVOKE_SKIPPED')
      return 'Revoke skipped — another mapping still holds access for the same group.';
    if (e === 'operator.sync.manual_run' || e === 'OPERATOR_SYNC_MANUAL_RUN')
      return 'Operator triggered an ad-hoc sync run' + at + '.';
    if (e === 'operator.location.reactivated' || e === 'OPERATOR_LOCATION_REACTIVATED')
      return 'Operator reactivated a location' + at + ' — mapping fan-out complete.';
    if (e === 'operator.location.apikey_set' || e === 'OPERATOR_LOCATION_APIKEY_SET')
      return 'Operator saved a per-location hardware API key from the portal.';
    if (e === 'operator.retry.pending_hardware' || e === 'OPERATOR_RETRY_PENDING_HARDWARE')
      return 'Operator triggered retry of pending_hardware members' + at + '.';
    if (e === 'operator.apikey.rotated' || e === 'OPERATOR_APIKEY_ROTATED')
      return 'Operator rotated the client-level hardware API key' + at + '.';
    if (e === 'operator.notification.updated' || e === 'OPERATOR_NOTIFICATION_UPDATED')
      return 'Operator updated the notification email' + at + '.';
    if (e === 'operator.member.unlock' || e === 'OPERATOR_MEMBER_UNLOCK') {
      var mu = ev.payload && ev.payload.memberId;
      return 'Operator unlocked stuck in_flight lock for member ' + (mu || '?') +
        ' — flipped to recovery_pending for retry.';
    }
    if (e === 'operator.member_sync.run' || e === 'OPERATOR_MEMBER_SYNC_RUN')
      return 'Operator triggered per-member reconcile for ' + who + '.';
    if (e === 'operator.member.welcome_email_resent' || e === 'OPERATOR_MEMBER_WELCOME_EMAIL_RESENT')
      return 'Operator resent the welcome email to ' + who + '.';
    if (e === 'operator.setup.bypass_accepted' || e === 'OPERATOR_SETUP_BYPASS_ACCEPTED')
      return 'Operator bypass during onboarding accepted (owner PIN flow).';

    if (e === 'admin.api_key_set' || e === 'ADMIN_API_KEY_SET')
      return 'Hardware API key configured for client ' + (c.client || (ev.payload && (ev.payload.name || ev.payload.clientId)) || '?') + '.';
    if (e === 'admin.location_api_key_set' || e === 'ADMIN_LOCATION_API_KEY_SET')
      return 'Per-location hardware API key override saved' + at + '.';
    if (e === 'admin.location_created' || e === 'ADMIN_LOCATION_CREATED')
      return 'Owner created a new location' + at + '.';
    if (e === 'admin.location_activated' || e === 'ADMIN_LOCATION_ACTIVATED')
      return 'Owner activated a location' + at + '.';
    if (e === 'admin.location_reactivated' || e === 'ADMIN_LOCATION_REACTIVATED')
      return 'Owner reactivated a previously suspended location' + at + '.';
    if (e === 'admin.client_created' || e === 'ADMIN_CLIENT_CREATED')
      return 'Owner created a new client account from Admin Panel.';
    if (e === 'admin.client_archived' || e === 'ADMIN_CLIENT_ARCHIVED')
      return 'Owner archived client ' + (c.client || '') + ' (soft-delete).';
    if (e === 'admin.wix_instance_wired' || e === 'ADMIN_WIX_INSTANCE_WIRED')
      return 'Wix App signed-instance verified — platform_instance_id wired to client row.';
    if (e === 'admin.sub_member_grant_queued' || e === 'ADMIN_SUB_MEMBER_GRANT_QUEUED')
      return 'Sub-member draft promoted — grant job enqueued.';
    if (e === 'admin.sub_member_revoke_queued' || e === 'ADMIN_SUB_MEMBER_REVOKE_QUEUED')
      return 'Sub-member revoke job enqueued (entering removing state per DR-044).';
    if (e === 'admin.scheduler.reconcile_start' || e === 'ADMIN_SCHEDULER_RECONCILE_START')
      return 'In-process scheduler kicked off the nightly reconcile sweep.';
    if (e === 'admin.scheduler.reconcile_complete' || e === 'ADMIN_SCHEDULER_RECONCILE_COMPLETE')
      return 'In-process scheduler nightly reconcile finished cleanly.';
    if (e === 'admin.scheduler.reconcile_failed' || e === 'ADMIN_SCHEDULER_RECONCILE_FAILED')
      return 'In-process scheduler nightly reconcile threw — investigate.';

    // SQLSTATE fallback — when event itself is a 5-char Postgres code and we
    // had no inner event name to upgrade to, describe the class of failure
    // instead of dumping the raw code. Pulls extra context from detail.error
    // when available (the full Postgres error object).
    if (isSqlstate(ev.event)) {
      var msg = ev.detail && ev.detail.error && ev.detail.error.message;
      return describeSqlstate(ev.event) + (msg ? ' (' + msg + ')' : '');
    }

    // Fallback — surface the raw event name + flag missing translation
    return e + ' — (plain English not yet defined)';
  }

  // Event names that fire on every successful grant — informational breadcrumbs,
  // not actionable warnings. Render gray, not yellow. See standard-adapter.js
  // log.warn() calls that intentionally land in diagnostic_log for trace continuity.
  var LIFECYCLE_INFO_EVENTS = {
    'adapter.resolve_and_lock.committed':         true,
    'adapter.resolve_and_lock.post_commit_verify': true,
    'adapter.complete_grant.entry':               true,
    'adapter.complete_grant.lookup':              true,
    'ADAPTER_RESOLVE_AND_LOCK_COMMITTED':         true,
    'ADAPTER_RESOLVE_AND_LOCK_POST_COMMIT_VERIFY': true,
    'ADAPTER_COMPLETE_GRANT_ENTRY':               true,
    'ADAPTER_COMPLETE_GRANT_LOOKUP':              true,
  };

  // Events that signal a happy end-state — render green. Currently the
  // member_access_log "provisioned"/"granted" rows, which only INSERT when a
  // real hardware call landed (DR-034 / OB-48), plus the closing
  // queue.grant.complete event that lands after status flips to active, and
  // the Kisi recovery-succeeded event that closes the idempotent 409 path.
  var SUCCESS_EVENTS = {
    'provisioned':                  true,
    'granted':                      true,
    'reactivated':                  true,
    'queue.grant.complete':         true,
    'QUEUE_GRANT_COMPLETE':         true,
    'kisi.role.recovery_succeeded': true,
    'KISI_ROLE_RECOVERY_SUCCEEDED': true,
  };

  /** Map a v_trace_timeline result column to a normalized severity bucket. */
  function severityOf(ev) {
    var e = (ev && ev.event) || '';
    if (SUCCESS_EVENTS[e]) return 'success';
    var r = (ev && ev.result || '').toLowerCase();
    if (r === 'error' || r === 'failed' || r === 'rejected' || r === 'critical') return 'error';
    // Lifecycle breadcrumbs were logged at warn-level for DB persistence, but
    // they are not actionable warnings. Demote to info so the UI shows them gray.
    if (LIFECYCLE_INFO_EVENTS[e]) return 'info';
    if (r === 'warn'  || r === 'warning' || r === 'open')                          return 'warn';
    return 'info';
  }

  /** Pretty source labels for the seven log sources. */
  var SOURCE_LABELS = {
    activity:      { short: 'activity',    plain: 'Operator activity', color: '#4F6EF7' },
    webhook:       { short: 'webhook',     plain: 'Wix webhook',       color: '#8B5CF6' },
    member_access: { short: 'member',      plain: 'Member access',     color: '#4ADE80' },
    error_queue:   { short: 'errors',      plain: 'Job queue',         color: '#FF4D6A' },
    diagnostic:    { short: 'diagnostic',  plain: 'Diagnostics',       color: '#F5A623' },
    admin_audit:   { short: 'admin',       plain: 'Config history',    color: '#06B6D4' },
    config_alert:  { short: 'alerts',      plain: 'Alerts',            color: '#EC4899' },
  };

  // ── Intent — one-line "what actually happened" summary for a trace group ──
  // Trace Timeline groups by trace_id but the header only ever showed WHO
  // (client/member), never WHAT (new signup vs. renewal vs. cancellation vs.
  // failure) — an operator had to expand the group and read every row to
  // find out. deriveIntent() picks the single most operationally meaningful
  // signal out of a trace's own events; no new columns, no migration — every
  // field read here is already returned by GET /admin/logs/trace/:trace_id
  // and GET /admin/logs/events (v_trace_timeline).
  //
  // Rule order matters: most specific / most actionable wins. A trace with
  // both a grant AND a later cancellation (e.g. a fast opt-out) should read
  // "Plan cancelled", not "New signup" — so cancellation/failure rules run
  // before the grant rule.
  var MEMBER_ACCESS_CANCEL_EVENTS = {
    cancelled_by_member: true, cancelled_expired: true,
    cancelled_booking:   true, cancelled_by_system: true,
  };

  function findEvent(events, source, names) {
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (source && e.source !== source) continue;
      if (names[e.event]) return e;
    }
    return null;
  }

  /**
   * @param {Array} events — one trace group's events (any order)
   * @returns {{label: string, tone: 'success'|'warn'|'error'|'info'}|null}
   *   null when nothing in the taxonomy matches — caller falls back to its
   *   existing "first event, humanized" behavior rather than showing a
   *   guessed label.
   */
  function deriveIntent(events) {
    if (!events || !events.length) return null;

    // Manual sync (Overview page "Sync" buttons, all of which hit the same
    // POST /operator/sync/run — admin/routes/operator.js) writes two rows in
    // the same request: an `operator.sync.manual_run` diagnostic and a
    // `client.synced` activity event. Both are independent fire-and-forget
    // INSERTs with no explicit timestamp, so which one lands first in
    // Postgres is a few-ms race — the OLD header (picking "first event,
    // humanized") flipped between two different-looking labels for the
    // exact same button click. One fixed label regardless of race outcome.
    if (findEvent(events, 'diagnostic', { 'operator.sync.manual_run': true })
        || findEvent(events, 'activity', { 'client.synced': true }))
      return { label: 'Manual sync', tone: 'info' };

    if (findEvent(events, 'webhook', { 'payment.failed': true }))
      return { label: 'Payment failed', tone: 'error' };

    if (findEvent(events, 'member_access', { revoked: true, deleted: true }))
      return { label: 'Access revoked', tone: 'error' };

    if (findEvent(events, 'member_access', { disabled: true }))
      return { label: 'Access suspended', tone: 'warn' };

    if (findEvent(events, 'webhook', { 'payment.recovered': true }))
      return { label: 'Payment recovered', tone: 'success' };

    if (findEvent(events, 'webhook', { 'plan.cancelled': true, 'booking.cancelled': true })
        || findEvent(events, 'member_access', MEMBER_ACCESS_CANCEL_EVENTS))
      return { label: 'Plan cancelled', tone: 'warn' };

    if (findEvent(events, 'diagnostic', {
          'admin.sub_member_removed': true, 'admin.sub_member_revoke_queued': true,
          'admin.sub_member_deleted': true,
        }))
      return { label: 'Sub-member removed', tone: 'warn' };

    if (findEvent(events, 'diagnostic', { 'admin.holder_release_slot_queued': true }))
      return { label: 'Seat released', tone: 'warn' };

    if (findEvent(events, 'diagnostic', {
          'admin.sub_member_added': true, 'admin.sub_members_submitted': true,
          'admin.sub_member_grant_queued': true,
        }))
      return { label: 'Sub-member added', tone: 'success' };

    if (findEvent(events, 'diagnostic', { 'admin.holder_claim_slot_queued': true }))
      return { label: 'Seat claimed', tone: 'success' };

    if (findEvent(events, 'webhook', { 'plan.purchased': true, 'booking.confirmed': true })) {
      // cycleIndex/isRenewal (added on queue.grant.complete / adapter.complete_grant.entry,
      // see core/queue-worker.js + adapters/standard-adapter.js) lives in the diagnostic
      // row's `detail` jsonb, not a first-class column — scan for it.
      var grantDiag = null;
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        if (e.source === 'diagnostic' && e.detail && typeof e.detail.isRenewal === 'boolean') {
          grantDiag = e;
          break;
        }
      }
      if (grantDiag && grantDiag.detail.isRenewal === true)
        return { label: 'Recurring renewal', tone: 'info' };
      return { label: 'New signup', tone: 'success' };
    }

    return null;
  }

  window.AccessSyncHumanize = {
    humanize: humanize,
    severityOf: severityOf,
    deriveIntent: deriveIntent,
    SOURCE_LABELS: SOURCE_LABELS,
  };
})();
