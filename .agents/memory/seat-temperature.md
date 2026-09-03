---
name: Whole-app seat temperature
description: Privacy, trust, and role boundaries for whole-app member activity scoring.
---

Seat temperature must be derived from canonical stored actions and server-written audit evidence. Never accept a client-reported “activity happened” event as scoring evidence.

**Why:** A self-reported event endpoint lets a member fabricate a Hot score even when the server owns the UID and timestamp. Pocket activity also carries sensitive relationship and content context that must not leak into summaries.

**How to apply:** Score bounded metadata-only timestamps from real sessions, messages, posts, comments, Ticket filing, Black Book entries, Deal evidence, and SUITS audit rows. Never return message bodies, recipients, conversation IDs, or source document paths. A member sees their own detail; either active pinned Hand admin sees permitted cross-member detail.

Login is recorded for context but has zero heat; login alone is Cold. Temperature follows total decayed meaningful activity (Hot at 50, Warm at 20), not category breadth. Client Deal progress must never substitute for an unavailable authoritative summary.

**Why:** Login and passive presence do not prove community participation, and a client fallback previously produced misleading temperatures.

**How to apply:** Use immutable creation/action timestamps, deduplicate canonical evidence, remove arbitrary query caps, and fail the summary closed if any required source cannot be read. Count Black Book/Royals for both owner and author without double-counting self-authored entries. Collection-group activity queries must stay metadata-only and backed by deployed indexes.

Per-icon heat in The Hand’s Activities view must use canonical, body-free actions—not client-reported screen opens. Pocket heat may use authored message/conversation timestamps and counts, but never message bodies, recipients, or conversation IDs.

**Why:** Client navigation telemetry can be forged, while canonical records prove meaningful feature use without exposing private content.

**How to apply:** Return every supported icon with Cold defaults so weak spots remain visible. Map real actions to their product icon separately from the trusted whole-seat score; keep cross-member icon detail exclusive to the two pinned Hand admins.

Unreported Pocket conversations remain private even from The Hand’s Investigation search. Show only that Pocket was used and when; do not provide an openable detail row, message/attachment content, recipients, or source identifiers. Reported evidence remains visible through the Reports workflow.

**Why:** The Investigation search is for behavioral awareness, not silent access to members’ personal conversations. Members choose what private evidence to disclose when they file a report.

**How to apply:** Sanitize Pocket records at the server response boundary and again in the client mapping. Preserve only usage timestamps, and keep those rows non-interactive in every investigation surface.