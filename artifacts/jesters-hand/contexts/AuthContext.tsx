import React, { createContext, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { onAuthStateChanged, User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { router } from 'expo-router';
import { auth, db } from '@/lib/firebase';
import { registerPushToken } from '@/lib/pushService';
import { signOutUser, setSuspensionNotice } from '@/lib/authService';
import { startSession, heartbeatSession, endSession, HEARTBEAT_MS } from '@/lib/sessionService';

import { getAgreement, Agreement } from '@/lib/agreementService';
import { listenContract, BUNDLED_CONTRACT } from '@/lib/contractService';

interface AuthContextType {
  user: User | null;
  jokerId: string | null;
  isAdmin: boolean;
  /** Either explicitly provisioned Hand seat (00-00 or 01-54). */
  isHandAdmin: boolean;
  /** Authenticated permanent owner seat. Admin authority alone is not enough. */
  isJester: boolean;
  /** Admin who may also curate Vault/Chamber documents (00-00). The second
   *  Hand has isAdmin without this. */
  isVaultKeeper: boolean;
  loading: boolean;
  /** null = still checking; Agreement = signed; false = not signed yet. */
  agreement: Agreement | false | null;
  refreshAgreement: () => Promise<void>;
  /** Live version of the contract wording (bundled version until amended). */
  contractVersion: number;
  /** True when this member must (re-)sign the contract before entering. */
  needsContract: boolean;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  jokerId: null,
  isAdmin: false,
  isHandAdmin: false,
  isJester: false,
  isVaultKeeper: false,
  loading: true,
  agreement: null,
  refreshAgreement: async () => {},
  contractVersion: BUNDLED_CONTRACT.version,
  needsContract: false,
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser]       = useState<User | null>(null);
  const [jokerId, setJokerId] = useState<string | null>(null);
  const [adminFlag, setAdminFlag] = useState(false);
  const [isVaultKeeper, setIsVaultKeeper] = useState(false);
  const [loading, setLoading] = useState(true);
  const [agreement, setAgreement] = useState<Agreement | false | null>(null);
  const [contractVersion, setContractVersion] = useState(BUNDLED_CONTRACT.version);
  const isAdmin = !!user && adminFlag && jokerId === '00-00';
  const isJester = isAdmin;
  const isHandAdmin = !!user && adminFlag && (jokerId === '00-00' || jokerId === '01-54');

  // Live contract version — when the Jester amends the rules, members whose
  // signature is older than the current version get gated to re-sign.
  useEffect(() => {
    if (!user) return;
    const unsub = listenContract(c => setContractVersion(c.version));
    return unsub;
  }, [user]);

  // The Contract gate: check for the member's signed agreement on sign-in.
  // Fail open (treat as signed) on read errors so a network hiccup can't
  // trap a long-standing member on the contract screen.
  const refreshAgreement = React.useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) { setAgreement(null); return; }
    try {
      const a = await getAgreement(uid);
      setAgreement(a ?? false);
    } catch {
      // Fail open: an unreadable agreement must never keep blocking the app
      // (especially right after a successful sign) — keep a loaded agreement
      // if we have one, otherwise fall back to non-blocking "unknown".
      setAgreement(prev => (prev ? prev : null));
    }
  }, []);

  useEffect(() => {
    // Live subscription to the signed-in user's own doc. Suspend revokes
    // refresh tokens server-side, but an ID token already on this device
    // stays valid for up to ~1 hour — so we watch users/{uid}.suspended and
    // force sign-out the moment it flips true.
    let unsubDoc: (() => void) | null = null;
    let signingOut = false;

    const unsubAuth = onAuthStateChanged(auth, (u) => {
      if (unsubDoc) { unsubDoc(); unsubDoc = null; }
      setUser(u);
      if (u) {
        unsubDoc = onSnapshot(
          doc(db, 'users', u.uid),
          (snap) => {
            const data = snap.exists() ? snap.data() : null;
            if (data?.suspended === true) {
              if (!signingOut) {
                signingOut = true;
                setSuspensionNotice();
                void signOutUser()
                  .catch(() => {})
                  .finally(() => {
                    signingOut = false;
                    router.replace('/');
                  });
              }
              return;
            }
            setJokerId(data?.jokerId ?? null);
            setAdminFlag(data?.isAdmin === true);
            // Privileged capabilities always require both the server-pinned
            // flag and the exact seat. Unknown admin flags fail closed.
            setIsVaultKeeper(data?.isAdmin === true && data?.jokerId === '00-00');
            setLoading(false);
          },
          () => {
            setJokerId(null);
            setAdminFlag(false);
            setIsVaultKeeper(false);
            setLoading(false);
          }
        );
        // Contract gate status for this member.
        void refreshAgreement();
        // Best-effort: store this device's push token on the user doc.
        void registerPushToken(u.uid);
        // Session log for the admin's Investigations timeline.
        void startSession(u.uid);
      } else {
        setJokerId(null);
        setAdminFlag(false);
        setIsVaultKeeper(false);
        setAgreement(null);
        setLoading(false);
      }
    });

    return () => {
      if (unsubDoc) unsubDoc();
      unsubAuth();
    };
  }, []);

  // Session heartbeat: refresh lastActiveAt while the app is in the
  // foreground so a killed app still leaves an accurate "last seen" time.
  useEffect(() => {
    if (!user) return;
    const tick = () => { void heartbeatSession(); };
    const interval = setInterval(tick, HEARTBEAT_MS);
    const sub = AppState.addEventListener('change', (state) => {
      // Both foregrounding and backgrounding stamp the log — the background
      // stamp is the best available "logged out" moment if the OS kills us.
      if (state === 'active' || state === 'background' || state === 'inactive') tick();
    });
    return () => { clearInterval(interval); sub.remove(); };
  }, [user?.uid]);

  // App unmount (rare on native, common on web reloads): close the session.
  useEffect(() => () => { void endSession(); }, []);

  return (
    <AuthContext.Provider value={{
      user, jokerId, isAdmin, isHandAdmin, isJester, isVaultKeeper, loading, agreement, refreshAgreement,
      contractVersion,
      // The Jester (00-00) never signs. Members are gated when they have no
      // signature, or when their signature predates the current wording.
      // agreement === null (still checking / read error) never blocks.
      needsContract: !!user && !isJester && (
        agreement === false || (!!agreement && agreement.version < contractVersion)
      ),
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
