import { Redirect, Slot, usePathname } from 'expo-router';
import { useAuth } from '@/contexts/AuthContext';

export default function TabsLayout() {
  const { needsContract } = useAuth();
  const pathname = usePathname();

  // The Contract gate: a signed-in member who hasn't signed the current
  // contract (first login, or the Jester amended the rules) sees it before
  // anything else. The Jester (00-00) is exempt. The lock screen ('/') stays
  // reachable so sign-in itself is never blocked; /contract lives outside
  // this group.
  if (needsContract && pathname !== '/') {
    return <Redirect href="/contract" />;
  }

  return <Slot />;
}
