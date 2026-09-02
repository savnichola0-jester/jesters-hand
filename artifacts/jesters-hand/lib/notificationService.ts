/**
 * Notification service — Firestore-backed per-user notification feed.
 *
 * Schema: notifications/{uid}/items/{notificationId}
 *   type          : 'message' | 'filed_ticket' | 'announcement' | 'ante_comment' | 'ante_reaction'
 *   fromUid?      : string   (who triggered it)
 *   conversationId?: string  (for message type → used to open chat)
 *   anteBoard?    : string   (for ante types → which board the post lives on)
 *   antePostId?   : string   (for ante types → used to open the comment thread)
 *   text          : string   (display text)
 *   createdAt     : Timestamp
 *   read          : boolean
 */
import {
  collection, doc, addDoc, updateDoc, getDocs,
  query, orderBy, onSnapshot, serverTimestamp,
  limit as firestoreLimit, writeBatch, Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { sendPushToUsers } from './pushService';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AppNotificationType =
  | 'message' | 'group_add' | 'filed_ticket' | 'filed_report' | 'announcement'
  | 'ante_comment' | 'ante_reaction'
  | 'target_comment' | 'target_reaction'
  | 'royals_honor'
  | 'issued_item'
  | 'contract_update'
  | 'vault_comment' | 'vault_review';

export interface AppNotification {
  id:              string;
  type:            AppNotificationType;
  /** Event-specific canonical title. Falls back to the type catalog for legacy rows. */
  title?:          string;
  fromUid?:        string;
  conversationId?: string;
  anteBoard?:      string;
  antePostId?:     string;
  targetTicketId?: string;
  vaultEntryId?:   string;
  vaultSection?:   string;
  text:            string;
  createdAt:       Timestamp | null;
  read:            boolean;
}

type NotifInput = Omit<AppNotification, 'id' | 'createdAt' | 'read'>;

// ── Write helpers ─────────────────────────────────────────────────────────────

/** Write a single notification document to one recipient. */
export async function writeNotification(
  recipientUid: string,
  data: NotifInput,
): Promise<void> {
  await addDoc(collection(db, 'notifications', recipientUid, 'items'), {
    ...data,
    createdAt: serverTimestamp(),
    read: false,
  });
  // Mirror to the recipient's device — best-effort, never blocks the write.
  void sendPushToUsers([recipientUid], data);
}

/**
 * Write the same notification to every uid in `recipientUids`,
 * excluding `senderUid`. Failures are swallowed (best-effort).
 */
export async function broadcastNotification(
  senderUid: string,
  recipientUids: string[],
  data: NotifInput,
): Promise<void> {
  const targets = recipientUids.filter(u => u !== senderUid);
  await Promise.allSettled(
    targets.map(uid =>
      addDoc(collection(db, 'notifications', uid, 'items'), {
        ...data,
        createdAt: serverTimestamp(),
        read: false,
      }),
    ),
  );
  // One batched push send for the whole fan-out — best-effort.
  void sendPushToUsers(targets, data);
}

/** Resolve the current active roster, then use the normal bell + real-push fan-out. */
export async function broadcastToActiveMembers(
  senderUid: string,
  data: NotifInput,
): Promise<void> {
  const users = await getDocs(collection(db, 'users'));
  const recipients = users.docs
    .filter(d => d.data().suspended !== true)
    .map(d => d.id);
  await broadcastNotification(senderUid, recipients, data);
}

// ── Real-time listener ────────────────────────────────────────────────────────

/** Listen to the 50 most recent notifications for a user, newest first. */
export function listenNotifications(
  uid: string,
  cb: (notifications: AppNotification[]) => void,
): () => void {
  const q = query(
    collection(db, 'notifications', uid, 'items'),
    orderBy('createdAt', 'desc'),
    firestoreLimit(50),
  );
  return onSnapshot(q, snap => {
    cb(
      snap.docs.map(d => ({
        id:              d.id,
        type:            d.data().type            ?? 'announcement',
        title:           d.data().title,
        fromUid:         d.data().fromUid,
        conversationId:  d.data().conversationId,
        anteBoard:       d.data().anteBoard,
        antePostId:      d.data().antePostId,
        targetTicketId:  d.data().targetTicketId,
        vaultEntryId:    d.data().vaultEntryId,
        vaultSection:    d.data().vaultSection,
        text:            d.data().text            ?? '',
        createdAt:       d.data().createdAt       ?? null,
        read:            d.data().read            ?? false,
      }))
    );
  });
}

// ── Read / clear ──────────────────────────────────────────────────────────────

/** Mark one notification as read. */
export async function markNotificationRead(
  uid: string,
  notifId: string,
): Promise<void> {
  await updateDoc(
    doc(db, 'notifications', uid, 'items', notifId),
    { read: true },
  );
}

/** Batch-mark all unread notifications as read. */
export async function markAllNotificationsRead(uid: string): Promise<void> {
  const snap = await getDocs(
    query(collection(db, 'notifications', uid, 'items')),
  );
  const unread = snap.docs.filter(d => !d.data().read);
  if (!unread.length) return;
  const batch = writeBatch(db);
  unread.forEach(d => batch.update(d.ref, { read: true }));
  await batch.commit();
}

/** Delete every dispatch in the user's bell (read and unread). */
export async function clearAllNotifications(uid: string): Promise<void> {
  const snap = await getDocs(
    query(collection(db, 'notifications', uid, 'items')),
  );
  if (snap.empty) return;
  // Firestore batches cap at 500 writes.
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

// ── Display helpers ───────────────────────────────────────────────────────────

/** Format a Firestore Timestamp for notification display ("2m ago", "1h ago", etc.). */
export function formatNotifTimestamp(ts: Timestamp | null): string {
  if (!ts) return '';
  const d   = ts.toDate();
  const now = new Date();
  const ms  = now.getTime() - d.getTime();
  if (ms < 60_000)        return 'just now';
  if (ms < 3_600_000)     return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000)    return `${Math.floor(ms / 3_600_000)}h ago`;
  if (ms < 604_800_000)   return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
