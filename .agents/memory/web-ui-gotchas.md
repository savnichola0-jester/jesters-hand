---
name: React Native Web UI gotchas
description: Web no-op APIs and local icon set constraints that silently break UI in the browser
---

- **RN-web `Alert.alert` is a total no-op** — any option menu or confirm built on `Alert.alert(title, msg, buttons)` is dead on web. Use `lib/confirm.ts` helpers or an in-app Modal sheet (see the `webMenu` pattern in VaultFolderScreen).
  - **Why:** the Vault admin per-entry menu was unreachable in the browser; found during real-manuscript E2E verification.
  - **How to apply:** before relying on any button-list `Alert.alert` on web, give it a web branch. Other screens likely still have web-dead menus.
- **PanResponder drag handles need `touchAction: 'none'` on web** — without it, touch browsers (Android Chrome) hijack the drag for scroll/pull-to-refresh, making handles jumpy and gestures shoot across the screen. Disabling ScrollView `scrollEnabled` is NOT enough; the browser's native touch handling still fires.
  - **Why:** the Recruit editor's resize handle was reported "super touchy, expands across the whole screen" on Android Chrome.
  - **How to apply:** any View with `panHandlers` (and its selection overlay) gets `...(Platform.OS === 'web' ? { touchAction: 'none' } : {})` in its style.
- **`components/FIcon.tsx` is a local, hand-curated SVG glyph map** — a `<Feather name>` missing from `GLYPHS` renders `null` (invisible, zero-size touch target), with no type or runtime error. Whenever new icon names are introduced, add their SVG paths to GLYPHS and grep for dynamic `name={cond ? 'a' : 'b'}` uses, which literal-string greps miss.
