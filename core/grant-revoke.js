/**
 * @file grant-revoke.js
 * @layer core/layer4
 * @role provisioning
 * @reads plan_mappings, member_identity, member_access_log, member_role_assignments
 * @writes member_access_log, config_alert_log, plan_mapping_groups (health_status), diagnostic_log (via logger)
 * @calls hardware-adapter
 * @exports processGrant, processRevoke
 * @dr DR-022, DR-026
 *
 * grant-revoke.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Pure grant and revoke logic
 * - Hardware calls via hardwareAdapter (Layer 5) — never calls Kisi/Seam directly
 * - Audit trail writes to member_access_log and config_alert_log
 * - Returns targetStatus to queue-worker so Standard Adapter (Layer 3) can write state
 *
 * Does NOT write to member_identity or member_access_state (DR-023 — Standard Adapter owns these).
 * Identity is resolved before this module is called. Lock is acquired before. State is written after.
 */

const db = require('../db');
const hardwareAdapter = require('../adapters/hardware-adapter');
const planMappingResolver = require('./plan-mapping-resolver');
const { decryptApiKey } = require('./crypto-utils');
const { log } = require('./logger');

class GrantRevokeLogic {

  /**
   * Executes the hardware grant for a member across all active plan mappings.
   * Called by queue-worker after Standard Adapter resolves identity and acquires lock.
   *
   * @param {string} tenantId
   * @param {string} memberId         member_identity.id
   * @param {string} hardwareUserId   resolved hardware platform user ID
   * @param {Array}  mappings         from planMappingResolver.resolve() — array of active mappings
   * @param {Object} wixEvent         standard event object
   * @returns {Array} assignments     [{ mappingId, roleAssignmentId }] — passed to completeGrant()
   */
  async processGrant(tenantId, memberId, hardwareUserId, mappings, wixEvent) {
    const assignments = [];
    const failedGroups = [];
    let newHardwareCallMade = false; // only true when assignRole() was actually called

    for (const mapping of mappings) {
      const apiKey = mapping.apiKey;

      // Idempotency guard: if any prior grant already created a hardware
      // role_assignment for this member on this group, reuse it.
      // Two separate checks:
      //   1. Exact match (member, mapping, group) — retry of the same job
      //   2. Group-only match (member, group, any mapping) — second plan that
      //      shares the same Kisi group as a previously-granted plan. Kisi
      //      returns 409 in both cases; the member already has the door open.
      // We intentionally still INSERT a new member_role_assignments row in
      // completeGrant with this mapping_id so the source is correctly tracked.
      // OB-47: Pre-grant source check (DR-034).
      // Check member_access_sources for an existing permanent row on this group.
      // A permanent row means the member already has hardware access from another
      // active source — making a second hardware assignRole call would be redundant
      // (Kisi returns 409) and could corrupt valid_until on a permanent assignment.
      // We still record the new source row so revoke tracking stays accurate.
      if (mapping.hardwareGroupId) {
        const sourceCheck = await db.query(
          `SELECT mas.source_plan_id, mas.source_type, mra.role_assignment_id
           FROM member_access_sources mas
           JOIN member_role_assignments mra
             ON mra.member_id = mas.member_id
            AND mra.hardware_group_id = mas.hardware_group_id
           WHERE mas.member_id = $1
             AND mas.hardware_group_id = $2
           ORDER BY mas.granted_at ASC
           LIMIT 1`,
          [memberId, mapping.hardwareGroupId]
        );
        if (sourceCheck.rows.length > 0 && sourceCheck.rows[0].role_assignment_id) {
          const priorRaId = sourceCheck.rows[0].role_assignment_id;
          log.info('grant.role.source_exists', {
            clientId: tenantId, memberId,
            platformMemberId: wixEvent.platformMemberId,
            hardwareGroupId: mapping.hardwareGroupId,
            mappingId: mapping.mappingId,
            priorSourcePlanId: sourceCheck.rows[0].source_plan_id,
            priorSourceType:   sourceCheck.rows[0].source_type,
            roleAssignmentId:  priorRaId,
            reason: 'permanent_access_exists',
            stage: 'grant', result: 'skipped',
          });
          assignments.push({
            mappingId:        mapping.mappingId,
            roleAssignmentId: String(priorRaId),
            hardwareGroupId:  mapping.hardwareGroupId,
            sourcePlanId:     wixEvent.planId || null,
            sourceType:       wixEvent.eventType === 'booking.confirmed' ? 'booking' : 'plan',
          });
          continue; // Hardware call skipped — source row recorded via completeGrant
        }
      }

      const existing = await db.query(
        `SELECT role_assignment_id, mapping_id FROM member_role_assignments
         WHERE member_id = $1
           AND hardware_group_id = $2
           AND role_assignment_id IS NOT NULL
         ORDER BY created_at ASC
         LIMIT 1`,
        [memberId, mapping.hardwareGroupId || null]
      );
      if (existing.rows.length > 0 && existing.rows[0].role_assignment_id) {
        const priorId = existing.rows[0].role_assignment_id;
        const samePlan = existing.rows[0].mapping_id === mapping.mappingId;
        const newIsTimeLimited = mapping.accessType === 'time_limited';

        log.info('grant.role.reused', {
          clientId: tenantId, memberId,
          platformMemberId: wixEvent.platformMemberId,
          hardwareGroupId: mapping.hardwareGroupId,
          mappingId: mapping.mappingId,
          priorMappingId: existing.rows[0].mapping_id,
          roleAssignmentId: priorId,
          reason: samePlan ? 'retry' : 'shared_group',
          newAccessType: mapping.accessType || 'permanent',
          stage: 'grant', result: 'skipped',
        });

        // Kisi enforces one role per group — can't create a second assignment with a
        // different valid_until. Source tracking in member_access_sources handles revoke
        // safety: this plan's source row is still recorded via completeGrant, so
        // cancelling the other plan won't revoke hardware access until all sources gone.
        if (!samePlan && newIsTimeLimited) {
          log.warn('grant.role.time_limit_not_applied', {
            clientId: tenantId, memberId,
            platformMemberId: wixEvent.platformMemberId,
            hardwareGroupId: mapping.hardwareGroupId,
            mappingId: mapping.mappingId,
            note: 'New plan is time-limited but group already has a role assignment. Member retains existing access; source row still recorded for revoke tracking.',
            stage: 'grant', result: 'skipped',
          });
        }

        assignments.push({
          mappingId:        mapping.mappingId,
          roleAssignmentId: String(priorId),
          hardwareGroupId:  mapping.hardwareGroupId,
          sourcePlanId:     wixEvent.planId || null,
          sourceType:       wixEvent.eventType === 'booking.confirmed' ? 'booking' : 'plan',
        });
        continue; // Skip hardware call for this mapping
      }

      log.info('grant.role.assigning', {
        clientId: tenantId, memberId, hardwareUserId,
        platformMemberId: wixEvent.platformMemberId,
        hardwareGroupId: mapping.hardwareGroupId,
        mappingId: mapping.mappingId,
        stage: 'grant', result: 'start',
      });
      // K-2: On 404 (group deleted), flag the specific group row and continue the loop.
      // Other groups on the same mapping still get attempted — member gets partial access.
      try {
        const roleId = await hardwareAdapter.assignRole(
          mapping.hardwarePlatform, apiKey, hardwareUserId, mapping.hardwareGroupId
        );
        newHardwareCallMade = true;
        assignments.push({
          mappingId:        mapping.mappingId,
          roleAssignmentId: String(roleId),
          hardwareGroupId:  mapping.hardwareGroupId,
          sourcePlanId:     wixEvent.planId || null,
          sourceType:       wixEvent.eventType === 'booking.confirmed' ? 'booking' : 'plan',
        });
      } catch (err) {
        if (err.code === 'HARDWARE_RESOURCE_NOT_FOUND') {
          log.warn('grant.group_not_found', {
            clientId: tenantId, memberId,
            platformMemberId: wixEvent.platformMemberId,
            mappingId: mapping.mappingId,
            hardwareGroupId: mapping.hardwareGroupId,
            stage: 'grant', result: 'failed',
          }, err);
          // Flag the specific dead group — mapping stays active, other groups keep working
          setImmediate(() => {
            db.query(
              `UPDATE plan_mapping_groups SET health_status = 'not_found'
               WHERE mapping_id = $1 AND hardware_group_id = $2`,
              [mapping.mappingId, mapping.hardwareGroupId]
            ).catch(() => {});
            db.query(
              `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
               VALUES ($1, 'group_not_found', $2)`,
              [tenantId, mapping.hardwareGroupId]
            ).catch(() => {});
          });
          failedGroups.push({ mapping, err });
          continue; // Try remaining groups
        }
        throw err; // Non-404 errors still throw immediately
      }
    }

    // If ALL groups failed, dead-letter the job
    if (failedGroups.length > 0 && assignments.length === 0) {
      throw failedGroups[0].err;
    }
    // If some succeeded and some failed, log warning but return successful assignments
    if (failedGroups.length > 0) {
      log.warn('grant.partial_failure', {
        clientId: tenantId, memberId,
        platformMemberId: wixEvent.platformMemberId,
        succeeded: assignments.length,
        failed: failedGroups.length,
        failedGroups: failedGroups.map(f => f.mapping.hardwareGroupId),
        stage: 'grant', result: 'failed',
      });
    }

    // Only write the provisioned log entry when a real hardware call was made.
    // Idempotency-reuse jobs (all mappings skipped via the existing-role guard) do
    // not produce a new provisioned entry — they are duplicates from Wix multi-firing
    // the same purchase event (orderCreated / orderPurchased / orderStarted).
    if (newHardwareCallMade) {
      await db.query(
        `INSERT INTO member_access_log (member_id, client_id, event_type)
         VALUES ($1, $2, 'provisioned')`,
        [memberId, tenantId]
      );
    } else {
      log.info('grant.log.skipped_duplicate', {
        clientId: tenantId, memberId,
        platformMemberId: wixEvent.platformMemberId,
        reason: 'all_assignments_reused',
        stage: 'grant', result: 'skipped',
      });
    }

    return assignments;
  }

  /**
   * Looks up and decrypts the client-level hardware API key for revoke operations.
   */
  async _getClientApiKey(tenantId) {
    const result = await db.query('SELECT hardware_api_key FROM clients WHERE id = $1', [tenantId]);
    const enc = result.rows[0]?.hardware_api_key;
    if (enc) return decryptApiKey(enc);
    return null;
  }

  async processRevoke(tenantId, memberId, hardwareUserId, roleAssignmentIds, hardwarePlatform, eventType, wixEvent) {
    log.info('revoke.start', {
      clientId: tenantId, memberId, eventType,
      platformMemberId: wixEvent.platformMemberId,
      stage: 'revoke', result: 'start',
    });

    const apiKey = await this._getClientApiKey(tenantId);

    switch (eventType) {

      case 'payment.failed': {
        await hardwareAdapter.suspendAccess(
          hardwarePlatform, apiKey, hardwareUserId,
          `Payment failed on ${new Date().toISOString()}`
        );
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'disabled')`,
          [memberId, tenantId]
        );
        return 'disabled';
      }

      case 'plan.cancelled':
      case 'booking.cancelled': {
        const sourceType = eventType === 'booking.cancelled' ? 'booking' : 'plan';
        const planId = wixEvent.planId || null;

        const raWithGroups = await db.query(
          `SELECT mra.role_assignment_id, mra.hardware_group_id
           FROM member_role_assignments mra
           WHERE mra.member_id = $1`,
          [memberId]
        );

        // Member was never provisioned — no hardware assignments to remove.
        // Happens when a cancel fires before (or without) a successful grant,
        // e.g. Wix fires orderCancelled on a superseded order when a new one is created.
        if (raWithGroups.rows.length === 0 && roleAssignmentIds.length === 0) {
          log.info('revoke.skipped.never_provisioned', {
            clientId: tenantId, memberId,
            platformMemberId: wixEvent.platformMemberId,
            eventType, planId,
            stage: 'revoke', result: 'skipped',
          });
          return 'revoked';
        }

        for (const { role_assignment_id: raId, hardware_group_id: groupId } of raWithGroups.rows) {
          await db.query(
            `DELETE FROM member_access_sources
             WHERE member_id = $1
               AND hardware_group_id = $2
               AND source_type = $3
               AND COALESCE(source_plan_id, '') = COALESCE($4, '')`,
            [memberId, groupId, sourceType, planId]
          );

          const remaining = await db.query(
            `SELECT COUNT(*) AS cnt FROM member_access_sources
             WHERE member_id = $1 AND hardware_group_id = $2`,
            [memberId, groupId]
          );

          const remainingCount = parseInt(remaining.rows[0].cnt, 10);
          if (remainingCount > 0) {
            log.info('revoke.group.skipped', {
              clientId: tenantId, memberId,
              platformMemberId: wixEvent.platformMemberId,
              hardwareGroupId: groupId, remainingSources: remainingCount,
              stage: 'revoke', result: 'skipped', reason: 'other_sources_active',
            });
          } else {
            await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
          }
        }

        // Fallback: legacy member with no member_role_assignments rows
        if (raWithGroups.rows.length === 0 && roleAssignmentIds.length > 0) {
          log.warn('revoke.legacy_fallback', {
            clientId: tenantId, memberId,
            platformMemberId: wixEvent.platformMemberId,
            roleAssignmentCount: roleAssignmentIds.length,
            stage: 'revoke', result: 'retry',
          });
          for (const raId of roleAssignmentIds) {
            await hardwareAdapter.removeRole(hardwarePlatform, apiKey, raId);
          }
        }

        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'revoked')`,
          [memberId, tenantId]
        );
        return 'revoked';
      }

      case 'member.deleted': {
        if (hardwareUserId) {
          await hardwareAdapter.deleteUser(hardwarePlatform, apiKey, hardwareUserId);
        }
        await db.query(
          `INSERT INTO member_access_log (member_id, client_id, event_type) VALUES ($1, $2, 'deleted')`,
          [memberId, tenantId]
        );
        await db.query(
          `INSERT INTO config_alert_log (client_id, alert_type, hardware_ref)
           VALUES ($1, 'member_deleted_review', $2)`,
          [tenantId, hardwareUserId || wixEvent.platformMemberId]
        );
        return 'deleted';
      }

      default: {
        const err = new Error(`Unknown revoke event type: ${eventType}`);
        err.code = 'REVOKE_UNKNOWN_EVENT';
        log.error('revoke.unknown_event_type', {
          clientId: tenantId, memberId,
          platformMemberId: wixEvent.platformMemberId,
          eventType,
          stage: 'revoke', result: 'failed',
        }, err);
        throw err;
      }
    }
  }
}

module.exports = new GrantRevokeLogic();
