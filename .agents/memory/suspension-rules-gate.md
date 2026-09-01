---
name: Suspension gate in security rules
description: How rules re-check users/{uid}.suspended on every request, and the two carve-outs
---

Firestore + Storage rules gate all club data on `activeUser()` / `signedIn()` = signed in AND not suspended, because a suspended member's ID token stays valid ~1 hour after The Hand flips the flag.

**Pattern:** `isSuspended()` must be exists-guarded (`exists(users/uid) && get(...).data.get('suspended', false) == true`) — a bare `get()` on a missing user doc errors and would deny fresh sign-ups and any auth context without a user doc.

**Carve-outs (do not "fix"):**
1. Suspended member may still READ their own users/{uid} doc — the app needs it to detect suspension and sign out.
2. The deletion-only expoPushToken update branch stays open to suspended members so sign-out can remove their token.

**How to apply:** any NEW Firestore match block or storage path must use `activeUser()` / `signedIn()` — not raw `request.auth != null` — or suspended members regain access there.
