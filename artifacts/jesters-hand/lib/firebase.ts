import { initializeApp, getApps } from 'firebase/app';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getAuth,
  initializeAuth,
  type Auth,
  type Persistence,
} from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey:            process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];

/**
 * Firebase's React Native build defaults to in-memory auth unless an
 * AsyncStorage persistence adapter is supplied. In-memory auth disappears
 * when Android kills the app process (including a swipe from Recents).
 *
 * The React Native runtime exports getReactNativePersistence, while the web
 * TypeScript declaration selected by the shared Expo/web build does not.
 * Keep the runtime lookup typed locally so one module works on both targets.
 */
type ReactNativePersistenceFactory = (storage: typeof AsyncStorage) => Persistence;
const reactNativePersistence = (
  FirebaseAuthRuntime: typeof import('firebase/auth'),
): ReactNativePersistenceFactory | null => {
  const factory = (
    FirebaseAuthRuntime as typeof FirebaseAuthRuntime & {
      getReactNativePersistence?: ReactNativePersistenceFactory;
    }
  ).getReactNativePersistence;
  return typeof factory === 'function' ? factory : null;
};

const createAuth = (): Auth => {
  if (Platform.OS === 'web') return getAuth(app);

  // Metro resolves firebase/auth to Firebase's React Native entrypoint.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const runtime = require('firebase/auth') as typeof import('firebase/auth');
  const persistenceFactory = reactNativePersistence(runtime);
  if (!persistenceFactory) {
    throw new Error('Firebase React Native auth persistence is unavailable.');
  }

  try {
    return initializeAuth(app, {
      persistence: persistenceFactory(AsyncStorage),
    });
  } catch (error) {
    // Fast Refresh can evaluate this module after Auth already exists. Reuse
    // that same durable instance rather than treating development reloads as
    // an app startup failure.
    if ((error as { code?: string }).code === 'auth/already-initialized') {
      return getAuth(app);
    }
    throw error;
  }
};

export const auth    = createAuth();
export const db      = getFirestore(app);
export const storage = getStorage(app);
export default app;
