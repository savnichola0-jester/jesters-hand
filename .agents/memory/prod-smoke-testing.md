---
name: Production rules smoke testing
description: How to smoke-test deployed Firestore rules against the live project with throwaway accounts
---

Pattern for verifying live (deployed) Firestore rules behave like the emulator-tested repo rules:

0. **Drift check is now automated:** the `rules-drift-check` workflow (scripts/rules-drift-check.mjs) diffs deployed Firestore + Storage rulesets against the repo files and exits non-zero on drift. Run it before any live-rules smoke test. It caught undeployed storage.rules on first run.
1. **Check deploy drift first.** Fetch the released ruleset via the Firebase Rules REST API (`releases/cloud.firestore` → ruleset source) using the FIREBASE_TOKEN OAuth exchange, and diff (whitespace-normalized) against the repo `firestore.rules`. Rules edits verified in the emulator are NOT live until `firebase deploy --only firestore:rules` runs — this drift actually happened and made an "admin can resolve" prod check fail until deploy.
2. **Throwaway accounts, not real ones.** Identity Toolkit `accounts:signUp` (with the public API key) works on this project; each test account creates its own rules-conformant `users/{uid}` doc. To simulate the Jester, flip `isAdmin: true` on a throwaway's user doc via the owner OAuth token (rules forbid self-grant).
3. Evidence-path rules only validate path STRINGS, so a report can be filed in tests without uploading any Storage files.
4. **Clean up fail-safe:** delete report + user docs via owner token, delete auth accounts via `accounts:delete` with their own idToken, and verify docs return 404.

**Why:** emulator tests prove the rules text; only a live check proves what's actually deployed.
**How to apply:** any "confirm X on the live app" rules task — write a one-off node script using this recipe rather than touching real member accounts.
