import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { appWindow } from '@/lib/appWindow';

const { width: SW, height: SH } = appWindow();
const TAB_W = 160;
const TAB_H = 38;

interface FileTransitionContextType {
  navigateTo: (route: string) => void;
}

const FileTransitionContext = createContext<FileTransitionContextType>({
  navigateTo: () => {},
});

export function useFileTransition() {
  return useContext(FileTransitionContext);
}

export function FileTransitionProvider({ children }: { children: React.ReactNode }) {
  const [visible, setVisible] = useState(false);
  const slideY  = useRef(new Animated.Value(SH)).current;
  const scaleX  = useRef(new Animated.Value(1)).current;

  const navigateTo = useCallback((route: string) => {
    setVisible(true);
    slideY.setValue(SH);
    scaleX.setValue(1);

    // ── Phase 1: File slides up from bottom, covering the screen ──────────
    Animated.timing(slideY, {
      toValue: 0,
      duration: 380,
      easing: Easing.bezier(0.4, 0.0, 0.2, 1),
      useNativeDriver: true,
    }).start(() => {

      // ── Phase 2: Brief "filed away" — squish slightly then navigate ──────
      Animated.sequence([
        Animated.timing(scaleX, {
          toValue: 0.92,
          duration: 80,
          useNativeDriver: true,
        }),
        Animated.timing(scaleX, {
          toValue: 1,
          duration: 60,
          useNativeDriver: true,
        }),
      ]).start(() => {
        router.push(route as any);

        // ── Phase 3: After a beat, new file sweeps off upward ───────────────
        setTimeout(() => {
          Animated.timing(slideY, {
            toValue: -SH,
            duration: 360,
            easing: Easing.bezier(0.4, 0.0, 0.6, 1),
            useNativeDriver: true,
          }).start(() => {
            setVisible(false);
            slideY.setValue(SH);
            scaleX.setValue(1);
          });
        }, 120);
      });
    });
  }, [slideY, scaleX]);

  return (
    <FileTransitionContext.Provider value={{ navigateTo }}>
      {children}

      {visible && (
        <Animated.View
          style={[
            styles.overlay,
            { transform: [{ translateY: slideY }, { scaleX }] },
          ]}
          pointerEvents="none"
        >
          {/* File tab */}
          <View style={styles.tab}>
            <Text style={styles.tabText}>JESTER'S HAND</Text>
          </View>
          {/* Folder body */}
          <View style={styles.body} />
        </Animated.View>
      )}
    </FileTransitionContext.Provider>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: SH + 60,
    zIndex: 9999,
  },
  tab: {
    position: 'absolute',
    top: 0, left: 20,
    width: TAB_W, height: TAB_H,
    backgroundColor: '#111',
    borderTopLeftRadius: 10,
    borderTopRightRadius: 10,
    borderWidth: 1,
    borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.4)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  tabText: {
    color: '#EDE0C4',
    fontFamily: 'Cinzel_700Bold',
    fontSize: 11,
    letterSpacing: 2,
  },
  body: {
    position: 'absolute',
    top: TAB_H,
    left: 0, right: 0,
    bottom: 0,
    backgroundColor: '#0A0A0A',
    borderTopRightRadius: 10,
    borderTopLeftRadius: 0,
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.25)',
  },
});
