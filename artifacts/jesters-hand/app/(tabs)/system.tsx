/**
 * The System — account & device controls.
 *
 * Home of everything about the member's own access to the app:
 *   • Standing        — Joker ID, role, alerts state at a glance
 *   • Change Cipher   — re-authenticates with the current cipher, then updates
 *   • Alerts          — turn push notifications on/off for this device
 *   • Leave the Table — sign out (moved here from the Ticket screen)
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, Image, ActivityIndicator, TextInput, Alert, Linking,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { deleteField, doc, getDoc, updateDoc } from 'firebase/firestore';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import { auth, db } from '@/lib/firebase';
import { signOutUser } from '@/lib/authService';
import { registerPushToken, unregisterPushToken } from '@/lib/pushService';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { SUIT_GLYPHS, SUIT_GENRES } from '@/lib/ticketFields';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const NAV_BELL   = require('../../assets/images/nav_bell.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const NAV_H = 52;
const SIDE  = 16;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

export default function SystemScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, jokerId, isAdmin } = useAuth();

  // Auth guard
  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  // ── Alerts (push token) state ─────────────────────────────────────────────
  const [alertsOn,      setAlertsOn]      = useState<boolean | null>(null); // null = loading
  const [alertsBusy,    setAlertsBusy]    = useState(false);

  // ── Role & suit (member-chosen, changeable anytime) ───────────────────────
  const [role, setRole] = useState<string | null>(null);
  const [suit, setSuit] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, 'users', user.uid))
      .then(snap => {
        const d = snap.data();
        const hasTarget = Platform.OS === 'web'
          ? Object.keys(d?.webPushSubs ?? {}).length > 0
          : !!d?.expoPushToken;
        setAlertsOn(d?.alertsMuted !== true && hasTarget);
        setRole(typeof d?.role === 'string' ? d.role : '');
        setSuit(typeof d?.suit === 'string' ? d.suit : '');
      })
      .catch(() => { setAlertsOn(false); setRole(''); setSuit(''); });
  }, [user?.uid]);

  const pickRole = useCallback((r: string) => {
    if (!user) return;
    setRole(r); // optimistic
    updateDoc(doc(db, 'users', user.uid), { role: r }).catch(() => {
      Alert.alert('Error', 'Could not save your role. Try again.');
    });
  }, [user]);

  const toggleAlerts = useCallback(async (next: boolean) => {
    if (!user || alertsBusy) return;
    setAlertsBusy(true);
    try {
      if (next) {
        // Clear the saved opt-out first — registerPushToken honors it.
        await updateDoc(doc(db, 'users', user.uid), { alertsMuted: deleteField() });
        const result = await registerPushToken(user.uid, { interactive: true });
        // registerPushToken no-ops silently if permission was denied or push
        // is unavailable — re-read the doc so the switch reflects the truth.
        const snap = await getDoc(doc(db, 'users', user.uid));
        const d = snap.data();
        const on = Platform.OS === 'web'
          ? Object.keys(d?.webPushSubs ?? {}).length > 0
          : !!d?.expoPushToken;
        setAlertsOn(on);
        if (!on) {
          let title = 'Alerts Unavailable';
          let msg = 'This device could not register for alerts.';
          let openSettings = false;
          if (Platform.OS === 'web') {
            msg = 'Notifications are blocked for this site in your browser settings. On iPhone, save the app to your home screen and open it from there first.';
          } else if (result.status === 'permission-denied') {
            title = 'Notification Permission Required';
            msg = result.canAskAgain
              ? 'Notification permission was not granted. Tap the bell again and allow notifications when Android asks.'
              : 'Android is not allowing this app to ask again. Open this app’s notification settings and allow notifications.';
            openSettings = !result.canAskAgain;
          } else if (result.status === 'unsupported-device') {
            msg = 'Remote alerts require a physical phone with Google Play services. Simulators cannot receive them.';
          } else if (result.status === 'missing-project-id') {
            msg = 'This app build is missing its Expo project identity. Install the latest native build.';
          } else if (result.status === 'token-unavailable') {
            msg = 'Expo did not issue a push token for this device. Install the latest native build and try again.';
          } else if (result.status === 'muted') {
            msg = 'Alerts are still marked as muted for this account. Turn them off, then on again.';
          } else if (result.status === 'failed') {
            const lower = result.reason.toLowerCase();
            if (lower.includes('firebase') || lower.includes('fcm')) {
              msg = `Firebase push registration failed: ${result.reason}`;
            } else {
              msg = `Push registration failed: ${result.reason}`;
            }
          } else if (result.status === 'registered') {
            msg = 'The device received a push token, but it could not be saved to your account. Check your connection and try again.';
          }
          // Alert.alert is a silent no-op on web — use the browser dialog there.
          if (Platform.OS === 'web') window.alert(msg);
          else Alert.alert(title, msg, openSettings
            ? [
                { text: 'Not Now', style: 'cancel' },
                { text: 'Open Settings', onPress: () => void Linking.openSettings() },
              ]
            : [{ text: 'OK' }]);
        }
      } else {
        // Persisted opt-out: survives app restarts — sign-in checks this flag
        // before auto-registering the push token.
        await updateDoc(doc(db, 'users', user.uid), { alertsMuted: true });
        await unregisterPushToken(user.uid);
        setAlertsOn(false);
      }
    } finally {
      setAlertsBusy(false);
    }
  }, [user, alertsBusy]);

  // ── Change cipher ─────────────────────────────────────────────────────────
  const [currentCipher, setCurrentCipher] = useState('');
  const [newCipher,     setNewCipher]     = useState('');
  const [confirmCipher, setConfirmCipher] = useState('');
  const [changing,      setChanging]      = useState(false);
  const [cipherMsg,     setCipherMsg]     = useState<{ ok: boolean; text: string } | null>(null);

  const changeCipher = useCallback(async () => {
    const u = auth.currentUser;
    if (!u?.email || changing) return;
    setCipherMsg(null);
    if (!currentCipher) {
      setCipherMsg({ ok: false, text: 'Enter your current cipher first.' });
      return;
    }
    if (newCipher.length < 6) {
      setCipherMsg({ ok: false, text: 'New cipher must be at least 6 characters.' });
      return;
    }
    if (newCipher !== confirmCipher) {
      setCipherMsg({ ok: false, text: 'New ciphers do not match.' });
      return;
    }
    if (newCipher === currentCipher) {
      setCipherMsg({ ok: false, text: 'New cipher must be different from the current one.' });
      return;
    }
    setChanging(true);
    try {
      // Firebase requires a recent sign-in before a password change — prove
      // identity with the current cipher, then update.
      const cred = EmailAuthProvider.credential(u.email, currentCipher);
      await reauthenticateWithCredential(u, cred);
      await updatePassword(u, newCipher);
      setCurrentCipher(''); setNewCipher(''); setConfirmCipher('');
      setCipherMsg({ ok: true, text: 'Cipher changed. Use it next time you enter.' });
    } catch (e: any) {
      const code = e?.code ?? '';
      const text =
        code === 'auth/wrong-password' || code === 'auth/invalid-credential'
          ? 'Current cipher is incorrect.'
          : code === 'auth/weak-password'
            ? 'New cipher is too weak — use at least 6 characters.'
            : code === 'auth/too-many-requests'
              ? 'Too many attempts. Wait a moment and try again.'
              : 'Could not change cipher. Check your connection and try again.';
      setCipherMsg({ ok: false, text });
    } finally {
      setChanging(false);
    }
  }, [currentCipher, newCipher, confirmCipher, changing]);

  // ── Sign out ──────────────────────────────────────────────────────────────
  const [signingOut, setSigningOut] = useState(false);
  const doSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOutUser();
      router.replace('/');
    } catch {
      Alert.alert('Error', 'Could not sign out. Try again.');
    } finally {
      setSigningOut(false);
    }
  }, []);
  const confirmSignOut = useCallback(() => {
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.confirm('Leave the table and sign out?')) {
        void doSignOut();
      }
      return;
    }
    Alert.alert('Leave the Table', 'Sign out of this device?', [
      { text: 'Stay', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => void doSignOut() },
    ]);
  }, [doSignOut]);

  const version = Constants?.expoConfig?.version ?? '1.0.0';
  const buildVersion = Platform.OS === 'android'
    ? String(Constants?.platform?.android?.versionCode ?? '—')
    : String(Constants?.platform?.ios?.buildNumber ?? '—');
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const checkForUpdate = useCallback(async () => {
    if (updateBusy) return;
    if (!Updates.isEnabled) {
      setUpdateMessage('Updates are available in the preview or production build.');
      return;
    }
    setUpdateBusy(true);
    setUpdateMessage(null);
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setUpdateMessage('You are already on the current version.');
        return;
      }
      await Updates.fetchUpdateAsync();
      setUpdateMessage('Update ready. Restarting now…');
      await Updates.reloadAsync();
    } catch (error: unknown) {
      setUpdateMessage(error instanceof Error ? error.message : 'Could not check for an update. Try again.');
    } finally {
      setUpdateBusy(false);
    }
  }, [updateBusy]);

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
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
          <Text style={s.navTitle} numberOfLines={1}>The System</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      <ScrollView
        style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
        contentContainerStyle={{ padding: SIDE, paddingBottom: 48 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* ── Standing ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>STANDING</Text>
          <View style={s.sectionLine} />
        </View>
        <View style={s.panel}>
          <View style={s.rowBetween}>
            <Text style={s.rowLabel}>Joker ID</Text>
            <Text style={s.rowValueGold}>{jokerId ?? '—'}</Text>
          </View>
          <View style={s.hairline} />
          {isAdmin ? (
            <View style={s.rowBetween}>
              <Text style={s.rowLabel}>Role</Text>
              <Text style={s.rowValueGold}>{jokerId === '00-00' ? 'Jester' : 'First Joker'}</Text>
            </View>
          ) : (
            <View style={{ paddingVertical: 6 }}>
              <Text style={s.rowLabel}>Role</Text>
              <View style={s.pillRow}>
                {['Scrub', 'Sweep', 'Mop'].map(r => (
                  <TouchableOpacity
                    key={r}
                    style={[s.pill, role === r && s.pillActive]}
                    onPress={() => pickRole(r)}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.pillText, role === r && s.pillTextActive]}>{r.toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}
          {suit ? (
            <>
              <View style={s.hairline} />
              <View style={s.rowBetween}>
                <Text style={s.rowLabel}>Suit</Text>
                <Text style={s.rowValueGold}>
                  {SUIT_GLYPHS[suit] ?? ''} {(SUIT_GENRES[suit] ?? suit).toUpperCase()}
                </Text>
              </View>
            </>
          ) : null}
          <View style={s.hairline} />
          <View style={s.rowBetween}>
            <Text style={s.rowLabel}>App Version</Text>
            <Text style={s.rowValue}>{version}</Text>
          </View>
          {Platform.OS !== 'web' ? (
            <>
              <View style={s.hairline} />
              <View style={s.rowBetween}>
                <Text style={s.rowLabel}>App Build</Text>
                <Text style={s.rowValue}>{buildVersion}</Text>
              </View>
            </>
          ) : null}
        </View>

        {/* ── Update ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>UPDATE</Text>
          <View style={s.sectionLine} />
        </View>
        <View style={s.panel}>
          <Text style={s.rowLabel}>App update</Text>
          <Text style={s.rowHint}>
            Check for the latest Hand release and install it without leaving the app.
          </Text>
          {updateMessage ? <Text style={s.updateMessage}>{updateMessage}</Text> : null}
          <TouchableOpacity
            testID="system-update"
            style={[s.goldBtn, updateBusy && { opacity: 0.6 }]}
            onPress={() => void checkForUpdate()}
            disabled={updateBusy}
            activeOpacity={0.8}
          >
            {updateBusy
              ? <ActivityIndicator size="small" color={GOLD} />
              : <Text style={s.goldBtnText}>UPDATE</Text>}
          </TouchableOpacity>
        </View>

        {/* ── The Contract ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>THE CONTRACT</Text>
          <View style={s.sectionLine} />
        </View>
        <TouchableOpacity
          style={s.panel}
          onPress={() => router.push('/contract')}
          activeOpacity={0.8}
        >
          <View style={s.rowBetween}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={s.rowLabel}>Rules of The Hand</Text>
              <Text style={s.rowHint}>
                The contract you signed on your first entry — rules, reactions, notifications, and your signature.
              </Text>
            </View>
            <Feather name="chevron-right" size={18} color={GOLD} />
          </View>
        </TouchableOpacity>

        {/* ── Alerts ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>ALERTS</Text>
          <View style={s.sectionLine} />
        </View>
        <View style={s.panel}>
          <View style={s.rowBetween}>
            <View style={{ flex: 1, paddingRight: 12 }}>
              <Text style={s.rowLabel}>Alerts on this device</Text>
              <Text style={s.rowHint}>
                Whispers, honors, and dispatches reach this phone even when the app is closed.
              </Text>
            </View>
            {alertsOn === null || alertsBusy ? (
              <ActivityIndicator size="small" color={GOLD} />
            ) : (
              <TouchableOpacity
                onPress={() => void toggleAlerts(!alertsOn)}
                activeOpacity={0.7}
                accessibilityLabel={alertsOn ? 'Turn alerts off' : 'Turn alerts on'}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                {/* The house bell — same one as the notification bell. Red
                    slash through it when alerts are muted on this device. */}
                <View style={s.bellWrap}>
                  <Image
                    source={NAV_BELL}
                    style={{ width: 32, height: 32, opacity: alertsOn ? 1 : 0.4 }}
                    resizeMode="contain"
                  />
                  {!alertsOn && <View style={s.bellSlash} />}
                </View>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* ── Change cipher ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>CHANGE CIPHER</Text>
          <View style={s.sectionLine} />
        </View>
        <View style={s.panel}>
          <Text style={s.fieldLabel}>CURRENT CIPHER</Text>
          <TextInput
            style={s.input}
            value={currentCipher}
            onChangeText={setCurrentCipher}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="••••••"
            placeholderTextColor="rgba(237,224,196,0.25)"
          />
          <Text style={s.fieldLabel}>NEW CIPHER</Text>
          <TextInput
            style={s.input}
            value={newCipher}
            onChangeText={setNewCipher}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="At least 6 characters"
            placeholderTextColor="rgba(237,224,196,0.25)"
          />
          <Text style={s.fieldLabel}>CONFIRM NEW CIPHER</Text>
          <TextInput
            style={s.input}
            value={confirmCipher}
            onChangeText={setConfirmCipher}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Repeat the new cipher"
            placeholderTextColor="rgba(237,224,196,0.25)"
          />

          {cipherMsg && (
            <View style={s.msgRow}>
              <Feather
                name={cipherMsg.ok ? 'check-circle' : 'alert-circle'}
                size={13}
                color={cipherMsg.ok ? '#FFD700' : '#FF6B6B'}
              />
              <Text style={[s.msgText, { color: cipherMsg.ok ? '#FFD700' : '#FF6B6B' }]}>
                {cipherMsg.text}
              </Text>
            </View>
          )}

          <TouchableOpacity
            style={[s.goldBtn, changing && { opacity: 0.6 }]}
            onPress={() => void changeCipher()}
            disabled={changing}
            activeOpacity={0.8}
          >
            {changing
              ? <ActivityIndicator size="small" color={GOLD} />
              : <Text style={s.goldBtnText}>SEAL NEW CIPHER</Text>}
          </TouchableOpacity>
          <Text style={s.panelFootnote}>
            Lost your cipher? Only The Hand can restore it.
          </Text>
        </View>

        {/* ── Session ── */}
        <View style={s.sectionHead}>
          <Text style={s.sectionTitle}>SESSION</Text>
          <View style={s.sectionLine} />
        </View>
        <View style={s.panel}>
          <TouchableOpacity
            style={s.signOutBtn}
            onPress={confirmSignOut}
            disabled={signingOut}
            activeOpacity={0.75}
          >
            {signingOut
              ? <ActivityIndicator size="small" color="rgba(237,224,196,0.6)" />
              : <>
                  <Feather name="log-out" size={14} color={GOLD} />
                  <Text style={s.signOutText}>LEAVE THE TABLE</Text>
                </>
            }
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20,
              justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { ...MARBLE_TEXT_SHADOW, flex: 1, textAlign: 'center',
              color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  sectionHead:  { flexDirection: 'row', alignItems: 'center', gap: 10,
                  marginTop: 18, marginBottom: 10 },
  sectionTitle: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 3 },
  sectionLine:  { flex: 1, height: 1, backgroundColor: 'rgba(212,168,83,0.55)' },

  panel: {
    backgroundColor: 'rgba(5,5,5,0.82)', borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },
  bellWrap: { width: 32, height: 32 },
  // Diagonal red slash across the bell when alerts are off (matches the
  // muted-thread bell treatment elsewhere in the app).
  bellSlash: {
    position: 'absolute', left: 15, top: -2,
    width: 2, height: 36, borderRadius: 1,
    backgroundColor: 'rgba(220,60,60,0.9)',
    transform: [{ rotate: '45deg' }],
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingVertical: 6 },
  rowLabel:   { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1 },
  rowValue:   { color: 'rgba(237,224,196,0.75)', fontFamily: 'Inter_500Medium', fontSize: 13 },
  rowValueGold: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 2 },
  rowHint:    { color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_400Regular', fontSize: 11,
                marginTop: 4, lineHeight: 15 },
  hairline:   { height: 1, backgroundColor: 'rgba(200,165,60,0.14)', marginVertical: 4 },

  fieldLabel: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10,
                letterSpacing: 2, marginBottom: 8, marginTop: 6, opacity: 0.8 },
  input: { width: '100%', height: 48, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8,
           borderWidth: 1, borderColor: 'rgba(237,224,196,0.18)', color: CREAM,
           fontFamily: 'Inter_400Regular', fontSize: 14, paddingHorizontal: 14, marginBottom: 8 },

  msgRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 2 },
  msgText: { fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },

  goldBtn: { height: 50, borderRadius: 10, marginTop: 12,
             backgroundColor: 'rgba(200,165,60,0.1)',
             borderWidth: 1, borderColor: 'rgba(200,165,60,0.45)',
             alignItems: 'center', justifyContent: 'center' },
  goldBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
  panelFootnote: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_400Regular',
                   fontSize: 11, marginTop: 10, textAlign: 'center' },
  updateMessage: { color: CREAM, fontFamily: 'Inter_400Regular', fontSize: 12,
                   lineHeight: 17, marginTop: 10 },

  signOutBtn: {
    ...MARBLE_BTN_BACKING,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 50, borderRadius: 10,
    backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.45)',
  },
  signOutText: {
    ...MARBLE_TEXT_SHADOW,
    color: GOLD, fontFamily: 'Cinzel_700Bold',
    fontSize: 12, letterSpacing: 2,
  },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  pill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  pillActive:     { backgroundColor: GOLD, borderColor: GOLD },
  pillText:       { color: 'rgba(237,224,196,0.7)', fontFamily: 'Cinzel_600SemiBold',
                    fontSize: 11, letterSpacing: 1.5 },
  pillTextActive: { color: '#000' },
});
