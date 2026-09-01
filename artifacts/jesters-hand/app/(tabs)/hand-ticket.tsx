import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import { getTicket, saveTicket, uploadAdminPhoto, TicketData } from '@/lib/ticketService';
import { useAuth } from '@/contexts/AuthContext';
import { listenOwnStats, listenOwnCompletion, listenPublishedDeals, seatTemperature, DealMemberStats, Deal } from '@/lib/dealService';
import { useLiveDeal } from '@/components/deal/useLiveDeal';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { fieldsForJokerId, SUIT_GLYPHS, SUIT_GENRES } from '@/lib/ticketFields';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW } = appWindow();
const NAV_H    = 52;
const SIDE     = 16;
const GAP      = 12;
const FOLDER_W = SW - SIDE * 2;
const CARD_W   = Math.floor((FOLDER_W - GAP - SIDE * 2) / 2);
const CARD_H   = Math.round(CARD_W * 1.4);
const TAB_W    = 180;
const TAB_H    = 40;
const CREAM    = '#EDE0C4';
const GOLD     = '#D4A853';

function PaperClip() {
  return (
    <View style={pc.wrap}>
      <View style={pc.outer} />
      <View style={pc.inner} />
    </View>
  );
}
const pc = StyleSheet.create({
  wrap:  { width: 18, height: 44, alignItems: 'center' },
  outer: { position: 'absolute', top: 0,  width: 18, height: 38, borderRadius: 9,  borderWidth: 2.5, borderColor: '#A0722A' },
  inner: { position: 'absolute', top: 6,  left: 4,   width: 10, height: 26, borderRadius: 5,  borderWidth: 2.5, borderColor: '#A0722A' },
});

export default function HandTicketScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isAdmin } = useAuth();
  const { uid } = useLocalSearchParams<{ uid: string }>();

  // Auth guard
  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  const [ticket,  setTicket]  = useState<TicketData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);

  const [deals, setDeals] = useState<Deal[]>([]);
  const activeDeal = useLiveDeal(deals);
  const [stats, setStats] = useState<DealMemberStats | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!user || !uid) return;
    if (user.uid !== uid && !isAdmin) return;
    return listenOwnStats(uid, (s) => setStats(s));
  }, [user, uid, isAdmin]);

  useEffect(() => {
    if (!user || !uid) return;
    if (user.uid !== uid && !isAdmin) return;
    return listenPublishedDeals(setDeals);
  }, [user, uid, isAdmin]);

  useEffect(() => {
    if (!activeDeal || !uid || !user) {
      setProgress(0);
      return;
    }
    if (user.uid !== uid && !isAdmin) return;
    return listenOwnCompletion(activeDeal.id, uid, comp => {
      if (comp && activeDeal.tasks.length > 0) {
        setProgress(comp.completedTaskIds.length / activeDeal.tasks.length);
      } else {
        setProgress(0);
      }
    });
  }, [activeDeal, uid, user, isAdmin]);

  const canSeeTemp = !!user && (user.uid === uid || isAdmin);
  const temp = canSeeTemp ? seatTemperature(stats?.lastActivityAt, progress) : null;
  const streak = stats?.currentStreak ?? 0;

  useEffect(() => {
    if (!uid) return;
    setLoading(true);
    getTicket(uid)
      .then(data => {
        // Even if no data exists, show the empty ticket shell
        setTicket(data ?? { jokerId: uid } as TicketData);
        setError(null);
      })
      .catch(e => {
        const msg = e?.code === 'permission-denied'
          ? 'Firestore rules need updating — see admin instructions.'
          : 'Could not load this ticket.';
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [uid]);

  // ── Admin: only the admin portrait is the Jester's to set. The mug photo
  // and all ticket fields belong to the member themselves.
  const [uploading, setUploading] = useState(false);
  const [saveMsg,   setSaveMsg]   = useState<string | null>(null);

  const pickAdminPhoto = useCallback(async () => {
    if (!uid || uploading) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85,
    });
    if (res.canceled || !res.assets[0]) return;
    setUploading(true);
    setSaveMsg(null);
    try {
      const url = await uploadAdminPhoto(uid, res.assets[0].uri);
      await saveTicket(uid, { adminPhotoUrl: url });
      setTicket(t => (t ? { ...t, adminPhotoUrl: url } : t));
    } catch {
      setSaveMsg('Photo upload failed — try again.');
    } finally {
      setUploading(false);
    }
  }, [uid, uploading]);

  // ── Admin: mark the member's suit on their ticket ─────────────────────────
  const [suitBusy, setSuitBusy] = useState(false);
  const markSuit = useCallback(async (v: string) => {
    if (!uid || suitBusy) return;
    setSuitBusy(true);
    setSaveMsg(null);
    try {
      await saveTicket(uid, { suit: v } as any);
      setTicket(t => (t ? { ...t, suit: v } as any : t));
    } catch {
      setSaveMsg('Could not mark the suit — try again.');
    } finally {
      setSuitBusy(false);
    }
  }, [uid, suitBusy]);

  const goWhisper = () => {
    if (!uid) return;
    router.push({ pathname: '/(tabs)/whisper', params: { recipientUid: uid } });
  };

  const goBlackBook = () => {
    if (!uid) return;
    router.push({
      pathname: '/(tabs)/street-art',
      params: { uid, ...(ticket?.jokerId ? { label: ticket.jokerId } : {}) },
    });
  };

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
          <Text style={s.navTitle} numberOfLines={1}>
            {ticket?.jokerId ?? uid ?? 'Intel'}
          </Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Loading / Error ── */}
      {loading ? (
        <View style={[s.center, { top: navBottom }]}>
          <ActivityIndicator size="large" color={GOLD} />
        </View>
      ) : error ? (
        <View style={[s.center, { top: navBottom }]}>
          <Feather name="alert-circle" size={28} color="#FF6B6B" />
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : ticket ? (
        <>
          <ScrollView
            style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 80 }}
            contentContainerStyle={{ padding: SIDE, paddingBottom: 24 }}
            showsVerticalScrollIndicator={false}
          >
            {/* ══ Folder ══ */}
            <View style={s.folderWrap}>

              {/* Tab */}
              <View style={[s.tab, { width: TAB_W, height: TAB_H }]}>
                <Text style={s.tabText} numberOfLines={1}>
                  JOKER ID: {ticket.jokerId ?? uid ?? '——'}
                  {(ticket as any).suit && SUIT_GLYPHS[(ticket as any).suit]
                    ? `   ${SUIT_GLYPHS[(ticket as any).suit]} ${String((ticket as any).suit).toUpperCase()}`
                    : ''}
                </Text>
              </View>

              {/* Folder body */}
              <View style={s.body}>

                {/* Cards row */}
                <View style={s.cardsRow}>
                  <View style={[s.clipPos, { left: SIDE + CARD_W / 2 - 9 }]}>
                    <PaperClip />
                  </View>
                  <View style={[s.clipPos, { left: SIDE + CARD_W + GAP + CARD_W / 2 - 9 }]}>
                    <PaperClip />
                  </View>

                  {/* Mug photo — the member's own; view-only here */}
                  <View style={[s.card, { width: CARD_W, height: CARD_H }]}>
                    {ticket.mugUrl ? (
                      <Image source={{ uri: ticket.mugUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                    ) : (
                      <View style={s.cardEmpty}>
                        <Feather name="user" size={26} color="rgba(237,224,196,0.2)" />
                        <Text style={s.cardLabel}>No Mug</Text>
                      </View>
                    )}
                  </View>

                  {/* Admin photo — the Jester's card to place */}
                  <TouchableOpacity
                    style={[s.card, { width: CARD_W, height: CARD_H }]}
                    disabled={!isAdmin || uploading}
                    onPress={() => void pickAdminPhoto()}
                    activeOpacity={0.8}
                  >
                    {ticket.adminPhotoUrl ? (
                      <Image source={{ uri: ticket.adminPhotoUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                    ) : (
                      <View style={s.cardEmpty}>
                        <Feather name="lock" size={20} color="rgba(237,224,196,0.15)" />
                        <Text style={[s.cardLabel, { opacity: 0.3 }]}>Admin</Text>
                        {isAdmin && <Text style={s.cardHint}>Tap to add</Text>}
                      </View>
                    )}
                    {uploading && (
                      <View style={s.cardBusy}><ActivityIndicator size="small" color={GOLD} /></View>
                    )}
                  </TouchableOpacity>
                </View>

                {canSeeTemp && (
                  <View style={[s.fieldBlock, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', padding: 14, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(237,224,196,0.1)' }]}>
                    <View>
                      <Text style={[s.fieldLabel, { marginBottom: 4 }]}>SEAT TEMPERATURE</Text>
                      <Text style={[s.fieldValue, { color: temp === 'Hot' ? '#FF6B6B' : temp === 'Warm' ? '#FFA06B' : temp === 'Cooling' ? '#6B90FF' : 'rgba(237,224,196,0.5)' }]}>
                        {temp?.toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={[s.fieldLabel, { marginBottom: 4 }]}>STREAK</Text>
                      <Text style={s.fieldValue}>{streak}</Text>
                    </View>
                  </View>
                )}

                {/* Suit — marked by the Hand only */}
                <View style={s.suitBlock}>
                  <Text style={s.fieldLabel}>SUIT — WHAT THEY'RE READING NOW</Text>
                  <View style={s.suitRow}>
                    {(['Spade', 'Diamond', 'Heart', 'Club'] as const).map(v => {
                      const active = (ticket as any).suit === v;
                      return (
                        <TouchableOpacity
                          key={v}
                          style={[s.suitPill, active && s.suitPillActive]}
                          onPress={() => void markSuit(v)}
                          disabled={suitBusy}
                          activeOpacity={0.8}
                        >
                          <Text style={[s.suitPillText, active && s.suitPillTextActive]}>
                            {SUIT_GLYPHS[v]} {SUIT_GENRES[v].toUpperCase()}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
                {saveMsg && <Text style={s.saveMsg}>{saveMsg}</Text>}

                {/* Divider */}
                <View style={s.divider} />

                {/* All 15 fields — always shown, empty or not */}
                {fieldsForJokerId(ticket.jokerId).map(f => {
                  const val = (ticket as any)[f.id];
                  const hasValue = typeof val === 'string' && val.length > 0;
                  return (
                    <View key={f.id} style={s.fieldBlock}>
                      <Text style={s.fieldLabel}>{f.label}</Text>
                      <View style={s.fieldValueBox}>
                        {hasValue ? (
                          <Text style={s.fieldValue}>{val}</Text>
                        ) : (
                          <Text style={s.fieldEmpty}>Not filled in yet</Text>
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          </ScrollView>

          {/* ── Action buttons — fixed at bottom ── */}
          <View style={[s.whisperBar, { bottom: insets.bottom + 12 }]}>
            <TouchableOpacity style={s.whisperBtn} onPress={goWhisper} activeOpacity={0.85}>
              <Feather name="message-circle" size={22} color={GOLD} />
              <Text style={s.whisperText}>Table Talk</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.whisperBtn} onPress={goBlackBook} activeOpacity={0.85}>
              <Feather name="book" size={22} color={GOLD} />
              <Text style={s.whisperText}>Black Book</Text>
            </TouchableOpacity>
          </View>
        </>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  center:    { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 12 },
  errorText: { ...MARBLE_TEXT_SHADOW, color: '#FF6B6B', fontFamily: 'Cinzel_400Regular', fontSize: 12, textAlign: 'center', paddingHorizontal: 32 },

  // Folder
  folderWrap: { width: FOLDER_W },
  tab: {
    backgroundColor: '#0D0D0D',
    borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.35)',
    justifyContent: 'center', paddingHorizontal: 14,
  },
  tabText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.5 },
  body: {
    backgroundColor: '#0A0A0A',
    borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    paddingHorizontal: SIDE, paddingBottom: SIDE, paddingTop: SIDE + 8,
  },

  // Cards
  cardsRow: { flexDirection: 'row', gap: GAP, marginBottom: SIDE },
  clipPos:  { position: 'absolute', top: -14, zIndex: 5 },
  card: {
    borderRadius: 8, backgroundColor: '#111',
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.22)', overflow: 'hidden',
  },
  cardEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  cardLabel: { color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },

  divider: { height: 1, backgroundColor: 'rgba(200,165,60,0.15)', marginBottom: SIDE + 4 },

  cardHint: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1, opacity: 0.7 },
  cardBusy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  saveMsg: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, textAlign: 'center', marginBottom: SIDE },
  suitBlock: { paddingHorizontal: SIDE, marginBottom: SIDE },
  suitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suitPill: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  suitPillActive: { backgroundColor: GOLD, borderColor: GOLD },
  suitPillText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1 },
  suitPillTextActive: { color: '#0A0A0A' },

  // Fields — always rendered
  fieldBlock:    { marginBottom: 18 },
  fieldLabel:    { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 7, opacity: 0.7 },
  fieldValueBox: {
    width: '100%', minHeight: 44, backgroundColor: 'rgba(0,0,0,0.35)', borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.1)', paddingHorizontal: 14, paddingVertical: 11,
  },
  fieldValue: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13, lineHeight: 20 },
  fieldEmpty: { color: 'rgba(237,224,196,0.22)', fontFamily: 'Cinzel_400Regular', fontSize: 12, fontStyle: 'italic' },

  // Whisper bar
  whisperBar: {
    position: 'absolute', left: SIDE, right: SIDE,
    flexDirection: 'row', justifyContent: 'center', gap: 10,
  },
  whisperBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(5,3,0,0.92)',
    borderRadius: 28, borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    paddingHorizontal: 22, paddingVertical: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.5, shadowRadius: 12, elevation: 8,
  },
  whisperText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 3 },
});
