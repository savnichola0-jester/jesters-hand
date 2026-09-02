---
name: Whole-app seat temperature
description: Privacy, trust, and role boundaries for whole-app member activity scoring.
---

Seat temperature must be derived from canonical stored actions and server-written audit evidence. Never accept a client-reported “activity happened” event as scoring evidence.

**Why:** A self-reported event endpoint lets a member fabricate a Hot score even when the server owns the UID and timestamp. Pocket activity also carries sensitive relationship and content context that must not leak into summaries.

**How to apply:** Score bounded metadata-only timestamps from real sessions, messages, posts, comments, Ticket filing, Black Book entries, Deal evidence, and SUITS audit rows. Never return message bodies, recipients, conversation IDs, or source document paths. A member sees their own detail; exact active 00-00 sees other-member detail; 01-54 sees only the categorical temperature, with no score, counts, or timestamps.