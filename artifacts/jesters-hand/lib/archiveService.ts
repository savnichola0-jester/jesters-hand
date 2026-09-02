// Archives — soft-delete safety net for The Jester's Hand.
//
// Whenever content is deleted anywhere in the app, a full copy is filed into
// `archives/{id}` FIRST; only then is the original removed. Storage files
// referenced by the content are NOT deleted — they stay in place (unreachable
// to members once the doc is gone) until the admin permanently deletes the
// archived item. The admin can also restore an item back to its exact
// original location, ownership and dates intact.
//
// Whisper (private conversation) content is deliberately NEVER archived.

import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, deleteDoc, writeBatch,
  increment, onSnapshot, orderBy, query, serverTimestamp, Timestamp, where,
} from 'firebase/firestore';
import { ref, deleteObject } from 'firebase/storage';
import { db, storage } from './firebase';

export type ArchiveType =
  | 'ante_post' | 'ante_comment'
  | 'ticket' | 'ticket_comment'
  | 'table_message'
  | 'black_book'
  | 'recruit_post'
  | 'vault_entry'
  | 'vault_comment'
  | 'vault_review'
  | 'book_review'
  | 'armory_product'
  | 'report'
  | 'contract_signed';

export const ARCHIVE_TYPE_LABEL: Record<ArchiveType, string> = {
  ante_post: 'Post', ante_comment: 'Comment',
  ticket: 'Ticket', ticket_comment: 'Comment',
  table_message: 'Message',
  black_book: 'Black Book Entry',
  recruit_post: 'Recruit Post',
  vault_entry: 'Vault Entry',
  vault_comment: 'Comment',
  vault_review: 'Review',
  book_review: 'Book Review',
  armory_product: 'Product',
  report: 'Report Card',
  contract_signed: 'Contract Signed',
};

export interface ArchivedComment { id: string; fields: Record<string, any>; }

export interface ArchiveRecord {
  id: string;
  type: ArchiveType;
  section: string;               // display: where it came from
  title: string;                 // best-available title/preview seed
  ownerUid: string;
  ownerJokerId: string;          // best-effort at archive time
  restorePath: string;           // exact original doc path
  payload: Record<string, any>;  // full original doc fields
  comments: ArchivedComment[];   // child comments (posts/tickets/vault)
  reviews: ArchivedComment[];    // child reviews (vault entries)
  marks: ArchivedComment[];      // child per-user emoji marks (vault entries)
  storagePaths: string[];        // files kept alive until permanent delete
  createdAtOriginal: Timestamp | null;
  deletedAt: Timestamp | null;
  deletedByUid: string;
}

const STORAGE_PREFIXES = [
  'targetTickets/', 'recruitPosts/', 'vault/', 'armoryProducts/', 'reports/', 'users/',
  'chatMedia/',
];

/** Scan a payload for storage paths so files survive until a permanent delete. */
export function extractStoragePaths(payload: Record<string, any>): string[] {
  const found = new Set<string>();
  const json = JSON.stringify(payload);
  const consider = (p: string) => {
    if (STORAGE_PREFIXES.some(pre => p.startsWith(pre)) && p.includes('/', p.indexOf('/') + 1)) {
      found.add(p);
    }
  };
  // 1. Paths stored as plain JSON strings.
  const re = /"((?:targetTickets|recruitPosts|vault|armoryProducts|reports|users|chatMedia)\/[^"\\]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json))) consider(m[1]);
  // 2. Paths buried inside Firebase download URLs ("…/o/targetTickets%2Fuid%2Fimg.jpg?alt=…").
  //    Ticket spread photos are stored as URLs, not raw paths.
  const urlRe = /\/o\/((?:targetTickets|recruitPosts|vault|armoryProducts|reports|users|chatMedia)(?:%2F|\/)[^"?\\]+)/g;
  while ((m = urlRe.exec(json))) {
    try { consider(decodeURIComponent(m[1])); } catch { /* malformed URL — skip */ }
  }
  return [...found];
}

async function lookupJokerId(uid: string): Promise<string> {
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    return (snap.data()?.jokerId as string) ?? '';
  } catch { return ''; }
}

/**
 * File a copy into Archives. Throws on failure — callers must archive FIRST
 * and only delete the original once the copy is safely stored.
 */
export async function archiveItem(input: {
  type: ArchiveType;
  section: string;
  title: string;
  ownerUid: string;
  deletedByUid: string;
  restorePath: string;
  payload: Record<string, any>;
  comments?: ArchivedComment[];
  reviews?: ArchivedComment[];
  marks?: ArchivedComment[];
}): Promise<void> {
  const ownerJokerId = await lookupJokerId(input.ownerUid);
  await addDoc(collection(db, 'archives'), {
    type: input.type,
    section: input.section,
    title: input.title || '',
    ownerUid: input.ownerUid,
    ownerJokerId,
    restorePath: input.restorePath,
    payload: input.payload,
    comments: input.comments ?? [],
    reviews: input.reviews ?? [],
    marks: input.marks ?? [],
    storagePaths: extractStoragePaths({ p: input.payload, c: input.comments ?? [] }),
    createdAtOriginal: (input.payload as any).createdAt ?? null,
    deletedAt: serverTimestamp(),
    deletedByUid: input.deletedByUid,
  });
}

/** Fetch a post/ticket's comments for archiving alongside it. */
export async function snapshotComments(colPath: string): Promise<ArchivedComment[]> {
  try {
    const snap = await getDocs(collection(db, colPath));
    return snap.docs.map(d => ({ id: d.id, fields: d.data() as Record<string, any> }));
  } catch { return []; }
}

// ── Admin: live archive list ──────────────────────────────────────────────────

export function listenArchives(
  onData: (records: ArchiveRecord[]) => void,
  onError: (e: Error) => void,
  excludeReports = false,
): () => void {
  // The partial Hand must never receive archived report contents. The
  // constrained query lets Firestore prove that before returning any row.
  const q = excludeReports
    ? query(collection(db, 'archives'), where('type', '!=', 'report'))
    : query(collection(db, 'archives'), orderBy('deletedAt', 'desc'));
  return onSnapshot(q, snap => {
    const records = snap.docs.map(d => {
      const data = d.data() as any;
      return {
        id: d.id,
        type: data.type, section: data.section ?? '', title: data.title ?? '',
        ownerUid: data.ownerUid ?? '', ownerJokerId: data.ownerJokerId ?? '',
        restorePath: data.restorePath ?? '',
        payload: data.payload ?? {}, comments: data.comments ?? [],
        reviews: data.reviews ?? [],
        marks: data.marks ?? [],
        storagePaths: data.storagePaths ?? [],
        createdAtOriginal: data.createdAtOriginal ?? null,
        deletedAt: data.deletedAt ?? null,
        deletedByUid: data.deletedByUid ?? '',
      } as ArchiveRecord;
    });
    records.sort((a, b) => (b.deletedAt?.toMillis?.() ?? 0) - (a.deletedAt?.toMillis?.() ?? 0));
    onData(records);
  }, err => onError(err as Error));
}

// ── Admin: restore ────────────────────────────────────────────────────────────

/**
 * Put the item back exactly where it was deleted from. Refuses to overwrite:
 * if a doc already exists at the original location, the restore aborts so no
 * duplicate or clobber can happen.
 */
export async function restoreArchive(rec: ArchiveRecord): Promise<void> {
  if (rec.type === 'contract_signed') {
    // Not deleted content — a permanent record of a signing. Nothing to restore.
    throw new Error('This is a signing record, not deleted content. There is nothing to restore.');
  }
  const target = doc(db, rec.restorePath);
  const existing = await getDoc(target);
  if (existing.exists()) {
    throw new Error('Something already exists at the original location. Nothing was changed.');
  }

  if (rec.type === 'ante_comment' || rec.type === 'ticket_comment' || rec.type === 'vault_comment') {
    // Comments restore atomically with the parent's counter, mirroring the
    // normal comment-create batch so counter-integrity rules stay honest.
    const parentPath = rec.restorePath.split('/').slice(0, -2).join('/');
    const parent = await getDoc(doc(db, parentPath));
    if (!parent.exists()) {
      throw new Error('The original post no longer exists, so this comment has nowhere to return to. Restore the post first if it is also archived.');
    }
    const commentId = rec.restorePath.split('/').pop()!;
    const batch = writeBatch(db);
    batch.set(target, rec.payload);
    batch.update(doc(db, parentPath), {
      commentCount: increment(1),
      countedCommentId: commentId,
    });
    // Archive record is removed in the SAME atomic batch: either everything
    // is restored and the record is gone, or nothing changed at all.
    batch.delete(doc(db, 'archives', rec.id));
    await batch.commit();
  } else {
    // All-or-nothing: parent doc, every child comment, and the archive record
    // commit in one atomic batch. A failure anywhere leaves the archive intact.
    const batch = writeBatch(db);
    batch.set(target, rec.payload);
    for (const c of rec.comments) {
      batch.set(doc(db, `${rec.restorePath}/comments/${c.id}`), c.fields);
    }
    for (const r of rec.reviews) {
      batch.set(doc(db, `${rec.restorePath}/reviews/${r.id}`), r.fields);
    }
    for (const m of rec.marks) {
      batch.set(doc(db, `${rec.restorePath}/marks/${m.id}`), m.fields);
    }
    batch.delete(doc(db, 'archives', rec.id));
    await batch.commit();
  }
}

// ── Admin: permanent delete ───────────────────────────────────────────────────

/** Remove the archived copy AND its retained storage files forever.
 *  Fail-closed: the archive record is only deleted after every retained
 *  file is confirmed gone — a permission denial (e.g. the second Hand on a
 *  vault archive) or transient failure keeps the record intact. */
export async function purgeArchive(rec: ArchiveRecord): Promise<void> {
  await Promise.all(rec.storagePaths.map(p =>
    deleteObject(ref(storage, p)).catch((e: { code?: string }) => {
      if (e?.code === 'storage/object-not-found') return; // already gone
      throw e;
    })));
  await deleteDoc(doc(db, 'archives', rec.id));
}

export function formatArchiveTimestamp(ts: Timestamp | null): { date: string; time: string } {
  if (!ts?.toDate) return { date: '—', time: '' };
  const d = ts.toDate();
  return {
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

/** Human-readable text preview drawn from whichever fields the payload has. */
export function archivePreview(rec: ArchiveRecord): string {
  const p = rec.payload;
  const parts: string[] = [];
  for (const key of ['title', 'name', 'target', 'text', 'description', 'notes', 'location', 'date', 'price', 'category']) {
    const v = p[key];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    if (typeof v === 'number') parts.push(String(v));
  }
  return parts.join(' · ');
}
