---
name: Lock screen artwork
description: lockscreen.png bakes the poker-chip card into the background; how to swap backgrounds without regenerating the card.
---

**Rule:** The login screen's poker-chip card is baked into `assets/images/lockscreen.png` (874×1798) — there is no standalone card asset. Input positions in `app/(tabs)/index.tsx` are percentages of this image, so any replacement must keep 874×1798 and keep the card in place.

**How to swap the background:** crop the card at rect x57,y196 → 761×1460 (card right edge ≈818, bottom ≈1656; the card is not centered), apply a white-on-black rounded-rect mask (radius ~60) via ImageMagick `CopyOpacity`, and composite over the new background cover-cropped to 874×1798. Marble/black-lace swap done this way Aug 2026.

**Tooling:** no sharp in the repo; `magick` is on PATH. `magick montage` fails (no fonts) — build montages with `+append`/`-append`.
