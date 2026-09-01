import React, { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  useFonts as useInterFonts,
} from '@expo-google-fonts/inter';
import {
  Cinzel_400Regular,
  Cinzel_600SemiBold,
  Cinzel_700Bold,
  Cinzel_900Black,
} from '@expo-google-fonts/cinzel';
// Editorial fonts for the Recruit/Verdict designer
import {
  PlayfairDisplay_400Regular,
  PlayfairDisplay_400Regular_Italic,
  PlayfairDisplay_700Bold,
  PlayfairDisplay_700Bold_Italic,
} from '@expo-google-fonts/playfair-display';
import { Oswald_400Regular, Oswald_700Bold } from '@expo-google-fonts/oswald';
import { SpecialElite_400Regular } from '@expo-google-fonts/special-elite';
import {
  EBGaramond_400Regular,
  EBGaramond_400Regular_Italic,
  EBGaramond_700Bold,
} from '@expo-google-fonts/eb-garamond';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { FileTransitionProvider } from '@/contexts/FileTransition';
import { AuthProvider } from '@/contexts/AuthContext';
import { WhisperProvider } from '@/contexts/WhisperContext';
import { NotificationProvider } from '@/contexts/NotificationContext';
import { sweepVaultTempFiles } from '@/lib/vaultService';
import { Platform, StyleSheet, View } from 'react-native';
import { APP_MAX_W } from '@/lib/appWindow';

SplashScreen.preventAutoHideAsync();

// Web: lock the document so the page itself can never scroll or rubber-band
// off screen on mobile — only in-app ScrollViews scroll. The custom +html.tsx
// CSS is not included in single-page web exports, so inject it at runtime.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    html, body {
      height: 100%;
      overflow: hidden;
      overscroll-behavior: none;
      touch-action: pan-x pan-y;
    }
    #root { height: 100%; overflow: hidden; }
  `;
  document.head.appendChild(style);
  // Belt and braces: some browsers still nudge scroll positions on focus.
  window.addEventListener('scroll', () => window.scrollTo(0, 0));
}

const queryClient = new QueryClient();

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}

/**
 * Web: render the whole app inside a centered, phone-sized column so desktop
 * browsers see the same proportions as a phone (frames stay unstretched).
 * Native: pass-through.
 */
function PhoneShell({ children }: { children: React.ReactNode }) {
  if (Platform.OS !== 'web') return <>{children}</>;
  return (
    <View style={shellStyles.outer}>
      <View style={shellStyles.column}>{children}</View>
    </View>
  );
}

const shellStyles = StyleSheet.create({
  outer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
  },
  column: {
    flex: 1,
    width: '100%',
    maxWidth: APP_MAX_W,
    overflow: 'hidden',
  },
});

export default function RootLayout() {
  const [fontsLoaded, fontError] = useInterFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Cinzel_400Regular,
    Cinzel_600SemiBold,
    Cinzel_700Bold,
    Cinzel_900Black,
    PlayfairDisplay_400Regular,
    PlayfairDisplay_400Regular_Italic,
    PlayfairDisplay_700Bold,
    PlayfairDisplay_700Bold_Italic,
    Oswald_400Regular,
    Oswald_700Bold,
    SpecialElite_400Regular,
    EBGaramond_400Regular,
    EBGaramond_400Regular_Italic,
    EBGaramond_700Bold,
  });

  // NOTE: icons are rendered as local SVGs via components/FIcon.tsx — the
  // @expo/vector-icons icon FONT failed to render on device in Expo Go
  // (glyphs showed as missing-glyph boxes), so no icon font is loaded at all.
  // Do not reintroduce icon fonts into this useFonts call.

  // Startup sweep: remove any vault-view-* temp files left behind if the app
  // was killed while a protected artwork viewer was open. Best-effort, async.
  useEffect(() => {
    sweepVaultTempFiles();
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1 }}>
            <KeyboardProvider>
              <AuthProvider>
                <WhisperProvider>
                  <NotificationProvider>
                    <PhoneShell>
                      <FileTransitionProvider>
                        <RootLayoutNav />
                      </FileTransitionProvider>
                    </PhoneShell>
                  </NotificationProvider>
                </WhisperProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
