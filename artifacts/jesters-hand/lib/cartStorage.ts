// ── Cart storage ──────────────────────────────────────────────────────────────
// Persists the Armory cart per member (AsyncStorage keyed by uid) so picked
// items survive navigating away and app restarts. Purely local device state —
// nothing here touches Firestore or Shopify.

import AsyncStorage from '@react-native-async-storage/async-storage';

export type CartLine = {
  variantId: string;
  quantity: number;
  productName: string;
  variantTitle: string;   // '' when the product has no real options
  price: string;          // formatted, e.g. "$45.00"
  // Set when the live-price refresh changed this line's price so the cart
  // can flag it; cleared after the member has seen the cart.
  priceChanged?: boolean;
};

const keyFor = (uid: string) => `armoryCart:${uid}`;

const isCartLine = (l: any): l is CartLine =>
  !!l &&
  typeof l.variantId === 'string' && l.variantId.length > 0 &&
  typeof l.quantity === 'number' && Number.isInteger(l.quantity) &&
  l.quantity >= 1 && l.quantity <= 20 &&
  typeof l.productName === 'string' &&
  typeof l.variantTitle === 'string' &&
  typeof l.price === 'string' &&
  (l.priceChanged === undefined || typeof l.priceChanged === 'boolean');

/** Load the saved cart for a member. Malformed / unreadable data → empty cart. */
export async function loadCart(uid: string): Promise<CartLine[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(uid));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop malformed lines and de-dupe by variant, keeping the first.
    const seen = new Set<string>();
    const lines: CartLine[] = [];
    for (const l of parsed) {
      if (isCartLine(l) && !seen.has(l.variantId)) {
        seen.add(l.variantId);
        lines.push(l);
      }
    }
    return lines;
  } catch {
    return [];
  }
}

/** Persist the cart (best-effort — a write failure never breaks the UI). */
export async function saveCart(uid: string, lines: CartLine[]): Promise<void> {
  try {
    if (lines.length === 0) await AsyncStorage.removeItem(keyFor(uid));
    else await AsyncStorage.setItem(keyFor(uid), JSON.stringify(lines));
  } catch {
    // best-effort
  }
}
