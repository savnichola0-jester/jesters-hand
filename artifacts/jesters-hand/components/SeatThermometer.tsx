import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { SeatTemperature } from '@/lib/activityService';

export function SeatThermometer({ score, temperature, compact = false }: {
  score?: number | null; temperature: SeatTemperature; compact?: boolean;
}) {
  const hasScore = typeof score === 'number';
  const fillPosition = hasScore
    ? Math.max(0, Math.min(100, Math.round(score)))
    : temperature === 'Hot' ? 100 : temperature === 'Warm' ? 60 : temperature === 'Lukewarm' ? 30 : 0;
  const color = temperature === 'Hot' ? '#FF6B6B' : temperature === 'Warm' ? '#FFA06B'
    : temperature === 'Lukewarm' ? '#D4A853' : 'rgba(237,224,196,0.35)';
  return (
    <View accessible accessibilityRole="progressbar"
      accessibilityLabel={hasScore
        ? `Seat temperature ${temperature}, activity score ${fillPosition} out of 100`
        : `Seat temperature ${temperature}`}
      accessibilityValue={hasScore ? { min: 0, max: 100, now: fillPosition } : undefined}
      style={[s.wrap, compact && s.compact]}>
      {!compact && <View style={s.labels}><Text style={s.label}>COLD</Text><Text style={s.label}>LUKEWARM</Text><Text style={s.label}>WARM</Text><Text style={s.label}>HOT</Text></View>}
      <View style={s.track}><View style={[s.fill, { width: `${fillPosition}%`, backgroundColor: color }]} /></View>
      {!compact && hasScore && <Text style={[s.score, { color }]}>{fillPosition}/100</Text>}
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { width: 150, gap: 5 }, compact: { width: 54 },
  labels: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: 'rgba(237,224,196,0.52)', fontSize: 6.5, letterSpacing: .25 },
  track: { height: 7, borderRadius: 4, overflow: 'hidden', backgroundColor: 'rgba(237,224,196,0.15)' },
  fill: { height: '100%', borderRadius: 4 }, score: { fontSize: 9, letterSpacing: 1, textAlign: 'right' },
});