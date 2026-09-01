// SCREEN 1 — Target Ticket home: the black tabbed case file becomes a
// scrolling feed of every Joker's filed theory tickets.
import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions, Platform,
  Image, FlatList, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  TargetTicket, Suit, listenTargetTickets, formatTicketTimestamp, SUIT_LABELS,
} from '@/lib/targetTicketService';
import { getAllMembers } from '@/lib/ticketService';
import { SuitIcon } from '@/components/target/SuitIcon';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW } = appWindow();
const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 40;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

export default function TargetTicketScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user } = useAuth();
  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  const [tickets, setTickets] = useState<TargetTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [names, setNames] = useState<Record<string, string>>({});
  const [mugs, setMugs] = useState<Record<string, string>>({});
  const [suitFilter, setSuitFilter] = useState<Suit | 'all'>('all');

  useEffect(() => {
    const unsub = listenTargetTickets(t => { setTickets(t); setLoading(false); });
    return unsub;
  }, []);

  useEffect(() => {
    getAllMembers().then(members => {
      const map: Record<string, string> = {};
      const mugMap: Record<string, string> = {};
      members.forEach((m: any) => {
        map[m.uid] = m.jokerId ?? '——';
        if (m.mugUrl) mugMap[m.uid] = m.mugUrl;
      });
      setNames(map);
      setMugs(mugMap);
    }).catch(() => {});
  }, []);

  const SUIT_CHIPS: Array<Suit | 'all'> = ['all', 'spade', 'diamond', 'heart', 'club'];
  const filtered = suitFilter === 'all' ? tickets : tickets.filter(t => t.suit === suitFilter);

  const renderRow = ({ item }: { item: TargetTicket }) => (
    <TouchableOpacity
      style={s.row}
      activeOpacity={0.8}
      onPress={() => router.push({ pathname: '/(tabs)/target-ticket-view', params: { id: item.id } })}
    >
      {mugs[item.senderUid] ? (
        <Image source={{ uri: mugs[item.senderUid] }} style={s.mug} />
      ) : (
        <View style={[s.mug, s.mugFallback]}>
          <Feather name="user" size={14} color="rgba(212,168,83,0.6)" />
        </View>
      )}
      <SuitIcon suit={item.suit} size={22} color={GOLD} />
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{item.title || 'Untitled Theory'}</Text>
        <Text style={s.rowMeta} numberOfLines={1}>
          {SUIT_LABELS[item.suit]}
          {names[item.senderUid] ? `  ·  ${names[item.senderUid]}` : ''}
          {item.createdAt ? `  ·  ${formatTicketTimestamp(item.createdAt)}` : ''}
        </Text>
      </View>
      <View style={s.commentPill}>
        <Feather name="message-square" size={12} color={GOLD} />
        <Text style={s.commentCount}>{item.commentCount}</Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Nav */}
      <View style={[s.nav, { height: navBottom }]}>
        <View style={s.navRow}>
          <View style={s.navLeft}>
            <TouchableOpacity
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)/home'))}
              activeOpacity={0.75}
            >
              <Image source={NAV_DAGGER} style={s.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={s.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          {/* pointerEvents=none: the absolute title spans the bar and must not
              swallow taps meant for the dagger/cards buttons underneath */}
          <Text style={s.navTitle} numberOfLines={1} pointerEvents="none">Target Ticket</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* The tabbed case file — its body is the scrolling feed frame */}
      <View style={[s.folderWrap, { top: navBottom + 12 }]}>
        <View style={[s.tab, { width: Math.min(SW * 0.55, 230), height: TAB_H }]}>
          <Text style={s.tabText} numberOfLines={1}>TARGET TICKETS</Text>
        </View>
        <View style={s.body}>
          {/* Suit filter chips */}
          <View style={s.chipsRow}>
            {SUIT_CHIPS.map(c => {
              const active = suitFilter === c;
              return (
                <TouchableOpacity
                  key={c}
                  style={[s.chip, active && s.chipActive]}
                  activeOpacity={0.75}
                  onPress={() => setSuitFilter(c)}
                >
                  {c === 'all' ? (
                    <Text style={[s.chipText, active && s.chipTextActive]}>ALL</Text>
                  ) : (
                    <SuitIcon suit={c} size={16} color={active ? '#0A0A0A' : GOLD} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          {loading ? (
            <ActivityIndicator color={GOLD} style={{ marginTop: 40 }} />
          ) : filtered.length === 0 ? (
            <View style={s.empty}>
              <Text style={s.emptyTitle}>No Intel Filed</Text>
              <Text style={s.emptyText}>
                {suitFilter === 'all'
                  ? 'Gather intel and file the first theory.'
                  : `No ${SUIT_LABELS[suitFilter]} theories yet.`}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={t => t.id}
              renderItem={renderRow}
              contentContainerStyle={{ paddingVertical: 6 }}
              showsVerticalScrollIndicator={false}
              ItemSeparatorComponent={() => <View style={s.sep} />}
            />
          )}
        </View>
      </View>

      {/* Gather Intel */}
      <TouchableOpacity
        style={[s.gatherBtn, { bottom: Math.max(insets.bottom, 14) + 6 }]}
        activeOpacity={0.85}
        onPress={() => router.push('/(tabs)/target-ticket-new')}
      >
        <Text style={s.gatherText}>Gather Intel</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  nav:  { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10 },
  navRow: { position: 'absolute', bottom: 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center' },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 2, marginLeft: 'auto' },
  navTitle: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: CREAM, fontSize: 16, fontFamily: 'Cinzel_700Bold', letterSpacing: 1,
  },
  dagIcon: { width: 34, height: 34 },
  sqIcon:  { width: 34, height: 34 },

  folderWrap: { position: 'absolute', left: SIDE, right: SIDE, bottom: 86 },
  tab: {
    backgroundColor: '#0D0D0D', borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(212,168,83,0.5)',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12,
  },
  tabText: { color: GOLD, fontSize: 12, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
  body: {
    flex: 1, backgroundColor: '#0A0A0A',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    paddingHorizontal: 10,
  },

  chipsRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingTop: 12, paddingBottom: 8, paddingHorizontal: 6,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.14)',
  },
  chip: {
    minWidth: 42, height: 30, borderRadius: 15,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10,
  },
  chipActive: { backgroundColor: GOLD, borderColor: GOLD },
  chipText: { color: GOLD, fontSize: 10, fontFamily: 'Cinzel_700Bold', letterSpacing: 1.5 },
  chipTextActive: { color: '#0A0A0A' },
  mug: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(212,168,83,0.12)' },
  mugFallback: {
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)',
  },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 6 },
  rowTitle: { color: CREAM, fontSize: 14.5, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 0.5 },
  rowMeta: { color: 'rgba(237,224,196,0.5)', fontSize: 10.5, fontFamily: 'Inter_400Regular', marginTop: 3 },
  commentPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 11,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  commentCount: { color: GOLD, fontSize: 11, fontFamily: 'Inter_500Medium' },
  sep: { height: 1, backgroundColor: 'rgba(212,168,83,0.14)' },

  empty: { alignItems: 'center', marginTop: 48, gap: 6 },
  emptyTitle: { color: GOLD, fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 2 },
  emptyText: { color: 'rgba(237,224,196,0.5)', fontSize: 12, fontFamily: 'Inter_400Regular' },

  gatherBtn: {
    position: 'absolute', left: SIDE, right: SIDE, height: 52,
    backgroundColor: '#0D0D0D', borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(255,215,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  gatherText: { color: '#FFD700', fontSize: 15, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
});
