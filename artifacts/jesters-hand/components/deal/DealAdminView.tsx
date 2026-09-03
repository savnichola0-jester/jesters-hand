import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, TextInput, Modal } from 'react-native';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  Deal, DealInput, DealTaskType, DealDuration, DealMemberStats, DealCompletion,
  listenDeals, listenAllDealStats, listenAllDealCompletions,
  createDeal, publishDeal, archiveDeal, awardDealMilestone, DEAL_MILESTONES,
} from '@/lib/dealService';
import { getAllMembers, TicketData } from '@/lib/ticketService';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { useLiveDeal } from '@/components/deal/useLiveDeal';
import { InWorldCard, CardPip, CardInput } from '@/components/InWorldCard';
import { appWindow } from '@/lib/appWindow';
import DealMemberView from '@/components/deal/DealMemberView';
import { fetchSeatActivitySummary, SeatActivitySummary } from '@/lib/activityService';

const { width: SW } = appWindow();

const CREAM = '#EDE0C4';
const GOLD = '#D4A853';
const TASK_TYPES: DealTaskType[] = ['ticket', 'the_hand', 'street_art', 'jesters_deal', 'suits', 'ante', 'jesters_table', 'target_ticket', 'vault', 'chamber', 'recruit', 'uniform', 'system', 'website', 'facebook', 'instagram', 'x', 'tiktok', 'twitch', 'suno'];
const TASK_CATALOG = [
  'Ticket', 'The Hand', 'Street Art', "Jester's Deal", 'SUITS', 'Ante',
  "Jester's Table", 'Target Ticket', 'Vault', 'Chamber', 'Recruit', 'Uniform',
  'System', 'Website', 'Facebook', 'Instagram', 'X', 'TikTok', 'Twitch', 'Suno',
];

export default function DealAdminView() {
  const { user, jokerId, isHandAdmin } = useAuth();
  const canInspectMemberStats = isHandAdmin;
  const [tab, setTab] = useState<'management' | 'mine'>('management');
  const hasPersonalTaskTab = jokerId === '01-54';

  const [deals, setDeals] = useState<Deal[]>([]);
  const activeDeal = useLiveDeal(deals);
  const [stats, setStats] = useState<DealMemberStats[]>([]);
  const [completions, setCompletions] = useState<(DealCompletion & {dealId: string})[]>([]);
  const [members, setMembers] = useState<Array<TicketData & { uid: string }>>([]);
  const [seatSummaries, setSeatSummaries] = useState<Record<string, SeatActivitySummary>>({});

  // Generic feedback message state
  const [msg, setMsg] = useState<{ text: string, type: 'error' | 'success' } | null>(null);
  const showMsg = (text: string, type: 'error' | 'success' = 'error') => {
    setMsg({ text, type });
    setTimeout(() => setMsg(null), 4000);
  };

  useEffect(() => {
    const offDeals = listenDeals(setDeals, e => showMsg(String(e)));
    const offStats = canInspectMemberStats ? listenAllDealStats(setStats) : () => {};
    const offComps = canInspectMemberStats ? listenAllDealCompletions(setCompletions) : () => {};
    getAllMembers().then(async loadedMembers => {
      setMembers(loadedMembers);
      const entries = await Promise.all(loadedMembers.map(async member => {
        const summary = await fetchSeatActivitySummary(member.uid);
        return summary ? [member.uid, summary] as const : null;
      }));
      setSeatSummaries(Object.fromEntries(
        entries.filter((entry): entry is readonly [string, SeatActivitySummary] => !!entry),
      ));
    }).catch(e => showMsg(String(e)));
    return () => { offDeals(); offStats(); offComps(); };
  }, [canInspectMemberStats]);

  // Deal Form
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState<DealDuration>('until_next');
  const [tasks, setTasks] = useState<{type: DealTaskType, label: string, targetCount: string, assigneeUid: string}[]>([]);
  const [assigningTask, setAssigningTask] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const eligibleMembers = useMemo(() => {
    const assignmentPool = user && jokerId && !members.some(member => member.uid === user.uid)
      ? [...members, { uid: user.uid, jokerId }]
      : members;
    return assignmentPool.filter(member =>
      !!member.jokerId
      && member.suspended !== true
    );
  }, [jokerId, members, user]);

  const handleCreate = async () => {
    if (!user || submitting) return;
    if (!title.trim()) return showMsg('Need a title');
    if (tasks.length === 0) return showMsg('Need at least one task');
    if (tasks.some(t => !t.label.trim())) return showMsg('All tasks need a label');
    if (tasks.some(t => !t.assigneeUid)) return showMsg('Choose a Joker ID for every task card');

    setSubmitting(true);
    try {
      const input: DealInput = {
        title: title.trim(),
        duration,
        tasks: tasks.map(t => ({
          type: t.type,
          label: t.label,
          targetCount: parseInt(t.targetCount, 10) || 1,
          assigneeUid: t.assigneeUid,
        }))
      };
      await createDeal(user.uid, input);
      setTitle('');
      setTasks([]);
      setTab('management');
      showMsg('Draft created', 'success');
    } catch (e: any) {
      showMsg(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const addTask = () => {
    if (tasks.length >= TASK_CATALOG.length) return;
    setTasks(ts => [...ts, {
      type: TASK_TYPES[ts.length],
      label: TASK_CATALOG[ts.length],
      targetCount: '1',
      assigneeUid: '',
    }]);
  };
  const removeTask = (idx: number) => setTasks(ts => ts.filter((_, i) => i !== idx));

  const handleAction = async (fn: () => Promise<void>, successMsg: string) => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await fn();
      showMsg(successMsg, 'success');
    } catch (e: any) {
      showMsg(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Member Awards
  const [awardUser, setAwardUser] = useState<string | null>(null);
  const [awardMilestone, setAwardMilestone] = useState<3|6|9|12|15>(3);
  const [awardMsg, setAwardMsg] = useState('');

  const grantAward = async () => {
    if (!user || !awardUser || !awardMsg.trim() || submitting) return;
    setSubmitting(true);
    try {
      await awardDealMilestone(awardUser, awardMilestone, awardMsg, user.uid);
      setAwardUser(null);
      setAwardMsg('');
      showMsg('Award granted', 'success');
    } catch (e: any) {
      showMsg(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={s.root}>
      {msg && (
        <View style={[s.msgBanner, msg.type === 'success' ? s.msgSuccess : s.msgError]}>
          <Text style={s.msgText}>{msg.text}</Text>
        </View>
      )}
      {hasPersonalTaskTab ? (
        <View style={s.tabs}>
          <TouchableOpacity style={[s.tab, tab==='management' && s.tabActive]} onPress={()=>setTab('management')}><Text style={[s.tabText, tab==='management' && s.tabTextActive]}>MANAGEMENT</Text></TouchableOpacity>
          <TouchableOpacity style={[s.tab, tab==='mine' && s.tabActive]} onPress={()=>setTab('mine')}><Text style={[s.tabText, tab==='mine' && s.tabTextActive]}>MY TASKS</Text></TouchableOpacity>
        </View>
      ) : null}

      {hasPersonalTaskTab && tab === 'mine' ? <DealMemberView /> : (
      <ScrollView contentContainerStyle={s.content} showsVerticalScrollIndicator={false}>
        <>
            <View style={s.formBox}>
              <Text style={s.sectionTitle}>NEW DRAFT DEAL</Text>
              <TextInput style={s.input} placeholder="Title (e.g. The Quiet Week)" placeholderTextColor="rgba(237,224,196,0.3)" value={title} onChangeText={setTitle} />

              <View style={s.durationRow}>
                {(['24h', '48h', 'until_next'] as const).map(d => (
                  <TouchableOpacity key={d} style={[s.durBtn, duration === d && s.durBtnActive]} onPress={() => setDuration(d)}>
                    <Text style={[s.durText, duration === d && s.durTextActive]}>{d.replace('_', ' ').toUpperCase()}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.cardSpread} style={s.cardScroller}>
                {tasks.map((t, idx) => (
                  <InWorldCard key={idx} style={s.taskCard}>
                    <TouchableOpacity style={s.taskTypeBtn} onPress={() => {
                      const next = TASK_TYPES[(TASK_TYPES.indexOf(t.type) + 1) % TASK_TYPES.length];
                      setTasks(ts => { const n = [...ts]; n[idx].type = next; return n; });
                    }}>
                      <CardPip style={{ fontSize: 16, minHeight: 20 }}>{t.type.replace(/_/g, ' ').toUpperCase()}</CardPip>
                      <Text style={s.tapToChange}>TAP TO CHANGE</Text>
                    </TouchableOpacity>

                    <View style={{ flex: 1, justifyContent: 'center' }}>
                      <CardInput
                        placeholder="Task Label (e.g. Find the mark)"
                        value={t.label}
                        onChangeText={v => setTasks(ts => { const n = [...ts]; n[idx].label = v; return n; })}
                        multiline
                        style={{ minHeight: 60, textAlignVertical: 'center' }}
                      />
                      <CardInput
                        placeholder="Target Count"
                        keyboardType="number-pad"
                        value={t.targetCount}
                        onChangeText={v => setTasks(ts => { const n = [...ts]; n[idx].targetCount = v; return n; })}
                      />
                      <TouchableOpacity style={s.assignBtn} onPress={() => setAssigningTask(idx)}>
                        <Text style={s.assignLabel}>ASSIGNED JOKER ID</Text>
                        <Text style={[s.assignValue, !t.assigneeUid && s.assignPlaceholder]}>
                          {eligibleMembers.find(member => member.uid === t.assigneeUid)?.jokerId ?? 'CHOOSE ID'}
                        </Text>
                        <Text style={s.tapToChange}>TAP TO CHOOSE</Text>
                      </TouchableOpacity>
                    </View>

                    <TouchableOpacity onPress={() => removeTask(idx)} style={s.removeTaskBtn}>
                      <Feather name="trash-2" size={16} color="#FF6B6B" />
                      <Text style={s.removeTaskText}>REMOVE TASK</Text>
                    </TouchableOpacity>
                  </InWorldCard>
                ))}

                {tasks.length < TASK_CATALOG.length && (
                  <TouchableOpacity style={[s.taskCard, s.addCard]} onPress={addTask}>
                    <Feather name="plus" size={32} color="rgba(237,224,196,0.4)" />
                    <Text style={s.addBtnText}>ADD TASK CARD</Text>
                  </TouchableOpacity>
                )}
              </ScrollView>

              <TouchableOpacity style={[s.submitBtn, submitting && { opacity: 0.5 }]} onPress={handleCreate} disabled={submitting}>
                <Text style={s.submitText}>{submitting ? '...' : 'CREATE DRAFT'}</Text>
              </TouchableOpacity>
            </View>

            <View style={s.list}>
              {deals.map(d => (
                <View key={d.id} style={s.dealCard}>
                  <View style={s.dealHead}>
                    <Text style={s.dealTitle}>{d.title}</Text>
                    <View style={s.badge}><Text style={s.badgeText}>{d.status}</Text></View>
                  </View>
                  <Text style={s.dealMeta}>{d.tasks.length} tasks · {d.duration.replace('_', ' ').toUpperCase()}</Text>
                  <View style={s.dealActions}>
                    {d.status === 'draft' && (
                      <TouchableOpacity style={[s.actionBtn, submitting && { opacity: 0.5 }]} disabled={submitting} onPress={() => handleAction(() => publishDeal(d.id), 'Deal published')}><Text style={s.actionText}>PUBLISH</Text></TouchableOpacity>
                    )}
                    {d.status !== 'archived' && (
                      <TouchableOpacity style={[s.actionBtn, { borderColor: '#FF6B6B' }, submitting && { opacity: 0.5 }]} disabled={submitting} onPress={() => handleAction(() => archiveDeal(d.id), 'Deal archived')}><Text style={[s.actionText, { color: '#FF6B6B' }]}>ARCHIVE</Text></TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}
            </View>
          <View style={s.managementSection}>
            <Text style={s.sectionTitle}>TASK MEMBERS</Text>
          <View style={s.list}>
            {awardUser ? (
              <View style={s.formBox}>
                <Text style={s.sectionTitle}>GRANT AWARD: {awardUser}</Text>
                <View style={s.milestonesRow}>
                  {DEAL_MILESTONES.map(m => (
                    <TouchableOpacity key={m} style={[s.msBtn, awardMilestone===m && s.msBtnActive]} onPress={()=>setAwardMilestone(m)}>
                      <Text style={[s.msText, awardMilestone===m && s.msTextActive]}>{m}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <TextInput style={[s.input, { height: 80 }]} multiline placeholder="Jester's Message" placeholderTextColor="rgba(237,224,196,0.3)" value={awardMsg} onChangeText={setAwardMsg} />
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <TouchableOpacity style={[s.submitBtn, { flex: 1, backgroundColor: 'transparent' }]} onPress={()=>setAwardUser(null)}><Text style={s.submitText}>CANCEL</Text></TouchableOpacity>
                  <TouchableOpacity style={[s.submitBtn, { flex: 1 }, submitting && { opacity: 0.5 }]} disabled={submitting} onPress={grantAward}><Text style={s.submitText}>GRANT</Text></TouchableOpacity>
                </View>
              </View>
            ) : (
              members.map(m => {
                const st: DealMemberStats = stats.find(s => s.uid === m.uid) || {
                  uid: m.uid,
                  currentStreak: 0,
                  bestStreak: 0,
                  lastCompletedDealId: null,
                  lastCompletedAt: null,
                  lastActivityAt: null,
                };
                const comp = activeDeal ? completions.find(c => c.dealId === activeDeal.id && c.uid === m.uid) : null;
                const doneCount = comp?.completedTaskIds.length ?? 0;
                const assignedTasks = activeDeal?.tasks.filter(task => !task.assigneeUid || task.assigneeUid === m.uid) ?? [];
                const total = assignedTasks.length;
                const progress = total > 0 ? doneCount / total : 0;
                const temperature = seatSummaries[m.uid]?.temperature ?? null;
                return (
                  <View key={m.uid} style={s.userCard}>
                    <View style={s.userHead}>
                      <Text style={s.userTitle}>{m.jokerId ?? m.uid}</Text>
                      <TouchableOpacity style={s.awardBtn} onPress={() => setAwardUser(m.uid)}><Feather name="award" size={14} color={GOLD} /></TouchableOpacity>
                    </View>
                    <View style={s.userStats}>
                      {canInspectMemberStats && <Text style={s.userStat}>Streak: <Text style={{color:GOLD}}>{st.currentStreak}</Text> (Best: {st.bestStreak})</Text>}
                      {canInspectMemberStats && <Text style={s.userStat}>Active Deal: <Text style={{color:GOLD}}>{doneCount}/{total}</Text></Text>}
                      <Text style={s.userStat}>Seat: <Text style={{color:GOLD}}>{temperature ?? 'Unavailable'}</Text></Text>
                    </View>
                  </View>
                );
              })
            )}
          </View>
          </View>
        </>
      </ScrollView>
      )}

      <Modal visible={assigningTask !== null} transparent animationType="fade" onRequestClose={() => setAssigningTask(null)}>
        <View style={s.modalBackdrop}>
          <View style={s.modalSheet}>
            <Text style={s.modalTitle}>CHOOSE JOKER ID</Text>
            <ScrollView style={s.memberPicker} contentContainerStyle={s.memberPickerContent}>
              {eligibleMembers.map(member => (
                <TouchableOpacity
                  key={member.uid}
                  style={s.memberOption}
                  onPress={() => {
                    if (assigningTask === null) return;
                    setTasks(current => current.map((task, index) =>
                      index === assigningTask ? { ...task, assigneeUid: member.uid } : task
                    ));
                    setAssigningTask(null);
                  }}
                >
                  <Text style={s.memberId}>{member.jokerId}</Text>
                  <Text style={s.memberName}>{member.name || 'No name on file'}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={s.modalClose} onPress={() => setAssigningTask(null)}>
              <Text style={s.modalCloseText}>CANCEL</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1 },
  tabs: { flexDirection: 'row', padding: 16, gap: 12 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: GOLD },
  tabText: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 1 },
  tabTextActive: { color: GOLD },

  content: { padding: 16, paddingBottom: 100 },
  msgBanner: { padding: 12, marginBottom: 12, borderRadius: 8, borderWidth: 1 },
  msgSuccess: { backgroundColor: 'rgba(127, 176, 127, 0.1)', borderColor: '#7FB07F' },
  msgError: { backgroundColor: 'rgba(255, 107, 107, 0.1)', borderColor: '#FF6B6B' },
  msgText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, textAlign: 'center' },

  formBox: { backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 10, padding: 16, borderWidth: 1, borderColor: 'rgba(237,224,196,0.15)', marginBottom: 24 },
  sectionTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2, marginBottom: 16 },

  durationRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  durBtn: { flex: 1, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)', borderRadius: 8 },
  durBtnActive: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  durText: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },
  durTextActive: { color: GOLD },

  input: { backgroundColor: '#111', borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 8, color: CREAM, paddingHorizontal: 12, paddingVertical: 10, fontFamily: 'Cinzel_400Regular', marginBottom: 12 },

  cardScroller: { flexGrow: 0, marginVertical: 16, marginHorizontal: -16 },
  cardSpread: { paddingHorizontal: 16, gap: 16 },
  taskCard: { width: SW * 0.65, height: SW * 0.95 },
  addCard: {
    borderWidth: 1,
    borderColor: 'rgba(237,224,196,0.2)',
    borderStyle: 'dashed',
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12
  },
  taskTypeBtn: {
    backgroundColor: 'rgba(212,168,83,0.15)',
    borderWidth: 1,
    borderColor: GOLD,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
  },
  tapToChange: { color: 'rgba(212,168,83,0.6)', fontSize: 9, fontFamily: 'Cinzel_700Bold', marginTop: 4 },
  assignBtn: { marginTop: 6, padding: 10, borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)', borderRadius: 8, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)' },
  assignLabel: { color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1 },
  assignValue: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 16, marginTop: 3 },
  assignPlaceholder: { color: '#FF9A7A', fontSize: 12 },
  removeTaskBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#FF6B6B',
    borderRadius: 8,
    backgroundColor: 'rgba(255,107,107,0.1)',
  },
  removeTaskText: { color: '#FF6B6B', fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1 },
  addBtnText: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 1 },

  submitBtn: { backgroundColor: 'rgba(212,168,83,0.15)', borderWidth: 1, borderColor: GOLD, borderRadius: 8, alignItems: 'center', paddingVertical: 14 },
  submitText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },

  list: { gap: 12 },
  managementSection: { marginTop: 32 },
  dealCard: { backgroundColor: '#050505', borderWidth: 1, borderColor: 'rgba(212,168,83,0.2)', borderRadius: 8, padding: 16 },
  dealHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  dealTitle: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 16 },
  badge: { backgroundColor: '#111', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)' },
  badgeText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 9, textTransform: 'uppercase' },
  dealMeta: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_400Regular', fontSize: 12, marginBottom: 16 },
  dealActions: { flexDirection: 'row', gap: 12 },
  actionBtn: { flex: 1, paddingVertical: 10, borderWidth: 1, borderColor: GOLD, borderRadius: 6, alignItems: 'center' },
  actionText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },

  userCard: { backgroundColor: '#050505', borderWidth: 1, borderColor: 'rgba(212,168,83,0.2)', borderRadius: 8, padding: 16 },
  userHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  userTitle: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 14 },
  awardBtn: { padding: 8, backgroundColor: 'rgba(212,168,83,0.1)', borderRadius: 20 },
  userStats: { flexDirection: 'row', justifyContent: 'space-between' },
  userStat: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11 },

  milestonesRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
  msBtn: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)', alignItems: 'center', justifyContent: 'center' },
  msBtnActive: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  msText: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_700Bold', fontSize: 12 },
  msTextActive: { color: GOLD },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.82)', justifyContent: 'center', padding: 24 },
  modalSheet: { maxHeight: '78%', backgroundColor: '#090909', borderWidth: 1, borderColor: GOLD, borderRadius: 12, padding: 16 },
  modalTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 2, textAlign: 'center', marginBottom: 12 },
  memberPicker: { flexGrow: 0 },
  memberPickerContent: { gap: 8, paddingBottom: 8 },
  memberOption: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 11, backgroundColor: 'rgba(212,168,83,0.06)' },
  memberId: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1 },
  memberName: { color: 'rgba(237,224,196,0.65)', fontFamily: 'Cinzel_400Regular', fontSize: 12, marginTop: 2 },
  modalClose: { marginTop: 12, borderWidth: 1, borderColor: 'rgba(237,224,196,0.3)', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  modalCloseText: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2 },
});
