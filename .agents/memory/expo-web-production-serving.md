---
name: Expo web production serving
description: Production deploy must export and serve the web build; the default static server only served the Expo Go QR landing page to browsers
---

- **The production build/server pair (`scripts/build.js` + `server/serve.js`) originally served ONLY the Expo Go QR landing page to browsers** — every visitor to the published domain saw "Download Expo Go / Scan QR" instead of the app, on phone and laptop alike.
  - **Why:** the app is web-first; members must use it in the browser. Fixed by adding `expo export --platform web` into `static-build/web` at the end of build.js (fails the build if index.html missing) and serving that for browser requests, with SPA fallback for extensionless deep links. The QR landing page moved to `/expo-go`; `expo-platform: ios|android` manifest routes unchanged.
  - **How to apply:** any change to build.js/serve.js must keep the web export + browser routing intact. Local test build: mockup-sandbox squats on port 8081, so run with `METRO_PORT=8090`. Background `node scripts/build.js` runs die when the shell session closes (signal handlers fire) — run heavy steps in foreground.
- **`document.fonts.check()` returns true for UNKNOWN font families** (fallback counts as available) — a headless "are fonts loaded on prod" probe gave a false positive while prod was actually serving the QR page. Verify page identity (grep for app-specific markup) before trusting font/asset probes.
