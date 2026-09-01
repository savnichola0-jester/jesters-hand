import React from 'react';
import { View, Image, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useWhisper } from '@/contexts/WhisperContext';

const NAV_WHISPER = require('../assets/images/nav_whisper.png');

interface Props {
  size?: number;
}

export default function WhisperNavIcon({ size = 34 }: Props) {
  const { totalUnread } = useWhisper();
  const displayCount = totalUnread > 99 ? '99+' : totalUnread > 0 ? String(totalUnread) : null;

  return (
    <TouchableOpacity
      activeOpacity={0.75}
      onPress={() => router.push('/(tabs)/whisper')}
      style={{ position: 'relative' }}
    >
      <Image source={NAV_WHISPER} style={{ width: size, height: size }} resizeMode="contain" />
      {displayCount ? (
        <View style={s.badge}>
          <Text style={s.badgeText}>{displayCount}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  badge: {
    position: 'absolute', top: -2, right: -4,
    minWidth: 16, height: 16, borderRadius: 8,
    backgroundColor: '#E53E3E',
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 3,
    borderWidth: 1.5, borderColor: '#000',
  },
  badgeText: {
    color: '#fff', fontSize: 9, fontWeight: '700', lineHeight: 12,
  },
});
