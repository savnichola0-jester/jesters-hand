---
name: Voice channel presence
description: Firestore heartbeat presence for Agora voice channels — stale sweep rules pattern
---

- Who-is-in-a-voice-channel lives at `voicePresence/{channelId}/members/{uid}` (jokerId, joinedAt, lastActiveAt) — Agora membership is invisible to clients outside the channel, so members announce their own seat on join, heartbeat lastActiveAt every 60s, delete on leave.
- **Rules pattern:** own-seat-only writes with all timestamps pinned to `request.time`; delete allowed for the owner OR anyone once `request.time > lastActiveAt + duration.value(3, 'm')` — so ghost seats after a dead connection are sweepable by any member but fresh entries can't be griefed.
- Clients filter by freshness too (hide entries silent >3 min) and opportunistically sweep on a 30s tick, since the seat owner may never come back to clean up.
- **How to apply:** any future ephemeral presence data should reuse this heartbeat + rules-verified stale-sweep shape; per-user presence docs are in the wipe manifest (channel parents are "missing" docs — enumerate with showMissing, like tableMessages).
