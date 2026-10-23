# Proposal: move the Kisi ownership marker to user `metadata` (DR-045 amendment)

**Date:** 2026-10-23 | **Status:** PROPOSED, needs SAGE ruling (Tier 3 under RULE-19: amends a locked DR) | **Builder preference:** Daxx favours metadata; accepts that it is not searchable and that bulk checks list every user.

## What changes

Today Layer B of the DR-045 delete guard is a free-text line in the Kisi user's `notes`:
`[AS|managed|<clientId>|<createdAt>] <reason>`. It works and is verified live, but it is a human-editable string that an operator can overwrite from the Kisi dashboard without realising it is load-bearing.

Kisi users also carry a `metadata` object. Kisi's OpenAPI users schema (mirror generated 2026-07-20) accepts it on create and update and returns it on every read, with these limits: values must be string, null, integer, float or boolean (no nesting); keys at most 50 characters; values at most 500 characters; at most 50 keys. The `query` filter on the users list searches email, name and notes only, so metadata is not searchable.

Proposal: the structured ownership record moves to `metadata`. `notes` keeps a one-line human hint and remains searchable. The DB `source_tag` (Layer A) and the elevated-role refusal (Layer C) are unchanged.

## Marker shape

Flat keys, all well inside Kisi's limits:

| Key | Type | Value | Why |
|---|---|---|---|
| `accesssync_managed` | boolean | `true` | Cheap presence check. |
| `accesssync_client_id` | string | AccessSync `clients.id` UUID | The ownership claim the delete guard compares against. |
| `accesssync_created_at` | string | ISO-8601 | Carried over from the notes marker; useful in orphan triage. |
| `accesssync_marker_v` | integer | `1` | Lets a future shape change be detected. |

No PII. Nothing a member sees. Four of the 50 keys an org gets; the rest stay free for SCIM or other integrations the operator may run.

## Rules the code must follow

1. **Never replace, always merge.** The spec does not say whether an update replaces or merges `metadata`. Every write reads the user, spreads the existing object, sets the four keys, and sends the result. This protects keys written by Kisi's SCIM sync or any other integration.
2. **Preserve on every PATCH we already make.** `suspendAccess`, `enableAccess` and the name setter in `adapters/kisi/kisi-adapter.js` already PATCH the user. They must not drop metadata. With rule 1 this is automatic.
3. **Notes keeps a short hint.** On create: `Managed by AccessSync. Do not edit or delete here; access is controlled from Wix.` No parse-critical structure in it any more.
4. **Delete guard reads metadata first, notes second.** `deleteUser` Layer B passes when `accesssync_client_id` equals the calling client. During transition it also passes on a valid legacy notes marker for the same client. After backfill is confirmed, the notes fallback is removed in a follow-up commit so the guard is metadata-only. SAGE decides the cut-over date.
5. **Bulk reads carry metadata.** `listAllUsers` returns `{id, email, name}` today. It adds `metadata` so reconcile Pass 2 can label each orphan Kisi assignment as "AccessSync user with no DB row" versus "operator-created user". That is the piece that makes the orphan dashboard (OB-186) meaningful.

## Backfill for existing users

One script, idempotent, safe to rerun: list every user in the org, and for each one whose notes parse as a legacy marker and whose metadata lacks `accesssync_client_id`, write the four keys from the parsed marker. Nothing else is touched. At 5 requests per second the HOG org takes well under a minute. Users with no notes marker are left alone and listed in the script output for a human look.

## Tests

- P1: `deleteUser` refuses when neither metadata nor notes names the client; allows on metadata alone; allows on legacy notes alone during transition; still refuses on an elevated role regardless of marker.
- P1: `createUser` sends flat metadata that satisfies the spec limits, plus the notes hint.
- P3: every PATCH path merges and never drops a foreign metadata key.
- P3: backfill is idempotent and skips users without a legacy marker.

## Rollout

1. SAGE ruling on this note.
2. Ship write side: create and PATCH paths dual-write metadata and the notes hint. Delete guard accepts either. Deploy, verify on one new test member.
3. Run backfill against HOG. Verify every DB-known Kisi user now has `accesssync_client_id`.
4. Follow-up commit: delete guard goes metadata-only. Update DR-045 in the vault and the repo CLAUDE.md key-files list.

## Risks and the answer to each

- **Update replaces instead of merges.** Rule 1 makes this moot; we always send the full merged object.
- **Metadata not searchable.** Accepted by Builder. Reconcile and backfill already page the whole users list.
- **Operator edits metadata in the dashboard.** Unknown whether the dashboard exposes it at all. Either way it is less exposed than the notes textarea. Layer A and Layer C still stand behind it.
- **The 50-key cap is shared with other integrations.** We use four. Backfill and create both check the key count before writing and log instead of writing if the cap would be exceeded.

## Side findings from the same spec read, logged for separate tickets

- The role-assignment create body marks `user_id` and `group_id` as deprecated in favour of `assignee_type`/`assignee_id` and `applies_to_type`/`applies_to_id`. `assignRole` uses the deprecated pair. Works today; should migrate.
- Role assignments accept `notify: boolean`. We rely on the default. Worth setting explicitly once the desired behaviour is decided.
- The role-assignments list supports a `group_id` filter; a code comment in `assignRole` calls it unverified.

## References

- Spec copies and research memo: this session's scratchpad, `kisi-openapi/kisi-users.yml`, `kisi-role-assignments.yml`, `kisi-roles.yml`, `kisi-groups.yml`, `kisi-group-locks.yml`.
- Probe script: `scripts/kisi-metadata-probe.js` (writes and reverts the flat keys on one user).
- Current marker code: `adapters/kisi/kisi-adapter.js` (`buildAccessSyncMarker`, `parseAccessSyncMarker`, `createUser`, `suspendAccess`, `enableAccess`, `deleteUser`, `listAllUsers`).
