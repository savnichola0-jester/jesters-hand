---
name: Firestore orphan subcollection enumeration
description: Why client collection-group reads can't find parentless docs, and the admin approach that works
---

A collection-group query allowance gated on `!exists(parent)` can never pass Firestore rules: query rules must be provable without evaluating per-document paths, so the query is rejected regardless of how the allowance is written. Per-document deletes of parentless docs can still be rule-allowed — only enumeration is blocked.

**How to enumerate orphans (admin):** list the parent collection via REST with `showMissing=true`; "missing" entries (name but no createTime) are deleted parents whose subcollections still hold data. Then list/delete each missing parent's subcollection docs. See `artifacts/jesters-hand/scripts/cleanup-orphan-messages.mjs` for a working script (exchanges FIREBASE_TOKEN for an OAuth access token using the public firebase-tools CLI client credentials — those are embedded in the open-source CLI, not secrets).
