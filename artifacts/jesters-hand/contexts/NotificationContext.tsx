import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  AppNotification,
  listenNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  clearAllNotifications,
} from '@/lib/notificationService';
import { Platform } from 'react-native';
import { routeNotification, NotificationRoutingData } from '@/lib/notificationRouting';
import { useAuth } from './AuthContext';

interface NotificationContextType {
  notifications: AppNotification[];
  unreadCount:   number;
  markOneRead:   (id: string) => Promise<void>;
  markAll:       () => Promise<void>;
  clearAll:      () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  unreadCount:   0,
  markOneRead:   async () => {},
  markAll:       async () => {},
  clearAll:      async () => {},
});

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }
    const unsub = listenNotifications(user.uid, setNotifications);
    return unsub;
  }, [user?.uid]);

  // Push notification taps → same routing as the bell panel.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let sub: { remove: () => void } | undefined;
    let cancelled = false;

    (async () => {
      try {
        const Notifications = await import('expo-notifications');

        const route = (data: unknown) => {
          const d = data as NotificationRoutingData | undefined;
          if (d && typeof d.type === 'string') routeNotification(d);
        };

        if (cancelled) return;
        sub = Notifications.addNotificationResponseReceivedListener(resp => {
          route(resp.notification.request.content.data);
        });

        // Cold start: app was opened by tapping a push.
        const last = await Notifications.getLastNotificationResponseAsync();
        if (!cancelled && last) route(last.notification.request.content.data);
      } catch {
        // expo-notifications unavailable (e.g. Expo Go limitations) — ignore.
      }
    })();

    return () => { cancelled = true; sub?.remove(); };
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  const markOneRead = useCallback(async (id: string) => {
    if (!user) return;
    await markNotificationRead(user.uid, id);
  }, [user]);

  const markAll = useCallback(async () => {
    if (!user) return;
    await markAllNotificationsRead(user.uid);
  }, [user]);

  const clearAll = useCallback(async () => {
    if (!user) return;
    await clearAllNotifications(user.uid);
  }, [user]);

  return (
    <NotificationContext.Provider value={{ notifications, unreadCount, markOneRead, markAll, clearAll }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
