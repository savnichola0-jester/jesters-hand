---
name: Expo Go icon font loading
description: Why vector-icon fonts must never block or gate app render in this project
---
**Rule:** Never put `@expo/vector-icons` fonts (e.g. `...Feather.font`) into the blocking `useFonts` call in the root layout. Warm them up non-blocking via `Feather.loadFont().catch(() => {})` in a `useEffect` instead.

**Why:** The app runs in Expo Go through the Replit proxy; the icon .ttf download can fail transiently on device. When it was preloaded in the blocking `useFonts` call, a single failure set `fontError` and the app rendered with the icon font never registered — every icon app-wide showed as a missing-glyph box (▨). Lazy/background loading degrades gracefully: icons pop in when the font arrives.

**FINAL SOLUTION (July 2026):** Icon FONTS never rendered reliably on device in this Expo Go + Replit proxy + pnpm setup, even when the log confirmed the font loaded. The app now uses `components/FIcon.tsx` — an auto-generated react-native-svg icon set (Feather path data from feather-icons npm, MIT) exporting a drop-in `Feather` alias. All screens import Feather from '@/components/FIcon'; `_layout.tsx` loads no icon font at all. To add a new icon: fetch its entry from feather-icons `dist/icons.json` and append to GLYPHS. Do NOT reintroduce `@expo/vector-icons` font rendering.

**Update 2 (superseded):** @expo/vector-icons registers Feather under the LOWERCASE family name `feather` (see its build/Feather.js). Loading the ttf as `Feather` does nothing for the icons. Correct pattern in app/_layout.tsx: `Font.loadAsync({ feather: require('../assets/fonts/Feather.ttf') })` from a local copy, completed (or failed) before screens render so no icon component self-loads the pnpm-store copy first — a corrupt/mangled fetch of that copy registers a font whose every glyph is a tofu box.

**Update (root cause):** Even non-blocking loads of the default `@expo/vector-icons` .ttf failed on device — the file lives deep in the pnpm store (`node_modules/.pnpm/@expo+vector-icons@...`) whose `@`/`+` path characters Expo Go can mangle when fetching the asset, while curl through the proxy succeeds. Fix: copy the .ttf to `assets/fonts/Feather.ttf` and background-load it with `Font.loadAsync({ Feather: require(...) })`. Assets at clean in-app paths (assets/images, assets/fonts) load reliably.

**How to apply:** Any new icon family (Ionicons, MaterialCommunityIcons, …) gets the same background `loadFont()` treatment in `app/_layout.tsx`. If icons show as boxes on device but fine on web preview, suspect font delivery over the proxy, not the icon names.
