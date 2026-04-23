/**
 * @file member-sync-api.js
 * @layer core/layer4
 * @role member-facing-api
 * @route GET /member/access-status
 * @auth Wix RS256 JWT (JWKS cached 1hr)
 * @reads member_identity, member_access_state, member_role_assignments, plan_mappings, locations
 * @exports router
 * @dr DR-021, OB-06, OB-08
 *
 * member-sync-api.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Serves raw DB access state to the Wix Velo frontend (Phase 5)
 * - Returns raw fields only — Velo (PIXEL) handles all UI state mapping (OB-07)
 * - JWT verification: RS256 via Wix public keys (OB-08 implemented)
 *
 * SAGE decision: Core Engine returns raw DB data. UI state logic lives in Velo, not here.
 *
 * Endpoint: GET /member/access-status?platformMemberId=X&clientId=Y
 * Auth:     Authorization: Bearer <wix_instance_jwt>
 */

'use strict';

const crypto = require('crypto');
const https  = require('https');
const db     = require('../db');
const { log } = require('./logger');

// Cache Wix public keys for 1 hour to avoid hammering their endpoint
let _keyCache      = null;
let _keyCacheExpiry = 0;
const KEY_CACHE_TTL_MS = 60 * 60 * 1000;

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
      // OB-08: Verify Wix JWT before trusting the request
      let jwtPayload = null;
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        try {
          jwtPayload = await this._verifyWixJWT(token);
        } catch (jwtErr) {
          log.warn('member.jwt_failed', {}, jwtErr);
          return res.status(401).json({ error: 'Unauthorized' });
        }
      } else {
        // Allow internal proxy requests from the admin server (sync-status iframe polling)
        if (req.headers['x-internal-proxy'] === '1') {
          // trusted internal call — no JWT required
        } else if (process.env.NODE_ENV === 'production') {
          return res.status(401).json({ error: 'Authorization header required' });
        }
      }

      const { platformMemberId, clientId } = req.query;

      if (!platformMemberId || !clientId) {
        return res.status(400).json({ error: 'platformMemberId and clientId are required' });
      }

      // If JWT is present, validate that the requesting member matches the query param
      // (prevents member A from reading member B's status)
      if (jwtPayload && jwtPayload.uid && jwtPayload.uid !== platformMemberId) {
        return res.status(403).json({ error: 'JWT uid does not match platformMemberId' });
      }

      // 1. Resolve member_identity
      const identityResult = await db.query(
        `SELECT id, hardware_user_id, hardware_platform, source_platform
         FROM member_identity
         WHERE platform_member_id = $1 AND client_id = $2
         LIMIT 1`,
        [platformMemberId, clientId]
      );

      if (!identityResult.rows.length) {
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

      // 4. Fetch active role assignments with plan/door names (OB-06 — Wix widget needs this)
      const rolesResult = await db.query(
        `SELECT mra.id, mra.hardware_role_id,
                pm.plan_name, pm.door_name, pm.hardware_group_id,
                l.name AS location_name
         FROM member_role_assignments mra
         JOIN plan_mappings pm ON pm.id = mra.mapping_id
         LEFT JOIN locations l ON pm.location_id = l.id
         WHERE mra.member_id = $1 AND mra.status = 'active'
         ORDER BY pm.plan_name`,
        [identity.id]
      );

      // Return raw fields — Velo (OB-07) maps these to UI states:
      //   status='active' + provisionedAt → "YOUR ACCESS IS ACTIVE"
      //   status='in_flight'              → "SYNCING"
      //   status='failed' || lastEvent.errorCode → "ERROR"
      //   status=null (not found)         → "PENDING" (webhook not yet processed)
      return res.status(200).json({
        platformMemberId,
        clientId,
        hardwarePlatform: identity.hardware_platform,
        sourcePlatform:   identity.source_platform,
        status:           state?.status || null,
        provisionedAt:    state?.provisioned_at || null,
        updatedAt:        state?.updated_at || null,
        lastEvent: lastEvent ? {
          eventType:      lastEvent.event_type,
          credentialType: lastEvent.credential_type,
          errorCode:      lastEvent.error_code,
          createdAt:      lastEvent.created_at,
        } : null,
        access: rolesResult.rows.map(r => ({
          planName:     r.plan_name,
          doorName:     r.door_name,
          locationName: r.location_name,
          groupId:      r.hardware_group_id,
        })),
      });

    } catch (error) {
      log.error('member.access_status_error', {}, error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * OB-08: Verify a Wix-issued JWT (RS256).
   *
   * Wix signs JWTs for Velo backend calls using RSA-SHA256.
   * Public keys are fetched from Wix's dynamic keys endpoint and cached locally.
   *
   * JWT payload includes:
   *   instanceId  — Wix site identifier (maps to clients.source_site_id via tenant-resolver)
   *   uid         — Wix member ID (= platformMemberId for Wix platform)
   *   exp         — Expiration timestamp
   *
   * @param {string} token  Raw JWT string (without 'Bearer ' prefix)
   * @returns {object} Decoded, verified JWT payload
   * @throws  If signature invalid, expired, or key unavailable
   */
  async _verifyWixJWT(token) {
    // 1. Split and decode JWT parts (no library needed — standard base64url)
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Malformed JWT — expected 3 parts');

    const [headerB64, payloadB64, sigB64] = parts;

    let header, payload;
    try {
      header  = JSON.parse(Buffer.from(headerB64,  'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    } catch {
      throw new Error('JWT base64 decode failed');
    }

    if (header.alg !== 'RS256') {
      throw new Error(`Unsupported JWT algorithm: ${header.alg} (expected RS256)`);
    }

    // 2. Fetch Wix public key matching this JWT's kid
    const jwk = await this._getWixPublicKey(header.kid);
    if (!jwk) throw new Error(`No Wix public key found for kid: ${header.kid}`);

    // 3. Reconstruct the JWK as a PEM for Node's crypto.createVerify
    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });

    // 4. Verify the RS256 signature
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature    = Buffer.from(sigB64, 'base64url');

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(signingInput);
    const valid = verifier.verify(publicKey, signature);

    if (!valid) throw new Error('JWT signature invalid');

    // 5. Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && now > payload.exp) {
      throw new Error(`JWT expired at ${new Date(payload.exp * 1000).toISOString()}`);
    }

    return payload;
  }

  /**
   * Fetch Wix RSA public keys from their JWKS endpoint.
   * Keys are cached for KEY_CACHE_TTL_MS (1 hour).
   *
   * @param {string} kid  Key ID from the JWT header
   * @returns {object|null}  JWK object or null if not found
   */
  async _getWixPublicKey(kid) {
    const now = Date.now();
    if (!_keyCache || now > _keyCacheExpiry) {
      _keyCache = await this._fetchWixJwks();
      _keyCacheExpiry = now + KEY_CACHE_TTL_MS;
    }

    if (!_keyCache || !Array.isArray(_keyCache.keys)) return null;
    return _keyCache.keys.find(k => k.kid === kid) || null;
  }

  /**
   * Fetch JWKS from Wix's dynamic keys endpoint.
   * Uses Node's built-in https — no external dependency.
   */
  _fetchWixJwks() {
    return new Promise((resolve, reject) => {
      const req = https.get('https://www.wix.com/_api/v2/dynamickeys', (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse Wix JWKS response'));
          }
        });
      });
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Wix JWKS fetch timed out'));
      });
    });
  }
}

module.exports = new MemberSyncApi();
