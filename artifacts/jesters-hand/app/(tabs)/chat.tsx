import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Platform, Image, TextInput,
  ActivityIndicator, Pressable, Alert,
  Keyboard, useWindowDimensions,
} from 'react-native';
import { Feather } from '@/components/FIcon';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { uploadChatImage } from '@/lib/chatMediaService';
import { useAuth } from '@/contexts/AuthContext';
import { useWhisper } from '@/contexts/WhisperContext';
import {
  Message, Conversation, Member,
  listenMessages, sendMessage, toggleReaction, markRead,
  getConvDisplayName, formatTimestamp, deleteChatMessage,
  getAllMembers, addMembersToGroup, claimLegacyGroupOwnership,
} from '@/lib/whisperService';
import BellNavIcon from '@/components/BellNavIcon';
import GroupAvatarCollage from '@/components/GroupAvatarCollage';
import ReportCardModal from '@/components/ReportCardModal';
import ChatImageViewer from '@/components/ChatImageViewer';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { useAppDimensions } from '@/lib/appWindow';

// ── Assets ────────────────────────────────────────────────────────────────────
const NAV_DAGGER     = require('../../assets/images/nav_dagger.png');
const NAV_CARDS      = require('../../assets/images/nav_cards.png');
const MARBLE         = require('../../assets/images/lace_bg.png');
const WHISPER_FRAME  = require('../../assets/images/whisper_frame.png');

// ── Layout constants (screen-size-independent) ────────────────────────────────
const PANEL_MARGIN  = 12;
const FRAME_RATIO   = 1536 / 1024;   // image aspect ratio (native, never stretched)
const WHISPER_BTN_W = 54;

const NAV_H = 52;
const GOLD  = '#D4A853';
const CREAM = '#EDE0C4';

const REACTION_EMOJIS = ['👍', '👎', '👑', '🎭', '😢', '😂', '🖤', '🤍', '🔥', '🗡', '👀', '🃏', '♠️', '♣️', '♥️', '♦️', '🐾'];

export default function ChatScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  // ── Reactive layout: re-derive panel dimensions whenever the keyboard changes
  // the available viewport (Android resize mode) or on iOS via explicit tracking.
  const { width: dynW, height: dynH } = useAppDimensions();
  const [kbHeight, setKbHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvt, e => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener(hideEvt, () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const effectiveSH = dynH - kbHeight;
  // Frame kept at its native aspect ratio: if height is the limit, width
  // shrinks to match so the artwork is never stretched.
  const PANEL_H    = Math.min(
    Math.round((dynW - PANEL_MARGIN * 2) * FRAME_RATIO),
    effectiveSH - 140,
  );
  const PANEL_W    = Math.round(PANEL_H / FRAME_RATIO);
  // Insets measured from the 1024×1536 bronze frame artwork.
  const SIDE_PAD   = Math.round(PANEL_W * 0.098);
  const MSG_TOP    = Math.round(PANEL_H * 0.105);
  const INPUT_H    = Math.round(PANEL_H * 0.065);
  const INPUT_BOT  = Math.round(PANEL_H * 0.155);
  const MSG_BOTTOM = INPUT_H + INPUT_BOT + 6;

  const { user, isAdmin } = useAuth();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const flatListRef = useRef<FlatList>(null);

  const [messages,     setMessages]     = useState<Message[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);

  // Shared live member caches from WhisperContext — one app-wide listener
  // keeps names + avatars fresh on every screen, so a Joker's updated mug
  // photo shows here immediately without remounting.
  const { memberCache: labelCache, avatarCache } = useWhisper();
  const [inputText,    setInputText]    = useState('');
  const [sending,      setSending]      = useState(false);
  const [pickerMsgId,  setPickerMsgId]  = useState<string | null>(null);
  const [pickerPos,    setPickerPos]    = useState({ top: 0, left: 0 });
  const [viewedImageUrl, setViewedImageUrl] = useState<string | null>(null);

  // The Card — file a report on your whisper partner (1:1 chats only)
  const [cardVisible, setCardVisible] = useState(false);

  // Add-members modal (group creator only)
  const [showAddModal, setShowAddModal] = useState(false);
  const [allMembers,   setAllMembers]   = useState<Member[]>([]);
  const [selectedAdd,  setSelectedAdd]  = useState<Set<string>>(new Set());
  const [addingMembers, setAddingMembers] = useState(false);

  const isGroupCreator = !!conversation?.isGroup
    && !!user && conversation.createdBy === user.uid;

  const openAddModal = useCallback(async () => {
    setSelectedAdd(new Set());
    setShowAddModal(true);
    try { setAllMembers(await getAllMembers()); }
    catch (e) { console.error('[Chat] load members error:', e); }
  }, []);

  const handleAddMembers = useCallback(async () => {
    if (!conversationId || !conversation || selectedAdd.size === 0 || addingMembers) return;
    setAddingMembers(true);
    try {
      const uids = Array.from(selectedAdd);
      await addMembersToGroup(conversationId, uids, user!.uid, conversation.groupName ?? 'Group');
      setShowAddModal(false);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e) {
      console.error('[Chat] add members error:', e);
      Alert.alert('Could not add members', 'Only the group\'s creator may add members.');
    } finally {
      setAddingMembers(false);
    }
  }, [conversationId, conversation, selectedAdd, addingMembers]);

  // Auth guard
  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  // Live conversation metadata — keeps createdBy (ownership) fresh when it
  // transfers, so the owner indicator and add-member button update in place.
  useEffect(() => {
    if (!conversationId) return;
    let backfillAttempted = false;
    const unsub = onSnapshot(doc(db, 'conversations', conversationId), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      const memberUids: string[] = d.memberUids ?? [];
      const createdBy: string | undefined = d.createdBy;

      // Legacy group (created before ownership existed): backfill createdBy
      // with the first member. Rules only allow this exact one-time write,
      // so it's safe for any member to trigger it on open. The snapshot
      // listener picks up the new createdBy automatically.
      if (d.isGroup === true && !createdBy && memberUids.length > 0 && !backfillAttempted) {
        backfillAttempted = true;
        claimLegacyGroupOwnership(snap.id, memberUids[0]).catch(e => {
          // Non-fatal (e.g. another member won the race and it's now set).
          console.warn('[Chat] legacy ownership backfill skipped:', e);
        });
      }

      setConversation({
        id:            snap.id,
        memberUids,
        isGroup:       d.isGroup       ?? false,
        groupName:     d.groupName,
        createdBy,
        lastMessage:   d.lastMessage   ?? '',
        lastMessageAt: d.lastMessageAt ?? null,
        unreadCounts:  d.unreadCounts  ?? {},
      });
    }, console.error);
    return unsub;
  }, [conversationId]);

  // Real-time messages
  useEffect(() => {
    if (!conversationId) return;
    const unsub = listenMessages(conversationId, msgs => setMessages(msgs));
    return unsub;
  }, [conversationId]);

  // Mark as read when messages update
  useEffect(() => {
    if (conversationId && user && messages.length > 0)
      markRead(conversationId, user.uid).catch(() => {});
  }, [conversationId, user, messages.length]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (messages.length > 0)
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages.length]);

  const handleSend = useCallback(async () => {
    if (!user || !conversationId || !inputText.trim() || sending) return;
    setSending(true);
    const text = inputText.trim();
    setInputText('');
    try {
      await sendMessage(conversationId, user.uid, text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e) {
      console.error('[Chat] send error:', e);
      setInputText(text);
    } finally {
      setSending(false);
    }
  }, [user, conversationId, inputText, sending]);

  // Pick a photo/GIF and send it (with any typed text as the caption).
  const handleAttach = useCallback(async () => {
    if (!user || !conversationId || sending) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85,
    });
    if (res.canceled || !res.assets[0]) return;
    setSending(true);
    const text = inputText.trim();
    setInputText('');
    try {
      const url = await uploadChatImage(user.uid, res.assets[0].uri, res.assets[0].mimeType);
      await sendMessage(conversationId, user.uid, text, url);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e) {
      console.error('[Chat] attach error:', e);
      setInputText(text);
    } finally {
      setSending(false);
    }
  }, [user, conversationId, inputText, sending]);

  const handleReact = useCallback(async (emoji: string) => {
    if (!user || !pickerMsgId || !conversationId) return;
    setPickerMsgId(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await toggleReaction(conversationId, pickerMsgId, user.uid, emoji).catch(console.error);
  }, [user, pickerMsgId, conversationId]);

  const navTitle = conversation
    ? getConvDisplayName(conversation, user?.uid ?? '', labelCache)
    : '…';

  // Group owner (createdBy) — shown to all members so they know who can add people
  const ownerUid = conversation?.isGroup ? conversation.createdBy : undefined;
  const ownerLabel = ownerUid
    ? (ownerUid === user?.uid ? 'You' : labelCache[ownerUid] ?? ownerUid.slice(0, 6))
    : null;

  // For DMs, the other member's uid (for the header avatar)
  const dmPartnerUid = conversation && !conversation.isGroup
    ? conversation.memberUids.find(u => u !== user?.uid) ?? null
    : null;
  const dmPartnerAvatar = dmPartnerUid ? avatarCache[dmPartnerUid] : undefined;
  const dmPartnerLabel  = dmPartnerUid ? labelCache[dmPartnerUid] : undefined;

  // ── Render one message bubble ─────────────────────────────────────────────
  const renderMessage = useCallback(({ item: msg, index }: { item: Message; index: number }) => {
    const isOwn        = msg.senderUid === user?.uid;
    const senderLabel  = labelCache[msg.senderUid] ?? msg.senderUid.slice(0, 6);
    const senderAvatar = avatarCache[msg.senderUid];
    const prevMsg      = messages[index - 1];
    const showSender   = !isOwn && (!prevMsg || prevMsg.senderUid !== msg.senderUid);
    const timeStr      = formatTimestamp(msg.sentAt);
    const reactionEntries = Object.entries(msg.reactions).filter(([, uids]) => uids.length > 0);
    const maxBubbleW   = PANEL_W - SIDE_PAD * 2 - 24;

    return (
      <View style={[s.msgWrap, isOwn ? s.msgWrapOwn : s.msgWrapOther]}>
        {showSender && (
          <View style={s.senderRow}>
            {senderAvatar ? (
              <Image source={{ uri: senderAvatar }} style={s.senderAvatar} />
            ) : (
              <View style={[s.senderAvatar, s.senderAvatarFallback]}>
                <Text style={s.senderAvatarInitial}>
                  {senderLabel.charAt(0).toUpperCase()}
                </Text>
              </View>
            )}
            <Text style={s.senderLabel}>{senderLabel}</Text>
          </View>
        )}

        <Pressable
          onLongPress={(e) => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
            const pageY = (e.nativeEvent as any).pageY ?? 200;
            setPickerPos({
              top:  Math.max(pageY - 60, navBottom + 10),
              left: isOwn ? dynW - 260 : PANEL_MARGIN + SIDE_PAD,
            });
            setPickerMsgId(msg.id);
          }}
          style={[s.bubble, isOwn ? s.bubbleOwn : s.bubbleOther, { maxWidth: maxBubbleW }]}
        >
          {msg.imageUrl ? (
            <TouchableOpacity
              onPress={() => setViewedImageUrl(msg.imageUrl!)}
              activeOpacity={0.86}
              accessibilityRole="imagebutton"
              accessibilityLabel="View full image"
            >
              <Image
                source={{ uri: msg.imageUrl }}
                style={[s.bubbleImage, { width: Math.min(maxBubbleW - 8, 220) }]}
                resizeMode="cover"
              />
            </TouchableOpacity>
          ) : null}
          {msg.text ? (
            <Text style={[s.bubbleText, isOwn ? s.bubbleTextOwn : s.bubbleTextOther]}>
              {msg.text}
            </Text>
          ) : null}
        </Pressable>

        {reactionEntries.length > 0 && (
          <View style={[s.reactionsRow, isOwn && s.reactionsRowOwn]}>
            {reactionEntries.map(([emoji, uids]) => (
              <TouchableOpacity
                key={emoji}
                style={[s.reactionPill, uids.includes(user?.uid ?? '') && s.reactionPillOwn]}
                onPress={() => {
                  if (user && conversationId)
                    toggleReaction(conversationId, msg.id, user.uid, emoji).catch(console.error);
                }}
                activeOpacity={0.75}
              >
                <Text style={s.reactionEmoji}>{emoji}</Text>
                <Text style={s.reactionCount}>{uids.length}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {timeStr ? (
          <Text style={[s.msgTime, isOwn ? s.msgTimeOwn : s.msgTimeOther]}>{timeStr}</Text>
        ) : null}
      </View>
    );
  }, [user, labelCache, avatarCache, messages, conversationId, navBottom]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <View style={s.root}>
      {/* Marble background */}
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Nav bar */}
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
          <View style={s.navCenter}>
            {conversation?.isGroup && (
              <GroupAvatarCollage
                memberUids={conversation.memberUids.filter(u => u !== user?.uid)}
                avatarCache={avatarCache}
                memberCache={labelCache}
                size={30}
              />
            )}
            {dmPartnerUid && (
              dmPartnerAvatar ? (
                <Image source={{ uri: dmPartnerAvatar }} style={s.navAvatar} />
              ) : (
                <View style={[s.navAvatar, s.navAvatarFallback]}>
                  <Text style={s.navAvatarInitial}>
                    {(dmPartnerLabel ?? navTitle).charAt(0).toUpperCase()}
                  </Text>
                </View>
              )
            )}
            {conversation?.isGroup ? (
              <View style={s.navTitleCol}>
                <Text style={s.navTitle} numberOfLines={1}>{navTitle}</Text>
                {ownerLabel && (
                  <Text style={s.navOwner} numberOfLines={1}>👑 {ownerLabel}</Text>
                )}
              </View>
            ) : (
              <Text style={s.navTitle} numberOfLines={1}>{navTitle}</Text>
            )}
          </View>
          <View style={s.navRight}>
            {dmPartnerUid && (
              <TouchableOpacity
                onPress={() => setCardVisible(true)}
                activeOpacity={0.8}
                style={s.cardBtn}
              >
                <Text style={s.cardBtnText}>CARD</Text>
              </TouchableOpacity>
            )}
            {isGroupCreator && (
              <TouchableOpacity onPress={openAddModal} activeOpacity={0.75} style={s.addMemberBtn}>
                <Feather name="user-plus" size={18} color={GOLD} />
              </TouchableOpacity>
            )}
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Whisper frame + overlaid content ── */}
      <View style={[s.frameContainer, { top: navBottom + 10, left: Math.round((dynW - PANEL_W) / 2) }]}>

        {/* Frame image */}
        <Image
          source={WHISPER_FRAME}
          style={{ width: PANEL_W, height: PANEL_H }}
          resizeMode="stretch"
        />

        {/* Messages — scrollable area inside frame body */}
        <View
          style={{
            position: 'absolute',
            top:    MSG_TOP,
            bottom: MSG_BOTTOM,
            left:   SIDE_PAD,
            right:  SIDE_PAD,
          }}
        >
          <FlatList
            ref={flatListRef}
            data={messages}
            keyExtractor={m => m.id}
            renderItem={renderMessage}
            contentContainerStyle={s.msgListContent}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={
              <View style={s.emptyWrap}>
                <Text style={s.emptyText}>Deal the first message in Pocket.</Text>
              </View>
            }
          />
        </View>

        {/* Dark backdrop behind the input bar */}
        <View style={[s.inputCover, {
          bottom: INPUT_BOT - 5,
          left:   SIDE_PAD - 6,
          right:  SIDE_PAD - 6,
          height: INPUT_H + 10,
        }]} />

        {/* Real input bar — overlaid on top of the cover */}
        <View
          style={[
            s.inputBar,
            {
              bottom: INPUT_BOT,
              left:   SIDE_PAD,
              right:  SIDE_PAD,
              height: INPUT_H,
            },
          ]}
        >
          <TouchableOpacity
            style={s.attachBtn}
            onPress={handleAttach}
            disabled={sending}
            activeOpacity={0.75}
          >
            <Feather name="image" size={18} color={sending ? 'rgba(212,168,83,0.35)' : GOLD} />
          </TouchableOpacity>
          <TextInput
            style={[s.textInput, { height: INPUT_H - 4 }]}
            value={inputText}
            onChangeText={setInputText}
            placeholder="Deal a message…"
            placeholderTextColor="rgba(237,224,196,0.28)"
            returnKeyType="send"
            onSubmitEditing={handleSend}
            blurOnSubmit={false}
          />
          <TouchableOpacity
            style={[s.whisperBtn, { height: INPUT_H - 4 }, (!inputText.trim() || sending) && s.whisperBtnOff]}
            onPress={handleSend}
            disabled={!inputText.trim() || sending}
            activeOpacity={0.8}
          >
            {sending
              ? <ActivityIndicator size="small" color={GOLD} />
              : <Text style={s.whisperBtnText}>Deal</Text>
            }
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Add-members modal (group creator only) ── */}
      {showAddModal && (
        <Pressable style={[StyleSheet.absoluteFill, s.addModalBackdrop]} onPress={() => setShowAddModal(false)}>
          <Pressable style={s.addModal} onPress={() => {}}>
            <Text style={s.addModalTitle}>ADD JOKERS</Text>
            <FlatList
              data={allMembers.filter(m =>
                m.uid !== user?.uid && !conversation?.memberUids.includes(m.uid))}
              keyExtractor={m => m.uid}
              style={s.addModalList}
              ListEmptyComponent={
                <Text style={s.addModalEmpty}>Everyone is already in this group.</Text>
              }
              renderItem={({ item: m }) => {
                const selected = selectedAdd.has(m.uid);
                return (
                  <TouchableOpacity
                    style={[s.addMemberRow, selected && s.addMemberRowSelected]}
                    activeOpacity={0.75}
                    onPress={() => {
                      setSelectedAdd(prev => {
                        const next = new Set(prev);
                        if (next.has(m.uid)) next.delete(m.uid); else next.add(m.uid);
                        return next;
                      });
                    }}
                  >
                    {m.mugUrl ? (
                      <Image source={{ uri: m.mugUrl }} style={s.addMemberAvatar} />
                    ) : (
                      <View style={[s.addMemberAvatar, s.navAvatarFallback]}>
                        <Text style={s.navAvatarInitial}>
                          {(m.name ?? m.jokerId ?? '?').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <Text style={s.addMemberName} numberOfLines={1}>
                      {m.jokerId || m.name || m.uid.slice(0, 6)}
                    </Text>
                    <Feather
                      name={selected ? 'check-circle' : 'circle'}
                      size={18}
                      color={selected ? GOLD : 'rgba(237,224,196,0.3)'}
                    />
                  </TouchableOpacity>
                );
              }}
            />
            <TouchableOpacity
              style={[s.addConfirmBtn, (selectedAdd.size === 0 || addingMembers) && s.whisperBtnOff]}
              onPress={handleAddMembers}
              disabled={selectedAdd.size === 0 || addingMembers}
              activeOpacity={0.8}
            >
              {addingMembers
                ? <ActivityIndicator size="small" color={GOLD} />
                : <Text style={s.addConfirmText}>
                    {selectedAdd.size > 0 ? `ADD ${selectedAdd.size}` : 'ADD'}
                  </Text>
              }
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      )}

      {/* ── Reaction picker (full-screen overlay) ── */}
      {pickerMsgId && (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerMsgId(null)}>
          <View style={[s.reactionPicker, { top: pickerPos.top, left: pickerPos.left }]}>
            {REACTION_EMOJIS.map(emoji => (
              <TouchableOpacity
                key={emoji}
                style={s.pickerEmoji}
                onPress={() => handleReact(emoji)}
                activeOpacity={0.7}
              >
                <Text style={s.pickerEmojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
            {(() => {
              const msg = messages.find(m => m.id === pickerMsgId);
              const canDelete = !!msg && (msg.senderUid === user?.uid || isAdmin);
              if (!canDelete) return null;
              return (
                <TouchableOpacity
                  style={s.pickerDeleteBtn}
                  onPress={() => {
                    const id = pickerMsgId;
                    setPickerMsgId(null);
                    Alert.alert('Delete message?', 'This cannot be undone.', [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete', style: 'destructive',
                        onPress: () => {
                          if (conversationId) deleteChatMessage(conversationId, id!).catch(console.error);
                        },
                      },
                    ]);
                  }}
                  activeOpacity={0.7}
                >
                  <Feather name="trash-2" size={15} color="#e05555" />
                  <Text style={s.pickerDeleteText}>Delete</Text>
                </TouchableOpacity>
              );
            })()}
          </View>
        </Pressable>
      )}

      <ChatImageViewer uri={viewedImageUrl} onClose={() => setViewedImageUrl(null)} />

      {/* The Card — file a report on your whisper partner */}
      {dmPartnerUid && (
        <ReportCardModal
          visible={cardVisible}
          onClose={() => setCardVisible(false)}
          reportedUid={dmPartnerUid}
          reportedLabel={dmPartnerLabel ?? navTitle}
        />
      )}
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: '#000', zIndex: 20,
  },
  navRow: {
    flex: 1, flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 10, paddingBottom: 8,
  },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navCenter: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 8,
  },
  navTitle: {
    ...MARBLE_TEXT_SHADOW,
    flexShrink: 1, textAlign: 'center',
    color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1.5,
  },
  navTitleCol: { flexShrink: 1, alignItems: 'center' },
  navOwner: {
    ...MARBLE_TEXT_SHADOW,
    color: 'rgba(212,168,83,0.75)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 8, letterSpacing: 1, marginTop: 1,
  },
  navAvatar: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
  },
  navAvatarFallback: {
    backgroundColor: 'rgba(212,168,83,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  navAvatarInitial: {
    color: 'rgba(212,168,83,0.85)', fontSize: 13,
    fontFamily: 'Cinzel_700Bold',
  },
  dagIcon: { width: 48, height: 26 },
  sqIcon:  { width: 34, height: 34 },

  frameContainer: { position: 'absolute' },

  msgListContent: { paddingVertical: 4 },

  emptyWrap: { paddingTop: 40, alignItems: 'center' },
  emptyText: {
    ...MARBLE_TEXT_SHADOW,
    color: 'rgba(237,224,196,0.3)',
    fontFamily: 'Cinzel_400Regular', fontSize: 11,
  },

  // Message bubbles
  msgWrap:      { marginBottom: 6, maxWidth: '85%' },
  msgWrapOwn:   { alignSelf: 'flex-end', alignItems: 'flex-end' },
  msgWrapOther: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  senderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    marginBottom: 3, marginLeft: 2,
  },
  senderAvatar: {
    width: 18, height: 18, borderRadius: 9,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  senderAvatarFallback: {
    backgroundColor: 'rgba(212,168,83,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  senderAvatarInitial: {
    color: 'rgba(212,168,83,0.8)', fontSize: 8,
    fontFamily: 'Cinzel_700Bold',
  },
  senderLabel: {
    color: 'rgba(212,168,83,0.65)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 9, letterSpacing: 1,
  },
  bubble: {
    borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8,
  },
  bubbleOwn: {
    backgroundColor: 'rgba(140,88,15,0.6)',
    borderBottomRightRadius: 3,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  bubbleOther: {
    backgroundColor: 'rgba(10,8,4,0.75)',
    borderBottomLeftRadius: 3,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.1)',
  },
  bubbleText:      { fontSize: 13, lineHeight: 19, fontFamily: 'Cinzel_400Regular' },
  bubbleImage:     { height: 180, borderRadius: 8, marginBottom: 4, backgroundColor: 'rgba(0,0,0,0.25)' },
  attachBtn:       { paddingHorizontal: 6, alignSelf: 'center' },
  bubbleTextOwn:   { color: '#FFF5E0' },
  bubbleTextOther: { color: CREAM },

  msgTime:      { fontSize: 8, opacity: 0.32, marginTop: 2, fontFamily: 'Cinzel_400Regular', color: CREAM },
  msgTimeOwn:   { marginRight: 3 },
  msgTimeOther: { marginLeft: 3 },

  // Reaction pills
  reactionsRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 3, marginLeft: 4 },
  reactionsRowOwn: { justifyContent: 'flex-end', marginLeft: 0, marginRight: 4 },
  reactionPill: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 10,
    paddingHorizontal: 6, paddingVertical: 2,
    borderWidth: 1, borderColor: 'rgba(237,224,196,0.15)',
  },
  reactionPillOwn: { borderColor: 'rgba(212,168,83,0.45)', backgroundColor: 'rgba(212,168,83,0.1)' },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { color: CREAM, fontSize: 9 },

  // Cover that hides the frame image's drawn input box
  // (position/size supplied as inline style so it tracks reactive PANEL_H)
  inputCover: {
    position: 'absolute',
    backgroundColor: '#0D0A06',
    borderRadius: 6,
  },

  // Real input bar (overlaid above the cover)
  inputBar: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // height injected inline so it tracks reactive INPUT_H
  textInput: {
    flex: 1,
    backgroundColor: 'rgba(12,8,4,0.7)',
    borderWidth: 1.5,
    borderColor: '#C8983A',
    borderRadius: 8,
    color: CREAM,
    fontFamily: 'Cinzel_400Regular',
    fontSize: 11,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  // height injected inline so it tracks reactive INPUT_H
  whisperBtn: {
    width: WHISPER_BTN_W,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#C8983A',
    backgroundColor: '#080604',
    alignItems: 'center',
    justifyContent: 'center',
  },
  whisperBtnOff: { opacity: 0.38 },
  whisperBtnText: {
    color: '#C8983A',
    fontFamily: 'Cinzel_700Bold',
    fontSize: 8,
    letterSpacing: 0.8,
  },

  // Reaction picker popup
  reactionPicker: {
    position: 'absolute',
    flexDirection: 'row',
    flexWrap: 'wrap',
    maxWidth: 300,
    backgroundColor: '#1A1108',
    borderRadius: 20, paddingHorizontal: 10, paddingVertical: 8,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)',
    gap: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.6, shadowRadius: 12, elevation: 10,
  },
  pickerEmoji:     { padding: 6, borderRadius: 20 },
  pickerDeleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, width: '100%', paddingVertical: 7, marginTop: 4,
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.35)',
  },
  pickerDeleteText: {
    color: '#e05555', fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 0.5,
  },
  pickerEmojiText: { fontSize: 22 },

  // The Card button (red, header)
  cardBtn: {
    paddingHorizontal: 10, height: 28, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(176,58,58,0.25)',
    borderWidth: 1.3, borderColor: '#B03A3A',
  },
  cardBtnText: {
    color: '#E8B4B4', fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 2,
  },

  // Add-members modal
  addMemberBtn: {
    width: 34, height: 34, alignItems: 'center', justifyContent: 'center',
  },
  addModalBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.75)', zIndex: 40,
    alignItems: 'center', justifyContent: 'center',
  },
  addModal: {
    width: '85%', maxHeight: '60%',
    backgroundColor: '#1A1108', borderRadius: 14,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.4)',
    padding: 16,
  },
  addModalTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13,
    letterSpacing: 2, textAlign: 'center', marginBottom: 12,
  },
  addModalList: { flexGrow: 0 },
  addModalEmpty: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_400Regular',
    fontSize: 11, textAlign: 'center', paddingVertical: 20,
  },
  addMemberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, paddingHorizontal: 8, borderRadius: 8,
  },
  addMemberRowSelected: { backgroundColor: 'rgba(212,168,83,0.12)' },
  addMemberAvatar: {
    width: 30, height: 30, borderRadius: 15,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  addMemberName: {
    flex: 1, color: CREAM, fontFamily: 'Cinzel_600SemiBold',
    fontSize: 12, letterSpacing: 0.5,
  },
  addConfirmBtn: {
    marginTop: 14, height: 40, borderRadius: 8,
    borderWidth: 1.5, borderColor: '#C8983A', backgroundColor: '#080604',
    alignItems: 'center', justifyContent: 'center',
  },
  addConfirmText: {
    color: '#C8983A', fontFamily: 'Cinzel_700Bold',
    fontSize: 11, letterSpacing: 1.5,
  },
});
