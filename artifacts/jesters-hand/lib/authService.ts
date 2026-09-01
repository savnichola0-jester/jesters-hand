/**
 * Auth session helpers.
 *
 * Sign-out must go through signOutUser() — it clears this device's push
 * token from the user's doc BEFORE Firebase sign-out (rules require the
 * owner to be authenticated to write their own doc). Otherwise the previous
 * account's honors and whispers keep popping up on this phone's lock screen.
 */
import { signOut } from 'firebase/auth';
import { auth } from './firebase';
import { unregisterPushToken } from './pushService';
import { endSession } from './sessionService';

/** Clear this device's push token, close the session log, then sign out. */
export async function signOutUser(): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (uid) await unregisterPushToken(uid); // best-effort; never throws
  await endSession();                      // best-effort; never throws
  await signOut(auth);
}

// ── Suspension notice ───────────────────────────────────────────────────────
// When AuthContext force-signs-out a member whose account was suspended
// mid-session, it sets this flag; the lock screen consumes it once to show
// the "currently suspended" message.
let suspensionNotice = false;

export function setSuspensionNotice(): void {
  suspensionNotice = true;
}

/** Returns true (once) if the last sign-out was due to suspension. */
export function consumeSuspensionNotice(): boolean {
  const v = suspensionNotice;
  suspensionNotice = false;
  return v;
}
