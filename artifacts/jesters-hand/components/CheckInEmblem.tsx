import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

const FRAME = require('../assets/images/check_ins_frame.png');
const EMBLEM = require('../assets/images/check_in_thread_logo.png');

/** The private Check-In thread's avatar, using the existing stone frame. */
export default function CheckInEmblem({ size = 54 }: { size?: number }) {
  return (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessibilityLabel="54 At Command Check-In"
    >
      <Image source={FRAME} style={StyleSheet.absoluteFill} resizeMode="contain" />
      <Image
        source={EMBLEM}
        style={{ width: size * 0.88, height: size * 0.88 }}
        resizeMode="contain"
      />
    </View>
  );
}