// Report ("Card") service — members file reports against another Joker ID
// from inside a whisper. Reports land in the admin-only Reports tab of
// Jester's Hand. Evidence photos live in private Storage under
// reports/{reporterUid}/{reportId}/img_N — readable ONLY by the admin.

import {
  collection, doc, getDoc, setDoc, onSnapshot, orderBy, query,
  serverTimestamp, Timestamp, deleteDoc, where, limit, getDocs, addDoc, updateDoc,
} from 'firebase/firestore';
import { ref, uploadBytesResumable, getDownloadURL, deleteObject } from 'firebase/storage';
import { db, storage, auth } from './firebase';
import { sendPushToUsers } from './pushService';

export interface Report {
  id: string;
  reporterUid: string;
  reporterJokerId: string;
  reportedUid: string;
  reportedJokerId: string;
  title: string;
  date: string;             // incident date as written by the reporter
  description: string;
  evidencePaths: string[];  // storage paths, admin-only readable
  createdAt: Timestamp | null;
  status: 'open' | 'resolved';  // legacy reports without the field are 'open'
}

export const MAX_EVIDENCE = 10;

export interface SubmitReportInput {
  reportedUid: string;
  title: string;
  date: string;
  description: string;
  photoUris: string[];      // local URIs from the image picker (1..MAX_EVIDENCE)
}

/** File a report. Uploads every evidence photo first, then writes the doc. */
export async function submitReport(input: SubmitReportInput): Promise<void> {
  const me = auth.currentUser;
  if (!me) throw new Error('Not signed in');
  if (input.photoUris.length === 0) throw new Error('Evidence is required');
  if (input.photoUris.length > MAX_EVIDENCE) throw new Error(`At most ${MAX_EVIDENCE} photos`);

  // Snapshot both Joker IDs at filing time (slots can transfer later).
  const [mineSnap, theirsSnap] = await Promise.all([
    getDoc(doc(db, 'users', me.uid)),
    getDoc(doc(db, 'users', input.reportedUid)),
  ]);
  const reporterJokerId = (mineSnap.data()?.jokerId as string | undefined) ?? '??-??';
  const reportedJokerId = (theirsSnap.data()?.jokerId as string | undefined) ?? '??-??';

  const reportRef = doc(collection(db, 'reports'));
  const evidencePaths: string[] = [];

  try {
    for (let i = 0; i < input.photoUris.length; i++) {
      const path = `reports/${me.uid}/${reportRef.id}/img_${i}`;
      const resp = await fetch(input.photoUris[i]);
      const blob = await resp.blob();
      await new Promise<void>((resolve, reject) => {
        const task = uploadBytesResumable(ref(storage, path), blob, { contentType: 'image/jpeg' });
        task.on('state_changed', undefined, reject, () => resolve());
      });
      evidencePaths.push(path);
    }

    await setDoc(reportRef, {
      reporterUid: me.uid,
      reporterJokerId,
      reportedUid: input.reportedUid,
      reportedJokerId,
      title: input.title.trim(),
      date: input.date.trim(),
      description: input.description.trim(),
      evidencePaths,
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    // Don't leave orphaned evidence behind if the filing failed midway.
    await cleanupEvidence(evidencePaths);
    throw err;
  }

  // Ping the Jester — bell notification + push, best-effort AFTER the report
  // is safely committed (a notification hiccup must never fail the filing).
  // Text stays generic: report contents never leave the Reports tab.
  await notifyAdminOfReport(me.uid).catch(err =>
    console.warn('[reports] admin notification failed:', err));
}

// (Members can't delete their own uploads per storage rules, so this is a
// best-effort request; the report doc itself was never written.)
async function cleanupEvidence(evidencePaths: string[]): Promise<void> {
  await Promise.all(evidencePaths.map(p =>
    deleteObject(ref(storage, p)).catch(() => { /* best effort */ })));
}

/**
 * Bell + push notification to the admin (the Jester) that a card was passed.
 * Deliberately generic — never includes the report's contents or parties.
 * The push payload carries no fromUid so the lock-screen banner stays
 * anonymous too; the notification doc keeps fromUid (rules require honest
 * attribution) but that feed is readable only by the admin.
 */
async function notifyAdminOfReport(reporterUid: string): Promise<void> {
  const adminSnap = await getDocs(query(
    collection(db, 'users'),
    where('jokerId', '==', '00-00'),
    where('isAdmin', '==', true),
  ));
  // Fail closed if the permanent seat is missing or duplicated. A sensitive
  // report alert must never be guessed onto the wrong account.
  const adminUid = adminSnap.size === 1 ? adminSnap.docs[0]?.id : undefined;
  if (!adminUid || adminUid === reporterUid) return;

  await addDoc(collection(db, 'notifications', adminUid, 'items'), {
    type: 'filed_report',
    title: 'Someone is bleeding out.',
    fromUid: reporterUid,
    text: 'A new card has been passed.',
    createdAt: serverTimestamp(),
    read: false,
  });
  // Push mirror, post-commit, best-effort. No fromUid → generic banner.
  void sendPushToUsers([adminUid], {
    type: 'filed_report',
    title: 'Someone is bleeding out.',
    text: 'A new card has been passed.',
  });
}

// ── Admin side ────────────────────────────────────────────────────────────────

export function listenReports(cb: (reports: Report[]) => void): () => void {
  const q = query(collection(db, 'reports'), orderBy('createdAt', 'desc'));
  return onSnapshot(q, snap => {
    cb(snap.docs.map(d => {
      const data = d.data();
      return {
        id: d.id,
        reporterUid: data.reporterUid ?? '',
        reporterJokerId: data.reporterJokerId ?? '??-??',
        reportedUid: data.reportedUid ?? '',
        reportedJokerId: data.reportedJokerId ?? '??-??',
        title: data.title ?? '',
        date: data.date ?? '',
        description: data.description ?? '',
        evidencePaths: Array.isArray(data.evidencePaths) ? data.evidencePaths : [],
        createdAt: data.createdAt ?? null,
        status: data.status === 'resolved' ? 'resolved' : 'open',
      } as Report;
    }));
  });
}

/**
 * Resolve evidence storage paths to viewable URLs (admin only per rules).
 * Tolerant of individual failures: a broken file yields null instead of
 * blanking the whole set.
 */
export async function fetchEvidenceUrls(paths: string[]): Promise<(string | null)[]> {
  return Promise.all(paths.map(p =>
    getDownloadURL(ref(storage, p)).catch(() => null)));
}

/** Admin: mark a report resolved (kept, but moved out of the live queue) or reopen it. */
export async function setReportStatus(reportId: string, status: 'open' | 'resolved'): Promise<void> {
  await updateDoc(doc(db, 'reports', reportId), { status });
}

/** Admin: discard a report. Evidence files are intentionally KEPT in storage —
 * they stay with the archived report until it is permanently deleted. */
export async function deleteReport(report: Report): Promise<void> {
  const snap = await getDoc(doc(db, 'reports', report.id));
  if (snap.exists()) {
    const data = snap.data() as any;
    const { archiveItem } = await import('./archiveService');
    await archiveItem({
      type: 'report',
      section: 'Reports',
      title: data.title ?? '',
      ownerUid: data.reporterUid ?? '',
      deletedByUid: auth.currentUser?.uid ?? '',
      restorePath: `reports/${report.id}`,
      payload: data,
    });
  }
  await deleteDoc(doc(db, 'reports', report.id));
}

export function formatReportTimestamp(ts: Timestamp | null): { date: string; time: string } {
  if (!ts) return { date: '—', time: '' };
  const d = ts.toDate();
  return {
    date: d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}
