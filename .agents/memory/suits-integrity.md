---
name: SUITS integrity
description: Authority, atomicity, retry, and audit rules for the assigned/in-play SUITS system.
---

SUITS assignments, active task configuration, streak stamps, Royal awards, and audit trails are server-authoritative. A mutation and its body-free Activity plus contextual Investigation records must be one conditional Firestore commit.

**Why:** Separate writes can leave a stamp without its Royal or one audit stream, and read-then-write updates can overwrite concurrent changes. Deterministic audit IDs alone do not repair a partially completed operation.

**How to apply:** use update-time or nonexistence preconditions, bounded conflict retries, and verify the full intended state before treating a repeated request as idempotent success. Keep Activity records content-free; contextual evidence belongs only in Investigations.

Privileged SUITS and investigation routes require the permanent `00-00` Joker ID, the pinned admin flag, and a non-suspended user record.

**Why:** Other admin roles must not inherit Jester authority, and relying on only one mutable or not-yet-deployed identity rule creates a privilege-escalation window.

**How to apply:** enforce all three checks server-side before owner-credential reads or writes; client visibility is not an authorization boundary.