// Card-suit icons rendered as local SVG paths (no icon fonts — see
// .agents/memory/expo-go-icon-fonts.md for why fonts are banned here).
import React from 'react';
import Svg, { Path } from 'react-native-svg';
import type { Suit } from '@/lib/targetTicketService';

const PATHS: Record<Suit, string> = {
  // 24x24 viewbox, filled shapes
  spade:
    'M12 2C9 7 4 9.5 4 13.5C4 16 6 17.5 8.2 17.5C9.3 17.5 10.3 17 11 16.2C10.8 18 10 19.5 8.5 21H15.5C14 19.5 13.2 18 13 16.2C13.7 17 14.7 17.5 15.8 17.5C18 17.5 20 16 20 13.5C20 9.5 15 7 12 2Z',
  diamond:
    'M12 2L19 12L12 22L5 12L12 2Z',
  heart:
    'M12 21C12 21 3 14.5 3 8.8C3 5.6 5.4 3.5 7.9 3.5C9.6 3.5 11.1 4.4 12 5.9C12.9 4.4 14.4 3.5 16.1 3.5C18.6 3.5 21 5.6 21 8.8C21 14.5 12 21 12 21Z',
  club:
    'M12 2C10 2 8.4 3.6 8.4 5.6C8.4 6.5 8.8 7.4 9.4 8C7 7.7 4.8 9.4 4.8 11.9C4.8 14 6.5 15.7 8.6 15.7C9.6 15.7 10.5 15.3 11.2 14.6C11 16.7 10.2 18.9 8.5 21H15.5C13.8 18.9 13 16.7 12.8 14.6C13.5 15.3 14.4 15.7 15.4 15.7C17.5 15.7 19.2 14 19.2 11.9C19.2 9.4 17 7.7 14.6 8C15.2 7.4 15.6 6.5 15.6 5.6C15.6 3.6 14 2 12 2Z',
};

export function SuitIcon({ suit, size = 20, color = '#D4A853' }: {
  suit: Suit;
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={PATHS[suit]} fill={color} />
    </Svg>
  );
}
