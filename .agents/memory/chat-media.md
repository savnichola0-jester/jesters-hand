---
name: Chat photo/GIF attachments
description: Whisper + Jester's Table image attachments — storage path, rules validation, immutability, known tradeoffs
---
- Messages carry optional `imageUrl`; uploads via lib/chatMediaService.ts → Storage `chatMedia/{uid}/{ts}.{ext}` (own folder, image/*, ≤10MB).
- Rules validate imageUrl on CREATE (https string ≤2048) and make it **immutable on update** in both collections; table message body edits are now sender-only (same split as whisper).
- **Why:** update paths otherwise bypass create-time validation, and table updates previously let any member rewrite anyone's text.
- Accepted tradeoff (documented, not a bug): chatMedia is readable by ANY signed-in member (download URLs are bearer URLs anyway).
- Attachment cleanup decision: whisper deletes (not archived) remove the file immediately; table deletes keep it until archive purge so restore keeps the photo working. **Why:** archive-first means files must survive while restorable.
- Bulk conversation teardown (last member leaves / orphan sweep) must go through the api-server teardown endpoint: attachments can live under OTHER members' folders the client can't delete. Server derives storage paths only from the message docs it deletes — never trust caller-supplied paths.
- Whisper preview/notification says "📷 Photo"/"sent you a photo." for image-only messages, incl. after delete-recompute.
