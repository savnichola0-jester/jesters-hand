---
name: Agora live voice
description: Live voice channels in Jester's Table via Agora RTC — token relay pattern and Expo Go limits
---

# Agora live voice (Jester's Table)

- Token flow mirrors the push/shopify relay pattern: client sends Firebase ID token to api-server `POST /api/agora/token`; server (Agora `agora-token` pkg) issues a 1h RTC token bound to uid + channel. `AGORA_APP_ID` / `AGORA_APP_CERTIFICATE` are Replit secrets — certificate must never reach the client.
- **Why:** app-certificate-signed tokens are the only way to stop anyone with the App ID from joining channels.
- **Web-first (Aug 2026 pivot)**: the user ships the app as a browser / home-screen web app, NOT app stores. Voice engine is platform-split — `lib/voiceEngine.web.ts` (agora-rtc-sdk-ng) and `lib/voiceEngine.ts` (react-native-agora); `voiceService.ts` delegates. A runtime `Platform.OS` check is NOT enough: Metro statically bundles any require()'d module and react-native-agora can't even parse on web — the `.web.ts` file split is mandatory.
- Web SDK gotchas handled: `buildTokenWithUserAccount` tokens work with string uid in `client.join`; autoplay-blocked remote audio recovers via `AgoraRTC.onAutoplayFailed` + one-time tap listener; member count derives from `client.remoteUsers.length + 1` (local counters drift); intentional `leave()` must suppress the DISCONNECTED-triggered onEnded (guard flag) or teardown double-fires.
- Package firewall blocked agora-rtc-sdk-ng latest (transitive @agora-js/media 403); pinned 4.23.4 installs fine.
- **Expo Go cannot run react-native-agora** (native binary missing); web preview/browser now supports voice. Real mic/audio still needs a manual two-browser test.
- Session rule (architect-caught): switching away from a joined voice channel must deterministically hang up — otherwise the mic stays hot with no visible controls.
- Smoke test recipe: prod anonymous signUp is disabled (ADMIN_ONLY_OPERATION); use email+password signUp `smoke-*@jestershand.local` throwaway, hit the endpoint, then `accounts:delete` with the same idToken.
