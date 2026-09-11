/**
 * @file event-routing.js
 * @layer core/layer4
 * @role pure-constants
 * @reads none
 * @writes none
 * @exports GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES, jobNameForEventType
 *
 * event-routing.js
 * Core Engine (Layer 4)
 *
 * The single answer to "is this standard event a grant or a revoke?"
 *
 * Every place that turns an event type into a 'grant' or 'revoke' BullMQ job
 * must route through here. Before this module existed the lists were copied
 * inline, and the copies drifted:
 *
 *   webhook-processor.js   grant = plan.purchased, plan.started,
 *                                  payment.recovered, booking.confirmed
 *   reconciliation.js      grant = plan.purchased,
 *   (_processRecordTargeted)       payment.recovered, booking.confirmed
 *                          revoke = EVERYTHING ELSE
 *
 * The reconciliation copy was missing plan.started and defaulted anything it
 * did not recognise to 'revoke'. So a member whose deferred-start grant
 * crashed mid-flight (stale lock → recovery_pending) had the failed
 * plan.started replayed by the sweep as a REVOKE — on the very day their
 * access was supposed to begin. Found 2026-09-10 during the reconciliation
 * safety pass.
 *
 * The rule is now: an event type is a grant, a revoke, or neither. "Neither"
 * is never silently promoted to a revoke — callers skip it.
 */

const GRANT_EVENT_TYPES = Object.freeze([
  'plan.purchased',
  'plan.started',      // phase 2 of a delayed-start grant — Wix orderStarted
  'payment.recovered',
  'booking.confirmed',
]);

const REVOKE_EVENT_TYPES = Object.freeze([
  'plan.cancelled',
  'payment.failed',
  'booking.cancelled',
  'member.deleted',
]);

/**
 * @param {string} eventType  standard event type, e.g. 'plan.purchased'
 * @returns {'grant'|'revoke'|null}  null for any type that is neither —
 *   callers must skip it, never default it to a revoke.
 */
function jobNameForEventType(eventType) {
  if (GRANT_EVENT_TYPES.includes(eventType)) return 'grant';
  if (REVOKE_EVENT_TYPES.includes(eventType)) return 'revoke';
  return null;
}

module.exports = { GRANT_EVENT_TYPES, REVOKE_EVENT_TYPES, jobNameForEventType };
