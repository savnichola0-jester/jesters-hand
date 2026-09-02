/**
 * Push notification service — Expo push tokens + best-effort push sends.
 *
 * Token registration: on sign-in the device's Expo push token is stored on
 * the user's own doc at users/{uid}.expoPushToken. Registration is skipped
 * on web and degrades gracefully in Expo Go environments where remote push
 * is unavailable.
 *
 * Sending: when a notification lands in a recipient's bell feed, the sender's
 * device also asks the api-server (POST /api/push/send, authenticated with
 * the sender's Firebase ID token) to deliver an Expo push to the recipient's
 * registered token. Sends are best-effort — the in-app bell feed is the
 * source of truth.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { deleteField, doc, getDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebase';
import { getApiDomain } from './apiConfig';
import type { AppNotificationType } from './notificationService';
import { notificationText, notificationTitle } from './notificationCatalog';
import { registerWebPush, unregisterWebPush } from './webPush';
import { routeNotification } from './notificationRouting';

const ANDROID_CHANNEL_ID = 'dispatches';
let nativeListenersAttached = false;

export type PushRegistrationResult =
  | { status: 'registered' }
  | { status: 'web-attempted' }
  | { status: 'muted' }
  | { status: 'unsupported-device' }
  | { status: 'permission-denied'; canAskAgain: boolean }
  | { status: 'missing-project-id' }
  | { status: 'token-unavailable' }
  | { status: 'failed'; reason: string };

/** Configure foreground presentation and notification-tap routing once. */
export async function configureNativePushNotifications(): Promise<() => void> {
  if (Platform.OS === 'web' || nativeListenersAttached) return () => {};
  const Notifications = await import('expo-notifications');
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
  nativeListenersAttached = true;
  const response = Notifications.addNotificationResponseReceivedListener(event => {
    const data = event.notification.request.content.data;
    if (typeof data?.type === 'string') routeNotification(data as any);
  });
  return () => {
    nativeListenersAttached = false;
    response.remove();
  };
}

// ── Token registration ────────────────────────────────────────────────────────

/**
 * Request notification permission and store this device's Expo push token on
 * the signed-in user's doc. Safe to call on every sign-in; no-ops on web or
 * when permission is denied / push is unavailable.
 */
export async function registerPushToken(
  uid: string,
  opts: { interactive?: boolean } = {},
): Promise<PushRegistrationResult> {
  try {
    // Respect the member's saved preference (System screen): if they turned
    // alerts off on purpose, sign-in must not silently re-enable them.
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists() && snap.data().alertsMuted === true) return { status: 'muted' };

    if (Platform.OS === 'web') {
      // Browser (Web Push): non-interactive calls only re-subscribe when
      // permission was already granted — no surprise permission prompts.
      await registerWebPush(uid, { interactive: opts.interactive === true });
      return { status: 'web-attempted' };
    }
    const Notifications = await import('expo-notifications');
    const Device = await import('expo-device');
    if (!Device.isDevice) return { status: 'unsupported-device' }; // simulators can't receive pushes

    let permission = await Notifications.getPermissionsAsync();
    let { status } = permission;
    if (status !== 'granted') {
      permission = await Notifications.requestPermissionsAsync();
      status = permission.status;
    }
    if (status !== 'granted') {
      return { status: 'permission-denied', canAskAgain: permission.canAskAgain };
    }

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name: 'Dispatches',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#D4A853',
        sound: 'default',
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }

    const projectId: string | undefined =
      Constants?.expoConfig?.extra?.eas?.projectId ?? Constants?.easConfig?.projectId;
    if (!projectId) return { status: 'missing-project-id' };
    const token = (
      await Notifications.getExpoPushTokenAsync({ projectId })
    ).data;
    if (!token) return { status: 'token-unavailable' };

    await updateDoc(doc(db, 'users', uid), { expoPushToken: token });
    return { status: 'registered' };
  } catch (err) {
    // Expo Go on Android (SDK 53+) doesn't support remote push — never fatal.
    console.warn('[push] token registration skipped:', err);
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Remove this user's stored Expo push token. Called on sign-out (while the
 * user is still authenticated — Firestore rules require it) so pushes for
 * this account stop reaching the device after the owner signs out or another
 * account signs in on the same phone. Best-effort: never throws, so a
 * network hiccup can't block sign-out.
 */
export async function unregisterPushToken(uid: string): Promise<void> {
  try {
    if (Platform.OS === 'web') {
      await unregisterWebPush(uid);
      return;
    }
    await updateDoc(doc(db, 'users', uid), { expoPushToken: deleteField() });
  } catch (err) {
    console.warn('[push] token unregister failed:', err);
  }
}

// ── Sending ───────────────────────────────────────────────────────────────────

export interface PushPayload {
  type:            AppNotificationType;
  title?:           string;
  fromUid?:        string;
  conversationId?: string;
  anteBoard?:      string;
  antePostId?:     string;
  targetTicketId?: string;
  vaultEntryId?:   string;
  vaultSection?:   string;
  text:            string;
}

// Small caches so a fan-out doesn't re-read the same user docs repeatedly.
const jokerIdCache = new Map<string, string>();

async function getJokerId(uid: string): Promise<string | null> {
  if (jokerIdCache.has(uid)) return jokerIdCache.get(uid)!;
  try {
    const snap = await getDoc(doc(db, 'users', uid));
    const id = snap.exists() ? (snap.data().jokerId ?? null) : null;
    if (id) jokerIdCache.set(uid, id);
    return id;
  } catch {
    return null;
  }
}

/**
 * Best-effort: deliver a push mirroring a just-written bell notification to
 * each recipient that has a registered push token. Never throws.
 */
export async function sendPushToUsers(
  recipientUids: string[],
  payload: PushPayload,
): Promise<void> {
  try {
    const domain = getApiDomain();
    const idToken = await auth.currentUser?.getIdToken();
    if (!domain || !idToken || recipientUids.length === 0) return;

    const senderLabel = payload.fromUid ? await getJokerId(payload.fromUid) : null;
    const normalizedText = notificationText(payload.type, payload.text);
    const body = senderLabel ? `${senderLabel} ${normalizedText}` : normalizedText;

    const title = payload.title ?? notificationTitle(payload.type);
    const data = {
      type:            payload.type,
      conversationId:  payload.conversationId,
      anteBoard:       payload.anteBoard,
      antePostId:      payload.antePostId,
      targetTicketId:  payload.targetTicketId,
      vaultEntryId:    payload.vaultEntryId,
      vaultSection:    payload.vaultSection,
    };

    // The relay resolves each recipient's registered Expo token and Web Push
    // subscriptions from their user doc itself (and honors alertsMuted), so
    // this device only ever names recipients by uid. Dead-token/subscription
    // cleanup also happens server-side.
    await fetch(`https://${domain}/api/push/send`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${idToken}`,
      },
      body: JSON.stringify({ toUids: recipientUids, title, body, data }),
    });
  } catch (err) {
    console.warn('[push] send failed:', err);
  }
}
