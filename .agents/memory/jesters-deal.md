---
name: Jester's Deal integrity
description: Security and task-semantics rules for activity-backed Deal progress and Seat Temperature.
---

Deal progress, streaks, milestones, and Seat Temperature must be derived from server-verified evidence of a real app action. Clients may request recording or reconciliation, but may not write activity or aggregate documents directly.

**Why:** Shape-valid client counters and client-created event records were still forgeable. Trusted aggregation only became reliable after the API verified the authenticated member against the source Black Book, Target, Table, or Vault-mark document before recording an immutable event.

**How to apply:** Every new Deal task type needs a canonical, idempotent source identifier, a server-side evidence verifier, a real producer callsite, and adversarial rules/API tests. Do not expose a task type in the admin editor until all four exist. Login and passive Vault opens do not count.

Timed Deals must be evaluated against wall-clock expiry while a screen stays open; do not rely on a Firestore snapshot arriving at the expiry instant.

**Why:** Firestore does not emit a document change merely because an `expiresAt` timestamp has passed.

**How to apply:** Any Deal-aware UI must use the shared expiry-aware live-Deal selection rather than filtering only inside snapshot callbacks.

Every new Deal task card is assigned to one active Joker ID. Either provisioned Hand admin (00-00 or 01-54) may assign any active member, including the other Hand seat. Both seats remain eligible to receive and complete cards.

**Why:** The two Hand seats have equal Deal-management authority, but management authority must not erase either seat’s member-task state.

**How to apply:** Pin management authority to active admin records for 00-00/01-54 at the client, server, and rules boundaries; show dealers their own assigned cards and calculate progress only from cards assigned to that member.

Only 01-54 gets separate MANAGEMENT and MY TASKS tabs in Jester's Deal. 00-00 keeps the single management interface.

**Why:** The personal-task split exists so 01-54 can manage the Deal without hiding their own assignments; it is a UI distinction, not reduced authority.

**How to apply:** Gate the personal tab by exact Joker ID 01-54, never by generic dealer/admin capability.