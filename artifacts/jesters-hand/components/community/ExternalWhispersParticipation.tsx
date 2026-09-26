import React, { useState } from 'react';
import {
  Linking, ScrollView, StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Feather } from '@/components/FIcon';
import { InWorldCard, CardPip, CardTitle } from '@/components/InWorldCard';
import { appWindow } from '@/lib/appWindow';

const WHISPERS_URL = 'https://54-ante-up-or-bleed-out-publishing-website.replit.app/whispers';
const { width: SW } = appWindow();
const CREAM = '#EDE0C4';
const GOLD = '#D4A853';

const PROMPTS = [
  { title: 'POST', icon: 'edit-3' as const, prompt: 'Share a thought, story, or piece of writing.' },
  { title: 'COMMENT', icon: 'message-circle' as const, prompt: 'Join the conversation on a community whisper.' },
  { title: 'REACT', icon: 'heart' as const, prompt: 'Leave a reaction on a post that speaks to you.' },
];

export default function ExternalWhispersParticipation({ location = 'deal' }: { location?: 'deal' | 'suits' }) {
  const [openError, setOpenError] = useState<string | null>(null);

  const openWhispers = async () => {
    setOpenError(null);
    try {
      await Linking.openURL(WHISPERS_URL);
    } catch {
      setOpenError('Could not open the publishing community. Please try again.');
    }
  };

  return (
    <View style={s.section}>
      <View style={s.heading}>
        <Feather name="external-link" size={16} color={GOLD} />
        <Text style={s.sectionTitle}>54 ANTE UP OR BLEED OUT PUBLISHING</Text>
      </View>
      <Text style={s.intro}>
        Optional community participation · View-only from {location === 'suits' ? 'SUITS' : 'Jester’s Deal'}
      </Text>
      <View style={s.notice}>
        <Feather name="info" size={16} color={GOLD} />
        <Text style={s.noticeText}>
          This community has its own sign-in. Posts, comments, and reactions there do not yet count toward Deal or SUITS progress, streaks, or awards.
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.cardSpread}
        style={s.cardScroller}
      >
        {PROMPTS.map(item => (
          <InWorldCard key={item.title} style={s.card}>
            <View style={s.cardContent}>
              <Feather name={item.icon} size={24} color={GOLD} />
              <CardPip style={s.pip}>{item.title}</CardPip>
              <CardTitle style={s.prompt}>{item.prompt}</CardTitle>
              <TouchableOpacity
                accessibilityRole="link"
                accessibilityLabel={`Open publishing community to ${item.title.toLowerCase()}`}
                testID={`external-whispers-${item.title.toLowerCase()}-cta`}
                style={s.cta}
                onPress={openWhispers}
              >
                <Text style={s.ctaText}>OPEN WHISPERS</Text>
                <Feather name="arrow-up-right" size={14} color={GOLD} />
              </TouchableOpacity>
            </View>
          </InWorldCard>
        ))}
      </ScrollView>
      {openError && (
        <Text accessibilityRole="alert" style={s.error}>{openError}</Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  section: { marginTop: 24, marginBottom: 24 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  sectionTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 1.2, textAlign: 'center' },
  intro: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_400Regular', fontSize: 11, textAlign: 'center', marginTop: 8 },
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, backgroundColor: 'rgba(212,168,83,0.08)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 8, padding: 12, marginTop: 14 },
  noticeText: { flex: 1, color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 11, lineHeight: 17 },
  cardScroller: { flexGrow: 0, marginTop: 16, marginHorizontal: -16 },
  cardSpread: { paddingHorizontal: 16, gap: 12 },
  card: { width: Math.min(SW * 0.58, 240), height: 236 },
  cardContent: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  pip: { fontSize: 18, minHeight: 24 },
  prompt: { fontSize: 13, lineHeight: 19 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, borderWidth: 1, borderColor: GOLD, borderRadius: 7, paddingVertical: 9, paddingHorizontal: 10, marginTop: 4, backgroundColor: 'rgba(0,0,0,0.45)' },
  ctaText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 1 },
  error: { color: '#FF9A7A', fontFamily: 'Cinzel_600SemiBold', fontSize: 12, textAlign: 'center', marginTop: 10 },
});