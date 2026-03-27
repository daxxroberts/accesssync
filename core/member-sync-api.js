/**
 * member-sync-api.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Serves raw DB access state to the Wix Velo frontend (Phase 5)
 * - Returns raw fields only — Velo (PIXEL) handles all UI state mapping (OB-07)
 * - JWT verification stubbed — must implement before Phase 5 launch (OB-08)
 *
 * SAGE decision: Core Engine returns raw DB data. UI state logic (6 state builders,
 * _mapToUIState, etc.) lives in Velo, not here.
 *
 * Endpoint: GET /member/access-status?platformMemberId=X&clientId=Y
 */

const db = require('../db');

class MemberSyncApi {

  /**
   * GET /member/access-status
   *
   * Query params:
   *   platformMemberId  - The member's platform ID (Wix member ID for Wix platform)
   *   clientId          - The AccessSync client UUID
   *
   * Returns raw DB fields. Velo (OB-07) maps these to UI states — Core Engine does not.
   */
  async getAccessStatus(req, res) {
    try {
      // TODO OB-08: Implement real Wix JWT verification before Phase 5 launch — security gate.
      // const jwtValid = await this._verifyWixJWT(req);
      // if (!jwtValid) return res.status(401).json({ error: 'Unauthorized' });

      const { platformMemberId, clientId } = req.query;

      if (!platformMemberId || !clientId) {
        return res.status(400).json({ error: 'platformMemberId and clientId are required' });
      }

      // 1. Resolve member_identity
      const identityResult = await db.query(
        `SELECT id, hardware_user_id, hardware_platform, source_platform
         FROM member_identity
         WHERE platform_member_id = $1 AND client_id = $2
         LIMIT 1`,
        [platformMemberId, clientId]
      );

      if (identityResult.rows.length === 0) {
        return res.status(404).json({ error: 'Member not found' });
      }

      const identity = identityResult.rows[0];

      // 2. Fetch access state
      const stateResult = await db.query(
        `SELECT status, role_assignment_id, provisioned_at, updated_at
         FROM member_access_state
         WHERE member_id = $1`,
        [identity.id]
      );

      const state = stateResult.rows[0] || null;

      // 3. Fetch most recent log entry
      const logResult = await db.query(
        `SELECT event_type, credential_type, error_code, created_at
         FROM member_access_log
         WHERE member_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [identity.id]
      );

      const lastEvent = logResult.rows[0] || null;

      // Return raw fields — Velo (OB-07) maps these to UI states
      return res.status(200).json({
        platformMemberId,
        clientId,
        hardwarePlatform: identity.hardware_platform,
        sourcePlatform: identity.source_platform,
        status: state?.status || null,
        provisionedAt: state?.provisioned_at || null,
        updatedAt: state?.updated_at || null,
        lastEvent: lastEvent ? {
          eventType: lastEvent.event_type,
          credentialType: lastEvent.credential_type,
          errorCode: lastEvent.error_code,
          createdAt: lastEvent.created_at,
        } : null,
      });

    } catch (error) {
      console.error('[Member Sync API] Error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * TODO OB-08: Verify Wix JWT before Phase 5 launch.
   * Wix passes a signed JWT in the Authorization header for Velo backend calls.
   */
  async _verifyWixJWT(req) {
    // OB-08: Implement before Phase 5 launch — security gate
    return true;
  }
}

module.exports = new MemberSyncApi();
