---
name: Social wall integrity
description: Security and lifecycle invariants for themed posts, comments, reactions, and RSVP records.
---

The app's themed walls use one integrity model: reaction maps may change only for the signed-in member's UID, and a comment is created atomically with an exactly-one parent counter increase tied to that new comment.

**Why:** Social interaction data is shared and user-generated. Unrestricted map or counter updates let a member impersonate others, forge popularity, or create drift between visible threads and parent totals.

**How to apply:** Any new wall should use server timestamps, published-parent gates where drafts exist, per-user child documents for private choices such as RSVP, archive child snapshots before parent deletion, and permanent-wipe cleanup for authored children plus UID references inside surviving reaction maps.