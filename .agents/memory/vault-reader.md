---
name: Vault/Chamber document reader
description: Page-flip reader HTML (pdf.js/mammoth), sanitization requirement, contentType inference
---

The Vault/Chamber viewer (`components/vault/VaultViewer.tsx`, `buildReaderHtml`) generates a self-contained HTML reader with a shared page-flip engine (`window.__flip`, `#pageNo`, prev/next arrows, swipe, `__vaultGoto` postMessage):
- PDF via pdf.js (cdnjs), one canvas per page slot, renders current±1 only.
- DOCX via mammoth (cdnjs) → HTML → CSS-column pagination in `#flow`; text/* uses the same paginated path via `<pre>`.
- contentType is inferred from the file extension when the recorded type is missing/octet-stream.

**Rule: any HTML derived from user-uploaded files (mammoth output or similar) MUST pass the strict allowlist sanitizer in the generated reader before insertion.** The reader script has the short-lived Firebase token in scope, so unsanitized markup means token exfiltration.
**Why:** architect review found a hostile .docx could execute active markup; fixed with a DOMParser allowlist sanitizer (benign tags only, `data:image/` img srcs, table spans; everything else stripped).
**How to apply:** new file types added to the reader must route untrusted markup through `sanitizeHtml` in the generated script; only `textContent`/`<pre>` paths are exempt.

E2E flip verification recipe: seed a throwaway published entry via owner-token admin REST (title matching the E2E pattern so purge-testers can sweep leftovers), upload a real file to `vault/{id}/file` (pdf.js rejects hand-written PDFs — build with ImageMagick; minimal docx via python zipfile works with mammoth), flip via iframe `#next` + `#pageNo`, then delete doc + storage + vaultActivity rows.
