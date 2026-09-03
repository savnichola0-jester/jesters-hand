---
name: Firebase setup
description: Firebase project wiring for Jester's Hand — auth scheme, Firestore structure, Storage paths, env vars
---

## Auth scheme
- Email/Password auth
- Email format: `{jokerID.toLowerCase()}@jestershand.local`
- Password = Cipher entered on lock screen
- Joker IDs are admin-assigned in Firebase Console → Authentication → Add user
- Native auth must initialize with React Native AsyncStorage persistence. Swiping the app out of Android Recents must not sign the member out; only explicit sign-out, suspension, or credential revocation ends access.

**Why:** Firebase React Native otherwise defaults to process-memory persistence, which loses the session whenever Android kills the app.

**How to apply:** Keep web on `getAuth`; initialize native Auth once with Firebase’s React Native persistence adapter and the existing AsyncStorage package. An in-app update may require one final login before future launches persist.

## Firestore structure
- Collection: `users/{uid}`
- Fields: jokerId, name, street, role, state, country, firstjest, patterns, coffee, donut, juice, codex, creed, streetart, haunting, static, mugUrl, adminPhotoUrl, filed (bool), filedAt (timestamp)

## Storage paths
- User mug: `users/{uid}/mug.jpg`
- Admin photo: `users/{uid}/admin.jpg`

## Env vars (EXPO_PUBLIC_ prefix for Expo client access)
- EXPO_PUBLIC_FIREBASE_API_KEY
- EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN
- EXPO_PUBLIC_FIREBASE_PROJECT_ID
- EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET
- EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID
- EXPO_PUBLIC_FIREBASE_APP_ID

## Notifications
- Feed: `notifications/{uid}/items` — rules allow owner read/update/delete; any auth user may create for others only with `fromUid == their uid`, `read == false`, never to self. This lets message sends fan out notifications inside the same Firestore transaction as the message (no post-commit best-effort window).

## Key files
- `lib/firebase.ts` — app init, exports auth/db/storage
- `lib/ticketService.ts` — Firestore + Storage helpers
- `contexts/AuthContext.tsx` — auth state + jokerId from Firestore

**Why this email format:**
Firebase Email/Password requires email format. Using `{id}@jestershand.local` keeps it human-readable while still passing Firebase validation. Users never see this email — they only type their Joker ID.
