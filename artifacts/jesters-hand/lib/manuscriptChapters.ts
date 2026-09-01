// ── Manuscript chapter detection (web implementation) ────────────────────────
// When the Jester uploads a whole manuscript PDF, we scan it for chapter
// boundaries so readers can move through the book chapter by chapter:
//   1. If the PDF carries a built-in outline (bookmarks), use that.
//   2. Otherwise scan the top of each page for heading-looking lines
//      ("Chapter One", "PROLOGUE", "Part II", …) or a two-line volume title
//      ("Izzy Vol. I" followed by "Before" → "Izzy Vol. I — Before").
// Detection is best-effort — the admin can always correct the list in the
// upload form. Native uploads use the companion hidden-WebView scanner, which
// feeds extracted page items through the same pure heading helpers.

import type { VaultChapter } from './vaultService';
import {
  buildLines,
  detectPageTitle,
  type TextItemLike,
} from './manuscriptChapterHelpers';

export {
  buildLines,
  detectPageTitle,
  type ManuscriptTextLine,
  type TextItemLike,
} from './manuscriptChapterHelpers';

const PDFJS_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pdfjsLoading: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  const w = window as any;
  if (w.pdfjsLib) return Promise.resolve(w.pdfjsLib);
  if (!pdfjsLoading) {
    pdfjsLoading = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = PDFJS_SRC;
      el.onload = () => {
        try {
          w.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
          resolve(w.pdfjsLib);
        } catch (e) { reject(e); }
      };
      el.onerror = () => { pdfjsLoading = null; reject(new Error('pdf.js failed to load')); };
      document.head.appendChild(el);
    });
  }
  return pdfjsLoading;
}

/** How the chapter list was produced, for callers that want to show provenance. */
export type ScanSource = 'outline' | 'headings' | 'none';

export interface ManuscriptScan {
  numPages: number;
  chapters: VaultChapter[];
  /** Where the chapter list came from ('none' when nothing was detected). */
  source: ScanSource;
  /** 0–1 rough confidence the detected list is meaningful. */
  confidence: number;
}

export type ManuscriptScanResult = ManuscriptScan;

/**
 * Scan a picked PDF (local blob/file URI) for chapters.
 * Returns null when detection isn't possible (non-PDF or load failure).
 */
export async function detectManuscriptChapters(localUri: string): Promise<ManuscriptScan | null> {
  try {
    const pdfjs = await loadPdfJs();
    const buf = await (await fetch(localUri)).arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;

    // 1) Built-in outline (bookmarks) — the author's own chapter map.
    const fromOutline = await outlineChapters(pdf);
    if (fromOutline && fromOutline.length >= 2) {
      return {
        numPages: pdf.numPages,
        chapters: fromOutline,
        source: 'outline',
        confidence: 0.95,
      };
    }

    // 2) Heading heuristic on page text (geometry-ordered lines).
    const chapters: VaultChapter[] = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const lines = buildLines(content.items as TextItemLike[]);
      const title = detectPageTitle(lines);
      if (title) chapters.push({ title, startPage: p });
      page.cleanup?.();
    }
    return {
      numPages: pdf.numPages,
      chapters,
      source: chapters.length ? 'headings' : 'none',
      // More detected chapters over more pages → higher confidence, capped.
      confidence: chapters.length ? Math.min(0.9, 0.4 + chapters.length * 0.05) : 0,
    };
  } catch {
    return null;
  }
}

async function outlineChapters(pdf: any): Promise<VaultChapter[] | null> {
  try {
    const outline = await pdf.getOutline();
    if (!outline?.length) return null;
    const chapters: VaultChapter[] = [];
    for (const item of outline) { // top level only — those are the chapters
      if (!item?.title) continue;
      let dest = item.dest;
      if (typeof dest === 'string') dest = await pdf.getDestination(dest);
      if (!Array.isArray(dest) || !dest[0]) continue;
      const pageIndex = await pdf.getPageIndex(dest[0]);
      chapters.push({ title: String(item.title).trim(), startPage: pageIndex + 1 });
    }
    return chapters.length ? chapters : null;
  } catch {
    return null;
  }
}
