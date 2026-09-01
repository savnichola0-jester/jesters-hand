---
name: Vault reading circle (comments / reviews / reactions)
description: Durable safety and consistency rules for Vault discussion and manuscript annotations.
---

- **Rule:** every member read/write on discussion subcollections must be gated on the parent entry being published (admin exempt; orphan-sweep delete carve-out when parent `!existsAfter`). **Why:** hidden/archived chapters must be fully invisible — an entry ID must not leak discussion.
- **Rule:** archive/delete flows must preserve discussion and referenced files before removing live data, and fail loudly if that snapshot is incomplete. **Why:** silent partial archives permanently lose reader contributions.
- **Rule:** member wipes must remove that member's discussion/marks and recompute surviving counters/tallies. **Why:** deleting children without repairing aggregates leaves trusted counts false.
- **Rule:** whole-book reactions/reviews remain entry-level and separate from chapter/paragraph targets; the final-page verdict overrides the final chapter-end prompt. **Why:** reaching the manuscript's end must keep the established book-review flow.
- **Rule:** manuscript detection must use the same heading rules on web, iOS, and Android; native scans must have an enforced memory ceiling. **Why:** mobile curators need automatic maps without risking an out-of-memory crash.
- **Rule:** replacement PDFs must be scanned before publication, uploaded to immutable object names, and published by one pointer/metadata/map switch; Storage reads must honor only the live pointer. **Why:** even a stale reader snapshot must never pair new bytes with old chapter boundaries.
- **Rule:** never pre-create manuscript chapter/paragraph discussion records. Derive paragraph targets only for the rendered page window, and materialize Firestore data only after a member comments or marks. **Why:** a 500-page manuscript otherwise creates thousands of unused records and defeats the reader's three-page memory bound.
- **Rule:** annotation targets must resolve deterministically from document-space content/position; display scaling may move overlays but must never affect passage grouping or identity. **Why:** different reader sizes must land on the same sparse target without a server-side paragraph index.
- **Rule:** emoji marks have one deterministic identity per member and target, and empty marks do not persist. **Why:** per-user ownership is straightforward to secure and prevents duplicate or stale reactions.
