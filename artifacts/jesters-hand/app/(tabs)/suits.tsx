import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { doc, onSnapshot } from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { getMySuits, SUITS, SUIT_TASK_ACTIONS, SuitKey, SuitState, SuitTask, setSuitInPlay } from '@/lib/suitsService';
import { InWorldCard, CardPip, CardTitle, CardInput } from '@/components/InWorldCard';

const GOLD = '#D4A853'; const CREAM = '#EDE0C4';
export default function SuitsScreen() {
  const { user, isHandAdmin } = useAuth(); const inset = useSafeAreaInsets();
  const [state, setState] = useState<SuitState | null>(null);
  const [selectedSuit, setSelectedSuit] = useState<SuitKey | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const canDeal = isHandAdmin;
  const load = useCallback(async () => {
    setLoading(true); setNote('');
    try {
      setState((await getMySuits()).state);
    } catch (e: any) {
      setNote(e?.message ?? 'SUITS is unavailable.');
    } finally {
      setLoading(false);
    }
    }, []);
  useEffect(() => { if (user) void load(); }, [user?.uid, load]);
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, 'suitConfig', 'current'), snapshot => {
      setState(current => current
        ? { ...current, inPlay: snapshot.data()?.inPlay ?? {} }
        : current);
    }, () => setNote('Could not refresh community cards. Reopen SUITS to try again.'));
  }, [user?.uid]);
  if (!state) return <View style={s.root}><Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} /><View style={s.center}>{loading ? <ActivityIndicator color={GOLD} /> : <><Text style={s.errorTitle}>SUITS COULD NOT OPEN</Text><Text style={s.errorText}>{note}</Text><TouchableOpacity style={s.retry} onPress={() => void load()}><Text style={s.buttonText}>TRY AGAIN</Text></TouchableOpacity><TouchableOpacity onPress={() => router.back()}><Text style={s.errorBack}>BACK TO THE HAND</Text></TouchableOpacity></>}</View></View>;
  const mutate = async (work: () => Promise<void>) => { setNote(''); try { await work(); await load(); } catch (e: any) { setNote(e?.message ?? 'SUITS action failed.'); } };
   const selected = SUITS.find(suit => suit.key === selectedSuit);
   const selectedTask = selectedSuit ? state.inPlay[selectedSuit] : undefined;
   const selectedAction = SUIT_TASK_ACTIONS.find(action => action.key === selectedTask?.destination);
   const openDestination = () => {
     if (selectedTask?.destination === 'social') {
       void Clipboard.setStringAsync('#JestersHand')
         .then(() => setNote('Copied: #JestersHand'))
         .catch(() => setNote('Copy this: #JestersHand'));
     } else if (selectedAction?.route) {
       router.push(selectedAction.route as any);
     }
     setSelectedSuit(null);
   };
   return <View style={s.root}>
    <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} />
    <View style={[s.nav, { paddingTop: inset.top + 8 }]}><TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹</Text></TouchableOpacity><Text style={s.navTitle}>SUITS</Text></View>
    <ScrollView contentContainerStyle={s.content}>
        <Text style={s.copy}>Community cards are dealt to the whole Hand. Tap a lit card to read it.</Text>
      {note ? <Text style={s.note}>{note}</Text> : null}
        <View style={s.cards}>
        {SUITS.map(suit => {
            const active = state.inPlay[suit.key];
            const isLive = active?.active === true;
          return (
            <TouchableOpacity
               disabled={!isLive}
              key={suit.key}
               testID={`suits-community-${suit.key}`}
               accessibilityLabel={`${suit.name} community card${isLive ? ', in play' : ', not dealt'}`}
               onPress={() => setSelectedSuit(suit.key)}
               style={[s.cardWrapper, isLive && s.liveCard]}
            >
               <InWorldCard style={s.card} isDone={isLive} artworkFit="contain">
                 <CardPip style={{ fontSize: 48, minHeight: 56 }}>{suit.pip}</CardPip>
                <CardTitle style={{ fontSize: 14 }}>{suit.name}</CardTitle>

                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 12 }}>
                   {isLive ? (
                    <>
                      <Text style={s.inPlay}>IN PLAY</Text>
                      <Text style={s.play}>{active.title}</Text>
                       <Text style={s.openHint}>TAP TO READ</Text>
                    </>
                   ) : <Text style={s.notDealt}>NOT DEALT</Text>}
                </View>
              </InWorldCard>
            </TouchableOpacity>
          );
        })}
        </View>
        {canDeal && <Admin inPlay={state.inPlay} mutate={mutate} />}
    </ScrollView>
     <Modal visible={!!selected && !!selectedTask?.active} transparent animationType="fade" onRequestClose={() => setSelectedSuit(null)}>
       <View style={s.detailOverlay}>
         <TouchableOpacity style={s.detailClose} onPress={() => setSelectedSuit(null)} accessibilityLabel="Close community card"><Text style={s.detailCloseText}>CLOSE ×</Text></TouchableOpacity>
         {selected && selectedTask?.active && <InWorldCard style={s.detailCard} artworkFit="contain">
           <CardPip>{selected.pip}</CardPip>
           <CardTitle>{selected.name}</CardTitle>
           <View style={s.detailBody}>
             <Text style={s.inPlay}>COMMUNITY CARD · IN PLAY</Text>
             <Text style={s.detailTitle}>{selectedTask.title}</Text>
             {selectedTask.instruction ? <Text style={s.detailInstruction}>{selectedTask.instruction}</Text> : null}
           </View>
           {selectedAction?.actionable && <TouchableOpacity style={s.detailAction} onPress={openDestination}><Text style={s.actionText}>{selectedTask.destination === 'social' ? 'COPY COMMUNITY TAG' : `OPEN ${selectedAction.label.toUpperCase()}`}</Text></TouchableOpacity>}
         </InWorldCard>}
       </View>
     </Modal>
  </View>;
}
function Admin({ inPlay, mutate }: { inPlay: Partial<Record<SuitKey, SuitTask>>; mutate: (fn: () => Promise<void>) => void }) {
   const [drafts, setDrafts] = useState<Partial<Record<SuitKey, SuitTask>>>({});
  const task = (pip: SuitKey): SuitTask => drafts[pip] ?? inPlay[pip] ?? { active: false, title: '', destination: 'table' };
   return <View><Text style={s.section}>DEAL TO THE WHOLE HAND</Text>
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

          <View style={s.adminActions}>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.actionText}>SAVE</Text></TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:true}))}><Text style={s.actionText}>IN PLAY</Text></TouchableOpacity>
            <TouchableOpacity style={s.actionBtn} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.actionText}>CLOSE</Text></TouchableOpacity>
          </View>

        </InWorldCard>
      );
    })}
   </View>;
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
   cardWrapper:{width:'47%',aspectRatio:2/3},
  card:{flex:1},
   liveCard:{shadowColor:GOLD,shadowOpacity:0.9,shadowRadius:15,elevation:12},
   notDealt:{color:'#8e8067',fontSize:9,letterSpacing:1.5,textAlign:'center'},
   openHint:{color:GOLD,fontSize:9,letterSpacing:1.5,marginTop:4},
   detailOverlay:{flex:1,backgroundColor:'rgba(0,0,0,0.94)',justifyContent:'center',alignItems:'center',paddingHorizontal:28},
   detailClose:{alignSelf:'flex-end',paddingVertical:14},
   detailCloseText:{color:CREAM,fontFamily:'Cinzel_700Bold',letterSpacing:1.5},
   detailCard:{width:'100%',maxWidth:340,aspectRatio:2/3},
   detailBody:{flex:1,justifyContent:'center',alignItems:'center',gap:16,paddingHorizontal:8},
   detailTitle:{color:GOLD,fontFamily:'Cinzel_700Bold',fontSize:20,textAlign:'center'},
   detailInstruction:{color:CREAM,fontSize:15,lineHeight:22,textAlign:'center'},
   detailAction:{borderWidth:1,borderColor:GOLD,borderRadius:6,padding:12,alignItems:'center',marginTop:12},
  meta:{color:'#aa9c85',fontSize:11,textAlign:'center'},
  inPlay:{color:CREAM,fontSize:8,letterSpacing:2,marginTop:4},
  play:{color:GOLD,fontSize:10,letterSpacing:2,marginTop:2,textAlign:'center'},
  section:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:12,marginTop:28,marginBottom:10},
  buttonText:{color:GOLD,fontSize:9,fontFamily:'Cinzel_700Bold'},

  adminCard: { width: '100%', marginBottom: 16 },
  destRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, justifyContent: 'center' },
  destBtn: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: 'rgba(0,0,0,0.4)' },
  destSelected: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  destBtnText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_700Bold', fontSize: 9 },
  destSelectedText: { color: GOLD },
  adminActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: GOLD, borderRadius: 6, paddingVertical: 12, alignItems: 'center', backgroundColor: 'rgba(212,168,83,0.1)' },
  actionText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
});