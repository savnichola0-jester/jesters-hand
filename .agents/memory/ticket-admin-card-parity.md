---
name: Ticket admin-card parity
description: Prevents Hand-admin portrait fixes from covering only one of the two Ticket surfaces.
---

The personal Ticket and the Hand's member Ticket are separate user interfaces. The second portrait card must be interactive for either pinned Hand admin on both surfaces and locked for everyone else.

**Why:** A prior fix covered only the Hand member view while the personal Ticket's Admin card remained deliberately non-interactive, causing repeated apparent upload failures.

**How to apply:** When changing Ticket card behavior, verify both the signed-in member's own Ticket and a member Ticket opened through The Hand. Do not infer that shared backend helpers mean the controls are shared.

The Admin card is gallery-only. Do not reintroduce bundled card choices or a picker sheet; tapping the card as either active Hand admin opens the device gallery directly.

**Why:** The bundled-card path repeatedly failed to render the selected mark correctly on the installed Android app, while gallery uploads worked reliably.

**How to apply:** Keep gallery upload behavior identical on both Ticket surfaces, require active pinned-Hand authority, clear any legacy built-in ID after upload, and reject new built-in IDs in Firestore rules.