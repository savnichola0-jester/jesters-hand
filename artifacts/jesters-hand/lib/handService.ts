// ── The Hand — member administration (00-00 and 01-54) ──────────────────────
// Roster of the 54 permanent Joker ID slots plus the three administrative
// actions. Suspend/Recover/Transfer are privileged Firebase Auth operations,
// so they run on the api-server (which re-verifies that the caller is the
// admin — the client gate alone is never trusted).
import { collection, onSnapshot } from 'firebase/firestore';
import { auth, db } from './firebase';
import { getApiDomain } from './apiConfig';

export interface RosterMember {
  uid: string;
  jokerId: string;
  street: string;
  name: string;
  suspended: boolean;
  isAdmin: boolean;
}

export interface RosterSlot {
  /** Permanent Joker ID, "01-54" … "54-54". */
  slotId: string;
  member: RosterMember | null;
}

/** All 54 permanent slot IDs in order. */
export const SLOT_IDS: string[] = Array.from(
  { length: 54 },
  (_, i) => `${String(i + 1).padStart(2, '0')}-54`,
);

/**
 * Live roster: maps each of the 54 permanent slots to its current member
 * profile (or null when the slot has no profile yet).
 */
export function listenRoster(cb: (slots: RosterSlot[]) => void): () => void {
  return onSnapshot(collection(db, 'users'), snap => {
    const byJokerId = new Map<string, RosterMember>();
    snap.docs.forEach(d => {
      const data = d.data() as Record<string, unknown>;
      const jokerId = String(data.jokerId ?? '').trim();
      if (!jokerId) return;
      byJokerId.set(jokerId.toLowerCase(), {
        uid: d.id,
        jokerId,
        street: String(data.street ?? ''),
        name: String(data.name ?? ''),
        suspended: data.suspended === true,
        isAdmin: data.isAdmin === true,
      });
    });
    cb(SLOT_IDS.map(slotId => ({
      slotId,
      member: byJokerId.get(slotId.toLowerCase()) ?? null,
    })));
  }, () => cb(SLOT_IDS.map(slotId => ({ slotId, member: null }))));
}

// ── Admin actions (api-server) ───────────────────────────────────────────────

async function adminPost(path: string, body: Record<string, unknown>): Promise<void> {
  const domain = getApiDomain();
  if (!domain) throw new Error('Server address is not configured.');
  const idToken = await auth.currentUser?.getIdToken();
  if (!idToken) throw new Error('Not signed in.');
  const res = await fetch(`https://${domain}/api/admin/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status}).`);
  }
}

/** Temporarily disable (or re-enable) a member's login. Data is untouched. */
export function setSuspended(targetUid: string, suspended: boolean): Promise<void> {
  return adminPost('suspend', { targetUid, suspended });
}

/** Reset only the member's cipher (password). Joker ID and data untouched. */
export function recoverCipher(targetUid: string, newPassword: string): Promise<void> {
  return adminPost('recover', { targetUid, newPassword });
}

/**
 * PERMANENT: wipe everything tied to the Joker ID and hand the clean slot to
 * a new member with a fresh cipher. The Joker ID itself never changes.
 */
export function transferSlot(
  targetUid: string,
  confirmJokerId: string,
  newPassword: string,
): Promise<void> {
  return adminPost('transfer', { targetUid, confirmJokerId, newPassword });
}
