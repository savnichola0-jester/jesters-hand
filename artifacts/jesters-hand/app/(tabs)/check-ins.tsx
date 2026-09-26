import React, { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import {
  CheckInMember, CheckInState, chooseCheckInReward, getCheckInMembers,
  getCheckInRoster, getMyCheckIns, redeemCheckInCode,
} from '@/lib/checkInsService';

const GOLD = '#D4A853';
const CREAM = '#EDE0C4';
const DIM = '#a89a80';
const FONT = 'Cinzel_700Bold';

export default function CheckInsScreen() {
  const { user, isHandAdmin, jokerId } = useAuth();
  const isDealer = isHandAdmin && (jokerId === '00-00' || jokerId === '01-54');
  const inset = useSafeAreaInsets();
  const [mine, setMine] = useState<CheckInState | null>(null);
  const [members, setMembers] = useState<CheckInMember[]>([]);
  const [rosterLoaded, setRosterLoaded] = useState(false);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [rewardType, setRewardType] = useState<'royal' | 'merch'>('royal');
  const [rewardDescription, setRewardDescription] = useState('');
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!user) return;
    const [own, roster] = await Promise.allSettled([
      getMyCheckIns(),
      isDealer ? getCheckInMembers() : getCheckInRoster(),
    ]);
    if (own.status === 'fulfilled') setMine(own.value.state);
    if (roster.status === 'fulfilled') {
      setMembers(roster.value.members.sort((a, b) => a.jokerId.localeCompare(b.jokerId)));
      setRosterLoaded(true);
    } else {
      setMembers([]);
      setRosterLoaded(false);
    }
    const failure = own.status === 'rejected' ? own.reason : roster.status === 'rejected' ? roster.reason : null;
    setError(failure ? (failure instanceof Error ? failure.message : 'Check-Ins could not load.') : '');
    setLoading(false);
  }, [user?.uid, isDealer]);

  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const act = async (action: () => Promise<string>) => {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      setNotice(await action());
      await refresh();
    } catch (e: any) {
      setError(e?.message ?? 'Could not finish that action. Try again.');
    } finally {
      setWorking(false);
    }
  };

  const openPocket = () => {
    if (!user) return;
    router.push({ pathname: '/(tabs)/chat', params: { conversationId: `checkins_${user.uid}` } } as any);
  };
  const openBook = () => router.push({ pathname: '/(tabs)/street-art', params: { tab: 'checkins' } } as any);
  const submitCode = () => void act(async () => {
    const result = await redeemCheckInCode(code.trim());
    setMine(result.state);
    setCode('');
    return result.state.streak % 7 === 0
      ? `${result.state.streak} consecutive days. The Jester will choose your reward.`
      : 'Check-in recorded. Your Black Book has been updated.';
  });
  const award = (milestoneId: string) => void act(async () => {
    if (!selectedUid) throw new Error('Choose a Joker first.');
    if (!rewardDescription.trim()) throw new Error('Describe the Royal or free merch you chose.');
    await chooseCheckInReward(selectedUid, milestoneId, rewardType, rewardDescription.trim());
    setRewardDescription('');
    return 'Your choice has been recorded in the Joker’s Black Book. Arrange delivery yourself.';
  });

  return (
    <View style={styles.root}>
      <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[styles.nav, { paddingTop: (Platform.OS === 'web' ? 50 : inset.top) + 8 }]}>
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Back"><Text style={styles.back}>‹</Text></TouchableOpacity>
        <Text style={styles.navTitle}>CHECK-INS</Text>
        <TouchableOpacity onPress={openBook} accessibilityLabel="Open Black Book Check-Ins"><Text style={styles.bookLink}>BOOK ›</Text></TouchableOpacity>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: inset.bottom + 65 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.introTitle}>THE DAILY MARK</Text>
        <Text style={styles.intro}>Every Joker, including both Hand seats, checks in. See who has marked today below.</Text>

        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {loading ? <ActivityIndicator color={GOLD} style={{ marginTop: 30 }} /> : (
          <>
            <View style={styles.panel}>
              <Text style={styles.heading}>YOUR CHECK-IN · {mine?.dateKey ?? '—'}</Text>
              <Text style={styles.status}>{mine?.checkedInToday ? 'YOUR MARK IS IN' : mine?.issuedToday ? 'YOUR CODE IS WAITING IN POCKET' : 'AWAITING TODAY’S CODE'}</Text>
              <View style={styles.stats}>
                <View><Text style={styles.statNumber}>{mine?.streak ?? 0}</Text><Text style={styles.statLabel}>DAY STREAK</Text></View>
                <View><Text style={styles.statNumber}>{mine?.bestStreak ?? 0}</Text><Text style={styles.statLabel}>BEST</Text></View>
                <View><Text style={styles.statNumber}>{mine?.total ?? 0}</Text><Text style={styles.statLabel}>TOTAL MARKS</Text></View>
              </View>
              <Text style={styles.copy}>Your private daily code appears in your Check-Ins Pocket when it is issued. Enter it here before the Denver day ends. Missing a day resets your streak.</Text>
              {mine?.issuedToday && !mine.checkedInToday ? (
                <>
                  <TouchableOpacity style={styles.button} onPress={openPocket}><Text style={styles.buttonText}>OPEN MY CHECK-INS POCKET ›</Text></TouchableOpacity>
                  <TextInput value={code} onChangeText={setCode} style={styles.input} placeholder="Paste your private code" placeholderTextColor={DIM} autoCapitalize="none" autoCorrect={false} maxLength={64} accessibilityLabel="Private daily check-in code" />
                  <TouchableOpacity style={styles.button} disabled={working || !code.trim()} onPress={submitCode}>
                    {working ? <ActivityIndicator color={GOLD} /> : <Text style={styles.buttonText}>MARK TODAY'S CHECK-IN</Text>}
                  </TouchableOpacity>
                </>
              ) : null}
            </View>
            {mine?.milestones?.length ? (
              <View style={styles.panel}>
                <Text style={styles.heading}>JESTER'S CHOICE</Text>
                {mine.milestones.slice().reverse().map(m => (
                  <Text key={m.milestoneId} style={styles.reward}>{m.streak} DAYS · {m.rewardType ? `${m.rewardType.toUpperCase()} — ${m.description ?? ''}` : "AWAITING THE JESTER'S CHOICE"}</Text>
                ))}
              </View>
            ) : null}
            <TouchableOpacity style={styles.button} onPress={openBook}><Text style={styles.buttonText}>SEE MY BLACK BOOK CHECK-INS ›</Text></TouchableOpacity>
            {rosterLoaded ? <Text style={styles.heading}>TODAY'S JOKERS · {members.length}</Text> : null}
            {rosterLoaded ? members.map(member => (
              <View key={member.uid} style={styles.memberCard}>
                <TouchableOpacity disabled={!isDealer} onPress={() => setSelectedUid(selectedUid === member.uid ? null : member.uid)} style={styles.memberHead}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberName}>{member.jokerId}{member.uid === user?.uid ? ' · YOU' : ''}</Text>
                    <Text style={styles.helper}>{member.checkedInToday ? 'CHECKED IN TODAY' : member.issuedToday ? 'NOT CHECKED IN YET' : 'NOT CHECKED IN · CODE NOT ISSUED'} · {member.streak} DAY STREAK</Text>
                  </View>
                  {isDealer ? <Text style={styles.chevron}>{selectedUid === member.uid ? '−' : '+'}</Text> : null}
                </TouchableOpacity>
                {isDealer && selectedUid === member.uid ? (
                  <View style={styles.memberDetails}>
                    {member.pendingMilestones?.length ? member.pendingMilestones.map(milestone => (
                      <View key={milestone.milestoneId} style={styles.awardBox}>
                        <Text style={styles.heading}>{milestone.streak} DAY MILESTONE · JESTER'S CHOICE</Text>
                        <View style={styles.choiceRow}>
                          {(['royal', 'merch'] as const).map(kind => (
                            <TouchableOpacity key={kind} onPress={() => setRewardType(kind)} style={[styles.choice, rewardType === kind && styles.choiceActive]}>
                              <Text style={styles.buttonText}>{kind === 'royal' ? 'ROYAL' : 'FREE MERCH'}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                        <TextInput style={styles.input} placeholder={rewardType === 'royal' ? 'Which Royal will you give?' : 'Which merch will you arrange?'} placeholderTextColor={DIM} value={rewardDescription} onChangeText={setRewardDescription} maxLength={280} multiline />
                        <TouchableOpacity style={styles.button} disabled={working || !rewardDescription.trim()} onPress={() => award(milestone.milestoneId)}>
                          <Text style={styles.buttonText}>RECORD MY CHOICE</Text>
                        </TouchableOpacity>
                      </View>
                    )) : <Text style={styles.helper}>No reward decision pending.</Text>}
                    <TouchableOpacity onPress={() => router.push({ pathname: '/(tabs)/street-art', params: { uid: member.uid, label: member.jokerId, tab: 'checkins' } } as any)}>
                      <Text style={styles.link}>VIEW THEIR BLACK BOOK ›</Text>
                    </TouchableOpacity>
                  </View>
                ) : null}
              </View>
            )) : null}
            <TouchableOpacity onPress={() => void refresh()}><Text style={styles.link}>REFRESH CHECK-INS</Text></TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050403' },
  nav: { backgroundColor: '#000', paddingHorizontal: 16, paddingBottom: 11, flexDirection: 'row', alignItems: 'center' },
  back: { color: GOLD, fontSize: 34, lineHeight: 32 },
  navTitle: { flex: 1, color: CREAM, textAlign: 'center', fontSize: 16, letterSpacing: 2, fontFamily: FONT },
  bookLink: { color: GOLD, fontSize: 11, fontFamily: FONT },
  content: { padding: 16, gap: 14 },
  introTitle: { color: GOLD, fontSize: 19, fontFamily: FONT, letterSpacing: 2, marginTop: 8 },
  intro: { color: CREAM, fontSize: 13, lineHeight: 20, marginBottom: 5 },
  panel: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.52)', backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, gap: 13 },
  heading: { color: GOLD, fontSize: 12, fontFamily: FONT, letterSpacing: 1.2 },
  copy: { color: CREAM, fontSize: 12, lineHeight: 19 },
  status: { color: CREAM, fontSize: 12, fontFamily: FONT, textAlign: 'center', letterSpacing: 1 },
  stats: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 12, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(212,168,83,0.3)' },
  statNumber: { color: GOLD, fontSize: 26, fontFamily: FONT, textAlign: 'center' },
  statLabel: { color: DIM, fontSize: 9, textAlign: 'center', letterSpacing: 0.7 },
  button: { borderWidth: 1, borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.11)', paddingVertical: 13, paddingHorizontal: 9, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  buttonText: { color: GOLD, fontSize: 10, letterSpacing: 0.7, fontFamily: FONT, textAlign: 'center' },
  helper: { color: DIM, fontSize: 10, lineHeight: 16 },
  input: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.48)', color: CREAM, padding: 12, fontSize: 14, minHeight: 44, backgroundColor: 'rgba(0,0,0,0.7)' },
  link: { color: GOLD, textAlign: 'center', padding: 10, fontSize: 11, fontFamily: FONT },
  reward: { color: CREAM, lineHeight: 20, fontSize: 12 },
  memberCard: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', backgroundColor: 'rgba(0,0,0,0.62)' },
  memberHead: { flexDirection: 'row', alignItems: 'center', padding: 13, minHeight: 58 },
  memberName: { color: CREAM, fontFamily: FONT, fontSize: 14, marginBottom: 3 },
  chevron: { color: GOLD, fontSize: 24, marginLeft: 12 },
  memberDetails: { padding: 14, gap: 12, borderTopWidth: 1, borderColor: 'rgba(212,168,83,0.25)' },
  awardBox: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', padding: 12, gap: 11 },
  choiceRow: { flexDirection: 'row', gap: 8 },
  choice: { flex: 1, paddingVertical: 11, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)' },
  choiceActive: { backgroundColor: 'rgba(212,168,83,0.2)', borderColor: GOLD },
  error: { color: '#ffab92', textAlign: 'center', lineHeight: 20, padding: 10 },
  notice: { color: GOLD, textAlign: 'center', lineHeight: 20, padding: 10 },
});