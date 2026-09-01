/**
 * Brown paw prints 🐾 — drawn as SVG so they're always brown.
 *
 * The native paw-prints emoji renders in whatever color the device's emoji
 * font uses (blue-gray on many phones). The Hand's paws are brown, so the
 * welcome page draws its own. Two prints, offset like a walking trail,
 * matching the emoji's layout.
 */
import React from 'react';
import Svg, { Circle, Ellipse, G } from 'react-native-svg';

const BROWN = '#8B5E3C';

function Paw({ x, y, scale }: { x: number; y: number; scale: number }) {
  return (
    <G transform={`translate(${x}, ${y}) scale(${scale})`}>
      {/* main pad */}
      <Ellipse cx="0" cy="10" rx="9.5" ry="8" fill={BROWN} />
      {/* toes */}
      <Circle cx="-10.5" cy="-2" r="4.4" fill={BROWN} />
      <Circle cx="-3.8" cy="-7.5" r="4.6" fill={BROWN} />
      <Circle cx="3.8" cy="-7.5" r="4.6" fill={BROWN} />
      <Circle cx="10.5" cy="-2" r="4.4" fill={BROWN} />
    </G>
  );
}

export default function PawPrints({ size = 22, color: _c }: { size?: number; color?: string }) {
  // ViewBox mirrors the 🐾 emoji: lower-left print + upper-right print.
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Paw x={20} y={40} scale={1.05} />
      <Paw x={46} y={18} scale={1.05} />
    </Svg>
  );
}
