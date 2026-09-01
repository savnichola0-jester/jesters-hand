---
name: Reaction integrity rules
description: Design constraints behind the own-uid-only emoji reaction rules
---

Firestore rules can't loop over map keys, so honest reaction toggles are enforced by pinning the allowed emoji set inside the rules and checking each emoji's array with the `toSet().difference().hasOnly([request.auth.uid])` pattern (same as mutedBy), plus requiring `reactions` to start empty on non-admin creates so forged reactions can't be planted at create time. Admin verbatim-restore create branches deliberately bypass the empty-create check.

**Why:** an `affectedKeys().hasOnly(['reactions'])` check alone lets any member forge or erase other people's reactions; and without the pinned key list an attacker can forge under a novel emoji key.

**How to apply:** the emoji list pinned in the rules must stay in sync with the app's reaction picker — adding a client emoji without updating AND deploying rules makes that button fail with permission-denied. Any new reactable collection must reuse the shared rules helpers and the empty-reactions create check.
