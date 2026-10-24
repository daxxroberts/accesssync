# Kisi ownership marker: move from `notes` to user `metadata` (DR-045 Layer B amendment)

**Date:** 2026-10-23, updated 2026-10-24 | **Status:** Builder-directed 2026-10-24. Phase 1 shipped to main. Phase 2 is on branch `dr045-metadata-phase2`, unmerged: it merges after the HOG backfill verifies clean **and** SAGE ratifies the DR-045 amendment (Tier 3 under RULE-19). KEEPER: vault DR-045 + both CLAUDE.md files need the Layer B wording updated when phase 2 merges.

## Why

Layer B of the DR-045 delete guard was a free-text line in the Kisi user's `notes`: `[AS|managed|<clientId>|<createdAt>] <reason>`. It worked, but:

- it is a dashboard textarea an operator can overwrite without knowing it is load-bearing;
- every suspend / re-enable overwrote the whole field, erasing anything the operator had typed;
- a suspend called without a client id wrote a bare reason and silently stripped the marker, leaving that user undeletable until a later grant re-stamped it.

Kisi users carry a `metadata` object. Kisi's OpenAPI users schema (mirror generated 2026-07-20) accepts it on create and update and returns it on every read. Limits: flat values only (string, null, integer, float, boolean), keys ≤ 50 chars, values ≤ 500 chars, ≤ 50 keys. The users-list `query` filter searches email, name and notes, not metadata — Builder accepts that: bulk checks already page every user, and most users in a client's org are AccessSync's anyway.

## The marker

| Key | Value |
|---|---|
| `accesssync_managed` | `true` |
| `accesssync_client_id` | AccessSync `clients.id` |
| `accesssync_created_at` | ISO-8601 (copied from the notes marker on backfill) |
| `accesssync_marker_v` | `1` |

No PII, nothing a member sees, 4 of Kisi's 50 keys. Code: `adapters/kisi/kisi-adapter.js` (`buildOwnershipMetadata`, `parseOwnershipMetadata`, `mergeOwnershipMetadata`, `readUserOwnership`).

## Rules the code follows

1. **Merge, never replace.** Every metadata write reads the user, spreads the existing object, sets the four keys, and sends the result. Keys another integration owns survive whatever Kisi's PATCH semantics are.
2. **Never overwrite another client's marker.** The backfill refuses if metadata already names a different client.
3. **Never stamp an unmarked user.** Some AccessSync members are linked to Kisi accounts that existed before AccessSync (the owner, admins, staff who bought a plan). They never carried a marker, so AccessSync may not delete them. Stamping them would change that. The migration reports them and leaves them alone.
4. **A conflict is a refusal.** If metadata and notes name different clients, both guards refuse with `CLIENT_MISMATCH` (`markerConflict: true`) — the code `finalizeRevoke` already maps to a clean refusal, so no retry loop.
5. **Layers A and C are unchanged.** DB `source_tag` and the elevated-role refusal still stand behind the marker.

## Phase 1 — shipped to main

- `createUser` writes the metadata marker and the legacy notes line, with one shared timestamp. If Kisi rejects the `metadata` field (documented, not yet seen live), it logs `kisi.user.create_metadata_rejected` and creates the user exactly as before, so a member's grant never fails on it.
- `deleteUser` and `setUserName` read ownership through `readUserOwnership`: metadata first, notes second, conflict refused.
- `listAllUsers` adds `ownerClientId` and `ownershipSource` per user (no extra Kisi calls).
- Reconcile Pass 3 logs `ownershipMarkerNotInMetadata` on `reconciliation.pass_3_complete`: active members whose Kisi user carries a notes-only or conflicting marker. It is a count only — no finding, proposal, repair or revoke. **0 means the backfill is complete.** Reconcile never read notes before this change and still doesn't.
- `scripts/kisi-ownership-migrate.js` — `verify` and `backfill`.
- `scripts/backfill-kisi-names.js` uses the shared ownership reader.

## Runbook — production steps (Builder runs these; this cloud session cannot reach Kisi)

From the repo root with `DATABASE_URL` and `API_KEY_ENCRYPTION_KEY` set, exactly as for `scripts/backfill-kisi-names.js`:

```bash
# 1. Baseline. Read-only. Expect most HOG users "notes only".
node scripts/kisi-ownership-migrate.js verify

# 2. See what backfill would write. Read-only.
node scripts/kisi-ownership-migrate.js backfill

# 3. Write it. Per user: read, merge, PATCH, re-read to confirm.
node scripts/kisi-ownership-migrate.js backfill --apply

# 4. Check the metadata against the notes. Must end "READY FOR PHASE 2".
node scripts/kisi-ownership-migrate.js verify
```

Then wait for one nightly sweep and confirm `ownershipMarkerNotInMetadata: 0` on HOG's `reconciliation.pass_3_complete`.

Anything listed as CONFLICT needs a human look before phase 2: one Kisi user carries two markers naming two different clients.

## Phase 2 — branch `dr045-metadata-phase2`, merge only after step 4 is clean

- Guards read metadata only. The notes fallback and the conflict case are gone.
- `createUser`, `suspendAccess`, `enableAccess` stop writing notes. Suspend / re-enable patch `access_enabled` only, so an operator's notes are never erased again.
- A static test fails the build if any runtime file under `adapters/` or `core/`, or any script other than the migration, reads or writes a Kisi user's `notes`.
- The migration script gains `clear-notes`: removes the notes line from every user whose metadata marker names this client **and** whose notes are exactly an AccessSync marker line. Notes with anything else in them are reported and left alone.

After phase 2 deploys:

```bash
node scripts/kisi-ownership-migrate.js clear-notes            # dry run
node scripts/kisi-ownership-migrate.js clear-notes --apply
node scripts/kisi-ownership-migrate.js verify                  # notes markers: 0
```

Day-pass group links are unaffected: links have no `notes` or `metadata`, so their marker stays in the link's `name`.

## Side findings from the spec read, for separate tickets

- `POST /role_assignments` marks `user_id` / `group_id` deprecated in favour of `assignee_type`/`assignee_id` and `applies_to_type`/`applies_to_id`. `assignRole` still uses the deprecated pair.
- Role assignments accept `notify: boolean`; AccessSync relies on Kisi's default.
- `GET /role_assignments` supports a `group_id` filter that a comment in `assignRole` calls unverified.

## References

- Kisi OpenAPI mirror: github.com/api-evangelist/kisi (`openapi/kisi-users-api-openapi.yml`, `kisi-group-links-api-openapi.yml`).
- Tests: `test/p1-critical-path/kisi-ownership-metadata.test.js`, `test/p3-data-integrity/kisi-ownership-migrate.test.js`, the DR-045 block in `test/p3-data-integrity/reconcile-revoke-gate.test.js`.
