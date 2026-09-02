import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView,
  StyleSheet, Dimensions, Platform, Image, Alert, ActivityIndicator,
  KeyboardAvoidingView,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import { getTicket, saveTicket, uploadMug, uploadAdminPhoto, deleteMug } from '@/lib/ticketService';
import { listenOwnStats, listenOwnCompletion, listenPublishedDeals, seatTemperature, DealMemberStats, Deal } from '@/lib/dealService';
import { useLiveDeal } from '@/components/deal/useLiveDeal';
import { broadcastToActiveMembers } from '@/lib/notificationService';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { fieldsForJokerId, SUIT_GLYPHS, SUIT_GENRES } from '@/lib/ticketFields';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');

const { width: SW } = appWindow();
const NAV_H  = 52;
const SIDE   = 16;
const GAP    = 12;
const FOLDER_W = SW - SIDE * 2;
const CARD_W   = Math.floor((FOLDER_W - GAP - SIDE * 2) / 2);
const CARD_H   = Math.round(CARD_W * 1.4);
const TAB_W    = 170;
const TAB_H    = 40;

const MARBLE = require('../../assets/images/wood_bg.png');

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

export default function TicketScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, jokerId } = useAuth();

  const [values,      setValues]      = useState<Record<string, string>>({});
  const [userPhoto,   setUserPhoto]   = useState<string | null>(null);
  const [adminPhoto,  setAdminPhoto]  = useState<string | null>(null);
  const [editMode,    setEditMode]    = useState(false);
  const [savedFlash,  setSavedFlash]  = useState(false);
  const [uploading,   setUploading]   = useState(false);
  const [uploadPct,   setUploadPct]   = useState(0);
  const [filing,      setFiling]      = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [deals, setDeals] = useState<Deal[]>([]);
  const activeDeal = useLiveDeal(deals);
  const [stats, setStats] = useState<DealMemberStats | null>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!user) return;
    return listenOwnStats(user.uid, (s) => setStats(s));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    return listenPublishedDeals(setDeals);
  }, [user]);

  useEffect(() => {
    if (!activeDeal || !user) {
      setProgress(0);
      return;
    }
    return listenOwnCompletion(activeDeal.id, user.uid, comp => {
      if (comp && activeDeal.tasks.length > 0) {
        setProgress(comp.completedTaskIds.length / activeDeal.tasks.length);
      } else {
        setProgress(0);
      }
    });
  }, [activeDeal, user]);

  const temp = seatTemperature(stats?.lastActivityAt, progress);
  const streak = stats?.currentStreak ?? 0;

  // ── Load from Firestore on mount ─────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    getTicket(user.uid).then(data => {
      if (!data) return;
      const { mugUrl, adminPhotoUrl, ...rest } = data;
      const strFields: Record<string, string> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (typeof v === 'string') strFields[k] = v;
      }
      setValues(strFields);
      if (mugUrl)        setUserPhoto(mugUrl);
      if (adminPhotoUrl) setAdminPhoto(adminPhotoUrl);
    }).catch(() => {});
  }, [user]);

  // ── Auto-save text fields to Firestore ───────────────────────────────────
  const save = useCallback(async () => {
    if (!user) return;
    try {
      await saveTicket(user.uid, values);
      if (jokerId === '00-00') {
        void broadcastToActiveMembers(user.uid, {
          type: 'announcement',
          title: 'The Jester whispered.',
          fromUid: user.uid,
          text: 'updated the Jester Ticket.',
        }).catch(() => {});
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSavedFlash(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    } catch {
      Alert.alert('Save failed', 'Could not save to server. Try again.');
    }
  }, [jokerId, user, values]);

  // Suit = what the member is reading right now; saves immediately.
  const pickSuit = useCallback(async (v: string) => {
    if (!user) return;
    setValues(prev => ({ ...prev, suit: v })); // optimistic
    try {
      await saveTicket(user.uid, { suit: v } as any);
      if (jokerId === '00-00') {
        void broadcastToActiveMembers(user.uid, {
          type: 'announcement',
          title: 'The Jester whispered.',
          fromUid: user.uid,
          text: 'updated the Jester Ticket.',
        }).catch(() => {});
      }
    } catch {
      Alert.alert('Save failed', 'Could not save your suit. Try again.');
    }
  }, [jokerId, user]);

  const toggleEdit = useCallback(() => {
    setEditMode(prev => {
      if (prev) save();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return !prev;
    });
  }, [save]);

  // ── Pick + upload a card photo ───────────────────────────────────────────
  const pickPhoto = useCallback(async (target: 'user' | 'admin') => {
    if (!user || uploading) return;
    if (target === 'admin' && jokerId !== '00-00') {
      Alert.alert('Admin card locked', 'Only the 00-00 login can change this card.');
      return;
    }

    try {
      let permission = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      }
      if (!permission.granted) {
        Alert.alert(
          'Photo access needed',
          'Allow Jester’s Hand to access photos in your device settings, then tap the card again.',
        );
        return;
      }

      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
      });
      if (res.canceled || !res.assets[0]) return;
      if ((res.assets[0].fileSize ?? 0) > 10 * 1024 * 1024) {
        Alert.alert('Image too large', 'Choose an image smaller than 10 MB.');
        return;
      }

      setUploading(true);
      setUploadPct(0);
      const progress = (p: number) => setUploadPct(Math.round(p * 100));
      if (target === 'admin') {
        const url = await uploadAdminPhoto(user.uid, res.assets[0].uri, progress);
        await saveTicket(user.uid, { adminPhotoUrl: url });
        setAdminPhoto(url);
      } else {
        const url = await uploadMug(user.uid, res.assets[0].uri, progress);
        await saveTicket(user.uid, { mugUrl: url });
        setUserPhoto(url);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error: any) {
      const code = String(error?.code ?? '');
      Alert.alert(
        'Upload failed',
        code.includes('unauthorized') || code.includes('permission-denied')
          ? `The server rejected this upload${code ? ` (${code})` : ''}.`
          : `Photo could not be saved${code ? ` (${code})` : ''}. Check your connection and try again.`,
      );
    } finally {
      setUploading(false);
    }
  }, [jokerId, uploading, user]);

  // ── Go Dark ──────────────────────────────────────────────────────────────
  const goDark = useCallback(async () => {
    setUserPhoto(null);
    if (user) {
      await deleteMug(user.uid).catch(() => {});
      await saveTicket(user.uid, { mugUrl: '' }).catch(() => {});
    }
  }, [user]);

  // ── Locked until "Review Intel" is pressed ────────────────────────────────
  const [unlocked, setUnlocked] = useState(false);

  // ── File Intel ───────────────────────────────────────────────────────────
  const fileIntel = useCallback(async () => {
    if (!user) return;
    setFiling(true);
    try {
      await saveTicket(user.uid, { ...values, filed: true, filedAt: Date.now() });
      setUnlocked(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Filed!', 'Your Intel has been filed. An admin will review it.');

      // Broadcast the canonical Hand event to all other members (best-effort).
      void broadcastToActiveMembers(user.uid, {
        type:    jokerId === '00-00' ? 'announcement' : 'filed_ticket',
        title:   jokerId === '00-00' ? 'The Jester whispered.' : 'Recruit filed.',
        fromUid: user.uid,
        text:    jokerId === '00-00' ? 'updated the Jester Ticket.' : 'filed their ticket.',
      }).catch(() => {});
    } catch {
      Alert.alert('Error', 'Could not file Intel. Try again.');
    } finally {
      setFiling(false);
    }
  }, [jokerId, user, values]);

  // ── Review Intel ─────────────────────────────────────────────────────────
  const reviewIntel = useCallback(async () => {
    if (!user) return;
    try {
      const data = await getTicket(user.uid);
      if (data) {
        const { mugUrl, adminPhotoUrl, ...rest } = data;
        const strFields: Record<string, string> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (typeof v === 'string') strFields[k] = v;
        }
        setValues(strFields);
        if (mugUrl)        setUserPhoto(mugUrl);
        if (adminPhotoUrl) setAdminPhoto(adminPhotoUrl);
      }
      setUnlocked(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    } catch {
      Alert.alert('Error', 'Could not load Intel.');
    }
  }, [user]);

  return (
    <View style={s.root}>
      {/* ── Marble BG ── */}
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
      <View style={[s.nav, { height: navBottom }]}>
        <View style={s.navRow}>
          {/* Left: dagger (back) + cards (home) */}
          <View style={s.navLeft}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.75}>
              <Image source={NAV_DAGGER} style={s.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={s.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>

          {/* Center title */}
          <Text style={s.navTitle} numberOfLines={1}>Ticket</Text>

          {/* Right: whisper + bell + edit */}
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
            <TouchableOpacity onPress={toggleEdit} activeOpacity={0.75} style={s.editBtn}>
              <Feather name={editMode ? 'check' : 'edit-2'} size={16} color="#D4A853" />
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* ── Scrollable content — keyboard-aware so focused inputs stay visible ── */}
      <KeyboardAvoidingView
        style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: SIDE, paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
      >
        {/* ══ The whole folder ══ */}
        <View style={s.folderWrap}>

          {/* Tab */}
          <View style={[s.tab, { width: TAB_W, height: TAB_H }]}>
            <Text style={s.tabText} numberOfLines={1}>
              JOKER ID: {jokerId ?? '######'}
              {values.suit && SUIT_GLYPHS[values.suit]
                ? `   ${SUIT_GLYPHS[values.suit]} ${values.suit.toUpperCase()}`
                : ''}
            </Text>
          </View>

          {/* Folder body — contains everything */}
          <View style={s.body}>

            {/* ── Cards row ── */}
            <View style={s.cardsRow}>
              {/* Paper clips */}
              <View style={[s.clipPos, { left: SIDE + CARD_W / 2 - 9 }]}>
                <PaperClip />
              </View>
              <View style={[s.clipPos, { left: SIDE + CARD_W + GAP + CARD_W / 2 - 9 }]}>
                <PaperClip />
              </View>

              {/* Card 1 — user photo */}
              <TouchableOpacity
                style={[s.card, { width: CARD_W, height: CARD_H }]}
                onPress={() => !editMode && pickPhoto('user')}
                activeOpacity={0.85}
              >
                {userPhoto
                  ? <Image source={{ uri: userPhoto }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                  : <View style={s.cardEmpty}>
                      <Feather name="camera" size={26} color="rgba(237,224,196,0.4)" />
                      <Text style={s.cardLabel}>Your Mug</Text>
                    </View>
                }
              </TouchableOpacity>

              {/* Card 2 — the 00-00 login may place it on its own Ticket too */}
              <TouchableOpacity
                style={[s.card, { width: CARD_W, height: CARD_H }]}
                onPress={() => void pickPhoto('admin')}
                disabled={jokerId !== '00-00' || uploading}
                activeOpacity={0.82}
              >
                {adminPhoto
                  ? <Image source={{ uri: adminPhoto }} style={StyleSheet.absoluteFill} resizeMode="cover" />
                  : <View style={s.cardEmpty}>
                      <Feather name="lock" size={20} color="rgba(237,224,196,0.28)" />
                      <Text style={[s.cardLabel, { opacity: 0.4 }]}>Admin</Text>
                      {jokerId === '00-00' && <Text style={s.adminCardHint}>Tap to upload</Text>}
                    </View>
                }
                {jokerId === '00-00' && (
                  <View pointerEvents="none" style={s.adminEditBadge}>
                    <Feather name="edit-2" size={14} color="#0A0A0A" />
                  </View>
                )}
              </TouchableOpacity>
            </View>

            {/* ── Upload progress ── */}
            {uploading && (
              <View style={s.uploadBar}>
                <ActivityIndicator size="small" color="#D4A853" />
                <Text style={s.uploadText}>Uploading… {uploadPct}%</Text>
              </View>
            )}

            {/* ── Go Dark / New Mug ── */}
            <View style={s.cardBtns}>
              <TouchableOpacity style={s.darkBtn} onPress={goDark} disabled={uploading}>
                <Text style={s.darkBtnText}>Go Dark</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.mugBtn} onPress={() => pickPhoto('user')} disabled={uploading}>
                <Text style={s.mugBtnText}>New Mug</Text>
              </TouchableOpacity>
            </View>

            <View style={[s.fieldBlock, { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.35)', padding: 14, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(237,224,196,0.1)' }]}>
              <View>
                <Text style={[s.fieldLabel, { marginBottom: 4 }]}>SEAT TEMPERATURE</Text>
                <Text style={[s.fieldValue, { color: temp === 'Hot' ? '#FF6B6B' : temp === 'Warm' ? '#FFA06B' : 'rgba(237,224,196,0.5)' }]}>
                  {temp?.toUpperCase()}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[s.fieldLabel, { marginBottom: 4 }]}>STREAK</Text>
                <Text style={s.fieldValue}>{streak}</Text>
              </View>
            </View>

            {/* ── Suit — what you're reading right now ── */}
            <View style={s.suitBlock}>
              <Text style={s.fieldLabel}>SUIT — WHAT YOU'RE READING NOW</Text>
              <View style={s.suitRow}>
                {(['Spade', 'Diamond', 'Heart', 'Club'] as const).map(v => {
                  const active = values.suit === v;
                  return (
                    <TouchableOpacity
                      key={v}
                      style={[s.suitPill, active && s.suitPillActive]}
                      onPress={() => void pickSuit(v)}
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

            {/* ── Divider ── */}
            <View style={s.divider} />

            {/* ── All input fields ── */}
            {fieldsForJokerId(jokerId).map(f => (
              <View key={f.id} style={s.fieldBlock}>
                <Text style={s.fieldLabel}>{f.label}</Text>
                <TextInput
                  style={[
                    s.input,
                    f.multiline && { height: f.height, textAlignVertical: 'top', paddingTop: 12 },
                    !unlocked && s.inputLocked,
                  ]}
                  value={values[f.id] || ''}
                  onChangeText={t => setValues(v => ({ ...v, [f.id]: t }))}
                  placeholder={f.placeholder}
                  placeholderTextColor="rgba(237,224,196,0.3)"
                  multiline={f.multiline}
                  editable={unlocked}
                />
              </View>
            ))}

            {/* ── Review Intel / File Intel ── */}
            <View style={s.bottomBtns}>
              <TouchableOpacity style={s.reviewBtn} onPress={reviewIntel}>
                <Text style={s.reviewText}>Review Intel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.fileBtn, !unlocked && { opacity: 0.5 }]}
                onPress={fileIntel}
                disabled={filing || !unlocked}
              >
                {filing
                  ? <ActivityIndicator color="#D4A853" />
                  : <Text style={s.fileText}>File Intel</Text>
                }
              </TouchableOpacity>
            </View>

          </View>{/* end folder body */}
        </View>{/* end folder wrap */}
      </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Saved toast ── */}
      {savedFlash && (
        <View style={[s.toast, { top: topInset + 11 }]}>
          <Feather name="check-circle" size={13} color="#FFD700" />
          <Text style={s.toastText}>Saved</Text>
        </View>
      )}
    </View>
  );
}

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20,
              justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { flex: 1, textAlign: 'center',
              color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },
  editBtn:  { width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
              borderRadius: 17, borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)',
              backgroundColor: 'rgba(0,0,0,0.5)' },

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
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    paddingHorizontal: SIDE, paddingBottom: SIDE, paddingTop: SIDE + 8,
  },

  // Cards
  cardsRow: { flexDirection: 'row', gap: GAP, marginBottom: SIDE },
  clipPos:  { position: 'absolute', top: -14, zIndex: 5 },
  card: {
    borderRadius: 8, backgroundColor: '#111',
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.28)', overflow: 'hidden',
  },
  cardEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  cardLabel: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },
  adminCardHint: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 0.8 },
  adminEditBadge: {
    position: 'absolute', top: 8, right: 8, width: 28, height: 28,
    borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: GOLD, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)',
  },

  cardBtns: { flexDirection: 'row', gap: GAP, marginBottom: SIDE },
  darkBtn:  { flex: 1, height: 38, borderRadius: 8, backgroundColor: 'rgba(80,0,0,0.45)',
    borderWidth: 1, borderColor: 'rgba(180,40,40,0.4)', alignItems: 'center', justifyContent: 'center' },
  darkBtnText: { color: '#C84040', fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.5 },
  mugBtn:   { flex: 1, height: 38, borderRadius: 8, backgroundColor: 'rgba(200,165,60,0.08)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)', alignItems: 'center', justifyContent: 'center' },
  mugBtnText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.5 },

  divider: { height: 1, backgroundColor: 'rgba(200,165,60,0.18)', marginBottom: SIDE + 4 },

  // Upload progress
  uploadBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10,
    backgroundColor: 'rgba(200,165,60,0.08)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)' },
  uploadText: { color: GOLD, fontFamily: 'Cinzel_400Regular', fontSize: 11, letterSpacing: 1 },

  // Inputs
  fieldBlock: { marginBottom: 20 },
  suitBlock: { paddingHorizontal: SIDE, marginBottom: SIDE },
  suitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  suitPill: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  suitPillActive: { backgroundColor: '#D4A853', borderColor: '#D4A853' },
  suitPillText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1 },
  suitPillTextActive: { color: '#0A0A0A' },
  fieldLabel: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10,
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8, opacity: 0.8 },
  fieldValue: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13, lineHeight: 20 },
  inputLocked: { opacity: 0.55 },
  input: { width: '100%', height: 48, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.18)', color: CREAM,
    fontFamily: 'Cinzel_400Regular', fontSize: 13, paddingHorizontal: 14 },

  // Bottom buttons
  bottomBtns: { flexDirection: 'row', gap: GAP, marginTop: 8 },
  reviewBtn:  { flex: 1, height: 52, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)', alignItems: 'center', justifyContent: 'center' },
  reviewText: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
  fileBtn:    { flex: 1, height: 52, borderRadius: 10, backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.45)', alignItems: 'center', justifyContent: 'center' },
  fileText:   { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },

  // Toast
  toast: { position: 'absolute', alignSelf: 'center', flexDirection: 'row', alignItems: 'center',
    gap: 6, backgroundColor: 'rgba(5,3,0,0.92)', borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 8, borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.5)', zIndex: 300 },
  toastText: { fontSize: 11, color: '#FFD700', letterSpacing: 2 },
});
