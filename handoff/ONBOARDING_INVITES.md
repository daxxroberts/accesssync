# Onboarding invites — decision record, blast radius, deploy checklist

**Status:** built on branch `claude/tenant-isolation-hardening`, **not deployed**. Needs Builder go-ahead (see §6).
**Owner of the decision:** SAGE gate (build approved; deploy not approved by this record).
**Code:** `core/invite-token.js`, `admin/routes/onboarding.js`, `admin/routes/operator.js` (onboarding routes), `admin/routes/clients.js` (`POST /:id/invite`), `admin/views/pages/onboard.ejs`, `admin/views/pages/admin-panel.ejs`.
**Tests:** `test/p3-data-integrity/onboarding-invite-scenarios.test.js` (56), `onboarding-rate-limits.test.js` (6), `test/p2-onboarding/e2e-webhook-helper.test.js` (5).

---

## 1. What was wrong (verified with the real routers and real auth middleware)

| # | Finding | Severity |
|---|---|---|
| 1 | `GET /onboard` is public and wrote `OPERATOR_INVITE_TOKEN` into its own HTML. The "invite token" was readable by anyone. | Critical |
| 2 | The auth bypass in `operator.js` checked only that an `x-invite-token` header **existed**. Anonymous `GET /operator/:clientId/locations`, `…/mappings`, `/clients/:id/kisi-groups`, `…/api-key/status`, `…/api-key/test` returned 200 with a junk value. | Critical |
| 3 | With the (public) token: `GET /operator/site-id/verify` leaked a client's id, name, tier and locations for any Wix site ID; `POST /operator/issue-session {clientId, siteId}` minted an 8h operator session for any registered gym; `POST /operator/clients` upserted by site ID and overwrote `platform_instance_id`; `POST /operator/clients/:id/api-key` overwrote a gym's Kisi key. | Critical |
| 4 | `POST /auth/pin` logs in as the **owner** (all clients) and had no rate limit anywhere in the admin app. The repo's e2e defaults and `docs/url-reference.html` carried `2096`. | Critical |
| 5 | Owner panel built inline `onclick` handlers from client names (only `"` escaped) and wrote names into `innerHTML` toasts. A gym that can rename itself could run script in the owner's session. | High |
| 6 | The e2e suite signed webhooks with a committed shared secret and no client id, against production, for the real House of Gains client. | High |

## 2. The design

**The owner creates the client; the gym is invited into it.** There is no public signup and no shared token.

1. Owner panel → **New client** → `POST /admin/clients` (creates the row and its own webhook secret).
2. `POST /admin/clients/:id/invite` returns `https://<admin>/onboard?invite=<token>`. The panel offers **Copy** and **Open email draft** (a `mailto:` in the owner's own mail client). Email is never the only channel.
3. The token is `base64url({p,c,e,n}).base64url(HMAC-SHA256)`: purpose, **one client id**, expiry, nonce. Key = `INVITE_SIGNING_SECRET`, else derived from `ADMIN_JWT_SECRET` with a purpose label. Default lifetime 72h (`INVITE_TTL_HOURS`, clamped 1–168).
4. `GET /onboard?invite=…` decides which screen to show and **changes nothing** (no cookie, no state, `Cache-Control: no-store`).
5. The gym presses **Start setup** → `POST /onboard/redeem` → `operatorToken` cookie (8h, httpOnly, `SameSite=Lax`) scoped to that client. The token is then removed from the address bar.
6. Every wizard call rides that cookie. `router.use(requireAuthOrOperator)` covers the whole operator router (no pre-session exception) and `router.param('clientId')` pins an operator to its own client.

Why **not** single-use: see §3. The v2 that is single-use is in §7.

## 3. "What if it doesn't work?" — scenario matrix

Every row is an automated test in `onboarding-invite-scenarios.test.js` unless noted.

| Scenario | What happens | Why this design |
|---|---|---|
| Invite never arrives / goes to spam | Owner presses **Setup link** again. Old and new links both work. Nothing is blocked. | Delivery is manual and observable; email isn't relied on. |
| Email security scanner or link preview opens it first | Nothing is consumed; gym's click still works. (5 scans, then redeem, tested.) | A burn-on-first-use token would be dead on arrival here. **Most likely real-world failure of one-time links.** |
| Opened on a second device / double-click / response lost | Every redeem succeeds; each gets a session scoped to the same client. | Burn-on-use strands the person whose response was lost. |
| Link expires before they open it | "This setup link has expired" screen + "ask your AccessSync contact". Owner issues a new one. | Expiry is the control that replaces single-use. |
| Link truncated / mangled when copied | "This setup link isn't complete" screen. No lookup, no session. | Signature check first. |
| Link forwarded to someone else | They get the same power the gym would: setup of **that one client**. Not another client, not the owner (tested). | Bearer link; blast radius capped to one client for ≤72h. |
| Attacker edits the client id inside the token | Signature fails. | HMAC. |
| Other token types replayed (session JWT, QR token) | Rejected (purpose pin + separate key). | Domain separation. |
| Client archived after the link was sent | Page and redeem both say "no longer active". | Archive is the revoke switch. |
| Signing secret rotated | Every outstanding link dies at once. | Panic button. |
| Server has no signing secret | 503 "unavailable" — never accepts, never says "invalid". | Fails closed, distinguishable. |
| Operator session ends mid-wizard (8h, cookie cleared) | Overlay "Your setup session ended — Nothing you've already saved is lost"; typed data stays; Reload shows "You need a setup link" if no cookie. (Browser-verified.) | Server state is the source of truth; wizard resumes from `GET /operator/:id/onboarding-status`. |
| Gym has no Wix dashboard extension (OB-64) | Their way back in is a new owner-issued link. | The old way back in **was** the exploit (`issue-session`). |
| Browser blocks cookies / private window | "Your browser blocked the setup session" with what to do. (Browser-verified.) | Redeem succeeds but first status call 401s → explained. |
| Retry after a failed door-key save | Location is **not** created twice. (Browser-verified.) | Provisioning is idempotent (`provisioned` flag + server status). |
| Gym name contains `&`, `<`, quotes, `</script>` | Rendered inert everywhere; All Set headline no longer shows `&amp;`. (Browser-verified.) | JSON-escaped boot data, `textContent`, data-attributes. |
| Brute-forcing links or the owner PIN | 10 failures / window per address → 429. | Real limiter, tested separately. |
| House of Gains | Existing portal sessions, webhook path and routes unchanged; issuing/redeeming writes nothing to HOG. | Regression tests in group E. |

**Honest limits of the stateless design** (the trade-off the Builder is accepting):
- A leaked link works until it expires (≤72h) or the client is archived. There is no per-link revoke.
- "First redeemer wins" does not apply: any holder can redeem repeatedly during that window.
- No "link used at …" display in the owner panel. (Each issue and redeem **is** written to `activity_event`.)

## 2a. Wix install = the invitation (second, equal entry)

The app is not in the Wix marketplace; the AccessSync owner installs it on each customer's Wix site. So no link is needed for those customers:

1. Customer's Wix **site owner** opens AccessSync from the Wix dashboard → `GET /operator-portal?instance=<signed>`.
2. `requireWixInstance` verifies the signature with `WIX_APP_SECRET` and rejects anonymous / not-signed-in viewers. Anyone Wix lets into that site's dashboard (owner, co-admin, staff) may open it — the instance is scoped to one installation, so they can only ever reach that site's client.
3. Path A (known `platform_instance_id`) → their dashboard. Path B (unwired client with a matching site id) → wires it. **Path C (new)**: nothing matched → `INSERT INTO clients (name='New Wix site', platform_instance_id=<verified instanceId>, status='active')`; a unique-index race re-reads the winner's row (one installation can never become two clients). A webhook secret is generated. `source_site_id` stays NULL — the authorizationCode site id is unsigned, so the wizard collects and verifies it.
4. The portal issues the scoped `operatorToken` and sends a client with no key and no locations to `/operator-portal/setup` → wizard (placeholder name is left blank for the gym to fill in).

Nothing from the URL (siteId, clientId, authorizationCode) is trusted or stored on this path. A shell client has no Kisi/Wix key, so reconciliation (`source_api_key` + `source_site_id` required) skips it; the nightly interval gate now orders by `last_sync_at DESC NULLS LAST` so a new shell can't be picked in place of HOG. Invite links (§2) remain the way to onboard a customer without a Wix install.

Changed on the owner's instruction: the owner-only gate was removed; any signed-in Wix dashboard user for the site gets in.

## 4. Blast radius of this change

| Surface | Change | Who is affected |
|---|---|---|
| `/onboard` | No longer a public wizard. Needs an invite or a session. | Anyone who bookmarked it. **The Wix install path is unchanged in effect:** the AccessSync owner installs the app on a customer's Wix site; that customer's owner opens it from the Wix dashboard → Path C in `wix-instance.js` creates the client from the Wix-signed instance and lands in setup (see §2a). |
| `/operator/*` | Every route requires a session; `x-invite-token` removed; `issue-session`, `POST /clients`, old `site-id/verify` behaviour removed. | Nothing in the repo calls them except the wizard (updated). |
| `POST /operator/clients/:id/{locations,api-key,locations/:l/activate}` | Session-scoped instead of token-scoped. | The wizard. |
| Wizard | Updates the owner-created client instead of creating one; site ID cannot be repointed; no `platform_instance_id` from the page. | New gyms. |
| Owner panel | **New client** + **Setup link**; card buttons use `data-*` + one delegated listener. | Owner. |
| `/auth/pin`, `/auth/google`, `/operator/verify-bypass`, `/onboard/redeem` | Rate limited (10 failures / 15 min; redeem 10/min). | The owner after 10 failed PINs from one IP. |
| e2e suite | Needs `OWNER_PIN`, `E2E_WEBHOOK_SECRET` (HOG's per-client secret) in the environment; sends `x-accesssync-client-id`. **Not run here** (it targets production). | Whoever runs e2e. |
| Webhooks | Unchanged verification: a named client with its own secret is checked against that secret only; otherwise the Wix developer-dashboard secret. Added: a signed webhook naming client A cannot be routed to client B by its site-id header. | Nobody — production's 368 accepted webhooks all name a client. |
| Env | `OPERATOR_INVITE_TOKEN` retired. `WIX_WEBHOOK_SECRET` is **kept** (Wix developer-dashboard secret; webhooks that name no client are verified with it). `INVITE_SIGNING_SECRET` optional. | Railway config. |
| Email | Unchanged. Invites don't use it. | — |

## 5. Not fixed here (open items for the Builder)

1. **Rotate `OWNER_PIN` now.** The repo history contains `2096` as the e2e default and as the documented invite value. If production's PIN is the same, the owner login is public regardless of any code. Code can't fix that; rotating can.
2. `/api/multi-member/*`, `/member/:id/widget-data` are unauthenticated beyond knowing a client id + member id; `/member/access-status` accepts `x-internal-proxy: 1` to skip login. (Separate review.)
3. The gym can self-activate its location (`…/activate` flips billing to `active`). Needs billing integration (OB-66).
4. Wix site-ID squatting: a gym could enter a site ID it doesn't own. Mitigated by owner-supplied site ID at creation and the unique constraint; real fix is verifying ownership against Wix.
5. e2e runs write test members into the real House of Gains account in production. Point e2e at a staging stack before more tenants exist.
6. Rotate-secret grace window (keep the old webhook secret valid ~24h) needs a column → SAGE.

## 6. Deploy checklist (order matters)

1. Builder approves; CI green on the branch.
2. **Before deploy:** rotate `OWNER_PIN` in the Admin Hub service. Confirm every real client has a `wix_webhook_secret` (HOG does; query `SELECT id,name,(wix_webhook_secret IS NOT NULL) FROM clients`).
3. Deploy Core Engine **and** Admin Hub together (both changed).
4. Smoke test: owner panel loads; **Setup link** on a test client; open it in a private window; **Start setup**; wizard shows step 1 prefilled; HOG dashboard still loads via the Wix portal.
5. After it is healthy: delete `OPERATOR_INVITE_TOKEN` from Railway (both services). **Do not delete `WIX_WEBHOOK_SECRET`.**
6. Optionally set `INVITE_SIGNING_SECRET` (random 32+ bytes) so invites rotate independently of sessions.
7. Update e2e runner env (`OWNER_PIN`, `E2E_WEBHOOK_SECRET`).

**Rollback:** redeploy the previous commit. No schema or data changed, so there is nothing to undo. (The old wizard returns with its public token — which is why step 2's PIN rotation should not be skipped.)

## 7. v2: true single-use links (needs SAGE + Builder, and a migration)

Only worth it if per-link revocation or "used at" visibility becomes a requirement.

```sql
-- NOT APPLIED. Proposed.
CREATE TABLE onboarding_invites (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,          -- sha256 of the token; the token itself is never stored
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz,
  redeemed_ip  text,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```
Keep the interface (`signInvite` / `verifyInvite`) and add a `consume()` step. If adopted it **must** keep: redeem as a user-initiated POST (scanner-safe), a short idempotent re-redeem window (~15 min, same browser) for lost responses and double-clicks, and "Resend" that revokes the previous unused link. Without those three, the §3 failure modes come back.

## 8. KEEPER sync (repo `CLAUDE.md` + vault — not edited here, per its own rule)

- Env list: remove `OPERATOR_INVITE_TOKEN` (keep `WIX_WEBHOOK_SECRET`); add `INVITE_SIGNING_SECRET` (optional) and `INVITE_TTL_HOURS` (optional); change `OWNER_PIN` description (it is the owner login PIN, not just an onboarding bypass).
- Key files: add `core/invite-token.js`, `core/webhook-secret.js`, `admin/routes/onboarding.js`.
- Decision to log: *Onboarding is owner-initiated and invite-only; invites are stateless signed bearer links bound to one client (v1); true single-use is a deferred v2.*
