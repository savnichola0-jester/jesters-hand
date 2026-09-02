import {
  arrayRemove, arrayUnion, collection, doc, increment, onSnapshot,
  orderBy, query, runTransaction, serverTimestamp, Timestamp, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';
import { recordDealActivity } from './dealService';

export const SOCIAL_REACTION_EMOJIS = [
  '👍', '👎', '👑', '🎭', '😢', '😂', '🖤', '🤍', '🔥',
  '🗡', '👀', '🃏', '♠️', '♣️', '♥️', '♦️', '🐾',
] as const;

export interface SocialComment {
  id: string;
  senderUid: string;
  senderJokerId: string;
  text: string;
  reactions: Record<string, string[]>;
  createdAt: Timestamp | null;
}

const parentRef = (path: string) => doc(db, path);
const commentsRef = (path: string) => collection(db, `${path}/comments`);

export function listenSocialComments(path: string, cb: (comments: SocialComment[]) => void): () => void {
  return onSnapshot(query(commentsRef(path), orderBy('createdAt', 'asc')), snap => {
    cb(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        senderUid: data.senderUid ?? '',
        senderJokerId: data.senderJokerId ?? '',
        text: data.text ?? '',
        reactions: data.reactions ?? {},
        createdAt: data.createdAt ?? null,
      };
    }));
  }, () => cb([]));
}

export async function toggleSocialReaction(path: string, uid: string, emoji: string): Promise<void> {
  const ref = parentRef(path);
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const has = (reactions[emoji] ?? []).includes(uid);
    added = !has;
    tx.update(ref, { [`reactions.${emoji}`]: has ? arrayRemove(uid) : arrayUnion(uid) });
  });
  if (added) void recordDealActivity('mark', uid, `social:${path}:${emoji}`);
}

export async function toggleSocialCommentReaction(
  path: string,
  commentId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const ref = doc(commentsRef(path), commentId);
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const has = (reactions[emoji] ?? []).includes(uid);
    added = !has;
    tx.update(ref, { [`reactions.${emoji}`]: has ? arrayRemove(uid) : arrayUnion(uid) });
  });
  if (added) void recordDealActivity('mark', uid, `social:${path}:comment:${commentId}:${emoji}`);
}

export async function createSocialComment(
  path: string,
  senderUid: string,
  senderJokerId: string,
  text: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return;
  const comment = doc(commentsRef(path));
  const batch = writeBatch(db);
  batch.set(comment, {
    senderUid,
    senderJokerId,
    text: trimmed,
    reactions: {},
    createdAt: serverTimestamp(),
  });
  batch.update(parentRef(path), {
    commentCount: increment(1),
    countedCommentId: comment.id,
  });
  await batch.commit();
  void recordDealActivity('mark', senderUid, `social:${path}:comment:${comment.id}`);
}