// SCREEN 2 — Ticket creation (and author editing via ?id=): structured
// document fields on the top half, "The Spread" free canvas on the bottom.
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Dimensions, Platform,
  Image, ScrollView, Alert, KeyboardAvoidingView, ActivityIndicator,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '@/contexts/AuthContext';
import {
  TicketDraft, EMPTY_SPREAD, createTargetTicket, updateTargetTicket,
  listenTargetTicket, uploadSpreadPhoto,
} from '@/lib/targetTicketService';
import { TicketDocument } from '@/components/target/TicketDocument';
import { SpreadCanvas } from '@/components/target/SpreadCanvas';
import { DotLegend } from '@/components/target/StatusDot';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { showAlert, confirmAction } from '@/lib/confirm';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW, height: SH } = appWindow();
const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 40;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const BLANK: TicketDraft = {
  title: '', target: '', suit: 'spade',
  evidence: [{ text: '', source: '' }],
  connections: '', contradictions: '',
  confidence: 0, fieldDots: {}, spread: { ...EMPTY_SPREAD },
};

export default function TargetTicketNewScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user } = useAuth();
  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  const { id } = useLocalSearchParams<{ id?: string }>();
  const editingId = typeof id === 'string' && id ? id : null;

  const [draft, setDraft] = useState<TicketDraft>(BLANK);
  const [loaded, setLoaded] = useState(!editingId);
  const [saving, setSaving] = useState(false);
  // Pause page scrolling while a canvas gesture is in progress, otherwise
  // the ScrollView steals vertical drags from the Spread.
  const [scrollLocked, setScrollLocked] = useState(false);

  // Editing an existing ticket: load it once. If the ticket is gone
  // (deleted / bad id), bail back out instead of spinning forever.
  useEffect(() => {
    if (!editingId) return;
    let cancelled = false;
    const unsub = listenTargetTicket(editingId, t => {
      unsub();
      if (cancelled) return;
      if (t) {
        setDraft({
          title: t.title, target: t.target, suit: t.suit,
          evidence: t.evidence.length ? t.evidence : [{ text: '', source: '' }],
          connections: t.connections, contradictions: t.contradictions,
          confidence: t.confidence, fieldDots: t.fieldDots, spread: t.spread,
        });
        setLoaded(true);
      } else {
        showAlert('File not found', 'This ticket no longer exists.');
        router.back();
      }
    });
    return () => { cancelled = true; unsub(); };
  }, [editingId]);

  const pickPhoto = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.7,
    });
    if (res.canceled || !res.assets?.[0]?.uri) return null;
    try {
      return await uploadSpreadPhoto(user.uid, res.assets[0].uri);
    } catch {
      showAlert('Upload failed', 'Could not upload the photo.');
      return null;
    }
  }, [user]);

  const voidTicket = () => {
    confirmAction(
      'Void this ticket?',
      'The theory and its spread will be discarded.',
      'Void',
      () => router.back(),
    );
  };

  const fileIntel = async () => {
    if (!user || saving) return;
    if (!draft.title.trim()) {
      showAlert('Working Theory required', 'Give the ticket a working theory title.');
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await updateTargetTicket(editingId, draft);
      } else {
        await createTargetTicket(user.uid, draft);
      }
      router.replace('/(tabs)/target-ticket');
    } catch {
      showAlert('Error', 'Could not file the intel. Try again.');
      setSaving(false);
    }
  };

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Nav */}
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
          <Text style={s.navTitle} numberOfLines={1} pointerEvents="none">{editingId ? 'Amend Intel' : 'Gather Intel'}</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {!loaded ? (
        <ActivityIndicator color={GOLD} style={{ marginTop: navBottom + 60 }} />
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
            contentContainerStyle={{ padding: SIDE, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={!scrollLocked}
          >
            {/* The open case file */}
            <View>
              {/* Working Theory lives on the file's tab */}
              <View style={[s.tab, { height: TAB_H }]}>
                <TextInput
                  style={s.tabInput}
                  value={draft.title}
                  onChangeText={t => setDraft(d => ({ ...d, title: t }))}
                  placeholder="WORKING THEORY…"
                  placeholderTextColor="rgba(212,168,83,0.4)"
                  selectionColor={GOLD}
                  maxLength={120}
                />
              </View>

              <View style={s.body}>
                {/* TOP HALF — document fields */}
                <TicketDocument
                  draft={draft}
                  onChange={setDraft}
                  editable
                />

                {/* BOTTOM HALF — The Spread */}
                <Text style={s.spreadLabel}>The Spread</Text>
                <DotLegend />
                <SpreadCanvas
                  value={draft.spread}
                  onChange={sp => setDraft(d => ({ ...d, spread: sp }))}
                  editable
                  height={Math.round(SH * 0.55)}
                  onPickPhoto={pickPhoto}
                  onGestureActive={setScrollLocked}
                />
              </View>
            </View>

            {/* Buttons */}
            <View style={s.btnRow}>
              <TouchableOpacity style={s.voidBtn} onPress={voidTicket} activeOpacity={0.85}>
                <Text style={s.voidText}>Void</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.fileBtn, saving && { opacity: 0.5 }]}
                onPress={fileIntel}
                activeOpacity={0.85}
                disabled={saving}
              >
                {saving
                  ? <ActivityIndicator color="#FFD700" size="small" />
                  : <Text style={s.fileText}>File Intel</Text>}
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  nav:  { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10 },
  navRow: { position: 'absolute', bottom: 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center' },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 10, marginLeft: 'auto' },
  navTitle: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: CREAM, fontSize: 16, fontFamily: 'Cinzel_700Bold', letterSpacing: 1,
  },
  dagIcon: { width: 34, height: 34 },
  sqIcon:  { width: 34, height: 34 },

  tab: {
    width: Math.min(SW * 0.66, 270),
    backgroundColor: '#0D0D0D', borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(212,168,83,0.5)',
    justifyContent: 'center', paddingHorizontal: 12,
  },
  tabInput: {
    color: GOLD, fontSize: 12, fontFamily: 'Cinzel_700Bold', letterSpacing: 2,
    paddingVertical: 0,
  },
  body: {
    backgroundColor: '#0A0A0A',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    padding: 14,
  },

  spreadLabel: {
    marginTop: 22, marginBottom: 4,
    fontSize: 10.5, color: GOLD, fontFamily: 'Cinzel_700Bold',
    letterSpacing: 2.5, textTransform: 'uppercase',
  },

  btnRow: { flexDirection: 'row', gap: 12, marginTop: 18 },
  voidBtn: {
    ...MARBLE_BTN_BACKING,
    flex: 1, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(150,60,60,0.7)', backgroundColor: 'rgba(80,20,20,0.25)',
  },
  voidText: { ...MARBLE_TEXT_SHADOW, color: '#D08080', fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
  fileBtn: {
    flex: 2, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,215,0,0.6)', backgroundColor: '#0D0D0D',
  },
  fileText: { color: '#FFD700', fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
});
