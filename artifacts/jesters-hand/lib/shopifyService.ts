// ── Shopify service ───────────────────────────────────────────────────────────
// Buy-online support for the Armory. All Shopify traffic goes through the
// member-authenticated api-server relay (/api/shopify/*) — the Storefront
// token never reaches the device, and checkout itself happens on Shopify's
// hosted page (no card entry in-app).
//
// Armory products (Firestore) are matched to Shopify products by a stored
// `shopifyHandle` when the admin has set one, else by normalized title.

import { auth } from './firebase';
import { getApiDomain } from './apiConfig';

export interface ShopifyVariant {
  id: string;                 // gid://shopify/ProductVariant/…
  title: string;              // e.g. "Small" — "Default Title" for single-variant
  availableForSale: boolean;
  price: { amount: string; currencyCode: string };
}

export interface ShopifyProduct {
  id: string;
  title: string;
  handle: string;
  description: string;
  featuredImage?: { url: string; altText?: string } | null;
  variants: { nodes: ShopifyVariant[] };
}

async function relayFetch(path: string, init?: RequestInit): Promise<Response> {
  const domain = getApiDomain();
  const idToken = await auth.currentUser?.getIdToken();
  if (!domain || !idToken) throw new Error('Not signed in.');
  return fetch(`https://${domain}/api/shopify/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
      ...(init?.headers ?? {}),
    },
  });
}

/** Fetch the store catalog through the relay (server caches ~60s). */
export async function fetchShopifyProducts(): Promise<ShopifyProduct[]> {
  const res = await relayFetch('products');
  if (!res.ok) throw new Error('Could not reach the store.');
  const data = (await res.json()) as { products?: ShopifyProduct[] };
  return data.products ?? [];
}

export interface CheckoutLine {
  variantId: string;
  quantity: number;
}

/**
 * Start a Shopify-hosted checkout for one or more cart lines. Returns the
 * URL to open in the device browser.
 */
export async function createShopifyCheckout(
  lines: CheckoutLine[],
): Promise<string> {
  if (lines.length === 0) throw new Error('Nothing to check out.');
  const res = await relayFetch('checkout', {
    method: 'POST',
    body: JSON.stringify({ lines }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    checkoutUrl?: string; error?: string;
  };
  if (!res.ok || !data.checkoutUrl) {
    throw new Error(data.error ?? 'Could not start checkout.');
  }
  return data.checkoutUrl;
}

const normalizeTitle = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Match an Armory product to a Shopify product: a stored handle wins, else
 * an exact (case/whitespace-insensitive) title match.
 */
export function matchShopifyProduct(
  armory: { name: string; shopifyHandle?: string },
  catalog: ShopifyProduct[],
): ShopifyProduct | null {
  const handle = armory.shopifyHandle?.trim().toLowerCase();
  if (handle) return catalog.find(p => p.handle === handle) ?? null;
  const name = normalizeTitle(armory.name);
  return catalog.find(p => normalizeTitle(p.title) === name) ?? null;
}

/**
 * Format a variant price for display, e.g. "$45" / "$45.50" for USD, or
 * "45.50 CAD" for other currencies.
 */
export function formatVariantPrice(price: ShopifyVariant['price']): string {
  const n = Number(price.amount);
  if (!Number.isFinite(n)) return price.amount;
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return price.currencyCode === 'USD' ? `$${amount}` : `${amount} ${price.currencyCode}`;
}

/**
 * True when an admin-typed display price (e.g. "$45") matches a variant's
 * live store price numerically. Non-numeric display prices never "match".
 */
export function displayPriceMatches(
  displayPrice: string,
  price: ShopifyVariant['price'],
): boolean {
  const typed = Number(displayPrice.replace(/[^0-9.]/g, ''));
  const live = Number(price.amount);
  return Number.isFinite(typed) && Number.isFinite(live) && Math.abs(typed - live) < 0.005;
}

/** Variants a member can actually buy. */
export function purchasableVariants(p: ShopifyProduct): ShopifyVariant[] {
  return p.variants?.nodes?.filter(v => v.availableForSale) ?? [];
}
