---
name: Chamber decoder game
description: Decoder locks on Chamber entries are a client-side game gate, not access control — deliberate design.
---

**Rule:** The Chamber decoder (`decoderHash` on vault entries, unlocks stored at `users/{uid}.decodedJests.{entryId}`) is a scavenger-hunt GAME gate enforced only in the client UI. The hash is member-readable, storage still serves published files to any active member, and members can write their own `decodedJests` freely.

**Why:** Reviewed and accepted — the lock exists for fun (decode the Hidden Jest on the Jester's Ticket), not to protect content. Real protection would need server-side answer verification and storage gating.

**How to apply:** Don't "fix" this as a security bug unless the user asks for real access control. If they do, verification must move to api-server and storage rules must gate on the unlock. `lib/sha256.ts` holds a pure-JS sha256 (`decoderHashOf` normalizes: trim/lowercase/squeeze spaces) used for web+native parity — reuse it rather than adding a crypto dependency.
