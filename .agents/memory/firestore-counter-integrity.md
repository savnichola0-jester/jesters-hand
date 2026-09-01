---
name: Firestore counter integrity pattern
description: How denormalized counters are kept tamper-proof via rules, and how to run rules tests
---

## Rule pattern
Denormalized counters (e.g. ante post commentCount) must never be client-mutable on their own. The pattern used:
- Counter change on the parent requires a `countedCommentId` naming the child doc, verified with `exists`/`existsAfter` so the child actually appears (+1) or disappears (-1) in the same atomic batch.
- Child create/delete rules use `get`/`getAfter` on the parent to require the counter moved in lockstep.
- Child deletes are also allowed when `!existsAfter(parent)` — so post deletion sweeps orphan comments (delete the parent FIRST, then batch-delete children).
- Parent create must pin the counter to 0 and restrict `keys().hasOnly(...)`.

**Why:** completion review rejected partial fixes twice — enforcement must cover create-initialization, increment, decrement, and cleanup paths symmetrically or a tamper hole remains.

## Rules testing
- `jdk` installed as a Nix system dependency; Firestore emulator works.
- Run: `cd artifacts/jesters-hand && firebase emulators:exec --only firestore --project demo-rules-test "node scripts/rules-test.mjs"` (uses `@firebase/rules-unit-testing`).
- Rules deploy: `firebase deploy --only firestore:rules --project "$EXPO_PUBLIC_FIREBASE_PROJECT_ID" --token "$FIREBASE_TOKEN" --non-interactive`.
