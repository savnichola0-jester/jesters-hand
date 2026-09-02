// ── Vault service ─────────────────────────────────────────────────────────────
// The Vault holds admin-published reading files (The Stack) and artwork
// (The Wall). Files live in PRIVATE Firebase Storage under vault/{entryId}/…
// and are NEVER exposed through permanent/tokenized download URLs. Members
// fetch bytes through the authenticated Storage REST endpoint with their
// short-lived Firebase ID token; Storage rules re-verify (admin OR entry
// published) on every request via a cross-service Firestore lookup.

import {
  collection, doc, onSnapshot, query, where,
  setDoc, updateDoc, deleteDoc, addDoc, getDoc,
  serverTimestamp, Timestamp, deleteField, getDocs, orderBy, limit,
} from 'firebase/firestore';
import { Platform } from 'react-native';
import { ref, uploadBytesResumable, deleteObject } from 'firebase/storage';
import { auth, db, storage } from './firebase';
import { broadcastToActiveMembers } from './notificationService';

export type VaultSection = 'stack' | 'wall' | 'margins' | 'cut';
export type VaultStatus = 'published' | 'hidden' | 'archived';

/** One chapter inside a whole-manuscript PDF (1-based start page). */
export interface VaultChapter {
  title: string;
  startPage: number;
}

export interface VaultEntry {
  id: string;
  section: VaultSection;
  title: string;
  description?: string;
  status: VaultStatus;
  order: number;
  /** Manuscript chapters (auto-detected at upload, admin-correctable). */
  chapters?: VaultChapter[];
  /** Private storage path of the main file (document or artwork). */
  filePath?: string;
  fileName?: string;
  contentType?: string;
  /** Optional private storage path of a cover/thumbnail image. */
  coverPath?: string;
  /**
   * Decoder game lock (Chamber): sha256 hex of the normalized secret answer.
   * Members must enter the answer to open the entry; absent = no lock.
   */
  decoderHash?: string;
  /** Reader reactions on the whole entry (emoji → uid[]). */
  reactions?: Record<string, string[]>;
  /** Counter-verified number of reader comments. */
  commentCount?: number;
  /** Counter-verified number of reader reviews. */
  reviewCount?: number;
  /** Counter-verified sum of all review ratings (avg = ratingSum / reviewCount). */
  ratingSum?: number;
  createdBy: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface VaultEntryInput {
  title: string;
  description?: string;
  status?: VaultStatus;
  order?: number | null;
  /** Manuscript chapter map; null clears it. */
  chapters?: VaultChapter[] | null;
  /** Decoder lock hash; null clears it, undefined leaves it untouched. */
  decoderHash?: string | null;
}

/** Normalize a chapter list for writing: trim, clamp, sort, dedupe pages. */
export function normalizeChapters(chapters: VaultChapter[]): VaultChapter[] {
  const seen = new Set<number>();
  return chapters
    .map(c => ({ title: c.title.trim().slice(0, 120), startPage: Math.max(1, Math.floor(c.startPage || 1)) }))
    .filter(c => c.title.length > 0)
    .sort((a, b) => a.startPage - b.startPage)
    .filter(c => (seen.has(c.startPage) ? false : (seen.add(c.startPage), true)))
    .slice(0, 300);
}

export type VaultAction =
  | 'view' | 'upload' | 'edit' | 'replace'
  | 'publish' | 'hide' | 'archive' | 'restore' | 'delete' | 'reorder';

export interface VaultActivityRecord {
  id: string;
  uid: string;
  jokerId: string;
  street?: string;
  entryId: string;
  entryTitle: string;
  section: VaultSection;
  action: VaultAction;
  at?: Timestamp;
}

function publishedTitle(section: VaultSection): string {
  if (section === 'wall') return 'New sketch.';
  if (section === 'stack') return "The ink that doesn't come off.";
  if (section === 'cut') return 'The slide just racked.';
  return 'Loaded, not fired.';
}

function notifyPublishedEntry(uid: string, section: VaultSection): void {
  void broadcastToActiveMembers(uid, {
    type: 'announcement',
    title: publishedTitle(section),
    fromUid: uid,
    vaultSection: section,
    text: 'posted a new entry.',
  }).catch(() => {});
}

// ── Listeners ─────────────────────────────────────────────────────────────────

/**
 * Listen to one section of the Vault. Members may only query published
 * entries (rules reject broader reads); the admin sees every status.
 * Sorted by display order, then newest first.
 */
export function listenVaultSection(
  section: VaultSection,
  isAdmin: boolean,
  onEntries: (entries: VaultEntry[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const base = collection(db, 'vault');
  const q = isAdmin
    ? query(base, where('section', '==', section))
    : query(base, where('section', '==', section), where('status', '==', 'published'));
  return onSnapshot(q, snap => {
    const entries = snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<VaultEntry, 'id'>) }));
    entries.sort((a, b) =>
      (a.order ?? 0) - (b.order ?? 0) ||
      (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    onEntries(entries);
  }, e => onError?.(e));
}

export function listenVaultActivity(
  onRecords: (records: VaultActivityRecord[]) => void,
  onError?: (e: unknown) => void,
): () => void {
  const q = query(collection(db, 'vaultActivity'), orderBy('at', 'desc'), limit(200));
  return onSnapshot(q, snap => {
    onRecords(snap.docs.map(d => ({ id: d.id, ...(d.data() as Omit<VaultActivityRecord, 'id'>) })));
  }, e => onError?.(e));
}

// ── Uploads / CRUD (admin only — enforced by Firestore & Storage rules) ──────

async function uploadToPath(path: string, localUri: string, contentType?: string): Promise<void> {
  const res = await fetch(localUri);
  const blob = await res.blob();
  const task = uploadBytesResumable(ref(storage, path), blob, contentType ? { contentType } : undefined);
  await new Promise<void>((resolve, reject) => {
    task.on('state_changed', undefined, reject, () => resolve());
  });
}

export interface VaultFilePick {
  uri: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

/** Create a Vault entry: upload file (+ optional cover) then write the doc. */
export async function addVaultEntry(
  section: VaultSection,
  uid: string,
  input: VaultEntryInput,
  file: VaultFilePick,
  cover?: VaultFilePick | null,
): Promise<string> {
  const entryRef = doc(collection(db, 'vault'));
  const filePath = `vault/${entryRef.id}/file`;
  await uploadToPath(filePath, file.uri, file.mimeType);
  let coverPath: string | undefined;
  if (cover) {
    coverPath = `vault/${entryRef.id}/cover`;
    await uploadToPath(coverPath, cover.uri, cover.mimeType ?? 'image/jpeg');
  }
  await setDoc(entryRef, {
    section,
    title: input.title.trim(),
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    status: input.status ?? 'published',
    order: input.order ?? 0,
    ...(input.chapters?.length ? { chapters: normalizeChapters(input.chapters) } : {}),
    ...(input.decoderHash ? { decoderHash: input.decoderHash } : {}),
    filePath,
    ...(file.name ? { fileName: file.name } : {}),
    ...(file.mimeType ? { contentType: file.mimeType } : {}),
    ...(coverPath ? { coverPath } : {}),
    createdBy: uid,
    reactions: {},
    commentCount: 0,
    reviewCount: 0,
    ratingSum: 0,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  if ((input.status ?? 'published') === 'published') notifyPublishedEntry(uid, section);
  return entryRef.id;
}

export async function updateVaultEntry(entryId: string, input: Partial<VaultEntryInput>): Promise<void> {
  const before = input.status === 'published' ? await getDoc(doc(db, 'vault', entryId)) : null;
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (input.title !== undefined) patch.title = input.title.trim();
  if (input.description !== undefined) {
    patch.description = input.description.trim() ? input.description.trim() : deleteField();
  }
  if (input.status !== undefined) patch.status = input.status;
  if (input.order !== undefined) patch.order = input.order ?? 0;
  if (input.chapters !== undefined) {
    const normalized = input.chapters ? normalizeChapters(input.chapters) : [];
    patch.chapters = normalized.length ? normalized : deleteField();
  }
  if (input.decoderHash !== undefined) {
    patch.decoderHash = input.decoderHash ? input.decoderHash : deleteField();
  }
  await updateDoc(doc(db, 'vault', entryId), patch);
  const uid = auth.currentUser?.uid;
  if (uid && input.status === 'published' && before?.exists() && before.data().status !== 'published') {
    notifyPublishedEntry(uid, before.data().section as VaultSection);
  }
}

function replacementFilePath(entryId: string): string {
  const version = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `vault/${entryId}/file-${version}`;
}

/** Replace the main file (or cover) while keeping the same entry/card. */
export async function replaceVaultFile(
  entry: VaultEntry,
  file: VaultFilePick,
  which: 'file' | 'cover',
  replacementChapters?: VaultChapter[] | null,
): Promise<void> {
  // Main-file replacements use an immutable object name. Until the final
  // Firestore switch, Storage rules expose only entry.filePath (the old file);
  // after it, the old object becomes unreadable even to a stale client.
  const path = which === 'file'
    ? replacementFilePath(entry.id)
    : `vault/${entry.id}/cover`;
  const entryRef = doc(db, 'vault', entry.id);
  await uploadToPath(path, file.uri, file.mimeType);
  const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
  if (which === 'file') {
    patch.filePath = path;
    patch.fileName = file.name ?? deleteField();
    patch.contentType = file.mimeType ?? deleteField();
    const normalized = replacementChapters ? normalizeChapters(replacementChapters) : [];
    patch.chapters = normalized.length ? normalized : deleteField();
  } else {
    patch.coverPath = path;
  }
  try {
    // One atomic document update publishes the new object pointer, metadata,
    // and its matching chapter map together.
    await updateDoc(entryRef, patch);
  } catch (error) {
    if (which === 'file') {
      // The staged object was never published. Best-effort cleanup; Storage
      // rules deny reads because entry.filePath still points at the old file.
      await deleteObject(ref(storage, path)).catch(() => {});
    }
    throw error;
  }
  if (which === 'file' && entry.filePath && entry.filePath !== path) {
    // Once the pointer switched, the previous object is no longer readable.
    // Physical cleanup is best-effort and cannot compromise consistency.
    deleteObject(ref(storage, entry.filePath)).catch(() => {});
  }
}

export async function deleteVaultEntry(entry: VaultEntry): Promise<void> {
  // Archive FIRST. The file & cover are intentionally KEPT in storage until
  // the admin permanently deletes the entry from Archives.
  const snap = await getDoc(doc(db, 'vault', entry.id));
  if (snap.exists()) {
    const data = snap.data() as any;
    const [{ archiveItem }, { snapshotVaultSub }] = await Promise.all([
      import('./archiveService'),
      import('./vaultDiscussionService'),
    ]);
    await archiveItem({
      type: 'vault_entry',
      section: 'The Vault',
      title: data.title ?? '',
      ownerUid: data.createdBy ?? auth.currentUser?.uid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `vault/${entry.id}`,
      payload: data,
      comments: await snapshotVaultSub(entry.id, 'comments'),
      reviews: await snapshotVaultSub(entry.id, 'reviews'),
      marks: await snapshotVaultSub(entry.id, 'marks'),
    });
  }
  await deleteDoc(doc(db, 'vault', entry.id));
  // Best-effort orphan sweep: once the entry is gone, rules let any member
  // clear leftover comments/reviews (parent no longer exists after the batch).
  try {
    const { writeBatch: wb, collection: col, getDocs: gd } = await import('firebase/firestore');
    for (const sub of ['comments', 'reviews', 'marks'] as const) {
      const subSnap = await gd(col(db, 'vault', entry.id, sub));
      const refs = subSnap.docs.map(d => d.ref);
      for (let i = 0; i < refs.length; i += 400) {
        const batch = wb(db);
        refs.slice(i, i + 400).forEach(r => batch.delete(r));
        await batch.commit().catch(() => {});
      }
    }
  } catch { /* ignore — the entry itself is already gone */ }
}

// ── Protected content fetch ───────────────────────────────────────────────────
// Downloads bytes through the Storage REST endpoint using the caller's
// short-lived Firebase ID token. No download token / permanent URL is ever
// created or stored; Storage rules re-check permission on every request.

const BUCKET = process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET as string;

/**
 * Short-lived fetch parameters for protected content. The URL alone grants
 * nothing — the Authorization header with the caller's ID token is required,
 * and Storage rules re-verify on every request. Used by the document reader
 * to stream bytes directly inside its sandboxed WebView (no base64 data URI,
 * so large files don't triple memory use in JS before reaching the reader).
 */
export async function getProtectedFetchInfo(path: string): Promise<{ url: string; token: string }> {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in');
  const token = await user.getIdToken();
  const url = `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(path)}?alt=media`;
  return { url, token };
}

/**
 * Fetch a protected image for viewing WITHOUT building a base64 data URI
 * (which roughly triples memory for multi-MB artwork). On native the bytes
 * are downloaded to a private temp cache file (file:// URI) that the caller
 * must release when done; on web a blob object URL is used instead. The
 * transport is identical to the other protected fetches: short-lived ID
 * token in the Authorization header, no permanent/tokenized URL ever created.
 */
export interface ProtectedImageHandle {
  uri: string;
  /** Release the backing resource (delete temp file / revoke object URL). */
  release: () => void;
}

export async function fetchProtectedImage(path: string, fallbackMime = 'image/jpeg'): Promise<ProtectedImageHandle> {
  const { url, token: idToken } = await getProtectedFetchInfo(path);
  if (Platform.OS === 'web') {
    const res = await fetch(url, { headers: { Authorization: `Firebase ${idToken}` } });
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    let blob = await res.blob();
    // Some blobs come back typed application/octet-stream; keep a usable mime.
    if (!blob.type || blob.type === 'application/octet-stream') {
      blob = blob.slice(0, blob.size, fallbackMime);
    }
    const objectUrl = URL.createObjectURL(blob);
    return { uri: objectUrl, release: () => URL.revokeObjectURL(objectUrl) };
  }
  // Native: stream straight to a temp cache file — bytes never pass through
  // base64 or the JS heap. File is deleted by release() when viewing ends.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const FileSystem = require('expo-file-system/legacy');
  const dest = `${FileSystem.cacheDirectory}vault-view-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dl = await FileSystem.downloadAsync(url, dest, {
    headers: { Authorization: `Firebase ${idToken}` },
  });
  if (dl.status !== 200) {
    FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {});
    throw new Error(`Fetch failed (${dl.status})`);
  }
  return {
    uri: dl.uri,
    release: () => { FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => {}); },
  };
}

/**
 * Best-effort startup sweep: delete any leftover `vault-view-*` temp files
 * from the cache directory. Files are normally removed by release() when the
 * viewer closes, but an app kill mid-view can leave one behind. Non-blocking;
 * silently no-ops on web or any filesystem error.
 */
export async function sweepVaultTempFiles(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const FileSystem = require('expo-file-system/legacy');
    const cacheDir: string | null = FileSystem.cacheDirectory;
    if (!cacheDir) return;
    const names: string[] = await FileSystem.readDirectoryAsync(cacheDir);
    await Promise.all(
      names
        .filter(n => n.startsWith('vault-view-'))
        .map(n => FileSystem.deleteAsync(`${cacheDir}${n}`, { idempotent: true }).catch(() => {})),
    );
  } catch {
    // Best-effort only — never let cache cleanup affect app startup.
  }
}

export async function fetchProtectedDataUri(path: string, fallbackMime = 'application/octet-stream'): Promise<string> {
  const { url, token: idToken } = await getProtectedFetchInfo(path);
  const res = await fetch(url, { headers: { Authorization: `Firebase ${idToken}` } });
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Read failed'));
    reader.onloadend = () => {
      let uri = String(reader.result);
      // Some blobs come back typed application/octet-stream; keep a usable mime.
      if (uri.startsWith('data:application/octet-stream') && fallbackMime !== 'application/octet-stream') {
        uri = uri.replace('data:application/octet-stream', `data:${fallbackMime}`);
      }
      resolve(uri);
    };
    reader.readAsDataURL(blob);
  });
}

// ── Activity records ──────────────────────────────────────────────────────────
// Members may only log their own 'view' actions; the admin logs management
// actions. Records are create-only and readable by the admin alone (rules).

export async function logVaultActivity(
  action: VaultAction,
  entry: { id: string; title: string; section: VaultSection },
  who: { uid: string; jokerId: string; street?: string },
): Promise<void> {
  try {
    await addDoc(collection(db, 'vaultActivity'), {
      uid: who.uid,
      jokerId: who.jokerId,
      ...(who.street ? { street: who.street } : {}),
      entryId: entry.id,
      entryTitle: entry.title,
      section: entry.section,
      action,
      at: serverTimestamp(),
    });
  } catch {
    // Activity logging must never block viewing or management.
  }
}
