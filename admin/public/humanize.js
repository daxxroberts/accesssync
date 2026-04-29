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

  /**
   * Translate one event row into a Plain-English sentence.
   * @param {Object} ev — must have .event; may have .member_name, .member_email,
   *   .client_name, .plan_name, .door_name, .actor_id, .payload
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
    var e = ev.event || '';

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
