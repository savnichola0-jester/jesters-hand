// ── Uniform screen ────────────────────────────────────────────────────────────
// Member-only merchandise store — "The Armory". Not a public shop: every
// visitor is already a recruited member, so the experience reads like
// officially issued attire and equipment rather than retail.
//
// Three views inside the same folder chrome used by Vault / Chamber / Recruit:
//   • Landing  — title, tagline, Enter the Armory / View Issued Equipment
//   • Armory   — issued-equipment catalog grouped by category, plus the
//                "Issued Artifacts" featured collection. Products are stocked
//                by the admin (Firestore `armoryProducts`, admin-only writes);
//                photos live in private Storage fetched with the caller's ID
//                token — never a public/tokenized URL.
//   • Locker   — Issue Locker: personal record of everything issued
//                (issuedItems/{uid}/records — admin writes, owner reads)

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Image, ScrollView,
  Platform, Modal, ActivityIndicator, Alert, KeyboardAvoidingView, Switch,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { useAuth } from '@/contexts/AuthContext';
import { getAllMembers } from '@/lib/ticketService';
import {
  LOCKER_KINDS, LockerKind, IssuedRecord,
  listenIssuedRecords, issueItem, deleteIssuedRecord, formatIssuedTimestamp,
} from '@/lib/issuedService';
import { confirmAction, showAlert } from '@/lib/confirm';
import {
  ArmoryCategory, ArmoryProduct, ArmoryPhotoPick, ARMORY_CATEGORIES,
  listenArmoryProducts, addArmoryProduct, updateArmoryProduct, deleteArmoryProduct,
} from '@/lib/armoryService';
import { fetchProtectedImage, ProtectedImageHandle } from '@/lib/vaultService';
import * as WebBrowser from 'expo-web-browser';
import {
  ShopifyProduct, fetchShopifyProducts, createShopifyCheckout,
  matchShopifyProduct, purchasableVariants, formatVariantPrice, displayPriceMatches,
} from '@/lib/shopifyService';
import { CartLine, loadCart, saveCart } from '@/lib/cartStorage';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 40;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

type ArmoryView = 'landing' | 'armory' | 'locker';

// Display names for equipment categories. Products are stored with
// retail-style category values; map them here instead of changing the data.
export const CATEGORY_DISPLAY: Record<string, string> = {
  Apparel: 'Uniforms',
  Accessories: 'Issued Gear',
  Books: 'Issued Books',
  'Art Prints': 'Archives',
  Other: 'Additional Equipment',
};

const CATEGORIES: { key: ArmoryCategory; label: string; icon: string }[] = [
  // Icon names must exist in the local Feather shim (components/FIcon.tsx).
  { key: 'Apparel',     label: CATEGORY_DISPLAY.Apparel,       icon: 'user' },
  { key: 'Accessories', label: CATEGORY_DISPLAY.Accessories,   icon: 'award' },
  { key: 'Books',       label: CATEGORY_DISPLAY.Books,         icon: 'file-text' },
  { key: 'Art Prints',  label: CATEGORY_DISPLAY['Art Prints'], icon: 'image' },
  { key: 'Other',       label: CATEGORY_DISPLAY.Other,         icon: 'check-square' },
];

type MemberLite = { uid: string; label: string };

// ── Protected product photo ───────────────────────────────────────────────────
// Pulls its image through authenticated Storage (no public URL) and releases
// the backing temp file / object URL when unmounted.
function ProductPhoto({ path, style }: { path?: string; style: any }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    setUri(null);
    if (!path) return;
    let alive = true;
    let handle: ProtectedImageHandle | null = null;
    fetchProtectedImage(path, 'image/jpeg')
      .then(h => {
        if (!alive) { h.release(); return; }
        handle = h;
        setUri(h.uri);
      })
      .catch(() => {});
    return () => { alive = false; handle?.release(); };
  }, [path]);
  if (!path) {
    return (
      <View style={[style, st.photoFallback]}>
        <Feather name="image" size={20} color="rgba(212,168,83,0.4)" />
      </View>
    );
  }
  if (!uri) {
    return (
      <View style={[style, st.photoFallback]}>
        <ActivityIndicator size="small" color="rgba(212,168,83,0.5)" />
      </View>
    );
  }
  return <Image source={{ uri }} style={style} resizeMode="cover" {...(Platform.OS === 'web' ? { draggable: false } : {})} />;
}

interface FormState {
  productId: string | null;        // null = new product
  name: string;
  price: string;
  category: ArmoryCategory;
  description: string;
  artifact: boolean;
  photo: ArmoryPhotoPick | null;   // newly picked photo (replaces existing)
  existingPhotoPath?: string;
  shopifyHandle: string;           // optional Shopify handle for buy-online matching
}

const emptyForm = (): FormState => ({
  productId: null, name: '', price: '', category: 'Apparel',
  description: '', artifact: false, photo: null, shopifyHandle: '',
});

export default function UniformScreen() {
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;
  const params = useLocalSearchParams<{ view?: string }>();
  // Deep link (e.g. issued-item notification) can open a specific view.
  const paramView = typeof params.view === 'string' ? params.view : undefined;
  const [view, setView] = useState<ArmoryView>(
    paramView && (['armory', 'locker'] as string[]).includes(paramView)
      ? (paramView as ArmoryView)
      : 'landing',
  );
  useEffect(() => {
    if (paramView && (['armory', 'locker'] as string[]).includes(paramView)) {
      setView(paramView as ArmoryView);
    }
  }, [paramView]);
  const { user, isAdmin } = useAuth();

  // ── Armory: product catalog ──
  const [products, setProducts] = useState<ArmoryProduct[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    return listenArmoryProducts(setProducts, () => {});
  }, [user]);

  // Category filter pills + fold-open folder cards
  const [catFilter, setCatFilter] = useState<'all' | ArmoryCategory>('all');
  const [openProductId, setOpenProductId] = useState<string | null>(null);

  const artifacts = products.filter(p => p.artifact);
  const filteredArtifacts = catFilter === 'all'
    ? artifacts
    : artifacts.filter(p => p.category === catFilter);
  const byCategory = (key: ArmoryCategory) =>
    products.filter(p => !p.artifact && p.category === key);
  const visibleCategories = catFilter === 'all'
    ? CATEGORIES
    : CATEGORIES.filter(c => c.key === catFilter);

  const openAdd = () => setForm(emptyForm());
  const openEdit = (p: ArmoryProduct) => setForm({
    productId: p.id, name: p.name, price: p.price, category: p.category,
    description: p.description ?? '', artifact: p.artifact, photo: null,
    existingPhotoPath: p.photoPath, shopifyHandle: p.shopifyHandle ?? '',
  });

  // ── Shopify buy-online support ──
  // The store catalog comes through the member-authed api-server relay; a
  // product that matches a Shopify listing (stored handle or exact title)
  // gets a buy button; everything else stays display-only ("issued, not
  // sold"). Catalog fetch is best-effort — if the store is unreachable the
  // Armory simply shows no buy buttons.
  const [shopCatalog, setShopCatalog] = useState<ShopifyProduct[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Record<string, string>>({});
  const [buyingProductId, setBuyingProductId] = useState<string | null>(null);
  useEffect(() => {
    if (view !== 'armory' || !user) return;
    let alive = true;
    fetchShopifyProducts()
      .then(list => { if (alive) setShopCatalog(list); })
      .catch(() => {});
    return () => { alive = false; };
  }, [view, user]);

  const startCheckout = async (p: ArmoryProduct, variantId: string) => {
    if (buyingProductId) return;
    setBuyingProductId(p.id);
    try {
      const url = await createShopifyCheckout([{ variantId, quantity: 1 }]);
      await WebBrowser.openBrowserAsync(url);
    } catch (e: any) {
      showAlert('Checkout unavailable', e?.message ?? 'Could not start checkout.');
    } finally {
      setBuyingProductId(null);
    }
  };

  // ── In-app cart ──
  // Cart so a member can claim several items in one Shopify checkout. Lines
  // are keyed by variant; adding the same variant again bumps the quantity.
  // Persisted per member (AsyncStorage) so it survives navigating away and
  // app restarts. Payment still happens only on Shopify's hosted page.
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [cartCheckingOut, setCartCheckingOut] = useState(false);
  // Don't persist until the saved cart has been loaded, or the initial
  // empty state would wipe what's on disk.
  const [cartLoadedForUid, setCartLoadedForUid] = useState<string | null>(null);
  useEffect(() => {
    const uid = user?.uid;
    if (!uid) { setCart([]); setCartLoadedForUid(null); return; }
    let alive = true;
    loadCart(uid).then(lines => {
      if (!alive) return;
      setCart(lines);
      setCartLoadedForUid(uid);
    });
    return () => { alive = false; };
  }, [user?.uid]);
  useEffect(() => {
    if (!user?.uid || cartLoadedForUid !== user.uid) return;
    saveCart(user.uid, cart);
  }, [cart, user?.uid, cartLoadedForUid]);
  // Once the live store catalog arrives, drop saved lines whose variant is no
  // longer purchasable (product unlisted, variant removed, or sold out), and
  // refresh the remaining lines' prices from the store — Shopify's hosted
  // checkout charges the live price, so the cart must show it too. The save
  // effect above persists the corrected prices for the next restart.
  useEffect(() => {
    if (!cartLoadedForUid || shopCatalog.length === 0) return;
    const liveVariants = new Map(
      shopCatalog.flatMap(p => purchasableVariants(p).map(v => [v.id, v] as const)),
    );
    setCart(prev => {
      let changed = false;
      const next: CartLine[] = [];
      for (const l of prev) {
        const v = liveVariants.get(l.variantId);
        if (!v) { changed = true; continue; }  // no longer purchasable
        const amount = Number(v.price.amount);
        const livePrice = Number.isFinite(amount) ? `$${amount.toFixed(2)}` : l.price;
        if (livePrice !== l.price) {
          changed = true;
          // Flag the line so the cart can tell the member the store
          // corrected the price; cleared once they've seen the cart.
          next.push({ ...l, price: livePrice, priceChanged: true });
        } else {
          next.push(l);
        }
      }
      return changed ? next : prev;
    });
  }, [shopCatalog, cartLoadedForUid]);
  // Once the member closes the cart they've seen the corrected prices —
  // clear the "price updated" flags (the save effect persists the clear).
  const cartWasOpen = React.useRef(false);
  useEffect(() => {
    if (cartWasOpen.current && !cartOpen) {
      setCart(prev => prev.some(l => l.priceChanged)
        ? prev.map(l => (l.priceChanged ? { ...l, priceChanged: false } : l))
        : prev);
    }
    cartWasOpen.current = cartOpen;
  }, [cartOpen]);
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const cartTotal = useMemo(() => {
    let total = 0;
    let currency = '$';
    for (const l of cart) {
      const n = Number(l.price.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) total += n * l.quantity;
      if (l.price.trim().startsWith('$')) currency = '$';
    }
    return `${currency}${total.toFixed(2)}`;
  }, [cart]);

  const addToCart = (p: ArmoryProduct, variant: { id: string; title: string; price: { amount: string } }) => {
    setCart(prev => {
      const existing = prev.find(l => l.variantId === variant.id);
      if (existing) {
        return prev.map(l =>
          l.variantId === variant.id ? { ...l, quantity: Math.min(20, l.quantity + 1) } : l,
        );
      }
      const amount = Number(variant.price.amount);
      return [...prev, {
        variantId: variant.id,
        quantity: 1,
        productName: p.name,
        variantTitle: variant.title === 'Default Title' ? '' : variant.title,
        price: Number.isFinite(amount) ? `$${amount.toFixed(2)}` : p.price,
      }];
    });
  };

  const changeCartQty = (variantId: string, delta: number) => {
    setCart(prev => prev
      .map(l => l.variantId === variantId
        ? { ...l, quantity: Math.min(20, l.quantity + delta) }
        : l)
      .filter(l => l.quantity >= 1));
  };

  const removeCartLine = (variantId: string) =>
    setCart(prev => prev.filter(l => l.variantId !== variantId));

  const checkoutCart = async () => {
    if (cartCheckingOut || cart.length === 0) return;
    setCartCheckingOut(true);
    try {
      const url = await createShopifyCheckout(
        cart.map(l => ({ variantId: l.variantId, quantity: l.quantity })),
      );
      setCartOpen(false);
      // Checkout is now in Shopify's hands — clear the local cart so the
      // member doesn't accidentally re-buy the same lines later.
      setCart([]);
      await WebBrowser.openBrowserAsync(url);
    } catch (e: any) {
      showAlert('Checkout unavailable', e?.message ?? 'Could not start checkout.');
    } finally {
      setCartCheckingOut(false);
    }
  };

  const pickPhoto = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.85,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    setForm(f => f ? { ...f, photo: { uri: a.uri, mimeType: a.mimeType ?? 'image/jpeg' } } : f);
  };

  const saveForm = async () => {
    if (!form || !user || saving) return;
    if (!form.name.trim()) { showAlert('Missing name', 'Every piece of equipment needs a name.'); return; }
    if (!form.price.trim()) { showAlert('Missing price', 'Enter a price (e.g. $45).'); return; }
    setSaving(true);
    try {
      const input = {
        name: form.name, price: form.price, category: form.category,
        description: form.description, artifact: form.artifact,
        shopifyHandle: form.shopifyHandle,
      };
      if (form.productId) {
        const existing = products.find(p => p.id === form.productId);
        if (existing) await updateArmoryProduct(existing, input, form.photo);
      } else {
        await addArmoryProduct(user.uid, input, form.photo);
      }
      setForm(null);
    } catch (e: any) {
      showAlert('Could not save', e?.message ?? 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  };

  const removeProduct = (p: ArmoryProduct) => {
    confirmAction(
      'Remove from the Armory',
      `Remove "${p.name}" from issue? Members will no longer see it.`,
      'Remove',
      async () => {
        try { await deleteArmoryProduct(p); }
        catch (e: any) { showAlert('Could not remove', e?.message ?? 'Something went wrong.'); }
      },
    );
  };

  // Each product reads as a closed black file folder with an index tab; tap
  // opens the folder to reveal the photo, description, and price — the same
  // folder language used across the rest of the app.
  const renderProduct = (p: ArmoryProduct) => {
    const open = openProductId === p.id;
    const shopMatch = open ? matchShopifyProduct(p, shopCatalog) : null;
    const shopVariants = shopMatch ? purchasableVariants(shopMatch) : [];
    // A lone "Default Title" variant means the product has no real options.
    const showVariantPicker =
      shopVariants.length > 1 ||
      (shopVariants.length === 1 && shopVariants[0].title !== 'Default Title');
    const chosenVariantId =
      selectedVariant[p.id] && shopVariants.some(v => v.id === selectedVariant[p.id])
        ? selectedVariant[p.id]
        : shopVariants[0]?.id ?? null;
    const buying = buyingProductId === p.id;
    // For matched (buyable) products, the live store price is the honest one:
    // it's what checkout will actually charge for the chosen variant.
    const chosenVariant = shopVariants.find(v => v.id === chosenVariantId) ?? null;
    const livePrice = chosenVariant ? formatVariantPrice(chosenVariant.price) : null;
    const priceMismatch =
      !!chosenVariant && !displayPriceMatches(p.price, chosenVariant.price);
    return (
      <View key={p.id} style={st.folderCardWrap}>
        {/* The index tab sticking up out of the folder */}
        <View style={st.folderCardTab}>
          <Text style={st.folderCardTabText} numberOfLines={1}>
            {(CATEGORY_DISPLAY[p.category] ?? p.category).toUpperCase()}
          </Text>
        </View>
        <TouchableOpacity
          style={[st.folderCard, open && st.folderCardOpen]}
          onPress={() => setOpenProductId(open ? null : p.id)}
          activeOpacity={0.85}
          accessibilityLabel={open ? `Close ${p.name}` : `Open ${p.name}`}
        >
          <View style={st.folderCardHead}>
            <Text style={st.productName} numberOfLines={2}>{p.name}</Text>
            <View style={st.folderCardHeadRight}>
              {!open && <Text style={st.productPrice}>{p.price}</Text>}
              <Feather name={open ? 'chevron-up' : 'chevron-down'} size={15} color="rgba(212,168,83,0.7)" />
            </View>
          </View>

          {open && (
            <View style={st.folderCardBody}>
              <ProductPhoto path={p.photoPath} style={st.productPhotoLarge} />
              {!!p.description && <Text style={st.productDesc}>{p.description}</Text>}
              <View style={st.folderCardFoot}>
                <Text style={st.productPriceLarge}>{livePrice ?? p.price}</Text>
                <Text style={st.issuedTag}>
                  {shopVariants.length > 0 ? 'ISSUED TO THE 54' : 'ISSUED, NOT SOLD'}
                </Text>
              </View>
              {isAdmin && priceMismatch && (
                <Text style={st.priceMismatchNote}>
                  Listed price {p.price} differs from the store price {livePrice}. Members see the store price.
                </Text>
              )}

              {shopVariants.length > 0 && (
                <View style={st.buyBox}>
                  {showVariantPicker && (
                    <>
                      <Text style={st.buyLabel}>SELECT OPTION</Text>
                      <View style={st.variantRow}>
                        {shopVariants.map(v => {
                          const active = v.id === chosenVariantId;
                          return (
                            <TouchableOpacity
                              key={v.id}
                              style={[st.variantChip, active && st.variantChipActive]}
                              onPress={() => setSelectedVariant(s => ({ ...s, [p.id]: v.id }))}
                              activeOpacity={0.8}
                              accessibilityLabel={`Select ${v.title}`}
                            >
                              <Text style={[st.variantChipText, active && st.variantChipTextActive]}>
                                {v.title.toUpperCase()}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    </>
                  )}
                  <TouchableOpacity
                    style={[st.buyBtn, buying && { opacity: 0.6 }]}
                    onPress={() => chosenVariantId && startCheckout(p, chosenVariantId)}
                    disabled={buying || !chosenVariantId}
                    activeOpacity={0.85}
                    accessibilityLabel={`Claim ${p.name}`}
                  >
                    {buying ? (
                      <ActivityIndicator size="small" color="#0B0906" />
                    ) : (
                      <Text style={st.buyBtnText}>CLAIM YOURS  →</Text>
                    )}
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[st.cartAddBtn, !chosenVariantId && { opacity: 0.5 }]}
                    onPress={() => {
                      const v = shopVariants.find(x => x.id === chosenVariantId);
                      if (v) addToCart(p, v);
                    }}
                    disabled={!chosenVariantId}
                    activeOpacity={0.85}
                    accessibilityLabel={`Add ${p.name} to cart`}
                  >
                    <Feather name="plus" size={13} color={GOLD} />
                    <Text style={st.cartAddBtnText}>ADD TO CART</Text>
                  </TouchableOpacity>
                  <Text style={st.buyHint}>Secure checkout opens in your browser.</Text>
                </View>
              )}
              {isAdmin && (
                <View style={st.productAdmin}>
                  <TouchableOpacity
                    onPress={() => openEdit(p)}
                    hitSlop={8}
                    accessibilityLabel={`Edit ${p.name}`}
                    style={st.adminIconBtn}
                  >
                    <Feather name="edit" size={15} color="rgba(212,168,83,0.8)" />
                    <Text style={st.adminIconText}>EDIT</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => removeProduct(p)}
                    hitSlop={8}
                    accessibilityLabel={`Remove ${p.name}`}
                    style={st.adminIconBtn}
                  >
                    <Feather name="x" size={16} color="rgba(200,80,60,0.85)" />
                    <Text style={[st.adminIconText, { color: 'rgba(200,80,60,0.85)' }]}>REMOVE</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  // ── Issue Locker: issued records, grouped by kind ──
  // Admins can browse any member's locker; viewUid === null means "my locker".
  const [viewUid, setViewUid] = useState<string | null>(null);
  const viewedUid = isAdmin && viewUid ? viewUid : user?.uid ?? null;
  const [records, setRecords] = useState<IssuedRecord[]>([]);
  useEffect(() => {
    if (!viewedUid) { setRecords([]); return; }
    return listenIssuedRecords(viewedUid, setRecords);
  }, [viewedUid]);

  const recordsByKind = useMemo(() => {
    const map: Record<string, IssuedRecord[]> = {};
    for (const r of records) (map[r.kind] ??= []).push(r);
    return map;
  }, [records]);

  // ── Admin: issue-equipment modal ──
  const [issueOpen, setIssueOpen] = useState(false);
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [targetUid, setTargetUid] = useState<'all' | string>('all');
  const [kind, setKind] = useState<LockerKind>(LOCKER_KINDS[0]);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [issuePrice, setIssuePrice] = useState('');
  const [issuing, setIssuing] = useState(false);

  // ── Member search filters (admin pickers) ──
  // Separate queries so the locker viewer picker and the issue-modal
  // recipient picker filter independently. Matches Joker ID or name
  // (both live in `label`), case-insensitive.
  const [lockerQuery, setLockerQuery] = useState('');
  const [recipientQuery, setRecipientQuery] = useState('');
  const matchesQuery = (m: MemberLite, q: string) =>
    m.label.toLowerCase().includes(q.trim().toLowerCase());

  // Load members when the admin opens the issue modal OR views the locker tab
  // (the locker tab hosts the admin member picker).
  const needMembers = issueOpen || (isAdmin && view === 'locker');
  useEffect(() => {
    if (!needMembers || members.length > 0) return;
    getAllMembers().then(all => {
      setMembers(all.map((m: any) => ({
        uid: m.uid,
        label: [m.jokerId, m.name].filter(Boolean).join(' — ') || '——',
      })));
    }).catch(() => {});
  }, [needMembers, members.length]);

  const submitIssue = async () => {
    if (!user || issuing) return;
    const t = title.trim();
    if (!t) { Alert.alert('Missing item', 'Name the item being issued.'); return; }
    // Nothing is free: every issued item carries a required dollar price.
    const rawPrice = issuePrice.trim().replace(/^\$/, '');
    const priceNum = Number(rawPrice);
    if (!rawPrice || !Number.isFinite(priceNum) || priceNum < 0) {
      Alert.alert('Invalid price', 'Enter the price in dollars (e.g. 45 or 45.50).');
      return;
    }
    const price = `$${Number.isInteger(priceNum) ? priceNum : priceNum.toFixed(2)}`;
    const recipients = targetUid === 'all' ? members.map(m => m.uid) : [targetUid];
    if (recipients.length === 0) { Alert.alert('No recipients', 'No members to issue to.'); return; }
    setIssuing(true);
    try {
      const failed = await issueItem(user.uid, recipients, { kind, title: t, notes, price });
      if (failed.length > 0) {
        Alert.alert('Partially issued', `${failed.length} of ${recipients.length} records failed to write.`);
      }
      setIssueOpen(false);
      setTitle(''); setNotes(''); setIssuePrice(''); setTargetUid('all'); setKind(LOCKER_KINDS[0]);
    } catch {
      Alert.alert('Issue failed', 'The record could not be written.');
    } finally {
      setIssuing(false);
    }
  };

  const confirmRemove = (rec: IssuedRecord) => {
    if (!viewedUid) return;
    const whose = viewUid && viewUid !== user?.uid ? "this member's" : 'your';
    Alert.alert('Remove record', `Remove "${rec.title}" from ${whose} locker record?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove', style: 'destructive',
        onPress: () => { deleteIssuedRecord(viewedUid, rec.id).catch(() => {}); },
      },
    ]);
  };

  const tabs: { id: ArmoryView; label: string }[] = [
    { id: 'armory', label: 'THE ARMORY' },
    { id: 'locker', label: 'ISSUE LOCKER' },
  ];

  return (
    <View style={st.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
      <View style={[st.nav, { height: navBottom }]}>
        <View style={st.navRow}>
          <View style={st.navSide}>
            <TouchableOpacity
              onPress={() =>
                view === 'landing'
                  ? (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'))
                  : setView('landing')
              }
              activeOpacity={0.75}
            >
              <Image source={NAV_DAGGER} style={st.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={st.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          <Text style={st.navTitle} numberOfLines={1}>Uniform</Text>
          <View style={st.navSide}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      <View style={[st.labelRow, { top: navBottom + 8 }]}>
        <Text style={st.screenLabel}>UNIFORM</Text>
      </View>

      {/* ── Folder ── */}
      <View style={[st.folderWrap, { top: navBottom + 42 }]}>
        {view === 'landing' ? (
          <View style={[st.body, st.bodyRounded]}>
            <View style={st.landingFill}>
              {/* "54" badge — parchment square, ornate hairline, gold glow */}
              <View style={st.badgeGlow}>
                <View style={st.badge}>
                  <View style={st.badgeInner}>
                    <Text style={st.badgeText}>54</Text>
                  </View>
                </View>
              </View>

              {/* Two-tone headline: gold line over cream line */}
              <Text style={st.heroLineGold}>THE SYSTEM</Text>
              <Text style={st.heroLineCream}>CONTINUES HERE</Text>

              <Text style={st.landingSubtitle}>
                Official gear for the 54. Issued, not sold.
              </Text>
              <Text style={st.landingTagline}>Every piece is issued. Every piece has purpose.</Text>

              <TouchableOpacity
                style={st.primaryBtn}
                onPress={() => setView('armory')}
                activeOpacity={0.85}
                accessibilityLabel="Enter the Armory"
              >
                <Text style={st.primaryBtnText}>ENTER THE ARMORY  →</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={st.linkBtn}
                onPress={() => setView('locker')}
                activeOpacity={0.85}
                accessibilityLabel="View Issued Equipment"
              >
                <Text style={st.linkBtnText}>VIEW ISSUED EQUIPMENT  →</Text>
              </TouchableOpacity>
            </View>
            <Text style={st.footerText}>
              Official gear for the 54. Issued, not sold.{'\n'}© The Jester's Hand. Members only.
            </Text>
          </View>
        ) : (
          <>
            <View style={st.tabsRow}>
              {tabs.map(t => {
                const active = t.id === view;
                return (
                  <TouchableOpacity
                    key={t.id}
                    style={[st.tab, active && st.tabActive]}
                    onPress={() => setView(t.id)}
                    activeOpacity={0.8}
                  >
                    <Text style={[st.tabText, active && st.tabTextActive]} numberOfLines={1}>
                      {t.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <View style={st.body}>
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 8 }}>
                {view === 'armory' ? (
                  <>
                    <Text style={st.pageTitleGold}>ARMORY INVENTORY</Text>
                    <Text style={st.pageSubtitle}>
                      Every piece already yours to claim.
                    </Text>

                    {/* Cart bar — only when there is something in the cart */}
                    {cartCount > 0 && (
                      <TouchableOpacity
                        style={st.cartBar}
                        onPress={() => setCartOpen(true)}
                        activeOpacity={0.85}
                        accessibilityLabel={`Open cart, ${cartCount} items`}
                      >
                        <Feather name="shopping-bag" size={14} color="#0B0906" />
                        <Text style={st.cartBarText}>
                          CART — {cartCount} {cartCount === 1 ? 'ITEM' : 'ITEMS'}
                        </Text>
                        <Text style={st.cartBarTotal}>{cartTotal}</Text>
                      </TouchableOpacity>
                    )}

                    {/* Category filter pills */}
                    <View style={st.pillRow}>
                      {(['all', ...ARMORY_CATEGORIES] as const).map(c => {
                        const active = catFilter === c;
                        return (
                          <TouchableOpacity
                            key={c}
                            style={[st.pill, active && st.pillActive]}
                            onPress={() => setCatFilter(c)}
                            activeOpacity={0.8}
                          >
                            <Text style={[st.pillText, active && st.pillTextActive]}>
                              {c === 'all' ? 'ALL' : CATEGORY_DISPLAY[c].toUpperCase()}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>

                    {isAdmin && (
                      <TouchableOpacity
                        style={st.stockBtn}
                        onPress={openAdd}
                        activeOpacity={0.85}
                        accessibilityLabel="Stock the Armory"
                      >
                        <Feather name="plus" size={14} color="#0B0906" />
                        <Text style={st.stockBtnText}>STOCK THE ARMORY</Text>
                      </TouchableOpacity>
                    )}

                    {products.length === 0 ? (
                      <View style={st.armoryEmpty}>
                        <Text style={st.armoryEmptyText}>
                          THE ARMORY IS BEING STOCKED.{'\n'}CHECK BACK SOON.
                        </Text>
                      </View>
                    ) : (
                      <>
                        {/* Featured collection */}
                        {(catFilter === 'all' || artifacts.some(p => p.category === catFilter)) && (
                          <View style={st.featured}>
                            <Text style={st.featuredTitle}>ISSUED ARTIFACTS</Text>
                            <Text style={st.featuredSub}>
                              Exclusive signed and limited-edition pieces, issued to the 54.
                            </Text>
                            {filteredArtifacts.length === 0 ? (
                              <View style={st.emptyRow}>
                                <Feather name="award" size={18} color="rgba(212,168,83,0.35)" />
                                <Text style={st.emptyRowText}>No artifacts are currently in the Armory.</Text>
                              </View>
                            ) : (
                              filteredArtifacts.map(renderProduct)
                            )}
                          </View>
                        )}

                        {/* Categories */}
                        {visibleCategories.map(c => {
                          const items = byCategory(c.key);
                          return (
                            <View key={c.key} style={st.category}>
                              <View style={st.categoryHead}>
                                <Feather name={c.icon as any} size={15} color={GOLD} />
                                <Text style={st.categoryLabel}>{c.label.toUpperCase()}</Text>
                              </View>
                              {items.length === 0 ? (
                                <View style={st.emptyRow}>
                                  <Text style={st.emptyRowText}>NO ITEMS IN THE ARMORY. CHECK BACK SOON.</Text>
                                </View>
                              ) : (
                                items.map(renderProduct)
                              )}
                            </View>
                          );
                        })}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <Text style={st.pageTitle}>Issue Locker</Text>
                    <Text style={st.pageSubtitle}>
                      {isAdmin && viewUid
                        ? `Reviewing the locker record of ${members.find(m => m.uid === viewUid)?.label ?? 'this member'}.`
                        : "Your personal record of equipment, rewards, and artifacts issued during your tenure in The Jester's Hand."}
                    </Text>

                    {/* Admin: browse any member's locker */}
                    {isAdmin && (
                      <View style={st.viewerBox}>
                        <Text style={st.fieldLabel}>VIEWING LOCKER</Text>
                        <TextInput
                          style={st.searchInput}
                          value={lockerQuery}
                          onChangeText={setLockerQuery}
                          placeholder="Search by Joker ID or name…"
                          placeholderTextColor="rgba(237,224,196,0.3)"
                          autoCapitalize="none"
                          autoCorrect={false}
                          accessibilityLabel="Search members"
                        />
                        <View style={st.chipWrap}>
                          <TouchableOpacity
                            style={[st.chip, !viewUid && st.chipActive]}
                            onPress={() => setViewUid(null)}
                            activeOpacity={0.8}
                          >
                            <Text style={[st.chipText, !viewUid && st.chipTextActive]}>MY LOCKER</Text>
                          </TouchableOpacity>
                          {members.filter(m => m.uid !== user?.uid && matchesQuery(m, lockerQuery)).map(m => (
                            <TouchableOpacity
                              key={m.uid}
                              style={[st.chip, viewUid === m.uid && st.chipActive]}
                              onPress={() => setViewUid(m.uid)}
                              activeOpacity={0.8}
                            >
                              <Text style={[st.chipText, viewUid === m.uid && st.chipTextActive]} numberOfLines={1}>
                                {m.label}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      </View>
                    )}

                    {isAdmin && (
                      <TouchableOpacity
                        style={st.issueBtn}
                        onPress={() => setIssueOpen(true)}
                        activeOpacity={0.85}
                        accessibilityLabel="Issue equipment to members"
                      >
                        <Feather name="plus" size={14} color="#0B0906" />
                        <Text style={st.issueBtnText}>ISSUE EQUIPMENT</Text>
                      </TouchableOpacity>
                    )}

                    {LOCKER_KINDS.map(k => {
                      const items = recordsByKind[k] ?? [];
                      return (
                        <View key={k} style={st.category}>
                          <View style={st.lockerRow}>
                            <Feather name="chevron-right" size={13} color="rgba(212,168,83,0.5)" />
                            <Text style={st.lockerRowText}>{k}</Text>
                          </View>
                          {items.length === 0 ? (
                            <View style={st.emptyRow}>
                              <Text style={st.emptyRowText}>Nothing issued under this record yet.</Text>
                            </View>
                          ) : items.map(rec => (
                            <View key={rec.id} style={st.recordRow}>
                              <View style={{ flex: 1 }}>
                                <Text style={st.recordTitle}>{rec.title}</Text>
                                {!!rec.notes && <Text style={st.recordNotes}>{rec.notes}</Text>}
                                {!!rec.price && <Text style={st.recordPrice}>{rec.price} owed</Text>}
                                <Text style={st.recordDate}>
                                  {formatIssuedTimestamp(rec.createdAt) || 'Issued'}
                                </Text>
                              </View>
                              {isAdmin && (
                                <TouchableOpacity
                                  onPress={() => confirmRemove(rec)}
                                  activeOpacity={0.7}
                                  accessibilityLabel={`Remove ${rec.title}`}
                                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                >
                                  <Feather name="trash-2" size={14} color="rgba(212,168,83,0.55)" />
                                </TouchableOpacity>
                              )}
                            </View>
                          ))}
                        </View>
                      );
                    })}

                    {records.length === 0 && (
                      <View style={st.lockerEmpty}>
                        <Feather name="save" size={26} color="rgba(212,168,83,0.3)" />
                        <Text style={st.lockerEmptyText}>Nothing additional has been issued yet.</Text>
                      </View>
                    )}
                  </>
                )}
                <Text style={st.footerText}>
                  Official gear for the 54. Issued, not sold.{'\n'}© The Jester's Hand. Members only.
                </Text>
              </ScrollView>

              {/* Floating cart button — stays visible while scrolling the Armory */}
              {view === 'armory' && cartCount > 0 && (
                <TouchableOpacity
                  style={st.cartFab}
                  onPress={() => setCartOpen(true)}
                  activeOpacity={0.85}
                  accessibilityLabel={`Open cart, ${cartCount} items`}
                >
                  <Feather name="shopping-bag" size={18} color="#0B0906" />
                  <View style={st.cartFabBadge}>
                    <Text style={st.cartFabBadgeText}>{cartCount > 99 ? '99+' : cartCount}</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
          </>
        )}
      </View>

      {/* ── Cart modal ── */}
      <Modal visible={cartOpen} transparent animationType="fade" onRequestClose={() => setCartOpen(false)}>
        <View style={st.modalBackdrop}>
          <View style={st.modalCard}>
            <Text style={st.modalTitle}>YOUR CART</Text>
            <ScrollView showsVerticalScrollIndicator={false}>
              {cart.length === 0 ? (
                <Text style={st.cartEmptyText}>Your cart is empty.</Text>
              ) : cart.map(l => (
                <View key={l.variantId} style={st.cartLine}>
                  <View style={{ flex: 1 }}>
                    <Text style={st.cartLineName} numberOfLines={2}>{l.productName}</Text>
                    {!!l.variantTitle && (
                      <Text style={st.cartLineVariant}>{l.variantTitle.toUpperCase()}</Text>
                    )}
                    <Text style={st.cartLinePrice}>{l.price}</Text>
                    {l.priceChanged && (
                      <Text style={st.cartPriceUpdated}>PRICE UPDATED BY THE STORE</Text>
                    )}
                  </View>
                  <View style={st.cartQtyBox}>
                    <TouchableOpacity
                      onPress={() => changeCartQty(l.variantId, -1)}
                      hitSlop={8}
                      style={st.cartQtyBtn}
                      accessibilityLabel={`Decrease quantity of ${l.productName}`}
                    >
                      <Feather name="minus" size={13} color={GOLD} />
                    </TouchableOpacity>
                    <Text style={st.cartQtyText}>{l.quantity}</Text>
                    <TouchableOpacity
                      onPress={() => changeCartQty(l.variantId, 1)}
                      hitSlop={8}
                      style={st.cartQtyBtn}
                      accessibilityLabel={`Increase quantity of ${l.productName}`}
                    >
                      <Feather name="plus" size={13} color={GOLD} />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeCartLine(l.variantId)}
                    hitSlop={8}
                    accessibilityLabel={`Remove ${l.productName} from cart`}
                  >
                    <Feather name="x" size={15} color="rgba(200,80,60,0.85)" />
                  </TouchableOpacity>
                </View>
              ))}

              {cart.length > 0 && (
                <View style={st.cartTotalRow}>
                  <Text style={st.cartTotalLabel}>TOTAL</Text>
                  <Text style={st.cartTotalValue}>{cartTotal}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[st.primaryBtn, { marginTop: 14 }, (cartCheckingOut || cart.length === 0) && { opacity: 0.6 }]}
                onPress={checkoutCart}
                disabled={cartCheckingOut || cart.length === 0}
                activeOpacity={0.85}
                accessibilityLabel="Check out"
              >
                {cartCheckingOut
                  ? <ActivityIndicator color="#0B0906" />
                  : <Text style={st.primaryBtnText}>CHECK OUT  →</Text>}
              </TouchableOpacity>
              {cart.length > 0 && (
                <Text style={st.buyHint}>Secure checkout opens in your browser.</Text>
              )}
              <TouchableOpacity
                style={st.modalCancel}
                onPress={() => setCartOpen(false)}
                activeOpacity={0.75}
              >
                <Text style={st.modalCancelText}>KEEP BROWSING</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── Admin: issue-equipment modal ── */}
      <Modal visible={issueOpen} transparent animationType="fade" onRequestClose={() => setIssueOpen(false)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={st.modalBackdrop}
        >
          <View style={st.modalCard}>
            <Text style={st.modalTitle}>ISSUE EQUIPMENT</Text>
            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={st.fieldLabel}>RECIPIENT</Text>
              <TextInput
                style={st.searchInput}
                value={recipientQuery}
                onChangeText={setRecipientQuery}
                placeholder="Search by Joker ID or name…"
                placeholderTextColor="rgba(237,224,196,0.3)"
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Search recipients"
              />
              <View style={st.chipWrap}>
                <TouchableOpacity
                  style={[st.chip, targetUid === 'all' && st.chipActive]}
                  onPress={() => setTargetUid('all')}
                  activeOpacity={0.8}
                >
                  <Text style={[st.chipText, targetUid === 'all' && st.chipTextActive]}>ALL MEMBERS</Text>
                </TouchableOpacity>
                {members.filter(m => matchesQuery(m, recipientQuery)).map(m => (
                  <TouchableOpacity
                    key={m.uid}
                    style={[st.chip, targetUid === m.uid && st.chipActive]}
                    onPress={() => setTargetUid(m.uid)}
                    activeOpacity={0.8}
                  >
                    <Text style={[st.chipText, targetUid === m.uid && st.chipTextActive]} numberOfLines={1}>
                      {m.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={st.fieldLabel}>RECORD</Text>
              <View style={st.chipWrap}>
                {LOCKER_KINDS.map(k => (
                  <TouchableOpacity
                    key={k}
                    style={[st.chip, kind === k && st.chipActive]}
                    onPress={() => setKind(k)}
                    activeOpacity={0.8}
                  >
                    <Text style={[st.chipText, kind === k && st.chipTextActive]} numberOfLines={1}>{k}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={st.fieldLabel}>ITEM</Text>
              <TextInput
                style={st.input}
                value={title}
                onChangeText={setTitle}
                placeholder="What is being issued"
                placeholderTextColor="rgba(237,224,196,0.3)"
                maxLength={200}
              />

              <Text style={st.fieldLabel}>PRICE</Text>
              <TextInput
                style={st.input}
                value={issuePrice}
                onChangeText={setIssuePrice}
                placeholder="e.g. 45 or 45.50"
                placeholderTextColor="rgba(237,224,196,0.3)"
                keyboardType="decimal-pad"
                maxLength={12}
                accessibilityLabel="Price in dollars"
              />

              <Text style={st.fieldLabel}>DETAILS (OPTIONAL)</Text>
              <TextInput
                style={[st.input, st.inputMulti]}
                value={notes}
                onChangeText={setNotes}
                placeholder="Size, edition, occasion…"
                placeholderTextColor="rgba(237,224,196,0.3)"
                maxLength={2000}
                multiline
              />

              <TouchableOpacity
                style={[st.primaryBtn, { marginTop: 14 }, issuing && { opacity: 0.6 }]}
                onPress={submitIssue}
                disabled={issuing}
                activeOpacity={0.85}
              >
                {issuing
                  ? <ActivityIndicator color="#0B0906" />
                  : <Text style={st.primaryBtnText}>ISSUE</Text>}
              </TouchableOpacity>
              <TouchableOpacity
                style={st.modalCancel}
                onPress={() => setIssueOpen(false)}
                activeOpacity={0.75}
              >
                <Text style={st.modalCancelText}>CANCEL</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Admin: add / edit product sheet ── */}
      <Modal visible={!!form && isAdmin} animationType="slide" transparent onRequestClose={() => setForm(null)}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={st.sheetBackdrop}
        >
          <View style={st.sheet}>
            <View style={st.sheetHead}>
              <Text style={st.sheetTitle}>
                {form?.productId ? 'EDIT EQUIPMENT' : 'STOCK THE ARMORY'}
              </Text>
              <TouchableOpacity onPress={() => setForm(null)} hitSlop={8} accessibilityLabel="Close">
                <Feather name="x" size={20} color="rgba(237,224,196,0.7)" />
              </TouchableOpacity>
            </View>

            {form && (
              <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
                <Text style={st.fieldLabel}>NAME</Text>
                <TextInput
                  style={st.input}
                  value={form.name}
                  onChangeText={t => setForm({ ...form, name: t })}
                  placeholder="e.g. Jester's Field Jacket"
                  placeholderTextColor="rgba(237,224,196,0.3)"
                  maxLength={200}
                />

                <Text style={st.fieldLabel}>PRICE</Text>
                <TextInput
                  style={st.input}
                  value={form.price}
                  onChangeText={t => setForm({ ...form, price: t })}
                  placeholder="e.g. $45"
                  placeholderTextColor="rgba(237,224,196,0.3)"
                  maxLength={60}
                />

                <Text style={st.fieldLabel}>CATEGORY</Text>
                <View style={st.chipWrap}>
                  {ARMORY_CATEGORIES.map(c => {
                    const active = form.category === c;
                    return (
                      <TouchableOpacity
                        key={c}
                        style={[st.chip, active && st.chipActive]}
                        onPress={() => setForm({ ...form, category: c })}
                        activeOpacity={0.8}
                      >
                        <Text style={[st.chipText, active && st.chipTextActive]}>
                          {CATEGORY_DISPLAY[c]}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>

                <Text style={st.fieldLabel}>DESCRIPTION (OPTIONAL)</Text>
                <TextInput
                  style={[st.input, st.inputMulti]}
                  value={form.description}
                  onChangeText={t => setForm({ ...form, description: t })}
                  placeholder="Details members should know…"
                  placeholderTextColor="rgba(237,224,196,0.3)"
                  multiline
                  maxLength={2000}
                />

                <View style={st.switchRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={st.switchLabel}>ISSUED ARTIFACT</Text>
                    <Text style={st.switchHint}>
                      Signed or limited-edition — shown in the featured collection.
                    </Text>
                  </View>
                  <Switch
                    value={form.artifact}
                    onValueChange={v => setForm({ ...form, artifact: v })}
                    trackColor={{ false: '#333', true: 'rgba(212,168,83,0.6)' }}
                    thumbColor={form.artifact ? GOLD : '#888'}
                  />
                </View>

                <Text style={st.fieldLabel}>SHOPIFY HANDLE (OPTIONAL)</Text>
                <TextInput
                  style={st.input}
                  value={form.shopifyHandle}
                  onChangeText={t => setForm({ ...form, shopifyHandle: t })}
                  placeholder="e.g. jesters-field-jacket"
                  placeholderTextColor="rgba(237,224,196,0.3)"
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={255}
                />
                <Text style={st.photoHint}>
                  Links this item to the online store for member purchase. Leave
                  blank to match by exact product name — or to keep it display-only.
                </Text>

                <Text style={st.fieldLabel}>PHOTO</Text>
                <TouchableOpacity style={st.photoBtn} onPress={pickPhoto} activeOpacity={0.85}>
                  {form.photo ? (
                    <Image source={{ uri: form.photo.uri }} style={st.photoPreview} resizeMode="cover" />
                  ) : form.existingPhotoPath ? (
                    <ProductPhoto path={form.existingPhotoPath} style={st.photoPreview} />
                  ) : (
                    <View style={st.photoBtnEmpty}>
                      <Feather name="camera" size={18} color="rgba(212,168,83,0.6)" />
                      <Text style={st.photoBtnText}>Choose a photo</Text>
                    </View>
                  )}
                </TouchableOpacity>
                {(form.photo || form.existingPhotoPath) && (
                  <Text style={st.photoHint}>Tap the photo to replace it.</Text>
                )}

                <TouchableOpacity
                  style={[st.primaryBtn, { marginTop: 16, opacity: saving ? 0.6 : 1 }]}
                  onPress={saveForm}
                  disabled={saving}
                  activeOpacity={0.85}
                  accessibilityLabel={form.productId ? 'Save changes' : 'Add to the Armory'}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#0B0906" />
                  ) : (
                    <Text style={st.primaryBtnText}>
                      {form.productId ? 'SAVE CHANGES' : 'ADD TO THE ARMORY'}
                    </Text>
                  )}
                </TouchableOpacity>
                <View style={{ height: 24 }} />
              </ScrollView>
            )}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navSide:  { flexDirection: 'row', alignItems: 'center', gap: 2 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  labelRow: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  screenLabel: {
    ...MARBLE_TEXT_SHADOW,
    textAlign: 'center', color: GOLD, fontFamily: 'Cinzel_700Bold',
    fontSize: 18, letterSpacing: 3,
  },

  folderWrap: { position: 'absolute', left: SIDE, right: SIDE, bottom: SIDE },

  tabsRow: { flexDirection: 'row', gap: 6 },
  tab: {
    flex: 1, height: TAB_H,
    backgroundColor: '#080808',
    borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.18)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  tabActive: { backgroundColor: '#0D0D0D', borderColor: 'rgba(200,165,60,0.4)' },
  tabText: {
    color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 11, letterSpacing: 1.2,
  },
  tabTextActive: { color: CREAM },

  body: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },
  bodyRounded: { borderRadius: 10 },

  // Landing / hero
  landingFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 8 },
  badgeGlow: {
    padding: 14, borderRadius: 40, marginBottom: 4,
    backgroundColor: 'rgba(212,168,83,0.10)',
    shadowColor: GOLD, shadowOpacity: 0.9, shadowRadius: 18, shadowOffset: { width: 0, height: 0 },
    ...(Platform.OS === 'android' ? { elevation: 8 } : null),
  },
  badge: {
    width: 60, height: 60, borderRadius: 6,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.75)',
    backgroundColor: '#141008', padding: 3,
  },
  badgeInner: {
    flex: 1, borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 3,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(237,224,196,0.05)',
  },
  badgeText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 24, letterSpacing: 1 },
  heroLineGold: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 22, letterSpacing: 5, textAlign: 'center',
  },
  heroLineCream: {
    color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 22, letterSpacing: 5,
    textAlign: 'center', marginTop: -4,
  },
  landingSubtitle: {
    color: 'rgba(237,224,196,0.75)', fontFamily: 'Inter_400Regular', fontSize: 12.5,
    textAlign: 'center', lineHeight: 20,
  },
  landingTagline: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_500Medium', fontSize: 10.5, letterSpacing: 1.5,
    textAlign: 'center', marginBottom: 14, textTransform: 'uppercase',
  },
  primaryBtn: {
    alignSelf: 'stretch', borderRadius: 8, backgroundColor: GOLD,
    paddingVertical: 13, alignItems: 'center',
  },
  primaryBtnText: { color: '#0B0906', fontFamily: 'Inter_600SemiBold', fontSize: 12, letterSpacing: 2 },
  secondaryBtn: {
    alignSelf: 'stretch', borderRadius: 8, borderWidth: 1, borderColor: GOLD,
    backgroundColor: 'rgba(212,168,83,0.08)', paddingVertical: 13, alignItems: 'center',
  },
  secondaryBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
  linkBtn: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 8 },
  linkBtnText: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 11.5, letterSpacing: 2 },

  // Armory
  pageTitle: {
    color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 19, letterSpacing: 2.5,
    textAlign: 'center', marginTop: 4,
  },
  pageTitleGold: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 19, letterSpacing: 3,
    textAlign: 'center', marginTop: 4,
  },
  pillRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 7, justifyContent: 'center',
    marginBottom: 16,
  },
  pill: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
    paddingHorizontal: 12, paddingVertical: 7,
  },
  pillActive: { backgroundColor: GOLD, borderColor: GOLD },
  pillText: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.5 },
  pillTextActive: { color: '#0B0906' },
  armoryEmpty: { alignItems: 'center', paddingVertical: 56, paddingHorizontal: 16 },
  armoryEmptyText: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_500Medium', fontSize: 11.5,
    letterSpacing: 2, textAlign: 'center', lineHeight: 20,
  },

  // Product folder cards
  folderCardWrap: { marginTop: 12 },
  folderCardTab: {
    alignSelf: 'flex-start', marginLeft: 10,
    backgroundColor: '#0D0D0D',
    borderTopLeftRadius: 8, borderTopRightRadius: 8,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(212,168,83,0.5)',
    paddingHorizontal: 12, paddingVertical: 5, maxWidth: '70%',
  },
  folderCardTabText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 8.5, letterSpacing: 2 },
  folderCard: {
    backgroundColor: '#0A0A0A',
    borderRadius: 8, borderTopLeftRadius: 0,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    paddingHorizontal: 12, paddingVertical: 11,
  },
  folderCardOpen: { backgroundColor: '#0D0B07' },
  folderCardHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  folderCardHeadRight: { flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 'auto' },
  folderCardBody: { marginTop: 12, gap: 10 },
  productPhotoLarge: { width: '100%', height: 190, borderRadius: 6, backgroundColor: '#111' },
  folderCardFoot: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.18)', paddingTop: 10,
  },
  productPriceLarge: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  issuedTag: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_500Medium', fontSize: 9, letterSpacing: 2,
  },
  priceMismatchNote: {
    color: 'rgba(200,80,60,0.85)', fontFamily: 'Inter_500Medium', fontSize: 10.5,
    lineHeight: 15, marginTop: 8,
  },
  buyBox: {
    marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.18)', paddingTop: 12,
  },
  buyLabel: {
    color: 'rgba(212,168,83,0.75)', fontFamily: 'Inter_600SemiBold', fontSize: 9.5,
    letterSpacing: 2, marginBottom: 8,
  },
  variantRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  variantChip: {
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', borderRadius: 6,
    paddingVertical: 6, paddingHorizontal: 12, backgroundColor: 'rgba(0,0,0,0.35)',
  },
  variantChipActive: { backgroundColor: GOLD, borderColor: GOLD },
  variantChipText: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 10, letterSpacing: 1.5 },
  variantChipTextActive: { color: '#0B0906' },
  buyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderRadius: 8, backgroundColor: GOLD, paddingVertical: 11,
  },
  buyBtnText: { color: '#0B0906', fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
  cartAddBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 8, borderWidth: 1, borderColor: GOLD,
    backgroundColor: 'rgba(212,168,83,0.08)', paddingVertical: 10, marginTop: 8,
  },
  cartAddBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2 },
  cartBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: 8, backgroundColor: GOLD,
    paddingVertical: 10, paddingHorizontal: 12, marginBottom: 14,
  },
  cartBarText: { color: '#0B0906', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1.6, flex: 1 },
  cartBarTotal: { color: '#0B0906', fontFamily: 'Inter_600SemiBold', fontSize: 12 },
  cartFab: {
    position: 'absolute', right: 14, bottom: 18,
    width: 52, height: 52, borderRadius: 26,
    backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 6,
  },
  cartFabBadge: {
    position: 'absolute', top: -4, right: -4,
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 4,
    backgroundColor: '#0B0906', borderWidth: 1, borderColor: GOLD,
    alignItems: 'center', justifyContent: 'center',
  },
  cartFabBadgeText: { color: CREAM, fontFamily: 'Inter_600SemiBold', fontSize: 10 },
  cartEmptyText: {
    color: 'rgba(237,224,196,0.5)', fontFamily: 'Inter_400Regular', fontSize: 11.5,
    textAlign: 'center', paddingVertical: 18,
  },
  cartLine: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 10, paddingVertical: 8, paddingHorizontal: 10,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)',
    backgroundColor: 'rgba(212,168,83,0.05)',
  },
  cartLineName: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, letterSpacing: 0.6 },
  cartLineVariant: { color: 'rgba(212,168,83,0.75)', fontFamily: 'Inter_600SemiBold', fontSize: 9, letterSpacing: 1.5, marginTop: 2 },
  cartLinePrice: { color: GOLD, fontFamily: 'Inter_500Medium', fontSize: 10.5, marginTop: 2 },
  cartPriceUpdated: { color: 'rgba(200,140,60,0.95)', fontFamily: 'Inter_600SemiBold', fontSize: 8.5, letterSpacing: 1.2, marginTop: 3 },
  cartQtyBox: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cartQtyBtn: {
    width: 24, height: 24, borderRadius: 6, borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  cartQtyText: {
    color: CREAM, fontFamily: 'Inter_600SemiBold', fontSize: 12, minWidth: 16, textAlign: 'center',
  },
  cartTotalRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.18)',
    marginTop: 12, paddingTop: 10, paddingHorizontal: 2,
  },
  cartTotalLabel: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 2 },
  cartTotalValue: { color: GOLD, fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  buyHint: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_500Medium', fontSize: 9,
    letterSpacing: 0.5, textAlign: 'center', marginTop: 8,
  },
  adminIconBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  adminIconText: { color: 'rgba(212,168,83,0.8)', fontFamily: 'Inter_600SemiBold', fontSize: 9.5, letterSpacing: 1.5 },
  pageSubtitle: {
    color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11,
    textAlign: 'center', lineHeight: 17, marginTop: 6, marginBottom: 14, paddingHorizontal: 6,
  },
  stockBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderRadius: 8, backgroundColor: GOLD, paddingVertical: 10, marginBottom: 14,
  },
  stockBtnText: { color: '#0B0906', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1.6 },
  featured: {
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
    backgroundColor: 'rgba(212,168,83,0.06)', padding: 12, marginBottom: 14,
  },
  featuredTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2, textAlign: 'center',
  },
  featuredSub: {
    color: 'rgba(237,224,196,0.6)', fontFamily: 'Inter_400Regular', fontSize: 10.5,
    lineHeight: 15, textAlign: 'center', marginTop: 5,
  },
  category: {
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    backgroundColor: 'rgba(5,3,0,0.82)', padding: 12, marginBottom: 10,
  },
  categoryHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  categoryLabel: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 11.5, letterSpacing: 2 },
  emptyRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 9 },
  emptyRowText: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_400Regular', fontSize: 10.5, flex: 1,
  },

  // Product rows
  productRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(200,165,60,0.14)',
    backgroundColor: 'rgba(10,8,4,0.7)', padding: 8,
  },
  productPhoto: { width: 54, height: 54, borderRadius: 6, backgroundColor: '#111' },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  productInfo: { flex: 1, gap: 2 },
  productName: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 0.6 },
  productDesc: { color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_400Regular', fontSize: 10, lineHeight: 14 },
  productPrice: { color: GOLD, fontFamily: 'Inter_500Medium', fontSize: 11, marginTop: 1 },
  productAdmin: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingTop: 2 },

  // Locker
  lockerRow: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 6 },
  lockerRowText: { color: 'rgba(237,224,196,0.75)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 0.8 },
  lockerEmpty: { alignItems: 'center', gap: 10, paddingVertical: 22 },
  lockerEmptyText: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, opacity: 0.5, textAlign: 'center',
  },

  // Issued records
  recordRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginTop: 8, marginLeft: 20, paddingVertical: 6, paddingHorizontal: 10,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)',
    backgroundColor: 'rgba(212,168,83,0.05)',
  },
  recordTitle: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, letterSpacing: 0.6 },
  recordNotes: { color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 },
  recordPrice: { color: GOLD, fontFamily: 'Inter_500Medium', fontSize: 10, marginTop: 2 },
  recordDate:  { color: 'rgba(212,168,83,0.6)', fontFamily: 'Inter_400Regular', fontSize: 9, marginTop: 3 },

  viewerBox: { marginBottom: 12 },
  issueBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    alignSelf: 'stretch', borderRadius: 8, backgroundColor: GOLD,
    paddingVertical: 10, marginBottom: 12,
  },
  issueBtnText: { color: '#0B0906', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2 },

  // Issue modal
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.82)',
    justifyContent: 'center', padding: SIDE,
  },
  modalCard: {
    maxHeight: '86%', borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.4)', backgroundColor: '#0C0A06', padding: 16,
  },
  modalTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 2.5,
    textAlign: 'center', marginBottom: 10,
  },
  fieldLabel: {
    color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 10, letterSpacing: 1.5, marginTop: 12, marginBottom: 6,
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  searchInput: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)',
    backgroundColor: 'rgba(5,3,0,0.6)', color: CREAM,
    fontFamily: 'Inter_400Regular', fontSize: 11,
    paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
  },
  chip: {
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)',
    paddingHorizontal: 10, paddingVertical: 6, maxWidth: '100%',
  },
  chipActive: { backgroundColor: 'rgba(212,168,83,0.18)', borderColor: GOLD },
  chipText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Inter_500Medium', fontSize: 10.5 },
  chipTextActive: { color: CREAM },
  input: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)',
    backgroundColor: 'rgba(255,255,255,0.03)', color: CREAM,
    paddingHorizontal: 10, paddingVertical: 9,
    fontFamily: 'Inter_400Regular', fontSize: 12,
  },
  inputMulti: { minHeight: 64, textAlignVertical: 'top' },
  modalCancel: { alignItems: 'center', paddingVertical: 12 },
  modalCancelText: {
    color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 11, letterSpacing: 2,
  },

  footerText: {
    color: 'rgba(237,224,196,0.35)', fontFamily: 'Inter_400Regular', fontSize: 9.5,
    textAlign: 'center', letterSpacing: 0.5, marginTop: 12,
  },

  // Product sheet
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '88%',
    backgroundColor: '#0C0A06',
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)',
    padding: SIDE, paddingBottom: 28,
  },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  sheetTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 2 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14,
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    padding: 10, backgroundColor: 'rgba(212,168,83,0.04)',
  },
  switchLabel: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.2 },
  switchHint: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 },
  photoBtn: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    backgroundColor: 'rgba(255,255,255,0.02)', overflow: 'hidden',
  },
  photoBtnEmpty: { alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 22 },
  photoBtnText: { color: 'rgba(212,168,83,0.7)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1 },
  photoPreview: { width: '100%', height: 150 },
  photoHint: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_400Regular', fontSize: 9.5, marginTop: 5,
  },
});
