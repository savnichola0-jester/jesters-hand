---
name: Native install QR
description: Durable linking rule for physical QR engravings and the admin-downloadable app key.
---

The physical engraving QR and the admin APP KEY must encode the stable Jester's Hand `/install` URL. That route redirects to the current public Expo Android build page.

**Why:** Internal APK artifact URLs expire, while physical engravings cannot be changed. The previous QR opened the legacy web app and was no longer the product's distribution path.

**How to apply:** After a future native build, update only the server redirect target. Never regenerate physical QR artwork unless the permanent install domain itself changes.