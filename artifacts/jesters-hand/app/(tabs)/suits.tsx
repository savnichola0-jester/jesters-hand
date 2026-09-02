import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, ImageBackground, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { findSuitHolder, getMySuits, SUITS, SuitHolder, SuitKey, SuitState, SuitTask, getSuitAdmin, setSuitAssignment, setSuitInPlay, stampSuitCompletion } from '@/lib/suitsService';

const GOLD = '#D4A853'; const CREAM = '#EDE0C4';
const CARD_BACK = require('../../assets/images/black_card.png');
export default function SuitsScreen() {
  const { user, jokerId, isAdmin, isHandAdmin } = useAuth(); const inset = useSafeAreaInsets();
  const [state, setState] = useState<SuitState | null>(null); const [holders, setHolders] = useState<SuitHolder[]>([]);
  const [lookup, setLookup] = useState(''); const [found, setFound] = useState<SuitHolder | null>(null); const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const canDeal = isHandAdmin;
  const canAwardRoyals = isAdmin && jokerId === '00-00';
  const load = useCallback(async () => {
    setLoading(true); setNote('');
    try {
      if (canDeal) {
        const r = await getSuitAdmin();
        setHolders(r.holders);
        setState({ pips: [], streaks: {}, notes: {}, inPlay: r.inPlay, completed: {} });
      } else {
        setState((await getMySuits()).state);
      }
    } catch (e: any) {
      setNote(e?.message ?? 'SUITS is unavailable.');
    } finally {
      setLoading(false);
    }
  }, [canDeal]);
  useEffect(() => { if (user) void load(); }, [user?.uid, load]);
  if (!state) return <View style={s.root}><Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} /><View style={s.center}>{loading ? <ActivityIndicator color={GOLD} /> : <><Text style={s.errorTitle}>SUITS COULD NOT OPEN</Text><Text style={s.errorText}>{note}</Text><TouchableOpacity style={s.retry} onPress={() => void load()}><Text style={s.buttonText}>TRY AGAIN</Text></TouchableOpacity><TouchableOpacity onPress={() => router.back()}><Text style={s.errorBack}>BACK TO THE HAND</Text></TouchableOpacity></>}</View></View>;
  const mutate = async (work: () => Promise<void>) => { setNote(''); try { await work(); await load(); } catch (e: any) { setNote(e?.message ?? 'SUITS action failed.'); } };
  return <View style={s.root}>
    <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} />
    <View style={[s.nav, { paddingTop: inset.top + 8 }]}><TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹</Text></TouchableOpacity><Text style={s.navTitle}>SUITS</Text></View>
    <ScrollView contentContainerStyle={s.content}>
      <Text style={s.copy}>Pips are assigned by Jester 00-00. Opening this table never counts.</Text>
      {note ? <Text style={s.note}>{note}</Text> : null}
      <View style={s.cards}>{SUITS.map(suit => { const held = state.pips.includes(suit.key); const active = state.inPlay[suit.key]; const streak = state.streaks[suit.key] ?? 0; return <TouchableOpacity disabled={!held || !active?.active} key={suit.key} onPress={() => { if (active?.destination === 'social') { const text = `#JestersHand ${jokerId ?? ''}`; void Clipboard.setStringAsync(text).then(() => setNote(`Copied: ${text}`)).catch(() => setNote(`Copy this: ${text}`)); } else if (active?.destination && active.destination !== 'discovery') router.push(`/(tabs)/${active.destination}` as any); }} style={[s.card, held && s.held]}>
        <ImageBackground source={CARD_BACK} style={s.cardBack} imageStyle={s.cardBackImage} resizeMode="cover">
          <View style={s.cardShade}>
            <Text style={s.pip}>{held ? suit.pip : ' '}</Text><Text style={s.suitName}>{suit.name}</Text>
            {held && streak > 0 ? <Text style={s.meta}>Streak {streak}</Text> : null}
            {held && active?.active ? <><Text style={s.inPlay}>IN PLAY</Text><Text style={s.play}>{active.title}</Text>{active.instruction ? <Text style={s.meta}>{active.instruction}</Text> : null}</> : null}
            {held && state.notes?.[suit.key] ? <Text style={s.jesterNote}>“{state.notes[suit.key]}”</Text> : null}
            {held && state.completed[suit.key] ? <Text style={s.stamped}>Stamped</Text> : null}
          </View>
        </ImageBackground>
      </TouchableOpacity>; })}</View>
      {!canDeal && <><Text style={s.section}>OTHER JOKER</Text><View style={s.lookup}><TextInput value={lookup} onChangeText={setLookup} placeholder="Joker ID" placeholderTextColor="#8e8067" style={s.input} /><TouchableOpacity style={s.button} onPress={() => mutate(async () => setFound((await findSuitHolder(lookup.trim())).holder))}><Text style={s.buttonText}>LOOK</Text></TouchableOpacity></View>{found ? <View><Text style={s.result}>{found.jokerId}</Text>{found.pips.map(p => { const suit = SUITS.find(x => x.key === p); const streak = found.streaks?.[p] ?? 0; return <Text key={p} style={s.result}>{suit?.pip} {suit?.name}{streak > 0 ? ` · Streak ${streak}` : ''}</Text>; })}</View> : null}<Text style={s.footer}>3 / 6 / 9 notes arrive as your suit story grows. Share eligible work with #JestersHand + your Joker ID.</Text></>}
       {canDeal && <Admin holders={holders} inPlay={state.inPlay} mutate={mutate} canAwardRoyals={canAwardRoyals} />}
    </ScrollView>
  </View>;
}
function Admin({ holders, inPlay, mutate, canAwardRoyals }: { holders: SuitHolder[]; inPlay: Partial<Record<SuitKey, SuitTask>>; mutate: (fn: () => Promise<void>) => void; canAwardRoyals: boolean }) {
  const [lookup, setLookup] = useState(''); const [member, setMember] = useState<SuitHolder | null>(null); const [drafts, setDrafts] = useState<Partial<Record<SuitKey, SuitTask>>>({});
  const task = (pip: SuitKey): SuitTask => drafts[pip] ?? inPlay[pip] ?? { active: false, title: '', destination: 'table' };
  return <View><Text style={s.section}>JESTER'S TABLE</Text><View style={s.lookup}><TextInput value={lookup} onChangeText={setLookup} placeholder="Find Joker ID" placeholderTextColor="#8e8067" style={s.input}/><TouchableOpacity style={s.button} onPress={() => mutate(async () => setMember((await findSuitHolder(lookup.trim())).holder))}><Text style={s.buttonText}>FIND</Text></TouchableOpacity></View>{member ? <Text style={s.result}>Selected: {member.jokerId}</Text> : null}
    {SUITS.map(x => { const d=task(x.key); return <View key={x.key} style={s.editor}><Text style={s.adminPip}>{x.pip} {x.name}</Text><TextInput value={d.title} onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,title:v}}))} placeholder="Task title" placeholderTextColor="#8e8067" style={s.input}/><TextInput value={d.instruction ?? ''} onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,instruction:v}}))} placeholder="Optional instruction" placeholderTextColor="#8e8067" style={s.input}/><View style={s.dest}>{(['table','jesters-deal','uniform','recruit','target-ticket','chamber','social','discovery'] as const).map(destination=><TouchableOpacity key={destination} style={[s.small, d.destination === destination && s.selected]} onPress={()=>setDrafts(a=>({...a,[x.key]:{...d,destination}}))}><Text style={s.buttonText}>{destination}</Text></TouchableOpacity>)}</View>{(['3','6','9'] as const).map(day=><TextInput key={day} value={d.milestoneNotes?.[day] ?? ''} onChangeText={v=>setDrafts(a=>({...a,[x.key]:{...d,milestoneNotes:{...(d.milestoneNotes ?? {}),[day]:v}}}))} placeholder={`${day}-day note from the Jester`} placeholderTextColor="#8e8067" style={s.input}/>)}
      <View style={s.dest}><TouchableOpacity style={s.small} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.buttonText}>SAVE</Text></TouchableOpacity><TouchableOpacity style={s.small} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:true}))}><Text style={s.buttonText}>IN PLAY</Text></TouchableOpacity><TouchableOpacity style={s.small} onPress={()=>mutate(()=>setSuitInPlay(x.key,{...d,active:false}))}><Text style={s.buttonText}>CLOSE PLAY</Text></TouchableOpacity><TouchableOpacity style={s.small} disabled={!member} onPress={() => mutate(() => setSuitAssignment(member!.uid, x.key, true))}><Text style={s.buttonText}>PIN</Text></TouchableOpacity><TouchableOpacity style={s.small} disabled={!member} onPress={() => mutate(() => setSuitAssignment(member!.uid, x.key, false))}><Text style={s.buttonText}>REMOVE</Text></TouchableOpacity></View></View>; })}
    <Text style={s.section}>HOLDERS · {holders.length}</Text>{holders.map(h => <View key={h.uid} style={s.holder}><Text style={s.result}>{h.jokerId} — {h.pips.join(', ')}</Text>{canAwardRoyals ? h.pips.map(p => <TouchableOpacity key={p} style={s.small} onPress={() => mutate(() => stampSuitCompletion(h.uid, p))}><Text style={s.buttonText}>STAMP {p}</Text></TouchableOpacity>) : null}</View>)}</View>;
}
const s = StyleSheet.create({ root:{flex:1,backgroundColor:'#050403'},center:{flex:1,justifyContent:'center',alignItems:'center',backgroundColor:'rgba(5,4,3,0.82)',padding:28},errorTitle:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:15,textAlign:'center'},errorText:{color:CREAM,fontSize:13,lineHeight:19,textAlign:'center',marginTop:12},retry:{borderWidth:1,borderColor:GOLD,paddingHorizontal:22,paddingVertical:12,marginTop:22},errorBack:{color:'#aa9c85',fontSize:11,marginTop:18},nav:{backgroundColor:'#000',flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingBottom:10},back:{color:GOLD,fontSize:34,lineHeight:30},navTitle:{flex:1,textAlign:'center',color:CREAM,fontFamily:'Cinzel_700Bold',letterSpacing:3,fontSize:16},content:{padding:16,paddingBottom:80},copy:{color:CREAM,textAlign:'center',fontFamily:'Cinzel_400Regular',marginBottom:15},note:{color:'#ff9b75',textAlign:'center',marginBottom:12},cards:{flexDirection:'row',flexWrap:'wrap',gap:10,justifyContent:'center'},card:{width:'47%',height:230,backgroundColor:'#060606',borderColor:'#56431b',borderWidth:1,borderRadius:12,overflow:'hidden'},held:{borderColor:GOLD},cardBack:{flex:1},cardBackImage:{borderRadius:11},cardShade:{flex:1,alignItems:'center',justifyContent:'center',padding:12,backgroundColor:'rgba(0,0,0,0.24)'},pip:{fontSize:42,color:GOLD,minHeight:50},suitName:{color:CREAM,fontFamily:'Cinzel_700Bold',fontSize:13},meta:{color:'#aa9c85',fontSize:11,marginTop:7,textAlign:'center'},inPlay:{color:CREAM,fontSize:8,letterSpacing:2,marginTop:7},play:{color:GOLD,fontSize:10,letterSpacing:2,marginTop:5,textAlign:'center'},jesterNote:{color:CREAM,fontSize:10,lineHeight:14,marginTop:8,textAlign:'center',fontStyle:'italic'},stamped:{color:'#7fb07f',fontSize:10,marginTop:4},section:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:12,marginTop:28,marginBottom:10},lookup:{flexDirection:'row',gap:8},input:{color:CREAM,borderWidth:1,borderColor:'#70551d',backgroundColor:'#0a0907',borderRadius:6,padding:10,flex:1,marginTop:6},button:{borderWidth:1,borderColor:GOLD,paddingHorizontal:12,justifyContent:'center'},buttonText:{color:GOLD,fontSize:9,fontFamily:'Cinzel_700Bold'},result:{color:CREAM,marginTop:10},footer:{color:'#aa9c85',fontSize:12,lineHeight:18,marginTop:24,fontStyle:'italic'},adminPip:{color:CREAM,marginBottom:6},small:{borderWidth:1,borderColor:'#70551d',padding:7},selected:{borderColor:GOLD,backgroundColor:'rgba(212,168,83,0.14)'},holder:{paddingVertical:9,borderBottomWidth:1,borderBottomColor:'#302816',flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:6},editor:{borderWidth:1,borderColor:'#302816',padding:9,marginBottom:8},dest:{flexDirection:'row',flexWrap:'wrap',gap:5,marginTop:6} });