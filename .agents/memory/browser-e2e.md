---
name: Headless browser E2E harness
description: Durable lessons for driving the real Expo web app end-to-end in headless Chromium
---

- Full in-browser verification is possible: nix `chromium` + `puppeteer-core` in a throwaway /tmp dir, pointed at the Expo dev server's `$PORT`. Real test PDFs via `pdfkit` (`doc.outline.addItem` gives bookmark chapters; heading-only pages exercise the heuristic path).
- Use the prod-smoke throwaway-admin pattern for credentials (never real member accounts), and **always clean up everything** the run created — auth account, users doc, sessions, test content docs + subcollections, activity logs, and Storage objects — verified deleted via owner token. Leftover test accounts are a known user-visible complaint.
- Throwaway accounts can vanish mid-run (parallel wipe tests delete them); if login suddenly fails, recreate rather than debugging auth.
- **Why:** rules tests and typecheck prove contracts, but only a real browser run catches web-dead UI (see web-ui-gotchas).
