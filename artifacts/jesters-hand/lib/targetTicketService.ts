import {
  collection, addDoc, doc, getDoc, getDocs, deleteDoc, updateDoc, runTransaction,
  writeBatch, query, orderBy, onSnapshot,
  serverTimestamp, Timestamp, arrayUnion, arrayRemove, increment,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { db, storage, auth } from './firebase';
import { broadcastToActiveMembers, writeNotification } from './notificationService';
import { recordDealActivity } from './dealService';

// ─── Types ────────────────────────────────────────────────────────

/** The four suits map to theory categories. */
export type Suit = 'spade' | 'diamond' | 'heart' | 'club';

export const SUIT_LABELS: Record<Suit, string> = {
  spade: 'Crime & Conspiracy',
  diamond: 'Identity & Secrets',
  heart: 'Relationships',
  club: 'Trauma & Origin',
};

/** Five-color status dot key, shared by document fields and canvas elements. */
export type DotColor = 'navy' | 'burgundy' | 'yellow' | 'orange' | 'green';

export const DOT_META: Record<DotColor, { color: string; label: string }> = {
  navy:     { color: '#27456E', label: 'Solved' },
  burgundy: { color: '#7A2233', label: 'Unsolved' },
  yellow:   { color: '#E0C341', label: 'To Be Determined' },
  orange:   { color: '#D97B29', label: 'Watching' },
  green:    { color: '#3E7C4F', label: 'Redirection' },
};

export const DOT_ORDER: DotColor[] = ['navy', 'burgundy', 'yellow', 'orange', 'green'];

export interface EvidenceEntry {
  text: string;
  source: string;      // Book & Chapter/Page citation
}

/** One element placed on The Spread canvas. */
export interface SpreadElement {
  id: string;
  kind: 'note' | 'clipping' | 'photo' | 'document' | 'fingerprint';
  x: number;           // canvas coordinates (unzoomed)
  y: number;
  w: number;
  h: number;
  rot: number;         // degrees
  z: number;           // stacking order
  text?: string;       // note / clipping / document body
  text2?: string;      // secondary field (clipping "more context")
  uri?: string;        // photo download URL
  dot?: DotColor | null;
}

/** A string-board line between two elements. */
export interface SpreadConnector {
  id: string;
  fromId: string;
  toId: string;
  dot?: DotColor | null;
}

export interface SpreadState {
  elements: SpreadElement[];
  connectors: SpreadConnector[];
  // Last viewport so the canvas reopens where the author left it.
  panX: number;
  panY: number;
  zoom: number;
}

export const EMPTY_SPREAD: SpreadState = { elements: [], connectors: [], panX: 0, panY: 0, zoom: 1 };

/** Keys of taggable document fields (for fieldDots). */
export type TicketFieldKey =
  | 'target' | 'suit' | 'evidence' | 'connections' | 'contradictions' | 'confidence';

export interface TargetTicket {
  id: string;
  senderUid: string;
  title: string;                    // Working Theory
  target: string;                   // Target / Subject of theory
  suit: Suit;
  evidence: EvidenceEntry[];
  connections: string;
  contradictions: string;
  confidence: number;               // 0–5 stars
  fieldDots: Partial<Record<TicketFieldKey, DotColor>>;
  spread: SpreadState;
  reactions: Record<string, string[]>;   // emoji → uid[]
  commentCount: number;
  mutedBy: string[];
  createdAt: Timestamp | null;
}

export interface TicketComment {
  id: string;
  senderUid: string;
  text: string;
  reactions: Record<string, string[]>;
  createdAt: Timestamp | null;
}

export interface TicketDraft {
  title: string;
  target: string;
  suit: Suit;
  evidence: EvidenceEntry[];
  connections: string;
  contradictions: string;
  confidence: number;
  fieldDots: Partial<Record<TicketFieldKey, DotColor>>;
  spread: SpreadState;
}

// ─── Notifications (best-effort, mirrors ante) ────────────────────

function notifyTicket(
  recipientUid: string,
  actorUid: string,
  type: 'target_comment' | 'target_reaction',
  ticketId: string,
  text: string,
): void {
  if (!recipientUid || recipientUid === actorUid) return;
  writeNotification(recipientUid, {
    type,
    fromUid: actorUid,
    targetTicketId: ticketId,
    text,
  }).catch(() => {});
}

function ticketLabel(title: string | undefined): string {
  const t = (title ?? '').trim();
  return t ? `"${t.length > 40 ? t.slice(0, 40) + '…' : t}"` : 'a target ticket';
}

// ─── Refs ─────────────────────────────────────────────────────────

const ticketsCol = () => collection(db, 'targetTickets');
const ticketDoc = (id: string) => doc(db, 'targetTickets', id);
const commentsCol = (id: string) => collection(db, 'targetTickets', id, 'comments');

// ─── Serialization ────────────────────────────────────────────────
// The spread is stored as a JSON string: Firestore rejects nested arrays and
// this keeps rule validation simple while the canvas format evolves.

function packSpread(s: SpreadState): string {
  return JSON.stringify(s ?? EMPTY_SPREAD);
}

function unpackSpread(raw: unknown): SpreadState {
  if (typeof raw !== 'string' || !raw) return { ...EMPTY_SPREAD };
  try {
    const p = JSON.parse(raw);
    return {
      elements: Array.isArray(p.elements) ? p.elements : [],
      connectors: Array.isArray(p.connectors) ? p.connectors : [],
      panX: typeof p.panX === 'number' ? p.panX : 0,
      panY: typeof p.panY === 'number' ? p.panY : 0,
      zoom: typeof p.zoom === 'number' ? p.zoom : 1,
    };
  } catch {
    return { ...EMPTY_SPREAD };
  }
}

function parseTicket(id: string, data: any): TargetTicket {
  return {
    id,
    senderUid: data.senderUid,
    title: data.title ?? '',
    target: data.target ?? '',
    suit: (['spade', 'diamond', 'heart', 'club'] as Suit[]).includes(data.suit) ? data.suit : 'spade',
    evidence: Array.isArray(data.evidence)
      ? data.evidence.map((e: any) => ({ text: e?.text ?? '', source: e?.source ?? '' }))
      : [],
    connections: data.connections ?? '',
    contradictions: data.contradictions ?? '',
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
    fieldDots: data.fieldDots ?? {},
    spread: unpackSpread(data.spread),
    reactions: data.reactions ?? {},
    commentCount: data.commentCount ?? 0,
    mutedBy: Array.isArray(data.mutedBy) ? data.mutedBy : [],
    createdAt: data.createdAt ?? null,
  };
}

// ─── Feed ─────────────────────────────────────────────────────────

export function listenTargetTickets(cb: (tickets: TargetTicket[]) => void): () => void {
  const q = query(ticketsCol(), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => parseTicket(d.id, d.data())));
  });
}

export function listenTargetTicket(
  id: string,
  cb: (ticket: TargetTicket | null) => void,
): () => void {
  return onSnapshot(ticketDoc(id), snap => {
    cb(snap.exists() ? parseTicket(snap.id, snap.data()) : null);
  });
}

// ─── Create / update / delete ─────────────────────────────────────

function draftFields(draft: TicketDraft) {
  return {
    title: draft.title.trim(),
    target: draft.target.trim(),
    suit: draft.suit,
    evidence: draft.evidence
      .map(e => ({ text: e.text.trim(), source: e.source.trim() }))
      .filter(e => e.text || e.source),
    connections: draft.connections.trim(),
    contradictions: draft.contradictions.trim(),
    confidence: Math.max(0, Math.min(5, Math.round(draft.confidence))),
    fieldDots: draft.fieldDots ?? {},
    spread: packSpread(draft.spread),
  };
}

export async function createTargetTicket(senderUid: string, draft: TicketDraft): Promise<string> {
  const refDoc = await addDoc(ticketsCol(), {
    senderUid,
    ...draftFields(draft),
    reactions: {},
    commentCount: 0,
    mutedBy: [],
    createdAt: serverTimestamp(),
  });
  void broadcastToActiveMembers(senderUid, {
    type: 'announcement',
    title: 'Target filed.',
    fromUid: senderUid,
    targetTicketId: refDoc.id,
    text: 'filed a target.',
  }).catch(() => {});
  return refDoc.id;
}

/** Author-only content edit (rules enforce authorship). */
export async function updateTargetTicket(id: string, draft: TicketDraft): Promise<void> {
  await updateDoc(ticketDoc(id), draftFields(draft));
}

export async function deleteTargetTicket(id: string): Promise<void> {
  // Archive FIRST — the original is only removed once a copy is safely filed.
  const snap = await getDoc(ticketDoc(id));
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem, snapshotComments } = await import('./archiveService');
    await archiveItem({
      type: 'ticket',
      section: 'The Target',
      title: data.title ?? data.target ?? '',
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `targetTickets/${id}`,
      payload: data,
      comments: await snapshotComments(`targetTickets/${id}/comments`),
    });
  }
  // Post first, then best-effort comment sweep (same pattern as ante posts).
  await deleteDoc(ticketDoc(id));
  try {
    const commentsSnap = await getDocs(commentsCol(id));
    const refs = commentsSnap.docs.map(d => d.ref);
    for (let i = 0; i < refs.length; i += 400) {
      const batch = writeBatch(db);
      refs.slice(i, i + 400).forEach(r => batch.delete(r));
      await batch.commit().catch(() => {});
    }
  } catch { /* post already gone */ }
}

// ─── Reactions ────────────────────────────────────────────────────

export async function toggleTicketReaction(
  id: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const refDoc = ticketDoc(id);
  let notify: { authorUid: string; title?: string } | null = null;
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(refDoc);
    if (!snap.exists()) return;
    const data = snap.data();
    const reactions: Record<string, string[]> = data.reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    added = !hasReacted;
    const muted = new Set<string>(Array.isArray(data.mutedBy) ? data.mutedBy : []);
    notify = hasReacted || muted.has(data.senderUid)
      ? null
      : { authorUid: data.senderUid, title: data.title };
    tx.update(refDoc, {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (added) void recordDealActivity('mark', uid, `ticket:${id}:${emoji}`);
  if (notify) {
    const { authorUid, title } = notify as { authorUid: string; title?: string };
    notifyTicket(authorUid, uid, 'target_reaction', id, `reacted ${emoji} to ${ticketLabel(title)}`);
  }
}

export async function toggleTicketCommentReaction(
  ticketId: string,
  commentId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const refDoc = doc(db, 'targetTickets', ticketId, 'comments', commentId);
  let notifyUid: string | null = null;
  let added = false;
  await runTransaction(db, async tx => {
    const snap = await tx.get(refDoc);
    if (!snap.exists()) return;
    const reactions: Record<string, string[]> = snap.data().reactions ?? {};
    const hasReacted = (reactions[emoji] ?? []).includes(uid);
    added = !hasReacted;
    let recipient: string | null = hasReacted ? null : snap.data().senderUid;
    if (recipient) {
      const postSnap = await tx.get(ticketDoc(ticketId));
      const mutedBy = postSnap.exists() ? postSnap.data().mutedBy : null;
      if (Array.isArray(mutedBy) && mutedBy.includes(recipient)) recipient = null;
    }
    notifyUid = recipient;
    tx.update(refDoc, {
      [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
    });
  });
  if (added) void recordDealActivity('mark', uid, `ticket:${ticketId}:comment:${commentId}:${emoji}`);
  if (notifyUid) {
    notifyTicket(notifyUid, uid, 'target_reaction', ticketId, `reacted ${emoji} to your comment`);
  }
}

// ─── Comments ─────────────────────────────────────────────────────

export function listenTicketComments(
  ticketId: string,
  cb: (comments: TicketComment[]) => void,
): () => void {
  const q = query(commentsCol(ticketId), orderBy('createdAt', 'asc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        senderUid: data.senderUid,
        text: data.text ?? '',
        reactions: data.reactions ?? {},
        createdAt: data.createdAt ?? null,
      } as TicketComment;
    }));
  });
}

export async function createTicketComment(
  ticketId: string,
  senderUid: string,
  text: string,
): Promise<void> {
  const batch = writeBatch(db);
  const commentRef = doc(commentsCol(ticketId));
  batch.set(commentRef, {
    senderUid,
    text: text.trim(),
    reactions: {},
    createdAt: serverTimestamp(),
  });
  // Counter integrity: rules verify the bump names a comment created in-batch.
  batch.update(ticketDoc(ticketId), {
    commentCount: increment(1),
    countedCommentId: commentRef.id,
  });
  await batch.commit();
  // commentRef.id makes repeated comments distinct while retries stay deduped.
  void recordDealActivity('target_whisper', senderUid, `ticket:${ticketId}:comment:${commentRef.id}`);

  // Notify author + prior commenters, respecting the mute list.
  getDoc(ticketDoc(ticketId)).then(async snap => {
    if (!snap.exists()) return;
    const data = snap.data();
    const label = ticketLabel(data.title);
    const muted = new Set<string>(Array.isArray(data.mutedBy) ? data.mutedBy : []);
    if (!muted.has(data.senderUid)) {
      notifyTicket(data.senderUid, senderUid, 'target_comment', ticketId, `commented on ${label}`);
    }
    const commentsSnap = await getDocs(commentsCol(ticketId));
    const notified = new Set<string>([senderUid, data.senderUid]);
    commentsSnap.docs.forEach(c => {
      const uid = (c.data() as any).senderUid as string | undefined;
      if (!uid || notified.has(uid) || muted.has(uid)) return;
      notified.add(uid);
      notifyTicket(uid, senderUid, 'target_comment', ticketId, `commented on ${label}`);
    });
  }).catch(() => {});
}

export async function deleteTicketComment(ticketId: string, commentId: string): Promise<void> {
  const cRef = doc(db, 'targetTickets', ticketId, 'comments', commentId);
  const snap = await getDoc(cRef);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'ticket_comment',
      section: 'The Target',
      title: (data.text ?? '').slice(0, 60),
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `targetTickets/${ticketId}/comments/${commentId}`,
      payload: data,
    });
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, 'targetTickets', ticketId, 'comments', commentId));
  batch.update(ticketDoc(ticketId), {
    commentCount: increment(-1),
    countedCommentId: commentId,
  });
  await batch.commit();
}

// ─── Mute ─────────────────────────────────────────────────────────

export async function setTicketMute(ticketId: string, uid: string, muted: boolean): Promise<void> {
  await runTransaction(db, async tx => {
    const refDoc = ticketDoc(ticketId);
    const snap = await tx.get(refDoc);
    if (!snap.exists()) return;
    tx.update(refDoc, { mutedBy: muted ? arrayUnion(uid) : arrayRemove(uid) });
  });
}

// ─── Photo upload for Spread elements ─────────────────────────────

export async function uploadSpreadPhoto(uid: string, localUri: string): Promise<string> {
  const resp = await fetch(localUri);
  const blob = await resp.blob();
  const path = `targetTickets/${uid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.jpg`;
  const storageRef = ref(storage, path);
  await new Promise<void>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, blob, { contentType: 'image/jpeg' });
    task.on('state_changed', undefined, reject, () => resolve());
  });
  return getDownloadURL(storageRef);
}

export function formatTicketTimestamp(ts: Timestamp | null): string {
  if (!ts) return '';
  const d = ts.toDate();
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
