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
 * Sub-member ID format (DR-029): {wix_uuid}###as{NNN}
 * Draft→Submit workflow (DR-032): members are draft until batch submit.
 */

const express = require('express');
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
       ORDER BY mi.plan_mapping_id, mi.created_at`,
      [holder.id]
    );

    // 4. Auto-insert the holder as a draft sub-member on first open (zero sub-members).
    // Holder occupies a slot by default but can remove themselves (business owner case).
    // Only fires when a multi-member plan exists for this client.
    if (subMembersResult.rows.length === 0 && plansResult.rows.length > 0) {
      const plan = plansResult.rows[0];
      const holderPlatformId = holder.platform_member_id;
      const subPlatformMemberId = `${holderPlatformId}###as001`;
      // Pull holder name/email from their own member_identity row
      const holderInfoResult = await db.query(
        `SELECT first_name, last_name, email, phone FROM member_identity WHERE id = $1`,
        [holder.id]
      );
      const hi = holderInfoResult.rows[0] || {};
      const inserted = await db.query(
        `INSERT INTO member_identity
           (client_id, platform_member_id, source_platform, hardware_platform, source_tag,
            plan_holder_id, plan_mapping_id, first_name, last_name, email, phone, sub_member_status)
         VALUES ($1, $2, 'wix', $3, 'accesssync', $4, $5, $6, $7, $8, $9, 'draft')
         ON CONFLICT (client_id, source_platform, platform_member_id) DO NOTHING
         RETURNING id, platform_member_id, first_name, last_name, email, phone, sub_member_status, plan_mapping_id`,
        [clientId, subPlatformMemberId, holder.hardware_platform,
         holder.id, plan.id, hi.first_name || '', hi.last_name || '', hi.email || '', hi.phone || '']
      );
      if (inserted.rows.length > 0) {
        const r = inserted.rows[0];
        subMembersResult.rows.push({
          id: r.id,
          platform_member_id: r.platform_member_id,
          first_name: r.first_name,
          last_name: r.last_name,
          email: r.email,
          phone: r.phone,
          sub_member_status: r.sub_member_status,
          plan_mapping_id: r.plan_mapping_id,
          access_status: null,
          provisioned_at: null,
        });
      }
    }

    res.json({
      holder: {
        id: holder.id,
        platformMemberId: holder.platform_member_id,
        accessStatus: holder.access_status,
        provisionedAt: holder.provisioned_at,
      },
      plans: plansResult.rows.map(p => ({
        id: p.id,
        sourcePlanId: p.source_plan_id,
        planName: p.plan_name || 'Unnamed Plan',
        allowMultiple: p.allow_multiple,
        maxMembers: p.max_members,
        doorName: p.door_name,
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

    // Generate sub-member platform ID (DR-029): {holderPlatformId}###as{NNN}
    // NNN is scoped across all sub-members for this holder (unique ID, not per-plan counter)
    const totalCount = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM member_identity WHERE plan_holder_id = $1`,
      [holderId]
    );
    const nextNum = totalCount.rows[0].cnt + 1;
    const holderPlatformMemberId = await db.query(
      `SELECT platform_member_id FROM member_identity WHERE id = $1`, [holderId]
    );
    const subPlatformMemberId = `${holderPlatformMemberId.rows[0].platform_member_id}###as${String(nextNum).padStart(3, '0')}`;

    const result = await db.query(
      `INSERT INTO member_identity
       (client_id, platform_member_id, source_platform, hardware_platform, source_tag,
        plan_holder_id, plan_mapping_id, first_name, last_name, email, phone, sub_member_status)
       VALUES ($1, $2, 'wix', $3, 'accesssync', $4, $5, $6, $7, $8, $9, 'draft')
       RETURNING id, platform_member_id, first_name, last_name, email, phone, sub_member_status, plan_mapping_id, created_at`,
      [clientId, subPlatformMemberId, holderCheck.rows[0].hardware_platform,
       holderId, planMappingId, firstName.trim(), lastName.trim(), email.trim().toLowerCase(), phone.trim()]
    );

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
              mi.hardware_user_id, mi.hardware_platform, mi.client_id,
              mas.status AS access_status
       FROM member_identity mi
       LEFT JOIN member_access_state mas ON mas.member_id = mi.id
       WHERE mi.id = $1 AND mi.plan_holder_id IS NOT NULL`,
      [subId]
    );

    if (!memberResult.rows.length) {
      return res.status(404).json({ error: 'Sub-member not found' });
    }

    const member = memberResult.rows[0];

    if (member.sub_member_status === 'draft') {
      // Draft: just delete — no hardware to clean up
      await db.query('DELETE FROM member_identity WHERE id = $1', [subId]);
      log.info('admin.sub_member_deleted', { subId });
      return res.json({ ok: true, message: 'Draft member removed' });
    }

    // Submitted/active: enqueue a revoke job to clean up hardware access,
    // then delete the identity record. The revoke job will handle Kisi removal.
    if (member.access_status === 'active' && member.hardware_user_id) {
      const syntheticEvent = {
        eventType: 'plan.cancelled',
        platformMemberId: member.platform_member_id,
        sourcePlatform: 'wix',
        synthetic: true,
        traceId: mintTraceId(),
      };
      const jobId = `revoke-multi-member-${subId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: member.client_id, standardEvent: syntheticEvent }, { jobId });
      log.info('admin.sub_member_revoke_queued', { platformMemberId: member.platform_member_id, jobId });
    }

    // Clean up DB records (CASCADE from member_identity handles access state + role assignments)
    await db.query('DELETE FROM member_identity WHERE id = $1', [subId]);

    log.info('admin.sub_member_removed', { status: member.sub_member_status, subId });
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

module.exports = router;
