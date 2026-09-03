---
name: SUITS integrity
description: Authority, atomicity, retry, and audit rules for the assigned/in-play SUITS system.
---

SUITS assignments, active task configuration, streak stamps, Royal awards, and audit trails are server-authoritative. A mutation and its body-free Activity plus contextual Investigation records must be one conditional Firestore commit.

**Why:** Separate writes can leave a stamp without its Royal or one audit stream, and read-then-write updates can overwrite concurrent changes. Deterministic audit IDs alone do not repair a partially completed operation.

**How to apply:** use update-time or nonexistence preconditions, bounded conflict retries, and verify the full intended state before treating a repeated request as idempotent success. Keep Activity records content-free; contextual evidence belongs only in Investigations.

SUITS assignment, in-play dealing, Royal stamps, and cross-member management accept either pinned Hand admin (00-00 or 01-54) with the admin flag and a non-suspended record.

**Why:** The two Hand seats have equal SUITS-management authority; a generic admin flag still must not grant those powers to any other identity.

**How to apply:** Enforce the pinned two-seat role server-side before privileged reads or writes; client visibility is not an authorization boundary. Keep audit bodies out of Activity.

For 01-54, SUITS must keep dealer work and personal assignments in separate top-level views. 00-00 keeps the single management interface. Both seats may alter the other’s assignment and award Royals.

**Why:** The separate personal view preserves 01-54’s member responsibilities without reducing management authority.

**How to apply:** Show MANAGEMENT / DEALING and MY TASKS only to exact seat 01-54. Both seats write body-free Activity evidence; contextual Investigation evidence remains limited to the established 00-00 audit path.

SUITS destinations should mirror member-facing app actions. Ticket means reviewing the member's own Ticket; System means signing the current contract. Non-completable or access-restricted destinations are view-only and must not navigate.

**Why:** A task label must lead to the action it promises, and opening an icon alone is never trusted completion evidence.

**How to apply:** Keep client and server destination catalogs synchronized, clearly mark view-only cards, and require canonical server evidence for any completion or stamp.