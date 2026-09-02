import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { getAllMembers, TicketData } from '@/lib/ticketService';
import { getRoyalsCounts } from '@/lib/blackBookService';
import {
  Deal, DealCompletion, DealMemberStats, listenAllDealCompletions,
  listenAllDealStats, listenPublishedDeals, seatTemperature,
} from '@/lib/dealService';
import { useLiveDeal } from '@/components/deal/useLiveDeal';
import { useAuth } from '@/contexts/AuthContext';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';
import { fetchSeatActivitySummary, SeatActivitySummary, SeatTemperature } from '@/lib/activityService';
import { SeatThermometer } from '@/components/SeatThermometer';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW } = appWindow();
const NAV_H  = 52;
const SIDE   = 16;
const GAP    = 12;
const CREAM  = '#EDE0C4';
const GOLD   = '#D4A853';

type Member = TicketData & { uid: string };

export default function HandScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isHandAdmin } = useAuth();
  const canSeeAllSeats = isHandAdmin;

  // Auth guard
  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  const [members,  setMembers]  = useState<Member[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);
  const [royals,   setRoyals]   = useState<Record<string, number>>({});
  const [deals, setDeals] = useState<Deal[]>([]);
  const [stats, setStats] = useState<DealMemberStats[]>([]);
  const [completions, setCompletions] = useState<Array<DealCompletion & { dealId: string }>>([]);
  const activeDeal = useLiveDeal(deals);
  const [seatSummaries, setSeatSummaries] = useState<Record<string, SeatActivitySummary>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getAllMembers();
      setMembers(data);
       if (canSeeAllSeats) {
         const entries = await Promise.all(data.map(async member => {
           const summary = await fetchSeatActivitySummary(member.uid);
           return summary ? [member.uid, summary] as const : null;
         }));
         setSeatSummaries(Object.fromEntries(entries.filter((entry): entry is readonly [string, SeatActivitySummary] => !!entry)));
       } else {
         setSeatSummaries({});
       }
      // Honor counts arrive separately — the list renders without waiting.
      getRoyalsCounts(data.map(m => m.uid)).then(setRoyals).catch(() => {});
    } catch (e: any) {
      const msg = e?.code === 'permission-denied'
        ? 'Firestore rules need updating — see admin instructions.'
        : 'Could not load members. Check your connection.';
      setError(msg);
      console.error('[Hand] load error:', e);
    } finally {
      setLoading(false);
    }
  }, [canSeeAllSeats, user?.uid]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!canSeeAllSeats) {
      setDeals([]);
      setStats([]);
      setCompletions([]);
      return;
    }
    const offDeals = listenPublishedDeals(setDeals);
    const offStats = listenAllDealStats(setStats);
    const offCompletions = listenAllDealCompletions(setCompletions);
    return () => {
      offDeals();
      offStats();
      offCompletions();
    };
  }, [canSeeAllSeats]);

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
      <View style={[s.nav, { height: navBottom }]}>
        <View style={s.navRow}>
          <View style={s.navLeft}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.75}>
              <Image source={NAV_DAGGER} style={s.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={s.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          <Text style={s.navTitle} numberOfLines={1}>The Hand</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
            <TouchableOpacity onPress={load} activeOpacity={0.75} style={s.refreshBtn}>
              <Feather name="refresh-cw" size={15} color={GOLD} />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* ── Content ── */}
      {loading ? (
        <View style={[s.center, { top: navBottom }]}>
          <ActivityIndicator size="large" color={GOLD} />
          <Text style={s.loadingText}>Dealing the hand…</Text>
        </View>
      ) : error ? (
        <View style={[s.center, { top: navBottom }]}>
          <Feather name="alert-circle" size={28} color="#FF6B6B" />
          <Text style={s.errorText}>{error}</Text>
          <TouchableOpacity style={s.retryBtn} onPress={load}>
            <Text style={s.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
          contentContainerStyle={{ padding: SIDE, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Header count */}
          <View style={s.headerRow}>
            <Text style={s.headerText}>
              {members.length} {members.length === 1 ? 'Joker' : 'Jokers'}
            </Text>
            <View style={s.headerLine} />
          </View>

          {/* Member cards */}
          {members.map(m => (
            <MemberCard
              key={m.uid}
              member={m}
              royalsCount={royals[m.uid] ?? 0}
               temperature={canSeeAllSeats ? (seatSummaries[m.uid]?.temperature ?? null) : null}
              onPress={() =>
                router.push({ pathname: '/(tabs)/hand-ticket', params: { uid: m.uid } })
              }
            />
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ── Member card ───────────────────────────────────────────────────────────────
function MemberCard({ member, royalsCount, temperature, onPress }: {
  member: Member;
  royalsCount: number;
  temperature: SeatTemperature | null;
  onPress: () => void;
}) {
  const hasMug   = !!member.mugUrl;
  const hasName  = !!member.name;
  const filed    = !!(member as any).filed;

  const initials = (member.name ?? member.jokerId ?? '?').slice(0, 2).toUpperCase();

  return (
    <TouchableOpacity style={s.card} onPress={onPress} activeOpacity={0.82}>
      {/* Circular mug photo or initials fallback */}
      <View style={s.mugWrap}>
        {hasMug ? (
          <Image source={{ uri: member.mugUrl }} style={s.mug} resizeMode="cover" />
        ) : (
          <View style={s.mugEmpty}>
            <Text style={s.mugInitials}>{initials}</Text>
          </View>
        )}
      </View>

      {/* Info */}
      <View style={s.cardInfo}>
        <Text style={s.cardJokerId} numberOfLines={1}>
          {member.jokerId ?? '——'}
        </Text>
        {hasName
          ? <Text style={s.cardName} numberOfLines={1}>{member.name}</Text>
          : <Text style={s.cardNameEmpty}>No name on file</Text>
        }
        {member.street
          ? <Text style={s.cardStreet} numberOfLines={1}>{member.street}</Text>
          : null
        }
        {member.role
          ? <Text style={s.cardRole} numberOfLines={1}>{member.role}</Text>
          : null
        }
        {/* Badges */}
        <View style={s.badgeRow}>
          <View style={[s.filedBadge, filed && s.filedBadgeActive]}>
            <Text style={[s.filedText, filed && s.filedTextActive]}>
              {filed ? 'Filed' : 'Incomplete'}
            </Text>
          </View>
          {royalsCount > 0 ? (
            <View style={s.royalsBadge}>
              <Feather name="award" size={10} color={GOLD} />
              <Text style={s.royalsText}>{royalsCount}</Text>
            </View>
          ) : null}
          {temperature ? (
            <View style={s.seatBadge}>
              <Text style={[
                s.seatText,
                temperature === 'Hot' && { color: '#FF6B6B' },
                temperature === 'Warm' && { color: '#FFA06B' },
              ]}>
                {temperature}
              </Text>
              <SeatThermometer compact temperature={temperature} />
            </View>
          ) : null}
        </View>
      </View>

      <Feather name="chevron-right" size={18} color="rgba(212,168,83,0.45)" />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:     { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle:{ flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight:{ flexDirection: 'row', alignItems: 'center', gap: 8 },
  dagIcon: { width: 48, height: 26 },
  sqIcon:  { width: 34, height: 34 },
  refreshBtn: {
    width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
    borderRadius: 17, borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },

  center:      { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loadingText: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_400Regular', fontSize: 13, letterSpacing: 1 },
  errorText:   { ...MARBLE_TEXT_SHADOW, color: '#FF6B6B', fontFamily: 'Cinzel_400Regular', fontSize: 12, textAlign: 'center', paddingHorizontal: 32 },
  retryBtn:    {
    ...MARBLE_BTN_BACKING,
    marginTop: 4, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.4)', backgroundColor: 'rgba(200,165,60,0.08)',
  },
  retryText: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1.5 },

  headerRow:  { flexDirection: 'row', alignItems: 'center', marginBottom: 18, gap: 12 },
  headerText: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase' },
  headerLine: { flex: 1, height: 1, backgroundColor: 'rgba(212,168,83,0.18)' },

  card: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    padding: 12, marginBottom: GAP,
  },
  mugWrap: {
    width: 46, height: 46, borderRadius: 23, overflow: 'hidden', flexShrink: 0,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
  },
  mug: { width: '100%', height: '100%' },
  mugEmpty: {
    width: '100%', height: '100%',
    backgroundColor: 'rgba(200,165,60,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  mugInitials: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13 },
  cardInfo:      { flex: 1, gap: 2 },
  cardJokerId:   { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
  cardName:      { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 13 },
  cardNameEmpty: { color: 'rgba(237,224,196,0.3)', fontFamily: 'Cinzel_400Regular', fontSize: 11, fontStyle: 'italic' },
  cardStreet:    { color: 'rgba(212,168,83,0.75)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, fontStyle: 'italic' },
  cardRole:      { color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_400Regular', fontSize: 11 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  royalsBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
    backgroundColor: 'rgba(212,168,83,0.1)',
  },
  royalsText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 1 },
  seatBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  seatText: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 1 },
  filedBadge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.12)',
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  filedBadgeActive: { borderColor: 'rgba(212,168,83,0.35)', backgroundColor: 'rgba(212,168,83,0.08)' },
  filedText:       { color: 'rgba(237,224,196,0.3)', fontFamily: 'Cinzel_400Regular', fontSize: 9, letterSpacing: 1 },
  filedTextActive: { color: GOLD },
});
