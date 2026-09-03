import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  Deal, DealCompletion, DealMemberStats, DealAward,
  listenPublishedDeals, listenOwnCompletion, listenOwnStats, listenOwnDealAwards,
  reconcileDealProgress, DEAL_MILESTONES
} from '@/lib/dealService';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';
import { useLiveDeal } from '@/components/deal/useLiveDeal';
import { InWorldCard, CardPip, CardTitle } from '@/components/InWorldCard';

const { width: SW } = appWindow();
const CREAM = '#EDE0C4';
const GOLD = '#D4A853';

export default function DealMemberView() {
  const { user } = useAuth();
  const [deals, setDeals] = useState<Deal[]>([]);
  const activeDeal = useLiveDeal(deals);
  const [loading, setLoading] = useState(true);
  const [completion, setCompletion] = useState<DealCompletion | null>(null);
  const [stats, setStats] = useState<DealMemberStats | null>(null);
  const [awards, setAwards] = useState<DealAward[]>([]);

  useEffect(() => {
    if (!user) return;
    const off = listenPublishedDeals(ds => {
      setDeals(ds);
      setLoading(false);
    }, () => setLoading(false));
    return off;
  }, [user]);

  useEffect(() => {
    if (!user || !activeDeal) {
      setCompletion(null);
      return;
    }
    reconcileDealProgress(user.uid).catch(() => {});
    const offComp = listenOwnCompletion(activeDeal.id, user.uid, setCompletion);
    const offStats = listenOwnStats(user.uid, setStats);
    const offAwards = listenOwnDealAwards(user.uid, setAwards);
    return () => { offComp(); offStats(); offAwards(); };
  }, [user, activeDeal]);

  if (loading) {
    return (
      <View style={s.center}>
        <ActivityIndicator size="large" color={GOLD} />
      </View>
    );
  }

  if (!activeDeal) {
    return (
      <View style={s.center}>
        <Feather name="moon" size={32} color="rgba(212,168,83,0.3)" />
        <Text style={s.emptyText}>The table is clear.</Text>
        <Text style={s.emptySub}>No active deal at this moment.</Text>
      </View>
    );
  }

  const streak = stats?.currentStreak ?? 0;
  // assigneeUid-less cards are legacy Deals published before targeted cards.
  const assignedTasks = activeDeal.tasks.filter(task => !task.assigneeUid || task.assigneeUid === user?.uid);
  const taskCount = assignedTasks.length;
  const completedTaskCount = completion?.completedTaskIds.length ?? 0;
  const progress = taskCount > 0 ? completedTaskCount / taskCount : 0;
  const isComplete = taskCount > 0 && completedTaskCount === taskCount;

  return (
    <ScrollView style={s.root} contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>

      <View style={s.header}>
        <Text style={s.title}>{activeDeal.title}</Text>
        <View style={s.progressRow}>
          <View style={s.progressBarWrap}>
            <View style={[s.progressBarFill, { width: `${progress * 100}%` }]} />
          </View>
          <Text style={s.progressText}>{Math.round(progress * 100)}%</Text>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.cardSpread} style={s.cardScroller}>
        {assignedTasks.map(task => {
          const current = completion?.taskCounts[task.id] ?? 0;
          const done = current >= task.targetCount;
          return (
            <InWorldCard key={task.id} style={s.card} isDone={done}>
              <View style={s.cardInnerContent}>
                <CardPip style={{ fontSize: 16, minHeight: 24, marginBottom: 8 }}>{task.type.replace(/_/g, ' ').toUpperCase()}</CardPip>
                <CardTitle>{task.label}</CardTitle>
              </View>
              <View style={s.cardFooter}>
                <Text style={s.cardCount}>{current} / {task.targetCount}</Text>
                {done && <Feather name="check" size={16} color={GOLD} />}
              </View>
            </InWorldCard>
          );
        })}
        {assignedTasks.length === 0 && (
          <View style={s.noCard}>
            <Feather name="clock" size={26} color="rgba(212,168,83,0.45)" />
            <Text style={s.emptyText}>No card dealt to your ID.</Text>
            <Text style={s.emptySub}>The Jester has not assigned you a task in this Deal.</Text>
          </View>
        )}
      </ScrollView>

      {isComplete && (
        <View style={s.completeBox}>
          <Text style={s.completeTitle}>DEAL COMPLETE</Text>
          <Text style={s.completeText}>You have fulfilled the Jester's conditions.</Text>
        </View>
      )}

      <View style={s.statsBox}>
        <Text style={s.statsTitle}>YOUR STANDING</Text>
        <View style={s.statsRow}>
          <View style={s.statItem}>
            <Text style={s.statValue}>{streak}</Text>
            <Text style={s.statLabel}>STREAK</Text>
          </View>
          <View style={s.statItem}>
            <Text style={s.statValue}>{stats?.bestStreak ?? 0}</Text>
            <Text style={s.statLabel}>BEST</Text>
          </View>
        </View>
      </View>

      <View style={s.awardsSection}>
        <Text style={s.statsTitle}>MILESTONES</Text>
        <View style={s.badgesRow}>
          {DEAL_MILESTONES.map(m => {
            const hasMilestone = streak >= m;
            return (
              <View key={m} style={[s.badge, hasMilestone && s.badgeActive]}>
                <Text style={[s.badgeText, hasMilestone && s.badgeTextActive]}>{m}</Text>
              </View>
            );
          })}
        </View>

        {awards.length > 0 && (
          <View style={s.messagesBox}>
            {awards.map(aw => (
              <View key={aw.id} style={s.messageItem}>
                <Text style={s.messageMilestone}>{aw.milestone} STREAK</Text>
                <Text style={s.messageText}>"{aw.message}"</Text>
              </View>
            ))}
          </View>
        )}
      </View>

    </ScrollView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, paddingBottom: 100 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 60 },
  emptyText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 18, letterSpacing: 2 },
  emptySub: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_400Regular', fontSize: 13 },

  header: { marginBottom: 24, alignItems: 'center' },
  title: { ...MARBLE_TEXT_SHADOW, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 20, textAlign: 'center', marginBottom: 12, letterSpacing: 1 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 12, width: '80%' },
  progressBarWrap: { flex: 1, height: 6, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 3, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)' },
  progressBarFill: { height: '100%', backgroundColor: GOLD, borderRadius: 2 },
  progressText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 12 },

  cardScroller: { flexGrow: 0, marginBottom: 32, marginHorizontal: -16 },
  cardSpread: { paddingHorizontal: 16, gap: 16 },
  card: { width: SW * 0.65, height: SW * 0.9 },
  cardInnerContent: { flex: 1, justifyContent: 'center', gap: 12 },
  cardFooter: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 'auto' },
  cardCount: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 16 },
  noCard: { width: SW - 32, minHeight: 180, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 24 },

  completeBox: { backgroundColor: 'rgba(212,168,83,0.1)', borderWidth: 1, borderColor: GOLD, borderRadius: 8, padding: 16, alignItems: 'center', marginBottom: 24 },
  completeTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 2, marginBottom: 4 },
  completeText: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12 },

  statsBox: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 10, padding: 16, borderWidth: 1, borderColor: 'rgba(237,224,196,0.15)', marginBottom: 24 },
  statsTitle: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2, marginBottom: 16, textAlign: 'center' },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  statItem: { alignItems: 'center' },
  statValue: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 24, marginBottom: 4 },
  statLabel: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },

  awardsSection: { marginBottom: 24 },
  badgesRow: { flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 24 },
  badge: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#050505', borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)', alignItems: 'center', justifyContent: 'center' },
  badgeActive: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  badgeText: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_700Bold', fontSize: 14 },
  badgeTextActive: { color: GOLD },

  messagesBox: { backgroundColor: '#050505', borderRadius: 8, padding: 16, borderWidth: 1, borderColor: 'rgba(212,168,83,0.2)' },
  messageItem: { marginBottom: 12 },
  messageMilestone: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1, marginBottom: 4 },
  messageText: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13, fontStyle: 'italic', lineHeight: 20 },
});
