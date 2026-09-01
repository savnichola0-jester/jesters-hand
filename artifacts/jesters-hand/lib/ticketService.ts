/**
 * Firestore + Storage helpers for the Ticket screen.
 * All functions are async and safe to call from React components.
 */
import { doc, getDoc, setDoc, updateDoc, collection, query, where, orderBy, getDocs } from 'firebase/firestore';
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage';
import { db, storage } from '@/lib/firebase';

export interface TicketData {
  jokerId?: string;
  name?: string;
  street?: string;
  role?: string;
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
  filed?: boolean;
  filedAt?: number;
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
  const res  = await fetch(localUri);
  const blob = await res.blob();
  const path = `users/${uid}/mug.jpg`;
  const storageRef = ref(storage, path);
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, blob, { contentType: 'image/jpeg' });
    task.on(
      'state_changed',
      (snap) => onProgress && onProgress(snap.bytesTransferred / snap.totalBytes),
      reject,
      async () => {
        const url = await getDownloadURL(storageRef);
        resolve(url);
      }
    );
  });
}

// ── Upload admin photo ────────────────────────────────────────────────────────
export async function uploadAdminPhoto(
  uid: string,
  localUri: string,
  onProgress?: (pct: number) => void
): Promise<string> {
  const res  = await fetch(localUri);
  const blob = await res.blob();
  const path = `users/${uid}/admin.jpg`;
  const storageRef = ref(storage, path);
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, blob, { contentType: 'image/jpeg' });
    task.on(
      'state_changed',
      (snap) => onProgress && onProgress(snap.bytesTransferred / snap.totalBytes),
      reject,
      async () => {
        const url = await getDownloadURL(storageRef);
        resolve(url);
      }
    );
  });
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
export async function deleteMug(uid: string): Promise<void> {
  try {
    await deleteObject(ref(storage, `users/${uid}/mug.jpg`));
  } catch {
    // File may not exist — that's fine
  }
}
