/**
 * @file member-access-log.js
 * @layer core/layer4
 * @role audit-log-helper
 * @reads (none)
 * @writes member_access_log
 * @exports logMemberAccessEvent
 * @ob OB-205
 *
 * core/member-access-log.js
 *
 * Single helper for inserting rows into member_access_log.
 *
 * OB-205: previously 7 separate INSERT sites with divergent column lists
 * (only 5 of the 8 possible columns guaranteed; the other 3 — mapping_id,
 * hardware_group_id, credential_type — appearing in different subsets).
 * Trace_id was already retrofitted across all sites once in Sprint 6 Phase 1
 * (commit d434b91). This helper makes the next retrofit a single-site
 * change instead of an N-site change.
 *
 * Contract: all callers pass memberId + clientId + eventType + any subset of
 * the optional fields. The helper reads trace_id + actor_type + actor_id
 * from AsyncLocalStorage via core/trace-context. NULLs are coalesced safely.
 * created_at uses the DB column default (CURRENT_TIMESTAMP).
 *
 * Returns the inserted row's id. Never throws — DB failures are logged via
 * logger.error and the call returns null so the parent flow is not blocked.
 *
 * Schema reference (member_access_log, post-S-11 / Supabase live):
 *   id                uuid PK   default uuid_generate_v4()
 *   member_id         uuid      NOT NULL
 *   client_id         uuid      NOT NULL
 *   event_type        varchar   NOT NULL
 *   credential_type   varchar   nullable
 *   credential_value  text      nullable    (not exposed by helper — unused in code)
 *   error_code        varchar   nullable
 *   created_at        timestamptz nullable  default CURRENT_TIMESTAMP
 *   trace_id          varchar   nullable
 *   actor_type        varchar   nullable
 *   actor_id          varchar   nullable
 *   mapping_id        uuid      nullable
 *   hardware_group_id varchar   nullable
 *
 * @param {object} args
 * @param {string} args.memberId          Required. member_access.id (UUID).
 * @param {string} args.clientId          Required. clients.id (UUID).
 * @param {string} args.eventType         Required. e.g. 'provisioned', 'revoked'.
 * @param {string} [args.mappingId]       Optional. plan_mappings.id.
 * @param {string} [args.hardwareGroupId] Optional. Kisi hardware_group_id.
 * @param {string} [args.credentialType]  Optional. e.g. 'group', 'role', 'location_lapse'.
 * @param {string} [args.errorCode]       Optional. error classification string.
 * @returns {Promise<string|null>}        Inserted row id, or null on failure.
 */

'use strict';

const db = require('../db');
const { getTraceId, getActor } = require('./trace-context');
const { log } = require('./logger');

async function logMemberAccessEvent({
  memberId,
  clientId,
  eventType,
  mappingId = null,
  hardwareGroupId = null,
  credentialType = null,
  errorCode = null,
} = {}) {
  if (!memberId || !clientId || !eventType) {
    log.warn('member_access_log.helper.invalid_args', {
      memberId, clientId, eventType,
      reason: 'memberId+clientId+eventType all required',
    });
    return null;
  }

  const traceId = getTraceId() || null;
  const actor = getActor() || {};
  const actorType = actor.type || null;
  const actorId = actor.id || null;

  try {
    const result = await db.query(
      `INSERT INTO member_access_log
         (member_id, client_id, event_type, mapping_id, hardware_group_id,
          credential_type, error_code, trace_id, actor_type, actor_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        memberId, clientId, eventType, mappingId, hardwareGroupId,
        credentialType, errorCode, traceId, actorType, actorId,
      ]
    );
    return result.rows[0]?.id || null;
  } catch (err) {
    log.error('member_access_log.helper.insert_failed', {
      memberId, clientId, eventType,
    }, err);
    return null;
  }
}

module.exports = { logMemberAccessEvent };
