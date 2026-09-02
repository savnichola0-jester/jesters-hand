import React from 'react';
import { View, ImageBackground, StyleSheet, StyleProp, ViewStyle, TextStyle, Text, TextInput, TextInputProps } from 'react-native';

const CARD_BG = require('@/assets/images/in_world_card.png');
const GOLD = '#D4A853';
const CREAM = '#EDE0C4';

export function InWorldCard({ style, children, isDone }: { style?: StyleProp<ViewStyle>, children?: React.ReactNode, isDone?: boolean }) {
  return (
    <View style={[s.card, isDone && s.cardDone, style]}>
      <ImageBackground source={CARD_BG} style={s.cardBack} imageStyle={s.cardBackImage} resizeMode="cover">
        <View style={s.cardInner}>
          {children}
        </View>
      </ImageBackground>
    </View>
  );
}

export function CardPip({ children, style }: { children: React.ReactNode, style?: StyleProp<TextStyle> }) {
  return <Text style={[s.pip, style]}>{children}</Text>;
}

export function CardTitle({ children, style }: { children: React.ReactNode, style?: StyleProp<TextStyle> }) {
  return <Text style={[s.title, style]}>{children}</Text>;
}

export function CardSub({ children, style }: { children: React.ReactNode, style?: StyleProp<TextStyle> }) {
  return <Text style={[s.sub, style]}>{children}</Text>;
}

export function CardInput(props: TextInputProps) {
  return (
    <TextInput
      {...props}
      style={[s.input, props.style]}
      placeholderTextColor="rgba(237,224,196,0.4)"
    />
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#050505',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.3)',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.8,
    shadowRadius: 10,
    shadowOffset: { width: 4, height: 4 },
    elevation: 8,
  },
  cardDone: { borderColor: GOLD, borderWidth: 1.5 },
  cardBack: { flex: 1 },
  cardBackImage: { borderRadius: 11 },
  cardInner: {
    flex: 1,
    padding: 16,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  pip: {
    fontSize: 42,
    color: GOLD,
    textAlign: 'center',
    minHeight: 50,
    fontFamily: 'Cinzel_700Bold',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: {width: 1, height: 1},
    textShadowRadius: 3
  },
  title: {
    color: CREAM,
    fontFamily: 'Cinzel_700Bold',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowOffset: {width: 1, height: 1},
    textShadowRadius: 3
  },
  sub: {
    color: 'rgba(237,224,196,0.6)',
    fontFamily: 'Cinzel_600SemiBold',
    fontSize: 11,
    textAlign: 'center',
    letterSpacing: 1
  },
  input: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.4)',
    borderRadius: 8,
    color: CREAM,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: 'Cinzel_600SemiBold',
    fontSize: 12,
    marginBottom: 10,
    textAlign: 'center'
  },
});
