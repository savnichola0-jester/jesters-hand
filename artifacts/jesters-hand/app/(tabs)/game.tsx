import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import GameRoomComms from '@/components/GameRoomComms';
import { useAuth } from '@/contexts/AuthContext';
import { confirmAction } from '@/lib/confirm';
import {
  advanceGame, answerTrivia, claimGameHost, createGameRoom, dealRecruitAgain, endGame,
  getGameReview, getGameRoom, getMyGameRooms, getTriviaCategories, getPrivateGameState,
  joinGameRoom, judgeResponse, leaveGame, openRecruitVoting, setGameReview, startGame,
  submitResponse, transferGameHost, voteRecruitRoles,
  type ContentBank, type GameMode, type GameSnapshot, type PrivateGameState, type ReviewEntry,
} from '@/lib/gamesService';

const GOLD = '#D4A853';
const CREAM = '#EDE0C4';
const DIM = '#a89a80';
const FONT = 'Cinzel_700Bold';
const ROLES = ['Sweep', 'Mop', 'Scrub', 'Recruit', 'Protect', 'Void', 'Quinn', 'FCJ'];
const ROLE_IMAGES: Record<string, number> = {
  Sweep: require('../../assets/images/game_role_sweep.png'),
  Mop: require('../../assets/images/game_role_mop.png'),
  Scrub: require('../../assets/images/game_role_scrub.png'),
  Recruit: require('../../assets/images/game_role_recruit.png'),
  Protect: require('../../assets/images/game_role_protect.png'),
  Void: require('../../assets/images/game_role_void.png'),
  Quinn: require('../../assets/images/game_role_quinn.png'),
  FCJ: require('../../assets/images/game_role_fcj.png'),
};
const BANKS: ContentBank[] = ['trivia', 'prompts', 'responses'];
const MODE_COPY: Record<GameMode, { title: string; detail: string }> = {
  trivia: { title: 'TRIVIA', detail: 'A private table. A fresh shuffled question deck. Play solo or invite your crew.' },
  cards: { title: 'JOKERS COH', detail: 'A rotating judge. Secret responses. One winning card each round.' },
  recruit: { title: 'RECRUIT', detail: 'Hold your role close. Question the table, lock your guesses, then reveal.' },
};

export default function GameScreen() {
  const { user, jokerId, isHandAdmin } = useAuth();
  const inset = useSafeAreaInsets();
  const isJester = isHandAdmin && jokerId === '00-00';
  const [room, setRoom] = useState<GameSnapshot | null>(null);
  const [myRooms, setMyRooms] = useState<GameSnapshot[]>([]);
  const [loadingRooms, setLoadingRooms] = useState(false);
  const [privateState, setPrivateState] = useState<PrivateGameState | null>(null);
  const [joinCode, setJoinCode] = useState('');
  const [choosingTrivia, setChoosingTrivia] = useState(false);
  const [triviaCategories, setTriviaCategories] = useState<string[]>([]);
  const [guessMap, setGuessMap] = useState<Record<string, string>>({});
  const [selectedCard, setSelectedCard] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [bank, setBank] = useState<ContentBank>('trivia');
  const [reviewEntries, setReviewEntries] = useState<ReviewEntry[]>([]);
  const [loadingReview, setLoadingReview] = useState(false);
  const [working, setWorking] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async (roomId = room?.id) => {
    if (!roomId) return;
    try {
      const [shared, secret] = await Promise.all([getGameRoom(roomId), getPrivateGameState(roomId)]);
      setRoom(shared.room);
      setPrivateState(secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The game could not refresh.');
    }
  }, [room?.id]);

  const refreshRooms = useCallback(async () => {
    if (!user?.uid) { setMyRooms([]); return; }
    setLoadingRooms(true);
    try { setMyRooms((await getMyGameRooms()).rooms); }
    catch (e) { setError(e instanceof Error ? e.message : 'Your game rooms could not load.'); }
    finally { setLoadingRooms(false); }
  }, [user?.uid]);

  useEffect(() => { void refreshRooms(); }, [refreshRooms]);

  useEffect(() => {
    if (!room?.id || room.status === 'finished') return;
    const timer = setInterval(() => { void refresh(room.id); }, 3500);
    return () => clearInterval(timer);
  }, [room?.id, room?.status, refresh]);

  const act = async (action: () => Promise<{ room: GameSnapshot }>, message = '') => {
    if (working) return;
    setWorking(true); setError(''); setNotice('');
    try {
      const result = await action();
      setRoom(result.room);
      void refreshRooms();
      const secret = await getPrivateGameState(result.room.id);
      setPrivateState(secret);
      setGuessMap(secret.myVotes ?? {});
      setSelectedCard('');
      if (message) setNotice(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That move could not be completed.');
    } finally {
      setWorking(false);
    }
  };

  const openReview = async (nextBank: ContentBank) => {
    setBank(nextBank); setReviewOpen(true); setLoadingReview(true); setError('');
    try { setReviewEntries((await getGameReview(nextBank)).entries); }
    catch (e) { setReviewEntries([]); setError(e instanceof Error ? e.message : 'The review bank is unavailable.'); }
    finally { setLoadingReview(false); }
  };
  const review = async (entryId: string, contentHash: string, status: 'approved' | 'removed' | 'draft') => {
    setWorking(true); setError('');
    try {
      await setGameReview(bank, entryId, contentHash, status);
      setReviewEntries(previous => previous.map(entry => entry.id === entryId ? { ...entry, status } : entry));
    } catch (e) { setError(e instanceof Error ? e.message : 'The review decision could not be saved.'); }
    finally { setWorking(false); }
  };
  const myRole = privateState?.role;
  const isHost = Boolean(room && user?.uid === room.hostUid);
  const selfAlreadyVoted = Boolean(privateState?.myVotes);
  const onLeave = async () => {
    if (!room) return;
    setWorking(true); setError('');
    try { await leaveGame(room.id); setRoom(null); setPrivateState(null); setReviewOpen(false); setNotice('You left the game.'); void refreshRooms(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not leave this game.'); }
    finally { setWorking(false); }
  };
  const resumeRoom = async (roomId: string) => {
    setLoading(true); setError('');
    try {
      const [shared, secret] = await Promise.all([getGameRoom(roomId), getPrivateGameState(roomId)]);
      setRoom(shared.room); setPrivateState(secret); setGuessMap(secret.myVotes ?? {});
    } catch (e) { setError(e instanceof Error ? e.message : 'This room could not be resumed.'); }
    finally { setLoading(false); }
  };
  const makeTable = async (mode: GameMode, category?: string) => {
    setLoading(true); setError(''); setNotice(''); setChoosingTrivia(false);
    try { setRoom((await createGameRoom(mode, category)).room); void refreshRooms(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not open a game table.'); }
    finally { setLoading(false); }
  };
  const chooseMode = async (mode: GameMode) => {
    if (mode !== 'trivia') return void makeTable(mode);
    setLoading(true); setError('');
    try {
      setTriviaCategories((await getTriviaCategories()).categories);
      setChoosingTrivia(true);
    } catch (e) { setError(e instanceof Error ? e.message : 'Trivia categories are unavailable.'); }
    finally { setLoading(false); }
  };

  return (
    <View style={styles.root}>
      <Image source={require('../../assets/images/wood_bg.png')} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[styles.nav, { paddingTop: (Platform.OS === 'web' ? 67 : inset.top) + 6 }]}>
        <TouchableOpacity onPress={() => router.back()} accessibilityLabel="Back"><Text style={styles.back}>‹</Text></TouchableOpacity>
        <Text style={styles.navTitle}>THE GAME ROOM</Text>
        {isJester ? <TouchableOpacity onPress={() => { setReviewOpen(!reviewOpen); setError(''); }} accessibilityLabel="Open content review"><Text style={styles.navAction}>{reviewOpen ? 'TABLE' : 'REVIEW'}</Text></TouchableOpacity> : <View style={styles.navSpacer} />}
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: inset.bottom + (Platform.OS === 'web' ? 48 : 28) }]} keyboardShouldPersistTaps="handled">
        {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
        {notice ? <Text style={styles.notice}>{notice}</Text> : null}
        {reviewOpen && isJester ? (
          <View style={styles.column}>
            <View style={styles.intro}>
              <Text style={styles.eyebrow}>00-00 · CONTENT CONTROL</Text>
              <Text style={styles.title}>THE REVIEW DESK</Text>
              <Text style={styles.copy}>Generated cards stay in draft until you approve them. Remove anything that does not belong at this table.</Text>
            </View>
            <View style={styles.bankRow}>
              {BANKS.map(item => <TouchableOpacity key={item} onPress={() => void openReview(item)} style={[styles.bankTab, bank === item && styles.bankTabActive]}><Text style={styles.bankText}>{item.toUpperCase()}</Text></TouchableOpacity>)}
            </View>
            {loadingReview ? <ActivityIndicator color={GOLD} /> : reviewEntries.length ? reviewEntries.map(entry => (
              <View key={entry.id} style={styles.panel}>
                <View style={styles.reviewHeading}><Text style={styles.eyebrow}>{entry.category ?? bank.toUpperCase()} · {entry.valid ? entry.status.toUpperCase() : 'INVALID · DRAFT'}</Text><Text style={styles.reviewId}>{entry.id}</Text></View>
                <Text style={styles.copy}>{entry.question ?? entry.text ?? ''}</Text>
                {entry.options?.map((option, index) => <Text key={`${entry.id}-${index}`} style={[styles.optionCopy, entry.correctIndex === index && styles.correctOption]}>{String.fromCharCode(65 + index)}  {option}{entry.correctIndex === index ? '  · KEY' : ''}</Text>)}
                {entry.sourceHint ? <Text style={styles.helper}>Source: {entry.sourceHint}</Text> : null}
                <View style={styles.actionRow}>
                  <SmallButton title="APPROVE" onPress={() => void review(entry.id, entry.contentHash, 'approved')} disabled={working || !entry.valid} active={entry.status === 'approved'} />
                  <SmallButton title="REMOVE" onPress={() => void review(entry.id, entry.contentHash, 'removed')} disabled={working} active={entry.status === 'removed'} quiet />
                  {entry.status !== 'draft' ? <SmallButton title="RESET TO DRAFT" onPress={() => void review(entry.id, entry.contentHash, 'draft')} disabled={working} quiet /> : null}
                </View>
                {!entry.valid ? <Text style={styles.helper}>This entry does not match the required JSON shape. Remove it or replace it in the generated bank before publication.</Text> : null}
              </View>
            )) : !loadingReview ? <View style={styles.panel}><Text style={styles.heading}>NOTHING TO REVIEW</Text><Text style={styles.copy}>This content bank is empty or has not been generated yet. Once a JSON bank is installed, each entry will appear here as a draft.</Text></View> : null}
          </View>
        ) : room ? (
          <View style={styles.column}>
            <View style={styles.roomHero}>
              <Text style={styles.eyebrow}>{MODE_COPY[room.mode].title} · {room.status === 'lobby' ? 'WAITING ROOM' : room.phase.replace('-', ' ').toUpperCase()}</Text>
              <Text style={styles.title}>{room.status === 'lobby' ? 'GATHER THE TABLE' : `ROUND ${room.round ?? room.questionNumber ?? 1}`}</Text>
              {room.status === 'lobby' ? <Text style={styles.copy}>Share the invitation. Game secrets remain private to each player.</Text> : null}
              <TouchableOpacity style={styles.codeBox} onPress={() => void Clipboard.setStringAsync(room.code)} accessibilityLabel="Copy invitation code">
                <Text style={styles.codeLabel}>INVITATION CODE · TAP TO COPY</Text><Text style={styles.code}>{room.code}</Text>
              </TouchableOpacity>
            </View>

            <GameRoomComms roomId={room.id} jokerId={jokerId ?? '??-??'} />

            {room.status === 'lobby' ? (
              <>
                <View style={styles.panel}>
                  <Text style={styles.heading}>AT THE TABLE · {room.members.length}</Text>
                  {room.members.map(member => <Text key={member.uid} style={styles.memberLine}>{member.jokerId}{member.uid === room.hostUid ? '  · HOST' : ''}{member.uid === user?.uid ? '  · YOU' : ''}</Text>)}
                  {room.mode === 'trivia' && room.members.length === 1 ? <Text style={styles.helper}>Solo play is ready. Invite a group or start a private challenge. Each table deals up to 20 questions, with ones you have not played first.</Text> : null}
                  {room.mode !== 'trivia' && room.members.length < 4 ? <Text style={styles.helper}>{MODE_COPY[room.mode].title} needs at least 4 Jokers to deal. Invite {4 - room.members.length} more {4 - room.members.length === 1 ? 'Joker' : 'Jokers'}.</Text> : null}
                  {isHost ? room.members.filter(member => member.uid !== user?.uid).map(member => <GoldButton key={member.uid} title={`PASS HOST TO ${member.jokerId}`} onPress={() => void act(() => transferGameHost(room.id, member.uid))} disabled={working} quiet />) : null}
                </View>
                {isHost ? <GoldButton title={`DEAL ${MODE_COPY[room.mode].title}`} onPress={() => void act(() => startGame(room.id))} disabled={working || (room.mode !== 'trivia' && room.members.length < 4)} /> : <Text style={styles.helper}>The host will deal when everyone is ready.</Text>}
                {isHost ? <GoldButton title="CLOSE THIS TABLE" onPress={() => confirmAction('Close this table?', 'The room will finish and its invitation will no longer accept new players.', 'Close table', () => void act(() => endGame(room.id)))} disabled={working} quiet /> : null}
                {!isHost ? <GoldButton title="TAKE HOST SEAT IF HOST IS OFFLINE" onPress={() => void act(() => claimGameHost(room.id))} disabled={working} quiet /> : null}
                <GoldButton title="LEAVE TABLE" onPress={() => void onLeave()} disabled={working} quiet />
              </>
            ) : room.status === 'finished' ? (
              <>
                <Scoreboard room={room} />
                <GoldButton title="CLOSE TABLE" onPress={() => void onLeave()} disabled={working} />
              </>
            ) : (
              <>
                <Scoreboard room={room} />
                {room.mode === 'trivia' ? (
                  <View style={styles.panel}>
                    <Text style={styles.eyebrow}>{room.question?.category?.toUpperCase()} · {room.questionNumber}/{room.questionCount}</Text>
                    <Text style={styles.question}>{room.question?.question}</Text>
                    {room.question?.options.map((option, index) => (
                      <TouchableOpacity key={`${room.question?.id}-${index}`} disabled={working || room.phase !== 'question' || room.myAnswered} onPress={() => void act(() => answerTrivia(room.id, index))} style={[styles.answer, room.myAnswered && room.correctIndex === index && styles.answerCorrect, room.myAnswered && room.correctIndex !== index && styles.answerMuted]}>
                        <Text style={styles.answerLetter}>{String.fromCharCode(65 + index)}</Text><Text style={styles.answerText}>{option}</Text>
                      </TouchableOpacity>
                    ))}
                    {room.phase === 'answer-result' ? <Text style={styles.resultCopy}>Answer: {room.question?.options[room.correctIndex ?? 0]}{room.sourceHint ? ` · ${room.sourceHint}` : ''}</Text> : room.myAnswered ? <Text style={styles.helper}>Answer locked · {room.answered}/{room.answerCount} have answered.</Text> : null}
                    {room.phase === 'question' && !room.myAnswered ? <Text style={styles.helper}>The answer remains sealed until the whole table responds.</Text> : null}
                    {room.phase === 'answer-result' && isHost ? <GoldButton title="NEXT QUESTION" onPress={() => void act(() => advanceGame(room.id))} disabled={working} /> : null}
                  </View>
                ) : room.mode === 'cards' ? (
                  <>
                    <View style={styles.promptCard}><Text style={styles.eyebrow}>PROMPT · {room.prompt?.length ?? 0}</Text><Text style={styles.promptText}>{room.prompt}</Text></View>
                    {room.phase === 'submitting' && room.judgeUid !== user?.uid ? (
                      <View style={styles.panel}>
                        <Text style={styles.heading}>YOUR PRIVATE RESPONSES</Text>
                        <Text style={styles.helper}>Pick one. The judge will see submissions without names.</Text>
                        {privateState?.hand.map(card => <TouchableOpacity key={card.id} onPress={() => setSelectedCard(card.id)} style={[styles.responseCard, selectedCard === card.id && styles.responseSelected]}><Text style={styles.responseText}>{card.text}</Text></TouchableOpacity>)}
                        <GoldButton title="PLAY THIS RESPONSE" onPress={() => void act(() => submitResponse(room.id, selectedCard))} disabled={working || !selectedCard} />
                      </View>
                    ) : room.phase === 'submitting' ? <View style={styles.panel}><Text style={styles.heading}>JUDGE’S TURN</Text><Text style={styles.copy}>Your table is choosing a private response · {room.submissionCount}/{room.expectedSubmissions} submitted.</Text></View>
                      : room.phase === 'judging' && room.judgeUid === user?.uid ? (
                        <View style={styles.panel}><Text style={styles.heading}>CHOOSE THE WINNER</Text>{room.submissions?.map((submission, i) => <TouchableOpacity key={submission.id} disabled={working} style={styles.responseCard} onPress={() => void act(() => judgeResponse(room.id, submission.id))}><Text style={styles.eyebrow}>CARD {String.fromCharCode(65 + i)}</Text><Text style={styles.responseText}>{submission.text}</Text></TouchableOpacity>)}</View>
                      ) : room.phase === 'judging' ? <View style={styles.panel}><Text style={styles.heading}>JUDGE IS READING</Text><Text style={styles.copy}>The judge is choosing the funniest match.</Text></View>
                        : room.phase === 'round-result' ? <View style={styles.panel}><Text style={styles.heading}>THE TABLE’S PICK · {room.winner?.jokerId}</Text><Text style={styles.responseText}>{room.winner?.text}</Text>{room.members.length < 4 ? <Text style={styles.helper}>Cards needs at least 4 Jokers to deal again. This table has {room.members.length}.</Text> : null}{isHost ? <GoldButton title="DEAL NEXT ROUND" onPress={() => void act(() => advanceGame(room.id))} disabled={working || room.members.length < 4} /> : null}</View> : null}
                  </>
                ) : (
                  <>
                    <View style={styles.roleCard}>
                      <Text style={styles.eyebrow}>YOUR PRIVATE CARD</Text>
                      {myRole && ROLE_IMAGES[myRole] ? <Image source={ROLE_IMAGES[myRole]} style={styles.roleArtwork} resizeMode="contain" accessibilityLabel={`${myRole} role card`} /> : null}
                      <Text style={styles.roleName}>{myRole ?? 'SEALED'}</Text>
                      <Text style={styles.helper}>Only you can see this role until the round is revealed.</Text>
                    </View>
                    <View style={styles.panel}>
                      <Text style={styles.heading}>{room.phase === 'questioning' ? 'QUESTION & DISCUSS' : room.phase === 'voting' ? 'GUESS THE TABLE' : 'ROLES REVEALED'}</Text>
                      {room.phase === 'questioning' ? <>
                        <Text style={styles.copy}>Take turns answering in character. Bluff or tell the truth—then discuss what you have heard.</Text>
                        <Text style={styles.helper}>{room.members.length} Jokers · {room.members.map(member => member.jokerId).join('  ·  ')}</Text>
                        {isHost ? <GoldButton title="LOCK DISCUSSION · OPEN VOTES" onPress={() => void act(() => openRecruitVoting(room.id))} disabled={working} /> : null}
                      </> : room.phase === 'voting' ? <>
                        <Text style={styles.copy}>Submit one role guess for each other player. Your guesses are private until the round closes.</Text>
                        {room.members.filter(member => member.uid !== user?.uid).map(member => (
                          <View key={member.uid} style={styles.guessBlock}>
                            <Text style={styles.memberLine}>{member.jokerId}</Text>
                            <View style={styles.roleChoices}>{ROLES.map(role => <TouchableOpacity key={role} disabled={selfAlreadyVoted || working} onPress={() => setGuessMap(previous => ({ ...previous, [member.uid]: role }))} style={[styles.roleChoice, guessMap[member.uid] === role && styles.roleChoiceActive]}><Text style={[styles.roleChoiceText, guessMap[member.uid] === role && styles.roleChoiceTextActive]}>{role}</Text></TouchableOpacity>)}</View>
                          </View>
                        ))}
                        {!selfAlreadyVoted ? <GoldButton title="LOCK MY GUESSES" disabled={working || room.members.some(member => member.uid !== user?.uid && !guessMap[member.uid])} onPress={() => void act(() => voteRecruitRoles(room.id, guessMap))} /> : <Text style={styles.helper}>Your ballot is locked · {room.votedCount}/{room.voteCount} have voted.</Text>}
                      </> : room.phase === 'revealed' ? <>
                        <Text style={styles.copy}>Correct guesses and unspotted bluffs earn a point. Each deal reshuffles the eight established roles; larger tables repeat the full deck.</Text>
                        {room.members.map(member => <Text key={member.uid} style={styles.memberLine}>{member.jokerId}  ·  {room.revealedRoles?.[member.uid]}</Text>)}
                        {room.members.length < 4 ? <Text style={styles.helper}>Recruit needs at least 4 Jokers to deal again. This table has {room.members.length}.</Text> : null}
                        {isHost ? <GoldButton title="RESHUFFLE & DEAL AGAIN" onPress={() => void act(() => dealRecruitAgain(room.id))} disabled={working || room.members.length < 4} /> : null}
                      </> : null}
                    </View>
                  </>
                )}
                <View style={styles.panel}>
                  <Text style={styles.heading}>TABLE CONTROLS</Text>
                  {isHost ? (
                    <>
                      <Text style={styles.helper}>Ending a game closes the round without revealing private Recruit roles.</Text>
                      {room.members.filter(member => member.uid !== user?.uid).map(member => <GoldButton key={member.uid} title={`PASS HOST TO ${member.jokerId}`} onPress={() => void act(() => transferGameHost(room.id, member.uid))} disabled={working} quiet />)}
                      <GoldButton title="END GAME" onPress={() => confirmAction('End this game?', 'The table will close now. Unrevealed roles and private hands will be erased.', 'End game', () => void act(() => endGame(room.id)))} disabled={working} quiet />
                    </>
                  ) : <GoldButton title="TAKE HOST SEAT IF HOST IS OFFLINE" onPress={() => void act(() => claimGameHost(room.id))} disabled={working} />}
                  <GoldButton title="LEAVE TABLE" onPress={() => void onLeave()} disabled={working} quiet />
                </View>
                <Text style={styles.helper}>Live room · refreshes automatically</Text>
              </>
            )}
          </View>
        ) : (
          <View style={styles.column}>
            <View style={styles.intro}>
              <Text style={styles.eyebrow}>PRIVATE ROLES · OPEN TABLES</Text>
              <Text style={styles.title}>DEAL THE NIGHT</Text>
              <Text style={styles.copy}>Pull up a chair. Choose your game, invite a few Jokers, and let the table decide what happens next.</Text>
            </View>
            <View style={styles.panel}>
              <Text style={styles.heading}>YOUR TABLES</Text>
              {loadingRooms ? <ActivityIndicator color={GOLD} /> : null}
              {!loadingRooms && !myRooms.length ? <Text style={styles.helper}>Rooms you have joined will be saved here so you can return after closing the app.</Text> : null}
              {myRooms.map(savedRoom => (
                <TouchableOpacity key={savedRoom.id} style={styles.savedRoom} disabled={loading} onPress={() => void resumeRoom(savedRoom.id)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.memberLine}>{MODE_COPY[savedRoom.mode].title} · {savedRoom.status.toUpperCase()}</Text>
                    <Text style={styles.helper}>{savedRoom.members.length} AT TABLE · CODE {savedRoom.code}{savedRoom.hostUid === user?.uid ? ' · HOST' : ''}</Text>
                  </View>
                  <Text style={styles.resumeArrow}>›</Text>
                </TouchableOpacity>
              ))}
            </View>
            {choosingTrivia ? (
              <View style={styles.panel}>
                <Text style={styles.heading}>CHOOSE YOUR QUESTION DECK</Text>
                <Text style={styles.helper}>20 questions per table. Come back for another round to uncover more; questions you have not played come first.</Text>
                <GoldButton title="ALL CATEGORIES" onPress={() => void makeTable('trivia')} disabled={loading} />
                {triviaCategories.map(category => <GoldButton key={category} title={category.toUpperCase()} onPress={() => void makeTable('trivia', category)} disabled={loading} quiet />)}
                <TouchableOpacity onPress={() => setChoosingTrivia(false)}><Text style={styles.link}>CANCEL</Text></TouchableOpacity>
              </View>
            ) : (['trivia', 'cards', 'recruit'] as GameMode[]).map(mode => (
              <TouchableOpacity key={mode} disabled={loading || !user} style={styles.gameTile} onPress={() => void chooseMode(mode)}>
                <View style={styles.tileTop}><Text style={styles.eyebrow}>0{(['trivia', 'cards', 'recruit'] as GameMode[]).indexOf(mode) + 1} / 03</Text><Text style={styles.tileArrow}>↗</Text></View>
                <Text style={styles.tileTitle}>{MODE_COPY[mode].title}</Text><Text style={styles.copy}>{MODE_COPY[mode].detail}</Text>
              </TouchableOpacity>
            ))}
            {loading ? <ActivityIndicator color={GOLD} /> : null}
            <View style={styles.panel}>
              <Text style={styles.heading}>JOIN AN INVITATION</Text>
              <TextInput value={joinCode} onChangeText={value => setJoinCode(value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 10))} style={styles.input} placeholder="10-character room code" placeholderTextColor={DIM} autoCapitalize="characters" autoCorrect={false} maxLength={10} accessibilityLabel="Game invitation code" />
              <GoldButton title="JOIN TABLE" disabled={loading || joinCode.length !== 10} onPress={() => {
                setLoading(true); setError(''); setNotice('');
                void joinGameRoom(joinCode).then(result => { setRoom(result.room); setJoinCode(''); void refreshRooms(); }).catch(e => setError(e instanceof Error ? e.message : 'Could not join this table.')).finally(() => setLoading(false));
              }} />
            </View>
            {!user ? <Text style={styles.helper}>Sign in with an active Joker account to play.</Text> : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

function Scoreboard({ room }: { room: GameSnapshot }) {
  return <View style={styles.scoreRow}>{room.members.map(member => <View style={styles.score} key={member.uid}><Text style={styles.scoreNumber}>{room.scores[member.uid] ?? 0}</Text><Text style={styles.scoreName}>{member.jokerId}</Text></View>)}</View>;
}
function GoldButton({ title, onPress, disabled, quiet = false }: { title: string; onPress: () => void; disabled?: boolean; quiet?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.button, quiet && styles.buttonQuiet, disabled && styles.buttonDisabled]}><Text style={[styles.buttonText, quiet && styles.buttonQuietText]}>{title}</Text></TouchableOpacity>;
}
function SmallButton({ title, onPress, disabled, active, quiet = false }: { title: string; onPress: () => void; disabled?: boolean; active?: boolean; quiet?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" onPress={onPress} disabled={disabled} style={[styles.smallButton, active && styles.smallButtonActive, quiet && styles.smallButtonQuiet]}><Text style={styles.smallButtonText}>{title}</Text></TouchableOpacity>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050403' },
  nav: { backgroundColor: '#000', paddingHorizontal: 17, paddingBottom: 10, flexDirection: 'row', alignItems: 'center' },
  back: { color: GOLD, fontSize: 34, lineHeight: 32, width: 34 },
  navTitle: { flex: 1, color: CREAM, textAlign: 'center', fontSize: 15, letterSpacing: 2, fontFamily: FONT },
  navAction: { color: GOLD, fontSize: 10, fontFamily: FONT, letterSpacing: 1 },
  navSpacer: { width: 42 },
  content: { width: '100%', alignItems: 'center', padding: 16, gap: 13 },
  column: { width: '100%', maxWidth: 620, gap: 13 },
  intro: { paddingHorizontal: 7, paddingVertical: 19, gap: 9 },
  eyebrow: { color: GOLD, fontSize: 9, fontFamily: FONT, letterSpacing: 1.35 },
  title: { color: CREAM, fontSize: 25, fontFamily: FONT, letterSpacing: 1.4 },
  copy: { color: CREAM, fontSize: 12, lineHeight: 19 },
  gameTile: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.48)', backgroundColor: 'rgba(0,0,0,0.83)', padding: 16, gap: 7, minHeight: 111 },
  tileTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tileArrow: { color: GOLD, fontSize: 20 },
  tileTitle: { color: CREAM, fontFamily: FONT, fontSize: 17, letterSpacing: 1.2 },
  panel: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.42)', backgroundColor: 'rgba(0,0,0,0.87)', padding: 15, gap: 12 },
  savedRoom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderTopWidth: 1, borderColor: 'rgba(212,168,83,0.2)' },
  resumeArrow: { color: GOLD, fontSize: 25, paddingHorizontal: 8 },
  heading: { color: GOLD, fontSize: 11, fontFamily: FONT, letterSpacing: 1.1 },
  input: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.48)', color: CREAM, padding: 12, fontSize: 15, minHeight: 47, backgroundColor: 'rgba(0,0,0,0.7)', letterSpacing: 1.2 },
  button: { borderWidth: 1, borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.13)', paddingVertical: 14, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', minHeight: 47 },
  buttonQuiet: { backgroundColor: 'rgba(0,0,0,0.6)', borderColor: 'rgba(212,168,83,0.35)' },
  buttonDisabled: { opacity: 0.42 },
  buttonText: { color: GOLD, fontSize: 10, letterSpacing: 0.9, fontFamily: FONT, textAlign: 'center' },
  buttonQuietText: { color: DIM },
  roomHero: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)', backgroundColor: 'rgba(0,0,0,0.88)', padding: 17, gap: 8, alignItems: 'center' },
  codeBox: { width: '100%', alignItems: 'center', marginTop: 7, borderTopWidth: 1, borderBottomWidth: 1, borderColor: 'rgba(212,168,83,0.28)', paddingVertical: 12 },
  codeLabel: { color: DIM, fontSize: 8, letterSpacing: 1.3, fontFamily: FONT },
  code: { color: GOLD, fontSize: 24, letterSpacing: 4, fontFamily: FONT, marginTop: 5 },
  memberLine: { color: CREAM, fontSize: 12, lineHeight: 19, fontFamily: FONT, letterSpacing: 0.4 },
  helper: { color: DIM, fontSize: 10, lineHeight: 16 },
  link: { color: GOLD, textAlign: 'center', padding: 7, fontSize: 10, fontFamily: FONT },
  scoreRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 1, backgroundColor: 'rgba(0,0,0,0.8)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)', padding: 9 },
  score: { minWidth: 64, alignItems: 'center', padding: 6 },
  scoreNumber: { color: GOLD, fontSize: 19, fontFamily: FONT },
  scoreName: { color: DIM, fontSize: 8, letterSpacing: 0.5 },
  question: { color: CREAM, fontSize: 17, lineHeight: 25, fontFamily: FONT, marginVertical: 3 },
  answer: { flexDirection: 'row', alignItems: 'center', gap: 11, padding: 12, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', backgroundColor: 'rgba(255,255,255,0.035)', minHeight: 46 },
  answerCorrect: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.15)' },
  answerMuted: { opacity: 0.52 },
  answerLetter: { color: GOLD, fontFamily: FONT, fontSize: 11 },
  answerText: { color: CREAM, flex: 1, fontSize: 12, lineHeight: 18 },
  resultCopy: { color: GOLD, fontSize: 11, lineHeight: 17 },
  promptCard: { minHeight: 144, justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(212,168,83,0.7)', backgroundColor: '#10100d', padding: 22, gap: 13 },
  promptText: { color: CREAM, fontFamily: FONT, fontSize: 20, lineHeight: 29 },
  responseCard: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.31)', backgroundColor: 'rgba(255,255,255,0.035)', padding: 14, gap: 6 },
  responseSelected: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.16)' },
  responseText: { color: CREAM, fontSize: 14, lineHeight: 21 },
  roleCard: { minHeight: 155, justifyContent: 'center', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: GOLD, backgroundColor: '#11100c', padding: 20 },
  roleArtwork: { width: 118, height: 148 },
  roleName: { color: GOLD, fontFamily: FONT, fontSize: 32, letterSpacing: 3 },
  guessBlock: { gap: 7, borderTopWidth: 1, borderColor: 'rgba(212,168,83,0.2)', paddingTop: 11 },
  roleChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  roleChoice: { borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', paddingHorizontal: 9, paddingVertical: 7 },
  roleChoiceActive: { backgroundColor: 'rgba(212,168,83,0.2)', borderColor: GOLD },
  roleChoiceText: { color: DIM, fontSize: 9 },
  roleChoiceTextActive: { color: GOLD, fontFamily: FONT },
  error: { color: '#ffab92', textAlign: 'center', lineHeight: 19, padding: 8, width: '100%', maxWidth: 620 },
  notice: { color: GOLD, textAlign: 'center', lineHeight: 19, padding: 8, width: '100%', maxWidth: 620 },
  bankRow: { flexDirection: 'row', gap: 6 },
  bankTab: { flex: 1, borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', paddingVertical: 11, alignItems: 'center' },
  bankTabActive: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.14)' },
  bankText: { color: GOLD, fontFamily: FONT, fontSize: 9, letterSpacing: 0.5 },
  reviewHeading: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'center' },
  reviewId: { color: DIM, fontSize: 9 },
  optionCopy: { color: CREAM, fontSize: 11, lineHeight: 17 },
  correctOption: { color: GOLD },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  smallButton: { flexGrow: 1, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', paddingHorizontal: 9, paddingVertical: 10 },
  smallButtonActive: { backgroundColor: 'rgba(212,168,83,0.2)', borderColor: GOLD },
  smallButtonQuiet: { borderColor: 'rgba(212,168,83,0.2)' },
  smallButtonText: { color: GOLD, fontSize: 8, fontFamily: FONT, letterSpacing: 0.4 },
});