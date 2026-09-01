---
name: Archives soft-delete safety net
description: How deletes are archived, restore/purge invariants, and the admin verbatim-create rules carve-out
---
- Every delete flow (ante, tickets+comments, table messages, black book, recruit, vault, armory, reports) archives FIRST via `archiveItem()` (throws → aborts delete). Whispers/conversations, mugshots, locker records deliberately excluded. New delete flows MUST follow the same archive-first pattern.
- Storage files are RETAINED on delete (no deleteObject in delete flows) and purged only via `purgeArchive`. **Why:** files must stay recoverable while archived.
- Restore is all-or-nothing: parent + child comments + archive-record delete in ONE writeBatch; comment-only restores mirror the counter batch (`commentCount` increment + `countedCommentId`). Never restore piecewise — a partial restore that deletes the archive record loses data.
- Ticket spread photos are stored as download URLs, not raw paths — `extractStoragePaths` must decode `/o/…%2F…` URL forms or purge misses those files.
- firestore.rules: `(activeUser() && isAdmin()) ||` create carve-outs exist on antePosts posts/comments, targetTickets/comments, tableMessages, blackBook, reports so the sole-owner admin can recreate others' content verbatim (author, dates, counters). Two old "admin cannot forge" tests were deliberately flipped. Don't "fix" these back.
- storage.rules: admin `delete` allowed on targetTickets/vault/recruitPosts/armoryProducts paths solely for archive purge.
- wipeUser sweeps `archives` by JSON-matching the uid anywhere in fields (owner, deleter, payload refs).
