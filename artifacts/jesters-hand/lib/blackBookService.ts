// ── Black Book (Street Art) ───────────────────────────────────────────────────
// Per-member logs stored at blackBook/{uid}/entries/{entryId}.
// Four tabs: recruit / uniform / turn / royals.
// Members write their own recruit/uniform/turn entries; royals entries are
// awarded by the admin only (admin may also keep their own royals).
import {
  collection, doc, addDoc, updateDoc, deleteDoc, getDoc,
  onSnapshot, query, orderBy, where, serverTimestamp, deleteField,
  getCountFromServer,
} from 'firebase/firestore';
import { db, auth } from './firebase';
import { writeNotification } from './notificationService';
import { recordDealActivity } from './dealService';

export type BlackBookTab = 'recruit' | 'uniform' | 'turn' | 'royals';

export const BLACK_BOOK_TABS: BlackBookTab[] = ['recruit', 'uniform', 'turn', 'royals'];

export interface BlackBookEntry {
  id: string;
  tab: BlackBookTab;
  /** Primary line: event name / merch title / book title / achievement title. */
  title: string;
  /** recruit: date & time of the event (free text). */
  date?: string;
  /** recruit: where it happened. */
  location?: string;
  /** recruit: 'in-person' | 'twitch' (member) or 'in-person' | 'live' (admin). */
  mode?: string;
  /** uniform: price (free text, e.g. "$25"). */
  price?: string;
  /** turn: progress through the book, 0–100. */
  progress?: number;
  /** turn: quick review/thoughts. royals: achievement details. */
  notes?: string;
  /** royals: award suit — Spade (loyalty), Diamond (investment),
   *  Heart (community), Club (discovery). */
  suit?: string;
  createdAt?: any;
  /** uid of the writer (owner, or admin when awarding royals). */
  createdBy?: string;
}

const entriesCol = (uid: string) => collection(db, 'blackBook', uid, 'entries');

/** Live entries for one member + tab, newest first. */
export function listenBlackBookEntries(
  uid: string,
  tab: BlackBookTab,
  cb: (entries: BlackBookEntry[]) => void,
): () => void {
  const q = query(entriesCol(uid), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    const all = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<BlackBookEntry, 'id'>) }));
    cb(all.filter(e => e.tab === tab));
  }, () => cb([]));
}

/**
 * Royals honor counts for a set of members, keyed by uid.
 * Uses server-side count aggregation (no entry documents are downloaded).
 * Best-effort per member: a failed count is simply omitted from the map.
 */
export async function getRoyalsCounts(uids: string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  await Promise.all(uids.map(async uid => {
    try {
      const snap = await getCountFromServer(
        query(entriesCol(uid), where('tab', '==', 'royals')),
      );
      counts[uid] = snap.data().count;
    } catch {
      // Leave this member out — the badge just won't show.
    }
  }));
  return counts;
}

/**
 * Fields the caller may set; tab/creator/timestamps are managed here.
 * Empty string (or null progress) means "clear this field" on update.
 */
export interface BlackBookEntryInput {
  title: string;
  date?: string;
  location?: string;
  mode?: string;
  price?: string;
  notes?: string;
  suit?: string;
  progress?: number | null;
}

const OPTIONAL_STRING_KEYS = ['date', 'location', 'mode', 'price', 'notes', 'suit'] as const;

function cleanInput(input: BlackBookEntryInput, forUpdate: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const title = input.title.trim();
  if (title) out.title = title;
  for (const key of OPTIONAL_STRING_KEYS) {
    const raw = input[key];
    if (raw === undefined) continue;
    const v = raw.trim();
    if (v) out[key] = v;
    else if (forUpdate) out[key] = deleteField();
  }
  if (input.progress !== undefined) {
    if (input.progress === null) {
      if (forUpdate) out.progress = deleteField();
    } else {
      out.progress = Math.max(0, Math.min(100, Math.round(input.progress)));
    }
  }
  return out;
}

export async function addBlackBookEntry(
  ownerUid: string,
  tab: BlackBookTab,
  writerUid: string,
  input: BlackBookEntryInput,
): Promise<string> {
  const ref = await addDoc(entriesCol(ownerUid), {
    tab,
    ...cleanInput(input, false),
    createdBy: writerUid,
    createdAt: serverTimestamp(),
  });
  // The entry is already durable; Deal bookkeeping must never block it.
  void recordDealActivity('black_book', writerUid, `entry:${ref.id}`);
  // Awarding a Royals honor to someone else → tell them (best-effort).
  if (tab === 'royals' && writerUid !== ownerUid) {
    writeNotification(ownerUid, {
      type: 'royals_honor',
      fromUid: writerUid,
      text: 'The Jester has bestowed an honor on you',
    }).catch(() => {});
  }
  return ref.id;
}

export async function updateBlackBookEntry(
  ownerUid: string,
  entryId: string,
  input: BlackBookEntryInput,
): Promise<void> {
  await updateDoc(doc(db, 'blackBook', ownerUid, 'entries', entryId), cleanInput(input, true));
  const actorUid = auth.currentUser?.uid;
  if (actorUid) {
    // One Black Book entry is one Deal action; edits cannot farm a task.
    void recordDealActivity('black_book', actorUid, `entry:${entryId}`);
  }
}

export async function deleteBlackBookEntry(ownerUid: string, entryId: string): Promise<void> {
  // Archive FIRST — the original is only removed once a copy is safely filed.
  const eRef = doc(db, 'blackBook', ownerUid, 'entries', entryId);
  const snap = await getDoc(eRef);
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'black_book',
      section: 'The Black Book',
      title: data.title ?? '',
      ownerUid,
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `blackBook/${ownerUid}/entries/${entryId}`,
      payload: data,
    });
  }
  await deleteDoc(eRef);
}

export function formatBlackBookTimestamp(ts: any): string {
  if (!ts?.toDate) return '';
  const d: Date = ts.toDate();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
