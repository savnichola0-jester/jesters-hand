/**
 * Jester's Table — Discord-style channel service.
 *
 * Firestore schema:
 *   tableMessages/{channelId}/messages/{messageId}
 *     senderUid     : string
 *     senderJokerId : string
 *     text          : string
 *     sentAt        : Timestamp
 *     reactions     : Record<string, string[]>  // emoji → uid[]
 */
import {
  collection, addDoc, query, orderBy, getDocs,
  onSnapshot, serverTimestamp, Timestamp, limit as fsLimit,
  doc, updateDoc, getDoc, deleteDoc, arrayUnion, arrayRemove,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { recordDealActivity } from './dealService';
import { broadcastNotification } from './notificationService';

// ── Channel definitions ───────────────────────────────────────────────────────

export interface Channel {
  id:        string;
  name:      string;   // used for Firestore path & channel bar title
  label:     string;   // displayed in sidebar (may include \n for wrapping)
  adminOnly: boolean;
}

export interface VoiceChannel {
  id:    string;
  name:  string;
  label: string;
}

export const TEXT_CHANNELS: Channel[] = [
  { id: 'verdict',         name: 'verdict',         label: 'verdict',           adminOnly: true  },
  { id: 'recruit',         name: 'recruit',          label: 'recruit',           adminOnly: true  },
  { id: 'hellokittens',    name: 'hello kittens',    label: 'hello\nkittens',    adminOnly: false },
  { id: 'side-deck',       name: 'side deck',        label: 'side deck',         adminOnly: false },
  { id: 'under-the-table', name: 'under the table',  label: 'under\nthe table',  adminOnly: false },
];

export const VOICE_CHANNELS: VoiceChannel[] = [
  { id: 'address-the-jester',    name: 'address the jester', label: 'address the\njester'  },
  { id: 'side-deck-voice',       name: 'side deck',          label: 'side deck'            },
  { id: 'under-the-table-voice', name: 'under the table',    label: 'under\nthe table'     },
];

// ── Message types ─────────────────────────────────────────────────────────────

export interface TableMessage {
  id:            string;
  senderUid:     string;
  senderJokerId: string;
  text:          string;
  imageUrl?:     string; // optional photo/GIF attachment
  sentAt:        Timestamp | null;
  reactions:     Record<string, string[]>; // emoji → uid[]
}

// ── Firestore helpers ─────────────────────────────────────────────────────────

/** Real-time listener for the 100 most recent messages in a channel. */
export function listenTableMessages(
  channelId: string,
  cb: (msgs: TableMessage[]) => void,
): () => void {
  const q = query(
    collection(db, 'tableMessages', channelId, 'messages'),
    orderBy('sentAt', 'asc'),
    fsLimit(100),
  );
  return onSnapshot(q, snap => {
    cb(
      snap.docs.map(d => ({
        id:            d.id,
        senderUid:     d.data().senderUid     ?? '',
        senderJokerId: d.data().senderJokerId ?? '??-??',
        text:          d.data().text          ?? '',
        imageUrl:      d.data().imageUrl      ?? undefined,
        sentAt:        d.data().sentAt        ?? null,
        reactions:     d.data().reactions     ?? {},
      }))
    );
  });
}

/** Send a message to a channel. */
export async function sendTableMessage(
  channelId:     string,
  senderUid:     string,
  senderJokerId: string,
  text:          string,
  imageUrl?:     string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed && !imageUrl) return;
  await addDoc(collection(db, 'tableMessages', channelId, 'messages'), {
    senderUid,
    senderJokerId,
    text:      trimmed,
    ...(imageUrl ? { imageUrl } : {}),
    sentAt:    serverTimestamp(),
    reactions: {},
  });
  // Resolve mentions and the current audience from the roster. Mentioned
  // members receive the stronger call-to-table title instead of a duplicate.
  getDocs(collection(db, 'users')).then(users => {
    const active = users.docs.filter(d => d.data().suspended !== true);
    const mentioned = new Set(
      active
        .filter(d => {
          const jokerId = String(d.data().jokerId ?? '');
          return jokerId && new RegExp(`(^|\\s)@${jokerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(trimmed);
        })
        .map(d => d.id),
    );
    const common = {
      type: 'announcement' as const,
      fromUid: senderUid,
      text: `spoke up in ${channelId}.`,
    };
    void broadcastNotification(senderUid, active.filter(d => !mentioned.has(d.id)).map(d => d.id), {
      ...common,
      title: 'Someone spoke up.',
    });
    void broadcastNotification(senderUid, [...mentioned], {
      ...common,
      title: 'Someone is calling you to the table.',
    });
  }).catch(() => {});
}

/** Toggle an emoji reaction on a table message (add if absent, remove if present). */
export async function toggleTableReaction(
  channelId:  string,
  messageId:  string,
  uid:        string,
  emoji:      string,
): Promise<void> {
  const msgRef = doc(db, 'tableMessages', channelId, 'messages', messageId);
  const snap   = await getDoc(msgRef);
  if (!snap.exists()) return;
  const reactions: Record<string, string[]> = snap.data().reactions ?? {};
  const current   = reactions[emoji] ?? [];
  const hasReacted = current.includes(uid);
  await updateDoc(msgRef, {
    [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
  });
  if (!hasReacted) {
    void recordDealActivity('mark', uid, `table:${channelId}:message:${messageId}:${emoji}`);
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatTableTimestamp(ts: Timestamp | null): string {
  if (!ts) return '';
  const d    = ts.toDate();
  const now  = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000)      return 'just now';
  if (diff < 3_600_000)   return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)  return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Delete a message (author or admin — enforced by Firestore rules) ─────────

export async function deleteTableMessage(
  channelId: string,
  messageId: string,
): Promise<void> {
  // Archive FIRST — the original is only removed once a copy is safely filed.
  const mRef = doc(db, 'tableMessages', channelId, 'messages', messageId);
  const snap = await getDoc(mRef);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'table_message',
      section: `Jester's Table · ${channelId}`,
      title: (data.text ?? '').slice(0, 60),
      ownerUid: data.senderUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `tableMessages/${channelId}/messages/${messageId}`,
      payload: data,
    });
  }
  await deleteDoc(mRef);
}
