# AccessSync — Operator FAQ

The plain-language reference for gym owners and operators using AccessSync. Written for people setting up the Wix → access control sync, embedding member-facing screens, and managing day-to-day membership access.

This document is the source of truth for operator-facing answers. Onboarding flows, in-app help text, the install guide, and any external help center should pull from here — not write their own version.

---

## Operating Model — Read This First

**Wix is for access you sell. Your access control system is the source of truth for who actually has access.**

- If access is **sold** (a member bought a plan) → it flows Wix → AccessSync → your access control system. AccessSync manages it.
- If access is **granted** (contractor, employee, comp, guest, admin) → add them in your access control system directly. AccessSync stays out.

This boundary is intentional. AccessSync's job is to keep the people you sold to in the right doors. Anyone you grant access to outside of selling is managed where they live — in your access control system.

---

## Granting and managing access

### I want to give a contractor / employee / friend access without a paid membership. How do I do that in AccessSync?

You don't. AccessSync syncs sold memberships from Wix to your access control system. For access you grant directly — contractors, staff, comps, guests — add them in your access control system directly. AccessSync isn't where that's managed.

If a person needs both — they're an employee AND they bought a plan — that works fine. They'll show up in AccessSync for the part you sold (their plan). Their other access is shown on their member card under "Other access (not managed here)" so you know it exists, but AccessSync won't touch it.

### Why does AccessSync revoke members who aren't in Wix anymore?

Because that's its job. AccessSync keeps your access control system in sync with what your members are actually paying for. If a member's Wix subscription cancels, expires, or otherwise drops out of Wix's active list, AccessSync removes their door access at the next sync.

Two important guardrails:
1. **AccessSync only manages access it created.** It will never revoke someone you added directly in your access control system. Manual additions are protected.
2. **AccessSync won't trust a broken Wix response.** If the Wix API errors out or returns suspicious data (like a sudden 25%+ drop in active members), the sync aborts and you get an alert instead of mass revokes.

### What happens during a Wix outage?

The sync aborts and notifies you. No grants, no revokes. Everyone keeps the access they had until Wix comes back. AccessSync errs on the side of doing nothing rather than guessing wrong.

### What if Wix returns a strange response — like suddenly saying nobody is active?

AccessSync has a sanity check. If a sync would remove access from 25% or more of your members in one run, it pauses, waits 30 seconds, and asks Wix again. If the second answer disagrees with the first (typical of a transient API hiccup), the revokes are cancelled and you get an alert instead. If the second answer agrees, the revokes proceed — that's a real mass cancellation, not an anomaly.

This protects against silent Wix API bugs that could otherwise lock out your whole membership at once.

### Can I give myself access through AccessSync if I'm an admin in my access control system?

You already have access through your admin role — AccessSync isn't part of that. If you also want to test the member experience, the recommended path is to buy a plan in Wix like a real member would. AccessSync will provision you the same way it provisions anyone else, on top of your admin access.

### What happens if I delete a member in AccessSync?

The member's AccessSync-managed access is removed from your access control system. Any access they have outside AccessSync (admin role, manually-added groups) is untouched.

---

## Plan holders and additional members

### I bought a multi-member plan. Why don't I have access yet?

Plan holders don't get access automatically. Owning the plan and using a seat on the plan are separate. If you want a seat on the plan you bought, claim one explicitly via the "Add me to this plan" button on the Member Hub.

This supports the case where someone buys a plan for others (e.g., an employer paying for staff access) without forcing them onto the plan themselves.

### What does "Pending" mean on a member?

It means AccessSync is still working on syncing their access — usually a few seconds. If a member stays in "Pending" for more than a couple minutes, something's wrong with the sync chain (Wix data, plan mapping, or hardware connection). Check the dashboard for alerts.

### What if someone is an admin AND a paying member?

That's fine. They'll show up in AccessSync with their paid plan, and their admin role appears on their member card under "Other access (not managed here)" as a heads-up. If you cancel their plan in Wix, AccessSync removes the plan-side access. Their admin role stays — that's not AccessSync's to manage.

---

## Setup and onboarding

### Where does AccessSync live?

Two services running on Railway: a Core Engine (handles Wix webhooks, talks to your access control system) and an Admin Hub (the dashboard you log into). Members never see either directly — they interact with embedded screens on your Wix site.

### What do I need to install AccessSync?

1. A Wix site with the Pricing Plans or Bookings app
2. An account in a supported access control system (currently Kisi)
3. API access on both — AccessSync handles the rest of the wiring

The onboarding wizard walks through each step. You'll need: Wix API key, access control system API key, your site URL, and one mapped plan to confirm everything works.

### How do I embed the sync screens on my Wix site?

There are two member-facing screens AccessSync provides:
1. **Sync Status** — shown right after a member buys a plan, animates them through the provisioning steps
2. **My Access / Manage Members** — the member's ongoing view of their access and (for multi-member plans) their additional members

Both are HTML pages embedded as iframes via Wix Velo. The onboarding wizard provides the snippets. Both screens self-resize to fit the Wix layout.

---

## Maintenance Rule (internal — for the team building this)

**Any customer-facing feature update — operator dashboard, member screens, onboarding wizard, embedded widgets — requires a corresponding FAQ update in this file.** A feature isn't done until the operator-facing answer exists here. This is how onboarding material, install guides, and help content stay current without a separate documentation sprint.

When in doubt: if a member or operator could see it, the FAQ should explain it.
