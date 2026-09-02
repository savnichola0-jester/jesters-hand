import {
  collection, addDoc, doc, getDoc, getDocs, deleteDoc, runTransaction, writeBatch,
  query, orderBy, onSnapshot,
  serverTimestamp, Timestamp, arrayUnion, arrayRemove, increment,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { broadcastToActiveMembers, writeNotification } from './notificationService';

export type AnteBoard = 'place' | 'raised';

export interface AntePost {
  id: string;
  senderUid: string;
  title: string;
  description: string;
  options: string[];               // Option A–D (empty ones omitted)
  text?: string;                   // legacy free-text posts
  reactions: Record<string, string[]>; // emoji → uid[]
  votes: Record<string, number>;       // uid → option index
  commentCount: number;
  mutedBy: string[];               // uids who muted this thread's notifications
  createdAt: Timestamp | null;
}

export interface AnteComment {
  id: string;
  senderUid: string;
  text: string;
  reactions: Record<string, string[]>;
  createdAt: Timestamp | null;
}

/** Best-effort ante notification — never blocks or fails the triggering action. */
function notifyAnte(
  recipientUid: string,
  actorUid: string,
  type: 'ante_comment' | 'ante_reaction',
  board: AnteBoard,
  postId: string,
  text: string,
): void {
  if (!recipientUid || recipientUid === actorUid) return;
  writeNotification(recipientUid, {
    type,
    fromUid: actorUid,
    anteBoard: board,
    antePostId: postId,
    text,
  }).catch(() => {});
}

function postLabel(title: string | undefined): string {
  const t = (title ?? '').trim();
  return t ? `"${t.length > 40 ? t.slice(0, 40) + '…' : t}"` : 'your ante';
}

const postsCol = (board: AnteBoard) => collection(db, 'antePosts', board, 'posts');
const postDoc  = (board: AnteBoard, postId: string) => doc(db, 'antePosts', board, 'posts', postId);
const commentsCol = (board: AnteBoard, postId: string) =>
  collection(db, 'antePosts', board, 'posts', postId, 'comments');

/** Live feed of posts for one ante board, newest first. */
export function listenAntePosts(
  board: AnteBoard,
  cb: (posts: AntePost[]) => void,
): () => void {
  const q = query(postsCol(board), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        senderUid: data.senderUid,
        title: data.title ?? '',
        description: data.description ?? data.text ?? '',
        options: Array.isArray(data.options) ? data.options : [],
        text: data.text,
        reactions: data.reactions ?? {},
        votes: data.votes ?? {},
        commentCount: data.commentCount ?? 0,
        mutedBy: Array.isArray(data.mutedBy) ? data.mutedBy : [],
        createdAt: data.createdAt ?? null,
      } as AntePost;
    }));
  });
}

/** Create a structured ante post on the given board. */
export async function createAntePost(
  board: AnteBoard,
  senderUid: string,
  fields: { title: string; description: string; options: string[] },
): Promise<void> {
  const post = await addDoc(postsCol(board), {
    senderUid,
    title: fields.title.trim(),
    description: fields.description.trim(),
    options: fields.options.map(o => o.trim()).filter(Boolean),
    reactions: {},
    votes: {},
    commentCount: 0,
    createdAt: serverTimestamp(),
  });
  void broadcastToActiveMembers(senderUid, {
    type: 'announcement',
    title: board === 'place' ? 'Someone placed an ante.' : 'Someone raised the ante.',
    fromUid: senderUid,
    anteBoard: board,
    antePostId: post.id,
    text: board === 'place' ? 'placed an ante.' : 'raised the ante.',
  }).catch(() => {});
}

/** Toggle an emoji reaction on a post. */
export async function toggleAntePostReaction(
  board: AnteBoard,
  postId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const ref = postDoc(board, postId);
  let notify: { authorUid: string; title?: string } | null = null;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const data = snap.data();
    const reactions: Record<string, string[]> = data.reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    const muted = new Set<string>(Array.isArray(data.mutedBy) ? data.mutedBy : []);
    notify = hasReacted || muted.has(data.senderUid)
      ? null
      : { authorUid: data.senderUid, title: data.title };
    tx.update(ref, {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (notify) {
    const { authorUid, title } = notify as { authorUid: string; title?: string };
    notifyAnte(
      authorUid, uid, 'ante_reaction', board, postId,
      `reacted ${emoji} to ${postLabel(title)}`,
    );
  }
}

/**
 * Cast (or change) a vote on a post's options. Tapping the option you already
 * voted for removes your vote; tapping another option moves it.
 */
export async function toggleAnteVote(
  board: AnteBoard,
  postId: string,
  uid: string,
  optionIndex: number,
): Promise<void> {
  const ref = postDoc(board, postId);
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const votes: Record<string, number> = snap.data().votes ?? {};
    if (votes[uid] === optionIndex) {
      delete votes[uid];              // un-vote
    } else {
      votes[uid] = optionIndex;       // cast / move vote
    }
    tx.update(ref, { votes });
  });
}

/** Live feed of comments on a post, oldest first. */
export function listenAnteComments(
  board: AnteBoard,
  postId: string,
  cb: (comments: AnteComment[]) => void,
): () => void {
  const q = query(commentsCol(board, postId), orderBy('createdAt', 'asc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        senderUid: data.senderUid,
        text: data.text ?? '',
        reactions: data.reactions ?? {},
        createdAt: data.createdAt ?? null,
      } as AnteComment;
    }));
  });
}

/** Add a comment to a post (also bumps the post's comment count). */
export async function createAnteComment(
  board: AnteBoard,
  postId: string,
  senderUid: string,
  text: string,
): Promise<void> {
  const batch = writeBatch(db);
  const commentRef = doc(commentsCol(board, postId));
  batch.set(commentRef, {
    senderUid,
    text: text.trim(),
    reactions: {},
    createdAt: serverTimestamp(),
  });
  // countedCommentId lets Firestore rules verify the counter bump is tied to a
  // real comment created in this same atomic batch.
  batch.update(postDoc(board, postId), {
    commentCount: increment(1),
    countedCommentId: commentRef.id,
  });
  await batch.commit();

  // Notify the ante author and prior commenters (best-effort, never yourself).
  getDoc(postDoc(board, postId)).then(async snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const label = postLabel(data.title);
    const muted = new Set<string>(Array.isArray(data.mutedBy) ? data.mutedBy : []);
    if (!muted.has(data.senderUid)) {
      notifyAnte(
        data.senderUid, senderUid, 'ante_comment', board, postId,
        `commented on ${label}`,
      );
    }
    // Prior commenters (dedup; skip the new commenter, the author, and muted users).
    const commentsSnap = await getDocs(commentsCol(board, postId));
    const notified = new Set<string>([senderUid, data.senderUid]);
    commentsSnap.docs.forEach(c => {
      const uid = (c.data() as any).senderUid as string | undefined;
      if (!uid || notified.has(uid) || muted.has(uid)) return;
      notified.add(uid);
      notifyAnte(
        uid, senderUid, 'ante_comment', board, postId,
        `commented on ${label}`,
      );
    });
  }).catch(() => {});
}

/** Mute or unmute comment notifications for a post thread. */
export async function setAnteMute(
  board: AnteBoard,
  postId: string,
  uid: string,
  muted: boolean,
): Promise<void> {
  await runTransaction(db, async tx => {
    const ref = postDoc(board, postId);
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    tx.update(ref, { mutedBy: muted ? arrayUnion(uid) : arrayRemove(uid) });
  });
}

/** Toggle an emoji reaction on a comment. */
export async function toggleAnteCommentReaction(
  board: AnteBoard,
  postId: string,
  commentId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const ref = doc(db, 'antePosts', board, 'posts', postId, 'comments', commentId);
  let notifyUid: string | null = null;
  await runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    let recipient: string | null = hasReacted ? null : snap.data().senderUid;
    if (recipient) {
      // Respect the thread's mute list: muted users get no reaction alerts.
      const postSnap = await tx.get(postDoc(board, postId));
      const mutedBy = postSnap.exists() ? postSnap.data().mutedBy : null;
      if (Array.isArray(mutedBy) && mutedBy.includes(recipient)) recipient = null;
    }
    notifyUid = recipient;
    tx.update(ref, {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (notifyUid) {
    notifyAnte(
      notifyUid, uid, 'ante_reaction', board, postId,
      `reacted ${emoji} to your comment`,
    );
  }
}

export function formatAnteTimestamp(ts: Timestamp | null): string {
  if (!ts) return '';
  const d = ts.toDate();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

// ── Delete a post (author or admin — enforced by Firestore rules) ────────────
// Deletes the post's comments first so no orphaned docs linger.

export async function deleteAntePost(board: AnteBoard, postId: string): Promise<void> {
  // Archive FIRST — the original is only removed once a copy is safely filed.
  const snap = await getDoc(postDoc(board, postId));
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem, snapshotComments } = await import('./archiveService');
    await archiveItem({
      type: 'ante_post',
      section: board === 'place' ? 'The Pool' : 'The Debate',
      title: data.title ?? '',
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `antePosts/${board}/posts/${postId}`,
      payload: data,
      comments: await snapshotComments(`antePosts/${board}/posts/${postId}/comments`),
    });
  }
  // Delete the post first: rules only allow comment deletes without a counter
  // decrement when the parent post no longer exists after the batch, so the
  // post must be gone before (or while) its comments are swept.
  await deleteDoc(postDoc(board, postId));
  // Best-effort comment cleanup in chunks (Firestore batches cap at 500 writes).
  // Once the post is gone, rules let any signed-in member sweep the orphans.
  try {
    const commentsSnap = await getDocs(commentsCol(board, postId));
    const refs = commentsSnap.docs.map(d => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit().catch(() => {});
    }
  } catch { /* ignore — the post itself is already gone */ }
}

// ── Delete a comment (author or admin) — atomic with commentCount decrement ──

export async function deleteAnteComment(
  board: AnteBoard,
  postId: string,
  commentId: string,
): Promise<void> {
  const cRef = doc(db, 'antePosts', board, 'posts', postId, 'comments', commentId);
  const snap = await getDoc(cRef);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'ante_comment',
      section: board === 'place' ? 'The Pool' : 'The Debate',
      title: (data.text ?? '').slice(0, 60),
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `antePosts/${board}/posts/${postId}/comments/${commentId}`,
      payload: data,
    });
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, 'antePosts', board, 'posts', postId, 'comments', commentId));
  // countedCommentId lets Firestore rules verify the counter decrement is tied
  // to a real comment deleted in this same atomic batch.
  batch.update(postDoc(board, postId), {
    commentCount: increment(-1),
    countedCommentId: commentId,
  });
  await batch.commit();
}
