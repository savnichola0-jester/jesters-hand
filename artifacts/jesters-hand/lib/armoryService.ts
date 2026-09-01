// ── Armory service ────────────────────────────────────────────────────────────
// The Armory is the member-only issued-equipment catalog on the Uniform
// screen. Products live in Firestore `armoryProducts/{productId}` (admin-only
// writes, member reads) and photos in PRIVATE Firebase Storage under
// armoryProducts/{productId}/photo — never exposed through permanent or
// tokenized download URLs. Members fetch photo bytes via the authenticated
// Storage REST endpoint (see vaultService.fetchProtectedImage), and Storage
// rules re-verify on every request that the product doc still exists.

import {
  collection, doc, onSnapshot,
  setDoc, updateDoc, deleteDoc, getDoc,
  serverTimestamp, Timestamp, deleteField,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, deleteObject } from 'firebase/storage';
import { db, storage, auth } from './firebase';

/** Raw category values stored on products. The Uniform screen maps these to
 *  display names (Uniforms / Issued Gear / …) via CATEGORY_DISPLAY. */
export type ArmoryCategory = 'Apparel' | 'Accessories' | 'Books' | 'Art Prints' | 'Other';

export const ARMORY_CATEGORIES: ArmoryCategory[] = [
  'Apparel', 'Accessories', 'Books', 'Art Prints', 'Other',
];

export interface ArmoryProduct {
  id: string;
  name: string;
  category: ArmoryCategory;
  /** Display price, e.g. "$45" — issued equipment, not a checkout amount. */
  price: string;
  description?: string;
  /** Signed / limited-edition items shown under "Issued Artifacts". */
  artifact: boolean;
  /** Private storage path of the product photo. */
  photoPath?: string;
  /** Shopify product handle for buy-online matching (admin-set, optional). */
  shopifyHandle?: string;
  order: number;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface ArmoryProductInput {
  name: string;
  category: ArmoryCategory;
  price: string;
  description?: string;
  artifact?: boolean;
  order?: number | null;
  shopifyHandle?: string;
}

export interface ArmoryPhotoPick {
  uri: string;
  mimeType?: string;
}

/** Listen to the full catalog, sorted by display order then newest first. */
export function listenArmoryProducts(
  onProducts: (products: ArmoryProduct[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  return onSnapshot(collection(db, 'armoryProducts'), snap => {
    const products = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<ArmoryProduct, 'id'>) }));
    products.sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) ||
      (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    onProducts(products);
  }, e => onError?.(e));
}

async function uploadPhoto(path: string, photo: ArmoryPhotoPick): Promise<void> {
  const res = await fetch(photo.uri);
  const blob = await res.blob();
  const task = uploadBytesResumable(
    ref(storage, path), blob, { contentType: photo.mimeType ?? 'image/jpeg' });
  await new Promise<void>((resolve, reject) => {
    task.on('state_changed', undefined, reject, () => resolve());
  });
}

function buildFields(input: ArmoryProductInput) {
  return {
    name: input.name.trim(),
    category: input.category,
    price: input.price.trim(),
    artifact: input.artifact ?? false,
    order: input.order ?? 0,
  };
}

/** Create a product: upload the photo (if any) first, then write the doc. */
export async function addArmoryProduct(
  uid: string,
  input: ArmoryProductInput,
  photo?: ArmoryPhotoPick | null,
): Promise<string> {
  const productRef = doc(collection(db, 'armoryProducts'));
  let photoPath: string | undefined;
  if (photo) {
    photoPath = `armoryProducts/${productRef.id}/photo`;
    await uploadPhoto(photoPath, photo);
  }
  await setDoc(productRef, {
    ...buildFields(input),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    ...(input.shopifyHandle?.trim() ? { shopifyHandle: input.shopifyHandle.trim().toLowerCase() } : {}),
    ...(photoPath ? { photoPath } : {}),
    createdBy: uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  return productRef.id;
}

/** Update a product's fields; optionally replace the photo in place. */
export async function updateArmoryProduct(
  product: ArmoryProduct,
  input: ArmoryProductInput,
  newPhoto?: ArmoryPhotoPick | null,
): Promise<void> {
  let photoPath = product.photoPath;
  if (newPhoto) {
    photoPath = `armoryProducts/${product.id}/photo`;
    await uploadPhoto(photoPath, newPhoto);
  }
  await updateDoc(doc(db, 'armoryProducts', product.id), {
    ...buildFields(input),
    description: input.description?.trim() ? input.description.trim() : deleteField(),
    shopifyHandle: input.shopifyHandle?.trim() ? input.shopifyHandle.trim().toLowerCase() : deleteField(),
    ...(photoPath ? { photoPath } : {}),
    updatedAt: serverTimestamp(),
  });
}

export async function deleteArmoryProduct(product: ArmoryProduct): Promise<void> {
  // Archive FIRST. The photo is intentionally KEPT in storage until the
  // admin permanently deletes the product from Archives.
  const snap = await getDoc(doc(db, 'armoryProducts', product.id));
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'armory_product',
      section: 'The Armory',
      title: data.name ?? '',
      ownerUid: data.createdBy ?? auth.currentUser?.uid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `armoryProducts/${product.id}`,
      payload: data,
    });
  }
  await deleteDoc(doc(db, 'armoryProducts', product.id));
}
