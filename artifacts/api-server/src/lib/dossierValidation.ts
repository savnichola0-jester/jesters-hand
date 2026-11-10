import { validateMediaPath } from "./mediaPaths";

const DOTS = ["navy", "burgundy", "yellow", "orange", "green"];
const FIELDS = ["target", "suit", "evidence", "connections", "contradictions", "confidence"];
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const text = (value: unknown, max = 30000): value is string => typeof value === "string" && value.length <= max;
const number = (value: unknown, low = -100000, high = 100000) =>
  typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const dot = (value: unknown) => value == null || DOTS.includes(value as string);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Only portable private pointers, never public download URLs or embedded image data. */
export function dossierPhotoOwnedBy(value: unknown, uid: string): boolean {
  if (typeof value !== "string" || !value.startsWith("dossier://")) return false;
  const parsed = validateMediaPath(value.slice("dossier://".length));
  return parsed?.kind === "dossier-photo" && parsed.uid === uid;
}

export function parseDossierDocument(raw: string, uid: string): Record<string, unknown> {
  if (raw.length > 500000) throw new Error("Dossier is too large.");
  const d: unknown = JSON.parse(raw);
  if (!record(d) || !text(d.title, 120) || !text(d.target) || !text(d.connections) || !text(d.contradictions)
    || !["spade", "diamond", "heart", "club"].includes(String(d.suit))
    || !number(d.confidence, 0, 5) || !record(d.fieldDots)) throw new Error("Invalid dossier fields.");
  if (Object.entries(d.fieldDots).some(([key, value]) => !FIELDS.includes(key) || !DOTS.includes(String(value)))) {
    throw new Error("Invalid field status.");
  }
  if (!Array.isArray(d.evidence) || d.evidence.length > 200
    || d.evidence.some(e => !record(e) || !text(e.text) || !text(e.source, 2000))) throw new Error("Invalid evidence.");
  const spread = d.spread;
  if (!record(spread) || !Array.isArray(spread.elements) || spread.elements.length > 250
    || !Array.isArray(spread.connectors) || spread.connectors.length > 500
    || !number(spread.panX) || !number(spread.panY) || !number(spread.zoom, 0.1, 5)) throw new Error("Invalid evidence canvas.");
  const ids = new Set<string>();
  for (const e of spread.elements) {
    if (!record(e) || !identifier(e.id) || ids.has(e.id)
      || !["note", "clipping", "photo", "document", "fingerprint"].includes(String(e.kind))
      || !number(e.x) || !number(e.y) || !number(e.w, 1, 10000) || !number(e.h, 1, 10000)
      || !number(e.rot) || !number(e.z, 0) || !dot(e.dot)
      || (e.text !== undefined && !text(e.text)) || (e.text2 !== undefined && !text(e.text2))
      || (e.uri !== undefined && !dossierPhotoOwnedBy(e.uri, uid))) throw new Error("Invalid canvas element or private photo.");
    ids.add(e.id);
  }
  const connectorIds = new Set<string>();
  for (const c of spread.connectors) {
    if (!record(c) || !identifier(c.id) || connectorIds.has(c.id)
      || !ids.has(String(c.fromId)) || !ids.has(String(c.toId)) || !dot(c.dot)) throw new Error("Invalid evidence connection.");
    connectorIds.add(c.id);
  }
  return d;
}
