---
name: Web export caching & +html gotchas
description: Why "fixed but user still sees old behavior" happens on the published web app, and the scroll-lock CSS location.
---

- The single-page Expo web export does NOT include `app/+html.tsx` — its custom CSS never ships. The document scroll lock (html/body overflow hidden, overscroll-behavior none, touch-action pan-x pan-y, #root lock) is therefore runtime-injected on web in `app/_layout.tsx`. Keep both in sync if editing.
- `server/serve.js` sets cache-control: `immutable` for hashed `/_expo/static/*`, `no-cache` for everything else (index.html, sw.js, icons, native manifest). **Why:** before this, HTML had no cache header → members' phones ran stale bundles after publishes, reporting already-fixed bugs as "still broken."
- **How to apply:** when a user reports a shipped fix "still not working" on the published app, first verify the live bundle (`curl` the entry JS, grep for a marker string) and reproduce with a throwaway account on the production URL before assuming the code is wrong. This exact false alarm happened with the bell dropdown (worked live; user's device was stale).
