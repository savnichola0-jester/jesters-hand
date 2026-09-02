// ── Issue Locker ──────────────────────────────────────────────────────────────
// Per-member record of everything officially issued, stored at
// issuedItems/{uid}/records/{recordId}. Only the admin writes (issuing is an
// official act); members read only their own locker. Rules enforce both.
import {
  collection, doc, addDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';
import { writeNotification } from './notificationService';

// Must stay in lockstep with the kind whitelist in firestore.rules.
export const LOCKER_KINDS = [
  'Initial Exclusive 54 Bundle',
  'Armory Purchases',
  'Event Exclusive Merchandise',
  'Anniversary Gifts',
  'Achievement Rewards',
  'Contest Rewards',
  'Limited Releases',
] as const;

export type LockerKind = (typeof LOCKER_KINDS)[number];

export interface IssuedRecord {
  id: string;
  kind: LockerKind;
  /** What was issued (item name). */
  title: string;
  /** Optional details — size, edition number, occasion, etc. */
  notes?: string;
  /** What the member owes for it, e.g. "$45". Absent only on legacy records. */
  price?: string;
  /** Admin uid who issued it (rules-enforced). */
  issuedBy: string;
  createdAt: Timestamp | null;
}

const recordsCol = (uid: string) => collection(db, 'issuedItems', uid, 'records');

/** Live issued records for one member, newest first. */
export function listenIssuedRecords(
  uid: string,
  cb: (records: IssuedRecord[]) => void,
): () => void {
  const q = query(recordsCol(uid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => ({
      id:        d.id,
      kind:      d.data().kind      ?? 'Limited Releases',
      title:     d.data().title     ?? '',
      notes:     d.data().notes     ?? undefined,
      price:     d.data().price     ?? undefined,
      issuedBy:  d.data().issuedBy  ?? '',
      createdAt: d.data().createdAt ?? null,
    })));
  }, () => cb([]));
}

export interface IssueInput {
  kind: LockerKind;
  title: string;
  notes?: string;
  /** Required — every issued item has a price, e.g. "$45". */
  price: string;
}

/**
 * Admin: issue one item to each uid in `recipientUids`.
 * Writes one record per member; recipients (other than the admin themself)
 * also get a bell/push notification, best-effort.
 * Returns uids whose record write failed (empty array = full success).
 */
export async function issueItem(
  adminUid: string,
  recipientUids: string[],
  input: IssueInput,
): Promise<string[]> {
  const title = input.title.trim();
  const notes = input.notes?.trim();
  const price = input.price.trim();
  const failed: string[] = [];
  await Promise.all(recipientUids.map(async uid => {
    try {
      await addDoc(recordsCol(uid), {
        kind: input.kind,
        title,
        ...(notes ? { notes } : {}),
        price,
        issuedBy: adminUid,
        createdAt: serverTimestamp(),
      });
      if (uid !== adminUid) {
        writeNotification(uid, {
          type: 'issued_item',
          title: 'Ante up or bleed out.',
          fromUid: adminUid,
          text: `New equipment has been issued to your locker: ${title}`,
        }).catch(() => {});
      }
    } catch {
      failed.push(uid);
    }
  }));
  return failed;
}

/** Admin: remove an issued record from a member's locker. */
export async function deleteIssuedRecord(ownerUid: string, recordId: string): Promise<void> {
  await deleteDoc(doc(db, 'issuedItems', ownerUid, 'records', recordId));
}

export function formatIssuedTimestamp(ts: Timestamp | null): string {
  if (!ts?.toDate) return '';
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
