/**
 * admin/routes/multi-member.js
 * Multi-Member API — Additional member management for plan holders
 *
 * Endpoints:
 *   GET    /member/:memberId/widget-data       — Widget data for multi-member editor
 *   POST   /api/multi-member/members            — Add draft sub-member
 *   PUT    /api/multi-member/members/:subId      — Edit draft sub-member
 *   DELETE /api/multi-member/members/:subId      — Remove sub-member (OB-150 load-bearing)
 *   POST   /api/multi-member/submit              — Submit all drafts for provisioning
 *   POST   /api/multi-member/holder-claim-slot   — Holder claims own seat
 *   POST   /api/multi-member/holder-release-slot — Holder releases own seat
 *
 * Sub-member ID format (DR-029): {wix_uuid}###as{6-char-random}
 * Draft→Submit workflow (DR-032): members are pending until batch submit.
 *
 * Schema: member_master (PII) + member_access (role/status/hardware).
 * Retired: member_identity, member_access_state, member_role_assignments.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../../db');
const { eventQueue } = require('../../core/webhook-processor');
const { log } = require('../../core/logger');
const { mintTraceId } = require('../../core/trace-context');

/**
 * Write the origin record for a synthetic grant/revoke job fired from the Member Hub.
 * Writes two rows, both fire-and-forget:
 *   1. trace_context  — seeds entry_point='member-hub'
 *   2. activity_event — human-readable origin row in the timeline
 */
function recordSyntheticOrigin(traceId, { clientId, actorType, actorId, action, diff = {} }) {
  setImmediate(() => {
    db.query(
      `INSERT INTO trace_context (trace_id, client_id, actor_type, actor_id, entry_point)
       VALUES ($1, $2, $3, $4, 'member-hub')
       ON CONFLICT (trace_id) DO NOTHING`,
      [traceId, clientId || null, actorType || null, actorId || null]
    ).catch(() => {});

    db.query(
      `INSERT INTO activity_event (client_id, action, actor_type, actor_id, trace_id, diff)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        clientId || null,
        action,
        actorType || null,
        actorId   || null,
        traceId,
        Object.keys(diff).length ? JSON.stringify(diff) : null,
      ]
    ).catch(() => {});
  });
}

// ── GET /member/:memberId/widget-data ──────────────────────────────
// Returns everything the multi-member editor needs:
//   - Plan holder info (name, plan)
//   - Plan config (allow_multiple, max_members)
//   - Current sub-members (pending + active)
router.get('/member/:memberId/widget-data', async (req, res) => {
  const { memberId } = req.params;
  const clientId = req.query.clientId;

  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  // OB-159: Member Hub polls this endpoint every 4s — force fresh every time.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    // 1. Find the holder's member_master + member_access row (sub_master_id IS NULL = holder).
    // The Member Hub iframe sends the platform's member ID (e.g. Wix Member ID) in the URL path —
    // NOT the AccessSync internal UUID. Match against platform_member_id + source_platform + client_id
    // to use the schema's UNIQUE composite (client_id, source_platform, platform_member_id).
    const holderResult = await db.query(
      `SELECT mm.id AS member_master_id, ma.id AS access_id,
              mm.platform_member_id, mm.first_name, mm.last_name, mm.email, mm.phone,
              ma.status AS access_status, ma.provisioned_at
       FROM member_master mm
       JOIN member_access ma ON ma.member_master_id = mm.id
       WHERE mm.platform_member_id = $1 AND mm.source_platform = 'wix'
         AND ma.client_id = $2 AND ma.sub_master_id IS NULL`,
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

    // 3. Get existing sub-members for this holder (sub_master_id = holder's member_master_id).
    // S-11/DR-046: per-plan state lives on member_access_sources. Each sub-member's
    // (mapping_id, source-row status) tuple comes from the sources JOIN. A sub-member with
    // multiple plans (rare) yields one row per plan-source. If they have NO source row yet
    // (legacy data before S-11, or unprovisioned), the LEFT JOIN preserves them with NULL.
    const subMembersResult = await db.query(
      `SELECT mm.id AS member_master_id, ma.id AS access_id,
              mm.first_name, mm.last_name, mm.email, mm.phone,
              ma.platform_member_id, ma.status AS access_status,
              ma.provisioned_at,
              mas.mapping_id  AS plan_mapping_id,
              mas.status      AS source_status
       FROM member_access ma
       JOIN member_master mm        ON mm.id = ma.member_master_id
       LEFT JOIN member_access_sources mas
                                    ON mas.access_id = ma.id
                                   AND mas.status NOT IN ('cancelled','revoked')
       WHERE ma.sub_master_id = $1
         AND ma.status NOT IN ('deleted')
       ORDER BY mas.mapping_id, ma.created_at`,
      [holder.member_master_id]
    );

    // 4. Holder slot check — does the holder have an active source row per plan?
    // S-11/DR-046: holder "having a slot on plan X" means they have an active source row
    // with mapping_id=X under their (non-sub-member) access row.
    const holderSlotResult = await db.query(
      `SELECT mas.mapping_id
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE ma.member_master_id = $1
         AND ma.sub_master_id IS NULL
         AND mas.status = 'active'`,
      [holder.member_master_id]
    );
    const holderMappingIds = new Set(holderSlotResult.rows.map(r => r.mapping_id));

    res.json({
      holder: {
        id:               holder.member_master_id,
        platformMemberId: holder.platform_member_id,
        accessStatus:     holder.access_status,
        provisionedAt:    holder.provisioned_at,
        firstName:        holder.first_name  || null,
        lastName:         holder.last_name   || null,
        email:            holder.email       || null,
        phone:            holder.phone       || null,
      },
      plans: plansResult.rows.map(p => ({
        id:            p.id,
        sourcePlanId:  p.source_plan_id,
        planName:      p.plan_name || 'Unnamed Plan',
        allowMultiple: p.allow_multiple,
        maxMembers:    p.max_members,
        doorName:      p.door_name,
        holderHasSlot: holderMappingIds.has(p.id),
      })),
      subMembers: subMembersResult.rows.map(m => ({
        id:               m.access_id,
        memberMasterId:   m.member_master_id,
        platformMemberId: m.platform_member_id,
        firstName:        m.first_name,
        lastName:         m.last_name,
        email:            m.email,
        phone:            m.phone,
        // status: prefer source-row status (per-plan state). Fall back to access status when
        // the sub-member has no source row yet (e.g. mid-add, before provisioning).
        status:           m.source_status || m.access_status,
        planMappingId:    m.plan_mapping_id,
        provisionedAt:    m.provisioned_at,
      })),
    });
  } catch (err) {
    log.error('admin.multi_member_widget_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/members ─────────────────────────────────
// Add a new sub-member as draft (status='pending'). Not provisioned until submit.
// Body: { holderId, clientId, firstName, lastName, email, phone, planMappingId }
//
// INSERT splits into two rows:
//   1. member_master — PII anchor (person record)
//   2. member_access — role/status record with sub_master_id = holder's member_master_id
router.post('/api/multi-member/members', async (req, res) => {
  const { holderId, clientId, firstName, lastName, email, phone, planMappingId } = req.body;

  if (!holderId || !clientId || !firstName || !lastName || !email || !phone || !planMappingId) {
    return res.status(400).json({ error: 'All fields required: holderId, clientId, firstName, lastName, email, phone, planMappingId' });
  }

  try {
    // Validate holder exists (sub_master_id IS NULL = holder row)
    const holderCheck = await db.query(
      `SELECT ma.id AS access_id, ma.hardware_platform,
              mm.platform_member_id, mm.source_platform
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       WHERE mm.id = $1 AND ma.client_id = $2 AND ma.sub_master_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderCheck.rows.length) {
      return res.status(404).json({ error: 'Plan holder not found' });
    }

    // Validate plan mapping exists, belongs to this client, and allows multiple (DR-040).
    // Also fetch source_plan_id and hardware_group_id so we can write the source row.
    const planCheck = await db.query(
      `SELECT id, max_members, source_plan_id, hardware_group_id FROM plan_mappings
       WHERE id = $1 AND client_id = $2 AND allow_multiple = true AND status = 'active'`,
      [planMappingId, clientId]
    );
    if (!planCheck.rows.length) {
      return res.status(404).json({ error: 'Plan not found or does not allow additional members' });
    }

    // Check limit per plan — count source rows that occupy a slot.
    // S-11/DR-046: drafts/active/pending_hardware/pending_start all consume a slot.
    const maxMembers = planCheck.rows[0].max_members || 1;
    const currentCount = await db.query(
      `SELECT COUNT(DISTINCT mas.access_id)::int AS cnt
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE ma.sub_master_id = $1
         AND mas.mapping_id  = $2
         AND mas.status IN ('draft','active','pending_hardware','pending_start','in_flight')`,
      [holderId, planMappingId]
    );
    if (currentCount.rows[0].cnt >= maxMembers) {
      return res.status(409).json({ error: `Maximum ${maxMembers} additional members allowed for this plan` });
    }

    const holderRow = holderCheck.rows[0];
    const holderId_str = holderRow.platform_member_id;
    const planRow = planCheck.rows[0];

    // Generate sub-member platform ID (DR-029): {holderPlatformId}###as{6-char-hex}
    // Retry on 23505 collision; UNIQUE on (client_id, source_platform, platform_member_id) is backstop.
    //
    // S-11 row layout for a draft sub-member:
    //   member_master            — PII anchor
    //   member_access            — sub_master_id=holderId, status='pending_identity' until submitted
    //   member_access_sources    — mapping_id=planMappingId, status='draft', no role_assignment_id yet
    let masterResult, accessResult;
    let subPlatformMemberId;
    for (let attempt = 0; attempt < 5; attempt++) {
      const suffix = crypto.randomBytes(4).toString('hex').slice(0, 6);
      subPlatformMemberId = `${holderId_str}###as${suffix}`;
      try {
        // Row 1: PII anchor
        masterResult = await db.query(
          `INSERT INTO member_master
             (client_id, source_platform, platform_member_id, first_name, last_name,
              email, phone, source_tag)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'accesssync')
           RETURNING id, platform_member_id, first_name, last_name, email, phone`,
          [clientId, holderRow.source_platform, subPlatformMemberId,
           firstName.trim(), lastName.trim(), email.trim().toLowerCase(), phone.trim()]
        );
        // Row 2: access/role record (S-11: no plan_mapping_id column; status='pending_identity'
        // since no source row is active yet — submit flow flips this when grant lands)
        accessResult = await db.query(
          `INSERT INTO member_access
             (member_master_id, client_id, source_platform, platform_member_id,
              hardware_platform, sub_master_id, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending_identity')
           RETURNING id, status`,
          [masterResult.rows[0].id, clientId, holderRow.source_platform,
           subPlatformMemberId, holderRow.hardware_platform, holderId]
        );
        // Row 3: source row in 'draft' status — per-plan state per DR-046
        await db.query(
          `INSERT INTO member_access_sources
             (client_id, access_id, source_type, source_plan_id, hardware_group_id,
              mapping_id, status)
           VALUES ($1, $2, 'plan', $3, $4, $5, 'draft')`,
          [clientId, accessResult.rows[0].id,
           planRow.source_plan_id || null, planRow.hardware_group_id || null,
           planMappingId]
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
        id:               accessResult.rows[0].id,
        memberMasterId:   masterResult.rows[0].id,
        platformMemberId: masterResult.rows[0].platform_member_id,
        firstName:        masterResult.rows[0].first_name,
        lastName:         masterResult.rows[0].last_name,
        email:            masterResult.rows[0].email,
        phone:            masterResult.rows[0].phone,
        status:           accessResult.rows[0].status,
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
// Edit a pending sub-member. Only pending/draft-status members can be edited.
// Body: { firstName, lastName, email, phone }
// subId = member_access.id (the access row id for the sub-member)
router.put('/api/multi-member/members/:subId', async (req, res) => {
  const { subId } = req.params;
  const { firstName, lastName, email, phone } = req.body;

  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: 'All fields required: firstName, lastName, email, phone' });
  }

  try {
    // Verify the sub-member is in a draft state (editable). S-11/DR-046: draft state lives
    // on the source row, not the access row. Editable means the sub-member has at least one
    // source row in 'draft' status and no source row has reached 'active'/'pending_hardware'.
    const accessCheck = await db.query(
      `SELECT ma.member_master_id
       FROM member_access ma
       WHERE ma.id = $1 AND ma.sub_master_id IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM member_access_sources mas
           WHERE mas.access_id = ma.id AND mas.status = 'draft'
         )
         AND NOT EXISTS (
           SELECT 1 FROM member_access_sources mas
           WHERE mas.access_id = ma.id
             AND mas.status NOT IN ('draft','cancelled','revoked')
         )`,
      [subId]
    );

    if (!accessCheck.rows.length) {
      return res.status(404).json({ error: 'Draft sub-member not found (only draft members can be edited)' });
    }

    const masterResult = await db.query(
      `UPDATE member_master
       SET first_name = $1, last_name = $2, email = $3, phone = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING id, first_name, last_name, email, phone`,
      [firstName.trim(), lastName.trim(), email.trim().toLowerCase(), phone.trim(),
       accessCheck.rows[0].member_master_id]
    );

    log.info('admin.sub_member_updated', { subId });
    res.json({ ok: true, subMember: masterResult.rows[0] });
  } catch (err) {
    log.error('admin.multi_member_update_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── DELETE /api/multi-member/members/:subId ─────────────────────────
// Remove a sub-member.
//   pending: hard delete member_access + member_master
//   active with hardware: set status='removing', queue synthetic plan.cancelled revoke
//   active without hardware: hard delete
//
// OB-150 LOAD-BEARING: pm.source_plan_id must be fetched via JOIN so
// syntheticEvent.planId is populated. Without it, processRevoke skips the
// targeted source-row DELETE and remainingCount stays > 0, suppressing
// removeRole and leaving the Kisi role assignment orphaned.
//
// subId = member_access.id
router.delete('/api/multi-member/members/:subId', async (req, res) => {
  const { subId } = req.params;

  try {
    // S-11/DR-046: plan_mapping_id and source_plan_id come from member_access_sources, not access.
    // A sub-member should have exactly one source row at this point in the lifecycle (draft,
    // pending_hardware, or active). Pick the most recent non-cancelled source for context.
    const memberResult = await db.query(
      `SELECT ma.id, ma.status AS access_status, ma.hardware_user_id, ma.client_id,
              ma.member_master_id, ma.sub_master_id,
              mm.platform_member_id,
              mas.mapping_id        AS plan_mapping_id,
              mas.status            AS source_status,
              mas.source_plan_id    AS source_plan_id
       FROM member_access ma
       JOIN member_master mm ON mm.id = ma.member_master_id
       LEFT JOIN LATERAL (
         SELECT mapping_id, status, source_plan_id
         FROM   member_access_sources
         WHERE  access_id = ma.id
           AND  status NOT IN ('cancelled','revoked')
         ORDER  BY created_at DESC
         LIMIT  1
       ) mas ON TRUE
       WHERE ma.id = $1 AND ma.sub_master_id IS NOT NULL`,
      [subId]
    );

    if (!memberResult.rows.length) {
      return res.status(404).json({ error: 'Sub-member not found' });
    }

    const member = memberResult.rows[0];

    // DR-044: terminal state — already soft-deleted. Return 410 Gone.
    if (member.access_status === 'deleted') {
      return res.status(410).json({ error: 'Sub-member already removed' });
    }

    // S-11: a draft sub-member has source_status='draft' and no hardware call has fired.
    // Hard delete is safe — no Kisi role assignment to clean up.
    if (member.source_status === 'draft') {
      // Hard delete source rows + access + member_master
      await db.query('DELETE FROM member_access_sources WHERE access_id = $1', [subId]);
      await db.query('DELETE FROM member_access WHERE id = $1', [subId]);
      await db.query(
        `DELETE FROM member_master WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM member_access WHERE member_master_id = $1)`,
        [member.member_master_id]
      );
      log.info('admin.sub_member_deleted', { subId, sourceStatus: 'draft' });
      return res.json({ ok: true, message: 'Draft member removed' });
    }

    // Submitted/active path
    if (member.hardware_user_id) {
      // Has hardware — mark removing and enqueue revoke job
      await db.query(
        `UPDATE member_access SET status = 'removing', updated_at = NOW() WHERE id = $1`,
        [subId]
      );
      // OB-150 fix: planId populated from pm.source_plan_id JOIN above.
      // Without planId, processRevoke skips the targeted source-row DELETE,
      // remainingCount stays > 0, removeRole is suppressed, Kisi role stays orphaned.
      const syntheticEvent = {
        eventType:        'plan.cancelled',
        platformMemberId: member.platform_member_id,
        sourcePlatform:   'wix',
        planId:           member.source_plan_id || null,
        synthetic:        true,
        traceId:          mintTraceId(),
      };
      recordSyntheticOrigin(syntheticEvent.traceId, {
        clientId:  member.client_id,
        actorType: 'member-hub',
        actorId:   subId,
        action:    'sub_member.revoke_queued',
        diff: { subMemberId: subId, platformMemberId: member.platform_member_id, planId: member.source_plan_id || null },
      });
      const jobId = `revoke-multi-member-${subId}-${Date.now()}`;
      await eventQueue.add('revoke', { tenantId: member.client_id, standardEvent: syntheticEvent }, { jobId });
      log.info('admin.sub_member_revoke_queued', { platformMemberId: member.platform_member_id, jobId, subId });
    } else {
      // Never provisioned to hardware — safe to delete immediately
      await db.query('DELETE FROM member_access WHERE id = $1', [subId]);
      await db.query(
        `DELETE FROM member_master WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM member_access WHERE member_master_id = $1)`,
        [member.member_master_id]
      );
    }

    log.info('admin.sub_member_removed', { status: member.status, subId, hadHardwareUser: !!member.hardware_user_id });
    res.json({ ok: true, message: 'Member removed and access revoked' });
  } catch (err) {
    log.error('admin.multi_member_delete_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/submit ──────────────────────────────────
// Submit all pending sub-members for provisioning (DR-032).
// Moves status from 'pending' → 'pending_hardware', enqueues synthetic grants.
// Body: { holderId, clientId }
// holderId = member_master.id of the holder
router.post('/api/multi-member/submit', async (req, res) => {
  const { holderId, clientId } = req.body;

  if (!holderId || !clientId) {
    return res.status(400).json({ error: 'holderId and clientId are required' });
  }

  try {
    // S-11/DR-046: per-plan draft state lives on member_access_sources (status='draft').
    // Fetch all draft sub-members for this holder by joining sources.
    const drafts = await db.query(
      `SELECT ma.id AS access_id, ma.platform_member_id,
              mm.first_name, mm.last_name, mm.email, mm.phone,
              mas.id            AS source_id,
              mas.mapping_id    AS plan_mapping_id,
              mas.source_plan_id
       FROM member_access ma
       JOIN member_master mm           ON mm.id = ma.member_master_id
       JOIN member_access_sources mas  ON mas.access_id = ma.id
       WHERE ma.sub_master_id = $1 AND ma.client_id = $2
         AND mas.status = 'draft'
       ORDER BY ma.created_at`,
      [holderId, clientId]
    );

    if (!drafts.rows.length) {
      return res.status(400).json({ error: 'No draft members to submit' });
    }

    // S-11: flip draft source rows to 'pending_hardware' (member_access status stays
    // 'pending_identity' until grant lands and rolls up to 'active').
    await db.query(
      `UPDATE member_access_sources
       SET status = 'pending_hardware', updated_at = NOW()
       WHERE client_id = $1
         AND status = 'draft'
         AND access_id IN (
           SELECT id FROM member_access
           WHERE sub_master_id = $2 AND client_id = $1
         )`,
      [clientId, holderId]
    );

    // DR-031: Enqueue synthetic grant events via BullMQ — one per sub-member.
    // DR-040: Each sub-member's source row carries the source_plan_id we need.
    for (const draft of drafts.rows) {
      if (!draft.plan_mapping_id) {
        log.warn('admin.sub_member_no_plan_mapping', { draftId: draft.access_id });
        continue;
      }
      const syntheticEvent = {
        eventType:        'plan.purchased',
        platformMemberId: draft.platform_member_id,
        sourcePlatform:   'wix',
        planId:           draft.source_plan_id,
        email:            draft.email,
        name:             `${draft.first_name} ${draft.last_name}`,
        synthetic:        true,
        traceId:          mintTraceId(),
      };
      recordSyntheticOrigin(syntheticEvent.traceId, {
        clientId,
        actorType: req.admin?.actorType || req.operator?.actorType || 'operator',
        actorId:   req.admin?.email     || req.operator?.clientId  || holderId,
        action:    'sub_member.grant_queued',
        diff: { subMemberId: draft.access_id, platformMemberId: draft.platform_member_id, planId: draft.source_plan_id, jobId: `grant-multi-member-${draft.access_id}` },
      });
      const jobId = `grant-multi-member-${draft.access_id}-${Date.now()}`;
      await eventQueue.add('grant', { tenantId: clientId, standardEvent: syntheticEvent }, { jobId });
      log.info('admin.sub_member_grant_queued', { platformMemberId: draft.platform_member_id, jobId });
    }

    log.info('admin.sub_members_submitted', { count: drafts.rows.length, holderId });
    res.json({
      ok: true,
      submitted: drafts.rows.length,
      members: drafts.rows.map(d => ({
        id:               d.access_id,
        platformMemberId: d.platform_member_id,
        firstName:        d.first_name,
        lastName:         d.last_name,
        email:            d.email,
      })),
    });
  } catch (err) {
    log.error('admin.multi_member_submit_error', {}, err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /api/multi-member/holder-claim-slot ────────────────────────
// The buyer claims a slot for themselves on this plan.
// Enqueues a synthetic plan.purchased grant for the holder's own platform_member_id.
// Body: { holderId, clientId, planMappingId }
// holderId = member_master.id
router.post('/api/multi-member/holder-claim-slot', async (req, res) => {
  const { holderId, clientId, planMappingId } = req.body;
  if (!holderId || !clientId || !planMappingId) {
    return res.status(400).json({ error: 'holderId, clientId, and planMappingId are required' });
  }

  try {
    // Validate holder (sub_master_id IS NULL = holder row)
    const holderResult = await db.query(
      `SELECT mm.id AS member_master_id, mm.platform_member_id,
              mm.first_name, mm.last_name, mm.email
       FROM member_master mm
       JOIN member_access ma ON ma.member_master_id = mm.id
       WHERE mm.id = $1 AND ma.client_id = $2 AND ma.sub_master_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderResult.rows.length) return res.status(404).json({ error: 'Plan holder not found' });

    const planResult = await db.query(
      `SELECT id, source_plan_id, max_members FROM plan_mappings
       WHERE id = $1 AND client_id = $2 AND allow_multiple = true AND status = 'active'`,
      [planMappingId, clientId]
    );
    if (!planResult.rows.length) return res.status(404).json({ error: 'Plan not found or does not allow additional members' });

    // S-11/DR-046: slot occupancy = source rows in active/pending state for this mapping.
    // Holder slot: count holder's own source rows on this mapping.
    const holderHasSlot = await db.query(
      `SELECT COUNT(*)::int AS cnt
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE ma.member_master_id = $1
         AND ma.sub_master_id IS NULL
         AND mas.mapping_id = $2
         AND mas.status = 'active'`,
      [holderId, planMappingId]
    );
    if (holderHasSlot.rows[0].cnt > 0) {
      return res.status(409).json({ error: 'Already on this plan' });
    }

    // Sub-member slot count: distinct sub-members holding any active/pending state source.
    const subCount = await db.query(
      `SELECT COUNT(DISTINCT mas.access_id)::int AS cnt
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE ma.sub_master_id = $1
         AND mas.mapping_id  = $2
         AND mas.status IN ('active','pending_hardware','pending_start','in_flight','draft')`,
      [holderId, planMappingId]
    );
    const totalOccupied = holderHasSlot.rows[0].cnt + subCount.rows[0].cnt;
    if (totalOccupied >= planResult.rows[0].max_members) {
      return res.status(409).json({ error: `Plan is full — ${planResult.rows[0].max_members} member limit reached` });
    }

    const holder = holderResult.rows[0];
    const syntheticEvent = {
      eventType:        'plan.purchased',
      platformMemberId: holder.platform_member_id,
      sourcePlatform:   'wix',
      planId:           planResult.rows[0].source_plan_id,
      email:            holder.email,
      name:             `${holder.first_name || ''} ${holder.last_name || ''}`.trim(),
      synthetic:        true,
      traceId:          mintTraceId(),
    };
    recordSyntheticOrigin(syntheticEvent.traceId, {
      clientId,
      actorType: 'member-hub',
      actorId:   holderId,
      action:    'holder.claim_slot_queued',
      diff: { holderId, planMappingId, planId: planResult.rows[0].source_plan_id },
    });
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
// Enqueues a synthetic plan.cancelled revoke targeted at this mapping only.
// Body: { holderId, clientId, planMappingId }
// holderId = member_master.id
router.post('/api/multi-member/holder-release-slot', async (req, res) => {
  const { holderId, clientId, planMappingId } = req.body;
  if (!holderId || !clientId || !planMappingId) {
    return res.status(400).json({ error: 'holderId, clientId, and planMappingId are required' });
  }

  try {
    // Validate holder
    const holderResult = await db.query(
      `SELECT mm.id AS member_master_id, mm.platform_member_id
       FROM member_master mm
       JOIN member_access ma ON ma.member_master_id = mm.id
       WHERE mm.id = $1 AND ma.client_id = $2 AND ma.sub_master_id IS NULL`,
      [holderId, clientId]
    );
    if (!holderResult.rows.length) return res.status(404).json({ error: 'Plan holder not found' });

    // Confirm holder has an active role assignment for this plan via member_access_sources
    const assignmentResult = await db.query(
      `SELECT mas.role_assignment_id
       FROM member_access_sources mas
       JOIN member_access ma ON ma.id = mas.access_id
       WHERE ma.member_master_id = $1 AND mas.mapping_id = $2`,
      [holderId, planMappingId]
    );
    if (!assignmentResult.rows.length) return res.status(409).json({ error: 'Not currently on this plan' });

    const holder = holderResult.rows[0];
    const syntheticEvent = {
      eventType:        'plan.cancelled',
      platformMemberId: holder.platform_member_id,
      sourcePlatform:   'wix',
      mappingId:        planMappingId,
      synthetic:        true,
      traceId:          mintTraceId(),
    };
    recordSyntheticOrigin(syntheticEvent.traceId, {
      clientId,
      actorType: 'member-hub',
      actorId:   holderId,
      action:    'holder.release_slot_queued',
      diff: { holderId, planMappingId },
    });
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
