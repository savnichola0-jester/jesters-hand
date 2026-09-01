// Session tracking — records login/logout history for the admin's
// Investigations tab. Each signed-in period writes one log doc under
// sessions/{uid}/logs/{id}: { startedAt, lastActiveAt, endedAt }.
//
// Phones kill apps without warning, so a clean "logout" write can't be
// guaranteed. The client therefore heartbeats lastActiveAt while the app is
// open; a session whose endedAt is null and whose lastActiveAt has gone
// stale is treated as having ended at lastActiveAt.
//
// Reads are ADMIN-ONLY per rules. Members can only create/update their own
// current session doc.

import {
  collection, doc, addDoc, updateDoc, getDocs, query, orderBy, limit,
  serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { db } from './firebase';

export interface SessionLog {
  id: string;
  startedAt: Timestamp | null;
  lastActiveAt: Timestamp | null;
  endedAt: Timestamp | null;
}

/** lastActiveAt older than this ⇒ the session is considered over. */
export const SESSION_STALE_MS = 3 * 60 * 1000;
/** How often the app refreshes lastActiveAt while in the foreground. */
export const HEARTBEAT_MS = 60 * 1000;

// ── Client side (the member's own device) ────────────────────────────────────

let currentUid: string | null = null;
let currentSessionId: string | null = null;

/** Begin a new session log for this sign-in. Best-effort; never throws. */
export async function startSession(uid: string): Promise<void> {
  try {
    if (currentSessionId && currentUid === uid) return; // already tracking
    const ref = await addDoc(collection(db, 'sessions', uid, 'logs'), {
      startedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
      endedAt: null,
    });
    currentUid = uid;
    currentSessionId = ref.id;
  } catch { /* tracking must never break the app */ }
}

/** Refresh lastActiveAt on the current session. Best-effort. */
export async function heartbeatSession(): Promise<void> {
  if (!currentUid || !currentSessionId) return;
  try {
    await updateDoc(doc(db, 'sessions', currentUid, 'logs', currentSessionId), {
      lastActiveAt: serverTimestamp(),
    });
  } catch { /* ignore */ }
}

/** Close the current session (called on sign-out). Best-effort. */
export async function endSession(): Promise<void> {
  const uid = currentUid, id = currentSessionId;
  currentUid = null;
  currentSessionId = null;
  if (!uid || !id) return;
  try {
    await updateDoc(doc(db, 'sessions', uid, 'logs', id), {
      lastActiveAt: serverTimestamp(),
      endedAt: serverTimestamp(),
    });
  } catch { /* ignore */ }
}

// ── Admin side (Investigations) ──────────────────────────────────────────────

/** Fetch a member's session history, newest first (admin-only per rules). */
export async function fetchSessions(uid: string, max = 200): Promise<SessionLog[]> {
  const snap = await getDocs(query(
    collection(db, 'sessions', uid, 'logs'),
    orderBy('startedAt', 'desc'),
    limit(max),
  ));
  return snap.docs.map(d => {
    const data = d.data();
    return {
      id: d.id,
      startedAt: data.startedAt ?? null,
      lastActiveAt: data.lastActiveAt ?? null,
      endedAt: data.endedAt ?? null,
    } as SessionLog;
  });
}

/**
 * The moment a session effectively ended: its explicit endedAt, or its last
 * heartbeat if the app was killed. Returns null while the session is live.
 */
export function sessionEnd(s: SessionLog, now = Date.now()): Date | null {
  if (s.endedAt) return s.endedAt.toDate();
  const last = s.lastActiveAt?.toDate();
  if (!last) return s.startedAt?.toDate() ?? null;
  return now - last.getTime() > SESSION_STALE_MS ? last : null; // null ⇒ live
}

/** Human duration like "2h 14m" or "38s". */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
