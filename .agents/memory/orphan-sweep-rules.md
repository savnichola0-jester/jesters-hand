---
name: Orphan sweep rules pattern
description: How to let clients sweep orphaned Firestore docs without opening a data-exposure hole
---

Letting any signed-in client read/delete "orphaned" docs (e.g. conversations with empty memberUids) for cleanup is only safe if rules ALSO make the orphan state unreachable going forward (e.g. updates may never empty the member list; the last member must delete instead).

**Why:** completion review rejected a sweep whose read allowance let a sole member self-orphan a chat, making its history world-readable.

**How to apply:** when adding a broad allowance keyed on a "dead" state, prove via rules tests that clients cannot transition a live doc into that state.
