/**
 * Voice service — live voice channels for Jester's Table, powered by Agora.
 *
 * The native Agora engine (react-native-agora) is only present in real
 * development/store builds — Expo Go cannot load it. Everything here degrades
 * gracefully: `voiceSupported()` reports availability, and join attempts in
 * unsupported environments throw a friendly error.
 *
 * Tokens: the client never sees the Agora App Certificate. It asks the
 * api-server (POST /api/agora/token, authenticated with the member's Firebase
 * ID token) for a short-lived RTC token bound to their uid + channel.
 */
import {
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc,
  serverTimestamp, Timestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase';
import { getApiDomain } from './apiConfig';

// ── Engine module ─────────────────────────────────────────────────────────────
//
// The actual audio engine lives in voiceEngine.web.ts (Agora Web SDK — the
// primary target, since members use the browser / home-screen web app) and
// voiceEngine.ts (native builds). Metro picks the right file per platform;
// Expo Go has neither engine and degrades gracefully.

import { engineSupported, engineJoin } from './voiceEngine';

/** True when a live-voice engine can exist in this environment. */
export function voiceSupported(): boolean {
  return engineSupported();
}

// ── Engine lifecycle ──────────────────────────────────────────────────────────

export interface VoiceSession {
  channelId: string;
  leave: () => void;
  setMuted: (muted: boolean) => void;
}

export interface VoiceEvents {
  /** uids currently in the channel (including self). */
  onMembersChanged?: (count: number) => void;
  /** Firebase uids of members currently speaking (including self). */
  onSpeakersChanged?: (speakingUids: string[]) => void;
  /** Fired when the session ends for any reason. */
  onEnded?: () => void;
}

let activeSession: VoiceSession | null = null;

// ── Voice presence (Firestore) ────────────────────────────────────────────────
//
// Agora membership is invisible to clients outside a channel, so each member
// announces their seat at voicePresence/{channelId}/members/{uid} on join,
// heartbeats lastActiveAt every minute, and deletes the doc on leave. An
// entry whose heartbeat has been silent for over PRESENCE_STALE_MS is stale
// (connection lost / app killed) — listeners hide it and any member may
// sweep it (rules allow deleting entries stale for >3 minutes).

export const PRESENCE_STALE_MS = 3 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

export interface VoicePresenceEntry {
  uid: string;
  jokerId: string;
  lastActiveAt: Timestamp | null;
}

/** True when the entry's heartbeat is recent enough to count as present. */
export function isPresenceFresh(e: VoicePresenceEntry, nowMs: number = Date.now()): boolean {
  // A null lastActiveAt means the serverTimestamp hasn't resolved yet
  // (doc just created) — that is the freshest an entry can be.
  return e.lastActiveAt === null || nowMs - e.lastActiveAt.toMillis() < PRESENCE_STALE_MS;
}

/** Live listener for who is sitting in a voice channel (unfiltered — callers
 *  apply isPresenceFresh so stale ghosts don't render). */
export function listenVoicePresence(
  channelId: string,
  cb: (entries: VoicePresenceEntry[]) => void,
): () => void {
  return onSnapshot(
    collection(db, 'voicePresence', channelId, 'members'),
    snap => {
      cb(snap.docs.map(d => ({
        uid: d.id,
        jokerId: (d.data().jokerId as string) ?? '',
        lastActiveAt: (d.data().lastActiveAt as Timestamp | undefined) ?? null,
      })));
    },
    () => cb([]),
  );
}

/** Best-effort sweep of stale entries (rules permit anyone to delete them). */
export function sweepStalePresence(channelId: string, entries: VoicePresenceEntry[]): void {
  const nowMs = Date.now();
  entries
    .filter(e => !isPresenceFresh(e, nowMs))
    .forEach(e => {
      deleteDoc(doc(db, 'voicePresence', channelId, 'members', e.uid)).catch(() => {});
    });
}

let presenceHeartbeat: ReturnType<typeof setInterval> | null = null;
let presenceChannelId: string | null = null;
let presenceJokerId: string | null = null;

function startPresence(channelId: string, jokerId: string): void {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  stopPresence();
  presenceChannelId = channelId;
  presenceJokerId = jokerId;
  const ref = doc(db, 'voicePresence', channelId, 'members', uid);
  setDoc(ref, {
    jokerId,
    joinedAt: serverTimestamp(),
    lastActiveAt: serverTimestamp(),
  }).catch(() => {});
  presenceHeartbeat = setInterval(() => {
    updateDoc(ref, { lastActiveAt: serverTimestamp() }).catch(() => {});
  }, HEARTBEAT_MS);
}

function stopPresence(): void {
  if (presenceHeartbeat) { clearInterval(presenceHeartbeat); presenceHeartbeat = null; }
  const uid = auth.currentUser?.uid;
  if (presenceChannelId && uid) {
    // Best-effort: if the network is already gone, the stale sweep covers it.
    deleteDoc(doc(db, 'voicePresence', presenceChannelId, 'members', uid)).catch(() => {});
  }
  presenceChannelId = null;
  presenceJokerId = null;
}

/**
 * Immediately re-announce our own presence (if seated). Called when the app
 * returns to the foreground: JS timers pause in the background, so after 2+
 * minutes the heartbeat is late and our entry may look stale to others (and
 * may even have been swept). setDoc with merge recreates it either way.
 */
export function refreshPresenceHeartbeat(): void {
  const uid = auth.currentUser?.uid;
  if (!presenceChannelId || !uid || !presenceHeartbeat) return;
  const channelId = presenceChannelId;
  const jokerId = presenceJokerId ?? '';
  const ref = doc(db, 'voicePresence', channelId, 'members', uid);
  updateDoc(ref, { lastActiveAt: serverTimestamp() }).catch(() => {
    // Doc was swept while we were backgrounded — recreate it with the full
    // shape the rules require, but only if we're still seated in that channel.
    if (presenceChannelId !== channelId) return;
    setDoc(ref, {
      jokerId,
      joinedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    }).catch(() => {});
  });
}

async function fetchVoiceToken(channelId: string): Promise<{
  appId: string; token: string; uid: string;
}> {
  const domain = getApiDomain();
  const idToken = await auth.currentUser?.getIdToken();
  if (!domain || !idToken) throw new Error('Not signed in.');
  const res = await fetch(`https://${domain}/api/agora/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify({ channel: channelId }),
  });
  if (!res.ok) {
    throw new Error(res.status === 500
      ? 'Voice service is not configured yet.'
      : 'Could not get a voice pass.');
  }
  return res.json();
}

/**
 * Join a voice channel. Resolves with a session handle once connected.
 * Any previously active session is left first (one channel at a time).
 */
export async function joinVoiceChannel(
  channelId: string,
  jokerId: string,
  events: VoiceEvents = {},
): Promise<VoiceSession> {
  if (!voiceSupported()) {
    throw new Error('Live voice works in the browser app — it is not available in Expo Go.');
  }
  activeSession?.leave();

  const { appId, token, uid } = await fetchVoiceToken(channelId);

  let ended = false; // onEnded fires exactly once, whether we leave or drop
  const endOnce = () => {
    if (ended) return;
    ended = true;
    stopPresence();
    if (activeSession === session) activeSession = null;
    events.onEnded?.();
  };

  const handle = await engineJoin(appId, channelId, token, uid, {
    onMembersChanged: count => events.onMembersChanged?.(count),
    onSpeakersChanged: uids => events.onSpeakersChanged?.(uids),
    onEnded: endOnce,
    // Agora tokens live ~1h. Shortly before expiry the engine warns us —
    // fetch a fresh token from the relay and hand it over so the member
    // stays in the channel with no interruption. If the fetch fails the
    // engine expires as before and onEnded fires; nothing worse happens.
    onTokenWillExpire: () => {
      fetchVoiceToken(channelId)
        .then(fresh => handle.renewToken(fresh.token))
        .catch(() => {});
    },
  });
  startPresence(channelId, jokerId);

  const session: VoiceSession = {
    channelId,
    leave: () => {
      handle.leave();
      endOnce();
    },
    setMuted: (muted: boolean) => handle.setMuted(muted),
  };
  activeSession = session;
  return session;
}


/** Leave whatever voice channel is active (safe to call anytime). */
export function leaveVoice(): void {
  activeSession?.leave();
}
