---
name: Phone-width web shell
description: Desktop web renders the app in a centered 430px column; all layout math must use capped dims
---
The web app renders inside a centered phone-width column (`PhoneShell` in `app/_layout.tsx`, max width `APP_MAX_W` in `lib/appWindow.ts`).

**Rules:**
- Never use `Dimensions.get('window')` or `useWindowDimensions()` for layout — use `appWindow()` / `useAppDimensions()` from `@/lib/appWindow`, which cap width on web. Raw window dims break every frame/panel calculation on desktop.
- RN-web `Modal` portals to `document.body`, OUTSIDE the shell. Any full-sheet modal must re-apply the cap itself: full-viewport dim backdrop + inner `width:'100%', maxWidth: APP_MAX_W, alignSelf/alignItems center` column (see VaultViewer). Framed card modals that size from capped `appWindow()` and center themselves are fine.
- Overlays from context providers must live INSIDE `PhoneShell` (FileTransitionProvider is nested inside it deliberately).

**Frame artwork:** the bronze frames (table_panel, whisper_frame, ante_card_frame) are 1024×1536 and must render at native 1.5 aspect — never stretch. When height-clamped, shrink width to match and center horizontally. Inner-region inset percentages live as constants in table.tsx / chat.tsx / ante.tsx / ReportCardModal.tsx; if artwork changes, re-measure with a gridline-overlay probe image (magick draw red/cyan lines every 10%).
