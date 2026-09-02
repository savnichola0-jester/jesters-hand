import React from 'react';
import { Image, StyleSheet } from 'react-native';

export default function SuitsTile({ size }: { size: number }) {
  return (
    <Image
      source={require('../../assets/images/icon_suits.png')}
      style={[s.image, { width: size, height: size }]}
      resizeMode="contain"
      accessibilityLabel="SUITS"
    />
  );
}

const s = StyleSheet.create({
  image: { backgroundColor: '#000' },
});