/**
 * @file wix-order-classification.js
 * @layer core/layer4
 * @role pure-constants
 * @reads none
 * @writes none
 * @exports PAYING_PAYMENT_STATUSES, ORDER_CLASS, isPayingOrder, classifyOrder
 *
 * wix-order-classification.js
 * Core Engine (Layer 4)
 *
 * The single answer to "is this Wix pricing-plan order paying?"
 *
 * Two places need that answer and must never disagree:
 *   - adapters/wix/wix-adapter.js   the webhook payment guard (parseEvent)
 *   - core/reconciliation.js        the nightly sweep, via
 *                                   wix-plans-api.listOrdersClassified()
 *
 * Before this module the paying rule lived inline in wix-adapter.js as
 * ALLOWED_PAYMENT. The sweep had no equivalent — it treated every ACTIVE order
 * as a paying member, including ACTIVE orders whose payment was still UNPAID.
 *
 * Pure: no I/O, no clock, no logger. Plain data in, plain data out.
 *
 * Classification of a raw Wix order (REST list shape or webhook entity):
 *   ACTIVE + lastPaymentStatus in PAYING_PAYMENT_STATUSES       → PAYING
 *   ACTIVE + lastPaymentStatus UNPAID | PENDING                 → PENDING
 *   status DRAFT | PENDING                                      → PENDING
 *   status PAUSED                                               → DECLINED
 *   ACTIVE + lastPaymentStatus FAILED | REFUNDED                → DECLINED
 *   status ENDED | CANCELED | CANCELLED | EXPIRED               → ENDED
 *   anything else (missing status, NOT_APPLICABLE, UNDEFINED…)  → UNKNOWN
 *
 * UNKNOWN is deliberately inert: the sweep never grants on it and never
 * removes on it. ACTIVE + NOT_APPLICABLE lands here on purpose — the webhook
 * guard already refuses it, so the sweep must not be looser than the webhook.
 * (Open question for the Builder: Wix may use NOT_APPLICABLE for free plans.
 * Flagged, not decided here.)
 *
 * Status values are matched exactly (Wix sends them uppercase). A value this
 * module has never seen is UNKNOWN, never PAYING and never ENDED.
 */

'use strict';

// Moved verbatim from wix-adapter.js ALLOWED_PAYMENT.
// null = lastPaymentStatus not yet set (free plans with no payment record).
const PAYING_PAYMENT_STATUSES = Object.freeze(['PAID', 'TRIAL', null]);

const ORDER_CLASS = Object.freeze({
  PAYING:   'PAYING',
  PENDING:  'PENDING',
  DECLINED: 'DECLINED',
  ENDED:    'ENDED',
  UNKNOWN:  'UNKNOWN',
});

const PENDING_PAYMENT_STATUSES  = Object.freeze(['UNPAID', 'PENDING']);
const DECLINED_PAYMENT_STATUSES = Object.freeze(['FAILED', 'REFUNDED']);
const PENDING_ORDER_STATUSES    = Object.freeze(['DRAFT', 'PENDING']);
const ENDED_ORDER_STATUSES      = Object.freeze(['ENDED', 'CANCELED', 'CANCELLED', 'EXPIRED']);

/**
 * @param {Object} order  raw Wix order
 * @returns {boolean} true only for status ACTIVE with a paying payment status
 */
function isPayingOrder(order) {
  if (!order || typeof order !== 'object') return false;
  return order.status === 'ACTIVE'
    && PAYING_PAYMENT_STATUSES.includes(order.lastPaymentStatus ?? null);
}

/**
 * @param {Object} order  raw Wix order
 * @returns {string} one of ORDER_CLASS
 */
function classifyOrder(order) {
  if (!order || typeof order !== 'object') return ORDER_CLASS.UNKNOWN;

  const status        = order.status;
  const paymentStatus = order.lastPaymentStatus ?? null;

  if (status === 'ACTIVE') {
    if (PAYING_PAYMENT_STATUSES.includes(paymentStatus))   return ORDER_CLASS.PAYING;
    if (PENDING_PAYMENT_STATUSES.includes(paymentStatus))  return ORDER_CLASS.PENDING;
    if (DECLINED_PAYMENT_STATUSES.includes(paymentStatus)) return ORDER_CLASS.DECLINED;
    return ORDER_CLASS.UNKNOWN; // e.g. NOT_APPLICABLE, UNDEFINED, '' — inert by design
  }
  if (PENDING_ORDER_STATUSES.includes(status)) return ORDER_CLASS.PENDING;
  if (status === 'PAUSED')                     return ORDER_CLASS.DECLINED;
  if (ENDED_ORDER_STATUSES.includes(status))   return ORDER_CLASS.ENDED;
  return ORDER_CLASS.UNKNOWN;
}

module.exports = { PAYING_PAYMENT_STATUSES, ORDER_CLASS, isPayingOrder, classifyOrder };
