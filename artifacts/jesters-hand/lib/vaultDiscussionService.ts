// ── Vault discussion service ──────────────────────────────────────────────────
// Inkitt-style reading feedback on Vault/Chamber entries:
//   • reactions on the entry itself (vault/{entryId}.reactions)
//   • comments on the entry, optionally pinned to a PDF page
//     (vault/{entryId}/comments — counter-verified commentCount like Ante)
//   • one review per member per entry  (vault/{entryId}/reviews/{uid})
//   • one overall book/saga review per member (bookReviews/{uid})
// Everything is visible to every active member; deletes are archive-first.

import {
  collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch,
  runTransaction, query, where, orderBy, onSnapshot,
  serverTimestamp, Timestamp, arrayUnion, arrayRemove, increment,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { writeNotification } from './notificationService';
import type { VaultSection } from './vaultService';
import { recordDealActivity } from './dealService';

/** What a comment/mark is anchored to inside a manuscript. */
export type VaultTargetType = 'chapter' | 'paragraph';

export interface VaultComment {
  id: string;
  senderUid: string;
  jokerId: string;
  text: string;
  /** 1-based PDF page the comment is pinned to; absent = the whole work. */
  page?: number;
  /** Optional short quote of the passage/paragraph the comment refers to. */
  quote?: string;
  /** Structured anchor: 'chapter' or 'paragraph' within the manuscript. */
  targetType?: VaultTargetType;
  /** Deterministic id of the anchored target (chapter/paragraph). */
  targetId?: string;
  /** 1-based start page of the chapter the target belongs to. */
  chapterStartPage?: number;
  reactions: Record<string, string[]>;
  createdAt: Timestamp | null;
}

/**
 * A member's emoji marks on one manuscript target (a chapter or paragraph).
 * One deterministic doc per user per target: id == `${targetId}__${uid}`.
 * The doc is deleted the moment its emoji list becomes empty, so no empty
 * shells linger and paragraph docs are never pre-created.
 */
export interface VaultMark {
  id: string;
  uid: string;
  jokerId: string;
  targetId: string;
  targetType: VaultTargetType;
  page: number;
  chapterStartPage: number;
  quote?: string;
  emojis: string[];
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

/** Emoji allowlist — keep in sync with REACTION_EMOJIS in the app + rules. */
export const VAULT_MARK_EMOJIS = [
  '👍', '👎', '👑', '🎭', '😢', '😂', '🖤', '🤍', '🔥', '🗡',
  '👀', '🃏', '♠️', '♣️', '♥️', '♦️', '🐾',
] as const;

export interface VaultReview {
  id: string;            // == reviewer uid
  uid: string;
  jokerId: string;
  rating: number;        // 1–5
  text: string;
  createdAt: Timestamp | null;
  updatedAt: Timestamp | null;
}

const commentsCol = (entryId: string) => collection(db, 'vault', entryId, 'comments');
const commentDoc  = (entryId: string, commentId: string) =>
  doc(db, 'vault', entryId, 'comments', commentId);
const reviewsCol  = (entryId: string) => collection(db, 'vault', entryId, 'reviews');
const marksCol    = (entryId: string) => collection(db, 'vault', entryId, 'marks');
const markDoc     = (entryId: string, markId: string) =>
  doc(db, 'vault', entryId, 'marks', markId);
const entryDoc    = (entryId: string) => doc(db, 'vault', entryId);

/** Deterministic mark doc id — one per user per target. */
export function vaultMarkId(targetId: string, uid: string): string {
  return `${targetId}__${uid}`;
}

// ── Notifications (best-effort, never block the action) ──────────────────────

function notifyVault(
  recipientUid: string,
  actorUid: string,
  type: 'vault_comment' | 'vault_review',
  entry: { id: string; title: string; section: VaultSection },
  text: string,
): void {
  if (!recipientUid || recipientUid === actorUid) return;
  writeNotification(recipientUid, {
    type,
    fromUid: actorUid,
    vaultEntryId: entry.id,
    vaultSection: entry.section,
    text,
  }).catch(() => {});
}

function entryLabel(title: string): string {
  const t = title.trim();
  return t ? `"${t.length > 40 ? t.slice(0, 40) + '…' : t}"` : 'a chapter';
}

// ── Entry reactions ───────────────────────────────────────────────────────────

export async function toggleVaultEntryReaction(
  entryId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(entryDoc(entryId));
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    added = !hasReacted;
    tx.update(entryDoc(entryId), {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (added) void recordDealActivity('vault_mark', uid, `vault:${entryId}:entry:${emoji}`);
}

// ── Comments ──────────────────────────────────────────────────────────────────

export function listenVaultComments(
  entryId: string,
  cb: (comments: VaultComment[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const q = query(commentsCol(entryId), orderBy('createdAt', 'asc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        senderUid: data.senderUid,
        jokerId: data.jokerId ?? '',
        text: data.text ?? '',
        ...(typeof data.page === 'number' ? { page: data.page } : {}),
        ...(typeof data.quote === 'string' && data.quote ? { quote: data.quote } : {}),
        ...(data.targetType === 'chapter' || data.targetType === 'paragraph'
          ? { targetType: data.targetType } : {}),
        ...(typeof data.targetId === 'string' && data.targetId ? { targetId: data.targetId } : {}),
        ...(typeof data.chapterStartPage === 'number'
          ? { chapterStartPage: data.chapterStartPage } : {}),
        reactions: data.reactions ?? {},
        createdAt: data.createdAt ?? null,
      } as VaultComment;
    }));
  }, e => onError?.(e));
}

/** Add a comment (optionally pinned to a PDF page); bumps commentCount atomically. */
export async function createVaultComment(
  entry: { id: string; title: string; section: VaultSection; createdBy: string },
  who: { uid: string; jokerId: string },
  text: string,
  page?: number | null,
  quote?: string | null,
  target?: {
    targetType: VaultTargetType;
    targetId: string;
    chapterStartPage: number;
  } | null,
): Promise<void> {
  const batch = writeBatch(db);
  const cRef = doc(commentsCol(entry.id));
  const quoteTrimmed = quote?.trim().slice(0, 300);
  // Structured anchor is optional; when present, all three fields travel
  // together so the comment can be located deterministically in the reader.
  const targetOk = !!target
    && (target.targetType === 'chapter' || target.targetType === 'paragraph')
    && typeof target.targetId === 'string' && target.targetId.length > 0
    && target.targetId.length <= 200
    && typeof target.chapterStartPage === 'number' && target.chapterStartPage >= 1;
  batch.set(cRef, {
    senderUid: who.uid,
    jokerId: who.jokerId,
    text: text.trim(),
    ...(typeof page === 'number' && page >= 1 ? { page: Math.floor(page) } : {}),
    ...(quoteTrimmed ? { quote: quoteTrimmed } : {}),
    ...(targetOk
      ? {
          targetType: target!.targetType,
          targetId: target!.targetId,
          chapterStartPage: Math.floor(target!.chapterStartPage),
        }
      : {}),
    reactions: {},
    createdAt: serverTimestamp(),
  });
  // countedCommentId ties the counter bump to this exact comment (rules-verified).
  batch.update(entryDoc(entry.id), {
    commentCount: increment(1),
    countedCommentId: cRef.id,
  });
  await batch.commit();
  notifyVault(
    entry.createdBy, who.uid, 'vault_comment', entry,
    `commented on ${entryLabel(entry.title)}`,
  );
}

export async function toggleVaultCommentReaction(
  entryId: string,
  commentId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  let added = false;
  await runTransaction(db, async tx => {
    const ref = commentDoc(entryId, commentId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    added = !hasReacted;
    tx.update(ref, {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (added) {
    void recordDealActivity(
      'vault_mark',
      uid,
      `vault:${entryId}:comment:${commentId}:${emoji}`,
    );
  }
}

// ── Marks (per-user emoji reactions on a chapter/paragraph target) ────────────

function mapMark(id: string, data: any): VaultMark {
  return {
    id,
    uid: data.uid ?? '',
    jokerId: data.jokerId ?? '',
    targetId: data.targetId ?? '',
    targetType: data.targetType === 'paragraph' ? 'paragraph' : 'chapter',
    page: typeof data.page === 'number' ? data.page : 0,
    chapterStartPage: typeof data.chapterStartPage === 'number' ? data.chapterStartPage : 0,
    ...(typeof data.quote === 'string' && data.quote ? { quote: data.quote } : {}),
    emojis: Array.isArray(data.emojis) ? data.emojis : [],
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/** Live marks for one manuscript target across all members. */
export function listenVaultMarks(
  entryId: string,
  targetId: string,
  cb: (marks: VaultMark[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const q = query(marksCol(entryId), where('targetId', '==', targetId));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => mapMark(d.id, d.data())));
  }, e => onError?.(e));
}

/**
 * Toggle one emoji on the caller's mark for a target. Creates the mark doc on
 * first emoji, updates the emoji list on subsequent toggles, and DELETES the
 * doc when the last emoji is removed — no empty shells are ever left behind,
 * and paragraph marks are only materialized when a member actually reacts.
 */
export async function toggleVaultMark(
  entryId: string,
  who: { uid: string; jokerId: string },
  target: {
    targetId: string;
    targetType: VaultTargetType;
    page: number;
    chapterStartPage: number;
    quote?: string | null;
  },
  emoji: string,
): Promise<void> {
  if (!(VAULT_MARK_EMOJIS as readonly string[]).includes(emoji)) return;
  const ref = markDoc(entryId, vaultMarkId(target.targetId, who.uid));
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) {
      added = true;
      // First reaction on this target — materialize the mark.
      tx.set(ref, {
        uid: who.uid,
        jokerId: who.jokerId,
        targetId: target.targetId,
        targetType: target.targetType,
        page: Math.max(1, Math.floor(target.page || 1)),
        chapterStartPage: Math.max(1, Math.floor(target.chapterStartPage || 1)),
        ...(target.quote?.trim() ? { quote: target.quote.trim().slice(0, 300) } : {}),
        emojis: [emoji],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      return;
    }
    const current: string[] = Array.isArray(snap.data().emojis) ? snap.data().emojis : [];
    const has = current.includes(emoji);
    added = !has;
    const next = has ? current.filter(e => e !== emoji) : [...current, emoji];
    if (next.length === 0) {
      // Last emoji removed — drop the doc entirely.
      tx.delete(ref);
    } else {
      tx.update(ref, { emojis: next, updatedAt: serverTimestamp() });
    }
  });
  if (added) {
    void recordDealActivity(
      'vault_mark',
      who.uid,
      `vault:${entryId}:target:${target.targetId}:${emoji}`,
    );
  }
}

/** Delete a comment (author or admin) — archive-first, counter kept honest. */
export async function deleteVaultComment(
  entry: { id: string; title: string },
  commentId: string,
): Promise<void> {
  const cRef = commentDoc(entry.id, commentId);
  const snap = await getDoc(cRef);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'vault_comment',
      section: 'The Vault',
      title: (data.text ?? '').slice(0, 60),
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `vault/${entry.id}/comments/${commentId}`,
      payload: data,
    });
  }
  const batch = writeBatch(db);
  batch.delete(cRef);
  batch.update(entryDoc(entry.id), {
    commentCount: increment(-1),
    countedCommentId: commentId,
  });
  await batch.commit();
}

// ── Reviews (per entry) ───────────────────────────────────────────────────────

function mapReview(id: string, data: any): VaultReview {
  return {
    id,
    uid: data.uid ?? id,
    jokerId: data.jokerId ?? '',
    rating: typeof data.rating === 'number' ? data.rating : 0,
    text: data.text ?? '',
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

export function listenVaultReviews(
  entryId: string,
  cb: (reviews: VaultReview[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const q = query(reviewsCol(entryId), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => mapReview(d.id, d.data())));
  }, e => onError?.(e));
}

/**
 * Create or update the caller's review of one entry (one per member).
 * The entry's counter-verified review tallies (reviewCount / ratingSum) move
 * in the same atomic batch, so chapter cards can show ★ averages instantly.
 */
export async function saveVaultReview(
  entry: { id: string; title: string; section: VaultSection; createdBy: string },
  who: { uid: string; jokerId: string },
  rating: number,
  text: string,
): Promise<void> {
  const ref = doc(db, 'vault', entry.id, 'reviews', who.uid);
  const existing = await getDoc(ref);
  const newRating = Math.min(5, Math.max(1, Math.round(rating)));
  const oldRating = existing.exists() && typeof existing.data().rating === 'number'
    ? existing.data().rating : 0;
  const batch = writeBatch(db);
  batch.set(ref, {
    uid: who.uid,
    jokerId: who.jokerId,
    rating: newRating,
    text: text.trim(),
    ...(existing.exists()
      ? { createdAt: existing.data().createdAt ?? serverTimestamp() }
      : { createdAt: serverTimestamp() }),
    updatedAt: serverTimestamp(),
  });
  if (!existing.exists()) {
    // countedReviewId ties the tally bump to this exact review (rules-verified).
    batch.update(entryDoc(entry.id), {
      reviewCount: increment(1),
      ratingSum: increment(newRating),
      countedReviewId: who.uid,
    });
  } else if (newRating !== oldRating) {
    batch.update(entryDoc(entry.id), {
      ratingSum: increment(newRating - oldRating),
      countedReviewId: who.uid,
    });
  }
  await batch.commit();
  if (!existing.exists()) {
    notifyVault(
      entry.createdBy, who.uid, 'vault_review', entry,
      `left a ${Math.round(rating)}-star review on ${entryLabel(entry.title)}`,
    );
  }
}

/** Delete a review (owner or admin) — archive-first, tallies kept honest. */
export async function deleteVaultReview(entryId: string, reviewUid: string): Promise<void> {
  const ref = doc(db, 'vault', entryId, 'reviews', reviewUid);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const data = snap.data() as any;
  const { archiveItem } = await import('./archiveService');
  await archiveItem({
    type: 'vault_review',
    section: 'The Vault',
    title: (data.text ?? '').slice(0, 60),
    ownerUid: data.uid ?? reviewUid,
    deletedByUid: auth.currentUser?.uid ?? '',
    restorePath: `vault/${entryId}/reviews/${reviewUid}`,
    payload: data,
  });
  const rating = typeof data.rating === 'number' ? data.rating : 0;
  const batch = writeBatch(db);
  batch.delete(ref);
  batch.update(entryDoc(entryId), {
    reviewCount: increment(-1),
    ratingSum: increment(-rating),
    countedReviewId: reviewUid,
  });
  await batch.commit();
}

// ── Overall book/saga review ──────────────────────────────────────────────────

export function listenBookReviews(
  cb: (reviews: VaultReview[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const q = query(collection(db, 'bookReviews'), orderBy('updatedAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => mapReview(d.id, d.data())));
  }, e => onError?.(e));
}

/** Create or update the caller's overall saga review; notifies the Jester once. */
export async function saveBookReview(
  who: { uid: string; jokerId: string },
  rating: number,
  text: string,
  notifyUid?: string,
): Promise<void> {
  const ref = doc(db, 'bookReviews', who.uid);
  const existing = await getDoc(ref);
  await setDoc(ref, {
    uid: who.uid,
    jokerId: who.jokerId,
    rating: Math.min(5, Math.max(1, Math.round(rating))),
    text: text.trim(),
    ...(existing.exists()
      ? { createdAt: existing.data().createdAt ?? serverTimestamp() }
      : { createdAt: serverTimestamp() }),
    updatedAt: serverTimestamp(),
  });
  if (!existing.exists()) {
    // Fall back to looking up the Jester directly if no uid was provided
    // (e.g. reviewing before any chapter loaded).
    let target = notifyUid;
    if (!target) {
      try {
        const { query: q2, where, limit } = await import('firebase/firestore');
        const admins = await getDocs(
          q2(collection(db, 'users'), where('isAdmin', '==', true), limit(1)),
        );
        target = admins.docs[0]?.id;
      } catch { /* best-effort */ }
    }
    if (target && target !== who.uid) {
      writeNotification(target, {
        type: 'vault_review',
        fromUid: who.uid,
        vaultSection: 'book',
        text: `left a ${Math.round(rating)}-star review of the saga`,
      }).catch(() => {});
    }
  }
}

/** Delete a book review (owner or admin) — archive-first. */
export async function deleteBookReview(reviewUid: string): Promise<void> {
  const ref = doc(db, 'bookReviews', reviewUid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'book_review',
      section: 'The Saga',
      title: (data.text ?? '').slice(0, 60),
      ownerUid: data.uid ?? reviewUid,
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `bookReviews/${reviewUid}`,
      payload: data,
    });
  }
  await deleteDoc(ref);
}

/**
 * Snapshot a subcollection (comments or reviews) for archiving with a parent.
 * Fails loudly: an entry must never be deleted while its discussion could not
 * be read for the archive (silent data loss otherwise).
 */
export async function snapshotVaultSub(
  entryId: string,
  sub: 'comments' | 'reviews' | 'marks',
): Promise<{ id: string; fields: Record<string, any> }[]> {
  const snap = await getDocs(collection(db, 'vault', entryId, sub));
  return snap.docs.map(d => ({ id: d.id, fields: d.data() as Record<string, any> }));
}
