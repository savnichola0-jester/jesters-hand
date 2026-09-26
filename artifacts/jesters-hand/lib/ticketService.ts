/**
 * Firestore + Storage helpers for the Ticket screen.
 * All functions are async and safe to call from React components.
 */
import { doc, getDoc, setDoc, updateDoc, collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { deleteMediaObject, replitMediaPath, uploadMedia } from './mediaService';

export interface TicketData {
  jokerId?: string;
  name?: string;
  street?: string;
  role?: string;
  suit?: string;
  state?: string;
  country?: string;
  firstjest?: string;
  patterns?: string;
  coffee?: string;
  donut?: string;
  juice?: string;
  codex?: string;
  creed?: string;
  streetart?: string;
  haunting?: string;
  static?: string;
  mugUrl?: string;
  adminPhotoUrl?: string;
  /** Legacy field cleared when a gallery admin card is uploaded. */
  adminCardId?: string;
  filed?: boolean;
  filedAt?: number;
  suspended?: boolean;
}

// ── Read ──────────────────────────────────────────────────────────────────────
export async function getTicket(uid: string): Promise<TicketData | null> {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? (snap.data() as TicketData) : null;
}

// ── Save (partial update) ──────────────────────────────────────────────────────
export async function saveTicket(uid: string, data: Partial<TicketData>): Promise<void> {
  const ref_ = doc(db, 'users', uid);
  const snap = await getDoc(ref_);
  if (snap.exists()) {
    await updateDoc(ref_, data as Record<string, unknown>);
  } else {
    await setDoc(ref_, data);
  }
}

// ── Upload mug photo ──────────────────────────────────────────────────────────
export async function uploadMug(
  uid: string,
  localUri: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const path = `users/${uid}/mug-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const result = await uploadMedia(localUri, path, 'image/jpeg', onProgress);
  if (!result.url?.startsWith('jhmedia://')) throw new Error('Media upload did not return a portable public photo URL.');
  return result.url;
}

// ── Upload admin photo ────────────────────────────────────────────────────────
export async function uploadAdminPhoto(
  uid: string,
  localUri: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const path = `users/${uid}/admin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}.jpg`;
  const result = await uploadMedia(localUri, path, 'image/jpeg', onProgress);
  if (!result.url?.startsWith('jhmedia://')) throw new Error('Media upload did not return a portable public photo URL.');
  return result.url;
}

// ── Get ALL members for The Hand directory (filed or not) ─────────────────────
export async function getAllMembers(): Promise<Array<TicketData & { uid: string }>> {
  const snap = await getDocs(collection(db, 'users'));
  const members = snap.docs.map(d => ({ uid: d.id, ...(d.data() as TicketData) }));
  // Sort by jokerId ascending
  members.sort((a, b) => (a.jokerId ?? '').localeCompare(b.jokerId ?? ''));
  return members;
}

// ── Delete mug ────────────────────────────────────────────────────────────────
export async function deleteMug(uid: string, currentUrl?: string | null): Promise<void> {
  const path = replitMediaPath(currentUrl);
  if (path && path.startsWith(`users/${uid}/mug-`) && path.endsWith('.jpg')) {
    await deleteMediaObject(path);
  }
}

export async function deleteAdminPhoto(uid: string, currentUrl?: string | null): Promise<void> {
  const path = replitMediaPath(currentUrl);
  if (path && path.startsWith(`users/${uid}/admin-`) && path.endsWith('.jpg')) {
    await deleteMediaObject(path);
  }
}
