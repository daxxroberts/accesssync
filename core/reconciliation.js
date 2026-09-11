/**
 * @file reconciliation.js
 * @layer core/layer4
 * @role cron-nightly
 * @schedule nightly via Railway Cron
 * @reads member_access, member_master, error_queue, locations, clients (source_api_key, source_site_id, reconciliation_interval, last_sync_at, auto_revoke_mode), member_access_sources (incl. the not_paying_* strike clock), plan_mappings, config_alert_log (alert dedupe)
 * @writes member_access, config_alert_log, clients (last_sync_at), reconciliation_run, reconciliation_proposal
 * @calls hardware-adapter (getLocks, getManagedRoleAssignments, listAllUsers), wix-plans-api (listOrdersClassified, listConfirmedBookings, listActiveOrders), plan-mapping-resolver (resolve), revoke-policy (evaluateRemovals, normalizeMode), standard-adapter (recordNotPayingObservation, clearNotPayingObservation), event-routing (jobNameForEventType), db (getClient — per-client advisory lock), BullMQ (re-queue), resend (digest)
 * @exports instance (NightlyReconciliation) — exposes runNightlySweep, _syncClient, reconcileMember
 * @dr DR-003, DR-008, DR-018, DR-020, DR-023, DR-034, DR-037
 *
 * reconciliation.js
 * Core Engine (Layer 4) - Standalone script triggered by cron
 *
 * Responsibilities:
 * - Sweeps for jobs with status IN ('failed', 'skipped_lockdown')
 * - Ensures jobs are tagged source_tag = 'accesssync' (DR-003)
 * - Checks physical door lockdown state via Kisi GET /locks
 * - Re-queues eligible jobs to BullMQ (NOT direct grant-revoke — respects in_flight lock)
 * - Packages unresolved errors into a nightly digest (Resend, DR-020)
 */

const crypto = require('crypto');
const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const standardAdapter = require('../adapters/standard-adapter');
const { eventQueue } = require('./webhook-processor');
const { decryptApiKey } = require('./crypto-utils');
const { listActiveOrders, listConfirmedBookings, listOrdersClassified } = require('../adapters/wix/wix-plans-api');
const { extractBillingSnapshot } = require('./billing-snapshot');
const planMappingResolver = require('./plan-mapping-resolver');
const { log, withTrace } = require('./logger');
const { runWith, mintTraceId, getTraceId, getActor } = require('./trace-context');
const { sendOperatorEmail } = require('./operator-mailer');
const { renderNightlyDigest } = require('./operator-email-templates');
const {
  REVOKE_SOURCE, DATA_SOURCE, REVOKE_MODE, REVOKE_HOLD_REASON, ANOMALY_HOLD_REASONS,
  DEFAULT_STRIKE_POLICY, REMOVABLE_CLASSIFICATIONS, normalizeMode, evaluateRemovals,
} = require('./revoke-policy');
const { ORDER_CLASS } = require('./wix-order-classification');
const { jobNameForEventType } = require('./event-routing');

// ── Phase 1 ("stop the bleeding", 2026-09-10): the sweep is OBSERVATION-ONLY ──
// Every removal path in _syncClient records what it would do and holds it.
// Nothing the sweep does can enqueue a revoke: there is no flush loop, and
// _enqueueApprovedRevoke refuses while this is true. Phase 3b flips it — and
// flipping it alone arms nothing; 3b must also add the flush back.
const SWEEP_OBSERVATION_ONLY = true;

// config_alert_log.alert_type raised when the removal policy holds a batch
// because the data looks wrong (as opposed to an operator mode or Phase 1's
// observation-only hold). Anything unmapped falls back to `revoke_<reason>`.
const ANOMALY_ALERT_TYPE = Object.freeze({
  [REVOKE_HOLD_REASON.INVALID_PROPOSAL]:  'revoke_invalid_proposal',
  [REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE]: 'wix_snapshot_anomaly',     // same type the old gate raised
  [REVOKE_HOLD_REASON.MASS_REVOKE]:       'revoke_batch_mass_revoke',
});

// Sweep alert types (copy: core/operator-email-templates.js describeConfigAlert).
const SWEEP_ALERT = Object.freeze({
  REPAIR_PENDING:       'sweep_repair_pending',        // paying member, door missing in Kisi
  REMOVAL_PENDING:      'sweep_removal_pending',       // 3B — no longer paying in Wix
  HOLDER_LAPSE_PENDING: 'revoke_holder_lapse_pending', // Pass 1.5 — holder no longer paying for the sub's plan
  HELD_PAYMENT_STATE:   'revoke_held_payment_state',   // 3B / Pass 1.5 — payment declined, pending or unrecognised: left alone
});

// reconciliation_proposal.kind
const PROPOSAL_KIND = Object.freeze({
  REMOVAL_PENDING:    'removal_pending',
  REPAIR_PENDING:     'repair_pending',
  HELD_PAYMENT_STATE: 'held_payment_state',
});

// reconciliation_proposal.hold_reason for held_payment_state rows. Not a
// removal-policy reason: these (member, plan) pairs never reach the policy.
const HELD_PAYMENT_STATE_REASON = 'payment_state_not_removable';

// Per-member removal alerts (sweep_removal_pending, revoke_holder_lapse_pending,
// revoke_held_payment_state) are suppressed only when the batch is held because
// the evidence itself cannot be trusted: the two Wix reads disagreed too much,
// or the batch was malformed. A MASS_REVOKE hold is about volume — each
// member's evidence still stands, so their alerts are kept (fix round F9).
const PER_MEMBER_ALERT_SUPPRESSING_REASONS = Object.freeze([
  REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE,
  REVOKE_HOLD_REASON.INVALID_PROPOSAL,
]);

// member_access_sources.source_type → the Wix read that says whether it pays.
// Any other value (including NULL) is not Wix-derived and is never a sweep
// removal candidate. Null-prototype: a DB value can never hit an inherited key.
const SOURCE_TYPE_DATA_SOURCE = Object.freeze(Object.assign(Object.create(null), {
  plan:    DATA_SOURCE.WIX_ORDERS,
  booking: DATA_SOURCE.WIX_BOOKINGS,
}));

// "Best" classification per (member, plan) across both reads: the most alive
// state wins, so one read showing PAYING beats the other showing ENDED.
const CLASS_RANK = Object.freeze(Object.assign(Object.create(null), {
  [ORDER_CLASS.PAYING]:   5,
  [ORDER_CLASS.PENDING]:  4,
  [ORDER_CLASS.DECLINED]: 3,
  [ORDER_CLASS.UNKNOWN]:  2,
  [ORDER_CLASS.ENDED]:    1,
}));
// Neither read had any order or booking for this (member, plan).
const CLASS_ABSENT = 'ABSENT';

// Only an ENDED order, or no order or booking at all (ABSENT), may ever back a
// Wix-sourced removal proposal — the policy's own list (P-2), so the two can
// never disagree.
function isRemovableClass(cls) {
  return typeof cls === 'string' && REMOVABLE_CLASSIFICATIONS.includes(cls);
}

// DECLINED / PENDING / UNKNOWN — or any value the sweep does not recognise.
// A payment that is declined, pending or unrecognised is not a cancellation:
// such a (member, plan) is recorded as held_payment_state, never proposed for
// removal, and not counted in any Wix removal population (fix round F2).
// Suspension is Phase 4's job.
function isHeldPaymentClass(cls) {
  return cls !== ORDER_CLASS.PAYING && !isRemovableClass(cls);
}

// The decision unit a member belongs to (P-1): a sub-member belongs to its
// holder's family, keyed by the holder's platform_member_id; everyone else is
// their own unit. A sub whose holder cannot be resolved is its own unit.
function unitKeyOf(memberKey, holderKey) {
  return holderKey || memberKey;
}

const ALERT_REF_MAX_LEN     = 255; // config_alert_log.hardware_ref is varchar(255)
const PROPOSAL_INSERT_CHUNK = 500; // rows per INSERT; one statement per sweep in practice

function countBySource(proposals) {
  const counts = {};
  for (const p of proposals) counts[p.source] = (counts[p.source] || 0) + 1;
  return counts;
}

function countByDataSource(proposals) {
  const counts = {};
  for (const p of proposals) counts[p.dataSource] = (counts[p.dataSource] || 0) + 1;
  return counts;
}

function countByClassification(records) {
  const counts = {};
  for (const r of records) counts[r.classification] = (counts[r.classification] || 0) + 1;
  return counts;
}

// The unit a proposal is counted in — the same rule as revoke-policy's own
// (an absent unitKey means the member's own unit).
function proposalUnit(p) {
  return p.unitKey === undefined ? p.memberKey : p.unitKey;
}

// Collision-free composite Map key for (member|access id, plan id).
function memberPlanKey(a, b) {
  return JSON.stringify([a, b]);
}

function alertRef(value) {
  return String(value === null || value === undefined ? '' : value).slice(0, ALERT_REF_MAX_LEN);
}

// A strike clock's `since`, as the removal policy expects it (P-3). A Date
// becomes its ISO instant. A string is passed through UNCHANGED for the policy
// to judge strictly — never through Date.parse, which reads '12' or '1/1' as a
// date decades ago and would launder it into a valid-looking, long-ripe clock.
// (pg returns timestamptz as a Date, so a string here is already unusual; a
// malformed one holds the batch as invalid_strike_since.)
function toIsoOrNull(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  if (typeof v === 'string' && v !== '') return v;
  return null;
}

function holdReasonForMode(mode) {
  return mode === REVOKE_MODE.DRY_RUN ? REVOKE_HOLD_REASON.DRY_RUN : REVOKE_HOLD_REASON.AUTO_REVOKE_OFF;
}

function symmetricDifferenceSize(a, b) {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}

/**
 * Folds the sweep's two Wix reads into one view of who is paying. Pure.
 *
 * @param {Array<{orders: Array, bookings: Array}>} reads  exactly two reads;
 *   orders from listOrdersClassified, bookings from listConfirmedBookings
 * @returns {{
 *   wixMembers: Map<string, {plans: Array<{planId, sourceType, rawOrder}>, email, name}>,
 *   payingPlansByMember: Map<string, Set<string>>,
 *   bestClass: Map<string, string>,
 *   payingInRead: Array<Set<string>>,
 *   readDisagreement: Object<string, number>,
 * }}
 *
 * PAYING = PAYING in EITHER read (Builder rule 5, the union):
 *   orders   — classification === 'PAYING' (core/wix-order-classification.js)
 *   bookings — present in the CONFIRMED list
 * wixMembers carries ONLY paying members and ONLY their paying plans: an
 * ACTIVE order whose payment is UNPAID / PENDING / FAILED is never a plan the
 * sweep grants or promotes. readDisagreement counts, per data source, the
 * members whose paying status differed between the two reads.
 *
 * readDisagreement is already a count of UNITS (P-1): every id here is the
 * Wix member on an order or booking — a primary member or a plan holder,
 * never a sub-member (subs carry AccessSync-minted `###as` ids and never
 * appear in Wix). A family whose holder's paying status flips between the
 * reads therefore counts once, whatever its number of subs.
 */
function buildWixPayingView(reads) {
  const wixMembers          = new Map();
  const payingPlansByMember = new Map();
  const bestClass           = new Map();
  const payingPerRead       = reads.map(() => ({ orders: new Set(), bookings: new Set() }));

  const noteClass = (memberId, planId, cls) => {
    if (!planId) return;
    const k = memberPlanKey(memberId, planId);
    const prev = bestClass.get(k);
    if (!prev || (CLASS_RANK[cls] || 0) > (CLASS_RANK[prev] || 0)) bestClass.set(k, cls);
  };

  // A member may hold MULTIPLE plans at once (OB-185 hotfix, 2026-05-18): one
  // entry per member, plans de-duplicated on planId. Orders go first, so the
  // first PAYING order for a plan supplies its rawOrder (OB-187 billing backfill).
  const addPaying = (memberId, planId, sourceType, email, name, rawOrder) => {
    let entry = wixMembers.get(memberId);
    if (!entry) {
      entry = { plans: [], email: email || null, name: name || null };
      wixMembers.set(memberId, entry);
    }
    let plans = payingPlansByMember.get(memberId);
    if (!plans) {
      plans = new Set();
      payingPlansByMember.set(memberId, plans);
    }
    if (planId && !plans.has(planId)) {
      plans.add(planId);
      entry.plans.push({ planId, sourceType, rawOrder: rawOrder || null });
    }
    if (!entry.email && email) entry.email = email;
    if (!entry.name && name)   entry.name  = name;
  };

  reads.forEach((read, i) => {
    for (const o of read.orders) {
      if (!o || !o.memberId) continue;
      const cls = CLASS_RANK[o.classification] ? o.classification : ORDER_CLASS.UNKNOWN;
      noteClass(o.memberId, o.planId, cls);
      if (cls !== ORDER_CLASS.PAYING) continue;
      payingPerRead[i].orders.add(o.memberId);
      addPaying(o.memberId, o.planId || null, 'plan', null, null, o.rawOrder);
    }
  });
  reads.forEach((read, i) => {
    for (const b of read.bookings) {
      if (!b || !b.memberId) continue;
      noteClass(b.memberId, b.planId, ORDER_CLASS.PAYING);
      payingPerRead[i].bookings.add(b.memberId);
      addPaying(b.memberId, b.planId || null, 'booking', b.email, b.name, null);
    }
  });

  const payingInRead = payingPerRead.map(r => new Set([...r.orders, ...r.bookings]));
  const readDisagreement = {
    [DATA_SOURCE.WIX_ORDERS]:   symmetricDifferenceSize(payingPerRead[0].orders,   payingPerRead[1].orders),
    [DATA_SOURCE.WIX_BOOKINGS]: symmetricDifferenceSize(payingPerRead[0].bookings, payingPerRead[1].bookings),
  };

  return { wixMembers, payingPlansByMember, bestClass, payingInRead, readDisagreement };
}

class NightlyReconciliation {

  constructor() {
    this.staleThresholdMinutes = 10;
    // The sweep reads Wix twice, this far apart, and treats a member as paying
    // if EITHER read says so (Builder rule 5). Tests set 0.
    this._doubleReadDelayMs = 15000;
  }

  /**
   * Automatic-removal mode — clients.auto_revoke_mode ('off' | 'dry_run' | 'on').
   *
   * Own try/catch, fail-closed: normalizeMode() turns anything but exactly
   * 'dry_run' or 'on' — a NULL, a failed read, a column that does not exist
   * yet because migrations/reconcile-auto-revoke-kill-switch.sql is not
   * applied — into 'off'. Grants and the reconciliation_run audit row are
   * never affected by it. (The event keeps its kill-switch name for
   * continuity: it is the same switch.)
   *
   * Phase 1: the sweep is observation-only in every mode. The mode gates the
   * DR-051 seat self-heal and reconcileMember's per-member revoke, and is
   * recorded with every proposal.
   *
   * @param {string} clientId
   * @returns {Promise<'off'|'dry_run'|'on'>}
   */
  async _readAutoRevokeMode(clientId) {
    try {
      const r = await db.query(`SELECT auto_revoke_mode FROM clients WHERE id = $1`, [clientId]);
      return normalizeMode(r && r.rows && r.rows[0] ? r.rows[0].auto_revoke_mode : undefined);
    } catch (err) {
      log.error('reconciliation.kill_switch_read_failed', { clientId }, err);
      return REVOKE_MODE.OFF;
    }
  }

  /**
   * Per-client Postgres advisory lock, so two sweeps of the same client can
   * never overlap (the boot sweep, the Railway cron, the in-process scheduler
   * and the manual /sync/run can all start one).
   *
   * Session-level advisory locks belong to a CONNECTION, and db.query() runs on
   * a pool — the lock and the unlock could land on different connections. So
   * the lock is taken on a dedicated connection from db.getClient(), held for
   * the whole sync, unlocked on that same connection and then released. (The
   * live DATABASE_URL is the Supabase SESSION-mode pooler, where this holds; the
   * transaction-mode pooler would not keep a session lock.)
   *
   * @returns {Promise<{state: 'acquired', conn: Object} | {state: 'held_elsewhere'} | {state: 'unavailable'}>}
   *   held_elsewhere — another sweep holds it: the caller must skip.
   *   unavailable    — the lock MECHANISM failed (getClient missing or
   *                    throwing, the query throwing or answering nonsense).
   *                    Phase 1 proceeds without the lock: the sweep enqueues no
   *                    removals, so an overlap is harmless, while skipping
   *                    would also skip that client's grants.
   */
  async _acquireClientLock(clientId) {
    let conn = null;
    try {
      if (typeof db.getClient !== 'function') throw new Error('db.getClient is not available');
      conn = await db.getClient();
      if (!conn || typeof conn.query !== 'function') throw new Error('db.getClient returned no usable connection');
      const r = await conn.query(
        `SELECT pg_try_advisory_lock(hashtext('reconcile:' || $1::text)) AS locked`,
        [String(clientId)]
      );
      const locked = r && r.rows && r.rows[0] ? r.rows[0].locked : undefined;
      if (locked === true) return { state: 'acquired', conn };
      if (locked === false) {
        // Held by another sweep. This session holds nothing — hand it back.
        conn.release();
        return { state: 'held_elsewhere' };
      }
      throw new Error('pg_try_advisory_lock returned no boolean');
    } catch (err) {
      // Destroy rather than pool the connection: if the lock query failed
      // mid-flight this session might still hold the lock, and a pooled
      // connection could keep it indefinitely. Closing the session frees it.
      if (conn && typeof conn.release === 'function') {
        try { conn.release(true); } catch (_) { /* already gone */ }
      }
      log.warn('reconciliation.client_lock_unavailable', {
        clientId, errorCode: (err && err.code) || null, traceId: this._sweepTraceId || null,
      }, err);
      // 3b: fail closed here — once the sweep can remove access, a sweep that
      // cannot take the lock must skip (like held_elsewhere), not proceed.
      return { state: 'unavailable' };
    }
  }

  /**
   * Releases a lock taken by _acquireClientLock on the SAME connection. Never
   * throws. If the unlock fails or reports nothing was held, the connection is
   * destroyed (release(true)) instead of pooled — ending the session is what
   * guarantees Postgres drops the lock.
   */
  async _releaseClientLock(lock, clientId) {
    if (!lock || lock.state !== 'acquired' || !lock.conn) return;
    let destroy = false;
    try {
      const r = await lock.conn.query(
        `SELECT pg_advisory_unlock(hashtext('reconcile:' || $1::text)) AS unlocked`,
        [String(clientId)]
      );
      if (!(r && r.rows && r.rows[0] && r.rows[0].unlocked === true)) {
        destroy = true;
        log.warn('reconciliation.client_lock_release_failed', { clientId, reason: 'not_held' });
      }
    } catch (err) {
      destroy = true;
      log.warn('reconciliation.client_lock_release_failed', {
        clientId, reason: 'unlock_threw', errorCode: (err && err.code) || null,
      }, err);
    } finally {
      try {
        if (destroy) lock.conn.release(true);
        else lock.conn.release();
      } catch (_) { /* connection already gone — nothing left to free */ }
    }
  }

  /**
   * Every _syncClient return has the same keys, whichever way the sync ended.
   * Callers (admin/routes/operator.js /sync/run, the dashboard) destructure it.
   */
  _syncResult(fields = {}) {
    return {
      granted: 0, revoked: 0, skippedHolderOptin: 0, runId: null,
      sanityGateTriggered: false, sanityGateResolved: null,
      heldRevokes: 0, holdReason: null,
      observationOnly: SWEEP_OBSERVATION_ONLY, proposalsRecorded: 0,
      ...fields,
    };
  }

  /**
   * INSERT a config_alert_log row unless an UNRESOLVED row with the same
   * (client, alert_type, hardware_ref) already exists — one statement, so a
   * condition that persists across sweeps alerts once until an operator
   * resolves it. alert_type is never null; hardware_ref is capped at 255.
   * Every parameter is cast explicitly: a parameter used both in the SELECT
   * list and in the WHERE would otherwise be inferred as two different types.
   * Never throws.
   *
   * @returns {Promise<boolean>} true when a row was written
   */
  async _insertAlertOnce(clientId, alertType, hardwareRef) {
    const type = alertType || 'revoke_unknown';
    const _actor = getActor() || {};
    try {
      const r = await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         SELECT $1::uuid, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar
         WHERE NOT EXISTS (
           SELECT 1 FROM config_alert_log
           WHERE client_id    = $1::uuid
             AND alert_type   = $2::varchar
             AND hardware_ref = $3::varchar
             AND resolved_at IS NULL
         )`,
        [
          clientId, type, alertRef(hardwareRef),
          this._sweepTraceId || getTraceId() || null,
          _actor.type || null, _actor.id || null,
        ]
      );
      return !!(r && r.rowCount > 0);
    } catch (err) {
      log.warn('reconciliation.alert_write_failed', { clientId, alertType: type }, err);
      return false;
    }
  }

  /**
   * One batched INSERT into reconciliation_proposal (migration
   * reconcile-proposal-log.sql) for every proposal this sweep made. Log only —
   * nothing reads it to decide. Never throws: a missing table (the migration
   * is not applied yet) warns once per process and the sweep carries on.
   *
   * @returns {Promise<number>} rows recorded
   */
  async _recordProposals(clientId, runId, records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    let recorded = 0;
    for (let i = 0; i < records.length; i += PROPOSAL_INSERT_CHUNK) {
      const chunk = records.slice(i, i + PROPOSAL_INSERT_CHUNK);
      const params = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 12;
        params.push(
          runId || null, clientId,
          r.platformMemberId || null, r.sourcePlanId || null, r.hardwareGroupId || null,
          r.kind, r.source || null, r.dataSource || null, r.classification || null,
          r.decision, r.holdReason || null,
          r.evidence ? JSON.stringify(r.evidence) : null
        );
        const ph = [];
        for (let k = 1; k <= 12; k++) ph.push(`$${b + k}`);
        return `(${ph.join(', ')})`;
      });
      try {
        const res = await db.query(
          `INSERT INTO reconciliation_proposal
             (run_id, client_id, platform_member_id, source_plan_id, hardware_group_id,
              kind, source, data_source, classification, decision, hold_reason, evidence)
           VALUES ${tuples.join(', ')}`,
          params
        );
        recorded += (res && typeof res.rowCount === 'number') ? res.rowCount : chunk.length;
      } catch (err) {
        if (err && err.code === '42P01') {
          if (!this._proposalLogMissingWarned) {
            this._proposalLogMissingWarned = true;
            log.warn('reconciliation.proposal_log_unavailable', {
              clientId, migration: 'migrations/reconcile-proposal-log.sql',
            });
          }
        } else {
          log.warn('reconciliation.proposal_log_failed', {
            clientId, runId, count: chunk.length, errorCode: (err && err.code) || null,
          }, err);
        }
        return recorded;
      }
    }
    return recorded;
  }

  /**
   * The Wix double read (Builder rule 5): every pricing-plan order, classified,
   * plus confirmed bookings — read, wait this._doubleReadDelayMs, read again —
   * folded by buildWixPayingView. Throws if EITHER read fails or returns a
   * non-list (the caller aborts the client's sync, fail-closed); the error
   * carries wixRead = 1 | 2.
   */
  async _readWixTwice(wixApiKey, siteId) {
    const readOnce = async (n) => {
      try {
        const [orders, bookings] = await Promise.all([
          listOrdersClassified(wixApiKey, siteId),
          listConfirmedBookings(wixApiKey, siteId),
        ]);
        if (!Array.isArray(orders) || !Array.isArray(bookings)) {
          const bad = new Error(`Wix read ${n} returned a non-array list`);
          bad.code = 'WIX_PAGE_INTEGRITY';
          throw bad;
        }
        return { orders, bookings };
      } catch (err) {
        if (err && typeof err === 'object' && !err.wixRead) err.wixRead = n;
        throw err;
      }
    };
    const first = await readOnce(1);
    if (this._doubleReadDelayMs > 0) await this._sleep(this._doubleReadDelayMs);
    const second = await readOnce(2);
    return buildWixPayingView([first, second]);
  }

  /**
   * Main entry point for the Railway Cron Job and in-process scheduler.
   *
   * @param {Object} [opts]
   * @param {string} [opts.triggerSource]  - Discriminates the caller for observability.
   *   Accepted values: 'inprocess' (admin/server.js scheduler), 'cli' (Railway cron or
   *   `node core/reconciliation.js`), 'railway-cron' (if a Railway env signal is wired),
   *   'operator-triggered' (manual sync run reusing the entry — rare; per-member uses
   *   reconcileMember instead), 'unknown' (default — fallback if a caller forgot to pass).
   *
   *   The literal string `'reconciliation-cron'` is RESERVED — older default that masked
   *   trigger source. Do NOT pass that as a triggerSource. OB-227.
   *
   *   Emitted as actor.id `reconciliation-<triggerSource>` so existing
   *   v_trace_timeline / diagnostic_log greps for `reconciliation-` still hit.
   */
  async runNightlySweep(opts = {}) {
    const triggerSource = opts.triggerSource || 'unknown';
    const actorId       = `reconciliation-${triggerSource}`;
    const sweepTraceId = mintTraceId();
    return runWith(
      { traceId: sweepTraceId, actor: { type: 'system', id: actorId } },
      () => this._runNightlySweepBody(sweepTraceId, triggerSource)
    );
  }

  async _runNightlySweepBody(sweepTraceId, triggerSource = 'unknown') {
    const sweepLogger = withTrace(sweepTraceId);
    this._sweepTraceId = sweepTraceId;
    this._sweepLogger = sweepLogger;
    this._sweepTriggerSource = triggerSource;
    sweepLogger.info('reconciliation.sweep_start', { stage: 'cron', result: 'start', triggerSource });

    try {
      // Recurrence gate: skip if not enough time has elapsed since last sweep (DR-018)
      // Uses the first active client's reconciliation_interval as a global gate (V1: single client).
      const lastSyncResult = await db.query(
        `SELECT last_sync_at, COALESCE(reconciliation_interval, 'daily') AS interval
         FROM clients WHERE status = 'active' LIMIT 1`
      );
      const { last_sync_at, interval } = lastSyncResult.rows[0] || {};
      const intervalMs = { hourly: 3600000, '6h': 21600000, '12h': 43200000, daily: 86400000, weekly: 604800000 };
      const minMs = intervalMs[interval] || 86400000;
      if (last_sync_at && (Date.now() - new Date(last_sync_at).getTime()) < minMs) {
        sweepLogger.info('reconciliation.skipped', { reason: 'interval_not_elapsed', interval, stage: 'cron', result: 'skipped' });
        return;
      }

      // Step 0: True-source sync — Wix ↔ DB diff, queue grants for paying members.
      // payingByClient collects each client's PAYING (member → plans) from this
      // sweep's Wix double read; the step-4 replay only re-grants members in it.
      const payingByClient = new Map();
      await this._syncTrueSources(payingByClient);

      // Step 1: Clean up stale in_flight records (crash protection).
      // OB-202: Stale lock → 'recovery_pending' (transient retry state).
      // Reconcile picks these up via _fetchActionableRecords on the next sweep
      // and re-attempts the grant via synthetic event re-queue. If the recovery
      // grant succeeds, the rollup CASE in completeGrant/completeRevoke flips
      // status to 'active'. If it fails again, the row stays in recovery_pending
      // for further retry attempts. 'recovery_pending' is a 5th valid value in
      // the member_access.status CHECK constraint (added 2026-05-26 via ob-202.sql).
      // OB-204: DR-023 boundary preserved — L3 owns the member_access write.
      // This call delegates to adapters/standard-adapter.js releaseStaleLocks.
      const releasedCount = await standardAdapter.releaseStaleLocks(this.staleThresholdMinutes);
      sweepLogger.warn('reconciliation.stale_reset', { stage: 'cron', result: 'success', newStatus: 'recovery_pending', releasedCount });

      // Step 2: Sync Door Lockdown States
      await this._syncDoorLockdownStates();

      // Step 3: Fetch Actionable Records
      const recordsToProcess = await this._fetchActionableRecords();
      sweepLogger.info('reconciliation.actionable_records', { count: recordsToProcess.length, stage: 'cron', result: 'success' });

      // Step 4: Re-process records with rate limit compliance. Grant replays
      // only (Phase 1), and only for members PAYING in this sweep's Wix read.
      // One bad record never stops the rest, the digest or last_sync_at.
      for (const record of recordsToProcess) {
        try {
          await this._processRecordTargeted(record, payingByClient);
        } catch (err) {
          log.warn('reconciliation.requeue_record_failed', {
            memberId: record && record.member_id, clientId: record && record.client_id,
          }, err);
        }
        await this._sleep(250); // Respect Kisi 5 req/sec (DR-008)
      }

      // Step 5: Send Operator Email Digest
      await this._generateAndSendDigest();

      // Update last_sync_at for all active clients (DR-018)
      await db.query(`UPDATE clients SET last_sync_at = NOW() WHERE status = 'active'`);

      sweepLogger.info('reconciliation.sweep_complete', { stage: 'cron', result: 'success' });
    } catch (error) {
      sweepLogger.critical('reconciliation.sweep_failed', { stage: 'cron', result: 'failed' }, error);
    }
  }

  /**
   * Step 0: Pull Wix orders + confirmed bookings (twice), diff against member_master/member_access.
   * Queue synthetic grants for paying members; record (never enqueue) removals — Phase 1.
   *
   * Sub-members (platform_member_id containing '###as' or sub_master_id IS NOT NULL)
   * are operator-managed — they are excluded from the Wix absence check (3B).
   *
   * @param {Map} [payingByClient]  filled with clientId → Map<memberId, Set<planId>>
   *   (PAYING in either Wix read) for every client whose Wix double read succeeded.
   */
  async _syncTrueSources(payingByClient = null) {
    const sweepLogger = this._sweepLogger || log;
    const sweepTraceId = this._sweepTraceId || null;
    sweepLogger.info('reconciliation.wix_sync_start', { traceId: sweepTraceId, stage: 'cron', result: 'start' });

    const clientsResult = await db.query(
      `SELECT c.id, c.source_site_id, c.source_api_key, c.last_active_member_count,
              cs.hardware_api_key, cs.hardware_platform
       FROM clients c
       JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       WHERE c.status = 'active'
         AND c.source_api_key IS NOT NULL
         AND c.source_site_id IS NOT NULL`
    );

    const triggerSource = this._sweepTriggerSource || 'unknown';
    for (const client of clientsResult.rows) {
      try {
        await this._syncClient(client, {
          triggeredBy: 'cron',
          triggeredByActor: { type: 'system', id: `reconciliation-${triggerSource}` },
          payingCollector: payingByClient,
        });
      } catch (err) {
        log.error('reconciliation.client_sync_failed', { clientId: client.id }, err);
        // One client failure must not abort the full sweep
      }
    }

    sweepLogger.info('reconciliation.wix_sync_complete', { traceId: sweepTraceId, stage: 'cron', result: 'success' });
  }

  /**
   * Diff a single client's Wix active members against live Kisi state, queue corrections.
   * Returns { granted, revoked, skippedHolderOptin, runId } so callers (manual sync endpoint) can
   * surface the counts. skippedHolderOptin is always 0 as of DR-049 (2026-07-26) — kept in the
   * return shape only so existing callers (admin/routes/operator.js) destructuring it don't break.
   *
   * Sources of truth:
   *   Wix  — who should have access (active orders + confirmed bookings)
   *   Kisi — who currently has access (live role assignments, filtered to AccessSync users)
   *
   * The DB is used only as a bridge: member_access.hardware_user_id maps Kisi user IDs
   * back to Wix platform_member_ids (on member_master), and member_master.source_tag = 'accesssync'
   * filters out staff/contractors.
   *
   * Hardening:
   *  - Opens a reconciliation_run audit row at start, closes at end with full counts (2026-04-28)
   *  - Per-client Postgres advisory lock (2026-09-10): a second concurrent sync of the same
   *    client returns skipped:'locked' and touches nothing (see _acquireClientLock).
   *  - Phase 1 "stop the bleeding" (2026-09-10) — the sweep is OBSERVATION-ONLY:
   *      · Wix is read twice (listOrdersClassified + listConfirmedBookings, _doubleReadDelayMs
   *        apart). PAYING = PAYING in either read. Grants and Pass 1 use PAYING plans only —
   *        an ACTIVE order whose payment is UNPAID is never granted by the sweep.
   *      · Either Wix read or the Kisi assignment read failing aborts the client's sync
   *        (fail-closed: no grants, no removals, run row closed 'aborted', operator alerted).
   *      · Every removal path — 3B Wix absence, Pass 3 Kisi-user-gone / role drift for
   *        non-paying members, Pass 1.5 holder lapse — only PROPOSES. One decision
   *        (core/revoke-policy.js evaluateRemovals, observationOnly: true) holds them all,
   *        whatever clients.auto_revoke_mode says. Nothing is enqueued: `revoked` is always 0.
   *      · Pass 3 findings for PAYING members are repair_pending (a missing door), never a
   *        removal. Every proposal is written to reconciliation_proposal; operators get
   *        de-duplicated alerts (sweep_repair_pending / sweep_removal_pending /
   *        revoke_holder_lapse_pending) and one anomaly alert when the data looks wrong.
   *  - Phase 1 fix round (2026-09-10):
   *      · 3B and Pass 1.5 propose a (member, plan) only when its Wix classification — for a
   *        sub, its HOLDER's — is ENDED or ABSENT (P-2). A declined, pending or unrecognised
   *        payment is recorded as held_payment_state (no strike clock; any running clock is
   *        cleared), alerted once per unit (revoke_held_payment_state), and never counted in
   *        a Wix removal population.
   *      · Decisions are in UNITS (P-1): a family — the holder plus its subs — is one unit
   *        keyed by the holder's platform_member_id. Every proposal carries unitKey and every
   *        population is a count of distinct units.
   *      · Strike clocks are read from the DB, the policy decides, and only then does any
   *        clock move. Fix round 3: an anomaly-held sweep — an empty batch whose two reads
   *        disagreed too much included — never ADVANCES a clock, nor does a sweep that could
   *        not read the clocks; clears always run, because clearing only ever delays a
   *        removal.
   *      · Per-member alerts survive a MASS_REVOKE hold; only SNAPSHOT_UNSTABLE and
   *        INVALID_PROPOSAL suppress them.
   *      · Pass 1 never promotes a seat its holder released (DR-051 holder_seated=false).
   *    Return adds observationOnly, proposalsRecorded and holdReason.
   */
  async _syncClient(client, opts = {}) {
    const lock = await this._acquireClientLock(client.id);
    if (lock.state === 'held_elsewhere') {
      // Another sweep of this client is running. Open no run row, change nothing.
      log.warn('reconciliation.client_sync_skipped_locked', {
        clientId: client.id, triggeredBy: opts.triggeredBy || 'cron', traceId: this._sweepTraceId || null,
      });
      return this._syncResult({ skipped: 'locked', aborted: true, reason: 'locked' });
    }
    try {
      return await this._syncClientLocked(client, opts);
    } finally {
      await this._releaseClientLock(lock, client.id);
    }
  }

  async _syncClientLocked(client, opts = {}) {
    const triggeredBy        = opts.triggeredBy || 'cron';
    // OB-227: literal 'reconciliation-cron' default was the bug — masked which trigger
    // path invoked the sweep. Callers must pass an explicit triggeredByActor; if absent,
    // fall back to 'reconciliation-unknown' so the omission is greppable.
    const triggeredByActor   = opts.triggeredByActor || { type: 'system', id: 'reconciliation-unknown' };
    const wixApiKey      = decryptApiKey(client.source_api_key);
    const hardwareApiKey = decryptApiKey(client.hardware_api_key);
    const hardwarePlatform = client.hardware_platform || 'kisi';
    const siteId = client.source_site_id;
    const traceId = this._sweepTraceId || null;

    let granted = 0;
    // Phase 1: the sweep never enqueues a revoke. Kept in the return and the
    // reconciliation_run row (revokes_queued) so both still read honestly.
    const revoked = 0;
    const skippedHolderOptin = 0; // always 0 since DR-049; kept for callers

    // Open the audit row immediately so even an early abort is recorded
    const runRowResult = await db.query(
      `INSERT INTO reconciliation_run
         (client_id, trace_id, triggered_by, triggered_by_actor_type, triggered_by_actor_id, status)
       VALUES ($1, $2, $3, $4, $5, 'running')
       RETURNING id`,
      [client.id, traceId, triggeredBy, triggeredByActor.type, triggeredByActor.id]
    ).catch(e => { log.error('reconciliation.run_open_failed', { clientId: client.id }, e); return { rows: [{ id: null }] }; });
    const runId = runRowResult.rows[0]?.id || null;

    // Automatic-removal mode — read once, up front, fail-closed 'off' (see
    // _readAutoRevokeMode). Gates the DR-051 seat self-heal in Pass 1 and is
    // recorded with every proposal. It never arms a sweep removal in Phase 1.
    const mode = await this._readAutoRevokeMode(client.id);

    // Every removal path below pushes a proposal here instead of enqueueing:
    // { source, dataSource, memberKey, unitKey, planId, ... }. The removal
    // decision (after 3B, before the grant loop) holds all of them in Phase 1.
    const revokeProposals = [];
    // Pass 3 findings for PAYING members: a door that should exist is missing.
    // Never a removal — recorded as repair_pending and alerted.
    const repairProposals = [];
    // 3B / Pass 1.5 (member, plan) pairs whose Wix payment is declined, pending
    // or unrecognised (fix round F2): never proposed, never counted in a Wix
    // removal population — recorded as held_payment_state and alerted.
    const heldPaymentState = [];
    // Units Pass 3 sees as active + provisioned — the 'kisi' population the
    // removal policy judges volume against; stays empty if Pass 3 is skipped.
    const pass3UnitKeys = new Set();

    // 1. Pull Wix side — every pricing-plan order (classified) + confirmed bookings,
    //    read TWICE, this._doubleReadDelayMs apart (Builder rule 5).
    //
    // OB-87: FAIL CLOSED. If ANY Wix fetch in either read throws, we cannot distinguish
    // "member has no active plan" from "Wix API is broken." An empty-but-valid
    // response from a broken endpoint would cause a mass revoke of real members.
    // So: on any fetch error, flag config_alert_log and abort this client's sync
    // entirely — no grants, no removals. Nightly digest will surface the alert.
    // (wix-plans-api now also throws WIX_PAGE_INTEGRITY on a malformed or
    // truncated page instead of returning a short list.)
    let wixView;
    try {
      wixView = await this._readWixTwice(wixApiKey, siteId);
    } catch (err) {
      log.error('reconciliation.wix_fetch_failed', {
        clientId: client.id, siteId,
        wixStatus: err.status || err.statusCode || null,
        wixCode:   err.code || null,
        wixRead:   err.wixRead || null,
      }, err);
      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, 'wix_api_unavailable', $2, $3, $4, $5)`,
        [client.id, alertRef(`status=${err.status || err.statusCode || 'unknown'} code=${err.code || 'unknown'}`), getTraceId() || null, _actor.type || null, _actor.id || null]
      ).catch(() => {}); // Fault-tolerant — never block digest
      // Close the audit row as aborted before returning
      if (runId) await db.query(
        `UPDATE reconciliation_run SET status = 'aborted', abort_reason = 'wix_api_unavailable', completed_at = NOW() WHERE id = $1`,
        [runId]
      ).catch(() => {});
      // Abort this client's sync. Do NOT fall through to compare/grant/propose.
      return this._syncResult({ runId, aborted: true, reason: 'wix_api_unavailable' });
    }

    // wixMembers: memberId → { plans: [{ planId, sourceType, rawOrder }], email, name } —
    // PAYING members (either read) with their PAYING plans only. Multi-plan members keep
    // every plan (OB-185 hotfix 2026-05-18); orders and bookings both contribute.
    const { wixMembers, payingPlansByMember, bestClass, payingInRead, readDisagreement } = wixView;
    if (opts.payingCollector instanceof Map) opts.payingCollector.set(client.id, payingPlansByMember);

    if (readDisagreement[DATA_SOURCE.WIX_ORDERS] > 0 || readDisagreement[DATA_SOURCE.WIX_BOOKINGS] > 0) {
      log.warn('reconciliation.wix_reads_disagreed', {
        clientId: client.id, readDisagreement,
        payingRead1: payingInRead[0].size, payingRead2: payingInRead[1].size,
        traceId: this._sweepTraceId,
      });
    }

    // Is this (member, plan) PAYING in either read? A sub-member is judged by
    // its holder: the sub keeps access while the holder pays for that plan.
    const isPayingPlan = (memberKey, holderKey, planId) => {
      const plans = payingPlansByMember.get(holderKey || memberKey);
      return !!(plans && planId && plans.has(planId));
    };
    // Best Wix classification seen for (member, plan) in either read, or ABSENT.
    const classOf = (memberKey, planId) =>
      (memberKey && planId && bestClass.get(memberPlanKey(memberKey, planId))) || CLASS_ABSENT;

    // 2. Pull Kisi side — live role assignments, filtered to AccessSync-managed users via DB join.
    //
    // Phase 1 (I-4): getManagedRoleAssignments THROWS on any Kisi error or malformed page
    // (it used to return [] — which read as "nobody has a door" and would have proposed a
    // role-drift removal for every active member). A throw aborts this client's sync exactly
    // like a Wix failure: no grants, no proposals, run row 'aborted', operator alerted.
    let kisiAssignments;
    try {
      kisiAssignments = await hardwareAdapter.getManagedRoleAssignments(hardwarePlatform, hardwareApiKey);
      if (!Array.isArray(kisiAssignments)) {
        const bad = new Error('getManagedRoleAssignments returned a non-array');
        bad.code = 'KISI_PAGE_INTEGRITY';
        throw bad;
      }
    } catch (err) {
      log.warn('reconciliation.kisi_fetch_failed', {
        clientId: client.id, hardwarePlatform,
        statusCode: err.statusCode || null, code: err.code || null,
        traceId: this._sweepTraceId,
      }, err);
      const _actor = getActor() || {};
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          client.id,
          hardwarePlatform === 'kisi' ? 'kisi_api_unavailable' : 'hardware_api_unavailable',
          alertRef(`status=${err.statusCode || 'unknown'} code=${err.code || 'unknown'}`),
          getTraceId() || null, _actor.type || null, _actor.id || null,
        ]
      ).catch(() => {}); // Fault-tolerant — never block digest
      if (runId) await db.query(
        `UPDATE reconciliation_run SET status = 'aborted', abort_reason = 'hardware_api_unavailable', completed_at = NOW() WHERE id = $1`,
        [runId]
      ).catch(() => {});
      // 'hardware_api_unavailable' is the reason the dashboard Sync button already words.
      return this._syncResult({ runId, aborted: true, reason: 'hardware_api_unavailable' });
    }
    const kisiUserIds = [...new Set(kisiAssignments.map(a => a.userId).filter(Boolean))];

    // Map: platform_member_id (Wix member ID) → { isSubMember }
    // Only includes users AccessSync created (source_tag = 'accesssync').
    // Staff, contractors, manually-added Kisi users have no member_master row and are excluded.
    const kisiMembers = new Map();

    if (kisiUserIds.length > 0) {
      const identityResult = await db.query(
        `SELECT mm.platform_member_id, ma.sub_master_id
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         WHERE ma.client_id = $1
           AND mm.source_tag = 'accesssync'
           AND ma.hardware_user_id = ANY($2)`,
        [client.id, kisiUserIds]
      );
      for (const row of identityResult.rows) {
        kisiMembers.set(row.platform_member_id, {
          isSubMember: row.sub_master_id !== null || row.platform_member_id.includes('###as'),
        });
      }
    }

    // OB-185 / A11 — Pass-2 orphan handling:
    // For each Kisi role assignment, check if it has a matching member_access_sources row.
    // If NOT, do NOT queue a synthetic revoke. Log the observation for operator review
    // (OB-186 will surface these in the Kisi tab dashboard). Operator-side manual grants
    // are preserved indefinitely by default — AccessSync never removes a Kisi assignment
    // we don't have a DB source row for.
    //
    // OB-185 / A12 — Pre-filter to AccessSync's universe of concern (STRATA contract):
    //   - role_id MUST be group_basic (the only role AccessSync ever creates)
    //   - group_id MUST be in plan_mappings.hardware_group_id for this client
    // Anything outside this universe is invisible to reconcile — never logged as orphan,
    // never matched against DB. Admin/manager/owner roles never reach this loop.
    // PARSE-verified 2026-05-02: AccessSync uses only role_id='group_basic'.
    // PARSE-verified 2026-05-13 via DR-045 Layer C: elevated roles return scope ∈
    // {organization, place} or role_id outside {group_basic}.

    // Build the universe filter once per sweep — set of (group_id) values AccessSync provisions to.
    const accessSyncGroupsResult = await db.query(
      `SELECT DISTINCT hardware_group_id FROM plan_mappings
       WHERE client_id = $1 AND status = 'active' AND hardware_group_id IS NOT NULL`,
      [client.id]
    );
    const accessSyncGroupIds = new Set(accessSyncGroupsResult.rows.map(r => String(r.hardware_group_id)));

    for (const assignment of kisiAssignments) {
      if (!assignment.userId) continue;

      // A12 pre-filter — skip assignments outside AccessSync's universe of concern.
      // Note: getManagedRoleAssignments doesn't return role_id/scope today (OB-184 CL-?),
      // so the role-id filter is enforced upstream by Kisi (we only ever POST group_basic).
      // The group_id filter is the strong defense here — any assignment to a group AccessSync
      // doesn't provision (admin scope, side doors, staff-only groups) gets skipped silently.
      if (!assignment.groupId || !accessSyncGroupIds.has(String(assignment.groupId))) {
        continue; // Outside AccessSync's universe — invisible to reconcile
      }

      // OB-225 — Kisi returns userId/groupId as JS numbers; DB columns are varchar.
      // Coerce both sides to text in JS AND cast columns to text in SQL so the
      // pg driver can never infer an int OID that breaks the varchar comparison.
      const sourceCheck = await db.query(
        `SELECT mas.id, mas.status
         FROM member_access_sources mas
         JOIN member_access ma ON ma.id = mas.access_id
         WHERE ma.client_id = $1
           AND ma.hardware_user_id::text = $2
           AND mas.hardware_group_id::text = $3
         LIMIT 1`,
        [client.id, String(assignment.userId), String(assignment.groupId)]
      );

      if (sourceCheck.rows.length === 0) {
        // A11 — no matching DB source row. Operator-side grant or DB-loss orphan.
        // DO NOT queue a synthetic revoke. Log only. OB-186 dashboard surfaces this.
        log.warn('reconciliation.unmanaged_assignment_observed', {
          clientId: client.id,
          kisiUserId: assignment.userId,
          hardwareGroupId: assignment.groupId,
          roleAssignmentId: assignment.roleAssignmentId,
          reason: 'no_matching_db_source_row',
          action: 'preserved_pending_operator_review',
          traceId: this._sweepTraceId,
          stage: 'reconcile', result: 'observed',
        });
        // No revoke queued. No state change. Preserved.
      }
    }

    // ── Pass 3: Operator-deleted-Kisi-user drift detection (OB-249) ──
    // After Pass 2 has observed Kisi orphans, Pass 3 detects the INVERSE case:
    // our DB says a member is 'active' with hardware_user_id pointing at a
    // Kisi user that no longer exists. Trigger: operator manually deletes a
    // user via the Kisi dashboard. Observed live 2026-06-12 (Brittany).
    //
    // Bulk-read optimized (SAGE-locked 2026-06-14): one paginated listAllUsers
    // call (~2-3 HTTP roundtrips up to ~500 users) instead of N per-user GETs.
    // Reuses Pass 2's `kisiAssignments` to detect per-source role drift
    // without additional Kisi calls.
    //
    // Two-strike requirement (SAGE condition): we set
    // `kisi_user_disappeared_observed_at` (OB-249 migration column) on the FIRST
    // observation. The NEXT sweep sees it populated and records a finding per
    // active source plan. Single transient 404s during Kisi outages can't raise
    // a finding — they need consecutive confirmations.
    //
    // Phase 1 (2026-09-10): a finding is never a revoke. If the member is PAYING
    // for that plan (either Wix read; a sub-member via its holder) the door is
    // MISSING, not surplus: repair_pending + a deduplicated sweep_repair_pending
    // alert (Builder rule 2 — the sweep repairs paying members, never removes
    // them). Otherwise it is a removal proposal, recorded and held.
    //
    // Outage short-circuit: if listAllUsers throws (network/5xx/auth, or a
    // KISI_PAGE_INTEGRITY page), abort Pass 3 for this client. Pass 1, Pass 1.5,
    // and the 3A grant queue continue.
    //
    // Platform gate: Kisi only for now. Seam stub doesn't implement listAllUsers
    // yet (OB-XXX when Seam ships).
    let pass3OutageObserved = false;
    let pass3KisiUsers = null;
    let pass3DisappearedFirstSighting = 0;
    let pass3DisappearedConfirmed = 0;
    let pass3RoleDrifted = 0;
    let pass3UserRecovered = 0;
    let pass3RepairPending = 0;

    if (hardwarePlatform === 'kisi') {
      try {
        pass3KisiUsers = await hardwareAdapter.listAllUsers(hardwarePlatform, hardwareApiKey);
      } catch (err) {
        pass3OutageObserved = true;
        log.warn('reconciliation.pass_3_aborted_kisi_unavailable', {
          clientId: client.id,
          statusCode: err.statusCode || null,
          traceId: this._sweepTraceId,
        }, err);
      }
    } else {
      log.info('reconciliation.pass_3_skipped_unsupported_platform', {
        clientId: client.id, hardwarePlatform,
      });
    }

    if (!pass3OutageObserved && pass3KisiUsers !== null) {
      const kisiUserIdSet = new Set(pass3KisiUsers.map(u => String(u.id)));

      // Build a set of (userId, groupId) pairs from Pass 2's already-fetched
      // assignments so per-source role drift detection is free of new HTTP calls.
      const kisiAssignmentPairs = new Set(
        kisiAssignments
          .filter(a => a.userId && a.groupId)
          .map(a => `${a.userId}:${a.groupId}`)
      );

      // holder_platform_member_id: a sub-member's holder (member_master via
      // sub_master_id) — subs are judged PAYING by their holder's plans.
      const activeAccessRows = await db.query(
        `SELECT ma.id AS access_id, ma.hardware_user_id::text AS hardware_user_id,
                ma.kisi_user_disappeared_observed_at,
                mm.platform_member_id, ma.sub_master_id,
                holder_mm.platform_member_id AS holder_platform_member_id
         FROM member_access ma
         JOIN member_master mm ON mm.id = ma.member_master_id
         LEFT JOIN member_master holder_mm
                ON holder_mm.id        = ma.sub_master_id
               AND holder_mm.client_id = ma.client_id
         WHERE ma.client_id = $1
           AND ma.status = 'active'
           AND ma.hardware_user_id IS NOT NULL
           AND mm.source_tag = 'accesssync'`,
        [client.id]
      );

      // Paying for this plan → the door is missing: repair_pending, never a
      // removal. Otherwise → a removal proposal (held — Phase 1). Kisi-sourced
      // proposals are decided in units too (P-1): a sub-member counts as its
      // holder's family, everyone else as themselves.
      const routePass3Finding = (finding) => {
        const proposal = { ...finding, unitKey: unitKeyOf(finding.memberKey, finding.holderKey) };
        if (isPayingPlan(proposal.memberKey, proposal.holderKey, proposal.planId)) {
          repairProposals.push({ ...proposal, classification: ORDER_CLASS.PAYING });
          pass3RepairPending++;
        } else {
          revokeProposals.push(proposal);
        }
      };

      for (const row of activeAccessRows.rows) {
        const holderKey = row.sub_master_id ? (row.holder_platform_member_id || null) : null;
        // The 'kisi' population, in units, under the same collapse rule as the proposals.
        if (row.platform_member_id) pass3UnitKeys.add(unitKeyOf(row.platform_member_id, holderKey));
        const userPresent = kisiUserIdSet.has(row.hardware_user_id);

        if (!userPresent) {
          if (row.kisi_user_disappeared_observed_at) {
            // SECOND consecutive observation — one finding per active source plan
            const subSources = await db.query(
              `SELECT DISTINCT source_plan_id FROM member_access_sources
               WHERE access_id = $1 AND status = 'active' AND source_plan_id IS NOT NULL`,
              [row.access_id]
            );
            for (const src of subSources.rows) {
              const tid = mintTraceId();
              const syntheticEvent = {
                eventType:        'plan.cancelled',
                platformMemberId: row.platform_member_id,
                sourcePlatform:   'wix',
                planId:           src.source_plan_id,
                synthetic:        true,
                traceId:          tid,
              };
              // Finding only — recorded, never enqueued in Phase 1. A held
              // finding is re-derived next sweep: the two-strike marker stays set.
              routePass3Finding({
                source:         REVOKE_SOURCE.KISI_USER_VANISHED,
                dataSource:     DATA_SOURCE.KISI,
                memberKey:      row.platform_member_id,
                planId:         src.source_plan_id,
                accessId:       row.access_id,
                hardwareUserId: row.hardware_user_id,
                holderKey,
                classification: classOf(holderKey || row.platform_member_id, src.source_plan_id),
                syntheticEvent,
                jobId: `pass3-userdrift-${row.access_id}-${src.source_plan_id}-${Date.now()}`,
              });
              pass3DisappearedConfirmed++; // detection count, not enqueue count
            }
          } else {
            // FIRST observation — record timestamp only, no destructive action.
            // DR-023: member_access write routed through L3.
            await standardAdapter.markKisiUserObservation(row.access_id, true);
            pass3DisappearedFirstSighting++;
            log.info('reconciliation.kisi_user_disappeared_first_sighting', {
              clientId:         client.id,
              accessId:         row.access_id,
              platformMemberId: row.platform_member_id,
              hardwareUserId:   row.hardware_user_id,
              sweepTraceId:     this._sweepTraceId,
            });
          }
        } else {
          // User exists in Kisi.
          // (a) Clear any prior disappear marker — recovery path
          if (row.kisi_user_disappeared_observed_at) {
            // DR-023: member_access write routed through L3.
            await standardAdapter.markKisiUserObservation(row.access_id, false);
            pass3UserRecovered++;
            log.info('reconciliation.kisi_user_recovered', {
              clientId:         client.id,
              accessId:         row.access_id,
              platformMemberId: row.platform_member_id,
              hardwareUserId:   row.hardware_user_id,
            });
          }
          // (b) Per-source role drift check — verify each active source's expected
          //     Kisi role assignment is still present. Reuses Pass 2's kisiAssignmentPairs.
          //     A12 universe filter — only check groups AccessSync manages.
          const sourceRows = await db.query(
            `SELECT id, source_plan_id, hardware_group_id::text AS hardware_group_id
             FROM member_access_sources
             WHERE access_id = $1
               AND status = 'active'
               AND hardware_group_id IS NOT NULL
               AND source_plan_id IS NOT NULL`,
            [row.access_id]
          );
          for (const src of sourceRows.rows) {
            if (!accessSyncGroupIds.has(String(src.hardware_group_id))) continue;
            const pairKey = `${row.hardware_user_id}:${src.hardware_group_id}`;
            if (!kisiAssignmentPairs.has(pairKey)) {
              const tid = mintTraceId();
              const syntheticEvent = {
                eventType:        'plan.cancelled',
                platformMemberId: row.platform_member_id,
                sourcePlatform:   'wix',
                planId:           src.source_plan_id,
                synthetic:        true,
                traceId:          tid,
              };
              // Finding only — recorded, never enqueued in Phase 1.
              routePass3Finding({
                source:          REVOKE_SOURCE.ROLE_DRIFT,
                dataSource:      DATA_SOURCE.KISI,
                memberKey:       row.platform_member_id,
                planId:          src.source_plan_id,
                accessId:        row.access_id,
                hardwareUserId:  row.hardware_user_id,
                hardwareGroupId: src.hardware_group_id,
                holderKey,
                classification:  classOf(holderKey || row.platform_member_id, src.source_plan_id),
                syntheticEvent,
                jobId: `pass3-roledrift-${row.access_id}-${src.source_plan_id}-${Date.now()}`,
              });
              pass3RoleDrifted++; // detection count, not enqueue count
            }
          }
        }
      }
    }

    log.info('reconciliation.pass_3_complete', {
      clientId:                  client.id,
      outage:                    pass3OutageObserved,
      totalKisiUsersFetched:     pass3KisiUsers?.length || 0,
      disappearedFirstSighting:  pass3DisappearedFirstSighting,
      disappearedConfirmed:      pass3DisappearedConfirmed,
      roleDrifted:               pass3RoleDrifted,
      userRecovered:             pass3UserRecovered,
      // Of the confirmed / drifted findings, how many belong to a PAYING member
      // (repair_pending, not a removal proposal).
      repairPending:             pass3RepairPending,
      traceId:                   this._sweepTraceId,
    });

    // OB-185 Pass 1 promotion logic — for each Wix-PAYING member who EXISTS in our DB,
    // (Phase 1: wixMembers holds PAYING plans only — an ACTIVE+UNPAID order is never promoted.)
    // ensure their source rows reflect "active" status. This handles the post-S-11 case
    // where migration translated existing access_status='inactive' → source.status='cancelled'
    // for members who in reality had active Wix plans the whole time.
    //
    // The pre-S-11 set-membership-only diff (Wix∩Kisi → "no action") missed this entire
    // class of stale-source-row situations. New behavior: if Wix has the member as active
    // and DB has source rows in cancelled status for that member's mapped plan, flip them
    // back to active. Pass 2 (the Kisi backfill block below) then picks up the
    // role_assignment_id from live Kisi state.
    let promoted = 0;
    let inserted = 0;
    for (const [memberId, wixData] of wixMembers) {
      if (!wixData.plans || wixData.plans.length === 0) continue;

      // Per OB-185 A13 (Builder pressure-test 2026-05-18): Wix is the source of truth.
      // If Wix says member has N plans, DB must have N source rows. Two cases per plan:
      //   (a) Source row exists in 'cancelled' → promote to 'active' (legacy migration case)
      //   (b) Source row doesn't exist at all  → INSERT in 'active'   (true Wix→DB sync)
      //
      // Multi-group plans expand: one plan_mapping with 3 hardware_group_ids produces
      // 3 source rows. Both promotion and INSERT iterate plan_mapping_groups.
      for (const plan of wixData.plans) {
        if (!plan.planId) continue;

        // ── DR-051 flag, read FIRST (fix round F12). A holder who released their OWN
        // seat on this plan has member_billing.holder_seated=false. The promotion in
        // (a) would otherwise flip that released seat back cancelled → active, and in
        // 'off' / 'dry_run' the self-heal further down is held — so the seat the
        // member gave up would stay resurrected. Read once, before (a), and reused by
        // the DR-051 branch in (b). Sub-members / members with no billing row → no
        // flag row → not released. A failed read leaves this plan exactly as found:
        // no promotion, no billing backfill, no seat INSERT.
        let holderReleasedSeat;
        try {
          const seatFlagRes = await db.query(
            `SELECT mb.holder_seated
             FROM member_billing mb
             JOIN member_master mm ON mm.id = mb.member_master_id
             WHERE mb.client_id = $1 AND mm.platform_member_id = $2 AND mb.plan_id = $3
             ORDER BY mb.cycle_index DESC LIMIT 1`,
            [client.id, memberId, plan.planId]
          );
          const seatFlagRows = (seatFlagRes && seatFlagRes.rows) || [];
          holderReleasedSeat = seatFlagRows.length > 0 && seatFlagRows[0].holder_seated === false;
        } catch (err) {
          log.warn('reconciliation.holder_seated_read_failed', {
            clientId: client.id, platformMemberId: memberId, planId: plan.planId,
            traceId: this._sweepTraceId,
          }, err);
          continue;
        }

        // ── (a) Promotion: flip cancelled → active for any existing source row matching
        //    this plan — never for a seat its holder released (the DR-051 flag above).
        if (!holderReleasedSeat) {
          try {
            const promotionResult = await db.query(
              `UPDATE member_access_sources mas
               SET status = 'active', updated_at = NOW()
               FROM member_access ma, member_master mm, plan_mappings pm
               WHERE mas.access_id = ma.id
                 AND mm.id = ma.member_master_id
                 AND pm.id = mas.mapping_id
                 AND ma.client_id = $1
                 AND mm.platform_member_id = $2
                 AND pm.source_plan_id = $3
                 AND mas.status = 'cancelled'
               RETURNING mas.id, mas.access_id`,
              [client.id, memberId, plan.planId]
            );
            if (promotionResult.rowCount > 0) {
              promoted += promotionResult.rowCount;
              log.info('reconciliation.source_promoted_from_cancelled', {
                clientId: client.id, platformMemberId: memberId, planId: plan.planId,
                sourceCount: promotionResult.rowCount,
                traceId: this._sweepTraceId, stage: 'reconcile', result: 'promoted',
              });
            }
          } catch (err) {
            log.error('reconciliation.source_promotion_failed', {
              clientId: client.id, platformMemberId: memberId, planId: plan.planId,
            }, err);
          }
        }

        // ── (b) Backfill INSERT: for every (mapping × hardware_group) this plan expects,
        // INSERT a source row if none exists. Idempotent via ON CONFLICT on the A9 UNIQUE.
        // Resolves multi-group plans by joining plan_mapping_groups (mirrors S-11 STEP 1).
        // F-3: skip plans with no mapping (operator hasn't mapped this Wix plan yet).
        try {
          const targets = await db.query(
            `SELECT pm.id AS mapping_id,
                    COALESCE(pmg.hardware_group_id, pm.hardware_group_id) AS hardware_group_id
             FROM plan_mappings pm
             LEFT JOIN plan_mapping_groups pmg ON pmg.mapping_id = pm.id
             WHERE pm.client_id = $1 AND pm.source_plan_id = $2 AND pm.status = 'active'`,
            [client.id, plan.planId]
          );
          if (targets.rowCount === 0) {
            log.warn('reconciliation.plan_not_mapped', {
              clientId: client.id, platformMemberId: memberId, planId: plan.planId,
              traceId: this._sweepTraceId, stage: 'reconcile', result: 'skipped',
            });
            continue;
          }

          // OB-187 — backfill member_billing once per (member × plan) for legacy
          // members who came in via reconcile, not webhook. Wrapped in the rawOrder
          // shape extractBillingSnapshot expects ({ data: { entity: <order> } }).
          // Idempotent on (client_id, wix_order_id, cycle_index). billingId is
          // then linked into every source row we INSERT/UPDATE below so the
          // Members UI Rate column populates without a real webhook ever firing.
          let billingId = null;
          // OB-187 — Wix Pricing Plans v2 /orders returns `id` (not `_id`). Probe
          // 2026-05-19 confirmed: every active order has id populated, _id null.
          // extractBillingSnapshot reads entity._id, so we normalize id → _id when
          // we wrap the order for the snapshot extractor below.
          const wixOrderId = plan.rawOrder?.id || plan.rawOrder?._id || null;
          if (plan.rawOrder && wixOrderId) {
            // Normalize id → _id so extractBillingSnapshot (which expects the
            // webhook envelope's _id) picks up the order id correctly. Also pull
            // subscriptionId off the rawOrder directly since the REST list shape
            // surfaces it at top level (not nested under entity like the webhook).
            const normalizedEntity = {
              ...plan.rawOrder,
              _id: wixOrderId,
              subscriptionId: plan.rawOrder.subscriptionId || null,
            };
            const snapshot = extractBillingSnapshot({ data: { entity: normalizedEntity } });
            const memberMasterRes = await db.query(
              `SELECT ma.member_master_id
               FROM member_access ma
               JOIN member_master mm ON mm.id = ma.member_master_id
               WHERE ma.client_id = $1 AND mm.platform_member_id = $2
               LIMIT 1`,
              [client.id, memberId]
            );
            const memberMasterId = memberMasterRes.rows[0]?.member_master_id || null;
            if (memberMasterId) {
              try {
                const billingResult = await db.query(
                  `INSERT INTO member_billing
                     (member_master_id, client_id, wix_order_id, wix_subscription_id, cycle_index,
                      plan_id, plan_name, status, billing_snapshot)
                   VALUES ($1, $2, $3, $4, 1, $5, $6, 'active', $7)
                   ON CONFLICT (client_id, wix_order_id, cycle_index) DO NOTHING
                   RETURNING id`,
                  [
                    memberMasterId, client.id, wixOrderId,
                    plan.rawOrder.subscriptionId || snapshot?.subscriptionId || null,
                    plan.planId,
                    plan.rawOrder.planName || null,
                    snapshot ? JSON.stringify(snapshot) : null,
                  ]
                );
                if (billingResult.rows.length > 0) {
                  billingId = billingResult.rows[0].id;
                } else {
                  const existing = await db.query(
                    `SELECT id FROM member_billing
                     WHERE client_id = $1 AND wix_order_id = $2 AND cycle_index = 1`,
                    [client.id, wixOrderId]
                  );
                  billingId = existing.rows[0]?.id || null;
                }
              } catch (err) {
                log.warn('reconciliation.billing_backfill_failed', {
                  clientId: client.id, platformMemberId: memberId,
                  planId: plan.planId, wixOrderId,
                }, err);
              }
            }
          }

          // DR-051 — durable leave enforcement. If this holder released their OWN seat on
          // this plan (member_billing.holder_seated=false — read before (a) above), the
          // 6-hour reconcile must (a) NOT re-add the seat Wix still lists, (b) NOT promote
          // it back from cancelled (skipped above), and (c) self-heal any lingering active
          // holder seat by marking it cancelled (DB-only — no Kisi call; the door role
          // follows the normal remaining-source logic, and in the all-same-door reality
          // other plans still hold it). Scoped to the holder's own access row
          // (sub_master_id IS NULL) + this plan's source_plan_id. Sub-members / members
          // with no billing row → no flag row → normal backfill proceeds below.
          if (holderReleasedSeat) {
            // The self-heal cancels a live seat, so it runs only when the client's
            // automatic-removal mode is explicitly 'on' ('off' and 'dry_run' —
            // the migration default — hold it). It is not part of the removal
            // batch — it enforces an explicit, recorded member choice. The
            // `continue` below runs either way, so the released seat is never
            // re-added.
            if (mode !== REVOKE_MODE.ON) {
              log.warn('reconciliation.revoke_held', {
                path: 'holder_seat_release', reason: holdReasonForMode(mode),
                clientId: client.id, platformMemberId: memberId, sourcePlanId: plan.planId,
                traceId: this._sweepTraceId,
              });
            } else {
              const healed = await db.query(
                `UPDATE member_access_sources mas
                 SET status = 'cancelled', updated_at = NOW()
                 FROM member_access ma
                 JOIN member_master mm ON mm.id = ma.member_master_id
                 WHERE mas.access_id = ma.id
                   AND ma.client_id = $1
                   AND mm.platform_member_id = $2
                   AND ma.sub_master_id IS NULL
                   AND mas.source_plan_id = $3
                   AND mas.status = 'active'
                 RETURNING mas.id`,
                [client.id, memberId, plan.planId]
              );
              log.info('reconciliation.holder_seat_released_enforced', {
                clientId: client.id, platformMemberId: memberId, planId: plan.planId,
                healedCount: healed.rowCount,
                traceId: this._sweepTraceId, stage: 'reconcile', result: 'skipped_release',
              });
            }
            continue; // skip the seat backfill for this plan — holder is unseated by choice
          }

          for (const target of targets.rows) {
            if (!target.hardware_group_id) continue; // mapping exists but no group set yet

            const insertResult = await db.query(
              `INSERT INTO member_access_sources
                 (client_id, access_id, source_type, source_plan_id,
                  hardware_group_id, mapping_id, billing_id, status)
               SELECT $1, ma.id, $2, $3, $4, $5, $7, 'active'
               FROM member_access ma
               JOIN member_master mm ON mm.id = ma.member_master_id
               WHERE ma.client_id = $1 AND mm.platform_member_id = $6
               ON CONFLICT (client_id, access_id, source_type, source_plan_id, hardware_group_id)
                 DO NOTHING
               RETURNING id, access_id`,
              [client.id, plan.sourceType || 'plan', plan.planId,
               target.hardware_group_id, target.mapping_id, memberId, billingId]
            );
            if (insertResult.rowCount > 0) {
              inserted += insertResult.rowCount;
              log.info('reconciliation.source_inserted_from_wix', {
                clientId: client.id, platformMemberId: memberId,
                planId: plan.planId, mappingId: target.mapping_id,
                hardwareGroupId: target.hardware_group_id,
                billingId: billingId,
                traceId: this._sweepTraceId, stage: 'reconcile', result: 'inserted',
              });
            }

            // OB-187 — backfill billing_id on rows that already existed (created
            // by an earlier OB-185 sweep before billing backfill landed). Only
            // overwrites NULL → never clobbers a real billing row.
            if (billingId) {
              await db.query(
                `UPDATE member_access_sources mas
                 SET billing_id = $7, updated_at = NOW()
                 FROM member_access ma, member_master mm
                 WHERE mas.access_id = ma.id
                   AND mm.id = ma.member_master_id
                   AND mas.client_id = $1
                   AND mas.source_type = $2
                   AND mas.source_plan_id = $3
                   AND mas.hardware_group_id = $4
                   AND mas.mapping_id = $5
                   AND mm.platform_member_id = $6
                   AND mas.billing_id IS NULL`,
                [client.id, plan.sourceType || 'plan', plan.planId,
                 target.hardware_group_id, target.mapping_id, memberId, billingId]
              ).catch(err => {
                log.warn('reconciliation.billing_id_link_failed', {
                  clientId: client.id, platformMemberId: memberId,
                  planId: plan.planId, billingId,
                }, err);
              });
            }
          }
        } catch (err) {
          log.error('reconciliation.source_insert_failed', {
            clientId: client.id, platformMemberId: memberId, planId: plan.planId,
          }, err);
        }
      }

      // ── Roll up access status from sources for every member we touched this iteration.
      // Single rollup per member, after all per-plan promotion+insert work is done.
      // DR-023: member_access write routed through L3.
      try {
        await standardAdapter.rollupAccessStatusByPlatformMember(client.id, memberId);
      } catch (err) {
        log.error('reconciliation.access_rollup_failed', {
          clientId: client.id, platformMemberId: memberId,
        }, err);
      }
    }

    // OB-185 Pass 2 backfill — for each Wix-active member where DB now shows active source
    // rows but role_assignment_id is NULL, populate role_assignment_id from live Kisi state.
    // "I see you" backfill: AccessSync's DB declares this assignment exists; Kisi already
    // has it; just write down the ID for future targeting on revoke. No assignRole call.
    let backfilled = 0;
    for (const assignment of kisiAssignments) {
      if (!assignment.userId || !assignment.roleAssignmentId) continue;
      if (!assignment.groupId || !accessSyncGroupIds.has(String(assignment.groupId))) continue;
      try {
        // OB-225 — same JS-int vs varchar coercion as Pass 2 source-check (lines 309-321).
        const backfillResult = await db.query(
          `UPDATE member_access_sources mas
           SET role_assignment_id = $4, updated_at = NOW()
           FROM member_access ma
           WHERE mas.access_id = ma.id
             AND ma.client_id = $1
             AND ma.hardware_user_id::text = $2
             AND mas.hardware_group_id::text = $3
             AND mas.role_assignment_id IS NULL
             AND mas.status IN ('active', 'pending_hardware', 'pending_start')
           RETURNING mas.id`,
          [client.id, String(assignment.userId), String(assignment.groupId), String(assignment.roleAssignmentId)]
        );
        if (backfillResult.rowCount > 0) {
          backfilled += backfillResult.rowCount;
          log.info('reconciliation.role_assignment_backfilled', {
            clientId: client.id,
            kisiUserId: assignment.userId,
            hardwareGroupId: assignment.groupId,
            roleAssignmentId: assignment.roleAssignmentId,
            sourceRowsUpdated: backfillResult.rowCount,
            traceId: this._sweepTraceId,
            stage: 'reconcile', result: 'backfilled',
          });
        }
      } catch (err) {
        log.error('reconciliation.role_assignment_backfill_failed', {
          clientId: client.id, kisiUserId: assignment.userId, hardwareGroupId: assignment.groupId,
        }, err);
      }
    }

    log.info('reconciliation.pass_1_2_complete', {
      clientId: client.id, promoted, backfilled, traceId: this._sweepTraceId,
    });

    // ── Pass 1.5: Holder-lapse → sub-member removal proposals (OB-247) ──
    // A sub-member's door rides on its holder's plan. Phase 1 (2026-09-10)
    // judges that from WIX, not from the holder's member_access.status: for
    // each ACTIVE sub-member source (member_access_sources.source_plan_id), the
    // holder (member_master via member_access.sub_master_id) must hold a PAYING
    // plan with that same source_plan_id in either Wix read (wixMembers). The
    // old DB predicate wrongly lapsed the subs of a holder who had only released
    // their OWN seat (DR-051) while still paying.
    //
    // Per-source semantics (OB-150 invariant): one proposal per (sub, source
    // plan), each with planId set so a future targeted revoke hits the right
    // source row. No Kisi calls in this pass.
    //
    // Phase 1: every lapse is a PROPOSAL (dataSource wix_orders), recorded and
    // held by the removal decision below, plus a deduplicated
    // revoke_holder_lapse_pending alert. Nothing is enqueued.
    //
    // Fix round (2026-09-10): a lapse is proposed only when the HOLDER's Wix
    // classification for the sub's plan (best across both reads) is ENDED or
    // ABSENT (P-2). A holder whose payment is declined, pending or
    // unrecognised — or who cannot be found at all — leaves the sub alone:
    // held_payment_state, never a proposal (Phase 4 handles suspension). Every
    // proposal is keyed to its family's unit, the holder (P-1) — a holder that
    // is never the sub itself (fix round 3: the policy's unit rule).
    let subMemberRevokesProposed = 0;
    let lapsedSubsFound = 0;
    let subsHeldPaymentState = 0;
    // Every sub examined here (logged as subsExamined).
    const pass15SubKeys = new Set();
    // The family units this pass contributes to the wix_orders population: the
    // HOLDER of every active sub source that could be proposed, seated or not.
    // A source held for its holder's payment state can never be proposed, so
    // it is not at risk and does not count.
    const pass15HolderUnits = new Set();
    try {
      const subSourcesResult = await db.query(
        `SELECT DISTINCT sub.id AS sub_access_id,
                sub_mm.platform_member_id,
                holder_mm.platform_member_id AS holder_platform_member_id,
                mas.source_plan_id
         FROM member_access sub
         JOIN member_master sub_mm ON sub_mm.id = sub.member_master_id
         JOIN member_access_sources mas
           ON mas.access_id = sub.id
          AND mas.status = 'active'
          AND mas.source_plan_id IS NOT NULL
         LEFT JOIN member_master holder_mm
                ON holder_mm.id        = sub.sub_master_id
               AND holder_mm.client_id = sub.client_id
         WHERE sub.client_id      = $1
           AND sub.sub_master_id IS NOT NULL
           AND sub.status         = 'active'`,
        [client.id]
      );

      const lapsedSubAccessIds = new Set();
      const heldSubAccessIds   = new Set();
      for (const source of subSourcesResult.rows) {
        if (source.platform_member_id) pass15SubKeys.add(source.platform_member_id);
        // A holder that resolves to the sub ITSELF (a corrupt sub_master_id that
        // points at the sub's own member_master row) is no holder at all: treated
        // as unresolvable, so the source is held as UNKNOWN below. Proposed, it
        // would carry unitKey === memberKey — a HOLDER_LAPSE shape the removal
        // policy refuses as unit_structure_invalid, holding the whole batch as an
        // invalid_proposal anomaly every sweep (fix round 3, R3-1).
        const holderKey = (source.holder_platform_member_id
          && source.holder_platform_member_id !== source.platform_member_id)
          ? source.holder_platform_member_id
          : null;
        // The holder's classification for the sub's plan, best across both reads.
        // No resolvable holder → UNKNOWN: nothing is known about who pays for this
        // seat, so it is never a removal (it used to be proposed as ABSENT).
        const holderClass = holderKey ? classOf(holderKey, source.source_plan_id) : ORDER_CLASS.UNKNOWN;
        if (holderKey && !isHeldPaymentClass(holderClass)) pass15HolderUnits.add(holderKey);
        // The sub keeps its door while the holder pays for this plan (either read).
        if (holderKey && isPayingPlan(holderKey, null, source.source_plan_id)) continue;

        if (isRemovableClass(holderClass)) {
          lapsedSubAccessIds.add(source.sub_access_id);
          const subTraceId = mintTraceId();
          const syntheticEvent = {
            eventType:        'plan.cancelled',
            platformMemberId: source.platform_member_id,
            sourcePlatform:   'wix',
            planId:           source.source_plan_id,
            synthetic:        true,
            traceId:          subTraceId,
          };
          const jobId = `pass1.5-${source.sub_access_id}-${source.source_plan_id}-${Date.now()}`;
          // Proposal only — recorded and held (Phase 1). sub_member_holder_lapsed
          // is emitted only when a revoke is actually enqueued (Phase 3b).
          revokeProposals.push({
            source:         REVOKE_SOURCE.HOLDER_LAPSE,
            dataSource:     DATA_SOURCE.WIX_ORDERS,
            memberKey:      source.platform_member_id,
            unitKey:        holderKey, // the family's unit (P-1)
            planId:         source.source_plan_id,
            accessId:       source.sub_access_id,
            holderKey,
            classification: holderClass,
            syntheticEvent,
            jobId,
          });
          subMemberRevokesProposed++;
        } else {
          // Declined / pending / unrecognised holder payment, or no holder found:
          // the sub is left alone. Recorded, never proposed; subs carry no clock.
          heldSubAccessIds.add(source.sub_access_id);
          heldPaymentState.push({
            source:         REVOKE_SOURCE.HOLDER_LAPSE,
            dataSource:     DATA_SOURCE.WIX_ORDERS,
            memberKey:      source.platform_member_id,
            unitKey:        unitKeyOf(source.platform_member_id, holderKey),
            planId:         source.source_plan_id,
            accessId:       source.sub_access_id,
            holderKey,
            classification: holderClass,
          });
        }
      }
      lapsedSubsFound      = lapsedSubAccessIds.size;
      subsHeldPaymentState = heldSubAccessIds.size;

      log.info('reconciliation.pass_1_5_complete', {
        clientId:               client.id,
        subsExamined:           pass15SubKeys.size,
        lapsedSubsFound,
        // Field name kept for log continuity; it counts PROPOSALS (one per
        // lapsed sub source) — Phase 1 records and holds them, enqueues none.
        subMemberRevokesQueued: subMemberRevokesProposed,
        // Subs left alone because their holder's payment is declined, pending
        // or unrecognised (or the holder cannot be found).
        subsHeldPaymentState,
        traceId:                this._sweepTraceId,
      });
    } catch (err) {
      log.error('reconciliation.pass_1_5_failed', { clientId: client.id }, err);
    }

    // ── Active-source census ───────────────────────────────────────────────────
    // Every AccessSync-managed member with an ACTIVE, plan-scoped source row, read
    // AFTER Pass 1 (so rows it just promoted or inserted for paying members count).
    // Feeds 3B's candidates and the populations the removal policy judges volume
    // against. A failed read skips 3B (no observation, no proposal); grants are
    // unaffected.
    let census = null; // memberKey → { accessId, isSub, sources: Map<planId, sourceType> }
    try {
      const censusResult = await db.query(
        `SELECT ma.id AS access_id, mm.platform_member_id, ma.sub_master_id,
                mas.source_type, mas.source_plan_id
         FROM member_access_sources mas
         JOIN member_access ma ON ma.id = mas.access_id
         JOIN member_master mm ON mm.id = ma.member_master_id
         WHERE ma.client_id = $1
           AND mas.status = 'active'
           AND mas.source_plan_id IS NOT NULL
           AND mm.source_tag = 'accesssync'
         ORDER BY mm.platform_member_id, mas.source_plan_id, mas.source_type`,
        [client.id]
      );
      census = new Map();
      for (const row of censusResult.rows) {
        const memberKey = row.platform_member_id;
        if (!memberKey) continue;
        let entry = census.get(memberKey);
        if (!entry) {
          entry = {
            accessId: row.access_id,
            isSub:    row.sub_master_id != null || String(memberKey).includes('###as'),
            sources:  new Map(),
          };
          census.set(memberKey, entry);
        }
        if (!entry.sources.has(row.source_plan_id)) entry.sources.set(row.source_plan_id, row.source_type || null);
      }
    } catch (err) {
      census = null;
      log.warn('reconciliation.active_source_census_failed', { clientId: client.id, traceId: this._sweepTraceId }, err);
    }

    // ── Not-paying strike clocks (migrations/reconcile-not-paying-strike.sql) ──
    // Read once: the (access, plan) pairs that carry a clock right now. Before
    // that migration is applied the columns do not exist (Postgres 42703): no
    // clock is read, started or cleared — so nothing can ever become eligible
    // for removal (fail safe). Any OTHER read failure (fix round 3, R3-4): every
    // proposal carries no strike, no clock is advanced this sweep, and the
    // clears are widened to every PAYING (member, plan) in the census — see
    // "when strike clocks may move" after the removal decision.
    const strikeClocks = new Map(); // memberPlanKey(accessId, planId) → { since, observations }
    let strikeColumnsMissing = false;
    let strikeReadFailed     = false;
    if (census && census.size > 0) {
      try {
        const strikeResult = await db.query(
          `SELECT access_id, source_plan_id,
                  MIN(not_paying_since)        AS not_paying_since,
                  MAX(not_paying_observations) AS not_paying_observations
           FROM member_access_sources
           WHERE client_id = $1
             AND status = 'active'
             AND source_plan_id IS NOT NULL
             AND (not_paying_since IS NOT NULL OR COALESCE(not_paying_observations, 0) > 0)
           GROUP BY access_id, source_plan_id`,
          [client.id]
        );
        for (const row of strikeResult.rows) {
          const observations = Number(row.not_paying_observations);
          strikeClocks.set(memberPlanKey(row.access_id, row.source_plan_id), {
            since:        toIsoOrNull(row.not_paying_since),
            observations: Number.isInteger(observations) && observations >= 0 ? observations : 0,
          });
        }
      } catch (err) {
        if (err && err.code === '42703') {
          strikeColumnsMissing = true;
          if (!this._strikeColumnsMissingWarned) {
            this._strikeColumnsMissingWarned = true;
            log.warn('reconciliation.strike_clock_unavailable', {
              clientId: client.id, migration: 'migrations/reconcile-not-paying-strike.sql',
            });
          }
        } else {
          // The one warn for this sweep's read failure (R3-4). strikeClocks
          // stays empty, so no proposal carries a strike.
          strikeReadFailed = true;
          log.warn('reconciliation.strike_read_failed', {
            clientId: client.id, errorCode: (err && err.code) || null,
          }, err);
        }
      }
    }

    // 3B. Provisioned PRIMARY members PAYING in NEITHER Wix read → one removal
    //     proposal per active source plan (OB-150: each carries planId), with
    //     dataSource from the source's source_type (plan → wix_orders,
    //     booking → wix_bookings). Phase 1: recorded and held — nothing is
    //     enqueued (the old plan-less 3B revoke was also a silent no-op in
    //     processRevoke). Sub-members are judged by Pass 1.5, never here.
    //
    //     Fix round (2026-09-10):
    //       · Only a (member, plan) classified ENDED or ABSENT (best across both
    //         reads) is proposed, carrying that classification (P-2). DECLINED,
    //         PENDING or UNKNOWN is not a cancellation: held_payment_state —
    //         recorded without a strike, its clock cleared after the decision,
    //         alerted once, never proposed and never counted in a population.
    //       · A proposal carries its strike clock AS THE DB HAS IT, before this
    //         sweep. The clock is advanced only after the removal decision, and
    //         only when that decision is not an anomaly hold and the clocks
    //         could be read (see "when strike clocks may move" below).
    //       · A primary member is its own unit (P-1): unitKey = memberKey.
    const now = Date.now();
    let sourcesSkippedNonWix = 0;
    if (census) {
      for (const [memberKey, entry] of census) {
        if (entry.isSub) continue;
        if (payingPlansByMember.has(memberKey)) continue; // PAYING in either read → never a candidate
        for (const [planId, sourceType] of entry.sources) {
          const dataSource = SOURCE_TYPE_DATA_SOURCE[sourceType];
          if (!dataSource) { sourcesSkippedNonWix++; continue; }

          const classification = classOf(memberKey, planId);
          if (!isRemovableClass(classification)) {
            // Declined / pending / unrecognised payment — left alone (Phase 4
            // handles suspension). No strike, no proposal.
            heldPaymentState.push({
              source:         REVOKE_SOURCE.WIX_ABSENCE,
              dataSource,
              memberKey,
              unitKey:        memberKey,
              planId,
              accessId:       entry.accessId,
              classification,
            });
            continue;
          }

          // The clock as the DB has it, before this sweep's observation — null
          // when none has started or the strike columns are not migrated (never
          // eligible for removal).
          const clock  = strikeColumnsMissing ? null : strikeClocks.get(memberPlanKey(entry.accessId, planId));
          const strike = clock ? { since: clock.since, observations: clock.observations } : null;

          const recoEventId = `recon-${client.id}-${memberKey}-${planId}-${Date.now()}`;
          const syntheticEvent = {
            eventType:        'plan.cancelled',
            sourcePlatform:   'wix',
            platformMemberId: memberKey,
            planId,
            wixSiteId:        siteId,
            synthetic:        true,
            // 3b: a DR-050 allow-listed source (reconciliation.wix_not_paying) when armed.
            syntheticSource:  'reconciliation.true_source_sync',
            traceId:          this._sweepTraceId || crypto.randomUUID(),
            eventId:          recoEventId,
          };
          revokeProposals.push({
            source:         REVOKE_SOURCE.WIX_ABSENCE,
            dataSource,
            memberKey,
            unitKey:        memberKey,
            planId,
            accessId:       entry.accessId,
            classification,
            strike,
            eventId:        recoEventId,
            syntheticEvent,
            jobId:          `revoke-wix-sync-${client.id}-${memberKey}-${planId}-${Date.now()}`,
          });
        }
      }
    }

    // ── Removal decision — ONE decision over every removal this sweep proposed ──
    //
    // Phase 1 (2026-09-10): observationOnly — evaluateRemovals holds the whole
    // batch whatever clients.auto_revoke_mode says, and there is NO flush: no
    // code path in this sweep enqueues a revoke. Anomalies (invalid input, the
    // two Wix reads disagreeing too much, more than half of a population at
    // once) are still judged first, so an operator learns the data looks wrong
    // even while removals are paused.
    //
    // Populations at risk (core/revoke-policy.js), each a set of distinct UNITS
    // (P-1: a family — the holder plus its subs — is ONE unit, keyed by the
    // holder's platform_member_id; everyone else is their own unit):
    //   wix_orders   — primaries with an active 'plan' source, plus the holder
    //                  of every active sub source Pass 1.5 examined, seated or not
    //   wix_bookings — primaries with an active 'booking' source (3B only
    //                  proposes primaries, so subs never pad this denominator)
    //   kisi         — the units of Pass 3's rows (active, provisioned,
    //                  AccessSync-tagged)
    // A (member, plan) held for its payment state (DECLINED / PENDING /
    // UNKNOWN — for a sub, its holder's) can never be proposed, so it is not at
    // risk: it is left out of both Wix populations, and a unit with no other
    // source there does not count at all. Holding it out only ever shrinks a
    // denominator, which tightens the caps. Kisi keeps every provisioned unit:
    // Pass 3's findings follow Kisi, not Wix payments, and P-2 exempts them.
    // currentManaged is the size of the union. By construction every
    // proposal's unitKey is in its own data source's set (3B from the census,
    // HOLDER_LAPSE from the Pass 1.5 rows, Pass 3 from its own rows), hence in
    // the union; the check below warns if that ever stops being true.
    const wixOrdersPop   = new Set(pass15HolderUnits);
    const wixBookingsPop = new Set();
    if (census) {
      for (const [memberKey, entry] of census) {
        if (entry.isSub) continue;
        for (const [planId, sourceType] of entry.sources) {
          if (isHeldPaymentClass(classOf(memberKey, planId))) continue;
          if (sourceType === 'plan')    wixOrdersPop.add(memberKey);
          if (sourceType === 'booking') wixBookingsPop.add(memberKey);
        }
      }
    }
    const populationSets = {
      [DATA_SOURCE.WIX_ORDERS]:   wixOrdersPop,
      [DATA_SOURCE.WIX_BOOKINGS]: wixBookingsPop,
      [DATA_SOURCE.KISI]:         pass3UnitKeys,
    };
    const populationByDataSource = {
      [DATA_SOURCE.WIX_ORDERS]:   wixOrdersPop.size,
      [DATA_SOURCE.WIX_BOOKINGS]: wixBookingsPop.size,
      [DATA_SOURCE.KISI]:         pass3UnitKeys.size,
    };
    const managedUnits   = new Set([...wixOrdersPop, ...wixBookingsPop, ...pass3UnitKeys]);
    const currentManaged = managedUnits.size;

    const outsidePopulation = revokeProposals.filter(p => {
      const pop  = populationSets[p.dataSource];
      const unit = proposalUnit(p);
      return !pop || !pop.has(unit) || !managedUnits.has(unit);
    });
    if (outsidePopulation.length > 0) {
      log.warn('reconciliation.proposal_population_mismatch', {
        clientId: client.id, count: outsidePopulation.length,
        bySource: countBySource(outsidePopulation), traceId: this._sweepTraceId,
      });
    }

    const decision = evaluateRemovals({
      proposals:       revokeProposals,
      currentManaged,
      populationByDataSource,
      readDisagreement,
      mode,
      observationOnly: SWEEP_OBSERVATION_ONLY,
      now,
      strikePolicy:    DEFAULT_STRIKE_POLICY,
    });
    // Phase 1 has no flush loop. observationOnly leaves decision.flush empty;
    // should a future edit ever change that, the flush is ignored here, loudly.
    if (Array.isArray(decision.flush) && decision.flush.length > 0) {
      log.warn('reconciliation.flush_ignored_observation_only', {
        clientId: client.id, flushCount: decision.flush.length, traceId: this._sweepTraceId,
      });
    }

    // Why the decision held, if it did.
    //   · A non-empty batch is always held in Phase 1 (observation-only); its
    //     reason is the policy's.
    //   · An EMPTY batch is still judged (fix round 3, R3-5): the policy holds
    //     it when the two reads themselves disagreed too much
    //     (SNAPSHOT_UNSTABLE) — or, were the populations ever malformed, as
    //     INVALID_PROPOSAL (also the fallback should a hold ever come back
    //     without a reason). That is an anomaly like any other: the
    //     de-duplicated anomaly alert, the run closed 'aborted', no clock
    //     advanced, per-member alerts suppressed (F9). A clean empty batch has
    //     no hold reason, as before.
    const holdReason = revokeProposals.length > 0
      ? (decision.reason || REVOKE_HOLD_REASON.OBSERVATION_ONLY)
      : (decision.action === 'hold' ? (decision.reason || REVOKE_HOLD_REASON.INVALID_PROPOSAL) : null);
    const anomalyHold = holdReason !== null && ANOMALY_HOLD_REASONS.includes(holdReason);

    // ── When strike clocks may move (fix round 3 — Phase 3b depends on this) ──
    // THE RULE: an anomaly-held sweep never ADVANCES a clock; clears always
    // run, because clearing only ever delays a removal.
    //
    // The proposals above carried each clock exactly as the DB had it, and the
    // decision is made. Now:
    //   · ADVANCE — one not-paying observation per WIX_ABSENCE proposal — only
    //     when the decision's reason is NOT an anomaly hold (INVALID_PROPOSAL,
    //     SNAPSHOT_UNSTABLE, MASS_REVOKE; an empty batch held for
    //     SNAPSHOT_UNSTABLE included), and only when this sweep could read the
    //     existing clocks (a non-42703 read failure freezes it too). A run of
    //     reads that cannot be trusted must never ripen anyone's strike.
    //   · CLEAR — in EVERY sweep, anomaly hold or not:
    //       (a) every (member, plan) PAYING in either read that carries a
    //           clock — and, when the clock read failed, every PAYING
    //           (member, plan) in the census, since which ones carry a clock
    //           is unknown;
    //       (b) every held_payment_state (member, plan) (F2): a declined,
    //           pending or unrecognised payment never keeps a removal clock
    //           running.
    //     A clear can only make a member look NEWER to the strike, never older
    //     — it can only delay a removal — so it is safe on any read, even one
    //     the anomaly says cannot be trusted. Skipping it is what let a stale
    //     clock outlive a held sweep: a member who paid again during a
    //     MASS_REVOKE hold kept their old clock, and their next lapse started
    //     out already ripe.
    // Primaries only: nothing ever starts a clock on a sub. The L3 primitives
    // write only a row that carries a clock, and never throw. Before the strike
    // migration (42703) no clock is read, advanced or cleared at all.
    let notPayingObserved = 0;
    let strikesCleared    = 0;
    let heldClocksCleared = 0;
    // Why no clock may be advanced this sweep, if none may. Never stops a clear.
    const strikeAdvanceFrozenReason = anomalyHold
      ? 'anomaly_hold'
      : (strikeReadFailed ? 'strike_read_failed' : null);
    const strikeAdvanceFrozen = strikeAdvanceFrozenReason !== null;
    const strikeAdvanced      = new Set(); // proposals whose observation this sweep recorded

    // ADVANCE — never on an anomaly hold, never on an unreadable clock.
    if (!strikeAdvanceFrozen) {
      for (const p of revokeProposals) {
        if (strikeColumnsMissing) break;
        if (p.source !== REVOKE_SOURCE.WIX_ABSENCE) continue;
        let rec = null;
        try {
          rec = await standardAdapter.recordNotPayingObservation(p.accessId, p.planId);
        } catch (err) {
          log.warn('reconciliation.strike_record_failed', {
            clientId: client.id, accessId: p.accessId, sourcePlanId: p.planId,
          }, err);
        }
        if (rec && rec.recorded === true && rec.rowCount > 0) {
          strikeAdvanced.add(p);
          notPayingObserved++;
        } else if (rec && rec.reason === 'columns_missing') {
          strikeColumnsMissing = true; // stop calling for the rest of this sweep
        }
      }
    }

    // CLEAR (a) — always: a (member, plan) PAYING again in either read resets
    // its clock.
    if (census && !strikeColumnsMissing && (strikeReadFailed || strikeClocks.size > 0)) {
      for (const [memberKey, entry] of census) {
        if (strikeColumnsMissing) break;
        if (entry.isSub) continue; // sub-members carry no clock of their own
        for (const planId of entry.sources.keys()) {
          if (strikeColumnsMissing) break;
          if (!isPayingPlan(memberKey, null, planId)) continue;
          // Clock read OK: only the pairs that carry one. Read failed: every
          // PAYING pair — the primitive leaves a row without a clock untouched.
          if (!strikeReadFailed && !strikeClocks.has(memberPlanKey(entry.accessId, planId))) continue;
          try {
            const res = await standardAdapter.clearNotPayingObservation(entry.accessId, planId);
            if (res && res.cleared && res.rowCount > 0) strikesCleared++;
            else if (res && res.reason === 'columns_missing') strikeColumnsMissing = true;
          } catch (err) {
            log.warn('reconciliation.strike_clear_failed', {
              clientId: client.id, accessId: entry.accessId, sourcePlanId: planId,
            }, err);
          }
        }
      }
    }

    // CLEAR (b) — always: a declined / pending / unrecognised payment stops any
    // running clock. Called for every such (member, plan), whatever the clock
    // read said — the primitive only writes a row that actually carries one.
    for (const h of heldPaymentState) {
      if (strikeColumnsMissing) break;
      if (h.source !== REVOKE_SOURCE.WIX_ABSENCE) continue;
      try {
        const res = await standardAdapter.clearNotPayingObservation(h.accessId, h.planId);
        if (res && res.cleared && res.rowCount > 0) heldClocksCleared++;
        else if (res && res.reason === 'columns_missing') strikeColumnsMissing = true;
      } catch (err) {
        log.warn('reconciliation.strike_clear_failed', {
          clientId: client.id, accessId: h.accessId, sourcePlanId: h.planId,
        }, err);
      }
    }

    if (revokeProposals.length > 0) {
      const heldKeys = [...new Set(revokeProposals.map(p => p.memberKey))];
      log.warn('reconciliation.revokes_held', {
        clientId:         client.id,
        reason:           holdReason,
        detail:           decision.detail || null,
        dataSource:       decision.dataSource || null,
        mode,
        observationOnly:  SWEEP_OBSERVATION_ONLY,
        heldCount:        revokeProposals.length,
        heldMembers:      heldKeys.length,
        // What every cap counts (P-1): a family is one unit.
        heldUnits:        new Set(revokeProposals.map(proposalUnit)).size,
        bySource:         countBySource(revokeProposals),
        byDataSource:     countByDataSource(revokeProposals),
        // How many would clear the strike clock — what 'on' would act on once
        // Phase 3b arms removal. A preview only.
        strikeReady:      decision.counts ? decision.counts.strikeReady : null,
        // No clock was advanced this sweep, and why (clears still ran).
        strikeAdvanceFrozen,
        strikeAdvanceFrozenReason,
        sampleMemberKeys: heldKeys.slice(0, 10),
        traceId:          this._sweepTraceId,
      });
    }
    if (heldPaymentState.length > 0) {
      const heldUnitKeys = [...new Set(heldPaymentState.map(h => h.unitKey))];
      log.warn('reconciliation.payment_state_held', {
        clientId:         client.id,
        heldCount:        heldPaymentState.length,
        heldUnits:        heldUnitKeys.length,
        bySource:         countBySource(heldPaymentState),
        byClassification: countByClassification(heldPaymentState),
        clocksCleared:    heldClocksCleared,
        strikeAdvanceFrozen,
        strikeAdvanceFrozenReason,
        sampleUnitKeys:   heldUnitKeys.slice(0, 10),
        traceId:          this._sweepTraceId,
      });
    }
    if (repairProposals.length > 0) {
      const repairKeys = [...new Set(repairProposals.map(p => p.memberKey))];
      log.warn('reconciliation.repairs_pending', {
        clientId:         client.id,
        repairCount:      repairProposals.length,
        repairMembers:    repairKeys.length,
        bySource:         countBySource(repairProposals),
        sampleMemberKeys: repairKeys.slice(0, 10),
        traceId:          this._sweepTraceId,
      });
    }

    // ── Operator alerts (config_alert_log, de-duplicated) ─────────────────────
    // Anomaly: ONE alert for the batch — an empty batch held as an anomaly
    // included (R3-5). Its hardware_ref names the condition, not counts, so a
    // condition that persists alerts once until an operator resolves it (the
    // counts are in reconciliation.revokes_held / wix_reads_disagreed).
    if (anomalyHold) {
      await this._insertAlertOnce(
        client.id,
        ANOMALY_ALERT_TYPE[holdReason] || `revoke_${holdReason}`,
        [holdReason, decision.dataSource, decision.detail].filter(Boolean).join(':')
      );
    }
    // Paying members whose door is missing in Kisi — one alert per member.
    for (const memberKey of new Set(repairProposals.map(p => p.memberKey))) {
      await this._insertAlertOnce(client.id, SWEEP_ALERT.REPAIR_PENDING, `member:${memberKey}`);
    }
    // Per-member alerts (fix round F9). Kept when the batch is held for
    // MASS_REVOKE — that hold is about volume; each member's evidence still
    // stands. Suppressed only for SNAPSHOT_UNSTABLE and INVALID_PROPOSAL, where
    // the per-member evidence itself cannot be trusted and the anomaly alert
    // above already tells the operator. Everything is still recorded below.
    const perMemberAlertsSuppressed = holdReason !== null
      && PER_MEMBER_ALERT_SUPPRESSING_REASONS.includes(holdReason);
    if (!perMemberAlertsSuppressed) {
      const holderLapseKeys = new Set(revokeProposals
        .filter(p => p.source === REVOKE_SOURCE.HOLDER_LAPSE).map(p => p.memberKey));
      for (const memberKey of holderLapseKeys) {
        await this._insertAlertOnce(client.id, SWEEP_ALERT.HOLDER_LAPSE_PENDING, `member:${memberKey}`);
      }
      const notPayingKeys = new Set(revokeProposals
        .filter(p => p.source === REVOKE_SOURCE.WIX_ABSENCE).map(p => p.memberKey));
      for (const memberKey of notPayingKeys) {
        await this._insertAlertOnce(client.id, SWEEP_ALERT.REMOVAL_PENDING, `member:${memberKey}`);
      }
      // Declined / pending / unrecognised payments — ONE alert per unit: a
      // family whose holder's payment is declined is one alert (naming the
      // holder), not one per seat. De-duplicated like the rest.
      for (const unitKey of new Set(heldPaymentState.map(h => h.unitKey))) {
        await this._insertAlertOnce(client.id, SWEEP_ALERT.HELD_PAYMENT_STATE, `member:${unitKey}`);
      }
    }

    // ── Proposal log (reconciliation_proposal) — every proposal, one INSERT ────
    const proposalRecords = [
      ...revokeProposals.map(p => this._proposalRecord(p, PROPOSAL_KIND.REMOVAL_PENDING, holdReason, {
        mode, decision, payingInRead, strikeAdvanced: strikeAdvanced.has(p),
      })),
      // Repairs are not armed in Phase 1 either (3a) — held, observation only.
      ...repairProposals.map(p => this._proposalRecord(p, PROPOSAL_KIND.REPAIR_PENDING, REVOKE_HOLD_REASON.OBSERVATION_ONLY, { mode, decision: null, payingInRead })),
      // Declined / pending / unrecognised payments — recorded, never proposed:
      // no strike, and no policy decision (they never reach the policy).
      ...heldPaymentState.map(h => this._proposalRecord(h, PROPOSAL_KIND.HELD_PAYMENT_STATE, HELD_PAYMENT_STATE_REASON, { mode, decision: null, payingInRead })),
    ];
    const proposalsRecorded = await this._recordProposals(client.id, runId, proposalRecords);

    // reconciliation_run: the "sanity gate" is the policy's instability /
    // mass-revoke check. In v3 a tripped gate always holds the batch, so it
    // never resolves to a proceed.
    const sanityGateTriggered = holdReason === REVOKE_HOLD_REASON.SNAPSHOT_UNSTABLE
      || holdReason === REVOKE_HOLD_REASON.MASS_REVOKE;
    const sanityGateResolved  = sanityGateTriggered ? false : null;

    // 3A. In Wix, not in Kisi → paid but not provisioned → queue grant.
    //
    //     DR-049 (2026-07-26): multi-member plan holders auto-receive their own door-access
    //     seat, matching every other plan type and matching the real-time Wix webhook path
    //     (queue-worker.js → grant-revoke.js processGrant), which has never had an opt-in
    //     check. This sweep previously invented its own "opt-in holder rule" here — code
    //     comments misattributed it to "DR-040," but DR-040 is a schema/quota decision, not
    //     a behavioral one; no decision record ever locked an opt-in requirement. That left
    //     a silent inconsistency: a member's real-time purchase granted them a seat
    //     immediately, but if that same grant needed backfilling via this nightly/manual
    //     sweep (e.g. the original webhook failed), the sweep would refuse to restore it.
    //     Holders can still self-serve leave a specific plan without losing others
    //     (holder-release-slot, DR-048) and rejoin (holder-claim-slot) — this only removes
    //     the sweep's own invented default, it does not touch that self-serve flow.
    for (const [memberId, wixData] of wixMembers) {
      if (kisiMembers.has(memberId)) continue;

      if (!wixData.plans || wixData.plans.length === 0) {
        log.warn('reconciliation.wix_order_no_plan_id', { clientId: client.id, memberId });
        continue;
      }

      // Queue one grant per Wix plan the member holds. Multi-plan members produce
      // multiple grant events (each with its own planId), so each plan's source row
      // gets correctly provisioned to its mapped hardware group.
      for (const plan of wixData.plans) {
        if (!plan.planId) continue;

        const recoEventId = `recon-${client.id}-${memberId}-${plan.planId}-${Date.now()}`;
        const traceId = this._sweepTraceId || crypto.randomUUID();
        const syntheticEvent = {
          eventType:        'plan.purchased',
          sourcePlatform:   'wix',
          platformMemberId: memberId,
          planId:           plan.planId,
          email:            wixData.email,
          name:             wixData.name,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.true_source_sync',
          traceId,
          eventId:          recoEventId,
        };

        const jobId = `grant-wix-sync-${client.id}-${memberId}-${plan.planId}-${Date.now()}`;
        await eventQueue.add('grant', { tenantId: client.id, standardEvent: syntheticEvent }, { jobId });
        log.info('reconciliation.grant_queued', {
          clientId: client.id,
          platformMemberId: memberId,
          planId: plan.planId, jobId, eventId: recoEventId,
          traceId: this._sweepTraceId,
          sourceType: 'cron', stage: 'cron', result: 'success',
        });
        granted++;
      }
    }

    // Paying-member count, kept for the dashboard. No longer a policy input:
    // revoke-policy v3 judges against the population actually at risk.
    await db.query(
      `UPDATE clients SET last_active_member_count = $1 WHERE id = $2`,
      [wixMembers.size, client.id]
    ).catch(() => {});

    // Close the audit row
    if (runId) await db.query(
      `UPDATE reconciliation_run
         SET status = $1, completed_at = NOW(),
             wix_active_count = $2, kisi_managed_count = $3,
             grants_queued = $4, revokes_queued = $5, grants_skipped_optin = $6,
             sanity_gate_triggered = $7, sanity_gate_resolved = $8,
             abort_reason = $9
       WHERE id = $10`,
      [
        // A data anomaly aborts the run; observation-only, dry_run and off are
        // intentional holds, so the run still succeeded.
        anomalyHold ? 'aborted' : 'success',
        wixMembers.size, kisiMembers.size,
        granted, revoked, skippedHolderOptin,
        sanityGateTriggered, sanityGateResolved,
        // null unless removals were proposed (then why they were held) or an
        // empty batch was held as an anomaly (R3-5: the reads disagreed too much)
        holdReason,
        runId,
      ]
    ).catch(e => log.error('reconciliation.run_close_failed', { runId }, e));

    log.info('reconciliation.client_sync_complete', {
      clientId: client.id, siteId, runId,
      wixActive: wixMembers.size, kisiManaged: kisiMembers.size,
      granted, revoked, skippedHolderOptin,
      sanityGateTriggered, sanityGateResolved,
      heldRevokes: revokeProposals.length, holdReason,
      repairsPending: repairProposals.length,
      heldPaymentState: heldPaymentState.length,
      observationOnly: SWEEP_OBSERVATION_ONLY, proposalsRecorded, mode,
      readDisagreement, notPayingObserved, strikesCleared, heldClocksCleared,
      strikeAdvanceFrozen, strikeAdvanceFrozenReason, sourcesSkippedNonWix,
    });

    return this._syncResult({
      granted, revoked, skippedHolderOptin, runId, sanityGateTriggered, sanityGateResolved,
      heldRevokes: revokeProposals.length, holdReason, proposalsRecorded,
    });
  }

  /**
   * One reconciliation_proposal row (see _recordProposals). decision is always
   * 'held' in Phase 1; hold_reason is the policy's reason (removals),
   * observation_only (repairs, which Phase 1 does not perform either) or
   * payment_state_not_removable (held_payment_state — never proposed).
   *
   * evidence.strike is the clock the policy judged — as the DB had it BEFORE
   * this sweep; evidence.strikeAdvanced says whether this sweep then recorded
   * an observation on it (never during an anomaly hold, nor when the clock
   * read failed).
   */
  _proposalRecord(p, kind, holdReason, { mode, decision, payingInRead, strikeAdvanced = false }) {
    const judgeKey = p.holderKey || p.memberKey;
    return {
      platformMemberId: p.memberKey,
      sourcePlanId:     p.planId || null,
      hardwareGroupId:  p.hardwareGroupId || null,
      kind,
      source:           p.source,
      dataSource:       p.dataSource,
      classification:   p.classification || null,
      decision:         'held',
      holdReason,
      evidence: {
        accessId:            p.accessId || null,
        hardwareUserId:      p.hardwareUserId || null,
        holderKey:           p.holderKey || null,
        unitKey:             p.unitKey || null,
        strike:              p.strike || null,
        strikeAdvanced:      !!strikeAdvanced,
        // Member-level: paying on ANY plan in that read (sub-members: their holder).
        memberPayingInRead1: payingInRead[0].has(judgeKey),
        memberPayingInRead2: payingInRead[1].has(judgeKey),
        mode,
        observationOnly:     SWEEP_OBSERVATION_ONLY,
        policyDetail:        decision ? (decision.detail || null) : null,
        policyDataSource:    decision ? (decision.dataSource || null) : null,
      },
    };
  }

  /**
   * Enqueue one revoke the removal policy approved. On success, emit the same
   * per-source event — same name, level and fields — that the inline code
   * emitted before the gate existed, so the trace timeline reads as it always
   * has. Each item has its own try/catch: one failed enqueue never stops the rest.
   *
   * KEPT FOR PHASE 3b, which re-arms sweep removals through it. In Phase 1
   * nothing calls it — and it refuses anyway while SWEEP_OBSERVATION_ONLY is
   * true, so no future call site can reach the queue by accident.
   *
   * @param {string} clientId
   * @param {Object} p  a proposal from _syncClient's revokeProposals
   * @returns {Promise<boolean>} true when the job reached the queue
   */
  async _enqueueApprovedRevoke(clientId, p) {
    if (SWEEP_OBSERVATION_ONLY) {
      log.warn('reconciliation.revoke_enqueue_refused_observation_only', {
        clientId, source: p && p.source, platformMemberId: p && p.memberKey,
        sourcePlanId: p && p.planId, traceId: this._sweepTraceId,
      });
      return false;
    }
    try {
      await eventQueue.add(
        'revoke',
        { tenantId: clientId, standardEvent: p.syntheticEvent },
        { jobId: p.jobId }
      );
    } catch (err) {
      switch (p.source) {
        case REVOKE_SOURCE.KISI_USER_VANISHED:
        case REVOKE_SOURCE.ROLE_DRIFT:
          log.error('reconciliation.pass_3_revoke_queue_failed', {
            clientId, accessId: p.accessId, sourcePlanId: p.planId,
          }, err);
          break;
        case REVOKE_SOURCE.HOLDER_LAPSE:
          log.error('reconciliation.sub_member_holder_lapsed_queue_failed', {
            clientId,
            subAccessId:  p.accessId,
            sourcePlanId: p.planId,
            traceId:      p.syntheticEvent.traceId,
          }, err);
          break;
        case REVOKE_SOURCE.WIX_ABSENCE:
        default:
          // 3B had no catch before — one failed enqueue aborted the whole client sync.
          log.error('reconciliation.revoke_queue_failed', {
            clientId, platformMemberId: p.memberKey, jobId: p.jobId, source: p.source,
            traceId: this._sweepTraceId,
          }, err);
      }
      return false;
    }

    switch (p.source) {
      case REVOKE_SOURCE.KISI_USER_VANISHED:
        log.warn('reconciliation.kisi_user_disappeared_confirmed', {
          clientId,
          accessId:         p.accessId,
          platformMemberId: p.memberKey,
          hardwareUserId:   p.hardwareUserId,
          sourcePlanId:     p.planId,
          traceId:          p.syntheticEvent.traceId,
          sweepTraceId:     this._sweepTraceId,
        });
        break;
      case REVOKE_SOURCE.ROLE_DRIFT:
        log.warn('reconciliation.role_assignment_drifted', {
          clientId,
          accessId:         p.accessId,
          platformMemberId: p.memberKey,
          hardwareUserId:   p.hardwareUserId,
          hardwareGroupId:  p.hardwareGroupId,
          sourcePlanId:     p.planId,
          traceId:          p.syntheticEvent.traceId,
          sweepTraceId:     this._sweepTraceId,
        });
        break;
      case REVOKE_SOURCE.HOLDER_LAPSE:
        log.info('reconciliation.sub_member_holder_lapsed', {
          clientId,
          subAccessId:      p.accessId,
          platformMemberId: p.memberKey,
          sourcePlanId:     p.planId,
          jobId:            p.jobId,
          traceId:          p.syntheticEvent.traceId,
          sweepTraceId:     this._sweepTraceId,
          stage:            'reconcile',
          result:           'revoke_queued',
        });
        break;
      case REVOKE_SOURCE.WIX_ABSENCE:
      default:
        log.info('reconciliation.revoke_queued', {
          clientId, platformMemberId: p.memberKey,
          jobId: p.jobId, eventId: p.eventId,
          traceId: this._sweepTraceId,
          sourceType: 'cron', stage: 'cron', result: 'success',
        });
    }
    return true;
  }

  /**
   * Reconcile a single member's access state against Wix and the hardware platform.
   *
   * Closes OB-49 at the per-member level: detects database drift (missing
   * member_access_sources rows) and surfaces config integrity issues that
   * require operator attention.
   *
   * Architectural rules (DR-023):
   *  - This function NEVER writes member_access or member_access_sources
   *    directly. All repairs flow through Standard Adapter Layer (L3) via the
   *    event queue, which makes completeGrant() handle the inserts idempotently.
   *  - Sub-members (sub_master_id != null OR platform_member_id contains '###as')
   *    are operator-managed and skipped; reconcile the plan holder instead.
   *
   * Result actions (one of):
   *   ok                   — DB matches Wix and hardware. No changes.
   *   repaired              — Wix says active, hardware has access, but DB rows
   *                           were missing. Synthetic grant queued to L3 to
   *                           re-insert tracking rows (Kisi call is idempotent).
   *   access_restored       — Wix active, no hardware access. Grant queued.
   *   access_removed        — No active Wix sub, but hardware still had access.
   *                           Revoke queued.
   *   revoke_held           — Same situation as access_removed, but the client's
   *                           automatic-removal mode (clients.auto_revoke_mode)
   *                           is not 'on' ('off', 'dry_run', or unreadable).
   *                           Nothing queued.
   *   needs_attention       — Integrity issue surfaced. No grant/revoke fires.
   *                           See `alerts` array. Operator must resolve.
   *   wix_unavailable       — Wix API failed. No changes made. Retry later.
   *   hardware_unavailable  — The door system's role-assignment read failed
   *                           (Kisi error or malformed page). No changes made.
   *                           Retry later.
   *   no_identity           — Member not provisioned in AccessSync (no member_master/member_access row).
   *   sub_member_skipped    — Caller passed a sub-member; reconcile plan holder instead.
   *
   * @param {string} memberId  - member_access.id (UUID)
   * @param {string} clientId  - clients.id (UUID)
   * @returns {Object} { action, granted, revoked, repaired, alerts: [...] }
   */
  async reconcileMember(memberId, clientId) {
    const traceId = crypto.randomUUID();
    return runWith(
      { traceId, actor: { type: 'system', id: 'reconcileMember' } },
      () => this._reconcileMemberBody(memberId, clientId, traceId)
    );
  }

  async _reconcileMemberBody(memberId, clientId, traceId) {
    const result = { action: null, granted: 0, revoked: 0, repaired: 0, alerts: [] };

    // 1. Load client + verify active and configured
    const clientRes = await db.query(
      `SELECT c.id, c.source_site_id, c.source_api_key,
              cs.hardware_api_key, cs.hardware_platform
       FROM clients c
       LEFT JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       WHERE c.id = $1 AND c.status = 'active'`,
      [clientId]
    );
    if (!clientRes.rows.length) {
      result.action = 'no_identity';
      result.alerts.push({ code: 'client_not_active', detail: 'Client not found or not active.' });
      return result;
    }
    const client = clientRes.rows[0];
    if (!client.source_api_key || !client.hardware_api_key) {
      result.action = 'needs_attention';
      result.alerts.push({
        code: 'client_not_configured',
        detail: 'This client is missing the Wix or hardware API key. Finish onboarding before reconciling members.',
      });
      return result;
    }

    // 2. Load member_access + member_master, guard against sub-members
    const identityRes = await db.query(
      `SELECT ma.id, mm.platform_member_id, ma.hardware_user_id, ma.sub_master_id, mm.source_tag
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.id = $1 AND ma.client_id = $2`,
      [memberId, clientId]
    );
    if (!identityRes.rows.length) {
      result.action = 'no_identity';
      result.alerts.push({
        code: 'no_member_identity',
        detail: 'No record of this member in AccessSync. They may not have been provisioned yet.',
      });
      return result;
    }
    const identity = identityRes.rows[0];
    const isSubMember = identity.sub_master_id !== null
      || (identity.platform_member_id || '').includes('###as');
    if (isSubMember) {
      result.action = 'sub_member_skipped';
      result.alerts.push({
        code: 'sub_member',
        detail: 'This is a sub-member on a multi-member plan. Reconcile the plan holder to fix sub-member access.',
      });
      return result;
    }

    const platformMemberId = identity.platform_member_id;
    const hardwareUserId   = identity.hardware_user_id;
    const wixApiKey        = decryptApiKey(client.source_api_key);
    const hardwareApiKey   = decryptApiKey(client.hardware_api_key);
    const hardwarePlatform = client.hardware_platform || 'kisi';
    const siteId           = client.source_site_id;

    // 3. Pull Wix subscriptions for this member (filtered from full list — V1)
    let activePlans;
    try {
      const [orders, bookings] = await Promise.all([
        listActiveOrders(wixApiKey, siteId),
        listConfirmedBookings(wixApiKey, siteId),
      ]);
      activePlans = [];
      for (const o of orders) {
        if (o.memberId === platformMemberId && o.planId) {
          activePlans.push({ planId: o.planId, sourceType: 'plan', email: o.email, name: o.name });
        }
      }
      for (const b of bookings) {
        if (b.memberId === platformMemberId && b.planId &&
            !activePlans.some(p => p.planId === b.planId)) {
          activePlans.push({ planId: b.planId, sourceType: 'booking', email: b.email, name: b.name });
        }
      }
    } catch (err) {
      log.error('reconcileMember.wix_fetch_failed', { clientId, memberId, traceId }, err);
      result.action = 'wix_unavailable';
      result.alerts.push({
        code: 'wix_api_unavailable',
        detail: 'Could not reach Wix to look up this member’s plans. No changes were made. Try again in a few minutes.',
      });
      return result;
    }

    // 4. Resolve current plan mappings — surface integrity issues, do not auto-fix
    const expectedGroupIds = new Set();           // hardware groups this member SHOULD be in
    const expectedAssignments = [];               // for grant repair: { planId, mappingId, hardwareGroupId, sourceType }
    let abortDueToIntegrity = false;

    for (const plan of activePlans) {
      const mappings = await planMappingResolver.resolve(clientId, plan.planId);

      if (mappings === null) {
        // Plan not recognized at all — operator hasn't mapped this Wix plan yet
        result.alerts.push({
          code: 'no_mapping_for_plan',
          detail: `This member has an active plan that isn’t mapped to any door yet. Open Plan Mappings and map plan “${plan.planId}” to a door group so they can get access.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }
      if (mappings.length === 0) {
        // Plan is mapped but no hardware group is set — Wix-first scenario
        result.alerts.push({
          code: 'mapping_missing_group',
          detail: `A mapping exists for this member’s plan, but no door group is assigned to it. Open Plan Mappings and finish setting up plan “${plan.planId}”.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }

      // Detect duplicate mappings claiming the same source_plan_id
      const uniqueMappingIds = new Set(mappings.map(m => m.mappingId));
      // Multi-group mappings legitimately produce one row per group with the same mappingId.
      // Distinct mappingIds for the same planId means duplicate plan_mappings entries.
      const distinctMappings = uniqueMappingIds.size;
      if (distinctMappings > 1) {
        result.alerts.push({
          code: 'duplicate_mappings_for_plan',
          detail: `Two or more plan mappings are set up for the same Wix plan. AccessSync can’t tell which one to use, so nothing was changed for this member. Review Plan Mappings and remove the duplicate.`,
          planId: plan.planId,
        });
        abortDueToIntegrity = true;
        continue;
      }

      for (const m of mappings) {
        if (m.hardwareGroupId) {
          expectedGroupIds.add(m.hardwareGroupId);
          expectedAssignments.push({
            planId: plan.planId,
            sourceType: plan.sourceType,
            mappingId: m.mappingId,
            hardwareGroupId: m.hardwareGroupId,
          });
        }
      }
    }

    if (abortDueToIntegrity) {
      // Log to config_alert_log so the nightly digest surfaces unresolved issues
      for (const a of result.alerts) {
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
           VALUES ($1, $2, $3, $4, 'system', 'reconcileMember')`,
          [clientId, a.code, a.planId || platformMemberId, traceId]
        ).catch(e => log.error('reconcileMember.alert_log_failed', { clientId, code: a.code }, e));
      }
      result.action = 'needs_attention';
      log.info('reconcileMember.integrity_blocked', {
        clientId, memberId, platformMemberId, alertCount: result.alerts.length, traceId,
      });
      return result;
    }

    // 5. Pull live hardware role assignments for this member.
    //    getManagedRoleAssignments THROWS on any Kisi error or malformed page
    //    (Phase 1, I-4 — it used to return [], which read as "no door access").
    //    Wrapped like the Wix step above (fix round F15): a failed read changes
    //    nothing — no grant, no revoke, no alert row — and says so plainly.
    let actualGroupIds = new Set();
    if (hardwareUserId) {
      let allAssignments;
      try {
        allAssignments = await hardwareAdapter.getManagedRoleAssignments(hardwarePlatform, hardwareApiKey);
        if (!Array.isArray(allAssignments)) {
          const bad = new Error('getManagedRoleAssignments returned a non-array');
          bad.code = 'KISI_PAGE_INTEGRITY';
          throw bad;
        }
      } catch (err) {
        log.warn('reconcileMember.hardware_fetch_failed', {
          clientId, memberId, hardwarePlatform,
          statusCode: (err && err.statusCode) || null, code: (err && err.code) || null, traceId,
        }, err);
        result.action = 'hardware_unavailable';
        result.alerts.push({
          code: 'hardware_api_unavailable',
          detail: 'AccessSync couldn’t reach the door system — no changes were made. Try again in a few minutes.',
        });
        return result;
      }
      actualGroupIds = new Set(
        allAssignments.filter(a => a.userId === hardwareUserId).map(a => a.groupId).filter(Boolean)
      );
    }

    // Untraceable hardware access: in Kisi but no Wix subscription justifies it
    const untraceable = [...actualGroupIds].filter(g => !expectedGroupIds.has(g));
    const missingHardware = [...expectedGroupIds].filter(g => !actualGroupIds.has(g));

    // 6. Check DB row drift — even when hardware matches Wix, member_access_sources
    //    rows may be missing (this is the bug Daxx hit). Uses access_id FK (new schema).
    const dbSourceRes = await db.query(
      `SELECT hardware_group_id FROM member_access_sources WHERE access_id = $1`,
      [memberId]
    );
    const dbSourceGroupIds = new Set(dbSourceRes.rows.map(r => r.hardware_group_id).filter(Boolean));

    const dbMissingForExpected = [...expectedGroupIds].filter(
      g => !dbSourceGroupIds.has(g)
    );

    // 7. Decide and act

    // 7a. Case: hardware has access from a source we can't trace (no active Wix sub)
    if (untraceable.length > 0 && expectedGroupIds.size === 0) {
      result.alerts.push({
        code: 'untraceable_hardware_access',
        detail: 'This member has door access in the hardware system, but we can’t find a reason for it — no active plan, no booking, no operator override. Review the member’s history and decide whether to keep or remove their access.',
      });
      await db.query(
        `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, trace_id, actor_type, actor_id)
         VALUES ($1, 'untraceable_hardware_access', $2, $3, 'system', 'reconcileMember')`,
        [clientId, platformMemberId, traceId]
      ).catch(e => log.error('reconcileMember.alert_log_failed', { clientId }, e));
      result.action = 'needs_attention';
      log.info('reconcileMember.untraceable', { clientId, memberId, platformMemberId, traceId });
      return result;
    }

    // 7b. Case: no active Wix subs, hardware has access → revoke
    //
    //     UNREACHABLE AS WRITTEN (found in the Phase 1 fix round, 2026-09-10; the
    //     same at HEAD c89b7c0): whenever this condition holds, 7a's holds too —
    //     with no expected groups, every actual group is untraceable — and 7a
    //     returns first (needs_attention, nothing queued). It is left exactly as
    //     it was: making it reachable would add a removal path, which Phase 1
    //     forbids. Phase 3b decides whether it should exist. Its mode gate below
    //     stays so that it can never fire unarmed if it ever becomes reachable.
    if (expectedGroupIds.size === 0 && actualGroupIds.size > 0) {
      // Automatic-removal mode — read where the revoke becomes possible,
      // fail-closed: only an explicit 'on' lets this per-member revoke through.
      const mode = await this._readAutoRevokeMode(clientId);
      if (mode !== REVOKE_MODE.ON) {
        log.warn('reconciliation.revoke_held', {
          path: 'reconcile_member', reason: holdReasonForMode(mode),
          clientId, memberId, platformMemberId, traceId,
        });
        result.alerts.push({
          code: 'auto_revoke_disabled',
          detail: mode === REVOKE_MODE.DRY_RUN
            ? 'This member has no active plan but still has door access. Automatic removals are paused while AccessSync’s safety checks roll out, so their access was left in place. If they shouldn’t get in, remove their access by hand.'
            : 'This member has no active plan but still has door access. Automatic removals are switched off for this gym, so their access was left in place. If they shouldn’t get in, remove their access by hand.',
        });
        result.action = 'revoke_held';
        return result;
      }

      const recoEventId = `recon-mbr-${clientId}-${platformMemberId}-${Date.now()}`;
      const syntheticEvent = {
        eventType:        'plan.cancelled',
        sourcePlatform:   'wix',
        platformMemberId,
        wixSiteId:        siteId,
        synthetic:        true,
        syntheticSource:  'reconciliation.reconcile_member',
        traceId,
        eventId:          recoEventId,
      };
      const jobId = `revoke-mbr-sync-${clientId}-${platformMemberId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
      result.revoked = 1;
      result.action = 'access_removed';
      log.info('reconcileMember.revoke_queued', { clientId, memberId, platformMemberId, jobId, traceId });
      return result;
    }

    // 7c. Case: hardware missing groups for active Wix subs → grant
    if (missingHardware.length > 0) {
      // One synthetic grant per active plan covers all missing groups
      // (queue-worker resolves mappings fresh and processes all groups for the plan).
      for (const plan of activePlans) {
        const recoEventId = `recon-mbr-${clientId}-${platformMemberId}-${Date.now()}`;
        const syntheticEvent = {
          eventType:        'plan.purchased',
          sourcePlatform:   'wix',
          platformMemberId,
          planId:           plan.planId,
          email:            plan.email,
          name:             plan.name,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.reconcile_member',
          traceId,
          eventId:          recoEventId,
        };
        const jobId = `grant-mbr-sync-${clientId}-${platformMemberId}-${plan.planId}-${Date.now()}`;
        await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
        result.granted++;
      }
      result.action = 'access_restored';
      log.info('reconcileMember.grant_queued', {
        clientId, memberId, platformMemberId, planCount: activePlans.length, traceId,
      });
      return result;
    }

    // 7d. Case: hardware matches Wix, but DB tracking rows are missing → repair
    //     Queue a synthetic grant; completeGrant() in L3 will INSERT missing rows
    //     idempotently (ON CONFLICT DO NOTHING). Kisi assignRole is idempotent —
    //     re-assigning an existing role returns the existing role.
    if (dbMissingForExpected.length > 0) {
      for (const plan of activePlans) {
        const recoEventId = `recon-mbr-repair-${clientId}-${platformMemberId}-${Date.now()}`;
        const syntheticEvent = {
          eventType:        'plan.purchased',
          sourcePlatform:   'wix',
          platformMemberId,
          planId:           plan.planId,
          email:            plan.email,
          name:             plan.name,
          wixSiteId:        siteId,
          synthetic:        true,
          syntheticSource:  'reconciliation.reconcile_member.repair',
          traceId,
          eventId:          recoEventId,
        };
        const jobId = `repair-mbr-sync-${clientId}-${platformMemberId}-${plan.planId}-${Date.now()}`;
        await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
        result.repaired++;
      }
      result.action = 'repaired';
      log.info('reconcileMember.repair_queued', {
        clientId, memberId, platformMemberId,
        missingDbGroups: dbMissingForExpected.length, traceId,
      });
      return result;
    }

    // 7e. All clear
    result.action = 'ok';
    log.info('reconcileMember.ok', { clientId, memberId, platformMemberId, traceId });
    return result;
  }

  async _syncDoorLockdownStates() {
    // Per-location iteration: each active location has its own platform + key
    // OB-200: defense-in-depth DISTINCT to prevent duplicate billing_subscriptions
    // rows from amplifying the inner loop. OB-198 will eventually enforce the
    // invariant at the schema layer (per RULE-15: schema enforces invariants).
    // Until then, DISTINCT is the cheap belt-and-suspenders defense against the
    // next class of dupes that may not fit OB-198's chosen constraint shape.
    const locationsResult = await db.query(
      `SELECT DISTINCT l.id AS location_id, l.client_id,
              cs.hardware_platform,
              cs.hardware_api_key
       FROM locations l
       JOIN clients c ON l.client_id = c.id
       JOIN connector_subscriptions cs ON cs.client_id = c.id AND cs.status = 'active'
       JOIN billing_subscriptions   bs ON bs.location_id = l.id AND bs.client_id = l.client_id
       WHERE c.status = 'active' AND bs.status = 'active'`
    );

    for (const loc of locationsResult.rows) {
      const apiKey = loc.hardware_api_key ? decryptApiKey(loc.hardware_api_key) : null;
      if (!apiKey) {
        log.warn('reconciliation.no_api_key', { locationId: loc.location_id });
        continue;
      }

      const locks = await hardwareAdapter.getLocks(loc.hardware_platform, apiKey);
      // DR-035: getLocks() normalized return shape — each adapter returns { id, name, locked: boolean }.
      // 'locked' is the canonical field. Adapters are responsible for mapping platform-specific fields.
      const lockedDoors = locks.filter(l => l.locked === true);
      for (const door of lockedDoors) {
        const _actor = getActor() || {};
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref, last_seen_at, trace_id, actor_type, actor_id)
           VALUES ($1, 'lockdown_detected', $2, NOW(), $3, $4, $5)`,
          [loc.client_id, String(door.id || door.name || 'unknown'), getTraceId() || null, _actor.type || null, _actor.id || null]
        ).catch(e => log.error('reconciliation.lockdown_alert_failed', { clientId: loc.client_id }, e));
      }
    }
  }

  async _fetchActionableRecords() {
    // OB-202: recovery_pending rows are stale in_flight cleanup targets ready
    // for re-attempt. pending_identity rows are members still waiting for
    // identity resolution. Both should be re-queued via _processRecordTargeted.
    // Pre-S-11 values 'failed' and 'skipped_lockdown' were dropped from the
    // member_access.status enum during S-10/S-11 cutover (2026-05-12 / 2026-05-15)
    // — this query silently returned 0 rows from then until 2026-05-26.
    const result = await db.query(
      `SELECT ma.id, ma.status, ma.id AS member_id, ma.client_id,
              mm.platform_member_id, ma.hardware_platform, mm.source_platform
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE ma.status IN ('recovery_pending', 'pending_identity')
         AND mm.source_tag = 'accesssync'`
    );
    return result.rows;
  }

  /**
   * R6 — replay a member's latest failed job from error_queue (step 4).
   *
   * Phase 1 (2026-09-10): GRANT-ONLY, and only for a member PAYING in this
   * sweep's Wix double read. A revoke is never replayed (months-old failed
   * revokes must not fire on their own), and a type that is neither is
   * skipped. The paying snapshot is passed in by _runNightlySweepBody; when it
   * is missing — or has no entry for this client because its sync aborted or
   * was skipped — the replay is skipped (fail-closed). When the event names a
   * plan, that plan itself must be PAYING, not just the member.
   *
   * @param {Object} record  a row from _fetchActionableRecords
   * @param {Map<string, Map<string, Set<string>>>} [payingByClient]
   *   clientId → (memberId → PAYING planIds), from this sweep's Wix reads
   */
  async _processRecordTargeted(record, payingByClient = null) {
    // 1. Fetch the latest failed event payload from error_queue
    const errorResult = await db.query(
      `SELECT id, event_type, payload FROM error_queue
       WHERE member_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [record.member_id]
    );

    if (errorResult.rows.length === 0) {
      log.warn('reconciliation.no_error_entry', { memberId: record.member_id });
      return;
    }

    const { id: errorQueueId, event_type: eventType, payload } = errorResult.rows[0];
    let standardEvent;
    try {
      standardEvent = typeof payload === 'string' ? JSON.parse(payload) : payload;
    } catch (e) {
      log.error('reconciliation.payload_parse_failed', { memberId: record.member_id }, e);
      return;
    }
    // Null / primitive / array payload (e.g. JSON 'null'): nothing to replay.
    if (!standardEvent || typeof standardEvent !== 'object' || Array.isArray(standardEvent)) {
      log.warn('reconciliation.requeue_skipped_unreadable_payload', {
        memberId: record.member_id, platformMemberId: record.platform_member_id, eventType,
      });
      return;
    }

    // One answer for grant-vs-revoke (core/event-routing.js). The old inline
    // list here was missing plan.started and defaulted everything else to
    // 'revoke' — a crashed deferred-start grant was replayed as a revoke. An
    // event type that is neither is skipped, never promoted to a revoke.
    const jobName = jobNameForEventType(eventType);
    if (!jobName) {
      log.warn('reconciliation.requeue_skipped_unroutable', {
        memberId: record.member_id, platformMemberId: record.platform_member_id, eventType,
      });
      return;
    }

    // Grant-only. The payload's own type must agree: a row labelled as a grant
    // whose event is a revoke is never replayed as either.
    const payloadJobName = standardEvent.eventType ? jobNameForEventType(standardEvent.eventType) : jobName;
    if (jobName !== 'grant' || payloadJobName !== 'grant') {
      log.warn('reconciliation.requeue_skipped_revoke', {
        memberId: record.member_id, platformMemberId: record.platform_member_id,
        clientId: record.client_id, eventType, payloadEventType: standardEvent.eventType || null,
      });
      return;
    }

    // Only for members PAYING in this sweep's Wix read (and, when the event
    // names a plan, for that plan).
    const payingForClient = payingByClient instanceof Map ? payingByClient.get(record.client_id) : null;
    const memberKey = standardEvent.platformMemberId || record.platform_member_id || null;
    const payingPlans = payingForClient instanceof Map && memberKey ? payingForClient.get(memberKey) : null;
    const planId = standardEvent.planId || null;
    let notPayingReason = null;
    if (!(payingForClient instanceof Map)) notPayingReason = 'no_wix_read';
    else if (!payingPlans)                 notPayingReason = 'member_not_paying';
    else if (planId && !payingPlans.has(planId)) notPayingReason = 'plan_not_paying';
    if (notPayingReason) {
      log.warn('reconciliation.requeue_skipped_not_paying', {
        memberId: record.member_id, platformMemberId: memberKey, clientId: record.client_id,
        eventType, planId, reason: notPayingReason,
      });
      return;
    }

    // Guard: never re-queue a job without a traceId — worker rejects at queue-worker.js:77
    // and BullMQ marks it exhausted on attempt 1. If the original payload predates traceId
    // discipline, mint one so the job can run rather than dying immediately.
    if (!standardEvent.traceId) {
      standardEvent.traceId = this._sweepTraceId || crypto.randomUUID();
    }

    // jobId is sweep-scoped for traceability (which error_queue row, which sweep).
    // Deliberately NOT stable across sweeps (e.g. just `requeue-${id}`): BullMQ
    // keeps the last 500 failed jobs (removeOnFail: 500, core/webhook-processor.js),
    // and a retained failed job's id silently blocks a new job with the same id —
    // so a member whose replay failed once could never be retried. Duplicate
    // replays of the same member are already serialised by the per-member lock
    // in resolveAndLock.
    const jobId = `requeue-${errorQueueId}-${this._sweepTraceId || 'nosweep'}`;

    // 2. Re-queue to BullMQ — respects in_flight lock and concurrency controls (not direct grant-revoke call)
    await eventQueue.add(jobName, { tenantId: record.client_id, standardEvent }, { jobId });
    log.info('reconciliation.requeued', { jobName, memberId: record.member_id, platformMemberId: record.platform_member_id, jobId });
  }

  async _generateAndSendDigest() {
    const sweepLogger = this._sweepLogger || log;
    const sweepTraceId = this._sweepTraceId || null;

    // Query both failure categories — operator needs both (NOVA spec).
    // Location/client names come along so the digest can name the place in plain English
    // instead of printing a client_id.
    const configAlertsResult = await db.query(
      `SELECT cal.client_id, cal.alert_type, cal.hardware_ref, cal.created_at,
              c.name AS client_name
       FROM config_alert_log cal
       LEFT JOIN clients c ON c.id = cal.client_id
       WHERE cal.resolved_at IS NULL
       ORDER BY cal.client_id, cal.created_at DESC`
    );

    // user_message / action_text are written at throw time by the connectors and
    // queue-worker. Preferring them is what turns "[null] member: null | CODE" into a
    // sentence; the older rows that predate them fall back to the event_type map.
    const failedJobsResult = await db.query(
      `SELECT eq.client_id, eq.member_id, eq.event_type, eq.error_reason, eq.created_at,
              eq.user_message, eq.action_text, eq.resolution, eq.plan_name, eq.door_name,
              mm.first_name, mm.last_name
       FROM error_queue eq
       LEFT JOIN member_master mm ON mm.id = eq.member_id
       WHERE eq.status = 'failed'
       ORDER BY eq.client_id, eq.created_at DESC`
    );

    const digest = {
      generatedAt: new Date().toISOString(),
      configAlerts: configAlertsResult.rows,
      failedJobs: failedJobsResult.rows,
    };

    sweepLogger.info('reconciliation.digest', { traceId: sweepTraceId, configAlerts: digest.configAlerts.length, failedJobs: digest.failedJobs.length, stage: 'cron', result: 'success' });

    if (configAlertsResult.rows.length === 0 && failedJobsResult.rows.length === 0) {
      sweepLogger.info('reconciliation.digest_empty', { traceId: sweepTraceId, stage: 'cron', result: 'skipped' });
      return;
    }

    // DR-020: Send nightly digest via Resend — same pattern as retry-engine._notifyOperator
    const toEmail = process.env.ACCESSSYNC_OWNER_NOTIFICATION_EMAIL || null;
    if (!toEmail) {
      log.warn('reconciliation.no_notification_email', {});
      return;
    }

    const { sent, reason } = await sendOperatorEmail({
      toEmail,
      render: renderNightlyDigest,
      renderArgs: {
        configAlerts: digest.configAlerts.map(a => ({
          alert_type: a.alert_type,
          locationName: a.client_name || null,
          doorName: a.hardware_ref || null,
        })),
        failedJobs: digest.failedJobs.map(j => ({
          event_type: j.event_type,
          user_message: j.user_message,
          action_text: j.action_text,
          plan_name: j.plan_name,
          memberName: [j.first_name, j.last_name].filter(Boolean).join(' ') || null,
        })),
      },
      logContext: { alert: 'nightly_digest', traceId: sweepTraceId },
    });

    if (!sent) {
      sweepLogger.error('reconciliation.digest_send_failed', { traceId: sweepTraceId, toEmail, stage: 'cron', result: 'failed', reason });
      return;
    }
    sweepLogger.info('reconciliation.digest_sent', { traceId: sweepTraceId, toEmail, stage: 'cron', result: 'success' });
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// --- Export and Executable Wrapper ---
const instance = new NightlyReconciliation();
module.exports = instance;

// If run directly via `node core/reconciliation.js`
//
// OB-227: distinguish Railway cron invocation from local CLI invocation by sniffing
// `RAILWAY_ENVIRONMENT` (Railway-injected on every deployment). In production the
// Railway cron service spawns this process with RAILWAY_ENVIRONMENT='production'
// (or similar); on a developer laptop the var is unset. If the env signal is missing
// the actor falls back to 'cli'.
if (require.main === module) {
  const triggerSource = process.env.RAILWAY_ENVIRONMENT ? 'railway-cron' : 'cli';
  instance.runNightlySweep({ triggerSource }).then(() => {
    process.exit(0);
  }).catch(err => {
    log.critical('reconciliation.fatal', {}, err);
    process.exit(1);
  });
}
