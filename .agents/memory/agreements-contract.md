---
name: Contract agreements gate
description: Living contract — contract/current doc, agreements sign/re-sign rules, fail-open loading, archives signing records, wipe manifest
---

- Contract wording lives in `contract/current` (heading, sections, acknowledgement, version). Bundled app text = version 1 fallback (`BUNDLED_CONTRACT` in contractService) when the doc is missing or unreadable — **fail open**. Only the admin can amend; rules force version to bump by exactly 1 (first amendment = 2), no delete.
- `agreements/{uid}` — one doc per member. Rules allow exactly two writes: first sign and a full re-sign, and the signed `version` must EQUAL the version currently in force (`contract/current`.version, else 1). **Why:** "version > previous" alone let a member pre-sign a huge version and dodge every future re-sign gate (architect-caught bypass). No in-place edits or deletes; wipes go through api-server.
- Gate: `needsContract` in AuthContext = signed-in, not admin, and (no agreement OR agreement.version < live contract version). Admin (00-00) never signs — contract screen shows view + Amend for them. Loading/read errors (`null`) never block — **fail open**; keep this invariant.
- `/contract` route is OUTSIDE `(tabs)` so the redirect can't loop; it subscribes LIVE to the contract doc so an amendment mid-screen can't cause signing at a stale version.
- Every signing files the agreement and its `contract_signed` archive record in one atomic batch. Rules allow only the signer’s own record when the agreement exists after the batch; restore refuses this record type.
- At filing time, read the current contract version from the server instead of trusting the screen listener. **Why:** a member may spend minutes reviewing/signing, and stale version data makes an honest re-sign fail.
- Amend publish broadcasts a `contract_update` notification + push ("The rules have changed.") to all users; routes to `/contract`.
- Push notification titles come from the contract's "NOTIFICATIONS — WHAT THEY MEAN" list — new notification types need a themed title consistent with that list.
- Gotcha (Aug 2026): archive `contract_signed` records carry only a display title (no uid/jokerId fields), so account wipes/purge sweeps can't find them — E2E reader signings lingered in Archives and had to be purged by title pattern via admin REST. If signing archives ever gain a uid field, add them to the wipe manifest.
