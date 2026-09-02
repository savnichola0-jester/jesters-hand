// ── Recruit service ───────────────────────────────────────────────────────────
// Recruit/Verdict posts are admin-designed layouts built on the official
// template images. The design itself (text boxes + photo frames) is stored as
// JSON in Firestore; uploaded photos live in PRIVATE Firebase Storage under
// recruitPosts/{postId}/img_… and are fetched with the caller's short-lived
// ID token — no permanent URL ever exists. Storage rules re-verify (admin OR
// post published) on every request, exactly like the Vault.

import {
  collection, doc, onSnapshot, query, where,
  setDoc, updateDoc, deleteDoc, getDoc, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, deleteObject } from 'firebase/storage';
import { db, storage, auth } from './firebase';
import { fetchProtectedDataUri } from './vaultService';
import { broadcastToActiveMembers } from './notificationService';

export type RecruitSection = 'recruit' | 'verdict';
export type RecruitStatus = 'draft' | 'published';

// ── Design elements ───────────────────────────────────────────────────────────
// Coordinates are in template units: the design space is 1024 × 1536 (the
// template image size), so a design renders identically at any screen size.

export const DESIGN_W = 1024;
export const DESIGN_H = 1536;

export type FontKey = 'serif' | 'headline' | 'typewriter' | 'editorial';
export type TextAlign = 'left' | 'center' | 'right';

interface ElementBase {
  id: string;
  x: number;      // top-left, design units
  y: number;
  w: number;
  h: number;
  rot: number;    // degrees
  z: number;      // stacking order (higher = in front)
}

export interface TextElement extends ElementBase {
  type: 'text';
  text: string;
  font: FontKey;
  size: number;          // font size in design units
  color: string;
  align: TextAlign;
  lineSpacing: number;   // multiplier, e.g. 1.2
  letterSpacing: number; // design units
  bold: boolean;
  italic: boolean;
  uppercase: boolean;
}

export interface PhotoElement extends ElementBase {
  type: 'photo';
  /** Private storage path (recruitPosts/{postId}/img_…) once uploaded. */
  path?: string;
  /** Local uri while editing, before/alongside upload. */
  localUri?: string;
  /** Crop = how the image sits inside its clipping frame. */
  imgScale: number;  // >= 1 fills the frame; larger zooms in
  imgDX: number;     // pan offset inside the frame, design units
  imgDY: number;
}

export type DesignElement = TextElement | PhotoElement;

export interface RecruitPost {
  id: string;
  section: RecruitSection;
  status: RecruitStatus;
  title: string;
  /** JSON-encoded DesignElement[] */
  design: string;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const str = (v: unknown, fallback: string, maxLen: number): string =>
  typeof v === 'string' ? v.slice(0, maxLen) : fallback;

/** Parse + strictly validate a design JSON. Invalid elements are dropped and
 *  every field is clamped/defaulted so bad data can never crash the renderer. */
export function parseDesign(json: string): DesignElement[] {
  let arr: unknown;
  try { arr = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out: DesignElement[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const base = {
      id: str(e.id, '', 60) || `el_${out.length}_${Math.random().toString(36).slice(2, 7)}`,
      x: num(e.x, 0, -DESIGN_W, DESIGN_W * 2),
      y: num(e.y, 0, -DESIGN_H, DESIGN_H * 2),
      w: num(e.w, 200, 20, DESIGN_W * 2),
      h: num(e.h, 100, 20, DESIGN_H * 2),
      rot: num(e.rot, 0, -360, 360),
      z: num(e.z, 0, -1000, 1000),
    };
    if (e.type === 'text') {
      out.push({
        ...base, type: 'text',
        text: str(e.text, '', 5000),
        font: (['serif', 'headline', 'typewriter', 'editorial'] as const).includes(e.font as FontKey)
          ? e.font as FontKey : 'serif',
        size: num(e.size, 44, 6, 400),
        color: /^#[0-9a-fA-F]{3,8}$/.test(String(e.color)) ? String(e.color) : '#1A1512',
        align: e.align === 'left' || e.align === 'right' ? e.align : 'center',
        lineSpacing: num(e.lineSpacing, 1.2, 0.5, 4),
        letterSpacing: num(e.letterSpacing, 0, -5, 60),
        bold: e.bold === true,
        italic: e.italic === true,
        uppercase: e.uppercase === true,
      });
    } else if (e.type === 'photo') {
      const path = typeof e.path === 'string' && /^recruitPosts\/[\w-]+\/img_[A-Za-z0-9]+$/.test(e.path)
        ? e.path : undefined;
      out.push({
        ...base, type: 'photo',
        path,
        imgScale: num(e.imgScale, 1, 1, 8),
        imgDX: num(e.imgDX, 0, -DESIGN_W * 2, DESIGN_W * 2),
        imgDY: num(e.imgDY, 0, -DESIGN_H * 2, DESIGN_H * 2),
      });
    }
  }
  return out;
}

// ── Listeners ─────────────────────────────────────────────────────────────────

export function listenRecruitSection(
  section: RecruitSection,
  isAdmin: boolean,
  onPosts: (posts: RecruitPost[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const base = collection(db, 'recruitPosts');
  const q = isAdmin
    ? query(base, where('section', '==', section))
    : query(base, where('section', '==', section), where('status', '==', 'published'));
  return onSnapshot(q, snap => {
    const posts = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<RecruitPost, 'id'>) }));
    posts.sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0));
    onPosts(posts);
  }, e => onError?.(e));
}

// ── CRUD (admin only — enforced by rules) ─────────────────────────────────────

export function newPostId(): string {
  return doc(collection(db, 'recruitPosts')).id;
}

export async function saveRecruitPost(
  postId: string,
  section: RecruitSection,
  uid: string,
  title: string,
  elements: DesignElement[],
  status: RecruitStatus,
  isNew: boolean,
): Promise<void> {
  const before = isNew ? null : await getDoc(doc(db, 'recruitPosts', postId));
  // Strip transient local uris before persisting.
  const clean = elements.map(el =>
    el.type === 'photo' ? { ...el, localUri: undefined } : el);
  const data = {
    section,
    status,
    title: title.trim() || (section === 'recruit' ? 'Untitled Recruit' : 'Untitled Verdict'),
    design: JSON.stringify(clean),
    createdBy: uid,
    updatedAt: serverTimestamp(),
    ...(isNew ? { createdAt: serverTimestamp() } : {}),
  };
  if (isNew) await setDoc(doc(db, 'recruitPosts', postId), data);
  else await updateDoc(doc(db, 'recruitPosts', postId), {
    status: data.status, title: data.title, design: data.design, updatedAt: data.updatedAt,
  });
  if (status === 'published' && (isNew || (before ? before.data()?.status !== 'published' : true))) {
    void broadcastToActiveMembers(uid, {
      type: 'announcement',
      title: section === 'recruit' ? "A new hand's being dealt." : "The verdict's in.",
      fromUid: uid,
      text: section === 'recruit' ? 'posted a new event.' : 'posted a new verdict.',
    }).catch(() => {});
  }
}

export async function setRecruitStatus(postId: string, status: RecruitStatus): Promise<void> {
  const before = await getDoc(doc(db, 'recruitPosts', postId));
  await updateDoc(doc(db, 'recruitPosts', postId), { status, updatedAt: serverTimestamp() });
  if (status === 'published' && before.exists() && before.data().status !== 'published') {
    const uid = auth.currentUser?.uid;
    const section = before.data().section as RecruitSection;
    if (uid) {
      void broadcastToActiveMembers(uid, {
        type: 'announcement',
        title: section === 'recruit' ? "A new hand's being dealt." : "The verdict's in.",
        fromUid: uid,
        text: section === 'recruit' ? 'posted a new event.' : 'posted a new verdict.',
      }).catch(() => {});
    }
  }
}

export async function deleteRecruitPost(post: RecruitPost): Promise<void> {
  // Archive FIRST. Photos are intentionally KEPT in storage — they stay with
  // the archived post until the admin permanently deletes it from Archives.
  const snap = await getDoc(doc(db, 'recruitPosts', post.id));
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'recruit_post',
      section: 'Recruit',
      title: `Recruit post (${data.status ?? 'draft'})`,
      ownerUid: auth.currentUser?.uid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `recruitPosts/${post.id}`,
      payload: data,
    });
  }
  await deleteDoc(doc(db, 'recruitPosts', post.id));
}

// ── Photos ────────────────────────────────────────────────────────────────────

export async function uploadRecruitPhoto(postId: string, localUri: string, mime?: string): Promise<string> {
  const imgId = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const path = `recruitPosts/${postId}/${imgId}`;
  const res = await fetch(localUri);
  const blob = await res.blob();
  const task = uploadBytesResumable(ref(storage, path), blob, { contentType: mime ?? 'image/jpeg' });
  await new Promise<void>((resolve, reject) => {
    task.on('state_changed', undefined, reject, () => resolve());
  });
  return path;
}

export async function deleteRecruitPhoto(path: string): Promise<void> {
  await deleteObject(ref(storage, path)).catch(() => {});
}

// Simple in-memory cache so cards/viewer don't refetch the same photo bytes.
const photoCache = new Map<string, Promise<string>>();

export function getRecruitPhotoUri(path: string): Promise<string> {
  let p = photoCache.get(path);
  if (!p) {
    p = fetchProtectedDataUri(path, 'image/jpeg').catch(e => {
      photoCache.delete(path);
      throw e;
    });
    photoCache.set(path, p);
  }
  return p;
}
