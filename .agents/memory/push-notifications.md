---
name: Push notifications
description: Expo push architecture for Jester's Hand — client-driven relay, no Firebase Admin SDK
---

## Architecture
- Sender's device writes the bell notification to Firestore, then best-effort POSTs to the api-server relay (`/api/push/send`), which forwards to Expo's push API. No server-side Firestore triggers (no Admin SDK / Cloud Functions in this project).
- Recipients' Expo push tokens live on `users/{uid}.expoPushToken`, written by the owner on sign-in; all authed users can read user docs, so the sender fetches tokens client-side.
- The relay verifies the caller's Firebase ID token with plain `node:crypto` against Google's securetoken x509 certs (aud/iss = `EXPO_PUBLIC_FIREBASE_PROJECT_ID` from shared env) — no admin credentials needed.

- Dead-token cleanup is server-side: the relay clears ticket-stage DeviceNotRegistered tokens immediately and schedules in-process delayed getReceipts polls (receipts can take ~15 min). Pending ticket ids are also persisted in a server-only Firestore collection (`pushReceiptQueue`, unmatched by client rules = default-deny) and a startup+interval sweeper finishes any polls a restart interrupted; entries expire after 24h (Expo drops receipts by then). Cleanup clears `users/{uid}.expoPushToken` via Firestore REST using the FIREBASE_TOKEN refresh-token → OAuth exchange (firebase-tools public CLI client). Deletes are guarded by a token-equality query + updateTime precondition so re-registrations aren't clobbered.

**Why:** app is Firestore-client-only; api-server has no Firebase service account (FIREBASE_TOKEN exchange stands in for admin creds). Client-side receipt timers died when the sender closed the app, leaking dead tokens. Client-driven push means a push is only as reliable as the sender's connectivity — acceptable because the bell feed is the source of truth.

**How to apply:** any new notification write path must also call the push send helper after commit (transactions can't, so capture recipients and send post-commit). Expo Go on Android SDK 53+ can't receive remote pushes — registration/sending must stay try/catch best-effort.

## Member-facing vocabulary
- Pocket = private messages. Whisper = public discussion under a Target Ticket. Table Talk = the Ticket action that starts a Pocket conversation. Internal legacy file/route names may remain, but visible copy must use these terms.
- Bell rows and device pushes share one canonical title catalog. Normalize legacy private-message rows at read/display time so old generic text still appears as Pocket language.

## Web Push (browser) delivery
- Browsers subscribe via `lib/webPush.ts` (`public/sw.js` service worker, VAPID keys in shared env: `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`, client key `EXPO_PUBLIC_VAPID_PUBLIC_KEY`). Subscriptions live at `users/{uid}.webPushSubs.{key}`, key = first 12 bytes of SHA-256(endpoint) hex (24 chars) — the server's `clearDeadWebPushSub` derives the same key, keep them in sync.
- The relay sends web pushes with the `web-push` npm package; 404/410 responses trigger server-side subscription cleanup.
- Headless Chromium cannot complete `pushManager.subscribe` (no push service) — full subscribe is untestable in browser E2E; verify permission flow + endpoint validation instead.

## Relay authorization (security-critical)
`/api/push/send` accepts **only** `{ toUids, title, body, data }`. The server resolves each recipient's Expo token + webPushSubs from their user doc itself (admin REST) and honors `alertsMuted`. **Never reintroduce client-supplied tokens/endpoints/subscriptions in the payload.**
**Why:** all members can read user docs, so a client-supplied-target relay let any member push arbitrary convincing notifications to anyone (architect-flagged, fixed).
**How to apply:** new push paths pass recipient uids; target resolution stays server-side in `getUserPushTargets`.

## Alerts opt-out (System screen)
Members can turn alerts off via `users/{uid}.alertsMuted: true`. `registerPushToken` checks this flag first — any new auto-registration path must go through it, or a saved opt-out gets silently re-enabled on sign-in. Toggle-on deletes the flag before re-registering.
