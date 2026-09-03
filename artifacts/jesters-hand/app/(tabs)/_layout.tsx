import { Redirect, Slot, usePathname } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';

export default function TabsLayout() {
  const { user, contractGateReady, contractGateRequired } = useAuth();
  const pathname = usePathname();

  // The Contract gate: a signed-in member who hasn't signed the current
  // contract (first login, or the Jester amended the rules) sees it before
  // anything else. The Jester (00-00) is exempt. The lock screen ('/') stays
  // reachable so sign-in itself is never blocked; /contract lives outside
  // this group.
  // Do not mount protected tabs while a returning member's current agreement
  // and the latest contract version are still being checked.
  if (user && (!contractGateReady || contractGateRequired === null)) return null;

  if (contractGateRequired && pathname !== '/') {
    return <Redirect href="/contract" />;
  }

  return <Slot />;
}
