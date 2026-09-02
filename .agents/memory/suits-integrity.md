---
name: SUITS integrity
description: Authority, atomicity, retry, and audit rules for the assigned/in-play SUITS system.
---

SUITS assignments, active task configuration, streak stamps, Royal awards, and audit trails are server-authoritative. A mutation and its body-free Activity plus contextual Investigation records must be one conditional Firestore commit.

**Why:** Separate writes can leave a stamp without its Royal or one audit stream, and read-then-write updates can overwrite concurrent changes. Deterministic audit IDs alone do not repair a partially completed operation.

**How to apply:** use update-time or nonexistence preconditions, bounded conflict retries, and verify the full intended state before treating a repeated request as idempotent success. Keep Activity records content-free; contextual evidence belongs only in Investigations.

SUITS assignment and in-play dealing accept either pinned Hand dealer (00-00 or 01-54) with the admin flag and a non-suspended record. Royal stamps and Investigations remain 00-00-only.

**Why:** 01-54 is explicitly a dealer but not the owner; broader admin capabilities must not leak through SUITS access.

**How to apply:** enforce exact role checks server-side before owner-credential reads or writes; client visibility is not an authorization boundary.