/**
 * Web Push (browser) registration — the web counterpart of the native Expo
 * push token. Subscriptions are stored on the member's own user doc under
 * users/{uid}.webPushSubs.{key} where key is a hash of the endpoint, so a
 * member can hold one subscription per browser/device at the same time.
 *
 * Delivery happens through the api-server (POST /api/push/send with
 * `webMessages`), which signs sends with the app's VAPID keys.
 */
import { Platform } from 'react-native';
import { deleteField, doc, updateDoc } from 'firebase/firestore';
import { db } from './firebase';

export interface WebPushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  at?: number;
}

export function webPushSupported(): boolean {
  return (
    Platform.OS === 'web' &&
    typeof navigator !== 'undefined' &&
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Stable per-browser key for a subscription — hash of its endpoint URL. */
export async function subKeyForEndpoint(endpoint: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(buf).slice(0, 12))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Register this browser for push and store the subscription on the user doc.
 * When `interactive` is false (e.g. automatic sign-in), never prompts — it
 * only re-subscribes if permission was already granted.
 * Returns true if a subscription is in place.
 */
export async function registerWebPush(
  uid: string,
  opts: { interactive: boolean },
): Promise<boolean> {
  if (!webPushSupported()) return false;
  const vapidPublicKey = process.env.EXPO_PUBLIC_VAPID_PUBLIC_KEY;
  if (!vapidPublicKey) {
    console.warn('[webpush] EXPO_PUBLIC_VAPID_PUBLIC_KEY not set');
    return false;
  }
  try {
    if (Notification.permission === 'denied') return false;
    if (Notification.permission !== 'granted') {
      if (!opts.interactive) return false;
      const status = await Notification.requestPermission();
      if (status !== 'granted') return false;
    }
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as unknown as BufferSource,
      });
    }
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return false;
    const key = await subKeyForEndpoint(json.endpoint);
    await updateDoc(doc(db, 'users', uid), {
      [`webPushSubs.${key}`]: {
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        at: Date.now(),
      },
    });
    return true;
  } catch (err) {
    console.warn('[webpush] registration failed:', err);
    return false;
  }
}

/**
 * Remove this browser's subscription from the user doc (and unsubscribe the
 * browser) — called on sign-out / alerts-off. Best-effort, never throws.
 */
export async function unregisterWebPush(uid: string): Promise<void> {
  if (!webPushSupported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    const key = await subKeyForEndpoint(sub.endpoint);
    await updateDoc(doc(db, 'users', uid), {
      [`webPushSubs.${key}`]: deleteField(),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  } catch (err) {
    console.warn('[webpush] unregister failed:', err);
  }
}
