---
name: Vault protected content
description: How the Vault serves private files without Admin SDK or signed URLs
---

## Pattern
Vault content (Firestore `vault/{entryId}`, Storage `vault/{entryId}/file|cover`) is private: no `getDownloadURL` (would mint a permanent tokenized URL). Clients fetch bytes from the Storage REST endpoint with `Authorization: Firebase <idToken>`; Storage rules re-check on every request via cross-service `firestore.get()` that the entry is `published` (or caller is admin). Member views/admin actions are logged to `vaultActivity` (create-only, admin-only read).

**Why:** project has no Firebase Admin SDK/service account, so short-lived signed URLs are impossible; the user's own 1-hour ID token + rules re-check is the equivalent. Never introduce `getDownloadURL` for vault paths — it defeats the protection.

**How to apply:** any new protected-content feature should copy `lib/vaultService.ts` `fetchProtectedDataUri` + the storage.rules cross-service pattern. Storage rules now exist in-repo (`storage.rules`, deployed with `firebase deploy --only storage`); new Storage paths MUST be added there or they fall into the default deny-all block (breaks existing uploads if forgotten).

## Firebase Storage provisioning gotcha
The project's default bucket did not exist until July 2026; `firebase deploy --only storage` failed with "Storage has not been set up". Fixed by creating it via REST: exchange FIREBASE_TOKEN → OAuth token (firebase-tools public client), then `POST https://firebasestorage.googleapis.com/v1beta/projects/{p}/defaultBucket` with `{"location":"US"}`.

## Bucket CORS is required for the web viewer
`alt=media` downloads from `firebasestorage.googleapis.com` only get an `Access-Control-Allow-Origin` header if the **bucket** has a CORS config (preflight passes regardless — the GET itself is what fails). With no config, the web Vault reader's in-iframe fetch dies with a CORS error and shows "Could not open this file" for every member.
**Why:** default Firebase buckets ship with no CORS config, and the `alt=media` endpoint honors bucket CORS (unlike the JSON API). Auth is unaffected — rules/tokens still gate reads.
**How to apply:** if web file viewing breaks with CORS errors, check the bucket's CORS config first; it must allow GET from the app's origins.
