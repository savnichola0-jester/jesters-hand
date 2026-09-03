import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ImageBackground, ActivityIndicator, Modal,
  FlatList, KeyboardAvoidingView, Alert, Pressable, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import {
  AnteBoard, AntePost, AnteComment,
  listenAntePosts, createAntePost, formatAnteTimestamp, toggleAnteVote,
  toggleAntePostReaction, listenAnteComments, createAnteComment,
  deleteAntePost, deleteAnteComment,
  toggleAnteCommentReaction, setAnteMute,
} from '@/lib/anteService';
import { getAllMembers } from '@/lib/ticketService';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');
const CARD_FRAME = require('../../assets/images/ante_card_frame.png');
const NAV_BELL   = require('../../assets/images/nav_bell.png');

const { width: SW, height: SH } = appWindow();
const NAV_H  = 52;
const SIDE   = 16;
const FOLDER_W = SW - SIDE * 2;
const TAB_H  = 40;
const CREAM  = '#EDE0C4';
const GOLD   = '#D4A853';

const REACTION_EMOJIS = ['👍', '👎', '👑', '🎭', '😢', '😂', '🖤', '🤍', '🔥', '🗡', '👀', '🃏', '♠️', '♣️', '♥️', '♦️', '🐾'];

// Compose card frame — rendered at the image's native aspect ratio (1024×1536)
// like the whisper/table frames, never stretched.
const CARD_RATIO = 1536 / 1024;
const CARD_MAX_H = SH * 0.88;
const CARD_W = Math.min(SW - 24, Math.round(CARD_MAX_H / CARD_RATIO));
const CARD_H = Math.round(CARD_W * CARD_RATIO);
const CARD_SIDE = Math.round(CARD_W * 0.098);  // inside the side borders
const CARD_TOP  = Math.round(CARD_H * 0.105);  // below top border
const CARD_BOT  = Math.round(CARD_H * 0.150);  // above bottom border + ornament

const OPTION_LABELS = ['Option A', 'Option B', 'Option C', 'Option D'];

type SenderInfo = { label: string; mugUrl: string | null };
type PickerTarget =
  | { kind: 'post'; postId: string }
  | { kind: 'comment'; postId: string; commentId: string };

export default function AnteScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isAdmin } = useAuth();

  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  const [board, setBoard] = useState<AnteBoard>('place');
  const [posts, setPosts] = useState<AntePost[]>([]);
  const [loading, setLoading] = useState(true);

  const [senderCache, setSenderCache] = useState<Record<string, SenderInfo>>({});

  useEffect(() => {
    getAllMembers().then(members => {
      const cache: Record<string, SenderInfo> = {};
      members.forEach((m: any) => {
        cache[m.uid] = { label: m.name || m.jokerId || '——', mugUrl: m.mugUrl ?? null };
      });
      setSenderCache(cache);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    const unsub = listenAntePosts(board, p => {
      setPosts(p);
      setLoading(false);
    });
    return unsub;
  }, [board]);

  // ── Compose card state ─────────────────────────────────────────────────────
  const [composeVisible, setComposeVisible] = useState(false);
  const [title, setTitle]             = useState('');
  const [description, setDescription] = useState('');
  const [options, setOptions]         = useState<string[]>(['', '', '', '']);
  const [posting, setPosting]         = useState(false);

  // ── Comments state ─────────────────────────────────────────────────────────
  const [openPostId, setOpenPostId]   = useState<string | null>(null);
  const [comments, setComments]       = useState<AnteComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [commenting, setCommenting]   = useState(false);
  const openBoardRef = useRef<AnteBoard>('place');

  useEffect(() => {
    if (!openPostId) return;
    setCommentsLoading(true);
    const unsub = listenAnteComments(openBoardRef.current, openPostId, c => {
      setComments(c);
      setCommentsLoading(false);
    });
    return unsub;
  }, [openPostId]);

  // ── Reaction picker ────────────────────────────────────────────────────────
  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);

  const openPicker = useCallback((target: PickerTarget) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setPickerTarget(target);
  }, []);

  const applyReaction = useCallback((emoji: string) => {
    if (!user || !pickerTarget) return;
    const b = openBoardRef.current;
    if (pickerTarget.kind === 'post') {
      toggleAntePostReaction(b, pickerTarget.postId, user.uid, emoji).catch(console.error);
    } else {
      toggleAnteCommentReaction(b, pickerTarget.postId, pickerTarget.commentId, user.uid, emoji)
        .catch(console.error);
    }
    setPickerTarget(null);
  }, [user, pickerTarget]);

  // Delete a post or comment from the reaction picker (author or admin)
  const deleteFromPicker = useCallback(() => {
    if (!pickerTarget) return;
    const target = pickerTarget;
    const b = openBoardRef.current;
    setPickerTarget(null);
    const label = target.kind === 'post' ? 'post' : 'comment';
    Alert.alert(`Delete ${label}?`, 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => {
          if (target.kind === 'post') {
            if (openPostId === target.postId) setOpenPostId(null);
            deleteAntePost(b, target.postId).catch(console.error);
          } else {
            deleteAnteComment(b, target.postId, target.commentId).catch(console.error);
          }
        },
      },
    ]);
  }, [pickerTarget, openPostId]);

  const canDeletePickerTarget = useMemo(() => {
    if (!pickerTarget || !user) return false;
    if (isAdmin) return true;
    if (pickerTarget.kind === 'post') {
      return posts.find(p => p.id === pickerTarget.postId)?.senderUid === user.uid;
    }
    return comments.find(c => c.id === pickerTarget.commentId)?.senderUid === user.uid;
  }, [pickerTarget, user, isAdmin, posts, comments]);

  const toggleQuickReaction = useCallback((target: PickerTarget, emoji: string) => {
    if (!user) return;
    const b = openBoardRef.current;
    if (target.kind === 'post') {
      toggleAntePostReaction(b, target.postId, user.uid, emoji).catch(console.error);
    } else {
      toggleAnteCommentReaction(b, target.postId, target.commentId, user.uid, emoji)
        .catch(console.error);
    }
  }, [user]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const switchBoard = useCallback((b: AnteBoard) => {
    if (b !== board) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setBoard(b);
      openBoardRef.current = b;
    }
  }, [board]);

  useEffect(() => { openBoardRef.current = board; }, [board]);

  // ── Deep link from a notification: open that post's comment thread ────────
  const params = useLocalSearchParams<{ board?: string; postId?: string }>();
  const handledDeepLink = useRef<string | null>(null);
  useEffect(() => {
    const targetPost = typeof params.postId === 'string' ? params.postId : null;
    if (!targetPost || handledDeepLink.current === targetPost) return;
    handledDeepLink.current = targetPost;
    const targetBoard: AnteBoard = params.board === 'raised' ? 'raised' : 'place';
    setBoard(targetBoard);
    openBoardRef.current = targetBoard;
    setPickerTarget(null);
    setComments([]);
    setOpenPostId(targetPost);
  }, [params.postId, params.board]);

  const openCompose = useCallback(() => {
    setTitle('');
    setDescription('');
    setOptions(['', '', '', '']);
    setComposeVisible(true);
  }, []);

  const submitPost = useCallback(async () => {
    const t = title.trim();
    if (!user || !t || posting) return;
    setPosting(true);
    try {
      await createAntePost(board, user.uid, {
        title: t,
        description,
        options: board === 'place' ? options : [],
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setComposeVisible(false);
    } catch {
      Alert.alert('Post failed', 'Could not drop the ante. Try again.');
    } finally {
      setPosting(false);
    }
  }, [user, board, title, description, options, posting]);

  const submitComment = useCallback(async () => {
    const text = commentText.trim();
    if (!user || !text || !openPostId || commenting) return;
    setCommenting(true);
    try {
      await createAnteComment(openBoardRef.current, openPostId, user.uid, text);
      setCommentText('');
    } catch {
      Alert.alert('Comment failed', 'Could not post comment. Try again.');
    } finally {
      setCommenting(false);
    }
  }, [user, openPostId, commentText, commenting]);

  const isPlace = board === 'place';
  const openPost = openPostId ? posts.find(p => p.id === openPostId) ?? null : null;
  const isMuted = !!(user && openPost?.mutedBy?.includes(user.uid));

  const toggleMute = useCallback(() => {
    if (!user || !openPostId || !openPost) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const next = !openPost.mutedBy?.includes(user.uid);
    setAnteMute(openBoardRef.current, openPostId, user.uid, next).catch(() => {
      Alert.alert('Mute failed', 'Could not update mute setting. Try again.');
    });
  }, [user, openPostId, openPost]);

  // ── Shared renderers ───────────────────────────────────────────────────────
  const renderSenderHead = (uid: string, ts: any) => {
    const sender = senderCache[uid];
    const label  = sender?.label ?? '——';
    const mug    = sender?.mugUrl ?? null;
    return (
      <View style={s.postHead}>
        <View style={s.postAvatar}>
          {mug
            ? <Image source={{ uri: mug }} style={s.postAvatarImg} />
            : <Text style={s.postAvatarText}>{label.slice(0, 2).toUpperCase()}</Text>
          }
        </View>
        <Text style={s.postSender} numberOfLines={1}>{label}</Text>
        <Text style={s.postTime}>{formatAnteTimestamp(ts)}</Text>
      </View>
    );
  };

  const renderReactionsRow = (
    reactions: Record<string, string[]>,
    target: PickerTarget,
  ) => {
    const entries = Object.entries(reactions).filter(([, uids]) => uids.length > 0);
    if (entries.length === 0) return null;
    return (
      <View style={s.reactionsRow}>
        {entries.map(([emoji, uids]) => (
          <TouchableOpacity
            key={emoji}
            style={[s.reactionPill, uids.includes(user?.uid ?? '') && s.reactionPillOwn]}
            onPress={() => toggleQuickReaction(target, emoji)}
            activeOpacity={0.75}
          >
            <Text style={s.reactionEmoji}>{emoji}</Text>
            <Text style={s.reactionCount}>{uids.length}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const castVote = useCallback((postId: string, optionIndex: number) => {
    if (!user) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    toggleAnteVote(openBoardRef.current, postId, user.uid, optionIndex).catch(console.error);
  }, [user]);

  const renderPostBody = (item: AntePost) => {
    const voteValues = Object.values(item.votes ?? {});
    const totalVotes = voteValues.length;
    const myVote = user ? item.votes?.[user.uid] : undefined;
    return (
      <>
        {!!item.title && <Text style={s.postTitle}>{item.title}</Text>}
        {!!item.description && <Text style={s.postText}>{item.description}</Text>}
        {item.options.length > 0 && (
          <View style={s.optionsWrap}>
            {item.options.map((opt, i) => {
              const count = voteValues.filter(v => v === i).length;
              const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
              const mine = myVote === i;
              return (
                <TouchableOpacity
                  key={i}
                  style={[s.optionRow, mine && s.optionRowMine]}
                  onPress={() => castVote(item.id, i)}
                  activeOpacity={0.75}
                >
                  {totalVotes > 0 && (
                    <View
                      pointerEvents="none"
                      style={[s.optionFill, mine && s.optionFillMine, { width: `${pct}%` }]}
                    />
                  )}
                  <Text style={[s.optionBullet, mine && s.optionTextMine]}>
                    {String.fromCharCode(65 + i)}
                  </Text>
                  <Text style={[s.optionText, mine && s.optionTextMine]}>{opt}</Text>
                  {mine && <Feather name="check" size={13} color={GOLD} />}
                  {totalVotes > 0 && (
                    <Text style={[s.optionPct, mine && s.optionTextMine]}>{pct}%</Text>
                  )}
                </TouchableOpacity>
              );
            })}
            {totalVotes > 0 && (
              <Text style={s.voteTally}>
                {totalVotes} {totalVotes === 1 ? 'vote' : 'votes'}
              </Text>
            )}
          </View>
        )}
      </>
    );
  };

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
      <View style={[s.nav, { height: navBottom }]}>
        <View style={s.navRow}>
          <View style={s.navLeft}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.75}>
              <Image source={NAV_DAGGER} style={s.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={s.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          <Text style={s.navTitle} numberOfLines={1}>Ante</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Folder ── */}
      <View style={[s.folderWrap, { top: navBottom + 10 }]}>
        <View style={s.tabsRow}>
          <TouchableOpacity
            style={[s.tab, isPlace && s.tabActive]}
            onPress={() => switchBoard('place')}
            activeOpacity={0.8}
          >
            <Text style={[s.tabText, isPlace && s.tabTextActive]} numberOfLines={1}>
              PLACE ANTE
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, !isPlace && s.tabActive]}
            onPress={() => switchBoard('raised')}
            activeOpacity={0.8}
          >
            <Text style={[s.tabText, !isPlace && s.tabTextActive]} numberOfLines={1}>
              RAISED ANTE
            </Text>
          </TouchableOpacity>
        </View>

        <View style={s.body}>
          {loading ? (
            <View style={s.centerFill}>
              <ActivityIndicator size="large" color={GOLD} />
            </View>
          ) : posts.length === 0 ? (
            <View style={s.centerFill}>
              <Feather name="file-text" size={30} color="rgba(212,168,83,0.25)" />
              <Text style={s.emptyText}>
                {isPlace ? 'No antes placed yet.' : 'No raised antes yet.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={posts}
              keyExtractor={p => p.id}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => {
                const reactionTotal = Object.values(item.reactions ?? {})
                  .reduce((n, uids) => n + uids.length, 0);
                return (
                  <Pressable
                    style={s.postCard}
                    onPress={() => { setPickerTarget(null); setComments([]); setOpenPostId(item.id); }}
                  >
                    {renderSenderHead(item.senderUid, item.createdAt)}
                    {renderPostBody(item)}
                    <View style={s.postFootRow}>
                      <View style={s.footBtn}>
                        <Feather name="message-circle" size={13} color="rgba(212,168,83,0.7)" />
                        <Text style={s.footMeta}>
                          {item.commentCount} {item.commentCount === 1 ? 'comment' : 'comments'}
                        </Text>
                      </View>
                      {reactionTotal > 0 && (
                        <View style={s.footBtn}>
                          <Feather name="smile" size={13} color="rgba(212,168,83,0.7)" />
                          <Text style={s.footMeta}>{reactionTotal}</Text>
                        </View>
                      )}
                      <Text style={s.footHint}>Tap to open</Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          )}

          <TouchableOpacity style={s.actionBtn} onPress={openCompose} activeOpacity={0.85}>
            <Text style={s.actionBtnText}>
              {isPlace ? 'THROW DOWN' : 'STANDOFF'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Compose card (full-screen framed card) ── */}
      <Modal
        visible={composeVisible}
        animationType="fade"
        transparent={true}
        onRequestClose={() => setComposeVisible(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.cardOverlay}
        >
          <View style={s.card}>
            {/* Frame image at native proportions */}
            <Image
              source={CARD_FRAME}
              style={{ width: CARD_W, height: CARD_H }}
              resizeMode="stretch"
            />

            {/* Scrollable content inside the frame borders */}
            <ScrollView
              style={{
                position: 'absolute',
                top: CARD_TOP, bottom: CARD_BOT,
                left: CARD_SIDE, right: CARD_SIDE,
              }}
              contentContainerStyle={s.cardInner}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              <Text style={s.fieldLabelCenter}>{isPlace ? 'Call It' : 'Set the Terms'}</Text>
              <TextInput
                style={s.titleInput}
                placeholder="Title"
                placeholderTextColor="rgba(237,224,196,0.4)"
                value={title}
                onChangeText={setTitle}
                maxLength={200}
              />

              <Text style={s.fieldLabelCenter}>{isPlace ? "What's The Ante" : 'Take your stance'}</Text>
              <TextInput
                style={[s.descInput, !isPlace && s.descInputTall]}
                placeholder={isPlace ? 'Description' : "What's your opinion?"}
                placeholderTextColor="rgba(237,224,196,0.4)"
                value={description}
                onChangeText={setDescription}
                multiline
                textAlignVertical="top"
              />

              {isPlace && OPTION_LABELS.map((label, i) => (
                <View key={label}>
                  <Text style={s.fieldLabelLeft}>{label.toUpperCase()}</Text>
                  <TextInput
                    style={s.optionInput}
                    placeholderTextColor="rgba(237,224,196,0.4)"
                    value={options[i]}
                    onChangeText={t =>
                      setOptions(prev => prev.map((o, j) => (j === i ? t : o)))
                    }
                  />
                </View>
              ))}

              <View style={s.cardBtnRow}>
                <TouchableOpacity
                  style={[s.cardBtn, (!title.trim() || posting) && s.cardBtnDisabled]}
                  onPress={submitPost}
                  disabled={!title.trim() || posting}
                  activeOpacity={0.85}
                >
                  {posting
                    ? <ActivityIndicator color={GOLD} size="small" />
                    : <Text style={s.cardBtnText}>{isPlace ? `Drop The\nAnte` : 'Raise'}</Text>
                  }
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.cardBtn}
                  onPress={() => setComposeVisible(false)}
                  activeOpacity={0.85}
                >
                  <Text style={s.cardBtnText}>Void</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Comments modal ── */}
      <Modal
        visible={!!openPostId}
        animationType="slide"
        transparent={true}
        onRequestClose={() => { setPickerTarget(null); setOpenPostId(null); }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.commentsOverlay}
        >
          <View style={[s.commentsSheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle} numberOfLines={1}>
                {openPost?.title || 'Ante'}
              </Text>
              {openPost && (
                <TouchableOpacity
                  onPress={toggleMute}
                  activeOpacity={0.7}
                  style={{ marginRight: 14 }}
                  accessibilityLabel={isMuted ? 'Unmute thread' : 'Mute thread'}
                >
                  <View style={{ width: 26, height: 26 }}>
                    <Image
                      source={NAV_BELL}
                      style={{ width: 26, height: 26, opacity: isMuted ? 0.35 : 1 }}
                      resizeMode="contain"
                    />
                    {isMuted && <View style={s.bellSlash} />}
                  </View>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => { setPickerTarget(null); setOpenPostId(null); }} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>

            <FlatList
              data={comments}
              keyExtractor={c => c.id}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              ListHeaderComponent={openPost ? (
                <>
                  <Pressable
                    style={[s.postCard, { marginBottom: 14 }]}
                    onLongPress={() => openPicker({ kind: 'post', postId: openPost.id })}
                  >
                    {renderSenderHead(openPost.senderUid, openPost.createdAt)}
                    {renderPostBody(openPost)}
                    {renderReactionsRow(openPost.reactions, { kind: 'post', postId: openPost.id })}
                    <View style={s.postFootRow}>
                      <TouchableOpacity
                        style={s.footBtn}
                        onPress={() => openPicker({ kind: 'post', postId: openPost.id })}
                        activeOpacity={0.7}
                      >
                        <Feather name="smile" size={14} color={GOLD} />
                        <Text style={s.footBtnText}>React</Text>
                      </TouchableOpacity>
                    </View>
                  </Pressable>
                  <Text style={s.commentsSectionTitle}>SPEAK YOUR PIECE</Text>
                </>
              ) : null}
              ListEmptyComponent={
                commentsLoading ? (
                  <ActivityIndicator color={GOLD} style={{ marginTop: 20 }} />
                ) : (
                  <Text style={s.noComments}>No one has spoken yet. Speak your piece.</Text>
                )
              }
              renderItem={({ item }) => (
                <Pressable
                  style={s.commentCard}
                  onLongPress={() => openPostId && openPicker({
                    kind: 'comment', postId: openPostId, commentId: item.id,
                  })}
                >
                  {renderSenderHead(item.senderUid, item.createdAt)}
                  <Text style={s.postText}>{item.text}</Text>
                  {openPostId ? renderReactionsRow(item.reactions, {
                    kind: 'comment', postId: openPostId, commentId: item.id,
                  }) : null}
                </Pressable>
              )}
            />

            <View style={s.commentInputRow}>
              <TextInput
                style={s.commentInput}
                placeholder="Speak your piece…"
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={commentText}
                onChangeText={setCommentText}
                multiline
              />
              <TouchableOpacity
                style={[s.sendBtn, (!commentText.trim() || commenting) && s.cardBtnDisabled]}
                onPress={submitComment}
                disabled={!commentText.trim() || commenting}
                activeOpacity={0.8}
              >
                {commenting
                  ? <ActivityIndicator color={GOLD} size="small" />
                  : <Text style={s.sendBtnText}>SPEAK</Text>
                }
              </TouchableOpacity>
            </View>
          </View>

          {/* Reaction picker inside comments modal */}
          {pickerTarget && (
            <Pressable style={s.pickerBackdrop} onPress={() => setPickerTarget(null)}>
              <View style={s.reactionPicker}>
                {REACTION_EMOJIS.map(emoji => (
                  <TouchableOpacity key={emoji} onPress={() => applyReaction(emoji)} activeOpacity={0.7}>
                    <Text style={s.pickerEmoji}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
                {canDeletePickerTarget && (
                  <TouchableOpacity style={s.pickerDeleteBtn} onPress={deleteFromPicker} activeOpacity={0.7}>
                    <Feather name="trash-2" size={15} color="#e05555" />
                    <Text style={s.pickerDeleteText}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
            </Pressable>
          )}
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Reaction picker (main feed) ── */}
      {pickerTarget && !openPostId && (
        <Pressable style={s.pickerBackdrop} onPress={() => setPickerTarget(null)}>
          <View style={s.reactionPicker}>
            {REACTION_EMOJIS.map(emoji => (
              <TouchableOpacity key={emoji} onPress={() => applyReaction(emoji)} activeOpacity={0.7}>
                <Text style={s.pickerEmoji}>{emoji}</Text>
              </TouchableOpacity>
            ))}
            {canDeletePickerTarget && (
              <TouchableOpacity style={s.pickerDeleteBtn} onPress={deleteFromPicker} activeOpacity={0.7}>
                <Feather name="trash-2" size={15} color="#e05555" />
                <Text style={s.pickerDeleteText}>Delete</Text>
              </TouchableOpacity>
            )}
          </View>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { ...MARBLE_TEXT_SHADOW, flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  folderWrap: {
    position: 'absolute', left: SIDE, right: SIDE, bottom: SIDE,
    width: FOLDER_W,
  },
  tabsRow: { flexDirection: 'row', gap: 6 },
  tab: {
    flex: 1, height: TAB_H,
    backgroundColor: '#080808',
    borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.18)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 10,
  },
  tabActive: {
    backgroundColor: '#0D0D0D',
    borderColor: 'rgba(200,165,60,0.4)',
  },
  tabText: {
    ...MARBLE_TEXT_SHADOW,
    color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 11, letterSpacing: 1.5,
  },
  tabTextActive: { color: CREAM },

  body: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText:  { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, opacity: 0.45 },

  // Post cards
  postCard: {
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    padding: 12, marginBottom: 10,
  },
  postHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  postAvatar: {
    width: 30, height: 30, borderRadius: 15, overflow: 'hidden',
    backgroundColor: 'rgba(200,165,60,0.12)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  postAvatarImg:  { width: 30, height: 30, borderRadius: 15 },
  postAvatarText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10 },
  postSender: { flex: 1, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1 },
  postTime:   { color: 'rgba(237,224,196,0.3)', fontFamily: 'Cinzel_400Regular', fontSize: 10 },
  postTitle:  { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1, marginBottom: 6 },
  postText:   { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13, lineHeight: 20 },

  optionsWrap: { marginTop: 8, gap: 6 },
  optionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: 'rgba(200,165,60,0.06)',
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    paddingVertical: 8, paddingHorizontal: 10,
    overflow: 'hidden',
  },
  optionRowMine: { borderColor: 'rgba(212,168,83,0.6)', backgroundColor: 'rgba(212,168,83,0.08)' },
  optionFill: {
    position: 'absolute', left: 0, top: 0, bottom: 0,
    backgroundColor: 'rgba(200,165,60,0.14)',
  },
  optionFillMine: { backgroundColor: 'rgba(212,168,83,0.24)' },
  optionBullet: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, width: 16, textAlign: 'center' },
  optionText:   { flex: 1, color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12, lineHeight: 18 },
  optionTextMine: { color: GOLD },
  optionPct: { color: 'rgba(237,224,196,0.7)', fontFamily: 'Cinzel_700Bold', fontSize: 11, minWidth: 34, textAlign: 'right' },
  voteTally: { color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_400Regular', fontSize: 10, marginTop: 2 },

  postFootRow: {
    flexDirection: 'row', gap: 18, marginTop: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(200,165,60,0.12)', paddingTop: 8,
  },
  footBtn:     { flexDirection: 'row', alignItems: 'center', gap: 5 },
  footBtnText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 0.5 },
  footMeta:    { color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_400Regular', fontSize: 10 },
  footHint:    { flex: 1, textAlign: 'right', color: 'rgba(237,224,196,0.25)', fontFamily: 'Cinzel_400Regular', fontSize: 9, letterSpacing: 0.5 },

  // Reactions
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 },
  reactionPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12, borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    paddingHorizontal: 7, paddingVertical: 3,
  },
  reactionPillOwn: { borderColor: 'rgba(212,168,83,0.45)', backgroundColor: 'rgba(212,168,83,0.1)' },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { color: CREAM, fontSize: 9 },

  pickerBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', zIndex: 50,
  },
  bellSlash: {
    position: 'absolute', left: 12, top: -2,
    width: 2, height: 30, borderRadius: 1,
    backgroundColor: 'rgba(237,224,196,0.8)',
    transform: [{ rotate: '45deg' }],
  },
  pickerDeleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, width: '100%', paddingVertical: 7, marginTop: 4,
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.35)',
  },
  pickerDeleteText: {
    color: '#e05555', fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 0.5,
  },
  reactionPicker: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 10, maxWidth: 300,
    backgroundColor: '#0D0B08',
    borderRadius: 14, borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)',
    padding: 14, justifyContent: 'center',
  },
  pickerEmoji: { fontSize: 24 },

  // Bottom action button
  actionBtn: {
    height: 50, borderRadius: 10, marginTop: 10,
    backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2.5 },

  // ── Compose card (framed) ──
  cardOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  card: {
    width: CARD_W, height: CARD_H,
  },
  cardInner: {
    paddingHorizontal: 4,
    paddingTop: 14,
    paddingBottom: 16,
  },
  fieldLabelCenter: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12,
    letterSpacing: 2, textAlign: 'center', marginBottom: 6, marginTop: 10,
  },
  fieldLabelLeft: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11,
    letterSpacing: 1.5, marginBottom: 5, marginTop: 12,
  },
  titleInput: {
    height: 42,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12, textAlign: 'center',
  },
  descInput: {
    minHeight: 130, maxHeight: 190,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    padding: 12,
  },
  descInputTall: { minHeight: 220, maxHeight: 300 },
  optionInput: {
    height: 40,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12,
  },
  cardBtnRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 22, gap: 14,
  },
  cardBtn: {
    flex: 1, minHeight: 52, borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.55)',
    alignItems: 'center', justifyContent: 'center', paddingVertical: 8,
  },
  cardBtnDisabled: { opacity: 0.4 },
  cardBtnText: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12,
    letterSpacing: 1.5, textAlign: 'center', lineHeight: 18,
  },

  // ── Comments modal ──
  commentsOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  commentsSheet: {
    height: SH * 0.82,
    backgroundColor: '#0D0B08',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.25)',
    padding: 16,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 12, gap: 12,
  },
  modalTitle: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 1.5 },
  commentsSectionTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11,
    letterSpacing: 1.5, marginBottom: 10,
  },
  noComments: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_400Regular',
    fontSize: 12, textAlign: 'center', marginTop: 16,
  },
  commentCard: {
    backgroundColor: 'rgba(200,165,60,0.05)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.14)',
    padding: 10, marginBottom: 8,
  },
  commentInputRow: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 8,
  },
  commentInput: {
    flex: 1, minHeight: 42, maxHeight: 110,
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  sendBtn: {
    minWidth: 66, height: 44, borderRadius: 10, paddingHorizontal: 12,
    backgroundColor: 'rgba(200,165,60,0.12)',
    borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtnText: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.2,
  },
});
