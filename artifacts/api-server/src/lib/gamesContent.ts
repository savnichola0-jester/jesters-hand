import { createHash } from "node:crypto";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Game content must be JSON serializable.");
  return serialized;
}

export function gameEntryHash(entry: unknown): string {
  return createHash("sha256").update(canonical(entry), "utf8").digest("hex");
}

export function matchingReviewStatus(status: unknown, savedHash: unknown, currentHash: string): string {
  if (savedHash !== currentHash) return "draft";
  if (status === "approved" || status === "removed") return status;
  return "draft";
}

/** Author-supplied banks are playable by default; a saved admin decision always takes priority.
 * A stale decision on changed content makes it a draft instead of silently approving a revision.
 */
export function effectiveReviewStatus(bundledStatus: unknown, savedStatus: unknown, savedHash: unknown, currentHash: string): string {
  if (savedStatus !== undefined || savedHash !== undefined) {
    return matchingReviewStatus(savedStatus, savedHash, currentHash);
  }
  return bundledStatus === "approved" ? "approved" : "draft";
}