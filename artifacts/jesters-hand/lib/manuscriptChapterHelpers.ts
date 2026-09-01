// Pure manuscript heading detection shared by the upload scanner and its
// focused regression test. No React Native, DOM, Firebase, or pdf.js imports.

const HEADING_RE = /^(chapter|prologue|epilogue|part|act|interlude|book)\b[\s.:\-—]*([ivxlc\d]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?|thirty(?:[-\s]\w+)?|forty(?:[-\s]\w+)?|fifty(?:[-\s]\w+)?)?\b/i;
const VOL_RE = /^(.{0,60}?)\bvol(?:\.|ume)?\s*([ivxlcdm]+)\.?$/i;
const ROMAN_RE = /^[ivxlcdm]+$/i;

export interface TextItemLike {
  str: string;
  /** pdf.js transform matrix; [4] = x, [5] = y (baseline). */
  transform?: number[];
}

export interface ManuscriptTextLine {
  y: number;
  x: number;
  text: string;
}

/**
 * Group raw text items into deterministically ordered lines. Items sharing a
 * baseline form a line, parts run left-to-right, and lines run page top-down.
 */
export function buildLines(items: TextItemLike[]): ManuscriptTextLine[] {
  const rows: { y: number; parts: { x: number; str: string }[] }[] = [];
  for (const it of items) {
    if (!it.str || !it.transform) continue;
    const y = it.transform[5];
    const x = it.transform[4];
    let row = rows.find(r => Math.abs(r.y - y) <= 2);
    if (!row) {
      row = { y, parts: [] };
      rows.push(row);
    }
    row.parts.push({ x, str: it.str });
  }
  return rows
    .sort((a, b) => b.y - a.y)
    .map(row => {
      const ordered = row.parts.slice().sort((a, b) => a.x - b.x);
      const text = ordered.map(part => part.str).join('').replace(/\s+/g, ' ').trim();
      return { y: row.y, x: ordered[0]?.x ?? 0, text };
    })
    .filter(line => line.text.length > 0);
}

/** Return the detected chapter title from the top lines of a page, or null. */
export function detectPageTitle(lines: ManuscriptTextLine[]): string | null {
  const top = lines.slice(0, 12).map(line => line.text);
  for (let i = 0; i < top.length; i++) {
    const line = top[i];
    const volume = matchVolume(line);
    if (volume) {
      const next = top[i + 1];
      if (next && isPlausibleSubtitle(next)) {
        return titleCase(`${volume} — ${next}`);
      }
      if (!isBodyText(line)) return titleCase(volume);
      continue;
    }
    if (line.length <= 60 && HEADING_RE.test(line) && !isBodyText(line)) {
      return titleCase(line);
    }
  }
  return null;
}

/** Normalize a "…Vol. <roman>" line, or null. Rejects obvious body text. */
export function matchVolume(line: string): string | null {
  if (isBodyText(line)) return null;
  const match = VOL_RE.exec(line.trim());
  if (!match || !ROMAN_RE.test(match[2])) return null;
  const name = match[1].trim().replace(/[\s.:\-—]+$/, '').trim();
  const roman = match[2].toUpperCase();
  return name ? `${name} Vol. ${roman}` : `Vol. ${roman}`;
}

function isPlausibleSubtitle(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 60 || isBodyText(value)) return false;
  return value.split(/\s+/).length <= 8;
}

function isBodyText(line: string): boolean {
  const value = line.trim();
  if (value.length > 80) return true;
  if (/[,;]$/.test(value)) return true;
  return value.split(/\s+/).length > 12;
}

function titleCase(value: string): string {
  if (value !== value.toUpperCase()) return value;
  return value.toLowerCase().replace(
    /(^|[\s\-—.:('"])(\p{L})/gu,
    (_, prefix, letter) => prefix + letter.toUpperCase(),
  );
}