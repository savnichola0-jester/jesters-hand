import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { doc, onSnapshot } from 'firebase/firestore';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import { db } from '@/lib/firebase';
import { findSuitHolder, getMySuits, getSuitAdmin, setSuitAssignment, SUITS, SUIT_TASK_ACTIONS, SuitHolder, SuitKey, SuitState, SuitTask, setSuitInPlay } from '@/lib/suitsService';
import { InWorldCard, CardPip, CardTitle, CardInput } from '@/components/InWorldCard';
import ExternalWhispersParticipation from '@/components/community/ExternalWhispersParticipation';
import { BUTTON_ACCENT, BUTTON_ACCENT_FAINT, BUTTON_ACCENT_SOFT } from '@/lib/buttonAccent';

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
  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, 'suitAssignments', user.uid), snapshot => {
      setState(current => current
         ? { ...current, pips: snapshot.data()?.pips ?? [], privateCards: snapshot.data()?.privateCards ?? {} }
        : current);
    }, () => setNote('Could not refresh your assignments. Reopen SUITS to try again.'));
  }, [user?.uid]);
  if (!state) return <View style={s.root}><Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} /><View style={s.center}>{loading ? <ActivityIndicator color={GOLD} /> : <><Text style={s.errorTitle}>SUITS COULD NOT OPEN</Text><Text style={s.errorText}>{note}</Text><TouchableOpacity style={s.retry} onPress={() => void load()}><Text style={s.buttonText}>TRY AGAIN</Text></TouchableOpacity><TouchableOpacity onPress={() => router.back()}><Text style={s.errorBack}>BACK TO THE HAND</Text></TouchableOpacity></>}</View></View>;
  const mutate = async (work: () => Promise<void>) => { setNote(''); try { await work(); await load(); } catch (e: any) { setNote(e?.message ?? 'SUITS action failed.'); } };
   const selected = SUITS.find(suit => suit.key === selectedSuit);
    const visibleTask = (pip: SuitKey) => {
      const shared = state.inPlay[pip];
      return shared?.visibility === 'private'
        ? (shared.privateTargetUid === user?.uid ? state.privateCards[pip] : undefined)
        : shared;
    };
    const selectedTask = selectedSuit ? visibleTask(selectedSuit) : undefined;
   const selectedAction = SUIT_TASK_ACTIONS.find(action => action.key === selectedTask?.destination);
   const openDestination = () => {
      if (selectedTask?.destination === 'social') {
        void Clipboard.setStringAsync('#JestersHand').catch(() => {});
        void Linking.openURL('https://savnicholaofficial.com')
          .catch(() => setNote('Could not open the author website. Visit savnicholaofficial.com to find the social links.'));
     } else if (selectedAction?.route) {
       router.push(selectedAction.route as any);
     }
     setSelectedSuit(null);
   };
   return <View style={s.root}>
    <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} />
    <View style={[s.nav, { paddingTop: inset.top + 8 }]}><TouchableOpacity onPress={() => router.back()}><Text style={s.back}>‹</Text></TouchableOpacity><Text style={s.navTitle}>SUITS</Text></View>
    <ScrollView contentContainerStyle={s.content}>
         <Text style={s.copy}>Cards may be dealt to the whole Hand or privately to one Joker. Tap a lit card to read it.</Text>
          <Text style={s.personalPips}>YOUR ASSIGNED CARDS · {SUITS.some(suit => state.pips.includes(suit.key) || (state.inPlay[suit.key]?.privateTargetUid === user?.uid && state.privateCards[suit.key]?.active)) ? SUITS.filter(suit => state.pips.includes(suit.key) || (state.inPlay[suit.key]?.privateTargetUid === user?.uid && state.privateCards[suit.key]?.active)).map(suit => `${suit.pip} ${suit.name}`).join('  ·  ') : 'NONE YET'}</Text>
      {note ? <Text style={s.note}>{note}</Text> : null}
        <View style={s.cards}>
        {SUITS.map(suit => {
             const active = visibleTask(suit.key);
            const isLive = active?.active === true;
             const isPrivate = state.inPlay[suit.key]?.visibility === 'private';
          return (
            <TouchableOpacity
               disabled={!isLive}
              key={suit.key}
               testID={`suits-community-${suit.key}`}
                accessibilityLabel={`${suit.name} ${isPrivate && isLive ? 'private' : 'community'} card${isLive ? ', in play' : ', not dealt'}`}
               onPress={() => setSelectedSuit(suit.key)}
               style={[s.cardWrapper, isLive && s.liveCard]}
            >
               <InWorldCard style={s.card} isDone={isLive} artworkFit="contain">
                 <CardPip style={{ fontSize: 48, minHeight: 56 }}>{suit.pip}</CardPip>
                <CardTitle style={{ fontSize: 14 }}>{suit.name}</CardTitle>
                  {(state.pips.includes(suit.key) || (isPrivate && isLive)) && <Text style={s.myAssignment}>ASSIGNED TO YOU</Text>}

                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 12 }}>
                   {isLive ? (
                    <>
                      <Text style={s.inPlay}>{isPrivate ? 'DEALT TO YOU' : 'IN PLAY'}</Text>
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
         <ExternalWhispersParticipation location="suits" />
        {canDeal && <Admin inPlay={state.inPlay} mutate={mutate} />}
    </ScrollView>
     <Modal visible={!!selected && !!selectedTask?.active} transparent animationType="fade" onRequestClose={() => setSelectedSuit(null)}>
       <View style={s.detailOverlay}>
          <TouchableOpacity style={s.detailClose} onPress={() => setSelectedSuit(null)} accessibilityLabel="Close SUITS card"><Text style={s.detailCloseText}>CLOSE ×</Text></TouchableOpacity>
         {selected && selectedTask?.active && <InWorldCard style={s.detailCard} artworkFit="contain">
           <CardPip>{selected.pip}</CardPip>
           <CardTitle>{selected.name}</CardTitle>
           <View style={s.detailBody}>
              <Text style={s.inPlay}>{state.inPlay[selectedSuit!]?.visibility === 'private' ? 'PRIVATE CARD · FOR YOUR JOKER ID' : 'COMMUNITY CARD · IN PLAY'}</Text>
             <Text style={s.detailTitle}>{selectedTask.title}</Text>
             {selectedTask.instruction ? <Text style={s.detailInstruction}>{selectedTask.instruction}</Text> : null}
           </View>
            {selectedAction?.actionable && <TouchableOpacity style={s.detailAction} onPress={openDestination}><Text style={s.actionText}>{selectedTask.destination === 'social' ? 'OPEN AUTHOR SOCIALS' : `OPEN ${selectedAction.label.toUpperCase()}`}</Text></TouchableOpacity>}
         </InWorldCard>}
       </View>
     </Modal>
  </View>;
}
function Admin({ inPlay, mutate }: { inPlay: Partial<Record<SuitKey, SuitTask>>; mutate: (fn: () => Promise<void>) => void }) {
   const [drafts, setDrafts] = useState<Partial<Record<SuitKey, SuitTask>>>({});
    const [jokerSearch, setJokerSearch] = useState('');
    const [holder, setHolder] = useState<SuitHolder | null>(null);
    const [assignmentNote, setAssignmentNote] = useState('');
    const [searching, setSearching] = useState(false);
    const [workingPip, setWorkingPip] = useState<SuitKey | null>(null);
    const [privateTargets, setPrivateTargets] = useState<Partial<Record<SuitKey, SuitHolder>>>({});
    const [targetingPip, setTargetingPip] = useState<SuitKey | null>(null);
    const [individualSearch, setIndividualSearch] = useState('');
    const [individualResult, setIndividualResult] = useState<SuitHolder | null>(null);
    const [individualNote, setIndividualNote] = useState('');
    const [searchingIndividual, setSearchingIndividual] = useState(false);
    const [adminHolders, setAdminHolders] = useState<SuitHolder[]>([]);
    useEffect(() => {
      let active = true;
      getSuitAdmin()
        .then(result => { if (active) setAdminHolders(result.holders); })
        .catch(() => { if (active) setAssignmentNote('Could not load current individual Joker assignments.'); });
      return () => { active = false; };
    }, []);
   const task = (pip: SuitKey): SuitTask => drafts[pip] ??
     (inPlay[pip]?.visibility === 'private'
       ? {
           active: false,
           title: '',
           ...(
             privateTargets[pip]?.uid === inPlay[pip]?.privateTargetUid
               ? privateTargets[pip]?.privateCards?.[pip]
               : holder?.uid === inPlay[pip]?.privateTargetUid
                 ? holder?.privateCards?.[pip]
                 : adminHolders.find(member => member.uid === inPlay[pip]?.privateTargetUid)?.privateCards?.[pip]
           ),
           visibility: 'private',
           privateTargetUid: inPlay[pip]?.privateTargetUid,
         }
       : inPlay[pip]) ?? { active: false, title: '', destination: 'table', visibility: 'community' };
    const searchIndividualJoker = async () => {
      const exactId = individualSearch.trim();
      if (!/^\d{2}-\d{2}$/.test(exactId)) {
        setIndividualResult(null);
        setIndividualNote('Enter an exact Joker ID in the form 00-00.');
        return;
      }
      if (exactId === '00-00' || exactId === '01-54') {
        setIndividualResult(null);
        setIndividualNote('Individual private cards can only be assigned to active member Jokers.');
        return;
      }
      setSearchingIndividual(true);
      setIndividualNote('');
      try {
        const result = await findSuitHolder(exactId);
        setIndividualResult(result.holder);
        if (!result.holder) setIndividualNote(`No active member found for ${exactId}.`);
      } catch (e: any) {
        setIndividualResult(null);
        setIndividualNote(e?.message ?? 'Joker lookup failed. Try again.');
      } finally {
        setSearchingIndividual(false);
      }
    };
    const chooseIndividualJoker = () => {
      if (targetingPip === null || !individualResult) return;
      const pip = targetingPip;
      setPrivateTargets(current => ({ ...current, [pip]: individualResult }));
      setDrafts(current => ({
        ...current,
        [pip]: {
          ...(current[pip] ?? (
            inPlay[pip]?.visibility === 'private' && inPlay[pip]?.privateTargetUid === individualResult.uid
              ? individualResult.privateCards?.[pip]
              : task(pip)
          )),
          visibility: 'private',
          notifyAudience: undefined,
        },
      }));
      setTargetingPip(null);
      setIndividualSearch('');
      setIndividualResult(null);
      setIndividualNote('');
    };
    const searchJoker = async () => {
      const exactId = jokerSearch.trim();
      if (!/^\d{2}-\d{2}$/.test(exactId)) {
        setHolder(null);
        setAssignmentNote('Enter an exact Joker ID in the form 00-00.');
        return;
      }
      setSearching(true);
      setAssignmentNote('');
      try {
        const result = await findSuitHolder(exactId);
         setHolder(result.holder);
         setDrafts({});
        if (!result.holder) setAssignmentNote(`No active member found for ${exactId}.`);
      } catch (e: any) {
        setHolder(null);
        setAssignmentNote(e?.message ?? 'Joker lookup failed. Try again.');
      } finally {
        setSearching(false);
      }
    };
    const toggleAssignment = async (pip: SuitKey) => {
      if (!holder) return;
      const assigned = !holder.pips.includes(pip);
      setWorkingPip(pip);
      setAssignmentNote('');
      try {
        await setSuitAssignment(holder.uid, holder.jokerId, pip, assigned);
        const refreshed = await findSuitHolder(holder.jokerId);
        if (!refreshed.holder) {
          setHolder(null);
          setAssignmentNote('The member is no longer available. Search again.');
        } else {
          setHolder(refreshed.holder);
          setAssignmentNote(`${SUITS.find(suit => suit.key === pip)?.name} ${assigned ? 'assigned to' : 'removed from'} ${holder.jokerId}.`);
        }
      } catch (e: any) {
        setAssignmentNote(e?.message ?? 'Assignment was rejected. Try again.');
      } finally {
        setWorkingPip(null);
      }
    };
    const saveCard = (pip: SuitKey, card: SuitTask) => {
      const selectedTarget = privateTargets[pip]
        ?? (holder && holder.uid === card.privateTargetUid ? holder : null);
      if (card.visibility === 'private' && !selectedTarget) {
        setAssignmentNote('Choose the individual Joker on this card before saving it.');
        return;
      }
      mutate(async () => {
        await setSuitInPlay(pip, card, card.visibility === 'private' ? selectedTarget! : undefined);
        setDrafts(current => {
          const next = { ...current };
          delete next[pip];
          return next;
        });
        if (holder) {
          try {
            const refreshed = await findSuitHolder(holder.jokerId);
            setHolder(refreshed.holder);
          } catch {
            setHolder(null);
            setAssignmentNote('Card saved. Search for this Joker again to refresh their assignment.');
          }
        }
      });
    };
    return <View><Text style={s.section}>DEAL A SUITS CARD</Text>
      <Text style={s.assignmentCopy}>Each card can go to the whole Hand, alert its suit group, or be assigned privately to one Joker. Suit groups come from the roster below.</Text>
     <View style={s.assignmentPanel}>
        <Text style={s.assignmentTitle}>SUIT GROUP ROSTER</Text>
        <Text style={s.assignmentCopy}>After placing a suit card on a member’s Ticket, search their Joker ID and assign the matching suit here. The artwork cannot be read automatically.</Text>
       <TextInput
         value={jokerSearch}
         onChangeText={value => { setJokerSearch(value); setHolder(null); setAssignmentNote(''); }}
          placeholder="Exact Joker ID · 12-34"
         placeholderTextColor="#8e8067"
         autoCapitalize="characters"
         autoCorrect={false}
         maxLength={5}
         accessibilityLabel="Search exact Joker ID"
         testID="suits-joker-search"
         style={s.jokerInput}
       />
       <TouchableOpacity style={s.searchButton} onPress={() => void searchJoker()} disabled={searching} accessibilityLabel="Search Joker">
         {searching ? <ActivityIndicator color={GOLD} /> : <Text style={s.actionText}>SEARCH JOKER</Text>}
       </TouchableOpacity>
       {assignmentNote ? <Text style={s.assignmentNote}>{assignmentNote}</Text> : null}
       {holder && <>
         <Text style={s.selectedMember}>SELECTED JOKER · {holder.jokerId}</Text>
         <Text style={s.assignedPips}>ASSIGNED PIPS · {holder.pips.length ? SUITS.filter(suit => holder.pips.includes(suit.key)).map(suit => suit.pip).join('  ') : 'NONE'}</Text>
         <View style={s.assignmentPips}>
           {SUITS.map(suit => {
             const assigned = holder.pips.includes(suit.key);
             return <TouchableOpacity
               key={suit.key}
               testID={`suits-assignment-${suit.key}`}
               accessibilityLabel={`${assigned ? 'Remove' : 'Assign'} ${suit.name} for ${holder.jokerId}`}
               style={[s.assignmentButton, assigned && s.assignedButton]}
               disabled={workingPip !== null}
               onPress={() => void toggleAssignment(suit.key)}
             >
               {workingPip === suit.key ? <ActivityIndicator color={GOLD} /> : <Text style={[s.assignmentButtonText, assigned && s.assignedButtonText]}>{suit.pip} {assigned ? 'REMOVE' : 'ASSIGN'} {suit.name.toUpperCase()}</Text>}
             </TouchableOpacity>;
           })}
         </View>
       </>}
     </View>
    {SUITS.map(x => {
      const d=task(x.key);
       const individualTarget = privateTargets[x.key]
         ?? (holder?.uid === d.privateTargetUid ? holder : null)
         ?? adminHolders.find(member => member.uid === d.privateTargetUid)
         ?? null;
       const audience = d.visibility === 'private'
         ? 'individual'
         : d.notifyAudience === 'suit_group' ? 'group' : 'community';
      return (
        <InWorldCard key={x.key} style={s.adminCard}>
          <CardPip>{x.pip} {x.name}</CardPip>
          <View style={s.audiencePanel}>
            <Text style={s.visibilityTitle}>WHO GETS THIS TASK?</Text>
            <View style={s.audienceOptions}>
              {([
                ['community', 'WHOLE HAND'],
                ['group', 'SUIT GROUP'],
                ['individual', 'ONE JOKER'],
              ] as const).map(([mode, label]) => {
                const selected = audience === mode;
                return (
                  <TouchableOpacity
                    key={mode}
                    testID={`suits-audience-${x.key}-${mode}`}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${label} task assignment for ${x.name}`}
                    style={[s.audienceOption, selected && s.audienceOptionSelected]}
                    onPress={() => setDrafts(current => ({
                      ...current,
                      [x.key]: {
                        ...d,
                        visibility: mode === 'individual' ? 'private' : 'community',
                        notifyAudience: mode === 'group' ? 'suit_group' : 'community',
                      },
                    }))}
                  >
                    <Text style={[s.audienceOptionText, selected && s.audienceOptionTextSelected]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={s.visibilityHint}>
              {audience === 'individual'
                ? 'Only the selected Joker and Hand admins can read this private card.'
                : audience === 'group'
                  ? `The card remains visible to the whole Hand; only Jokers assigned ${x.name} get the alert.`
                  : 'Everyone can read the card and gets the alert.'}
            </Text>
            {audience === 'individual' && (
              <TouchableOpacity
                style={s.individualTargetButton}
                testID={`suits-individual-target-${x.key}`}
                accessibilityLabel={`Choose individual Joker for ${x.name}`}
                onPress={() => {
                  setTargetingPip(x.key);
                  setIndividualSearch(individualTarget?.jokerId ?? '');
                  setIndividualResult(individualTarget);
                  setIndividualNote('');
                }}
              >
                <Text style={s.individualTargetLabel}>ASSIGNED JOKER</Text>
                <Text style={s.individualTargetValue}>{individualTarget?.jokerId ?? 'CHOOSE JOKER ID'}</Text>
                <Text style={s.tapHint}>{individualTarget ? 'TAP TO CHANGE' : 'TAP TO SELECT'}</Text>
              </TouchableOpacity>
            )}
          </View>

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
             <TouchableOpacity style={s.actionBtn} onPress={()=>saveCard(x.key,{...d,active:false})}><Text style={s.actionText}>SAVE</Text></TouchableOpacity>
             <TouchableOpacity style={s.actionBtn} onPress={()=>saveCard(x.key,{...d,active:true})}><Text style={s.actionText}>IN PLAY</Text></TouchableOpacity>
             <TouchableOpacity style={s.actionBtn} onPress={()=>saveCard(x.key,{...d,active:false})}><Text style={s.actionText}>CLOSE</Text></TouchableOpacity>
          </View>

        </InWorldCard>
      );
    })}
    <Modal visible={targetingPip !== null} transparent animationType="fade" onRequestClose={() => setTargetingPip(null)}>
      <View style={s.modalBackdrop}>
        <View style={s.modalSheet}>
          <Text style={s.modalTitle}>ASSIGN TO ONE JOKER</Text>
          <Text style={s.modalCopy}>This card will be private to the Joker you select.</Text>
          <TextInput
            value={individualSearch}
            onChangeText={value => { setIndividualSearch(value); setIndividualResult(null); setIndividualNote(''); }}
            placeholder="Exact Joker ID · 12-34"
            placeholderTextColor="#8e8067"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={5}
            accessibilityLabel="Search individual Joker ID"
            testID="suits-individual-joker-search"
            style={s.jokerInput}
          />
          <TouchableOpacity style={s.searchButton} onPress={() => void searchIndividualJoker()} disabled={searchingIndividual}>
            {searchingIndividual ? <ActivityIndicator color={GOLD} /> : <Text style={s.actionText}>SEARCH JOKER</Text>}
          </TouchableOpacity>
          {individualNote ? <Text style={s.assignmentNote}>{individualNote}</Text> : null}
          {individualResult && (
            <TouchableOpacity
              style={s.confirmTarget}
              testID="suits-confirm-individual-joker"
              accessibilityLabel={`Assign to Joker ${individualResult.jokerId}`}
              onPress={chooseIndividualJoker}
            >
              <Text style={s.confirmTargetText}>ASSIGN TO {individualResult.jokerId}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.modalClose} onPress={() => setTargetingPip(null)}>
            <Text style={s.modalCloseText}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
   </View>;
}

const s = StyleSheet.create({
  root:{flex:1,backgroundColor:'#050403'},
  center:{flex:1,justifyContent:'center',alignItems:'center',backgroundColor:'rgba(5,4,3,0.82)',padding:28},
  errorTitle:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:15,textAlign:'center'},
  errorText:{color:CREAM,fontSize:13,lineHeight:19,textAlign:'center',marginTop:12},
  retry:{borderWidth:1,borderColor:BUTTON_ACCENT,backgroundColor:BUTTON_ACCENT_SOFT,paddingHorizontal:22,paddingVertical:12,marginTop:22},
  errorBack:{color:'#aa9c85',fontSize:11,marginTop:18},
  nav:{backgroundColor:'#000',flexDirection:'row',alignItems:'center',paddingHorizontal:16,paddingBottom:10},
  back:{color:GOLD,fontSize:34,lineHeight:30},
  navTitle:{flex:1,textAlign:'center',color:CREAM,fontFamily:'Cinzel_700Bold',letterSpacing:3,fontSize:16},
  content:{padding:16,paddingBottom:80},
  copy:{color:CREAM,textAlign:'center',fontFamily:'Cinzel_400Regular',marginBottom:15},
   personalPips:{color:GOLD,textAlign:'center',fontFamily:'Cinzel_700Bold',fontSize:10,letterSpacing:1,marginBottom:16},
   myAssignment:{color:GOLD,fontSize:8,letterSpacing:1,marginTop:5,textAlign:'center'},
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
   detailAction:{borderWidth:1,borderColor:BUTTON_ACCENT,backgroundColor:BUTTON_ACCENT_SOFT,borderRadius:6,padding:12,alignItems:'center',marginTop:12},
  meta:{color:'#aa9c85',fontSize:11,textAlign:'center'},
  inPlay:{color:CREAM,fontSize:8,letterSpacing:2,marginTop:4},
  play:{color:GOLD,fontSize:10,letterSpacing:2,marginTop:2,textAlign:'center'},
  section:{color:GOLD,fontFamily:'Cinzel_700Bold',letterSpacing:2,fontSize:12,marginTop:28,marginBottom:10},
  buttonText:{color:BUTTON_ACCENT,fontSize:9,fontFamily:'Cinzel_700Bold'},

  adminCard: { width: '100%', marginBottom: 16 },
  audiencePanel: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', backgroundColor: 'rgba(0,0,0,0.38)', padding: 10, marginBottom: 12 },
  audienceOptions: { flexDirection: 'row', gap: 6, marginTop: 8, marginBottom: 8 },
  audienceOption: { flex: 1, minHeight: 40, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 5, paddingHorizontal: 4, paddingVertical: 7 },
  audienceOptionSelected: { borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT },
  audienceOptionText: { color: 'rgba(237,224,196,0.65)', fontFamily: 'Cinzel_700Bold', fontSize: 8, letterSpacing: 0.4, textAlign: 'center' },
  audienceOptionTextSelected: { color: BUTTON_ACCENT },
  visibilityTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  visibilityHint: { color: CREAM, fontSize: 10, marginTop: 5 },
  individualTargetButton: { alignItems: 'center', borderWidth: 1, borderColor: 'rgba(250,105,2,0.45)', padding: 10, marginTop: 10, backgroundColor: BUTTON_ACCENT_FAINT },
  individualTargetLabel: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1 },
  individualTargetValue: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, marginTop: 4 },
  tapHint: { color: 'rgba(212,168,83,0.65)', fontFamily: 'Cinzel_700Bold', fontSize: 8, letterSpacing: 1, marginTop: 4 },
  destRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12, justifyContent: 'center' },
  destBtn: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: 'rgba(0,0,0,0.4)' },
  destSelected: { borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT },
  destBtnText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_700Bold', fontSize: 9 },
  destSelectedText: { color: BUTTON_ACCENT },
  adminActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, borderWidth: 1, borderColor: BUTTON_ACCENT, borderRadius: 6, paddingVertical: 12, alignItems: 'center', backgroundColor: BUTTON_ACCENT_SOFT },
  actionText: { color: BUTTON_ACCENT, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  assignmentCopy: { color: CREAM, fontSize: 12, lineHeight: 18, textAlign: 'center', marginBottom: 12 },
  assignmentPanel: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)', backgroundColor: 'rgba(0,0,0,0.55)', padding: 14, marginBottom: 20 },
  assignmentTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', letterSpacing: 1.5, fontSize: 12, textAlign: 'center', marginBottom: 12 },
  jokerInput: { borderWidth: 1, borderColor: BUTTON_ACCENT, color: CREAM, fontSize: 15, paddingHorizontal: 12, paddingVertical: 11, textAlign: 'center' },
  searchButton: { borderWidth: 1, borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT, padding: 12, alignItems: 'center', marginTop: 8 },
  assignmentNote: { color: '#ff9b75', textAlign: 'center', marginTop: 10, fontSize: 12 },
  selectedMember: { color: CREAM, fontFamily: 'Cinzel_700Bold', letterSpacing: 1.2, textAlign: 'center', marginTop: 16 },
  assignedPips: { color: GOLD, fontSize: 12, letterSpacing: 1, textAlign: 'center', marginTop: 8, marginBottom: 12 },
  assignmentPips: { gap: 8 },
  assignmentButton: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)', padding: 11, alignItems: 'center' },
  assignedButton: { borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT },
  assignmentButtonText: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1 },
  assignedButtonText: { color: BUTTON_ACCENT },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.84)', justifyContent: 'center', padding: 24 },
  modalSheet: { backgroundColor: '#090909', borderWidth: 1, borderColor: GOLD, borderRadius: 10, padding: 16 },
  modalTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1.5, textAlign: 'center', marginBottom: 8 },
  modalCopy: { color: CREAM, fontSize: 12, lineHeight: 18, textAlign: 'center', marginBottom: 14 },
  confirmTarget: { borderWidth: 1, borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT, padding: 12, alignItems: 'center', marginTop: 12 },
  confirmTargetText: { color: BUTTON_ACCENT, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  modalClose: { borderWidth: 1, borderColor: 'rgba(237,224,196,0.3)', padding: 12, alignItems: 'center', marginTop: 12 },
  modalCloseText: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.5 },
});