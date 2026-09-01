import React from 'react';
import { View, Text, Image, StyleSheet } from 'react-native';
import { Feather } from '@/components/FIcon';

const GOLD = '#D4A853';

interface GroupAvatarCollageProps {
  memberUids: string[];
  avatarCache: Record<string, string>;
  memberCache: Record<string, string>;
  /** Overall square size of the collage. Defaults to 46 (conversation-list size). */
  size?: number;
}

type CollageLayout = { top: number; left: number; size: number }[];

// Layouts defined against the reference 46px box; scaled at render time.
const COLLAGE_LAYOUTS: Record<1 | 2 | 3, CollageLayout> = {
  1: [{ top: 9, left: 9, size: 28 }],
  2: [
    { top: 0,  left: 0,  size: 28 },
    { top: 18, left: 18, size: 28 },
  ],
  3: [
    { top: 0,  left: 0,  size: 24 },
    { top: 0,  left: 22, size: 24 },
    { top: 22, left: 11, size: 24 },
  ],
};

const REF_SIZE = 46;

export default function GroupAvatarCollage({
  memberUids, avatarCache, memberCache, size = REF_SIZE,
}: GroupAvatarCollageProps) {
  const slots = memberUids.slice(0, 3);
  const scale = size / REF_SIZE;

  if (slots.length === 0) {
    return (
      <View style={[s.fallback, { width: size, height: size, borderRadius: size / 2 }]}>
        <Feather name="users" size={Math.round(16 * scale)} color={GOLD} />
      </View>
    );
  }

  const key = (Math.min(slots.length, 3) as 1 | 2 | 3);
  const positions = COLLAGE_LAYOUTS[key];

  return (
    <View style={{ width: size, height: size }}>
      {slots.map((uid, i) => {
        const pos = positions[i];
        const cell = Math.round(pos.size * scale);
        const photoUrl = avatarCache[uid];
        const label = (memberCache[uid] ?? uid).slice(0, 2).toUpperCase();
        return (
          <View
            key={uid}
            style={[s.collageCell, {
              top: Math.round(pos.top * scale),
              left: Math.round(pos.left * scale),
              width: cell,
              height: cell,
              borderRadius: cell / 2,
            }]}
          >
            {photoUrl ? (
              <Image
                source={{ uri: photoUrl }}
                style={{ width: cell, height: cell, borderRadius: cell / 2 }}
              />
            ) : (
              <Text style={[s.collageCellText, { fontSize: Math.max(6, Math.round(cell * 0.3)) }]}>
                {label}
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  fallback: {
    backgroundColor: 'rgba(80,40,0,0.4)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  collageCell: {
    position: 'absolute',
    backgroundColor: 'rgba(200,165,60,0.18)',
    borderWidth: 1.5,
    borderColor: '#0D0B08',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  collageCellText: {
    color: GOLD,
    fontFamily: 'Cinzel_700Bold',
  },
});
