/**
 * SignaturePad — finger-drawn signature capture.
 *
 * Captures touch strokes with a PanResponder and renders them live as SVG
 * paths (react-native-svg — already used across the app; works in Expo Go).
 * The parent receives the raw SVG path strings so the signature can be
 * stored compactly in Firestore and re-rendered pixel-faithfully later.
 *
 * NOTE (per spread-canvas-gestures memory): this pad claims the gesture on
 * touch start deliberately — it sits inside a ScrollView, so it must win the
 * gesture or scrolling eats the strokes. The ScrollView parent should set
 * scrollEnabled={false} while the user is drawing (onDrawingChange).
 */
import React, { useCallback, useRef, useState } from 'react';
import { View, StyleSheet, PanResponder } from 'react-native';
import Svg, { Path } from 'react-native-svg';

const GOLD = '#D4A853';

interface Props {
  width: number;
  height: number;
  paths: string[];
  onPathsChange: (paths: string[]) => void;
  /** Fires true on touch start, false on release — lets parents lock scroll. */
  onDrawingChange?: (drawing: boolean) => void;
}

export default function SignaturePad({
  width, height, paths, onPathsChange, onDrawingChange,
}: Props) {
  const [livePath, setLivePath] = useState<string | null>(null);
  // Refs mirror props/state so the PanResponder (created once) reads fresh values.
  const pathsRef   = useRef(paths);
  pathsRef.current = paths;
  const liveRef    = useRef<string>('');

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder:        () => true,
      onMoveShouldSetPanResponder:         () => true,
      onPanResponderTerminationRequest:    () => false, // don't yield to the ScrollView mid-stroke
      onPanResponderGrant: (evt) => {
        onDrawingChange?.(true);
        const { locationX, locationY } = evt.nativeEvent;
        liveRef.current = `M${locationX.toFixed(1)} ${locationY.toFixed(1)}`;
        setLivePath(liveRef.current);
      },
      onPanResponderMove: (evt) => {
        const { locationX, locationY } = evt.nativeEvent;
        // Clamp to the pad so strokes can't escape the box.
        const x = Math.max(0, Math.min(locationX, width));
        const y = Math.max(0, Math.min(locationY, height));
        liveRef.current += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
        setLivePath(liveRef.current);
      },
      onPanResponderRelease: () => {
        onDrawingChange?.(false);
        if (liveRef.current.includes('L')) {
          onPathsChange([...pathsRef.current, liveRef.current]);
        } else if (liveRef.current) {
          // A tap — draw a dot (tiny line) so dotted i's still count.
          const dot = liveRef.current + liveRef.current.replace('M', ' L');
          onPathsChange([...pathsRef.current, dot]);
        }
        liveRef.current = '';
        setLivePath(null);
      },
      onPanResponderTerminate: () => {
        onDrawingChange?.(false);
        liveRef.current = '';
        setLivePath(null);
      },
    }),
  ).current;

  return (
    <View style={[s.pad, { width, height }]} {...panResponder.panHandlers}>
      <Svg width={width} height={height}>
        {paths.map((d, i) => (
          <Path key={i} d={d} stroke={GOLD} strokeWidth={2.5}
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
        ))}
        {livePath && (
          <Path d={livePath} stroke={GOLD} strokeWidth={2.5}
                strokeLinecap="round" strokeLinejoin="round" fill="none" />
        )}
      </Svg>
      {/* Baseline the member signs on */}
      <View pointerEvents="none" style={s.baseline} />
    </View>
  );
}

/** Read-only rendering of a stored signature, scaled to fit a target width. */
export function SignatureView({
  paths, sourceWidth, sourceHeight, displayWidth,
}: {
  paths: string[]; sourceWidth: number; sourceHeight: number; displayWidth: number;
}) {
  if (!paths.length || !sourceWidth || !sourceHeight) return null;
  const displayHeight = (sourceHeight / sourceWidth) * displayWidth;
  return (
    <Svg
      width={displayWidth}
      height={displayHeight}
      viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
    >
      {paths.map((d, i) => (
        <Path key={i} d={d} stroke={GOLD} strokeWidth={2.5}
              strokeLinecap="round" strokeLinejoin="round" fill="none" />
      ))}
    </Svg>
  );
}

const s = StyleSheet.create({
  pad: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.35)',
    overflow: 'hidden',
  },
  baseline: {
    position: 'absolute',
    left: 18, right: 18, bottom: 28,
    height: 1,
    backgroundColor: 'rgba(237,224,196,0.25)',
  },
});
