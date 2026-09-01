---
name: Member admin (The Hand)
description: Suspend/Recover/Transfer architecture — Identity Toolkit via FIREBASE_TOKEN OAuth, fail-closed wipe rules
---

## Architecture
- Admin member ops (disable login, reset password, full data wipe) run on api-server routes `/api/admin/{suspend,recover,transfer}`; caller's ID token is verified and `users/{uid}.isAdmin` is re-checked server-side (client gate never trusted). Self-targeting and admin-targeting are blocked.
- The FIREBASE_TOKEN OAuth exchange (same as push cleanup) also works for the Identity Toolkit admin REST (`accounts:update` — disableUser/password/validSince) and the GCS JSON API — no service account needed.
- `suspended` boolean on `users/{uid}` is display-only; real enforcement is Auth disable + validSince session revoke. Login screen maps `auth/user-disabled` to a friendly message.

## Wipe rules (Transfer)
- The wipe manifest lives in `memberAdmin.ts` — **any new per-user collection or storage path must be added there**, or Transfer silently leaks data.
- Table channels are discovered dynamically via a showMissing list of `tableMessages` (channel parent docs are "missing" docs). Never hardcode channel lists server-side — they rotted once already.
- Storage deletion is fail-closed: any list/delete failure aborts the transfer with an error (slot stays locked) rather than reporting success with residual files.
- Transfer order: disable account → wipe → set new password → re-enable. A mid-wipe failure leaves the slot disabled so retry is safe.

**Why:** review caught a stale hardcoded channel list and a best-effort storage wipe that could report success while leaving data — both violate "permanent wipe" semantics.

## Wipe proof + REST gotchas (validated via emulator e2e test)
- Firestore `:commit` write/delete names must be bare resource names (`projects/.../documents/...`) — passing the full URL returns 400. Hand-built names need a docName helper; listDocs results are fine.
- The wipe manifest must also cover notifications the member *sent* into other users' inboxes (`fromUid == uid`), not just their own inbox.
- Admin helpers are emulator-aware: `FIRESTORE_EMULATOR_HOST` switches firestoreBase + yields "owner" token; `FIREBASE_STORAGE_EMULATOR_HOST` switches the storage JSON API origin. Powers the e2e wipe test (`artifacts/api-server/scripts/wipe-test.mjs`, run under `firebase emulators:exec` from artifacts/jesters-hand; `wipe-test` workflow).
- Test bundles the real memberAdmin.ts with esbuild (pino external, NODE_ENV=production to avoid pino-pretty transport), seeds every manifest area for a victim + bystander, ends with a global JSON grep sweep for the uid.

## Admin ticket editing (The Hand)
- The Jester edits any member's ticket in-app (hand-ticket screen): photo cards tap-to-upload, EDIT INTEL mode for fields. Rules `users/{uid}` update has an admin branch with an explicit **allow-list** (15 ticket field ids + mugUrl/adminPhotoUrl). **Why:** a deny-list (just isAdmin/jokerId) was rejected in review — it exposed suspended/expoPushToken etc. New ticket fields must be added to both `ticketFields.ts` and this rules list.
- Storage `users/{uid}/` writes are pinned to `mug.jpg`/`admin.jpg`, image/* only, ≤10MB, with a delete carve-out (`request.resource == null`) so Go Dark keeps working.
- UPDATE (Aug 2026): the users-rules admin branch is now hasOnly(['adminPhotoUrl']) — mug + all ticket fields belong to the member only; the member's own ticket screen no longer offers the admin card picker, and storage pins users/{uid}/admin.jpg writes to isAdmin.
- Second Hand tier (Aug 2026): 01-54 has isAdmin:true + vaultKeeper:false. isKeeper() (firestore + storage rules) gates ALL vault collection/storage curation AND vault_entry archive purges; vaultKeeper is pinned in users update rules like isAdmin. Admins default to keeper when the field is absent. New vault-curation surfaces must gate on isKeeper/isVaultKeeper, not isAdmin. Flag set only out-of-band (api-server scripts/set-second-hand.mjs, has --revert).
