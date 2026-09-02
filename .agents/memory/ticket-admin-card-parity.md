---
name: Ticket admin-card parity
description: Prevents fixes to the 00-00-only admin portrait from covering only one of the two Ticket surfaces.
---

The personal Ticket and the Hand's member Ticket are separate user interfaces. The second portrait card must be interactive for exact `00-00` on both surfaces and locked for everyone else.

**Why:** A prior fix covered only the Hand member view while the personal Ticket's Admin card remained deliberately non-interactive, causing repeated apparent upload failures.

**How to apply:** When changing Ticket card behavior, verify both the signed-in member's own Ticket and a member Ticket opened through The Hand. Do not infer that shared backend helpers mean the controls are shared.