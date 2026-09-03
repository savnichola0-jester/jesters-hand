import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Dimensions,
  Platform,
  Image,
  ImageBackground,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import * as Haptics from 'expo-haptics';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { signInWithEmailAndPassword } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { ElementData } from '@/components/DraggableElement';
import {
  LockscreenLayout, fetchLockscreenLayout, publishLockscreenLayout, scaleLayout,
} from '@/lib/lockscreenLayout';
import { consumeSuspensionNotice } from '@/lib/authService';
import { appWindow } from '@/lib/appWindow';

const { width: SW, height: SH } = appWindow();

// Image natural aspect ratio (874 × 1798)
const IMG_W = 874;
const IMG_H = 1798;
const IMG_RATIO = IMG_H / IMG_W; // ≈ 2.057

// On wide screens (laptops/desktops) the lock screen renders inside a
// centered, phone-proportioned frame so the card image fits the window
// height instead of blowing up to the full window width. On phones
// FRAME_W === SW, so nothing changes there.
const FRAME_W = Math.min(SW, SH / IMG_RATIO);

const BG_IMAGE = require('../../assets/images/lockscreen.png');
const STONE_TEXTURE = require('../../assets/images/stone_texture.png');

const STORAGE_KEY = '@jesters_hand_v3';

// Default bg: show full image (contain-style, no crop)
const DEFAULT_BG_SCALE = FRAME_W / IMG_W; // fits image to frame width
const DEFAULT_BG_X = 0;
const DEFAULT_BG_Y = (SH - FRAME_W * IMG_RATIO) / 2; // vertically centered

function getDefaultElements(): ElementData[] {
  // positions are relative to the image display area
  const imgDisplayH = FRAME_W * IMG_RATIO;
  const imgTop = DEFAULT_BG_Y;

  return [
    {
      id: 'jokerInput',
      type: 'jokerInput',
      x: FRAME_W * 0.1,
      y: imgTop + imgDisplayH * 0.593,
      width: FRAME_W * 0.8,
      height: 48,
    },
    {
      id: 'cipherInput',
      type: 'cipherInput',
      x: FRAME_W * 0.1,
      y: imgTop + imgDisplayH * 0.718,
      width: FRAME_W * 0.8,
      height: 48,
    },
    {
      id: 'takeSeatBtn',
      type: 'takeSeatBtn',
      x: FRAME_W * 0.2,
      y: imgTop + imgDisplayH * 0.800,
      width: FRAME_W * 0.6,
      height: 52,
    },
  ];
}

// ─── Stone Texture Button ─────────────────────────────────────────
function TakeSeatButton({
  element,
  onPress,
  loading,
}: {
  element: ElementData;
  onPress: () => void;
  loading?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.82}
      disabled={loading}
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        borderRadius: 5,
        overflow: 'hidden',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.5,
        shadowRadius: 8,
        elevation: 6,
      }}
    >
      <ImageBackground
        source={STONE_TEXTURE}
        style={[styles.takeSeatBg, { width: element.width, height: element.height }]}
        imageStyle={{ borderRadius: 5 }}
      >
        <View style={styles.takeSeatTint} />
        {loading
          ? <ActivityIndicator color="#D4A853" />
          : <Text style={styles.takeSeatText}>Take a Seat</Text>
        }
      </ImageBackground>
    </TouchableOpacity>
  );
}

// ─── Input Overlay ────────────────────────────────────────────────
function InputOverlay({
  element,
  placeholder,
  value,
  onChangeText,
  secure,
}: {
  element: ElementData;
  placeholder: string;
  value: string;
  onChangeText: (v: string) => void;
  secure?: boolean;
}) {
  const [revealed, setRevealed] = useState(false);

  return (
    <View
      style={{
        position: 'absolute',
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
      }}
    >
      <TextInput
        style={[styles.input, { flex: 1, paddingRight: secure ? 44 : 14 }]}
        placeholder={placeholder}
        placeholderTextColor="rgba(200,165,60,0.45)"
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secure && !revealed}
        selectionColor="#D4A853"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {secure && (
        <TouchableOpacity
          onPress={() => setRevealed(r => !r)}
          activeOpacity={0.7}
          style={styles.eyeBtn}
        >
          <Feather name={revealed ? 'eye' : 'eye-off'} size={16} color="rgba(200,165,60,0.7)" />
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────
// NOTE: the lock screen's layout editor was removed by request. The layout the
// user arranged (input/button positions, background scale/offset) still loads
// from AsyncStorage below and renders exactly as saved.
export default function LockScreen() {
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 67 : insets.top;
  const { user, contractGateReady, contractGateRequired } = useAuth();

  // Background position/scale
  const [bgScale, setBgScale] = useState(DEFAULT_BG_SCALE);
  const [bgOffsetX, setBgOffsetX] = useState(DEFAULT_BG_X);
  const [bgOffsetY, setBgOffsetY] = useState(DEFAULT_BG_Y);

  // Elements
  const [elements, setElements] = useState<ElementData[]>(getDefaultElements);

  // Inputs
  const [jokerIdValue, setJokerIdValue] = useState('');
  const [cipherValue, setCipherValue] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // If AuthContext force-signed this member out because their account was
  // suspended mid-session, surface the same message shown on failed sign-in.
  // Runs on focus (not just mount) — the lock screen may still be mounted
  // behind other screens when router.replace('/') brings it back.
  useFocusEffect(
    useCallback(() => {
      if (consumeSuspensionNotice()) {
        setAuthError('This Joker ID is currently suspended.');
      }
    }, [])
  );

  // Firebase accepting the credentials happens before the profile, agreement,
  // and current-contract checks settle. Navigate only after that entry gate is
  // ready so the first successful sign-in cannot be lost in a blank navigator.
  useEffect(() => {
    if (!user || !contractGateReady || contractGateRequired === null) return;
    router.replace(contractGateRequired ? '/contract' : '/(tabs)/home');
  }, [contractGateReady, contractGateRequired, user]);

  // Load saved layout. The shared (published) layout in Firestore wins so
  // every device shows the same arrangement, scaled to its screen; the
  // device-local AsyncStorage copy is the fallback — and if this device holds
  // a local layout, it gets published so phones pick it up too.
  useEffect(() => {
    let alive = true;
    const applyLayout = (l: LockscreenLayout) => {
      if (!alive) return;
      setElements(l.elements);
      setBgScale(l.bgScale);
      setBgOffsetX(l.bgOffsetX);
      setBgOffsetY(l.bgOffsetY);
    };
    (async () => {
      let local: LockscreenLayout | null = null;
      try {
        const data = await AsyncStorage.getItem(STORAGE_KEY);
        if (data) {
          const s = JSON.parse(data);
          if (s.elements && Array.isArray(s.elements)) {
            local = {
              elements: s.elements,
              bgScale: s.bgScale ?? DEFAULT_BG_SCALE,
              bgOffsetX: s.bgOffsetX ?? DEFAULT_BG_X,
              bgOffsetY: s.bgOffsetY ?? DEFAULT_BG_Y,
              screenW: FRAME_W, screenH: SH,
            };
            applyLayout(local); // instant, no network wait
          }
        }
      } catch {}
      const cloud = await fetchLockscreenLayout();
      if (cloud) {
        applyLayout(scaleLayout(cloud, FRAME_W, SH));
      } else if (local) {
        // First device with a layout publishes it (admin only per rules).
        publishLockscreenLayout(local);
      }
    })();
    return () => { alive = false; };
  }, []);

  const handleTakeSeat = useCallback(async () => {
    setAuthError(null);
    if (!jokerIdValue.trim() || !cipherValue.trim()) {
      setAuthError('Enter your Joker ID and Cipher.');
      return;
    }
    setAuthLoading(true);
    try {
      await signInWithEmailAndPassword(
        auth,
        `${jokerIdValue.trim().toLowerCase()}@jestershand.local`,
        cipherValue
      );
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    } catch (err: any) {
      console.error('[TakeSeat] Firebase error:', err?.code, err?.message);
      const msg =
        err.code === 'auth/invalid-credential' ||
        err.code === 'auth/wrong-password' ||
        err.code === 'auth/invalid-password'
          ? 'Invalid Joker ID or Cipher.'
          : err.code === 'auth/user-disabled'
          ? 'This Joker ID is currently suspended.'
          : err.code === 'auth/user-not-found'
          ? 'No Joker found with that ID.'
          : err.code === 'auth/too-many-requests'
          ? 'Too many attempts. Try again later.'
          : err.code === 'auth/network-request-failed'
          ? 'Network error. Check your connection.'
          : `Sign-in failed. (${err.code ?? 'unknown'})`;
      setAuthError(msg);
    } finally {
      setAuthLoading(false);
    }
  }, [jokerIdValue, cipherValue]);

  // ── Background dimensions ──
  const bgDisplayW = bgScale * IMG_W;
  const bgDisplayH = bgScale * IMG_H;
  const bgLeft = bgOffsetX + (FRAME_W - bgDisplayW) / 2;
  const bgTop = bgOffsetY + (SH - bgDisplayH) / 2;

  // ── View mode element renderer ──
  const renderViewElement = useCallback(
    (el: ElementData) => {
      switch (el.type) {
        case 'jokerInput':
          return (
            <InputOverlay
              key={el.id}
              element={el}
              placeholder="Enter Joker ID..."
              value={jokerIdValue}
              onChangeText={v => { setJokerIdValue(v); setAuthError(null); }}
            />
          );
        case 'cipherInput':
          return (
            <InputOverlay
              key={el.id}
              element={el}
              placeholder="Enter Cipher..."
              value={cipherValue}
              onChangeText={v => { setCipherValue(v); setAuthError(null); }}
              secure
            />
          );
        case 'takeSeatBtn':
          return <TakeSeatButton key={el.id} element={el} onPress={handleTakeSeat} loading={authLoading} />;
        case 'image':
          return el.uri ? (
            <Image
              key={el.id}
              source={{ uri: el.uri }}
              style={{ position: 'absolute', left: el.x, top: el.y, width: el.width, height: el.height }}
              resizeMode="contain"
            />
          ) : null;
        case 'text':
          return (
            <Text
              key={el.id}
              style={{
                position: 'absolute',
                left: el.x,
                top: el.y,
                width: el.width,
                fontSize: el.fontSize ?? 18,
                color: el.color ?? '#F5E8C8',
                fontFamily: 'Cinzel_400Regular',
                textShadowColor: 'rgba(0,0,0,0.85)',
                textShadowRadius: 5,
                textShadowOffset: { width: 1, height: 1 },
              }}
            >
              {el.text}
            </Text>
          );
        default:
          return null;
      }
    },
    [jokerIdValue, cipherValue, handleTakeSeat]
  );

  return (
    <View style={styles.root}>
      {/* Centered phone-proportioned frame (full width on phones) */}
      <View style={styles.frame}>
        {/* ── Background image (position/scale loaded from saved layout) ── */}
        <View style={StyleSheet.absoluteFill}>
          <Image
            source={BG_IMAGE}
            style={{
              position: 'absolute',
              left: bgLeft,
              top: bgTop,
              width: bgDisplayW,
              height: bgDisplayH,
            }}
            resizeMode="stretch"
          />
        </View>

        {/* ── Elements (saved layout) ── */}
        {elements.map(renderViewElement)}

        {/* Cover AI watermark at bottom-left of background image */}
        <View pointerEvents="none" style={styles.watermarkCover} />
      </View>

      {/* ── Auth error banner ── */}
      {authError && (
        <View style={styles.authErrorBanner}>
          <Feather name="alert-circle" size={13} color="#FF6B6B" />
          <Text style={styles.authErrorText}>{authError}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0900', alignItems: 'center' },
  frame: { width: FRAME_W, height: '100%', overflow: 'hidden' },
  bgBlack: { ...StyleSheet.absoluteFillObject, backgroundColor: '#0D0900' },
  bgEditBorder: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 2,
    borderColor: '#FFD700',
    borderStyle: 'dashed',
  },
  editOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.22)',
  },

  // ── Input ──
  input: {
    backgroundColor: 'rgba(0,0,0,0.58)',
    borderWidth: 1.5,
    borderColor: 'rgba(200,165,60,0.65)',
    borderRadius: 4,
    color: '#F5E8C8',
    paddingHorizontal: 14,
    fontSize: 15,
    fontFamily: 'Cinzel_400Regular',
    letterSpacing: 1,
    height: '100%',
  },
  eyeBtn: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  authErrorBanner: {
    position: 'absolute',
    bottom: 120,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(20,0,0,0.92)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,80,80,0.45)',
    zIndex: 300,
    maxWidth: SW * 0.85,
  },
  authErrorText: {
    fontSize: 12,
    color: '#FF6B6B',
    fontFamily: 'Cinzel_400Regular',
    letterSpacing: 0.5,
    flexShrink: 1,
  },

  // ── Stone button ──
  takeSeatBg: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    overflow: 'hidden',
  },
  takeSeatTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(30,15,0,0.18)',
  },
  takeSeatText: {
    fontSize: 12,
    fontFamily: 'Cinzel_900Black',
    color: '#1A0800',
    letterSpacing: 5,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(255,230,170,0.5)',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },

  // ── Edit toggle ──
  editToggle: {
    position: 'absolute',
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.72)',
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 200,
  },

  // ── Edit badge ──
  editBadge: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    zIndex: 200,
  },
  editBadgeText: {
    fontSize: 10,
    color: '#D4A853',
    fontFamily: 'Inter_500Medium',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },

  // ── BG hint ──
  bgHint: {
    position: 'absolute',
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.3)',
    zIndex: 200,
  },
  bgHintText: {
    fontSize: 11,
    color: '#FFD700',
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.5,
  },

  // ── Edit placeholder ──
  editPlaceholder: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editPlaceholderLabel: {
    color: 'rgba(200,165,60,0.65)',
    fontSize: 10,
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.5,
  },

  // ── Toolbar ──
  toolbar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(4,2,0,0.9)',
    borderRadius: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.22)',
    zIndex: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.55,
    shadowRadius: 12,
    elevation: 10,
  },
  toolBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    gap: 3,
    borderRadius: 8,
  },
  toolBtnActive: {
    backgroundColor: 'rgba(255,215,0,0.12)',
  },
  toolLabel: {
    fontSize: 9,
    color: '#D4A853',
    fontFamily: 'Inter_400Regular',
    letterSpacing: 0.3,
  },
  divider: {
    width: 1,
    height: 30,
    backgroundColor: 'rgba(200,165,60,0.18)',
    marginHorizontal: 2,
  },
  saveBtn: {
    flex: 1.2,
    backgroundColor: 'rgba(255,215,0,0.12)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.45)',
    paddingVertical: 8,
  },
  saveBtnText: {
    fontSize: 9,
    color: '#FFD700',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  doneBtn: {
    flex: 1.2,
    backgroundColor: 'rgba(200,165,60,0.15)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.45)',
    paddingVertical: 8,
  },
  doneBtnText: {
    fontSize: 11,
    color: '#D4A853',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  savedToast: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(5,3,0,0.92)',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(255,215,0,0.5)',
    zIndex: 300,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 10,
  },
  savedToastText: {
    fontSize: 12,
    color: '#FFD700',
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },

  // ── Modal ──
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.65)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#0E0900',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: 'rgba(200,165,60,0.3)',
    padding: 28,
    gap: 16,
  },
  modalTitle: {
    fontSize: 15,
    color: '#D4A853',
    fontFamily: 'Cinzel_700Bold',
    letterSpacing: 3,
    textTransform: 'uppercase',
    textAlign: 'center',
  },
  modalInput: {
    backgroundColor: 'rgba(200,165,60,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.35)',
    borderRadius: 8,
    color: '#F5E8C8',
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 15,
    fontFamily: 'Cinzel_400Regular',
  },
  modalConfirmBtn: {
    backgroundColor: 'rgba(200,165,60,0.18)',
    borderRadius: 10,
    paddingVertical: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.5)',
  },
  modalConfirmText: {
    color: '#D4A853',
    fontSize: 12,
    fontFamily: 'Cinzel_700Bold',
    letterSpacing: 3,
    textTransform: 'uppercase',
  },
  // Covers the "✦ AI-generated content" watermark at the bottom-left of the background image
  watermarkCover: {
    position: 'absolute', bottom: 0, left: 0,
    width: 175, height: 22,
    backgroundColor: '#000',
  },
});
