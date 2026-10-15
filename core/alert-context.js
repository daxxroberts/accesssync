/**
 * @file alert-context.js
 * @layer core
 * @role shared-sql
 * @exports ALERT_CONTEXT_COLUMNS, ALERT_CONTEXT_JOINS
 *
 * Who and where a config_alert_log row is about, so its sentence (operator-email-templates.js#describeConfigAlert)
 * names the real member and the real location instead of "a member at one of your locations".
 * Used by the gym's alerts list (admin/routes/operator.js) and the nightly digest (core/reconciliation.js), so
 * the screen and the email always name the same place.
 *
 * Rules (certainty over guessing — Daxx, 2026-10-15):
 *   member  — sweep alerts carry "member:<platform member id>", finalize guards "member_id=<member_access id>";
 *             both looked up inside the alert's own client only.
 *   location — for a member alert: the location(s) of that member's plans (their plan mappings), preferring
 *             live sources (active / pending / failed) over ended ones. If that finds nothing, and the client has
 *             exactly one location, that location — every member is there.
 *             For a client-wide alert (no member): the client's only location, or the client's name when it has
 *             several (the sync ran for the whole gym).
 *             Otherwise NULL — and the sentence leaves the location out rather than guess.
 *
 * The fragment expects the alert table aliased as `cal`.
 */

'use strict';

const ALERT_CONTEXT_COLUMNS = `
       COALESCE(NULLIF(TRIM(ac_m.display_name), ''),
                NULLIF(TRIM(CONCAT_WS(' ', ac_m.first_name, ac_m.last_name)), '')) AS member_name,
       CASE
         WHEN ac_m.id IS NOT NULL THEN COALESCE(ac_ml.live_names, ac_ml.any_names,
                                                 CASE WHEN ac_cl.n = 1 THEN ac_cl.only_name END)
         WHEN ac_member_ref THEN NULL
         ELSE CASE WHEN ac_cl.n = 1 THEN ac_cl.only_name ELSE ac_c.name END
       END AS location_name,
       ac_c.name AS client_name`;

const ALERT_CONTEXT_JOINS = `
       LEFT JOIN clients ac_c ON ac_c.id = cal.client_id
       CROSS JOIN LATERAL (
         SELECT (cal.hardware_ref LIKE 'member:%' OR cal.hardware_ref ~ 'member_id=[0-9a-fA-F-]{36}') AS ac_member_ref
       ) ac_ref
       LEFT JOIN LATERAL (
         SELECT mm.id, mm.display_name, mm.first_name, mm.last_name
           FROM member_master mm
          WHERE mm.client_id = cal.client_id
            AND (
                  (cal.hardware_ref LIKE 'member:%' AND mm.platform_member_id = substring(cal.hardware_ref FROM 8))
               OR mm.id = (SELECT ma.member_master_id FROM member_access ma
                            WHERE ma.client_id = cal.client_id
                              AND ma.id::text = substring(cal.hardware_ref FROM 'member_id=([0-9a-fA-F-]{36})'))
                )
          LIMIT 1
       ) ac_m ON TRUE
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT l.name, ' and ') FILTER (WHERE mas.status IN ('active','pending_hardware','pending_start','failed')) AS live_names,
                string_agg(DISTINCT l.name, ' and ') FILTER (WHERE mas.status <> 'draft') AS any_names
           FROM member_access ma2
           JOIN member_access_sources mas ON mas.access_id = ma2.id AND mas.client_id = cal.client_id
           JOIN plan_mappings pm ON pm.id = mas.mapping_id AND pm.client_id = cal.client_id
           JOIN locations l ON l.id = pm.location_id AND l.client_id = cal.client_id
          WHERE ac_m.id IS NOT NULL AND ma2.member_master_id = ac_m.id AND ma2.client_id = cal.client_id
       ) ac_ml ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS n, MIN(l.name) AS only_name FROM locations l WHERE l.client_id = cal.client_id
       ) ac_cl ON TRUE`;

module.exports = { ALERT_CONTEXT_COLUMNS, ALERT_CONTEXT_JOINS };
