import React from 'react';
import { Image, StyleSheet, View } from 'react-native';

const EMBLEM = require('../assets/images/check_in_thread_logo.png');

/** A small debossed maker's mark at the bottom right of a member Ticket. */
export default function TicketBrandImprint() {
  return (
    <View style={s.recess} pointerEvents="none" accessibilityLabel="54 At Command emblem">
      <Image source={EMBLEM} style={[s.art, s.edge]} resizeMode="contain" />
      <Image source={EMBLEM} style={[s.art, s.face]} resizeMode="contain" />
    </View>
  );
}

const s = StyleSheet.create({
  recess: {
    width: 96, height: 114, alignSelf: 'flex-end', marginTop: 20,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(29, 13, 10, 0.38)',
    borderRadius: 12,
    borderTopWidth: 2, borderLeftWidth: 2,
    borderTopColor: 'rgba(0, 0, 0, 0.8)',
    borderLeftColor: 'rgba(0, 0, 0, 0.8)',
    borderRightWidth: 1, borderBottomWidth: 1,
    borderRightColor: 'rgba(197, 130, 67, 0.22)',
    borderBottomColor: 'rgba(221, 166, 98, 0.28)',
    overflow: 'hidden',
  },
  art: { position: 'absolute', width: 88, height: 106 },
  edge: {
    tintColor: '#C58E5D', opacity: 0.2,
    transform: [{ translateX: -1 }, { translateY: -1 }],
  },
  face: { opacity: 0.8, transform: [{ translateX: 1 }, { translateY: 1 }] },
});