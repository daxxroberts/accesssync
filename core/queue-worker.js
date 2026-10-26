/**
 * @file queue-worker.js
 * @layer core/layer4
 * @role queue-coordinator
 * @reads BullMQ:grant,revoke jobs
 * @calls standard-adapter, grant-revoke, retry-engine
 * @exports startWorker, processJob
 * @dr DR-022, DR-023, DR-026, DR-037
 *
 * queue-worker.js
 * BullMQ Worker — Core Engine (Layer 4) — Layer Coordinator
 *
 * Orchestration sequence per job type:
 *
 * GRANT:
 *   1. planMappingResolver.resolve() → mappings[] (all active mappings for this plan)
 *   2. standardAdapter.resolveAndLock(tenantId, event, hardwarePlatform) → { memberId }
 *   3. standardAdapter.resolveIdentity(memberId, email, name, platform, apiKey) → hardwareUserId
 *   4. grantRevokeLogic.processGrant(tenantId, memberId, hardwareUserId, mappings, event) → assignments[]
 *   5. standardAdapter.completeGrant(memberId, tenantId, assignments)
 *
 * REVOKE:
 *   1. standardAdapter.resolveAndLock(tenantId, event, null) → { memberId, hardwareUserId, hardwarePlatform, roleAssignmentIds[] }
 *   2. grantRevokeLogic.processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform, eventType, event) → targetStatus
 *   3. standardAdapter.completeRevoke(memberId, tenantId, targetStatus)
 *
 * CATCH:
 *   standardAdapter.releaseLock(memberId, tenantId, 'failed')
 *   throw error — BullMQ retries (BUG-01 fix preserved)
 */

const { Worker, UnrecoverableError, DelayedError } = require('bullmq');
const grantRevokeLogic = require('./grant-revoke');
const retryEngine = require('./retry-engine');
const standardAdapter = require('../adapters/standard-adapter');
const hardwareAdapter = require('../adapters/hardware-adapter');
const planMappingResolver = require('./plan-mapping-resolver');
const { getRedisConnection } = require('./redis-utils');
const { eventQueue } = require('./webhook-processor');
const db = require('../db');
const { decryptApiKey } = require('./crypto-utils');
const { extractBillingSnapshot } = require('./billing-snapshot');
const { log, withTrace } = require('./logger');
const { runWith, registerTrace, setTraceContext, mintTraceId } = require('./trace-context');
const memberMailer = require('./member-mailer');

const connection = getRedisConnection();

// ── Per-member serialization ─────────────────────────────────────────────────────────────
// Wix fires 3-4 webhooks per purchase (orderUpdated ×2, orderPurchased ×1-2, orderStarted) and
// each becomes its own grant job. resolveAndLock's FOR UPDATE NOWAIT only guards the few ms the
// row is locked inside its own transaction, so the sibling jobs ran side by side: on a 2026-10-14
// purchase four jobs took the "lock" within 0.8 s of each other and Kisi was called seven times.
// A per-(client × person) Redis lock makes the siblings wait their turn; the ones that run after
// the first hit the OB-47 source-exists guard and make no door-system call at all.
//
// A job that finds the lock taken is parked with BullMQ's own mechanism (job.moveToDelayed +
// DelayedError): re-queued a moment later without spending one of its retry attempts. The TTL
// caps how long a crashed job can hold its member. The lock client is the Worker's non-blocking
// Redis connection (set in startWorker); without one — tests build no Worker — jobs run unlocked,
// exactly as before.
const MEMBER_LOCK_TTL_MS   = 120 * 1000;
const MEMBER_LOCK_RETRY_MS = 1000;
const RELEASE_IF_OWNER_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

let _lockClientPromise = null;
/** Tests inject a fake client here; startWorker sets the real one. null → run unlocked. */
function _setMemberLockClient(client) {
  _lockClientPromise = client ? Promise.resolve(client) : null;
}
function memberLockKey(tenantId, platformMemberId) {
  return `accesssync:member-lock:${tenantId}:${platformMemberId}`;
}

async function withMemberLock(job, token, fn) {
  const { tenantId, standardEvent } = job.data || {};
  const platformMemberId = standardEvent?.platformMemberId;
  const client = _lockClientPromise ? await _lockClientPromise.catch(() => null) : null;
  if (!client || typeof client.set !== 'function' || !tenantId || !platformMemberId) return fn();

  const key   = memberLockKey(tenantId, platformMemberId);
  const owner = String(job.id);
  const acquired = await client.set(key, owner, 'PX', MEMBER_LOCK_TTL_MS, 'NX');
  if (acquired !== 'OK') {
    const retryInMs = MEMBER_LOCK_RETRY_MS + Math.floor(Math.random() * 250);
    withTrace(standardEvent.traceId).info('queue.job.member_busy_parked', {
      jobId: job.id, jobName: job.name, clientId: tenantId, platformMemberId,
      heldBy: await client.get(key), retryInMs,
      stage: 'queue', result: 'skipped',
    });
    await job.moveToDelayed(Date.now() + retryInMs, token);
    throw new DelayedError();
  }
  try {
    return await fn();
  } finally {
    // Compare-and-delete: never release a lock the TTL already handed to a sibling.
    await Promise.resolve(client.eval(RELEASE_IF_OWNER_LUA, 1, key, owner)).catch(() => {});
  }
}

// ── Holder-lapse seat cascade ─────────────────────────────────────────────────────────────
// When Wix ends a plan holder's order (orderEnded / orderCanceled → plan.cancelled), the webhook
// revokes the HOLDER only. The seats on that plan (sub-members: member_access.sub_master_id →
// the holder's member_master, with a source row on the same source_plan_id) were left to the
// reconcile's Pass 1.5, which runs observation-only and never enqueues. 2026-10-15 review: a
// Family order ended on Oct 4 and its four seats still opened the door eleven days later.
//
// Each active seat now gets the same synthetic per-plan revoke the Member Hub's "remove
// sub-member" path has used in production since DR-044 (markSubMemberRemoving → plan.cancelled
// with planId → processRevoke targets that source row → finalizeRevoke purges). Job ids are
// deterministic per (seat, plan, holder webhook) so a retried holder job never queues a seat
// twice. The cascade runs before the holder's own revoke so a holder who already released their
// own seat (DR-051: no active access row → no_identity) still takes the seats down with them.
// HOLDER_LAPSE_CASCADE=off is the kill switch.
const HOLDER_LAPSE_CASCADE_SOURCE = 'holder_lapse.cascade';

async function _cascadeHolderLapse(tenantId, standardEvent, logger, holderJobId) {
  const { eventType, planId, platformMemberId } = standardEvent || {};
  if (eventType !== 'plan.cancelled' || standardEvent.synthetic || !planId || !platformMemberId) return 0;

  const eventId = standardEvent.eventId || holderJobId;
  if (process.env.HOLDER_LAPSE_CASCADE === 'off') {
    logger.info('queue.revoke.holder_lapse.cascade_disabled', {
      clientId: tenantId, eventId, holderPlatformMemberId: platformMemberId, planId,
      stage: 'revoke', result: 'skipped',
    });
    return 0;
  }

  const seats = await db.query(
    `SELECT sub.id              AS sub_access_id,
            sub_mm.platform_member_id,
            sub.status          AS sub_status,
            sub.hardware_user_id,
            mas.status          AS source_status
       FROM member_master holder_mm
       JOIN member_access sub          ON sub.sub_master_id = holder_mm.id
                                      AND sub.client_id     = holder_mm.client_id
       JOIN member_master sub_mm       ON sub_mm.id = sub.member_master_id
       JOIN member_access_sources mas  ON mas.access_id      = sub.id
                                      AND mas.source_plan_id = $3
                                      AND mas.status NOT IN ('cancelled', 'revoked')
      WHERE holder_mm.client_id          = $1
        AND holder_mm.source_platform    = $2
        AND holder_mm.platform_member_id = $4
        AND sub.status NOT IN ('deleted', 'removing')`,
    [tenantId, standardEvent.sourcePlatform || 'wix', planId, platformMemberId]
  );

  let queued = 0;
  for (const seat of seats.rows) {
    const common = {
      clientId: tenantId, eventId, holderPlatformMemberId: platformMemberId, planId,
      subAccessId: seat.sub_access_id, subPlatformMemberId: seat.platform_member_id,
    };
    // Only a seat that actually holds a door is revoked here. A seat still pending (no hardware
    // yet) has nothing to take back; it is logged so the Member Hub / sweep can deal with it.
    if (seat.sub_status !== 'active' || seat.source_status !== 'active' || !seat.hardware_user_id) {
      logger.warn('queue.revoke.holder_lapse.seat_skipped', {
        ...common, subStatus: seat.sub_status, sourceStatus: seat.source_status,
        hasHardwareUser: !!seat.hardware_user_id, stage: 'revoke', result: 'skipped',
      });
      continue;
    }
    const seatTraceId = mintTraceId();
    const jobId = `revoke-holder-lapse-${seat.sub_access_id}-${planId}-${eventId}`;
    try {
      await standardAdapter.markSubMemberRemoving(seat.sub_access_id);
      registerTrace(seatTraceId, {
        entryPoint: 'queue', clientId: tenantId, memberId: seat.sub_access_id,
        actorType: 'system', actorId: 'queue-worker',
      });
      await eventQueue.add('revoke', {
        tenantId,
        standardEvent: {
          eventType:        'plan.cancelled',
          platformMemberId: seat.platform_member_id,
          sourcePlatform:   standardEvent.sourcePlatform || 'wix',
          planId,
          synthetic:        true,
          syntheticSource:  HOLDER_LAPSE_CASCADE_SOURCE,   // DR-052: the seat's access really ended → email allowed
          holderPlatformMemberId: platformMemberId,
          holderEventId:    eventId,
          traceId:          seatTraceId,
        },
      }, { jobId });
      queued++;
      logger.info('queue.revoke.holder_lapse.cascade_queued', {
        ...common, jobId, seatTraceId, stage: 'revoke', result: 'success',
      });
    } catch (err) {
      // One seat failing never stops the rest; the row is visible in diagnostic_log.
      logger.error('queue.revoke.holder_lapse.cascade_failed', { ...common, jobId, stage: 'revoke', result: 'failed' }, err);
    }
  }
  return queued;
}

/**
 * Resolves the client-level hardware API key for a tenant.
 * Used for user resolution (findUserByEmail, createUser) and payment.recovered.
 * DR-028: hardware_api_key lives on connector_subscriptions.
 */
async function getClientApiKey(tenantId) {
  const result = await db.query(
    `SELECT hardware_api_key FROM connector_subscriptions
      WHERE client_id = $1 AND status = 'active' LIMIT 1`,
    [tenantId]
  );
  const enc = result.rows[0]?.hardware_api_key;
  if (enc) return decryptApiKey(enc);
  return null;
}

/**
 * Day pass grant (OB-98 / OB-251). A day-pass buyer never gets a hardware user —
 * the credential is a Kisi group link (QR + access link) that expires with the
 * order. Same layer discipline as the standard path, different steps:
 *   1. endDate   — synthetic event without one → no-op (reconcile re-grants);
 *                  real webhook without one → throws, dead-letters visibly
 *   2. email     — L3 resolveEmailOnly: the QR has to go somewhere, and live Wix
 *                  order webhooks carry no buyer.email (0/10 recent orders)
 *   3. claim     — L3 claimDayPassSources: the cross-job mutex against Wix's
 *                  triple-fire; a loser just recomputes the rollup and exits
 *   4. hardware  — L4 processDayPassGrant: one link per claimed mapping
 *   5. record    — L3 completeGrant (RI-03 writes valid_until), then the branded
 *                  QR email, fire-and-forget
 * Called from both the plan.purchased and plan.started paths; the second call for
 * the same order loses the claim and is a clean no-op.
 */
async function _runDayPassGrant({ tenantId, memberId, mappings, standardEvent, eventId, job, logger, traceId, jobStart }) {
  const clientId = tenantId;
  const planId = standardEvent.planId || null;

  // Quantity buys consecutive days, not extra people (Builder rule, 2026-09-23): a 1-Day
  // Pass x5 is ONE code good for 5 x 24 h from purchase.
  const units   = _unitsBought(standardEvent, planId, logger);
  const endDate = grantRevokeLogic.dayPassEndDate(standardEvent, mappings, units);
  if (!endDate) {
    logger.info('grant.day_pass.synthetic_skipped', {
      clientId, memberId, eventId,
      platformMemberId: standardEvent.platformMemberId, planId,
      syntheticSource: standardEvent.syntheticSource || null,
      stage: 'grant', result: 'skipped',
    });
    await standardAdapter.rollupAccessStatus(memberId);
    return;
  }

  const identity = await standardAdapter.resolveEmailOnly(
    memberId, tenantId, standardEvent.platformMemberId, standardEvent.email || null
  );
  if (!identity) {
    logger.warn('queue.grant.parked.pending_identity', {
      clientId, memberId, eventId,
      platformMemberId: standardEvent.platformMemberId, planId,
      stage: 'identity', result: 'skipped',
    });
    return;
  }

  // Every paid ORDER gets its own door code. The claim key is the product PLUS the
  // order — so a second purchase of the same pass is a new pass, while Wix's 2-3
  // echoes of ONE order share a key and still collapse to a single code. The `#1`
  // suffix keeps the product#order#unit shape older rows and revoke matching use;
  // one order is one code now, however many days it bought. No order id (legacy /
  // synthetic) → the bare product id, i.e. the old one-pass-per-product behaviour.
  const orderId   = standardEvent.wixOrderId || null;
  const sourceKey = orderId ? `${planId}#${orderId}#1` : planId;
  const billingSnapshot = extractBillingSnapshot(standardEvent.rawPayload);

  const claimed = await standardAdapter.claimDayPassSources(memberId, tenantId, mappings, sourceKey);
  if (claimed.length === 0) {
    logger.info('grant.day_pass.claim_lost', {
      clientId, memberId, eventId,
      platformMemberId: standardEvent.platformMemberId, planId,
      wixOrderId: orderId, units,
      mappingCount: mappings.length,
      stage: 'grant', result: 'skipped',
    });
    await standardAdapter.rollupAccessStatus(memberId);
    return;
  }

  let result;
  try {
    result = await grantRevokeLogic.processDayPassGrant(
      tenantId, memberId, claimed, standardEvent,
      { email: identity.email, sourceKey, units, holderName: identity.name || null }
    );
  } catch (err) {
    await standardAdapter.releaseDayPassClaims(memberId, tenantId, claimed, sourceKey).catch(() => {});
    await standardAdapter.rollupAccessStatus(memberId);
    throw err;
  }
  const okMappingIds = new Set(result.assignments.map(a => a.mappingId));
  const failedClaims = claimed.filter(m => !okMappingIds.has(m.mappingId));
  if (failedClaims.length > 0) {
    await standardAdapter.releaseDayPassClaims(memberId, tenantId, failedClaims, sourceKey).catch(() => {});
  }

  await standardAdapter.completeGrant(memberId, tenantId, result.assignments, billingSnapshot);
  const links = result.links;

  if (links.length === 0) {
    await standardAdapter.rollupAccessStatus(memberId);
    return;
  }

  setTraceContext(traceId, {
    clientId, memberId,
    planName:  standardEvent.planName || null,
    mappingId: (mappings[0] && mappings[0].mappingId) || null,
  });
  logger.info('queue.grant.day_pass.complete', {
    clientId, memberId, eventId,
    platformMemberId: standardEvent.platformMemberId, planId,
    wixOrderId: orderId, units,
    links: links.length,
    validUntil: endDate,
    durationMs: Date.now() - jobStart,
    stage: 'grant', result: 'success',
  });

  // `:u1` keeps the dedup key shape of emails already sent under the per-unit model.
  memberMailer.maybeSendDayPassEmail({
    clientId: tenantId, accessId: memberId, standardEvent,
    links, recipientEmail: identity.email, units,
    eventKey: `${orderId || eventId || job.id}:u1`,
  }).catch(() => {});
}

// A sanity ceiling, not a product rule: quantity is days in a row, and a single code
// good for months is a malformed payload or an abuse case, not a customer.
const MAX_DAY_PASS_UNITS = 50;

/** How many units of `planId` this order bought. Plan orders and legacy events → 1. */
function _unitsBought(standardEvent, planId, logger) {
  const details = Array.isArray(standardEvent.lineItemDetails) ? standardEvent.lineItemDetails : [];
  const bought = details.filter(d => d.id === planId).reduce((n, d) => n + (d.quantity || 1), 0) || 1;
  if (bought > MAX_DAY_PASS_UNITS) {
    logger.warn('grant.day_pass.units_capped', {
      platformMemberId: standardEvent.platformMemberId, planId,
      wixOrderId: standardEvent.wixOrderId || null,
      unitsBought: bought, unitsGranted: MAX_DAY_PASS_UNITS,
      stage: 'grant', result: 'success',
    });
    return MAX_DAY_PASS_UNITS;
  }
  return bought;
}

/**
 * OB-98 — which mapping does a Wix STORES order grant against?
 *
 * A plan order names exactly one plan. A store order is a basket: a day pass, two
 * t-shirts and a protein bar all arrive on one `store.order_paid`. Only some of those
 * are mapped to a door, and a shop that sells merchandise must not raise a
 * PLAN_NOT_MAPPED alert every time somebody buys a shirt.
 *
 * So: try each line item's catalog id, take the first that resolves to a live mapping,
 * and pin standardEvent.planId to it so every downstream write (source rows, billing,
 * revoke scoping) keys off the product that actually granted access. Nothing mapped →
 * `null`, and the caller returns quietly.
 *
 * A basket can hold more than one mapped pass (a 1-Day and a 2-Day). Every matched item
 * is kept on standardEvent.storeGrantItems so the day-pass branch grants each of them —
 * paid for means a code is issued. planId is pinned to the first for the shared steps
 * (lock, logging) that expect exactly one.
 *
 * Only DAY-PASS mappings count. Buying a Pricing Plan also makes Wix create an eCom
 * checkout whose `store.order_paid` line item carries the PLAN's id (lineItemType
 * CUSTOM_AMOUNT_ITEM). Matching that against the plan's mapping granted every plan
 * purchase a second time: a second member_billing row under the checkout order id,
 * the access source re-pointed at it, and a second "access ready" email (59 House of
 * Gains members, 2026-09-23 → 10-05). Plans are granted by their own plan.* webhooks;
 * a store order only ever grants day passes. Keying on our own mapping data, not the
 * payload shape, holds whatever Wix sends.
 *
 * @returns {Promise<Array|null>} mappings, or null when no line item is a mapped day pass
 */
async function _resolveStoreMappings(tenantId, standardEvent, logger) {
  const ids = Array.isArray(standardEvent.lineItemPlanIds) && standardEvent.lineItemPlanIds.length
    ? standardEvent.lineItemPlanIds
    : [standardEvent.planId].filter(Boolean);

  const matched = [];
  for (const id of ids) {
    const mappings = await planMappingResolver.resolve(tenantId, id);
    if (!Array.isArray(mappings) || mappings.length === 0) continue;
    if (mappings[0].accessType !== 'day_pass') {
      logger.info('queue.grant.store.non_day_pass_item_skipped', {
        clientId: tenantId,
        platformMemberId: standardEvent.platformMemberId,
        wixOrderId: standardEvent.wixOrderId,
        planId: id,
        stage: 'grant', result: 'skipped',
      });
      continue;
    }
    matched.push({ id, mappings });
  }

  if (matched.length === 0) {
    logger.info('queue.grant.store.no_mapped_item', {
      clientId: tenantId,
      platformMemberId: standardEvent.platformMemberId,
      wixOrderId: standardEvent.wixOrderId,
      lineItemCount: ids.length,
      stage: 'grant', result: 'skipped',
    });
    return null;
  }
  if (matched.length > 1) {
    logger.info('queue.grant.store.multiple_mapped_items', {
      clientId: tenantId,
      platformMemberId: standardEvent.platformMemberId,
      wixOrderId: standardEvent.wixOrderId,
      planIds: matched.map(m => m.id),
      stage: 'grant', result: 'success',
    });
  }
  standardEvent.storeGrantItems = matched;
  standardEvent.planId = matched[0].id;
  return matched[0].mappings;
}

/**
 * processGrant, recovering ONCE from a Kisi user that no longer exists.
 *
 * member_access.hardware_user_id is a cache: resolveIdentity returns it without asking
 * the door system. When that Kisi user is deleted (our finalizeRevoke, or the gym in the
 * Kisi dashboard), every grant answers HARDWARE_USER_GONE, dead-letters on attempt 1,
 * and reconcile re-queues the same grant with the same dead id — forever. A Couples plan
 * holder failed 12 grants this way from 2026-09-30 (trace 8c92ad90, 2026-10-15).
 *
 * On HARDWARE_USER_GONE: resolveIdentity(force) skips the cache, finds-or-creates the
 * user (with the OB-89 email-recovery ladder), runs the OB-80 purge on an id change and
 * caches the new id — then processGrant runs once more with it. Hard cap: processGrant
 * runs at most twice per job.
 *   resolveIdentity → null      → parked pending_identity; returns null (caller exits)
 *   resolveIdentity → same id   → the original error is rethrown (no loop)
 *   second processGrant throws  → that error propagates unchanged (dead-letters as today)
 * Any other first-call error propagates unchanged.
 *
 * @returns {Promise<{assignments: Array, hardwareUserId: string}|null>}
 *          hardwareUserId is the id the assignments were made with (the new one after a
 *          recreate); null means the member was parked pending_identity.
 */
async function _processGrantRecoveringUser({
  tenantId, memberId, hardwareUserId, mappings, standardEvent, apiKey, eventId, logger, onStep,
}) {
  try {
    const assignments = await grantRevokeLogic.processGrant(
      tenantId, memberId, hardwareUserId, mappings, standardEvent
    );
    return { assignments, hardwareUserId };
  } catch (err) {
    if (!err || err.code !== 'HARDWARE_USER_GONE') throw err;

    const ctx = {
      clientId: tenantId, memberId, eventId,
      platformMemberId: standardEvent.platformMemberId,
      staleHardwareUserId: hardwareUserId,
    };
    logger.warn('queue.grant.user_gone_recreating', { ...ctx, stage: 'identity', result: 'retry' });

    if (onStep) onStep('recreate_identity');
    const newHardwareUserId = await standardAdapter.resolveIdentity(
      memberId, standardEvent.email, standardEvent.name,
      mappings[0].hardwarePlatform, apiKey,
      { tenantId, platformMemberId: standardEvent.platformMemberId, force: true }
    );
    if (newHardwareUserId === null) return null; // parked as pending_identity
    if (String(newHardwareUserId) === String(hardwareUserId)) throw err;

    if (onStep) onStep('process_grant_recreated');
    const assignments = await grantRevokeLogic.processGrant(
      tenantId, memberId, newHardwareUserId, mappings, standardEvent
    );
    // warn, not info: persists without an EVENT_REGISTRY entry, and a recreated
    // door-system user is worth an operator's eye.
    logger.warn('queue.grant.user_recreated', {
      ...ctx, newHardwareUserId, assignments: assignments.length,
      stage: 'identity', result: 'success',
    });
    return { assignments, hardwareUserId: newHardwareUserId };
  }
}

/**
 * Job processor function.
 * BullMQ calls this for every job dequeued. Returning normally = success. Throwing = retry.
 *
 * DR-037: ALS does not cross process boundaries. traceId is read from job payload
 * and explicitly re-bound via runWith so all downstream log calls auto-carry it.
 */
async function processJob(job, token) {
  const { tenantId, standardEvent } = job.data || {};
  const traceId  = standardEvent?.traceId  || null;

  if (!traceId) {
    log.error('queue.job.missing_trace_id', {
      jobId: job.id, jobName: job.name,
      clientId: tenantId || null,
      eventId: standardEvent?.eventId || null,
    });
    throw new Error('QUEUE_JOB_MISSING_TRACE_ID');
  }

  // One job per (client × person) at a time — see withMemberLock.
  return withMemberLock(job, token, () => runWith(
    // clientId: every log row written while this job runs — including from layers that never
    // receive the tenant (the Kisi connector's HTTP error log) — is stamped with its client.
    { traceId, actor: { type: 'system', id: 'queue-worker' }, clientId: tenantId || null },
    () => _processJobBody(job, traceId)
  ));
}

async function _processJobBody(job, traceId) {
  const { tenantId, standardEvent } = job.data || {};
  const clientId = tenantId;
  const eventId  = standardEvent.eventId  || null;
  const logger   = withTrace(traceId);     // withTrace kept for explicit traceId in log ctx fields
  const jobStart = Date.now();

  logger.info('queue.job.start', {
    traceId, clientId, eventId,
    jobId: job.id, jobName: job.name,
    attempt: (job.attemptsMade || 0) + 1,
    platformMemberId: standardEvent.platformMemberId,
    eventType: standardEvent.eventType,
    planId: standardEvent.planId,
    stage: 'queue', result: 'start',
  });

  let memberId = null;
  let lastStep = 'entry';
  // Set when finalizeRevoke throws after completeRevoke committed — the error path then
  // parks the member at 'removing' so the BullMQ retry can find them (see Step 4).
  let finalizePending = false;

  try {
    if (job.name === 'grant') {

      // payment.recovered: user is suspended — re-enable only (no new role assignments)
      if (standardEvent.eventType === 'payment.recovered') {
        lastStep = 'grant.recovered.resolve_lock';
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null, null);
        if (!lockResult) {
          logger.warn('queue.grant.recovered.no_identity', {
            clientId, eventId,
            platformMemberId: standardEvent.platformMemberId,
            stage: 'grant', result: 'skipped',
          });
          return;
        }
        const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform } = lockResult;
        memberId = resolvedMemberId;
        lastStep = 'grant.recovered.enable_access';
        const apiKey = await getClientApiKey(tenantId);
        if (hardwareUserId) {
          await hardwareAdapter.enableAccess(hardwarePlatform, apiKey, hardwareUserId, { clientId: tenantId });
        } else {
          // Day-pass-only member (OB-98): no hardware user to re-enable — status flip only.
          logger.warn('queue.grant.recovered.no_hardware_user', {
            clientId, memberId, eventId,
            platformMemberId: standardEvent.platformMemberId,
            stage: 'grant', result: 'skipped',
          });
        }
        lastStep = 'grant.recovered.complete_revoke';
        await standardAdapter.completeRevoke(memberId, tenantId, 'active');
        // OB-162: enrich trace_context on payment.recovered path (no mapping context available)
        setTraceContext(traceId, { clientId, memberId });
        // DR-052 — M5 access-restored email. No PII-deletion race on this path
        // (finalizeRevoke never runs for a recovery), so fire-and-forget is safe.
        memberMailer.maybeSendAccessRestoredEmail({
          clientId: tenantId, accessId: memberId, standardEvent, eventKey: eventId || job.id,
          hardwarePlatform, // from lockResult above — names the right app in the email, not a hardcoded "Kisi"
        }).catch(() => {});
        logger.info('queue.grant.recovered.complete', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          durationMs: Date.now() - jobStart,
          stage: 'grant', result: 'success',
        });
        return;
      }

      // plan.started: orderStarted has arrived — Kisi user already exists (cache hit from
      // orderPurchased), assign to access group now. This is phase 2 of delayed-start grants.
      if (standardEvent.eventType === 'plan.started') {
        lastStep = 'grant.started.resolve_mappings';
        const mappings = await planMappingResolver.resolve(tenantId, standardEvent.planId);
        if (!mappings || mappings.length === 0) {
          logger.warn('queue.grant.started.no_mappings', {
            clientId, eventId,
            platformMemberId: standardEvent.platformMemberId,
            planId: standardEvent.planId,
            stage: 'grant', result: 'skipped',
          });
          return;
        }

        lastStep = 'grant.started.resolve_and_lock';
        const startedLock = await standardAdapter.resolveAndLock(tenantId, standardEvent, mappings[0].hardwarePlatform, mappings[0].mappingId);
        memberId = startedLock.memberId;

        lastStep = 'grant.started.get_api_key';
        const startedApiKey = await getClientApiKey(tenantId);
        if (!startedApiKey) {
          // S-11: park as pending_hardware via source-row writes (mappings present here).
          await standardAdapter.parkPendingHardware(memberId, tenantId, mappings);
          logger.info('queue.grant.started.parked.no_api_key', {
            clientId, memberId, eventId,
            platformMemberId: standardEvent.platformMemberId,
            mappingCount: mappings.length,
            stage: 'grant', result: 'skipped',
          });
          return;
        }

        // Day pass (OB-98 / OB-251): no Kisi user — group link + QR instead. The
        // orderStarted echo of a day-pass purchase loses the claim and no-ops.
        if (mappings[0].accessType === 'day_pass') {
          lastStep = 'grant.started.day_pass';
          await _runDayPassGrant({ tenantId, memberId, mappings, standardEvent, eventId, job, logger, traceId, jobStart });
          return;
        }

        lastStep = 'grant.started.resolve_identity';
        const startedHardwareUserId = await standardAdapter.resolveIdentity(
          memberId, standardEvent.email, standardEvent.name,
          mappings[0].hardwarePlatform, startedApiKey,
          { tenantId, platformMemberId: standardEvent.platformMemberId }
        );
        if (startedHardwareUserId === null) return; // parked as pending_identity

        lastStep = 'grant.started.process_grant';
        const startedGrant = await _processGrantRecoveringUser({
          tenantId, memberId, hardwareUserId: startedHardwareUserId, mappings, standardEvent,
          apiKey: startedApiKey, eventId, logger,
          onStep: (s) => { lastStep = `grant.started.${s}`; },
        });
        if (startedGrant === null) return; // recreate parked as pending_identity
        const startedAssignments = startedGrant.assignments;

        lastStep = 'grant.started.complete_grant';
        const startedBilling = extractBillingSnapshot(standardEvent.rawPayload);
        await standardAdapter.completeGrant(memberId, tenantId, startedAssignments, startedBilling);
        // OB-162: enrich trace_context with plan/door context on plan.started path
        setTraceContext(traceId, {
          clientId,
          memberId,
          planName:  mappings[0]?.planName  || null,
          doorName:  mappings[0]?.doorName  || null,
          mappingId: mappings[0]?.mappingId || null,
        });
        logger.info('queue.grant.started.complete', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          assignments: startedAssignments.length,
          durationMs: Date.now() - jobStart,
          stage: 'grant', result: 'success',
        });
        // DR-052 — access became live on plan.started too (delayed-start plans).
        memberMailer.maybeSendGrantEmail({
          clientId: tenantId, accessId: memberId, standardEvent, assignments: startedAssignments,
          eventKey: eventId || job.id,
        }).catch(() => {});
        return;
      }

      // Step 1: Resolve all active plan mappings for this plan (returns array, null, or empty array).
      // OB-98: a Wix Stores order is a basket — resolve across its line items instead
      // (see _resolveStoreMappings), and skip quietly when nothing in it is mapped.
      lastStep = 'grant.resolve_mappings';
      let mappings;
      if (standardEvent.eventType === 'store.order_paid') {
        mappings = await _resolveStoreMappings(tenantId, standardEvent, logger);
        if (mappings === null) return;
      } else {
        mappings = await planMappingResolver.resolve(tenantId, standardEvent.planId);
      }
      logger.info('queue.grant.mappings_resolved', {
        clientId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        planId: standardEvent.planId,
        mappingCount: mappings === null ? null : mappings.length,
        hardwareGroupIds: Array.isArray(mappings) ? mappings.map(m => m.hardwareGroupId) : [],
        stage: 'grant', result: 'success',
      });
      if (mappings === null) {
        // W-1: Unknown plan — write to error_queue + notify operator immediately
        logger.warn('queue.grant.plan_unknown', {
          clientId, eventId,
          planId: standardEvent.planId,
          platformMemberId: standardEvent.platformMemberId,
          stage: 'grant', result: 'failed',
        });
        const unmappedErr = new Error(`No mapping for plan ${standardEvent.planId}`);
        unmappedErr.code = 'PLAN_NOT_MAPPED';
        unmappedErr.userMessage = "A member just signed up for a plan that hasn't been connected to any access group yet. They won't be able to get in until the plan is mapped.";
        unmappedErr.action = 'Open Plan Mapping in your AccessSync dashboard and connect this plan to an access group.';
        await retryEngine.handleFailure({ id: job.id, data: job.data }, unmappedErr);
        return;
      }
      if (mappings.length === 0) {
        // Plan recognized but no hardware group mapped yet (Wix-first flow) — park member.
        // S-11: no mappings means we have no source-row identity to write. Access stays
        // 'inactive'; the parking signal lives in config_alert_log (operator's "map this plan"
        // alert). parkPendingHardware([]) handles the no-mapping case explicitly.
        const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, 'kisi', null);
        memberId = lockResult.memberId;
        await standardAdapter.parkPendingHardware(memberId, tenantId, []);
        // Only "no group chosen yet" is a quiet park. A lapsed location or a door group that no
        // longer exists means a PAYING member has no door and nobody would be told: raise it as a
        // dead-letter so it reaches the error list, the owner hub and the email (bug 3, 2026-10-15).
        const noDoorReason = mappings.noMappingReason || 'no_group';
        if (noDoorReason === 'location_lapsed' || noDoorReason === 'group_unhealthy') {
          logger.warn('queue.grant.parked.no_door', {
            clientId, memberId, eventId, reason: noDoorReason,
            platformMemberId: standardEvent.platformMemberId,
            planId: standardEvent.planId,
            stage: 'grant', result: 'failed',
          });
          const noDoorErr = new Error(noDoorReason === 'location_lapsed'
            ? `Location subscription lapsed — no door for plan ${standardEvent.planId}`
            : `Every door group for plan ${standardEvent.planId} is gone from the door system`);
          if (noDoorReason === 'location_lapsed') {
            noDoorErr.code = 'SUBSCRIPTION_LAPSED';
            noDoorErr.userMessage = 'A member paid for a plan at a location whose AccessSync subscription is not active, so they have no door access.';
            noDoorErr.action = 'AccessSync will reactivate the location.';
          } else {
            noDoorErr.code = 'HARDWARE_RESOURCE_NOT_FOUND';
            noDoorErr.resolution = 'REMAP_PLAN';
            noDoorErr.userMessage = 'A member paid for a plan whose door group no longer exists in your door system, so they have no door access.';
            noDoorErr.action = 'Open Plan Mapping and choose a door group that still exists, then press Retry.';
          }
          await retryEngine.handleFailure({ id: job.id, data: job.data }, noDoorErr);
          return;
        }
        logger.info('queue.grant.parked.no_mapping', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'grant', result: 'skipped',
        });
        return;
      }

      // Step 2: Resolve identity + acquire lock (all mappings share same hardwarePlatform).
      // Pass mappings[0].mappingId so member_access.plan_mapping_id is populated and the
      // UNIQUE(member_master_id, plan_mapping_id) ON CONFLICT path actually distinguishes
      // multi-plan-per-person grants. Pre-fix every row was inserted with NULL, allowing
      // duplicate (mm_id, NULL) rows past the UNIQUE constraint.
      lastStep = 'grant.resolve_and_lock';
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, mappings[0].hardwarePlatform, mappings[0].mappingId);
      memberId = lockResult.memberId;
      logger.info('queue.grant.lock_acquired', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        hardwarePlatform: mappings[0].hardwarePlatform,
        email: standardEvent.email || null,
        stage: 'grant', result: 'start',
      });

      // Step 3: Check for hardware API key — if missing, park as pending_hardware (Wix-first flow).
      // S-11: parkPendingHardware writes per-mapping source rows in 'pending_hardware' status;
      // reconcile picks them up when API key arrives.
      lastStep = 'grant.get_api_key';
      const apiKey = await getClientApiKey(tenantId);
      if (!apiKey) {
        await standardAdapter.parkPendingHardware(memberId, tenantId, mappings);
        logger.info('queue.grant.parked.no_api_key', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          mappingCount: mappings.length,
          stage: 'grant', result: 'skipped',
        });
        return;
      }

      // Day pass (OB-98 / OB-251): branch before identity — a day-pass buyer never
      // gets a hardware user. Skips resolveIdentity, pending_start parking, and
      // processGrant entirely; see _runDayPassGrant for the sequence.
      if (mappings[0].accessType === 'day_pass') {
        lastStep = 'grant.day_pass';
        // A store basket may hold several mapped passes — grant each. A plan order has one.
        const items = Array.isArray(standardEvent.storeGrantItems) && standardEvent.storeGrantItems.length
          ? standardEvent.storeGrantItems
          : [{ id: standardEvent.planId, mappings }];
        let itemError = null;
        for (const item of items) {
          if (!item.mappings[0] || item.mappings[0].accessType !== 'day_pass') {
            logger.warn('queue.grant.store.non_day_pass_item_skipped', {
              clientId, memberId, eventId, planId: item.id,
              wixOrderId: standardEvent.wixOrderId || null,
              stage: 'grant', result: 'skipped',
            });
            continue;
          }
          const detail = (standardEvent.lineItemDetails || []).find(d => d.id === item.id);
          const itemEvent = item.id === standardEvent.planId && !detail
            ? standardEvent
            : { ...standardEvent, planId: item.id, planName: (detail && detail.name) || standardEvent.planName };
          try {
            await _runDayPassGrant({ tenantId, memberId, mappings: item.mappings, standardEvent: itemEvent, eventId, job, logger, traceId, jobStart });
          } catch (err) {
            itemError = itemError || err;   // finish the other passes first, then retry
          }
        }
        if (itemError) throw itemError;
        return;
      }

      // Step 4: Resolve hardware user identity (client-level key — user ops are org-scoped)
      // OB-89 Gate 2: pass tenantId + platformMemberId so standardAdapter can recover
      // missing email via Wix Members API. If ladder exhausts, resolveIdentity returns
      // null and the member is parked as pending_identity — we exit cleanly (not a failure).
      lastStep = 'grant.resolve_identity';
      // let: replaced by the recreated user's id if Kisi says this one is gone (Step 5).
      let hardwareUserId = await standardAdapter.resolveIdentity(
        memberId, standardEvent.email, standardEvent.name,
        mappings[0].hardwarePlatform, apiKey,
        { tenantId, platformMemberId: standardEvent.platformMemberId }
      );
      if (hardwareUserId === null) {
        logger.warn('queue.grant.parked.pending_identity', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'identity', result: 'skipped',
        });
        return;
      }
      logger.info('queue.grant.identity_resolved', {
        clientId, memberId, eventId, hardwareUserId,
        platformMemberId: standardEvent.platformMemberId,
        stage: 'identity', result: 'success',
      });

      // Enrich trace_context now that we have full member + hardware context (DR-041).
      // registerTrace was a no-op here because the row already exists (entry-point
      // middleware writes it at request time with ON CONFLICT DO NOTHING).
      // setTraceContext does an UPDATE-with-COALESCE so we fill the NULL fields.
      registerTrace(traceId, {
        entryPoint:   'queue',
        clientId,
        memberId,
        actorType:    'system',
        actorId:      'queue-worker',
        planName:     mappings[0]?.planName   || null,
        doorName:     mappings[0]?.doorName   || null,
        mappingId:    mappings[0]?.mappingId  || null,
      });
      setTraceContext(traceId, {
        clientId,
        memberId,
        planName:     mappings[0]?.planName   || null,
        doorName:     mappings[0]?.doorName   || null,
        mappingId:    mappings[0]?.mappingId  || null,
      });
      // Two-phase provisioning: if startDate is more than 1 minute in the future,
      // park as pending_start — Kisi user exists but group assignment is deferred.
      // orderStarted fires when the start date arrives and completes the grant.
      const grantStartDate = standardEvent.startDate ? new Date(standardEvent.startDate) : null;
      if (grantStartDate && grantStartDate.getTime() > Date.now() + 60_000) {
        // S-11: parkPendingStart writes per-mapping source rows in 'pending_start' status
        // with scheduled_start_date populated. Access stays 'inactive' until orderStarted lands.
        await standardAdapter.parkPendingStart(
          memberId, tenantId, grantStartDate.toISOString(), mappings
        );
        logger.info('queue.grant.parked.pending_start', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          scheduledStartDate: grantStartDate.toISOString(),
          mappingCount: mappings.length,
          stage: 'grant', result: 'skipped',
        });
        return;
      }

      // Step 5: Execute hardware grant across all active mappings — recreating the Kisi
      // user once if the cached one is gone (see _processGrantRecoveringUser).
      lastStep = 'grant.process_grant';
      const grantResult = await _processGrantRecoveringUser({
        tenantId, memberId, hardwareUserId, mappings, standardEvent, apiKey, eventId, logger,
        onStep: (s) => { lastStep = `grant.${s}`; },
      });
      if (grantResult === null) {
        logger.warn('queue.grant.parked.pending_identity', {
          clientId, memberId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          planId: standardEvent.planId,
          stage: 'identity', result: 'skipped',
        });
        return;
      }
      const assignments = grantResult.assignments;
      hardwareUserId = grantResult.hardwareUserId;
      logger.info('queue.grant.hardware_calls_complete', {
        clientId, memberId, eventId, hardwareUserId,
        platformMemberId: standardEvent.platformMemberId,
        assignments: assignments.length,
        roleAssignmentIds: assignments.map(a => a.roleAssignmentId),
        durationMs: Date.now() - jobStart,
        stage: 'grant', result: 'success',
      });

      // Step 6: Record success — writes all assignments to member_role_assignments
      lastStep = 'grant.complete_grant';
      const billingSnapshot = extractBillingSnapshot(standardEvent.rawPayload);
      await standardAdapter.completeGrant(memberId, tenantId, assignments, billingSnapshot);
      logger.info('queue.grant.complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        assignments: assignments.length,
        durationMs: Date.now() - jobStart,
        // Wix's own currentCycle.index off the order webhook (wix-adapter.js) — lets an
        // operator tell a first purchase (cycleIndex 1/null) from a recurring auto-renewal
        // (cycleIndex > 1) without cross-referencing member_billing.
        cycleIndex: standardEvent.cycleIndex || null,
        isRenewal: standardEvent.cycleIndex != null ? standardEvent.cycleIndex > 1 : null,
        stage: 'grant', result: 'success',
      });

      // DR-052 — member-facing branded email (M1 access-ready / M3 sub-member invite).
      // Fire-and-forget: email outcome never affects the grant job. The mailer applies
      // the ship-dark toggle, the allow-list synthetic suppression, and atomic dedup.
      memberMailer.maybeSendGrantEmail({
        clientId: tenantId, accessId: memberId, standardEvent, assignments,
        eventKey: eventId || job.id,
      }).catch(() => {});

    } else if (job.name === 'revoke') {
      // Step 0: a holder's plan ending takes its seats with it — queued as their own jobs
      // (see _cascadeHolderLapse). Runs before the holder's own revoke on purpose: a holder
      // with no active access row of their own (DR-051 self-release) returns at Step 1.
      lastStep = 'revoke.holder_lapse_cascade';
      await _cascadeHolderLapse(tenantId, standardEvent, logger, job.id);

      // Step 1: Resolve identity + acquire lock (reads hardwarePlatform from existing row).
      // Revoke is per-member (all access rows), not per-plan — planMappingId=null.
      lastStep = 'revoke.resolve_and_lock';
      const lockResult = await standardAdapter.resolveAndLock(tenantId, standardEvent, null, null);

      if (!lockResult) {
        logger.warn('queue.revoke.no_identity', {
          clientId, eventId,
          platformMemberId: standardEvent.platformMemberId,
          eventType: standardEvent.eventType,
          stage: 'revoke', result: 'skipped',
        });
        return; // Member never existed — skip silently
      }

      const { memberId: resolvedMemberId, hardwareUserId, hardwarePlatform, roleAssignmentIds } = lockResult;
      memberId = resolvedMemberId;
      logger.info('queue.revoke.lock_acquired', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        hardwarePlatform,
        roleAssignmentCount: roleAssignmentIds?.length || 0,
        stage: 'revoke', result: 'start',
      });

      // Phase 2 enrichment — mirrors grant path so revoke traces show full member/client context.
      // OB-162: query first active mapping for this member to populate plan/door context.
      registerTrace(traceId, {
        entryPoint: 'queue',
        clientId,
        memberId,
        actorType: 'system',
        actorId:   'queue-worker',
      });
      const revokeMappingRow = roleAssignmentIds?.length
        ? await db.query(
            `SELECT pm.plan_name, pm.door_name, mas.mapping_id
             FROM member_access_sources mas
             JOIN plan_mappings pm ON pm.id = mas.mapping_id
             WHERE mas.access_id = $1
             LIMIT 1`,
            [memberId]
          ).then(r => r.rows[0] || {}).catch(() => ({}))
        : {};
      setTraceContext(traceId, {
        clientId,
        memberId,
        planName:  revokeMappingRow.plan_name  || null,
        doorName:  revokeMappingRow.door_name  || null,
        mappingId: revokeMappingRow.mapping_id || null,
      });

      // Step 2: Execute hardware revoke across all stored role assignments → returns targetStatus
      lastStep = 'revoke.process_revoke';
      const targetStatus = await grantRevokeLogic.processRevoke(
        tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform,
        standardEvent.eventType, standardEvent
      );
      logger.info('queue.revoke.hardware_calls_complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        targetStatus,
        durationMs: Date.now() - jobStart,
        stage: 'revoke', result: 'success',
      });

      // Step 3: Record success
      lastStep = 'revoke.complete_revoke';
      await standardAdapter.completeRevoke(memberId, tenantId, targetStatus);
      logger.info('queue.revoke.complete', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId,
        targetStatus,
        durationMs: Date.now() - jobStart,
        stage: 'revoke', result: 'success',
      });

      // DR-052 — M2 access-removed email. The recipient capture MUST be synchronous and
      // MUST happen HERE: finalizeRevoke below (same awaited job) NULLs member PII per
      // DR-044, after which the address is gone. Only true cancellations qualify
      // (targetStatus 'inactive'); the capture helper itself enforces the allow-list
      // (real plan/booking cancellations + holder-initiated sub-member removals — never
      // holder self-release, reconcile drift, or member.deleted). The send is then
      // fire-and-forget with the context already in memory.
      if (targetStatus === 'inactive') {
        const removedCtx = await memberMailer.captureAccessRemovedContext({
          clientId: tenantId, accessId: memberId, standardEvent,
        });
        if (removedCtx) {
          memberMailer.maybeSendAccessRemovedEmail({
            clientId: tenantId, accessId: memberId, standardEvent,
            context: removedCtx, eventKey: eventId || job.id,
          }).catch(() => {});
        }
      } else if (targetStatus === 'disabled') {
        // DR-052 — M4 access-suspended email (payment.failed). Source rows are
        // preserved on suspend (fast recovery), so unlike M2 there's no PII-
        // deletion race — no separate capture step needed.
        memberMailer.maybeSendAccessSuspendedEmail({
          clientId: tenantId, accessId: memberId, standardEvent, eventKey: eventId || job.id,
        }).catch(() => {});
      }

      // Step 4 (OB-248): DR-044 finalize — delete Kisi user + NULL PII + mark
      // access 'deleted'. Runs on a full revoke (targetStatus='inactive') and on
      // member.deleted ('deleted' — processRevoke removed the doors, finalize owns
      // the user delete); suspends ('disabled') and recoveries ('active') skip.
      // DR-045 three-layer guard inside finalizeRevoke handles unowned /
      // cross-tenant / elevated-role refusals — surfaces to operator queue
      // without throwing. Other Kisi errors throw so BullMQ can retry.
      if (targetStatus === 'inactive' || targetStatus === 'deleted') {
        lastStep = 'revoke.finalize';
        try {
          const finalizeApiKey = await getClientApiKey(tenantId);
          if (finalizeApiKey) {
            const finalizeResult = await standardAdapter.finalizeRevoke(
              memberId, tenantId, hardwarePlatform, finalizeApiKey, hardwareUserId
            );
            logger.info('queue.revoke.finalize.result', {
              clientId, memberId, eventId,
              finalized: finalizeResult.finalized,
              reason:    finalizeResult.reason,
              hardwareUserId: hardwareUserId || null,
              durationMs: Date.now() - jobStart,
              stage: 'revoke', result: finalizeResult.finalized ? 'success' : 'skipped',
            });
          } else {
            logger.warn('queue.revoke.finalize_skipped_no_api_key', {
              clientId, memberId, eventId,
              hardwareUserId: hardwareUserId || null,
              stage: 'revoke', result: 'skipped',
            });
          }
        } catch (finalizeErr) {
          // finalizeRevoke threw — propagate so BullMQ retries the whole revoke job.
          // completeRevoke already committed (doors removed, sources cleared), so the
          // rollup says 'inactive' — and the retry's lookup, which looks for a door to
          // remove, found nobody: it logged no_identity and completed, leaving the Kisi
          // user and the PII with no alert (2026-10-26 audit). The error path below parks
          // the member at 'removing' instead (DR-044: removal under way), which the lookup
          // matches: the revoke re-runs with nothing left to remove and finalize runs again.
          finalizePending = true;
          logger.error('queue.revoke.finalize_failed', {
            clientId, memberId, eventId,
            hardwareUserId: hardwareUserId || null,
            stage: 'revoke', result: 'failed',
          }, finalizeErr);
          throw finalizeErr;
        }
      }

    } else {
      logger.warn('queue.job.unknown_name', { jobId: job.id, jobName: job.name, clientId, eventId });
    }

  } catch (error) {
    logger.error('queue.job.failed', {
      jobId: job.id, jobName: job.name,
      clientId, memberId, eventId,
      attempt: job.attemptsMade,
      lastStep,
      platformMemberId: standardEvent?.platformMemberId || null,
      planId: standardEvent?.planId || null,
      eventType: standardEvent?.eventType || null,
      emailPresent: !!(standardEvent?.email),
      namePresent: !!(standardEvent?.name),
      durationMs: Date.now() - jobStart,
      stage: lastStep.split('.')[0], result: 'failed',
    }, error);

    // Release in_flight lock before BullMQ retries.
    // error.memberId is set by the in_flight lock throw when memberId isn't yet assigned
    // in the outer scope (i.e. the lock fired before resolveAndLock returned).
    const lockMemberId = memberId || error.memberId || null;
    if (lockMemberId) {
      await standardAdapter.releaseLock(lockMemberId, tenantId, finalizePending ? 'removing' : 'failed');
    }

    // IN_FLIGHT_LOCK is a transient race — let BullMQ retry with its normal backoff, never escalate it to an
    // UnrecoverableError. If the member is STILL locked after every attempt, worker.on('failed') dead-letters it
    // like any exhausted job: a member stuck behind a lock must be visible (core/error-guidance.js says "nothing to
    // do" for a one-off and hands it to AccessSync support once it repeats).
    if (error.code === 'IN_FLIGHT_LOCK') {
      throw error;
    }

    // 4xx errors (except 429) are non-retryable — bad config, not transient failures.
    // Throw UnrecoverableError so BullMQ dead-letters immediately without exhausting retries.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
      const unrecoverable = new UnrecoverableError(`Non-retryable hardware error (${error.statusCode}): ${error.message}`);
      // Carry the original error's classification across the wrapper. Without these the
      // dead-letter step sees an error with no code/status/userMessage: it cannot dedupe
      // (a duplicate error_queue row per failure) and stores nothing the operator can act on.
      unrecoverable.original = error;
      for (const key of ['code', 'statusCode', 'userMessage', 'action', 'resolution', 'body']) {
        if (error[key] !== undefined) unrecoverable[key] = error[key];
      }
      throw unrecoverable;
    }

    // BUG-01 fix: throw so BullMQ retries. Dead-letter via worker.on('failed') → retryEngine.
    throw error;
  }
}

// Max parallel jobs across all tenants. Each job holds one Postgres connection through
// resolveAndLock and the Supabase session pooler allows 15, so this must stay well under it.
const WORKER_CONCURRENCY = 10;

/**
 * Start the BullMQ worker.
 * Called once at server boot from server.js.
 * Returns the worker instance for graceful shutdown.
 */
function startWorker() {
  const worker = new Worker('accesssync-events', processJob, {
    connection,
    concurrency: WORKER_CONCURRENCY,  // DR-035: rate limiting is per-adapter inside each connector (e.g. kisi-connector enforces 5 req/sec).
                      // Worker concurrency is not the rate limit — it's max parallel jobs across all tenants/platforms.
                      // 2026-10-15: 20 → 10. The Supabase session pooler allows 15 connections and each job holds
                      // one through resolveAndLock; at 20 a purchase burst hit EMAXCONNSESSION (2026-10-05 03:19,
                      // 14 pool-exhausted recoveries). 10 leaves headroom for the admin service and the sweep.
  });

  // The per-member lock (withMemberLock) uses the Worker's non-blocking Redis client.
  if (worker.client && typeof worker.client.then === 'function') {
    _lockClientPromise = worker.client;
  }

  worker.on('completed', (job) => {
    const traceId = job.data?.standardEvent?.traceId || null;
    const logger = traceId ? withTrace(traceId) : log;
    logger.info('queue.job.completed', {
      jobId: job.id, jobName: job.name,
      clientId: job.data?.tenantId || null,
      eventId: job.data?.standardEvent?.eventId || null,
      platformMemberId: job.data?.standardEvent?.platformMemberId || null,
      stage: 'queue', result: 'success',
    });
  });

  worker.on('failed', async (job, err) => {
    const traceId = job.data?.standardEvent?.traceId || null;
    const logger = traceId ? withTrace(traceId) : log;
    logger.error('queue.job.exhausted', {
      jobId: job.id, jobName: job.name,
      clientId: job.data?.tenantId || null,
      eventId: job.data?.standardEvent?.eventId || null,
      platformMemberId: job.data?.standardEvent?.platformMemberId || null,
      attempt: job.attemptsMade, maxAttempts: job.opts.attempts,
      stage: 'queue', result: 'failed',
    }, err);

    // An UnrecoverableError (4xx: bad key, bad group, rejected payload) ends the job on its
    // FIRST attempt, so attemptsMade is below opts.attempts. Gating on attempts alone dropped
    // every such failure: no error_queue row, no operator email, and the panels read "Clean".
    const unrecoverable = !!err && (err instanceof UnrecoverableError || err.name === 'UnrecoverableError');
    if (unrecoverable || job.attemptsMade >= job.opts.attempts) {
      // BullMQ fires 'failed' outside the job's async context, so without re-binding it the error_queue row and
      // its log lines had no trace id, actor or client: the incident could not be followed back to its webhook.
      const deadLetter = () => retryEngine.handleFailure(job, err);
      await (traceId
        ? runWith({ traceId, actor: { type: 'system', id: 'queue-worker' }, clientId: job.data?.tenantId || null }, deadLetter)
        : deadLetter());
    }
  });

  worker.on('error', (err) => {
    log.critical('queue.worker.error', {}, err);
  });

  // DR-023: BullMQ stall events bypass the catch block in processJob — the lock
  // is never released via the normal path when a worker process is killed mid-job.
  // This handler recovers the job data and calls releaseLock() so the member is
  // never permanently stuck at in_flight.
  worker.on('stalled', async (jobId) => {
    try {
      const job = await eventQueue.getJob(jobId);
      if (!job) {
        log.warn('queue.job.stalled.no_job', { jobId });
        return;
      }
      const { tenantId, standardEvent } = job.data || {};
      const platformMemberId = standardEvent?.platformMemberId || null;
      log.warn('queue.job.stalled', {
        jobId, jobName: job.name,
        clientId: tenantId || null,
        platformMemberId,
        stage: 'queue', result: 'stalled',
      });
      // Recover member_id from DB so we can release the lock.
      // Composite key (client_id, source_platform, platform_member_id) — schema UNIQUE.
      if (tenantId && platformMemberId) {
        const result = await db.query(
          `SELECT ma.id FROM member_access ma
           JOIN member_master mm ON mm.id = ma.member_master_id
           WHERE mm.client_id = $1 AND mm.source_platform = 'wix'
             AND mm.platform_member_id = $2 AND ma.status = 'in_flight'`,
          [tenantId, platformMemberId]
        );
        if (result.rows.length) {
          const memberId = result.rows[0].id;
          await standardAdapter.releaseLock(memberId, tenantId, 'failed');
          log.info('queue.job.stalled.lock_released', { jobId, memberId, clientId: tenantId });
        } else {
          log.info('queue.job.stalled.no_lock', { jobId, clientId: tenantId, platformMemberId });
        }
      }
    } catch (err) {
      log.error('queue.job.stalled.release_failed', { jobId }, err);
    }
  });

  log.info('queue.worker.started', { queue: 'accesssync-events', concurrency: WORKER_CONCURRENCY });
  return worker;
}

module.exports = {
  startWorker, processJob, _processJobBody, _runDayPassGrant, _unitsBought, _resolveStoreMappings,
  withMemberLock, memberLockKey, _setMemberLockClient,
  _cascadeHolderLapse, HOLDER_LAPSE_CASCADE_SOURCE,
};
