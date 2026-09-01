/**
 * Pure checkout-line parsing for POST /api/shopify/checkout.
 *
 * Accepts either the multi-line cart shape { lines: [{ variantId, quantity }] }
 * or the legacy single-item shape { variantId, quantity? }, validates every
 * line (gid prefix, integer quantity 1–20, at most 20 lines), and merges
 * duplicate variants (capped at 20 per variant) so Shopify doesn't reject
 * repeated lines.
 *
 * Kept free of Express/Shopify imports so it can be unit-tested in isolation
 * (see scripts/checkout-lines-test.mjs).
 */

export type CartLine = { merchandiseId: string; quantity: number };

export type ParseResult =
  | { ok: true; lines: CartLine[] }
  | { ok: false; error: string };

export const MAX_LINES = 20;
export const MAX_QUANTITY = 20;
const GID_PREFIX = "gid://shopify/ProductVariant/";

function isValidLine(l: unknown): l is { variantId: string; quantity?: unknown } {
  if (typeof l !== "object" || l === null) return false;
  const { variantId, quantity } = l as { variantId?: unknown; quantity?: unknown };
  const q = Number(quantity ?? 1);
  return (
    typeof variantId === "string" &&
    variantId.startsWith(GID_PREFIX) &&
    Number.isInteger(q) &&
    q >= 1 &&
    q <= MAX_QUANTITY
  );
}

export function parseCheckoutLines(body: unknown): ParseResult {
  const b = body as { lines?: unknown; variantId?: unknown; quantity?: unknown } | null | undefined;
  const rawLines: unknown = Array.isArray(b?.lines)
    ? b.lines
    : b?.variantId !== undefined
      ? [{ variantId: b.variantId, quantity: b?.quantity ?? 1 }]
      : null;
  if (
    !Array.isArray(rawLines) ||
    rawLines.length < 1 ||
    rawLines.length > MAX_LINES ||
    !rawLines.every(isValidLine)
  ) {
    return { ok: false, error: "invalid checkout lines" };
  }
  // Merge duplicate variants so Shopify doesn't reject repeated lines.
  const merged = new Map<string, number>();
  for (const l of rawLines) {
    const q = Number(l.quantity ?? 1);
    merged.set(l.variantId, Math.min(MAX_QUANTITY, (merged.get(l.variantId) ?? 0) + q));
  }
  const lines = [...merged.entries()].map(([merchandiseId, quantity]) => ({
    merchandiseId,
    quantity,
  }));
  return { ok: true, lines };
}
