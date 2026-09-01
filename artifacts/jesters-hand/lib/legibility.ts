// ── Marble legibility helpers ────────────────────────────────────────────────
// The cream/gold lettering and outline buttons sit directly on the busy marble
// background on many screens. These shared style fragments add a dark drop
// shadow behind text and a translucent dark backing behind outline buttons so
// everything stays readable. Spread them into existing StyleSheet entries:
//   title: { ...MARBLE_TEXT_SHADOW, color: CREAM, ... }
//   btn:   { ...MARBLE_BTN_BACKING, borderColor: GOLD, ... }

import type { TextStyle, ViewStyle } from 'react-native';

/** Dark shadow behind light text rendered directly on the marble. */
export const MARBLE_TEXT_SHADOW: TextStyle = {
  textShadowColor: 'rgba(0,0,0,0.85)',
  textShadowOffset: { width: 1, height: 1 },
  textShadowRadius: 5,
};

/** Translucent dark backing + shadow for outline buttons on the marble. */
export const MARBLE_BTN_BACKING: ViewStyle = {
  backgroundColor: 'rgba(0,0,0,0.45)',
  shadowColor: '#000',
  shadowOpacity: 0.6,
  shadowRadius: 6,
  shadowOffset: { width: 0, height: 2 },
  elevation: 4,
};
