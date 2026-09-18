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

const { Worker, UnrecoverableError } = require('bullmq');
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
const { runWith, registerTrace, setTraceContext } = require('./trace-context');
const memberMailer = require('./member-mailer');

const connection = getRedisConnection();

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

  const endDate = grantRevokeLogic.dayPassEndDate(standardEvent, mappings);
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

  // Every paid unit gets its own door code. The claim key is the product PLUS the
  // order and unit — so a second purchase of the same pass is a new pass (the buyer
  // may be handing codes to other people), while Wix's 2-3 echoes of ONE order share
  // a key and still collapse to a single code. No order id (legacy / synthetic) →
  // the bare product id, i.e. the old one-pass-per-product behaviour.
  const orderId = standardEvent.wixOrderId || null;
  const units   = _unitsBought(standardEvent, planId, logger);
  const billingSnapshot = extractBillingSnapshot(standardEvent.rawPayload);

  const links = [];
  const unitsGranted = [];
  let firstError = null;

  for (let unit = 1; unit <= units; unit++) {
    const sourceKey = orderId ? `${planId}#${orderId}#${unit}` : planId;
    const claimed = await standardAdapter.claimDayPassSources(memberId, tenantId, mappings, sourceKey);
    if (claimed.length === 0) {
      logger.info('grant.day_pass.claim_lost', {
        clientId, memberId, eventId,
        platformMemberId: standardEvent.platformMemberId, planId,
        wixOrderId: orderId, unit, units,
        mappingCount: mappings.length,
        stage: 'grant', result: 'skipped',
      });
      continue;
    }

    // One unit failing must not strand the codes already minted for this order —
    // they are emailed below, then the job throws so the retry finishes the rest.
    let result;
    try {
      result = await grantRevokeLogic.processDayPassGrant(
        tenantId, memberId, claimed, standardEvent,
        { email: identity.email, sourceKey, unit, units }
      );
    } catch (err) {
      await standardAdapter.releaseDayPassClaims(memberId, tenantId, claimed, sourceKey).catch(() => {});
      firstError = firstError || err;
      continue;
    }
    const okMappingIds = new Set(result.assignments.map(a => a.mappingId));
    const failedClaims = claimed.filter(m => !okMappingIds.has(m.mappingId));
    if (failedClaims.length > 0) {
      await standardAdapter.releaseDayPassClaims(memberId, tenantId, failedClaims, sourceKey).catch(() => {});
    }

    await standardAdapter.completeGrant(memberId, tenantId, result.assignments, billingSnapshot);
    links.push(...result.links);
    unitsGranted.push(unit);
  }

  if (links.length === 0) {
    await standardAdapter.rollupAccessStatus(memberId);
    if (firstError) throw firstError;
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
    wixOrderId: orderId, units, unitsGranted,
    links: links.length,
    validUntil: endDate,
    durationMs: Date.now() - jobStart,
    stage: 'grant', result: 'success',
  });

  // Keyed on the units this job minted, so a retry that finishes the remaining units
  // sends THEIR codes instead of being deduped against the first email.
  memberMailer.maybeSendDayPassEmail({
    clientId: tenantId, accessId: memberId, standardEvent,
    links, recipientEmail: identity.email,
    eventKey: `${orderId || eventId || job.id}:u${unitsGranted.join('-')}`,
  }).catch(() => {});

  if (firstError) throw firstError;
}

// A sanity ceiling, not a product rule: one order minting hundreds of Kisi links is a
// malformed payload or an abuse case, not a group outing.
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
 * @returns {Promise<Array|null>} mappings, or null when no line item is mapped
 */
async function _resolveStoreMappings(tenantId, standardEvent, logger) {
  const ids = Array.isArray(standardEvent.lineItemPlanIds) && standardEvent.lineItemPlanIds.length
    ? standardEvent.lineItemPlanIds
    : [standardEvent.planId].filter(Boolean);

  const matched = [];
  for (const id of ids) {
    const mappings = await planMappingResolver.resolve(tenantId, id);
    if (Array.isArray(mappings) && mappings.length > 0) matched.push({ id, mappings });
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
 * Job processor function.
 * BullMQ calls this for every job dequeued. Returning normally = success. Throwing = retry.
 *
 * DR-037: ALS does not cross process boundaries. traceId is read from job payload
 * and explicitly re-bound via runWith so all downstream log calls auto-carry it.
 */
async function processJob(job) {
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

  return runWith(
    { traceId, actor: { type: 'system', id: 'queue-worker' } },
    () => _processJobBody(job, traceId)
  );
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
        const startedAssignments = await grantRevokeLogic.processGrant(
          tenantId, memberId, startedHardwareUserId, mappings, standardEvent
        );

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
      const hardwareUserId = await standardAdapter.resolveIdentity(
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

      // Step 5: Execute hardware grant across all active mappings
      lastStep = 'grant.process_grant';
      const assignments = await grantRevokeLogic.processGrant(
        tenantId, memberId, hardwareUserId, mappings, standardEvent
      );
      logger.info('queue.grant.hardware_calls_complete', {
        clientId, memberId, eventId,
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
      // access 'deleted'. Only runs on full revoke (targetStatus='inactive');
      // suspends (targetStatus='disabled') and recoveries ('active') skip.
      // DR-045 three-layer guard inside finalizeRevoke handles unowned /
      // cross-tenant / elevated-role refusals — surfaces to operator queue
      // without throwing. Other Kisi errors throw so BullMQ can retry.
      if (targetStatus === 'inactive') {
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
          // completeRevoke already committed (sources cleared); the retry will see
          // status='inactive' and finalize will resume from there. Idempotent.
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
      await standardAdapter.releaseLock(lockMemberId, tenantId, 'failed');
    }

    // IN_FLIGHT_LOCK is a transient race — let BullMQ retry with its normal backoff.
    // Do not dead-letter or escalate to UnrecoverableError.
    if (error.code === 'IN_FLIGHT_LOCK') {
      throw error;
    }

    // 4xx errors (except 429) are non-retryable — bad config, not transient failures.
    // Throw UnrecoverableError so BullMQ dead-letters immediately without exhausting retries.
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429) {
      throw new UnrecoverableError(`Non-retryable hardware error (${error.statusCode}): ${error.message}`);
    }

    // BUG-01 fix: throw so BullMQ retries. Dead-letter via worker.on('failed') → retryEngine.
    throw error;
  }
}

/**
 * Start the BullMQ worker.
 * Called once at server boot from server.js.
 * Returns the worker instance for graceful shutdown.
 */
function startWorker() {
  const worker = new Worker('accesssync-events', processJob, {
    connection,
    concurrency: 20,  // DR-035: rate limiting is per-adapter inside each connector (e.g. kisi-connector enforces 5 req/sec).
                      // Worker concurrency is not the rate limit — it's max parallel jobs across all tenants/platforms.
  });

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

    if (job.attemptsMade >= job.opts.attempts) {
      await retryEngine.handleFailure(job, err);
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

  log.info('queue.worker.started', { queue: 'accesssync-events', concurrency: 20 });
  return worker;
}

module.exports = { startWorker, processJob, _processJobBody, _runDayPassGrant, _unitsBought };
