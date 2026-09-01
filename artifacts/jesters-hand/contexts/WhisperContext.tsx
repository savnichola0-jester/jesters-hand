import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { listenConversations, listenAllMembers, Conversation, Member } from '@/lib/whisperService';
import { useAuth } from './AuthContext';

interface WhisperContextType {
  conversations: Conversation[];
  totalUnread:   number;
  /** Live list of all members — re-fires on any profile change. */
  allMembers:    Member[];
  /** True once the first member snapshot has arrived. */
  membersReady:  boolean;
  /** uid → display label, always fresh. */
  memberCache:   Record<string, string>;
  /** uid → mug photo URL, always fresh. */
  avatarCache:   Record<string, string>;
}

const WhisperContext = createContext<WhisperContextType>({
  conversations: [],
  totalUnread:   0,
  allMembers:    [],
  membersReady:  false,
  memberCache:   {},
  avatarCache:   {},
});

export function WhisperProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [allMembers, setAllMembers]       = useState<Member[]>([]);
  const [membersReady, setMembersReady]   = useState(false);

  useEffect(() => {
    if (!user) {
      setConversations([]);
      return;
    }
    const unsub = listenConversations(user.uid, setConversations);
    return unsub;
  }, [user?.uid]);

  // Single app-wide member listener — every screen shares the same live
  // caches, so avatar/name changes propagate everywhere immediately.
  useEffect(() => {
    if (!user) {
      setAllMembers([]);
      setMembersReady(false);
      return;
    }
    const unsub = listenAllMembers(members => {
      setAllMembers(members);
      setMembersReady(true);
    });
    return unsub;
  }, [user?.uid]);

  const { memberCache, avatarCache } = useMemo(() => {
    const names: Record<string, string>   = {};
    const avatars: Record<string, string> = {};
    allMembers.forEach(m => {
      names[m.uid] = m.name ?? m.jokerId ?? m.uid.slice(0, 6);
      if (m.mugUrl) avatars[m.uid] = m.mugUrl;
    });
    return { memberCache: names, avatarCache: avatars };
  }, [allMembers]);

  const totalUnread = conversations.reduce(
    (sum, c) => sum + (c.unreadCounts[user?.uid ?? ''] ?? 0),
    0,
  );

  return (
    <WhisperContext.Provider
      value={{ conversations, totalUnread, allMembers, membersReady, memberCache, avatarCache }}
    >
      {children}
    </WhisperContext.Provider>
  );
}

export function useWhisper() {
  return useContext(WhisperContext);
}
