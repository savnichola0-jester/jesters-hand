/**
 * Shopify storefront relay — lets the mobile app browse the store catalog
 * and open Shopify's hosted checkout without ever touching Shopify tokens
 * on the device.
 *
 * All endpoints require a verified Firebase ID token (members only), same
 * trust model as the push relay. The Storefront access token stays
 * server-side; checkout itself happens on Shopify's hosted page, so no
 * card data ever passes through this server or the app.
 *
 * GET  /api/shopify/status    → { connected, shopDomain }
 * GET  /api/shopify/products  → { products: [...] } (cached ~60s)
 * POST /api/shopify/checkout  → { checkoutUrl }
 *   Body: { lines: [{ variantId, quantity }] } (multi-line cart)
 *      or { variantId, quantity? }             (legacy single-item)
 */
import { Router, type IRouter } from "express";
import { verifyFirebaseIdToken } from "../lib/firebaseAuth";
import {
  shopifyStorefrontRequest,
  getShopifyStorefrontConfig,
} from "../lib/shopifyStorefrontClient";
import { logger } from "../lib/logger";
import { parseCheckoutLines } from "../lib/checkoutLines";

const router: IRouter = Router();

async function requireMember(
  req: { headers: { authorization?: string } },
): Promise<string | null> {
  const projectId = process.env["EXPO_PUBLIC_FIREBASE_PROJECT_ID"];
  if (!projectId) return null;
  const authHeader = req.headers.authorization ?? "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return idToken ? await verifyFirebaseIdToken(idToken, projectId) : null;
}

router.get("/shopify/status", async (req, res) => {
  const uid = await requireMember(req);
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  try {
    const cfg = await getShopifyStorefrontConfig();
    res.json({ connected: true, shopDomain: cfg.shopDomain });
  } catch (e) {
    logger.error({ err: e }, "shopify status check failed");
    res.json({ connected: false });
  }
});

// ── Product catalog (cached; Storefront API allows ~60 req/min/IP) ──────────
type CachedProducts = { at: number; products: unknown[] };
let productCache: CachedProducts | null = null;
const PRODUCT_CACHE_MS = 60_000;

const PRODUCTS_QUERY = `
  query ArmoryProducts($first: Int!) {
    products(first: $first) {
      nodes {
        id
        title
        handle
        description
        featuredImage { url altText }
        variants(first: 10) {
          nodes {
            id
            title
            availableForSale
            price { amount currencyCode }
          }
        }
      }
    }
  }
`;

router.get("/shopify/products", async (req, res) => {
  const uid = await requireMember(req);
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (productCache && Date.now() - productCache.at < PRODUCT_CACHE_MS) {
    res.json({ products: productCache.products });
    return;
  }
  try {
    const data = await shopifyStorefrontRequest<{
      products: { nodes: unknown[] };
    }>(PRODUCTS_QUERY, { first: 50 });
    productCache = { at: Date.now(), products: data.products.nodes };
    res.json({ products: productCache.products });
  } catch (e) {
    logger.error({ err: e }, "shopify products fetch failed");
    res.status(502).json({ error: "could not reach the store" });
  }
});

// ── Checkout: create a cart (one or more lines) and hand back Shopify's
//    hosted checkout URL. Payment is collected by Shopify, never by us. ─────
const CART_CREATE = `
  mutation CartCreate($lines: [CartLineInput!]!) {
    cartCreate(input: { lines: $lines }) {
      cart { id checkoutUrl }
      userErrors { field message }
    }
  }
`;

router.post("/shopify/checkout", async (req, res) => {
  const uid = await requireMember(req);
  if (!uid) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  // Accept either { lines: [{ variantId, quantity }] } (cart checkout) or
  // the legacy single-item shape { variantId, quantity? }. Validation and
  // duplicate-variant merging live in lib/checkoutLines (unit-tested).
  const parsed = parseCheckoutLines(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const lines = parsed.lines;
  try {
    const data = await shopifyStorefrontRequest<{
      cartCreate: {
        cart: { id: string; checkoutUrl: string } | null;
        userErrors: Array<{ message: string }>;
      };
    }>(CART_CREATE, { lines });
    const errs = data.cartCreate.userErrors;
    if (errs.length > 0 || !data.cartCreate.cart) {
      res.status(400).json({ error: errs[0]?.message ?? "cart failed" });
      return;
    }
    // Dev/preview stores are password-gated; `channel=online_store` lets the
    // buyer preview checkout. Harmless once the store is claimed and live.
    const url = new URL(data.cartCreate.cart.checkoutUrl);
    if (process.env["NODE_ENV"] !== "production") {
      url.searchParams.set("channel", "online_store");
    }
    res.json({ checkoutUrl: url.toString() });
  } catch (e) {
    logger.error({ err: e }, "shopify checkout create failed");
    res.status(502).json({ error: "could not start checkout" });
  }
});

export default router;
