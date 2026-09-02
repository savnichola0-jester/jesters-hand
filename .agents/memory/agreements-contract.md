---
name: Contract agreements gate
description: Living contract — contract/current doc, agreements sign/re-sign rules, fail-open loading, archives signing records, wipe manifest
---

- Contract wording lives in `contract/current` (heading, sections, acknowledgement, version). Bundled app text = version 1 fallback (`BUNDLED_CONTRACT` in contractService) when the doc is missing or unreadable — **fail open**. Only the admin can amend; rules force version to bump by exactly 1 (first amendment = 2), no delete.
- `agreements/{uid}` — one doc per member. Rules allow exactly two writes: first sign and a full re-sign, and the signed `version` must EQUAL the version currently in force (`contract/current`.version, else 1). **Why:** "version > previous" alone let a member pre-sign a huge version and dodge every future re-sign gate (architect-caught bypass). No in-place edits or deletes; wipes go through api-server.
- Gate: `needsContract` in AuthContext = signed-in, not admin, and (no agreement OR agreement.version < live contract version). Admin (00-00) never signs — contract screen shows view + Amend for them. Loading/read errors (`null`) never block — **fail open**; keep this invariant.
- `/contract` route is OUTSIDE `(tabs)` so the redirect can't loop; it subscribes LIVE to the contract doc so an amendment mid-screen can't cause signing at a stale version.
- Every signing files the agreement and its `contract_signed` archive record in one atomic batch. Rules allow only the signer’s own record when the agreement exists after the batch; restore refuses this record type.
- New signatures seal the exact wording snapshot in both the agreement and Contracts archive record. **Why:** immediate-previous wording is wrong when a signer skips multiple amendments; re-sign must show what that member actually signed before the current wording.
- At filing time, read the current contract version from the server instead of trusting the screen listener. **Why:** a member may spend minutes reviewing/signing, and stale version data makes an honest re-sign fail.
- Amend publish broadcasts a `contract_update` notification + push titled "Go sign in blood." to active members; routes to `/contract`.
- Contract amendments use an authenticated REST commit with a 15-second deadline and an update-time precondition. **Why:** the mobile Firestore SDK can leave a write pending indefinitely, trapping the Jester behind the publish spinner. Notification fan-out must start only after the commit and must never hold the saved screen open.
- Production contract rules intentionally remain on the legacy payload shape until the owner authorizes a rules deployment. Amendment writes must support both shapes: try history-preserving `previous`, then retry without it only on permission denial.
- The existing Firebase identity whose profile is both `jokerId == 00-00` and admin is the sole Jester authority. Never create or provision another `00-00` login.
- Push notification titles come from the contract's "NOTIFICATIONS — WHAT THEY MEAN" list — new notification types need a themed title consistent with that list.
- Contract signing archive records carry owner identity and the sealed wording/signature payload; the wipe manifest must continue removing them by owner UID.
