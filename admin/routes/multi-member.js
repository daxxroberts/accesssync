/**
 * admin/routes/multi-member.js
 * Multi-Member API — Additional member management for plan holders
 *
 * Endpoints:
 *   GET    /member/:memberId/widget-data       — Widget data for multi-member editor
 *   POST   /api/multi-member/members            — Add draft sub-member
 *   PUT    /api/multi-member/members/:subId      — Edit draft sub-member
 *   DELETE /api/multi-member/members/:subId      — Remove sub-member
 *   POST   /api/multi-member/submit              — Submit all drafts for provisioning
 *
 * Sub-member ID format (DR-029): {wix_uuid}###as{6-char-random}
 * Draft→Submit workflow (DR-032): members are draft until batch submit.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const { log } = require('../../core/logger');
const { mintTraceId } = require('../../core/trace-context');

// ── GET /member/:memberId/widget-data ──────────────────────────────
// Returns everything the multi-member editor needs:
//   - Plan holder info (name, plan)
//   - Plan config (allow_multiple, max_members)
//   - Current sub-members (draft + submitted + active)
router.get('/member/:memberId/widget-data', async (req, res) => {
  const { memberId } = req.params;
  const clientId = req.query.clientId;

  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  try {
    // 1. Find the plan holder's identity record
    const holderResult = await db.query(
      `SELECT mi.id, mi.platform_member_id, mi.client_id, mi.hardware_platform,
              mas.status AS access_status, mas.provisioned_at
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       WHERE mi.platform_member_id = $1 AND mi.client_id = $2
         AND mi.plan_holder_id IS NULL`,
      [memberId, clientId]
    );

    if (!holderResult.rows.length) {
      return res.status(404).json({ error: 'Member not found' });
    }

    const holder = holderResult.rows[0];

    // 2. Get plan mappings that allow multiple members
    const plansResult = await db.query(
      `SELECT pm.id, pm.source_plan_id, pm.plan_name, pm.allow_multiple, pm.max_members,
              pm.hardware_group_id, pm.door_name
       FROM plan_mappings pm
       WHERE pm.client_id = $1 AND pm.status = 'active' AND pm.allow_multiple = true
       ORDER BY pm.plan_name`,
      [clientId]
    );

    // 3. Get existing sub-members for this plan holder, grouped by plan (DR-040)
    const subMembersResult = await db.query(
      `SELECT mi.id, mi.platform_member_id, mi.first_name, mi.last_name,
              mi.email, mi.phone, mi.sub_member_status, mi.plan_mapping_id,
              mas.status AS access_status, mas.provisioned_at
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       WHERE mi.plan_holder_id = $1
         AND (mi.sub_member_status IS NULL OR mi.sub_member_status != 'deleted')
       ORDER BY mi.plan_mapping_id, mi.created_at`,
      [holder.id]
    );

    // 4. For each plan, check whether the holder currently has a role assignment.
    // The buyer is NOT auto-added to the plan — they must explicitly opt in via the
    // "Add me to this plan" CTA on the Member Hub. This supports the business-owner
    // case where the buyer assigns all seats to others.
    const holderRoleResult = await db.query(
      `SELECT mapping_id FROM member_role_assignments WHERE member_id = $1`,
      [holder.id]
    );
    const holderMappingIds = new Set(holderRoleResult.rows.map(r => r.mapping_id));

    // Holder name/contact for the "add me" UX prefill
    const holderInfoResult = await db.query(
      `SELECT first_name, last_name, email, phone FROM member_identity WHERE id = $1`,
      [holder.id]
    );
    const hi = holderInfoResult.rows[0] || {};

    res.json({
      holder: {
        id: holder.id,
        platformMemberId: holder.platform_member_id,
        accessStatus: holder.access_status,
        provisionedAt: holder.provisioned_at,
        firstName: hi.first_name || null,
        lastName:  hi.last_name  || null,
        email:     hi.email      || null,
        phone:     hi.phone      || null,
      },
      plans: plansResult.rows.map(p => ({
        id: p.id,
        sourcePlanId: p.source_plan_id,
        planName: p.plan_name || 'Unnamed Plan',
        allowMultiple: p.allow_multiple,
        maxMembers: p.max_members,
        doorName: p.door_name,
        holderHasSlot: holderMappingIds.has(p.id), // true → buyer occupies a seat on this plan
      })),
      subMembers: subMembersResult.rows.map(m => ({
        id: m.id,
        platformMemberId: m.platform_member_id,
        firstName: m.first_name,
        lastName: m.last_name,
        email: m.email,
        phone: m.phone,
        status: m.sub_member_status,
        planMappingId: m.plan_mapping_id,   // DR-040: which plan this sub-member belongs to
        accessStatus: m.access_status,
        provisionedAt: m.provisioned_at,
      })),
    });
  } catch (err) {
    log.error('admin.multi_member_widget_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/members ─────────────────────────────────
// Add a new sub-member as draft. Not provisioned until submit.
// Body: { holderId, clientId, firstName, lastName, email, phone }
router.post('/api/multi-member/members', async (req, res) => {
  const { holderId, clientId, firstName, lastName, email, phone, planMappingId } = req.body;

  if (!holderId || !clientId || !firstName || !lastName || !email || !phone || !planMappingId) {
    return res.status(400).json({ error: 'All fields required: holderId, clientId, firstName, lastName, email, phone, planMappingId' });
  }

  try {
    // Validate plan holder exists
    const holderCheck = await db.query(
      `SELECT id, hardware_platform FROM member_identity WHERE id = $1 AND client_id = $2 AND plan_holder_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderCheck.rows.length) {
      return res.status(404).json({ error: 'Plan holder not found' });
    }

    // Validate plan mapping exists, belongs to this client, and allows multiple (DR-040)
    const planCheck = await db.query(
      `SELECT id, max_members FROM plan_mappings
       WHERE id = $1 AND client_id = $2 AND allow_multiple = true AND status = 'active'`,
      [planMappingId, clientId]
    );
    if (!planCheck.rows.length) {
      return res.status(404).json({ error: 'Plan not found or does not allow additional members' });
    }

    // Check limit per plan — drafts don't consume a slot, only submitted/active do (DR-040)
    const maxMembers = planCheck.rows[0].max_members || 1;
    const currentCount = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM member_identity
       WHERE plan_holder_id = $1 AND plan_mapping_id = $2
         AND sub_member_status IN ('submitted', 'active')`,
      [holderId, planMappingId]
    );
    if (currentCount.rows[0].cnt >= maxMembers) {
      return res.status(409).json({ error: `Maximum ${maxMembers} additional members allowed for this plan` });
    }

    // Generate sub-member platform ID (DR-029): {holderPlatformId}###as{6-char-base36}
    // Random suffix avoids reuse-after-revoke collisions (no counter state).
    // Retry on the off chance of a 6-char collision; UNIQUE constraint is the backstop.
    const holderPlatformMemberId = await db.query(
      `SELECT platform_member_id FROM member_identity WHERE id = $1`, [holderId]
    );
    const holderId_str = holderPlatformMemberId.rows[0].platform_member_id;

    let result;
    let subPlatformMemberId;
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = crypto.randomBytes(4).toString('hex').slice(0, 6);
      subPlatformMemberId = `${holderId_str}###as${suffix}`;
      try {
        result = await db.query(
          `INSERT INTO member_identity
           (client_id, platform_member_id, source_platform, hardware_platform, source_tag,
            plan_holder_id, plan_mapping_id, first_name, last_name, email, phone, sub_member_status)
           VALUES ($1, $2, 'wix', $3, 'accesssync', $4, $5, $6, $7, $8, $9, 'draft')
           RETURNING id, platform_member_id, first_name, last_name, email, phone, sub_member_status, plan_mapping_id, created_at`,
          [clientId, subPlatformMemberId, holderCheck.rows[0].hardware_platform,
           holderId, planMappingId, firstName.trim(), lastName.trim(), email.trim().toLowerCase(), phone.trim()]
        );
        break;
      } catch (e) {
        if (e.code === '23505' && attempt < 4) continue;
        throw e;
      }
    }

    log.info('admin.sub_member_added', { subPlatformMemberId, holderId });
    res.status(201).json({
      ok: true,
      subMember: {
        id: result.rows[0].id,
        platformMemberId: result.rows[0].platform_member_id,
        firstName: result.rows[0].first_name,
        lastName: result.rows[0].last_name,
        email: result.rows[0].email,
        phone: result.rows[0].phone,
        status: result.rows[0].sub_member_status,
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A member with this identifier already exists' });
    }
    log.error('admin.multi_member_add_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /api/multi-member/members/:subId ────────────────────────────
// Edit a draft sub-member. Only draft members can be edited.
// Body: { firstName, lastName, email, phone }
router.put('/api/multi-member/members/:subId', async (req, res) => {
  const { subId } = req.params;
  const { firstName, lastName, email, phone } = req.body;

  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: 'All fields required: firstName, lastName, email, phone' });
  }

  try {
    const result = await db.query(
      `UPDATE member_identity
       SET first_name = $1, last_name = $2, email = $3, phone = $4, updated_at = NOW()
       WHERE id = $5 AND plan_holder_id IS NOT NULL AND sub_member_status = 'draft'
       RETURNING id, first_name, last_name, email, phone`,
      [firstName.trim(), lastName.trim(), email.trim().toLowerCase(), phone.trim(), subId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'Draft sub-member not found (only draft members can be edited)' });
    }

    log.info('admin.sub_member_updated', { subId });
    res.json({ ok: true, subMember: result.rows[0] });
  } catch (err) {
    log.error('admin.multi_member_update_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/multi-member/members/:subId ─────────────────────────
// Remove a sub-member. Draft members are deleted immediately.
// Submitted/active members are revoked in hardware first, then deleted.
router.delete('/api/multi-member/members/:subId', async (req, res) => {
  const { subId } = req.params;

  try {
    const memberResult = await db.query(
      `SELECT mi.id, mi.platform_member_id, mi.plan_holder_id, mi.sub_member_status,
              mi.hardware_user_id, mi.hardware_platform, mi.client_id, mi.plan_mapping_id,
              pm.source_plan_id,
              mas.status AS access_status
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       LEFT JOIN plan_mappings pm ON pm.id = mi.plan_mapping_id
       WHERE mi.id = $1 AND mi.plan_holder_id IS NOT NULL`,
      [subId]
    );

    if (!memberResult.rows.length) {
      return res.status(404).json({ error: 'Sub-member not found' });
    }

    const member = memberResult.rows[0];

    // DR-044: terminal state — already soft-deleted. Return 410 Gone.
    if (member.sub_member_status === 'deleted') {
      return res.status(410).json({ error: 'Sub-member already removed' });
    }

    if (member.sub_member_status === 'draft') {
      // Draft: just delete — no hardware to clean up
      await db.query('DELETE FROM member_identity WHERE id = $1', [subId]);
      log.info('admin.sub_member_deleted', { subId });
      return res.json({ ok: true, message: 'Draft member removed' });
    }

    // Submitted/active path — check whether a hardware user was ever created.
    // If hardware_user_id exists, enqueue a revoke BEFORE deleting identity so the
    // queue-worker can look up the row and call Kisi. Identity is kept alive with
    // sub_member_status='removing' until the revoke job completes, at which point
    // completeRevoke sets access_status='revoked'. On the next loadData the UI
    // sees no member (we delete it there) — or we clean up here via a brief wait.
    if (member.hardware_user_id) {
      // Mark as removing so the GET /members endpoint filters it out immediately
      await db.query(
        `UPDATE member_identity SET sub_member_status = 'removing', updated_at = NOW() WHERE id = $1`,
        [subId]
      );
      // OB-150 fix: include planId so DR-034 source row delete COALESCE check matches.
      // Without planId, the targeted DELETE in processRevoke skips the source row,
      // remainingCount stays > 0, and removeRole is incorrectly suppressed by the
      // multi-source safety guard — leaving the Kisi role assignment orphaned.
      const syntheticEvent = {
        eventType: 'plan.cancelled',
        platformMemberId: member.platform_member_id,
        sourcePlatform: 'wix',
        planId: member.source_plan_id || null,
        synthetic: true,
        traceId: mintTraceId(),
      };
      const jobId = `revoke-multi-member-${subId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: member.client_id, standardEvent: syntheticEvent }, { jobId });
      log.info('admin.sub_member_revoke_queued', { platformMemberId: member.platform_member_id, jobId, subId });
      // Row is kept alive — queue-worker reads it; completeRevoke sets status='revoked'.
      // Orphan cleanup: any row with sub_member_status='removing' that is also revoked
      // will be excluded from the GET /members query.
    } else {
      // Never provisioned to hardware — safe to delete immediately.
      await db.query('DELETE FROM member_identity WHERE id = $1', [subId]);
    }

    log.info('admin.sub_member_removed', { status: member.sub_member_status, subId, hadHardwareUser: !!member.hardware_user_id });
    res.json({ ok: true, message: 'Member removed and access revoked' });
  } catch (err) {
    log.error('admin.multi_member_delete_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/submit ──────────────────────────────────
// Submit all draft sub-members for provisioning (DR-032).
// Moves status from 'draft' → 'submitted', then triggers provisioning.
// Body: { holderId, clientId }
router.post('/api/multi-member/submit', async (req, res) => {
  const { holderId, clientId } = req.body;

  if (!holderId || !clientId) {
    return res.status(400).json({ error: 'holderId and clientId are required' });
  }

  try {
    // Get all draft sub-members for this holder, with each sub-member's own source_plan_id (DR-040)
    const drafts = await db.query(
      `SELECT mi.id, mi.platform_member_id, mi.first_name, mi.last_name,
              mi.email, mi.phone, mi.plan_mapping_id, pm.source_plan_id
       FROM member_identity mi
       LEFT JOIN plan_mappings pm ON pm.id = mi.plan_mapping_id
       WHERE mi.plan_holder_id = $1 AND mi.client_id = $2 AND mi.sub_member_status = 'draft'
       ORDER BY mi.created_at`,
      [holderId, clientId]
    );

    if (!drafts.rows.length) {
      return res.status(400).json({ error: 'No draft members to submit' });
    }

    // Move all drafts to 'submitted'
    await db.query(
      `UPDATE member_identity
       SET sub_member_status = 'submitted', updated_at = NOW()
       WHERE plan_holder_id = $1 AND client_id = $2 AND sub_member_status = 'draft'`,
      [holderId, clientId]
    );

    // Create member_access_state rows for each submitted member
    for (const draft of drafts.rows) {
      await db.query(
        `INSERT INTO member_access_state (member_id, client_id, plan_holder_id, status)
         VALUES ($1, $2, $3, 'pending_sync')
         ON CONFLICT (member_id) DO UPDATE SET status = 'pending_sync', updated_at = NOW()`,
        [draft.id, clientId, holderId]
      );
    }

    // DR-031: Enqueue synthetic grant events via BullMQ — one per sub-member.
    // DR-040: Each sub-member carries its own plan_mapping_id — use that to look up
    // source_plan_id so sub-members on different plans get provisioned against the
    // correct plan (not a single LIMIT 1 across all multi-member plans).
    for (const draft of drafts.rows) {
      if (!draft.plan_mapping_id) {
        log.warn('admin.sub_member_no_plan_mapping', { draftId: draft.id });
        continue;
      }
      const syntheticEvent = {
        eventType: 'plan.purchased',
        platformMemberId: draft.platform_member_id,
        sourcePlatform: 'wix',
        planId: draft.source_plan_id,
        email: draft.email,
        name: `${draft.first_name} ${draft.last_name}`,
        synthetic: true,
        traceId: mintTraceId(),
      };
      const jobId = `grant-multi-member-${draft.id}-${Date.now()}`;
      await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
      log.info('admin.sub_member_grant_queued', { platformMemberId: draft.platform_member_id, jobId });
    }

    log.info('admin.sub_members_submitted', { count: drafts.rows.length, holderId });
    res.json({
      ok: true,
      submitted: drafts.rows.length,
      members: drafts.rows.map(d => ({
        id: d.id,
        platformMemberId: d.platform_member_id,
        firstName: d.first_name,
        lastName: d.last_name,
        email: d.email,
      })),
    });
  } catch (err) {
    log.error('admin.multi_member_submit_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/holder-claim-slot ────────────────────────
// The buyer claims a slot for themselves on this plan.
// Enqueues a synthetic plan.purchased grant for the holder's own platform_member_id
// so the standard provisioning path runs and writes a member_role_assignments row.
// Body: { holderId, clientId, planMappingId }
router.post('/api/multi-member/holder-claim-slot', async (req, res) => {
  const { holderId, clientId, planMappingId } = req.body;
  if (!holderId || !clientId || !planMappingId) {
    return res.status(400).json({ error: 'holderId, clientId, and planMappingId are required' });
  }

  try {
    const holderResult = await db.query(
      `SELECT mi.id, mi.platform_member_id, mi.first_name, mi.last_name, mi.email
       FROM member_identity mi
       WHERE mi.id = $1 AND mi.client_id = $2 AND mi.plan_holder_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderResult.rows.length) return res.status(404).json({ error: 'Plan holder not found' });

    const planResult = await db.query(
      `SELECT id, source_plan_id, max_members FROM plan_mappings
       WHERE id = $1 AND client_id = $2 AND allow_multiple = true AND status = 'active'`,
      [planMappingId, clientId]
    );
    if (!planResult.rows.length) return res.status(404).json({ error: 'Plan not found or does not allow additional members' });

    // Slot count includes holder's own slot + every sub-member with status submitted/active
    const slotsTaken = await db.query(
      `SELECT
         (SELECT COUNT(*) FROM member_role_assignments mra
            JOIN member_identity mi ON mi.id = mra.member_id
            WHERE mra.mapping_id = $1 AND mi.plan_holder_id IS NULL AND mi.id = $2)::int AS holder_has_slot,
         (SELECT COUNT(*) FROM member_identity
            WHERE plan_holder_id = $2 AND plan_mapping_id = $1
              AND sub_member_status IN ('submitted', 'active'))::int AS sub_count`,
      [planMappingId, holderId]
    );
    const totalOccupied = slotsTaken.rows[0].holder_has_slot + slotsTaken.rows[0].sub_count;
    if (slotsTaken.rows[0].holder_has_slot > 0) {
      return res.status(409).json({ error: 'Already on this plan' });
    }
    if (totalOccupied >= planResult.rows[0].max_members) {
      return res.status(409).json({ error: `Plan is full — ${planResult.rows[0].max_members} member limit reached` });
    }

    const holder = holderResult.rows[0];
    const syntheticEvent = {
      eventType: 'plan.purchased',
      platformMemberId: holder.platform_member_id,
      sourcePlatform: 'wix',
      planId: planResult.rows[0].source_plan_id,
      email: holder.email,
      name: `${holder.first_name || ''} ${holder.last_name || ''}`.trim(),
      synthetic: true,
      traceId: mintTraceId(),
    };
    const jobId = `grant-holder-claim-${holderId}-${planMappingId}-${Date.now()}`;
    await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });

    log.info('admin.holder_claim_slot_queued', { holderId, planMappingId, jobId });
    res.json({ ok: true, message: 'Adding you to this plan — access will be active shortly', jobId });
  } catch (err) {
    log.error('admin.holder_claim_slot_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/holder-release-slot ──────────────────────
// The buyer releases their own slot on this plan.
// Enqueues a synthetic plan.cancelled revoke targeted at the specific role assignment
// for this mapping — leaves any other plans the holder is on untouched.
// Body: { holderId, clientId, planMappingId }
router.post('/api/multi-member/holder-release-slot', async (req, res) => {
  const { holderId, clientId, planMappingId } = req.body;
  if (!holderId || !clientId || !planMappingId) {
    return res.status(400).json({ error: 'holderId, clientId, and planMappingId are required' });
  }

  try {
    const holderResult = await db.query(
      `SELECT mi.id, mi.platform_member_id
       FROM member_identity mi
       WHERE mi.id = $1 AND mi.client_id = $2 AND mi.plan_holder_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderResult.rows.length) return res.status(404).json({ error: 'Plan holder not found' });

    const assignmentResult = await db.query(
      `SELECT role_assignment_id FROM member_role_assignments
       WHERE member_id = $1 AND mapping_id = $2`,
      [holderId, planMappingId]
    );
    if (!assignmentResult.rows.length) return res.status(409).json({ error: 'Not currently on this plan' });

    const holder = holderResult.rows[0];
    const syntheticEvent = {
      eventType: 'plan.cancelled',
      platformMemberId: holder.platform_member_id,
      sourcePlatform: 'wix',
      mappingId: planMappingId,             // hint to the revoke path: only this mapping
      synthetic: true,
      traceId: mintTraceId(),
    };
    const jobId = `revoke-holder-release-${holderId}-${planMappingId}-${Date.now()}`;
    await eventQueue.add('revoke', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });

    log.info('admin.holder_release_slot_queued', { holderId, planMappingId, jobId });
    res.json({ ok: true, message: 'Removing you from this plan — access will be revoked shortly', jobId });
  } catch (err) {
    log.error('admin.holder_release_slot_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
