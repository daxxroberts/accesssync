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
    if (e === 'plan.unpaid_order')
      return 'An unpaid Wix order arrived' + onPlan + ' — dropped, no access granted.';
    if (e === 'booking.confirmed') return who + ' confirmed a booking' + at + '.';
    if (e === 'booking.cancelled') return who + "'s booking was cancelled" + at + '.';
    if (e === 'member.deleted')    return who + ' was deleted from Wix' + at + '.';

    // Member-access events
    if (e === 'provisioned' || e === 'granted')   return 'Set up access for ' + who + door + '.';
    if (e === 'disabled')                         return 'Suspended access for ' + who + door + ' (payment failed or paused).';
    if (e === 'revoked')                          return 'Removed access for ' + who + door + '.';
    if (e === 'deleted')                          return "Deleted " + who + "'s hardware user.";
    if (e === 'location_suspended')               return 'Suspended ' + who + ' (location subscription lapsed).';
    if (e === 'reactivated')                      return 'Restored access for ' + who + door + '.';

    // Diagnostic events
    if (e === 'IN_FLIGHT_LOCK')                   return 'Concurrent change rejected — already processing ' + who + '.';
    if (e === 'ADAPTER_IDENTITY_GATE2_RECOVERY_TRIGGERED') return 'Webhook arrived without an email — recovering from Wix.';
    if (e === 'DB_SLOW_QUERY')                    return 'A database query took longer than the threshold.';
    if (e === 'ADAPTER_NO_IDENTITY')              return 'Revoke skipped — no identity record for this member.';
    if (e === 'QUEUE_REVOKE_NO_IDENTITY')         return 'Cancel arrived for a member we never provisioned.';
    if (e.indexOf('grant.') === 0)                return 'Grant step: ' + e.replace('grant.', '').replace(/_/g, ' ') + '.';
    if (e.indexOf('revoke.') === 0)               return 'Revoke step: ' + e.replace('revoke.', '').replace(/_/g, ' ') + '.';
    if (e.indexOf('hmac.') === 0)                 return 'Webhook signature: ' + e.replace('hmac.', '').replace(/_/g, ' ') + '.';

    // Alerts
    if (e === 'no_mapping_found' || e === 'missing_group')
      return 'Plan "' + (c.plan || 'unknown') + "\" isn't mapped to a hardware group" + at + '.';
    if (e === 'group_not_found')                  return 'Hardware group missing — the door it points to no longer exists' + at + '.';
    if (e === 'untraceable_hardware_access')      return who + ' has door access but no plan or booking justifies it' + at + '.';
    if (e === 'wix_api_unavailable')              return "Wix API didn't respond during reconciliation" + at + '.';
    if (e === 'lockdown_detected')                return 'A door is currently in lockdown' + at + '.';
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
    if (e === 'error.retried')          return (who || 'An operator') + ' retried a failed job' + at + '.';
    if (e === 'client_deleted')         return (who || 'An owner') + ' deleted client ' + (c.client || '') + '.';
    if (e === 'sub_member.revoke_queued')
      return (who || 'A plan holder') + ' removed a sub-member' + onPlan + at + '.';
    if (e === 'sub_member.grant_queued')
      return (who || 'A plan holder') + ' added a sub-member' + onPlan + at + '.';
    if (e === 'holder.claim_slot_queued')
      return (who || 'A plan holder') + ' claimed their own access slot' + onPlan + at + '.';
    if (e === 'holder.release_slot_queued')
      return (who || 'A plan holder') + ' released their access slot' + onPlan + at + '.';
    if (e === 'sub_member_soft_deleted')
      return 'Sub-member record finalized — personal info purged, audit row preserved.';
    if (e === 'member.sub_member.soft_deleted')
      return 'Sub-member soft-deleted — DB record kept as audit shell, PII purged.';
    if (e === 'member.sub_member.soft_delete_idempotent_skip')
      return 'Soft-delete already done — no-op (race or replay).';

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

  /** Map a v_trace_timeline result column to a normalized severity bucket. */
  function severityOf(ev) {
    var r = (ev && ev.result || '').toLowerCase();
    if (r === 'error' || r === 'failed' || r === 'rejected' || r === 'critical') return 'error';
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

  window.AccessSyncHumanize = {
    humanize: humanize,
    severityOf: severityOf,
    SOURCE_LABELS: SOURCE_LABELS,
  };
})();
