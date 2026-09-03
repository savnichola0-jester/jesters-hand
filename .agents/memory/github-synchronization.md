---
name: GitHub synchronization
description: Safe source-sync method for this workspace when local and remote histories contain equivalent commits.
---

Synchronize GitHub through the installed GitHub connector’s Git Data API: build blobs and one tree from the current remote `main`, create one commit with that remote head as its parent, then advance the ref without force.

**Why:** Connector-created atomic commits can advance GitHub while the workspace retains equivalent changes under different local commit IDs. A normal rebase then tries to replay old local history and can create unrelated conflicts; direct HTTPS pushes may also lack a usable Git credential.

**How to apply:** Read the remote head first and use it as an optimistic concurrency check. Send all intended files in one tree/commit and update `refs/heads/main` with `force: false`. If the head moved, stop and rebuild against the new head rather than overwriting it.