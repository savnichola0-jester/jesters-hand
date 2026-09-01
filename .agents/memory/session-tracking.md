---
name: Session tracking (Investigations)
description: Heartbeat-based login/logout tracking, multi-device status math, and suspension carve-out limits
---

Sessions live at `sessions/{uid}/logs/{id}` with {startedAt, lastActiveAt, endedAt|null}. Client writes: startSession on login, heartbeat every 60s + AppState changes, endSession on sign-out. A session with endedAt null but lastActiveAt older than 3 min is treated as ended-at-lastActiveAt (phone killed the app).

**Rules pattern:** admin-only read, create/update own with request.time-pinned timestamps, closed sessions immutable, no deletes. The suspension sign-out carve-out (`request.auth != null` instead of activeUser) must ALSO require `endedAt == request.time` — otherwise a suspended member can keep heartbeating to look active. **Why:** architect review caught this integrity gap.

**Multi-device math:** users can be signed in on several devices, so sessions overlap. "Currently active" = ANY live session; "offline since" = latest end across all sessions; suppress "logged out for X" gaps when the next login precedes this session's end (show "Another device was still logged in"). Never derive status from just the newest session.

**How to apply:** any new per-user activity collection must be added to the wipe manifest (memberAdmin wipeUser) + wipe-test roots/subMap, and its rules must honor the suspension gate with only a terminal-close carve-out.
