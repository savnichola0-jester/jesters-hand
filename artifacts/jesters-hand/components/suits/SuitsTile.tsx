import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

/** A separate mark from the Deal's three-card art: four short, single-pip cards. */
export default function SuitsTile({ size }: { size: number }) {
  const card = Math.round(size * 0.42);
  return (
    <View style={[s.tile, { width: size, height: size }]}>
      <Text style={s.title}>SUITS</Text>
      <View style={s.spread}>
        {['♠', '♦', '♥', '♣'].map((pip, index) => (
          <View key={pip} style={[s.card, { width: card, height: Math.round(card * 1.28), transform: [{ rotate: `${(index - 1.5) * 7}deg` }] }]}>
            <Text style={s.pip}>{pip}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
const s = StyleSheet.create({
  tile: { backgroundColor: '#030303', borderWidth: 2, borderColor: '#D4A853', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  title: { position: 'absolute', top: 13, color: '#D4A853', fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 3 },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: 18 },
  card: { backgroundColor: '#080808', borderWidth: 1, borderColor: '#D4A853', borderRadius: 4, marginHorizontal: -10, alignItems: 'center', justifyContent: 'center' },
  pip: { color: '#D4A853', fontSize: 27, fontFamily: 'serif' },
});