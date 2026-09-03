import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDoc, getDocs,
  query, where, orderBy, limit, onSnapshot, serverTimestamp,
  increment, arrayUnion, arrayRemove, runTransaction, writeBatch,
  Timestamp, QuerySnapshot, DocumentData,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { getApiDomain } from './apiConfig';
import { sendPushToUsers } from './pushService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Conversation {
  id: string;
  memberUids: string[];
  isGroup: boolean;
  groupName?: string;
  createdBy: string;
  createdAt: Timestamp | null;
  lastMessage: string;
  lastMessageAt: Timestamp | null;
  unreadCounts: Record<string, number>;
}

export interface Message {
  id: string;
  senderUid: string;
  text: string;
  imageUrl?: string; // optional photo/GIF attachment
  sentAt: Timestamp | null;
  reactions: Record<string, string[]>; // emoji → uid[]
}

export interface Member {
  uid: string;
  jokerId: string;
  name?: string;
  mugUrl?: string;
}

// ── Get or create a 1-1 DM ───────────────────────────────────────────────────

export async function getOrCreateDM(
  currentUid: string,
  recipientUid: string,
): Promise<string> {
  // Query all conversations for the current user, filter for 1-1 with recipient
  const snap = await getDocs(
    query(
      collection(db, 'conversations'),
      where('memberUids', 'array-contains', currentUid),
      where('isGroup', '==', false),
    ),
  );

  for (const d of snap.docs) {
    const data = d.data();
    if (
      Array.isArray(data.memberUids) &&
      data.memberUids.includes(recipientUid) &&
      data.memberUids.length === 2
    ) {
      return d.id;
    }
  }

  // Create new DM
  const ref = await addDoc(collection(db, 'conversations'), {
    memberUids:    [currentUid, recipientUid],
    isGroup:       false,
    createdBy:     currentUid,
    createdAt:     serverTimestamp(),
    lastMessage:   '',
    lastMessageAt: null,
    unreadCounts:  { [currentUid]: 0, [recipientUid]: 0 },
  });
  return ref.id;
}

// ── Create a group conversation ───────────────────────────────────────────────

export async function createGroup(
  creatorUid: string,
  memberUids: string[],
  groupName: string,
): Promise<string> {
  const allUids = Array.from(new Set([creatorUid, ...memberUids]));
  const unreadCounts: Record<string, number> = {};
  allUids.forEach(uid => { unreadCounts[uid] = 0; });

  const ref = await addDoc(collection(db, 'conversations'), {
    memberUids:    allUids,
    isGroup:       true,
    groupName:     groupName.trim() || 'Group',
    createdBy:     creatorUid,
    createdAt:     serverTimestamp(),
    lastMessage:   '',
    lastMessageAt: null,
    unreadCounts,
  });
  return ref.id;
}

// ── Add members to a group (creator only — enforced by Firestore rules) ──────

export async function addMembersToGroup(
  conversationId: string,
  newUids: string[],
  addedByUid: string,
  groupName: string,
): Promise<void> {
  if (newUids.length === 0) return;
  const updates: Record<string, any> = {
    memberUids: arrayUnion(...newUids),
    // If they had previously left this group, re-adding them should make
    // the conversation visible in their list again.
    deletedBy:  arrayRemove(...newUids),
  };
  for (const uid of newUids) {
    updates[`unreadCounts.${uid}`] = 0;
  }

  // Update membership AND notify each new member in ONE atomic batch, so a
  // dropped connection can never add someone silently without their
  // "added you" notification (or vice versa).
  const batch = writeBatch(db);
  batch.update(doc(db, 'conversations', conversationId), updates);
  for (const uid of newUids) {
    if (uid === addedByUid) continue; // rules forbid self-notifications
    const notifRef = doc(collection(db, 'notifications', uid, 'items'));
    batch.set(notifRef, {
      type:           'group_add',
      fromUid:        addedByUid,
      conversationId: conversationId,
      text:           `added you to ${groupName || 'a group'}.`,
      createdAt:      serverTimestamp(),
      read:           false,
    });
  }
  await batch.commit();

  // Mirror the "added you" notifications to devices — best-effort.
  void sendPushToUsers(
    newUids.filter(uid => uid !== addedByUid),
    {
      type:           'group_add',
      fromUid:        addedByUid,
      conversationId: conversationId,
      text:           `added you to ${groupName || 'a group'}.`,
    },
  );
}

// ── Backfill ownership on a legacy group (created before createdBy existed) ──
// Firestore rules only accept this write when the group has no createdBy yet,
// and only with the deterministic first member as owner. Do not add createdAt:
// opening an old conversation must not manufacture creation activity.

export async function claimLegacyGroupOwnership(
  conversationId: string,
  firstMemberUid: string,
): Promise<void> {
  await updateDoc(doc(db, 'conversations', conversationId), {
    createdBy: firstMemberUid,
  });
}

// ── Send a message ────────────────────────────────────────────────────────────

export async function sendMessage(
  conversationId: string,
  senderUid: string,
  text: string,
  imageUrl?: string,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed && !imageUrl) return;

  const convRef = doc(db, 'conversations', conversationId);
  // Pre-allocate a message doc ref so we can write it inside the transaction.
  const msgRef = doc(collection(db, 'conversations', conversationId, 'messages'));

  // Atomically write the message, update the conversation preview/unread
  // counts, AND fan out per-recipient notifications — all in ONE transaction.
  // Either everything lands or nothing does: the app closing or the network
  // dropping right after the message commits can no longer leave recipients
  // without their in-app notification.
  let pushRecipients: string[] = [];
  await runTransaction(db, async (tx) => {
    const convSnap = await tx.get(convRef);
    if (!convSnap.exists()) return;
    const memberUids: string[] = convSnap.data().memberUids ?? [];
    const deletedBy:  string[] = convSnap.data().deletedBy  ?? [];
    pushRecipients = memberUids.filter(
      uid => uid !== senderUid && !deletedBy.includes(uid),
    );

    tx.set(msgRef, {
      senderUid,
      text:      trimmed,
      ...(imageUrl ? { imageUrl } : {}),
      sentAt:    serverTimestamp(),
      reactions: {},
    });

    const preview = trimmed
      ? (trimmed.length > 60 ? trimmed.slice(0, 60) + '…' : trimmed)
      : '📷 Photo';
    const updates: Record<string, any> = {
      lastMessage:   preview,
      lastMessageAt: serverTimestamp(),
    };
    for (const uid of memberUids) {
      if (uid !== senderUid) {
        updates[`unreadCounts.${uid}`] = increment(1);
      }
    }
    tx.update(convRef, updates);

    // Notification fan-out in the same atomic write. Skip anyone who has
    // left the conversation (present in deletedBy).
    for (const uid of memberUids) {
      if (uid === senderUid || deletedBy.includes(uid)) continue;
      const notifRef = doc(collection(db, 'notifications', uid, 'items'));
      tx.set(notifRef, {
        type:           'message',
        fromUid:        senderUid,
        conversationId: conversationId,
        text:           trimmed ? 'dealt you a private message in Pocket.' : 'dealt you a photo in Pocket.',
        createdAt:      serverTimestamp(),
        read:           false,
      });
    }
  });

  // Mirror the message notifications to devices — best-effort, post-commit.
  void sendPushToUsers(pushRecipients, {
    type:           'message',
    fromUid:        senderUid,
    conversationId: conversationId,
    text:           trimmed ? 'dealt you a private message in Pocket.' : 'dealt you a photo in Pocket.',
  });
}

// ── Toggle a reaction (add if absent, remove if present) ─────────────────────

export async function toggleReaction(
  conversationId: string,
  messageId: string,
  uid: string,
  emoji: string,
): Promise<void> {
  const msgRef = doc(db, 'conversations', conversationId, 'messages', messageId);
  const snap = await getDoc(msgRef);
  if (!snap.exists()) return;

  const reactions: Record<string, string[]> = snap.data().reactions ?? {};
  const current = reactions[emoji] ?? [];
  const hasReacted = current.includes(uid);

  await updateDoc(msgRef, {
    [`reactions.${emoji}`]: hasReacted ? arrayRemove(uid) : arrayUnion(uid),
  });
}

// ── Mark a conversation as read for a user ────────────────────────────────────

export async function markRead(conversationId: string, uid: string): Promise<void> {
  await updateDoc(doc(db, 'conversations', conversationId), {
    [`unreadCounts.${uid}`]: 0,
  });
}

// ── Real-time conversations list ──────────────────────────────────────────────

export function listenConversations(
  uid: string,
  cb: (conversations: Conversation[]) => void,
): () => void {
  const q = query(
    collection(db, 'conversations'),
    where('memberUids', 'array-contains', uid),
  );
  return onSnapshot(q, (snap: QuerySnapshot<DocumentData>) => {
    const convs: Conversation[] = snap.docs
      .filter(d => {
        const deletedBy: string[] = d.data().deletedBy ?? [];
        return !deletedBy.includes(uid);
      })
      .map(d => ({
        id:            d.id,
        memberUids:    d.data().memberUids   ?? [],
        isGroup:       d.data().isGroup      ?? false,
        groupName:     d.data().groupName,
        createdBy:     d.data().createdBy    ?? '',
        createdAt:     d.data().createdAt    ?? null,
        lastMessage:   d.data().lastMessage  ?? '',
        lastMessageAt: d.data().lastMessageAt ?? null,
        unreadCounts:  d.data().unreadCounts ?? {},
      }));
    // Sort by lastMessageAt desc (newest first), then by creation order for new convs
    convs.sort((a, b) => {
      const ta = a.lastMessageAt?.toMillis() ?? 0;
      const tb = b.lastMessageAt?.toMillis() ?? 0;
      return tb - ta;
    });
    cb(convs);
  });
}

// ── Real-time messages in a conversation ──────────────────────────────────────

export function listenMessages(
  conversationId: string,
  cb: (messages: Message[]) => void,
): () => void {
  const q = query(
    collection(db, 'conversations', conversationId, 'messages'),
    orderBy('sentAt', 'asc'),
  );
  return onSnapshot(q, (snap: QuerySnapshot<DocumentData>) => {
    const msgs: Message[] = snap.docs.map(d => ({
      id:        d.id,
      senderUid: d.data().senderUid ?? '',
      text:      d.data().text      ?? '',
      imageUrl:  d.data().imageUrl  ?? undefined,
      sentAt:    d.data().sentAt    ?? null,
      reactions: d.data().reactions ?? {},
    }));
    cb(msgs);
  });
}

// ── Get all members (for group picker) ───────────────────────────────────────

export async function getAllMembers(): Promise<Member[]> {
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map(d => ({
    uid:     d.id,
    jokerId: d.data().jokerId ?? '',
    name:    d.data().name,
    mugUrl:  d.data().mugUrl ?? undefined,
  })).sort((a, b) => a.jokerId.localeCompare(b.jokerId));
}

// ── Real-time all-members listener ────────────────────────────────────────────
// Fires immediately with the current list and re-fires whenever any user
// document is added, removed, or updated, so newly-joined Jokers appear
// in the DM / Group pickers without requiring an app restart.

export function listenAllMembers(
  cb: (members: Member[]) => void,
): () => void {
  return onSnapshot(collection(db, 'users'), (snap: QuerySnapshot<DocumentData>) => {
    const members: Member[] = snap.docs.map(d => ({
      uid:     d.id,
      jokerId: d.data().jokerId ?? '',
      name:    d.data().name,
      mugUrl:  d.data().mugUrl ?? undefined,
    })).sort((a, b) => a.jokerId.localeCompare(b.jokerId));
    cb(members);
  });
}

// ── Get display name for a conversation ──────────────────────────────────────

export function getConvDisplayName(
  conv: Conversation,
  currentUid: string,
  memberCache: Record<string, string>, // uid → jokerId or name
): string {
  if (conv.isGroup) return conv.groupName ?? 'Group';
  const otherUid = conv.memberUids.find(u => u !== currentUid) ?? '';
  return memberCache[otherUid] ?? '——';
}

// ── Format a Firestore Timestamp for display ──────────────────────────────────

/** Remove the current user from a conversation — clears it from their list. */
export async function clearConversation(conversationId: string, uid: string): Promise<void> {
  const convRef = doc(db, 'conversations', conversationId);

  // If we are the LAST remaining member, leaving would orphan the
  // conversation forever (nobody could ever read or delete it again), so
  // instead we delete the conversation and all of its messages.
  const snap = await getDoc(convRef);
  if (!snap.exists()) return;
  const members: string[] = snap.data().memberUids ?? [];
  const isLastMember = members.length === 1 && members[0] === uid;

  if (isLastMember) {
    // Preferred path: the api-server tears down the conversation, its
    // messages AND their chatMedia attachments (which may live under other
    // members' storage folders that this client cannot delete).
    if (await teardownConversationServerSide(conversationId)) return;

    try {
      // Collect message ids while we can still query them (reading the
      // subcollection requires membership, which ends with the delete).
      const msgs = await getDocs(
        collection(db, 'conversations', conversationId, 'messages'),
      );

      // First batch deletes the conversation doc itself plus as many messages
      // as fit; rules allow message deletes in the same batch as the parent
      // delete, and orphan sweeps afterwards once the parent is gone.
      const BATCH_LIMIT = 500;
      const batches = [writeBatch(db)];
      batches[0].delete(convRef);
      let ops = 1;
      for (const m of msgs.docs) {
        if (ops >= BATCH_LIMIT) {
          batches.push(writeBatch(db));
          ops = 0;
        }
        batches[batches.length - 1].delete(m.ref);
        ops++;
      }
      for (const b of batches) {
        await b.commit();
      }
      // Fallback attachment cleanup: only files this client is allowed to
      // delete (its own folder, or any folder when admin). Others' files are
      // left for the server-side path / a later sweep.
      await deleteAttachmentsBestEffort(
        msgs.docs.map(m => m.data().imageUrl).filter(Boolean) as string[],
      );
      return;
    } catch {
      // A concurrent membership change (e.g. the owner re-adding someone) can
      // make the delete impermissible — fall through to a normal self-leave.
    }
  }

  await runTransaction(db, async (tx) => {
    const txSnap = await tx.get(convRef);
    if (!txSnap.exists()) return;
    const data = txSnap.data();
    const remaining: string[] = (data.memberUids ?? []).filter((u: string) => u !== uid);
    const updates: Record<string, any> = {
      memberUids: arrayRemove(uid),
      deletedBy:  arrayUnion(uid),
    };
    tx.update(convRef, updates);
  });
}

// ── One-time sweep of pre-existing orphaned conversations ────────────────────
// Conversations orphaned BEFORE the last-member-leaves fix still sit in
// Firestore with empty memberUids. Rules let any signed-in user read and
// delete zero-member conversations and their leftover messages, so any
// client can sweep them on app start. Best-effort: concurrent sweepers or
// rule races just skip the doc.

/**
 * Ask the api-server to tear down a conversation (docs + every chatMedia
 * attachment, including files under other members' folders that this client
 * cannot delete). Returns true on success, false when the server is
 * unavailable or refuses — callers fall back to the client-side delete.
 */
async function teardownConversationServerSide(conversationId: string): Promise<boolean> {
  try {
    const domain = getApiDomain();
    const idToken = await auth.currentUser?.getIdToken();
    if (!domain || !idToken) return false;
    const res = await fetch(`https://${domain}/api/chat/teardown`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ conversationId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Best-effort storage cleanup for a list of message imageUrls. */
async function deleteAttachmentsBestEffort(imageUrls: string[]): Promise<void> {
  if (!imageUrls.length) return;
  const { deleteChatImage } = await import('./chatMediaService');
  for (const url of imageUrls) await deleteChatImage(url);
}

export async function sweepOrphanedConversations(): Promise<void> {
  let orphans;
  try {
    orphans = await getDocs(
      query(collection(db, 'conversations'), where('memberUids', '==', [])),
    );
  } catch (e) {
    console.error('[whisperService] orphan sweep query failed:', e);
    return;
  }

  for (const conv of orphans.docs) {
    try {
      // Preferred path: server-side teardown also removes chatMedia
      // attachments (any member's folder).
      if (await teardownConversationServerSide(conv.id)) continue;

      // Enumerate messages while the parent still exists (readable because
      // its memberUids is empty), then delete parent + messages in batches.
      const msgs = await getDocs(
        collection(db, 'conversations', conv.id, 'messages'),
      );

      const BATCH_LIMIT = 500;
      const batches = [writeBatch(db)];
      batches[0].delete(conv.ref);
      let ops = 1;
      for (const m of msgs.docs) {
        if (ops >= BATCH_LIMIT) {
          batches.push(writeBatch(db));
          ops = 0;
        }
        batches[batches.length - 1].delete(m.ref);
        ops++;
      }
      for (const b of batches) {
        await b.commit();
      }
      // Fallback: clean up whatever attachments this client may delete.
      await deleteAttachmentsBestEffort(
        msgs.docs.map(m => m.data().imageUrl).filter(Boolean) as string[],
      );
    } catch (e) {
      // Another client may have swept this conversation concurrently, or a
      // member was re-added mid-sweep — either way, skip and move on.
      console.warn(`[whisperService] orphan sweep skipped ${conv.id}:`, e);
    }
  }
}

export function formatTimestamp(ts: Timestamp | null): string {
  if (!ts) return '';
  const d = ts.toDate();
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) {
    return d.toLocaleDateString(undefined, { weekday: 'short' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Delete a single message in a conversation (sender or admin-member) ───────

export async function deleteChatMessage(
  conversationId: string,
  messageId: string,
): Promise<void> {
  const msgRef = doc(db, 'conversations', conversationId, 'messages', messageId);

  // Capture the deleted message's timestamp before removing it so we can tell
  // whether the conversation preview still refers to it (or something older).
  let deletedSentAt: Timestamp | null = null;
  let deletedImageUrl: string | null = null;
  try {
    const msgSnap = await getDoc(msgRef);
    if (msgSnap.exists()) {
      deletedSentAt   = msgSnap.data().sentAt ?? null;
      deletedImageUrl = msgSnap.data().imageUrl ?? null;
    }
  } catch {
    // Non-fatal: fall through with deletedSentAt = null (guard becomes strict).
  }

  await deleteDoc(msgRef);

  // Whispers are not archived, so the attachment has no soft-delete safety
  // net: remove its storage object now (best-effort — never blocks the flow).
  if (deletedImageUrl) {
    const { deleteChatImage } = await import('./chatMediaService');
    await deleteChatImage(deletedImageUrl);
  }

  // Recompute the conversation preview from the latest remaining message so the
  // Whispers list never keeps showing text that was just deleted.
  //
  // Race safety: a concurrent sendMessage may set a newer preview between our
  // query and our write. We therefore apply the recomputed preview inside a
  // transaction and only overwrite when the conversation's current
  // lastMessageAt is NOT newer than both the deleted message and the
  // recomputed latest message — i.e. we never clobber a preview that a newer
  // message already produced.
  try {
    const latestSnap = await getDocs(
      query(
        collection(db, 'conversations', conversationId, 'messages'),
        orderBy('sentAt', 'desc'),
        limit(1),
      ),
    );

    const latest = latestSnap.empty ? null : latestSnap.docs[0].data();
    const latestSentAt: Timestamp | null = latest?.sentAt ?? null;

    await runTransaction(db, async (tx) => {
      const convRef  = doc(db, 'conversations', conversationId);
      const convSnap = await tx.get(convRef);
      if (!convSnap.exists()) return;

      const currentAt: Timestamp | null = convSnap.data().lastMessageAt ?? null;
      const currentMs = currentAt?.toMillis() ?? 0;
      const deletedMs = deletedSentAt?.toMillis() ?? 0;
      const latestMs  = latestSentAt?.toMillis() ?? 0;

      // If the conversation preview is already newer than both the deleted
      // message and the newest message we found, a concurrent send won the
      // race — leave its preview intact.
      if (currentMs > deletedMs && currentMs > latestMs) return;

      if (!latest) {
        tx.update(convRef, { lastMessage: '', lastMessageAt: null });
        return;
      }

      const text: string = latest.text ?? '';
      const preview = text
        ? (text.length > 60 ? text.slice(0, 60) + '…' : text)
        : (latest.imageUrl ? '📷 Photo' : '');
      tx.update(convRef, {
        lastMessage:   preview,
        lastMessageAt: latestSentAt,
      });
    });
  } catch (e) {
    console.error('[whisperService] failed to refresh conversation preview after delete:', e);
  }
}
