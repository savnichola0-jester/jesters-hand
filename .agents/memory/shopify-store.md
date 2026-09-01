---
name: Shopify store connection
description: How the Armory's Shopify store is wired — relay endpoints, storefront client gotchas, checkout model
---

- Shopify Store connector is attached to this repl (dev "Vibe" store, unclaimed until the user accepts the transfer link). Connection is repl-scoped; do not recreate it.
- All buyer traffic goes through api-server relay routes (`/api/shopify/*`), member-authed with the same Firebase ID-token verify pattern as the push relay. Storefront token never reaches the device.
- **Gotcha:** `shopifyStorefrontRequest(query, variables)` takes the GraphQL variables object as the 2nd positional arg — wrapping it in `{ variables }` silently sends nothing and every query fails (caught in review once already).
- Checkout is Shopify-hosted via `cartCreate` → `cart.checkoutUrl`; never collect payment in-app. Dev/password-gated stores need `channel=online_store` appended to the checkout URL (relay does this when NODE_ENV !== production; must NOT apply on the live store).
- Admin catalog work (when stocking): `node artifacts/api-server/scripts/shopify-admin-api.mjs '<json>'` through the OpenInt proxy; follow the shopify skill's exact order for price/inventory/publish or stock is silently unenforced.
- In-app buy flow: Armory products match Shopify listings by admin-set `shopifyHandle` (stored lowercase; also allowed in firestore.rules) else exact normalized title (lib/shopifyService.ts). Matched + available → "CLAIM YOURS" button with variant chips; unmatched stays display-only ("issued, not sold"). Checkout URL opens via expo-web-browser.
- Store is deliberately kept unstocked until the user stocks it; a test product was created and deleted to verify the flow end-to-end.
- **Admin API 2026-04 gotchas:** `inventoryActivate` and `inventorySetQuantities` require a field-level `@idempotent(key: "...")` directive; `InventoryQuantityInput` no longer takes `compareQuantity`/`ignoreCompareQuantity` — it requires `changeFromQuantity` instead. Skill templates predate this.
