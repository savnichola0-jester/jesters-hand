/**
 * BellNavIcon — notification bell with red badge + animated slide-down panel.
 *
 * Reads from NotificationContext (Firestore-backed).
 * Notification types:
 *   message      → navigates to chat
 *   filed_ticket → navigates to The Hand
 *   announcement → closes panel
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View, Image, TouchableOpacity, StyleSheet, Text,
  Modal, FlatList, TouchableWithoutFeedback, Platform,
  Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useNotifications } from '@/contexts/NotificationContext';
import { useAuth } from '@/contexts/AuthContext';
import { AppNotification, formatNotifTimestamp } from '@/lib/notificationService';
import { routeNotification } from '@/lib/notificationRouting';
import { notificationText, notificationTitle } from '@/lib/notificationCatalog';
import { db } from '@/lib/firebase';
import { doc, getDoc } from 'firebase/firestore';

const NAV_BELL = require('../assets/images/nav_bell.png');

interface Props { size?: number }

export default function BellNavIcon({ size = 38 }: Props) {
  const { notifications, unreadCount, markOneRead, clearAll } = useNotifications();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();

  const [open,        setOpen]        = useState(false);
  const [memberCache, setMemberCache] = useState<Record<string, string>>({});
  const slideAnim = useRef(new Animated.Value(0)).current;

  // Resolve UIDs → Joker IDs when notifications arrive
  useEffect(() => {
    const uids = new Set<string>();
    notifications.forEach(n => { if (n.fromUid) uids.add(n.fromUid); });
    const missing = Array.from(uids).filter(u => !memberCache[u]);
    if (!missing.length) return;

    Promise.allSettled(
      missing.map(uid =>
        getDoc(doc(db, 'users', uid)).then(snap => ({
          uid,
          label: snap.exists()
            ? (snap.data().jokerId ?? uid.slice(0, 6))
            : uid.slice(0, 6),
        }))
      )
    ).then(results => {
      const updates: Record<string, string> = {};
      results.forEach(r => { if (r.status === 'fulfilled') updates[r.value.uid] = r.value.label; });
      setMemberCache(prev => ({ ...prev, ...updates }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifications]);

  // Animate panel in/out
  const openPanel = () => {
    setOpen(true);
    Animated.timing(slideAnim, {
      toValue: 1,
      duration: 200,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  };

  const closePanel = () => {
    Animated.timing(slideAnim, {
      toValue: 0,
      duration: 150,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => setOpen(false));
  };

  const handleClearAll = async () => {
    await clearAll();
    closePanel();
  };

  const handleTap = useCallback(async (item: AppNotification) => {
    await markOneRead(item.id);
    closePanel();
    routeNotification(item); // announcements: just close
  }, [markOneRead]);

  const badge = unreadCount > 99 ? '99+' : unreadCount > 0 ? String(unreadCount) : null;
  const navTop = (Platform.OS === 'web' ? 50 : insets.top) + 52 + 6;

  const translateY = slideAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [-24, 0],
  });
  const opacity = slideAnim.interpolate({ inputRange: [0, 1], outputRange: [0, 1] });

  const renderRow = useCallback(({ item }: { item: AppNotification }) => {
    const label = item.fromUid ? (memberCache[item.fromUid] ?? '——') : null;
    const ts    = formatNotifTimestamp(item.createdAt);
    const title = item.title ?? notificationTitle(item.type);
    const detail = notificationText(item.type, item.text);

    let icon: React.ReactNode;
    if (item.type === 'message') {
      icon = <Feather name="message-circle" size={16} color={GOLD} />;
    } else if (item.type === 'group_add') {
      icon = <Feather name="user-plus" size={16} color={GOLD} />;
    } else if (item.type === 'filed_ticket') {
      icon = <Feather name="file-text" size={16} color={GOLD} />;
    } else if (item.type === 'filed_report') {
      icon = <Feather name="alert-circle" size={16} color={GOLD} />;
    } else if (item.type === 'ante_comment' || item.type === 'target_comment') {
      icon = <Feather name="message-square" size={16} color={GOLD} />;
    } else if (item.type === 'ante_reaction' || item.type === 'target_reaction') {
      icon = <Feather name="smile" size={16} color={GOLD} />;
    } else if (item.type === 'royals_honor') {
      icon = <Feather name="award" size={16} color={GOLD} />;
    } else if (item.type === 'contract_update') {
      icon = <Feather name="edit-3" size={16} color={GOLD} />;
    } else {
      icon = <Feather name="bell" size={16} color={GOLD} />;
    }

    return (
      <TouchableOpacity
        style={[styles.row, !item.read && styles.rowUnread]}
        activeOpacity={0.8}
        onPress={() => handleTap(item)}
      >
        <View style={styles.rowIcon}>{icon}</View>
        <View style={styles.rowBody}>
          <Text style={styles.rowTitle} numberOfLines={1}>{title}</Text>
          <Text style={styles.rowText} numberOfLines={2}>
            {label ? <Text style={styles.rowSender}>{label} </Text> : null}
            {detail}
          </Text>
          <Text style={styles.rowTs}>{ts}</Text>
        </View>
        {!item.read && <View style={styles.dot} />}
      </TouchableOpacity>
    );
  }, [memberCache, handleTap]);

  return (
    <>
      {/* Bell button */}
      <TouchableOpacity onPress={openPanel} activeOpacity={0.75}>
        <View>
          <Image source={NAV_BELL} style={{ width: size, height: size }} resizeMode="contain" />
          {badge !== null && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          )}
        </View>
      </TouchableOpacity>

      {/* Dropdown modal */}
      <Modal
        visible={open}
        transparent
        animationType="none"
        onRequestClose={closePanel}
        statusBarTranslucent
      >
        <TouchableWithoutFeedback onPress={closePanel}>
          <View style={styles.overlay} />
        </TouchableWithoutFeedback>

        <Animated.View
          style={[
            styles.panel,
            { top: navTop },
            { transform: [{ translateY }], opacity },
          ]}
        >
          {/* Header */}
          <View style={styles.panelHeader}>
            <Text style={styles.panelTitle}>DISPATCHES</Text>
            {notifications.length > 0 && (
              <TouchableOpacity onPress={handleClearAll} style={styles.clearBtn} activeOpacity={0.75}>
                <Feather name="trash-2" size={12} color={GOLD} />
                <Text style={styles.clearText}>Clear all</Text>
              </TouchableOpacity>
            )}
          </View>

          {/* Body */}
          {notifications.length === 0 ? (
            <View style={styles.allClear}>
              <Feather name="bell-off" size={28} color="rgba(212,168,83,0.25)" />
              <Text style={styles.allClearTitle}>All Clear</Text>
              <Text style={styles.allClearSub}>No dispatches yet</Text>
            </View>
          ) : (
            <FlatList
              data={notifications}
              keyExtractor={item => item.id}
              renderItem={renderRow}
              style={{ maxHeight: 360 }}
              showsVerticalScrollIndicator={false}
            />
          )}
        </Animated.View>
      </Modal>
    </>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const GOLD  = '#D4A853';
const CREAM = '#EDE0C4';
const DARK  = '#1A1510';
const RED   = '#E53E3E';

const styles = StyleSheet.create({
  badge: {
    position: 'absolute', top: -4, right: -4,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: RED,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },

  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },

  panel: {
    position: 'absolute', right: 10, width: 300,
    backgroundColor: DARK,
    borderRadius: 10, borderWidth: 1, borderColor: GOLD,
    overflow: 'hidden',
  },

  panelHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 14, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.3)',
  },
  panelTitle: {
    color: GOLD, fontSize: 11,
    fontFamily: 'Cinzel_700Bold', letterSpacing: 2,
  },
  clearBtn: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  clearText: { color: GOLD, fontSize: 10 },

  allClear: { alignItems: 'center', paddingVertical: 32, gap: 8 },
  allClearTitle: { color: CREAM, fontSize: 14, fontFamily: 'Cinzel_700Bold' },
  allClearSub: { color: '#666', fontSize: 11 },

  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(212,168,83,0.15)',
    gap: 10,
  },
  rowUnread: { backgroundColor: 'rgba(212,168,83,0.06)' },
  rowIcon: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(212,168,83,0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  rowBody: { flex: 1 },
  rowTitle: {
    color: GOLD,
    fontFamily: 'Cinzel_700Bold',
    fontSize: 10,
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  rowText: { color: CREAM, fontSize: 12, lineHeight: 17 },
  rowSender: { color: GOLD, fontWeight: '700' },
  rowTs: { color: '#666', fontSize: 10, marginTop: 3 },
  dot: {
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: RED, alignSelf: 'center',
  },
});
