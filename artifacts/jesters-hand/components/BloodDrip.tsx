// Non-interactive, sculpted crimson drip. Geometry is shared with the
// asset-baking script (scripts/drips/composite.mjs) via lib/dripGeometry.js.
import React, { useMemo } from 'react';
import { Platform, StyleSheet, View, ViewStyle } from 'react-native';
import Svg, { Defs, Ellipse, LinearGradient, Path, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildDrip } = require('../lib/dripGeometry.js') as {
  buildDrip: (W: number, H: number, seed?: number, count?: number) => {
    body: string; band: number; drops: { x: number; w: number; L: number }[];
  };
};

export function BloodDrip({ width, height, seed = 1, count = 4, style }: {
  width: number; height: number; seed?: number; count?: number; style?: ViewStyle;
}) {
  const g = useMemo(() => buildDrip(width, height, seed, count), [width, height, seed, count]);
  const gid = `bd${seed}`;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height }, style]}
    >
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#3a0408" />
            <Stop offset="0.35" stopColor="#6a0a12" />
            <Stop offset="1" stopColor="#4a050b" />
          </LinearGradient>
        </Defs>
        <Path d={g.body} fill="#000" opacity={0.5} transform={`translate(${width * 0.006}, ${height * 0.03})`} />
        <Path d={g.body} fill={`url(#${gid})`} stroke="#1e0204" strokeWidth={Math.max(1, height * 0.012)} />
        <Path d={g.body} fill="none" stroke="#a3141f" strokeOpacity={0.35} strokeWidth={0.8} transform="translate(-0.6, -0.6)" />
        {g.drops.map(({ x, w, L }, i) => {
          const rr = w * 0.42;
          return (
            <React.Fragment key={i}>
              <Path d={`M${x - w * 0.12},${g.band * 1.2} L${x - w * 0.1},${L - rr * 2.1}`} stroke="#ff9c8c" strokeOpacity={0.16} strokeWidth={w * 0.1} strokeLinecap="round" />
              <Ellipse cx={x - rr * 0.32} cy={L - rr * 1.25} rx={rr * 0.22} ry={rr * 0.34} fill="#ffd9d0" opacity={0.38} />
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

/**
 * Global screen drip, mounted once inside the phone shell so every route
 * (lock screen, contract gate, member and admin screens) carries it. It hangs
 * only inside the status-bar / top-inset band, which every screen leaves
 * empty above its nav row, so titles and buttons stay clear.
 */
export function ScreenDrip() {
  const insets = useSafeAreaInsets();
  const band = Platform.OS === 'web' ? 50 : Math.max(insets.top, 28);
  const h = Math.max(22, band - 6);
  return (
    <View pointerEvents="none" style={sd.wrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <BloodDrip width={132} height={h} seed={11} count={4} style={sd.a} />
      <BloodDrip width={70} height={Math.round(h * 0.7)} seed={5} count={2} style={sd.b} />
    </View>
  );
}

const sd = StyleSheet.create({
  wrap: { ...StyleSheet.absoluteFillObject, zIndex: 9999, elevation: 30 },
  a: { position: 'absolute', top: 0, left: '38%' },
  b: { position: 'absolute', top: 0, right: '9%' },
});
