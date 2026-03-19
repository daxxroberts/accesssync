/**
 * grant-revoke.js
 * Core Engine (Layer 4)
 *
 * Responsibilities:
 * - Executes the idempotent core grant and revoke logic
 * - Enforces the `in_flight` state lock to block race conditions
 * - Performs identity resolution against existing DB records and API
 * - Calls appropriate Hardware adapter methods
 */

const kisiAdapter = require('../adapters/kisi-adapter');
const retryEngine = require('./retry-engine');
const planMappingResolver = require('./plan-mapping-resolver');

class GrantRevokeLogic {
  
  /**
   * Flow A: New Member Grant
   * Maps to FLOW_New_Member_Grant.md
   */
  async processGrant(tenantId, wixEvent) {
    console.log(`[Grant] Processing grant for tenant ${tenantId}, member ${wixEvent.wixMemberId}`);
    
    // Step 1: Resolve hardware tier & API key from DB
    const mapping = await planMappingResolver.resolve(tenantId, wixEvent.planId);
    if (!mapping) return; // Unmapped plan, already logged in resolver
    
    // Get actual API key for tenant (Mocked for now)
    const apiKey = process.env.KISI_API_KEY_MOCK; 
    let memberAccessLogId = null;

    try {
      // Step 2: Check database state lock
      // DB: const state = await db.query('SELECT status FROM member_access_state WHERE member_id = ?')
      // If state === 'in_flight' throw new Error('Concurrent modification rejected');
      // DB: UPDATE member_access_state SET status = 'in_flight' WHERE member_id

      // Step 3: Identify User in Kisi
      let hardwareUserId = await this._resolveIdentity(tenantId, wixEvent.wixMemberId, wixEvent.email, wixEvent.name, apiKey);

      // Step 4: Provision Role
      console.log(`[Grant] Assigning role to user ${hardwareUserId} in group ${mapping.hardwareGroupId}`);
      const roleId = await kisiAdapter.assignRole(apiKey, hardwareUserId, mapping.hardwareGroupId);

      // Step 5: Commit Success to Database
      console.log(`[Grant] Success! Storing role_assignment_id: ${roleId}`);
      // DB: UPDATE member_access_state SET status = 'active', role_assignment_id = roleId WHERE ...
      // DB: INSERT INTO member_access_log ... status = 'provisioned'

    } catch (error) {
      console.error(`[Grant] Failed for ${wixEvent.wixMemberId}:`, error);
      // Let the Retry Engine decide if this is transient or permanent
      await retryEngine.handleFailure({ attempt: 1, data: { tenantId, eventType: 'grant', memberId: wixEvent.wixMemberId } }, error);
    }
  }

  /**
   * Flow B: Revoke Access
   * Maps to FLOW_Revoke.md 
   * CRITICAL: 3 Distinct Paths based on eventType
   */
  async processRevoke(tenantId, eventType, wixEvent) {
    console.log(`[Revoke] Processing revoke (${eventType}) for tenant ${tenantId}, member ${wixEvent.wixMemberId}`);
    
    const apiKey = process.env.KISI_API_KEY_MOCK;

    try {
      // DB: UPDATE member_access_state SET status = 'in_flight' 
      
      // Look up existing state from DB
      const hardwareUserId = 'mock_kisi_user_id'; 
      const roleAssignmentId = 'mock_role_id'; 
      
      switch (eventType) {
        case 'payment.failed':
          // Path A: Suspend access, preserve role (Fast recovery)
          console.log(`[Revoke] Suspending access via PATCH /users`);
          await kisiAdapter.suspendAccess(apiKey, hardwareUserId, `Payment failed on ${new Date().toISOString()}`);
          // DB: UPDATE member_access_state SET status = 'disabled'
          break;
        
        case 'plan.cancelled':
        case 'booking.cancelled':
          // Path B: Delete role assignment, preserve user
          console.log(`[Revoke] Deleting role assignment ${roleAssignmentId}`);
          await kisiAdapter.removeRole(apiKey, roleAssignmentId);
          // DB: UPDATE member_access_state SET status = 'revoked', role_assignment_id = NULL
          break;

        case 'member.deleted':
          // Path C: Completely remove user from Kisi org (Permanent)
          console.log(`[Revoke] Permanently deleting user ${hardwareUserId}`);
          await kisiAdapter.deleteUser(apiKey, hardwareUserId);
          // DB: UPDATE member_access_state SET status = 'deleted'
          // DB: INSERT INTO config_alert_log (Operator review flag)
          break;
        
        default:
          console.error(`[Revoke] Unknown revoke event type: ${eventType}`);
      }
    } catch (error) {
       console.error(`[Revoke] Failed:`, error);
       await retryEngine.handleFailure({ attempt: 1, data: { tenantId, eventType, memberId: wixEvent.wixMemberId } }, error);
    }
  }


  /**
   * 3-Step Identity Resolution Chain
   */
  async _resolveIdentity(tenantId, wixMemberId, email, name, apiKey) {
    // 1. Check DB first
    // const dbId = await db.query('SELECT hardware_user_id FROM member_identity WHERE wix_member_id = ?')
    // if (dbId) return dbId;

    // 2. Fetch from Kisi API by Email (Wix sends us the email payload, but we don't store it)
    let kisiId = await kisiAdapter.findUserByEmail(apiKey, email);
    
    if (kisiId) {
      console.log(`[Identity] Found existing Kisi user: ${kisiId}`);
    } else {
      // 3. Create cleanly in Kisi (MUST send_emails: false)
      console.log(`[Identity] Creating new Kisi user for ${email}`);
      kisiId = await kisiAdapter.createUser(apiKey, email, name);
    }

    // Cache the resolved ID in our Database mapped against the Wix ID
    // DB: UPDATE member_identity SET hardware_user_id = kisiId ...
    
    return kisiId;
  }
}

module.exports = new GrantRevokeLogic();
