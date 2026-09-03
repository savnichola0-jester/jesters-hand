import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { findSuitHolder, getMySuits, SUITS, SUIT_TASK_ACTIONS, SuitHolder, SuitKey, SuitState, SuitTask, getSuitAdmin, setSuitAssignment, setSuitInPlay, stampSuitCompletion } from '@/lib/suitsService';
import { InWorldCard, CardPip, CardTitle, CardSub, CardInput } from '@/components/InWorldCard';

const GOLD = '#D4A853'; const CREAM = '#EDE0C4';
export default function SuitsScreen() {
  const { user, jokerId, isHandAdmin } = useAuth(); const inset = useSafeAreaInsets();
  const [state, setState] = useState<SuitState | null>(null); const [holders, setHolders] = useState<SuitHolder[]>([]);
  const [myState, setMyState] = useState<SuitState | null>(null);
  const [view, setView] = useState<'deal' | 'mine'>('deal');
  const [lookup, setLookup] = useState(''); const [found, setFound] = useState<SuitHolder | null>(null); const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const canDeal = isHandAdmin;
  const isSecondDealer = canDeal && jokerId === '01-54';
  const canAwardRoyals = canDeal;
  const load = useCallback(async () => {
    setLoading(true); setNote('');
    try {
       if (canDeal) {
         const [r, mine] = await Promise.all([
           getSuitAdmin(),
           isSecondDealer ? getMySuits() : Promise.resolve(null),
         ]);
        setHolders(r.holders);
        setState({ pips: [], streaks: {}, notes: {}, inPlay: r.inPlay, completed: {} });
         setMyState(mine?.state ?? null);
      } else {
         const mine = (await getMySuits()).state;
         setState(mine);
         setMyState(mine);
      }
    } catch (e: any) {
      setNote(e?.message ?? 'SUITS is unavailable.');
    } finally {
      setLoading(false);
    }
   }, [canDeal, isSecondDealer]);
  useEffect(() => { if (user) void load(); }, [user?.uid, load]);
  if (!state) return <View style={s.root}><Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} /><View style={s.center}>{loading ? <ActivityIndicator color={GOLD} /> : <><Text style={s.errorTitle}>SUITS COULD NOT OPEN</Text><Text style={s.errorText}>{note}</Text><TouchableOpacity style={s.retry} onPress={() => void load()}><Text style={s.buttonText}>TRY AGAIN</Text></TouchableOpacity><TouchableOpacity onPress={() => router.back()}><Text style={s.errorBack}>BACK TO THE HAND</Text></TouchableOpacity></>}</View></View>;
  const mutate = async (work: () => Promise<void>) => { setNote(''); try { await work(); await load(); } catch (e: any) { setNote(e?.message ?? 'SUITS action failed.'); } };
   const shownState = isSecondDealer && view === 'mine' ? myState : state;
   return <View style={s.root}>
    <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} />
    <View style={[s.nav, { paddingTop: inset.top + 8 }]}><TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹</Text></TouchableOpacity><Text style={s.navTitle}>SUITS</Text></View>
     {isSecondDealer ? <View style={s.tabs}>
       <TouchableOpacity testID="suits-dealing-tab" style={[s.tab, view === 'deal' && s.tabActive]} onPress={() => setView('deal')}><Text style={[s.tabText, view === 'deal' && s.tabTextActive]}>MANAGEMENT / DEALING</Text></TouchableOpacity>
       <TouchableOpacity testID="suits-my-tasks-tab" style={[s.tab, view === 'mine' && s.tabActive]} onPress={() => setView('mine')}><Text style={[s.tabText, view === 'mine' && s.tabTextActive]}>MY TASKS</Text></TouchableOpacity>
     </View> : null}
    <ScrollView contentContainerStyle={s.content}>
       <Text style={s.copy}>{isSecondDealer && view === 'mine' ? 'Your assigned SUITS appear here as a regular recipient.' : 'Pips are dealt by 00-00 or 01-54. Opening a destination never earns a stamp.'}</Text>
      {note ? <Text style={s.note}>{note}</Text> : null}
       {shownState ? <View style={s.cards}>
        {SUITS.map(suit => {
           const held = shownState.pips.includes(suit.key);
           const active = shownState.inPlay[suit.key];
           const streak = shownState.streaks[suit.key] ?? 0;
           const action = SUIT_TASK_ACTIONS.find(item => item.key === active?.destination);
          return (
            <TouchableOpacity
              disabled={!held || !active?.active || !action?.actionable}
              key={suit.key}
              onPress={() => {
                if (active?.destination === 'social') {
                  const text = `#JestersHand ${jokerId ?? ''}`;
                  void Clipboard.setStringAsync(text).then(() => setNote(`Copied: ${text}`)).catch(() => setNote(`Copy this: ${text}`));
                 } else if (action?.route) {
                   router.push(action.route as any);
                }
              }}
              style={[s.cardWrapper, held && s.held]}
            >
              <InWorldCard style={s.card} isDone={held}>
                <CardPip style={{ fontSize: 48, minHeight: 56 }}>{held ? suit.pip : ' '}</CardPip>
                <CardTitle style={{ fontSize: 14 }}>{suit.name}</CardTitle>

                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 12 }}>
                  {held && streak > 0 ? <CardSub style={s.meta}>Streak {streak}</CardSub> : null}
                  {held && active?.active ? (
                    <>
                      <Text style={s.inPlay}>IN PLAY</Text>
                      <Text style={s.play}>{active.title}</Text>
                      {active.instruction ? <Text style={s.meta}>{active.instruction}</Text> : null}
                    </>
                  ) : null}
                   {held && active?.destination === 'ticket' ? <Text testID={`suits-ticket-review-${suit.key}`} style={s.ticketReview}>REVIEW YOUR TICKET</Text> : null}
                   {held && action && !action.actionable ? <Text style={s.viewOnly}>VIEW ONLY · NOT COMPLETABLE</Text> : null}
                   {held && shownState.notes?.[suit.key] ? <Text style={s.jesterNote}>“{shownState.notes[suit.key]}”</Text> : null}
                   {held && shownState.completed[suit.key] ? <Text style={s.stamped}>Stamped by The Hand</Text> : null}
                </View>
              </InWorldCard>
            </TouchableOpacity>
          );
        })}
       </View> : <ActivityIndicator color={GOLD} />}
       {(!canDeal || (isSecondDealer && view === 'mine')) && <><Text style={s.section}>OTHER JOKER</Text><View style={s.lookup}><TextInput value={lookup} onChangeText={setLookup} placeholder="Joker ID" placeholderTextColor="#8e8067" style={s.input} /><TouchableOpacity style={s.button} onPress={() => mutate(async () => setFound((await findSuitHolder(lookup.trim())).holder))}><Text style={s.buttonText}>LOOK</Text></TouchableOpacity></View>{found ? <View><Text style={s.result}>{found.jokerId}</Text>{found.pips.map(p => { const suit = SUITS.find(x => x.key === p); const streak = found.streaks?.[p] ?? 0; return <Text key={p} style={s.result}>{suit?.pip} {suit?.name}{streak > 0 ? ` · Streak ${streak}` : ''}</Text>; })}</View> : null}<Text style={s.footer}>3 / 6 / 9 notes arrive as your suit story grows. Share eligible work with #JestersHand + your Joker ID.</Text></>}
        {canDeal && view === 'deal' && <Admin holders={holders} inPlay={state.inPlay} mutate={mutate} canAwardRoyals={canAwardRoyals} />}
    </ScrollView>
  </View>;
}
function Admin({ holders, inPlay, mutate, canAwardRoyals }: { holders: SuitHolder[]; inPlay: Partial<Record<SuitKey, SuitTask>>; mutate: (fn: () => Promise<void>) => void; canAwardRoyals: boolean }) {
  const [lookup, setLookup] = useState(''); const [member, setMember] = useState<SuitHolder | null>(null); const [drafts, setDrafts] = useState<Partial<Record<SuitKey, SuitTask>>>({});
  const task = (pip: SuitKey): SuitTask => drafts[pip] ?? inPlay[pip] ?? { active: false, title: '', destination: 'table' };
  return <View><Text style={s.section}>JESTER'S TABLE</Text><View style={s.lookup}><TextInput value={lookup} onChangeText={setLookup} placeholder="Find Joker ID" placeholderTextColor="#8e8067" style={s.input}/><TouchableOpacity style={s.button} onPress={() => mutate(async () => setMember((await findSuitHolder(lookup.trim())).holder))}><Text style={s.buttonText}>FIND</Text></TouchableOpacity></View>{member ? <Text style={s.result}>Selected: {member.jokerId}</Text> : null}
    {SUITS.map(x => {
      const d=task(x.key);
      return (
        <InWorldCard key={x.key} style={s.adminCard}>
          <CardPip>{x.pip} {x.name}</CardPip>

          <CardInput
            value={d.title}
            onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,title:v}}))}
            placeholder="Task title"
          />
          <CardInput
            value={d.instruction ?? ''}
            onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,instruction:v}}))}
            placeholder="Optional instruction"
            multiline
            style={{ height: 60, textAlignVertical: 'center' }}
          />

          <View style={s.destRow}>
            {SUIT_TASK_ACTIONS.map(action=>(
              <TouchableOpacity
                 key={action.key}
                 style={[s.destBtn, d.destination === action.key && s.destSelected]}
                 onPress={()=>setDrafts(a=>({...a,[x.key]:{...d,destination:action.key}}))}
              >
                 <Text style={[s.destBtnText, d.destination === action.key && s.destSelectedText]}>
                   {action.label.toUpperCase()}{action.actionable ? '' : ' · VIEW ONLY'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {(['3','6','9'] as const).map(day=>(
            <CardInput
              key={day}
              value={d.milestoneNotes?.[day] ?? ''}
              onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,milestoneNotes:{...(d.milestoneNotes ?? {}),[day]:v}}}))}
              placeholder={`${day}-day note`}
            />
          ))}

          <View style={s.adminActions}>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.actionText}>SAVE</Text></TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:true}))}><Text style={s.actionText}>IN PLAY</Text></TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.actionText}>CLOSE</Text></TouchableOpacity>
          </View>

          <View style={s.adminActions}>
            <TouchableOpacity style={[s.actionBtn, !member && s.actionDisabled]} disabled={!member} onPress={() => mutate(() => setSuitAssignment(member!.uid, x.key, true))}><Text style={s.actionText}>PIN</Text></TouchableOpacity>
            <TouchableOpacity style={[s.actionBtn, !member && s.actionDisabled]} disabled={!member} onPress={() => mutate(() => setSuitAssignment(member!.uid, x.key, false))}><Text style={s.actionText}>REMOVE</Text></TouchableOpacity>
          </View>
        </InWorldCard>
      );
    })}
    <Text style={s.section}>HOLDERS · {holders.length}</Text>{holders.map(h => <View key={h.uid} style={s.holder}><Text style={s.result}>{h.jokerId} — {h.pips.join(', ')}</Text>{canAwardRoyals ? h.pips.map(p => <TouchableOpacity key={p} style={s.small} onPress={() => mutate(() => stampSuitCompletion(h.uid, p))}><Text style={s.buttonText}>STAMP {p}</Text></TouchableOpacity>) : null}</View>)}</View>;
}

const s = StyleSheet.create({
  root:{flex:1,backgroundColor:'#050403'},
  center:{flex:1,justifyContent:'center',alignItems:'center',backgroundColor:'rgba(5,4,3,0.82)',padding:28},
  errorTitle:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:15,textAlign:'center'},
  errorText:{color:CREAM,fontSize:13,lineHeight:19,textAlign:'center',marginTop:12},
  retry:{borderWidth:1,borderColor:GOLD,paddingHorizontal:22,paddingVertical:12,marginTop:22},
  errorBack:{color:'#aa9c85',fontSize:11,marginTop:18},
  nav:{backgroundColor:'#000',flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingBottom:10},
  back:{color:GOLD,fontSize:34,lineHeight:30},
  navTitle:{flex:1,textAlign:'center',color:CREAM,fontFamily:'Cinzel_700Bold',letterSpacing:3,fontSize:16},
  content:{padding:16,paddingBottom:80},
  copy:{color:CREAM,textAlign:'center',fontFamily:'Cinzel_400Regular',marginBottom:15},
  note:{color:'#ff9b75',textAlign:'center',marginBottom:12},
  cards:{flexDirection:'row',flexWrap:'wrap',gap:12,justifyContent:'center'},
  cardWrapper:{width:'47%',minHeight:240},
  card:{flex:1},
  held:{},
  meta:{color:'#aa9c85',fontSize:11,textAlign:'center'},
  inPlay:{color:CREAM,fontSize:8,letterSpacing:2,marginTop:4},
  play:{color:GOLD,fontSize:10,letterSpacing:2,marginTop:2,textAlign:'center'},
  ticketReview:{color:CREAM,fontSize:8,letterSpacing:1,marginTop:5,textAlign:'center'},
  jesterNote:{color:CREAM,fontSize:10,lineHeight:14,marginTop:6,textAlign:'center',fontStyle:'italic'},
  stamped:{color:'#7fb07f',fontSize:10,marginTop:4},
  viewOnly:{color:'#aa9c85',fontSize:8,letterSpacing:1,marginTop:5,textAlign:'center'},
  tabs:{flexDirection:'row',backgroundColor:'#000',borderTopWidth:1,borderTopColor:'#302816',paddingHorizontal:12},
  tab:{flex:1,alignItems:'center',paddingVertical:13,borderBottomWidth:2,borderBottomColor:'transparent'},
  tabActive:{borderBottomColor:GOLD},
  tabText:{color:'#8e8067',fontFamily:'Cinzel_700Bold',fontSize:9,letterSpacing:1,textAlign:'center'},
  tabTextActive:{color:GOLD},
  section:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:12,marginTop:28,marginBottom:10},
  lookup:{flexDirection:'row',gap:8},
  input:{color:CREAM,borderWidth:1,borderColor:'#70551d',backgroundColor:'#0a0907',borderRadius:6,padding:10,flex:1,marginTop:6},
  button:{borderWidth:1,borderColor:GOLD,paddingHorizontal:12,justifyContent:'center'},
  buttonText:{color:GOLD,fontSize:9,fontFamily:'Cinzel_700Bold'},
  result:{color:CREAM,marginTop:10},
  footer:{color:'#aa9c85',fontSize:12,lineHeight:18,marginTop:24,fontStyle:'italic'},
  small:{borderWidth:1,borderColor:'#70551d',padding:7},
  holder:{paddingVertical:9,borderBottomWidth:1,borderBottomColor:'#302816',flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:6},

  adminCard: { width: '100%', marginBottom: 16 },
  destRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, justifyContent: 'center' },
  destBtn: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: 'rgba(0,0,0,0.4)' },
  destSelected: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  destBtnText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_700Bold', fontSize: 9 },
  destSelectedText: { color: GOLD },
  adminActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: GOLD, borderRadius: 6, paddingVertical: 12, alignItems: 'center', backgroundColor: 'rgba(212,168,83,0.1)' },
  actionText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  actionDisabled: { opacity: 0.3, borderColor: 'rgba(237,224,196,0.3)' },
});