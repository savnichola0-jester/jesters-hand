import React from 'react';
import { Image } from 'react-native';

export default function SuitsTile({ size }: { size: number }) {
  return (
    <Image
      source={require('../../assets/images/icon_suits.png')}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityLabel="SUITS"
    />
  );
}