import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Platform, Image, TextInput, AppState,
  ActivityIndicator, ScrollView, Pressable, Alert,
  Keyboard, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { uploadChatImage } from '@/lib/chatMediaService';
import { Feather } from '@/components/FIcon';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import ChatImageViewer from '@/components/ChatImageViewer';
import {
  TEXT_CHANNELS, VOICE_CHANNELS, Channel, VoiceChannel,
  TableMessage, listenTableMessages, sendTableMessage,
  toggleTableReaction, formatTableTimestamp, deleteTableMessage,
} from '@/lib/tableService';
import { getAllMembers } from '@/lib/ticketService';
import {
  voiceSupported, joinVoiceChannel, leaveVoice, VoiceSession,
  listenVoicePresence, isPresenceFresh, sweepStalePresence, VoicePresenceEntry,
  refreshPresenceHeartbeat,
} from '@/lib/voiceService';
import { doc, getDoc, updateDoc, arrayUnion, arrayRemove } from 'firebase/firestore';
import { db } from '@/lib/firebase';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { useAppDimensions } from '@/lib/appWindow';

// ── Assets ────────────────────────────────────────────────────────────────────
const NAV_DAGGER  = require('../../assets/images/nav_dagger.png');
const NAV_CARDS   = require('../../assets/images/nav_cards.png');
const MARBLE      = require('../../assets/images/wood_bg.png');
const TABLE_PANEL = require('../../assets/images/table_panel.png');
const TABLE_BELL  = require('../../assets/images/table_bell.png');
const TABLE_LOCK  = require('../../assets/images/table_lock.png');
const TABLE_MIC   = require('../../assets/images/table_mic.png');

// ── Layout constants (screen-size-independent) ────────────────────────────────
const PANEL_MARGIN = 12;
// Insets measured from the frame artwork (1024×1536 bronze side-rail frame):
// the sidebar strip sits between the inner border (~6.3%) and the vertical
// rail (~24.6%); the slate message panel runs ~28.3%→93.7% of the width and
// ~8.5% in from top, ~9.5% from bottom.
const PICKER_W     = 160; // 4 emojis × 36 px + padding

const NAV_H = 52;
const GOLD  = '#D4A853';
const CREAM = '#EDE0C4';

const REACTION_EMOJIS = ['👍','👎','👑','🎭','😢','😂','🖤','🤍','🔥','🗡','👀','🃏','♠️','♣️','♥️','♦️','🐾'];

// Regex: detect trailing @query in input text
const MENTION_RE = /@([a-zA-Z0-9-]*)$/;

type ActiveChannel =
  | (Channel      & { isVoice: false })
  | (VoiceChannel & { isVoice: true  });

export default function TableScreen() {
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
  // Frame rendered at its native 1024×1536 aspect ratio — never stretched.
  // If the height wins, the width shrinks to match so proportions hold.
  const MAX_PANEL_W = dynW - PANEL_MARGIN * 2;
  const MAX_PANEL_H = effectiveSH - navBottom - 90;
  const PANEL_H   = Math.min(Math.round(MAX_PANEL_W * (1536 / 1024)), MAX_PANEL_H);
  const PANEL_W   = Math.round(PANEL_H * (1024 / 1536));
  const SIDEBAR_L = Math.round(PANEL_W * 0.063);
  const SIDEBAR_W = Math.round(PANEL_W * 0.183);
  const CONTENT_L = Math.round(PANEL_W * 0.283);
  const CONTENT_W = Math.round(PANEL_W * 0.937) - CONTENT_L;
  const EDGE_TOP  = Math.round(PANEL_H * 0.085);
  const EDGE_BOT  = Math.round(PANEL_H * 0.095);
  const INNER_H   = PANEL_H - EDGE_TOP - EDGE_BOT;

  const { user, jokerId, isAdmin } = useAuth();

  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  // ── Channel state ─────────────────────────────────────────────────────────
  const [active,    setActive]    = useState<ActiveChannel>({ ...TEXT_CHANNELS[0], isVoice: false });
  const [messages,  setMessages]  = useState<TableMessage[]>([]);
  const [loading,   setLoading]   = useState(false);

  // ── Input state ───────────────────────────────────────────────────────────
  const [inputText, setInputText] = useState('');
  const [sending,   setSending]   = useState(false);

  // ── Reaction picker state ─────────────────────────────────────────────────
  const [pickerMsgId, setPickerMsgId] = useState<string | null>(null);
  const [pickerTop,   setPickerTop]   = useState(0);
  const [viewedImageUrl, setViewedImageUrl] = useState<string | null>(null);

  // ── @mention state ────────────────────────────────────────────────────────
  const [allMembers,   setAllMembers]   = useState<string[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  // ── Muted channels state ──────────────────────────────────────────────────
  const [mutedChannels, setMutedChannels] = useState<Set<string>>(new Set());

  // ── Avatar cache: uid → mugUrl ────────────────────────────────────────────
  const [avatarCache, setAvatarCache] = useState<Record<string, string>>({});

  const flatListRef = useRef<FlatList>(null);

  // Load muted channels from user doc
  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, 'users', user.uid))
      .then(snap => {
        if (snap.exists()) {
          const muted: string[] = snap.data().mutedTableChannels ?? [];
          setMutedChannels(new Set(muted));
        }
      })
      .catch(console.error);
  }, [user]);

  // Load members: @mention list + seed avatar cache from mugUrl
  useEffect(() => {
    getAllMembers()
      .then(members => {
        setAllMembers(members.map(m => m.jokerId ?? '').filter(Boolean).sort());
        const seed: Record<string, string> = {};
        members.forEach(m => { if (m.mugUrl) seed[m.uid] = m.mugUrl; });
        if (Object.keys(seed).length) setAvatarCache(seed);
      })
      .catch(console.error);
  }, []);

  // Lazy-fetch avatars for any sender not yet in the cache
  useEffect(() => {
    const missing = [...new Set(messages.map(m => m.senderUid))].filter(
      uid => uid && !avatarCache[uid],
    );
    if (!missing.length) return;
    missing.forEach(uid => {
      getDoc(doc(db, 'users', uid))
        .then(snap => {
          const url: string | undefined = snap.data()?.mugUrl;
          if (url) setAvatarCache(prev => ({ ...prev, [uid]: url }));
        })
        .catch(() => {});
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  // Subscribe to messages
  useEffect(() => {
    if (active.isVoice) { setMessages([]); return; }
    setLoading(true);
    const unsub = listenTableMessages(active.id, msgs => {
      setMessages(msgs);
      setLoading(false);
    });
    return unsub;
  }, [active.id, active.isVoice]);

  // Auto-scroll to latest
  useEffect(() => {
    if (messages.length > 0)
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages.length]);

  const canPost         = !active.isVoice && (isAdmin || !(active as Channel).adminOnly);
  const activeAdminOnly = !active.isVoice && (active as Channel).adminOnly;

  // Filtered @mention results (max 8)
  const mentionResults = mentionQuery !== null
    ? allMembers
        .filter(id => id.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 8)
    : [];

  // ── Handlers ─────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!user || !jokerId || !inputText.trim() || sending) return;
    setSending(true);
    const text = inputText.trim();
    setInputText('');
    setMentionQuery(null);
    try {
      await sendTableMessage(active.id, user.uid, jokerId, text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e) { console.error('[Table] send error:', e); }
    finally     { setSending(false); }
  }, [user, jokerId, inputText, sending, active.id]);

  // Pick a photo/GIF and send it (with any typed text as the caption).
  const handleAttach = useCallback(async () => {
    if (!user || !jokerId || sending) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85,
    });
    if (res.canceled || !res.assets[0]) return;
    setSending(true);
    const text = inputText.trim();
    setInputText('');
    setMentionQuery(null);
    try {
      const url = await uploadChatImage(user.uid, res.assets[0].uri, res.assets[0].mimeType);
      await sendTableMessage(active.id, user.uid, jokerId, text, url);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (e) {
      console.error('[Table] attach error:', e);
      setInputText(text);
    } finally {
      setSending(false);
    }
  }, [user, jokerId, inputText, sending, active.id]);

  const handleInputChange = useCallback((text: string) => {
    setInputText(text);
    const match = text.match(MENTION_RE);
    setMentionQuery(match ? match[1] : null);
  }, []);

  const insertMention = useCallback((id: string) => {
    setInputText(prev => prev.replace(MENTION_RE, `@${id} `));
    setMentionQuery(null);
  }, []);


  const handleReact = useCallback(async (emoji: string) => {
    if (!user || !pickerMsgId) return;
    setPickerMsgId(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await toggleTableReaction(active.id, pickerMsgId, user.uid, emoji).catch(console.error);
  }, [user, pickerMsgId, active.id]);

  // Toggle mute for a text channel — persisted to Firestore
  const toggleMute = useCallback(async (channelId: string) => {
    if (!user) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const wasMuted = mutedChannels.has(channelId);
    setMutedChannels(prev => {
      const next = new Set(prev);
      wasMuted ? next.delete(channelId) : next.add(channelId);
      return next;
    });
    await updateDoc(doc(db, 'users', user.uid), {
      mutedTableChannels: wasMuted ? arrayRemove(channelId) : arrayUnion(channelId),
    }).catch(console.error);
  }, [user, mutedChannels]);

  const selectText  = (ch: Channel)      => { setActive({ ...ch, isVoice: false }); setInputText(''); setMentionQuery(null); };
  const selectVoice = (ch: VoiceChannel) =>   setActive({ ...ch, isVoice: true  });

  // ── Live voice (Agora) ─────────────────────────────────────────────────────
  const [voiceSession,  setVoiceSession]  = useState<VoiceSession | null>(null);
  const [voiceJoining,  setVoiceJoining]  = useState(false);
  const [voiceMuted,    setVoiceMuted]    = useState(false);
  const [voiceMembers,  setVoiceMembers]  = useState(1);
  const [speakingUids,  setSpeakingUids]  = useState<Set<string>>(new Set());

  useEffect(() => () => leaveVoice(), []); // leave on unmount

  // ── Voice presence: who is sitting in each channel (live) ────────────────
  const [voicePresence, setVoicePresence] = useState<Record<string, VoicePresenceEntry[]>>({});
  const [, setPresenceTick] = useState(0); // re-render so stale entries age out
  // Bumped when the app returns to the foreground: iOS/Android can silently
  // drop Firestore listeners after an extended background, so we resubscribe.
  const [presenceEpoch, setPresenceEpoch] = useState(0);

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        refreshPresenceHeartbeat(); // our own seat may be overdue for a heartbeat
        setPresenceTick(n => n + 1); // re-apply the staleness filter immediately
        setPresenceEpoch(n => n + 1); // tear down + resubscribe presence listeners
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!user) return;
    const unsubs = VOICE_CHANNELS.map(ch =>
      listenVoicePresence(ch.id, entries =>
        setVoicePresence(prev => ({ ...prev, [ch.id]: entries }))),
    );
    return () => unsubs.forEach(u => u());
  }, [user, presenceEpoch]);

  // Every 30s: refresh the staleness filter and sweep ghost entries.
  useEffect(() => {
    if (!user) return;
    const t = setInterval(() => {
      setPresenceTick(n => n + 1);
      setVoicePresence(prev => {
        VOICE_CHANNELS.forEach(ch => sweepStalePresence(ch.id, prev[ch.id] ?? []));
        return prev;
      });
    }, 30_000);
    return () => clearInterval(t);
  }, [user]);

  // Deterministic teardown: switching to any other channel hangs up, so the
  // mic can never stay hot while its controls are hidden.
  useEffect(() => {
    if (voiceSession && (!active.isVoice || active.id !== voiceSession.channelId)) {
      voiceSession.leave();
    }
  }, [active.id, active.isVoice, voiceSession]);

  const joinVoice = useCallback(async (channelId: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setVoiceJoining(true);
    try {
      const session = await joinVoiceChannel(channelId, jokerId ?? '??-??', {
        onMembersChanged: setVoiceMembers,
        onSpeakersChanged: uids => setSpeakingUids(new Set(uids)),
        onEnded: () => {
          setVoiceSession(null); setVoiceMuted(false); setVoiceMembers(1);
          setSpeakingUids(new Set());
        },
      });
      setVoiceSession(session);
      setVoiceMuted(false);
    } catch (e: any) {
      Alert.alert('Voice', e?.message ?? 'Could not join the voice channel.');
    } finally {
      setVoiceJoining(false);
    }
  }, [jokerId]);

  const toggleVoiceMute = useCallback(() => {
    if (!voiceSession) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setVoiceMuted(m => { voiceSession.setMuted(!m); return !m; });
  }, [voiceSession]);

  // ── Message text renderer (highlights @mentions) ──────────────────────────
  const renderMentionText = (text: string) => {
    const parts = text.split(/(@[a-zA-Z0-9-]+)/g);
    return (
      <Text style={s.msgText}>
        {parts.map((part, i) =>
          part.startsWith('@')
            ? <Text key={i} style={s.mentionHighlight}>{part}</Text>
            : part
        )}
      </Text>
    );
  };

  // ── Render one message ────────────────────────────────────────────────────
  const renderMessage = useCallback(({ item }: { item: TableMessage }) => {
    const initial        = item.senderJokerId.charAt(0).toUpperCase();
    const ts             = formatTableTimestamp(item.sentAt);
    const reactionPairs  = Object.entries(item.reactions ?? {}).filter(([, uids]) => uids.length > 0);
    const avatarUrl      = avatarCache[item.senderUid];

    return (
      <View style={s.msgRow}>
        <View style={s.msgAvatar}>
          {avatarUrl
            ? <Image source={{ uri: avatarUrl }} style={s.msgAvatarImg} />
            : <Text style={s.msgAvatarText}>{initial}</Text>
          }
        </View>

        <View style={s.msgBody}>
          <View style={s.msgMeta}>
            <Text style={s.msgSender}>{item.senderJokerId}</Text>
            <Text style={s.msgTs}>{ts}</Text>
          </View>

          {/* Long-press the text to open reaction picker */}
          <Pressable
            onLongPress={(e) => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
              const pageY = (e.nativeEvent as any).pageY ?? 300;
              setPickerTop(Math.max(pageY - 110, navBottom + 20));
              setPickerMsgId(item.id);
            }}
            delayLongPress={350}
          >
            {item.imageUrl ? (
              <TouchableOpacity
                onPress={() => setViewedImageUrl(item.imageUrl!)}
                activeOpacity={0.86}
                accessibilityRole="imagebutton"
                accessibilityLabel="View full image"
              >
                <Image source={{ uri: item.imageUrl }} style={s.msgImage} resizeMode="cover" />
              </TouchableOpacity>
            ) : null}
            {item.text ? renderMentionText(item.text) : null}
          </Pressable>

          {/* Reaction pills */}
          {reactionPairs.length > 0 && (
            <View style={s.reactionsRow}>
              {reactionPairs.map(([emoji, uids]) => (
                <TouchableOpacity
                  key={emoji}
                  style={[s.reactionPill, uids.includes(user?.uid ?? '') && s.reactionPillOwn]}
                  onPress={() => {
                    if (user) toggleTableReaction(active.id, item.id, user.uid, emoji).catch(console.error);
                  }}
                  activeOpacity={0.75}
                >
                  <Text style={s.reactionEmoji}>{emoji}</Text>
                  <Text style={s.reactionCount}>{uids.length}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>
      </View>
    );
  }, [user, navBottom, active.id, avatarCache]);

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
          <Text style={s.navTitle} numberOfLines={1}>Jester's Table</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* Panel + overlaid UI */}
      <View style={[s.panelContainer, { top: navBottom + 10, left: Math.round((dynW - PANEL_W) / 2) }]}>

        {/* Panel image at natural proportions */}
        <Image
          source={TABLE_PANEL}
          style={{ width: PANEL_W, height: PANEL_H }}
          resizeMode="stretch"
        />

        {/* ── Sidebar ── */}
        <View style={[s.sidebar, { left: SIDEBAR_L, top: EDGE_TOP, width: SIDEBAR_W, height: INNER_H }]}>
          <ScrollView
            showsVerticalScrollIndicator={false}
            contentContainerStyle={s.sidebarContent}
          >
            <Text style={s.sectionHeader}>TEXT CHANNELS</Text>
            {TEXT_CHANNELS.map(ch => {
              const isActive = !active.isVoice && active.id === ch.id;
              const isMuted  = mutedChannels.has(ch.id);
              return (
                <TouchableOpacity
                  key={ch.id}
                  style={[s.channelRow, isActive && s.channelRowActive]}
                  onPress={() => selectText(ch)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.channelHash, isActive && s.channelHashActive]}>#</Text>
                  <Text style={[s.channelName, isActive && s.channelNameActive]}>
                    {ch.label}
                  </Text>
                  {ch.adminOnly ? (
                    /* Lock — decorative, glows gold */
                    <View style={s.iconGlow}>
                      <Image source={TABLE_LOCK} style={s.lockIcon} resizeMode="contain" />
                    </View>
                  ) : (
                    /* Bell — tappable mute toggle */
                    <TouchableOpacity
                      onPress={() => toggleMute(ch.id)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      activeOpacity={0.6}
                    >
                      <View style={[s.iconGlow, isMuted && s.iconGlowMuted]}>
                        <Image
                          source={TABLE_BELL}
                          style={[s.bellIcon, isMuted && { opacity: 0.25 }]}
                          resizeMode="contain"
                        />
                        {/* Red slash when muted */}
                        {isMuted && <View style={s.mutedSlash} />}
                      </View>
                    </TouchableOpacity>
                  )}
                </TouchableOpacity>
              );
            })}

            <Text style={[s.sectionHeader, { marginTop: 18 }]}>VOICE CHANNELS</Text>
            {VOICE_CHANNELS.map(ch => {
              const isActive = active.isVoice && active.id === ch.id;
              const sitting  = (voicePresence[ch.id] ?? []).filter(e => isPresenceFresh(e));
              return (
                <View key={ch.id}>
                  <TouchableOpacity
                    style={[s.channelRow, isActive && s.channelRowActive]}
                    onPress={() => selectVoice(ch)}
                    activeOpacity={0.75}
                  >
                    {/* Mic — glows gold */}
                    <View style={s.iconGlow}>
                      <Image source={TABLE_MIC} style={s.micIcon} resizeMode="contain" />
                    </View>
                    <Text style={[s.channelName, isActive && s.channelNameActive]}>
                      {ch.label}
                    </Text>
                  </TouchableOpacity>
                  {/* Who's sitting in this channel, live */}
                  {sitting.map(e => (
                    <View key={e.uid} style={s.presenceRow}>
                      <View style={s.presenceDot} />
                      <Text style={s.presenceName} numberOfLines={1}>{e.jokerId}</Text>
                    </View>
                  ))}
                </View>
              );
            })}
          </ScrollView>
        </View>

        {/* ── Content (messages + input) ── */}
        <View style={[s.content, { left: CONTENT_L, top: EDGE_TOP, width: CONTENT_W, height: INNER_H }]}>
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <View style={s.contentOverlay} />
          </View>

          {/* Channel title strip */}
          <View style={s.channelBar}>
            {active.isVoice
              ? <Image source={TABLE_MIC} style={s.barMicIcon} resizeMode="contain" />
              : <Text style={s.channelBarHash}>#</Text>
            }
            <Text style={s.channelBarName} numberOfLines={1}>{active.name}</Text>
            {activeAdminOnly && (
              <Image source={TABLE_LOCK} style={s.barLockIcon} resizeMode="contain" />
            )}
          </View>

          {/* Voice channel */}
          {active.isVoice ? (
            <View style={s.voicePlaceholder}>
              <View style={s.voiceMicGlow}>
                <Image source={TABLE_MIC} style={s.voiceMicBig} resizeMode="contain" />
              </View>
              <Text style={s.voiceTitle}>{active.name}</Text>
              {!voiceSupported() ? (
                <Text style={s.voiceSub}>
                  Live voice needs the browser version — open Jester's Hand in your phone's web browser. The phone app can't run voice until the store build ships.
                </Text>
              ) : voiceSession?.channelId === active.id ? (
                <>
                  <Text style={s.voiceSub}>
                    {voiceMembers === 1 ? 'Only you at the table.' : `${voiceMembers} at the table.`}
                  </Text>
                  {/* Seated members (from presence), lit while speaking */}
                  <View style={s.voiceRoster}>
                    {(voicePresence[active.id] ?? [])
                      .filter(e => isPresenceFresh(e))
                      .map(e => {
                        const talking = speakingUids.has(e.uid);
                        return (
                          <View key={e.uid} style={[s.voiceRosterRow, talking && s.voiceRosterRowTalking]}>
                            <View style={[s.voiceRosterDot, talking && s.voiceRosterDotTalking]} />
                            <Text
                              style={[s.voiceRosterName, talking && s.voiceRosterNameTalking]}
                              numberOfLines={1}
                            >
                              {e.jokerId}
                            </Text>
                          </View>
                        );
                      })}
                  </View>
                  <View style={s.voiceBtnRow}>
                    <TouchableOpacity style={s.voiceBtn} onPress={toggleVoiceMute} activeOpacity={0.8}>
                      <Feather name={voiceMuted ? 'mic-off' : 'mic'} size={17} color={GOLD} />
                      <Text style={s.voiceBtnText}>{voiceMuted ? 'UNMUTE' : 'MUTE'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[s.voiceBtn, s.voiceBtnLeave]}
                      onPress={() => voiceSession.leave()}
                      activeOpacity={0.8}
                    >
                      <Feather name="phone-off" size={17} color="#C96A5A" />
                      <Text style={[s.voiceBtnText, { color: '#C96A5A' }]}>LEAVE</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <Text style={s.voiceSub}>Pull up a chair and speak.</Text>
                  <TouchableOpacity
                    style={s.voiceJoinBtn}
                    onPress={() => joinVoice(active.id)}
                    disabled={voiceJoining}
                    activeOpacity={0.8}
                  >
                    {voiceJoining
                      ? <ActivityIndicator size="small" color="#000" />
                      : <Text style={s.voiceJoinText}>JOIN VOICE</Text>}
                  </TouchableOpacity>
                </>
              )}
            </View>

          ) : loading ? (
            <View style={s.center}>
              <ActivityIndicator size="small" color={GOLD} />
            </View>

          ) : (
            <>
              {/* Messages */}
              <FlatList
                ref={flatListRef}
                data={messages}
                keyExtractor={item => item.id}
                renderItem={renderMessage}
                style={s.messageList}
                contentContainerStyle={s.messageListContent}
                showsVerticalScrollIndicator={false}
                ListEmptyComponent={
                  <View style={s.emptyWrap}>
                    <Text style={s.emptyText}>No messages yet.</Text>
                    {canPost && <Text style={s.emptySub}>Be the first to speak.</Text>}
                  </View>
                }
              />

              {/* @mention dropdown — floats above input bar */}
              {mentionQuery !== null && mentionResults.length > 0 && (
                <View style={s.mentionDropdown}>
                  <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 175 }}>
                    {mentionResults.map(id => (
                      <TouchableOpacity
                        key={id}
                        style={s.mentionRow}
                        onPress={() => insertMention(id)}
                        activeOpacity={0.75}
                      >
                        <Text style={s.mentionRowText}>@{id}</Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                </View>
              )}

              {/* Input bar or read-only bar */}
              {canPost ? (
                <View style={s.inputBar}>
                  <TouchableOpacity
                    style={s.attachBtn}
                    onPress={handleAttach}
                    disabled={sending}
                    activeOpacity={0.75}
                  >
                    <Feather name="image" size={18} color={sending ? 'rgba(212,168,83,0.35)' : GOLD} />
                  </TouchableOpacity>
                  <TextInput
                    style={s.input}
                    value={inputText}
                    onChangeText={handleInputChange}
                    placeholder="Say your piece…"
                    placeholderTextColor="rgba(237,224,196,0.35)"
                    returnKeyType="send"
                    onSubmitEditing={handleSend}
                    blurOnSubmit={false}
                  />
                  <TouchableOpacity
                    style={[s.speakBtn, (!inputText.trim() || sending) && s.speakBtnOff]}
                    onPress={handleSend}
                    disabled={!inputText.trim() || sending}
                    activeOpacity={0.8}
                  >
                    {sending
                      ? <ActivityIndicator size="small" color={GOLD} />
                      : <Text style={s.speakText}>Speak</Text>
                    }
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={s.readOnlyBar}>
                  <Image source={TABLE_LOCK} style={s.readOnlyLock} resizeMode="contain" />
                  <Text style={s.readOnlyText} numberOfLines={2}>
                    Read-only — only 00-00 may speak here
                  </Text>
                </View>
              )}
            </>
          )}
        </View>
      </View>

      {/* ── Reaction picker — full-screen overlay ── */}
      {pickerMsgId && (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setPickerMsgId(null)}>
          <View
            style={[
              s.reactionPicker,
              {
                top:  pickerTop,
                left: PANEL_MARGIN + CONTENT_L + Math.floor((CONTENT_W - PICKER_W) / 2),
              },
            ]}
          >
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
              const canDelete = !!msg && (isAdmin || msg.senderUid === user?.uid);
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
                        onPress: () => deleteTableMessage(active.id, id!).catch(console.error),
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
  navTitle: {
    ...MARBLE_TEXT_SHADOW,
    flex: 1, textAlign: 'center',
    color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 1.5,
  },
  dagIcon: { width: 48, height: 26 },
  sqIcon:  { width: 34, height: 34 },

  panelContainer: { position: 'absolute' },

  // Sidebar
  sidebar: { position: 'absolute' },
  sidebarContent: { paddingTop: 16, paddingBottom: 24 },
  sectionHeader: {
    ...MARBLE_TEXT_SHADOW,
    color: 'rgba(237,224,196,0.5)', fontSize: 7,
    fontFamily: 'Cinzel_700Bold', letterSpacing: 0.5,
    textTransform: 'uppercase', paddingHorizontal: 4, marginBottom: 4,
  },
  channelRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 4, paddingVertical: 8, gap: 3,
  },
  channelRowActive: {
    backgroundColor: 'rgba(212,168,83,0.15)',
    borderLeftWidth: 2, borderLeftColor: GOLD, paddingLeft: 6,
  },
  channelHash:       { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.45)', fontSize: 11, width: 10, textAlign: 'center' },
  channelHashActive: { color: GOLD },
  channelName:       { ...MARBLE_TEXT_SHADOW, flex: 1, color: 'rgba(237,224,196,0.65)', fontFamily: 'Cinzel_400Regular', fontSize: 8.5, lineHeight: 12 },
  channelNameActive: { color: CREAM },
  presenceRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 28, paddingRight: 8, paddingVertical: 3, gap: 5,
  },
  presenceDot: {
    width: 5, height: 5, borderRadius: 3, backgroundColor: '#7BB97E',
  },
  presenceName: {
    flex: 1, color: 'rgba(237,224,196,0.55)',
    fontFamily: 'Cinzel_400Regular', fontSize: 8, lineHeight: 11,
  },
  bellIcon: { width: 13, height: 13 },
  lockIcon: { width: 13, height: 16 },
  micIcon:  { width: 13, height: 17 },

  // Glowing wrapper for sidebar icons
  iconGlow: {
    alignItems: 'center', justifyContent: 'center',
    padding: 3, borderRadius: 5,
    shadowColor: GOLD,
    shadowOpacity: 0.75,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  iconGlowMuted: { shadowOpacity: 0 },

  // Diagonal red slash overlaid on the bell when muted
  mutedSlash: {
    position: 'absolute',
    width: 1.5, height: 22,
    backgroundColor: 'rgba(220,60,60,0.85)',
    borderRadius: 1,
    transform: [{ rotate: '45deg' }],
  },

  // Content panel
  content: { position: 'absolute', flexDirection: 'column' },
  contentOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.42)' },

  channelBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 8, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.22)',
    backgroundColor: 'rgba(0,0,0,0.35)', gap: 5,
  },
  channelBarHash: { color: GOLD, fontSize: 13 },
  channelBarName: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  barLockIcon: { width: 11, height: 14 },
  barMicIcon:  { width: 13, height: 16 },

  voicePlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, gap: 10 },
  voiceMicGlow: {
    shadowColor: GOLD,
    shadowOpacity: 0.8,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  voiceMicBig:      { width: 50, height: 62, opacity: 0.7 },
  voiceTitle:       { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  voiceSub:         { color: 'rgba(237,224,196,0.38)', fontFamily: 'Cinzel_400Regular', fontSize: 9, textAlign: 'center', lineHeight: 14 },
  voiceJoinBtn:     { marginTop: 14, backgroundColor: GOLD, borderRadius: 6, paddingVertical: 9, paddingHorizontal: 26, minWidth: 120, alignItems: 'center' },
  voiceJoinText:    { color: '#000', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 2 },
  voiceRoster:      { alignSelf: 'stretch', marginTop: 8, gap: 4 },
  voiceRosterRow: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    alignSelf: 'center', minWidth: 120,
    paddingVertical: 4, paddingHorizontal: 12,
    borderRadius: 6, borderWidth: 1, borderColor: 'transparent',
  },
  voiceRosterRowTalking: {
    borderColor: 'rgba(123,185,126,0.55)',
    backgroundColor: 'rgba(123,185,126,0.10)',
  },
  voiceRosterDot: {
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: 'rgba(237,224,196,0.30)',
  },
  voiceRosterDotTalking: {
    backgroundColor: '#7BB97E',
    shadowColor: '#7BB97E', shadowOpacity: 0.9, shadowRadius: 5,
    shadowOffset: { width: 0, height: 0 }, elevation: 4,
  },
  voiceRosterName: {
    color: 'rgba(237,224,196,0.60)',
    fontFamily: 'Cinzel_400Regular', fontSize: 9.5, letterSpacing: 0.5,
  },
  voiceRosterNameTalking: { color: '#A8D8AB', fontFamily: 'Cinzel_700Bold' },
  voiceBtnRow:      { flexDirection: 'row', gap: 10, marginTop: 14 },
  voiceBtn:         { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: 'rgba(212,168,83,0.55)', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 14 },
  voiceBtnLeave:    { borderColor: 'rgba(201,106,90,0.55)' },
  voiceBtnText:     { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.5 },

  center:             { flex: 1, alignItems: 'center', justifyContent: 'center' },
  messageList:        { flex: 1 },
  messageListContent: { paddingHorizontal: 6, paddingTop: 8, paddingBottom: 4 },

  // Message row
  msgRow:        { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 11, gap: 6 },
  msgAvatar:    { width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(212,168,83,0.15)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', alignItems: 'center', justifyContent: 'center', marginTop: 1, overflow: 'hidden' },
  msgAvatarImg:  { width: 24, height: 24, borderRadius: 12 },
  msgAvatarText: { color: GOLD, fontSize: 9, fontWeight: '700' },
  msgBody:       { flex: 1 },
  msgMeta:       { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 },
  msgSender:     { ...MARBLE_TEXT_SHADOW, color: GOLD, fontSize: 10, fontFamily: 'Cinzel_700Bold' },
  msgTs:         { color: 'rgba(237,224,196,0.35)', fontSize: 8 },
  msgText:       { ...MARBLE_TEXT_SHADOW, color: CREAM, fontSize: 11, lineHeight: 15 },
  msgImage:      { width: 180, height: 150, borderRadius: 8, marginBottom: 4, backgroundColor: 'rgba(0,0,0,0.25)' },
  attachBtn:     { paddingHorizontal: 4, alignSelf: 'center' },

  // @mention highlight inside message text
  mentionHighlight: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11 },

  // Reaction pills
  reactionsRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionPill:  { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(237,224,196,0.2)', paddingHorizontal: 5, paddingVertical: 2 },
  reactionPillOwn: { borderColor: 'rgba(212,168,83,0.5)', backgroundColor: 'rgba(212,168,83,0.1)' },
  reactionEmoji: { fontSize: 11 },
  reactionCount: { color: CREAM, fontSize: 9 },

  emptyWrap: { paddingTop: 36, alignItems: 'center', gap: 5 },
  emptyText: { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.32)', fontFamily: 'Cinzel_400Regular', fontSize: 10 },
  emptySub:  { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.2)', fontSize: 9 },

  // @mention dropdown
  mentionDropdown: {
    position: 'absolute', bottom: 50, left: 0, right: 0,
    backgroundColor: 'rgba(10,7,5,0.97)',
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.3)',
    borderRadius: 6, zIndex: 10,
  },
  mentionRow: {
    paddingHorizontal: 10, paddingVertical: 9,
    borderBottomWidth: 1, borderBottomColor: 'rgba(237,224,196,0.06)',
  },
  mentionRowText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 0.5 },

  // Input
  inputBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 6, paddingVertical: 7,
    borderTopWidth: 1.5, borderTopColor: GOLD,
    backgroundColor: 'rgba(0,0,0,0.88)', gap: 6,
    width: '100%',
  },
  input: {
    flex: 1, minWidth: 0, flexShrink: 1,
    height: 36,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 6, borderWidth: 1, borderColor: 'rgba(212,168,83,0.65)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 11,
    paddingHorizontal: 8,
  },
  pickerDeleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, width: '100%', paddingVertical: 7, marginTop: 4,
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.35)',
  },
  pickerDeleteText: {
    color: '#e05555', fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 0.5,
  },
  speakBtn:    { ...MARBLE_BTN_BACKING, flexShrink: 0, width: 56, height: 36, borderRadius: 6, borderWidth: 1.5, borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.28)', alignItems: 'center', justifyContent: 'center' },
  speakBtnOff: { borderColor: 'rgba(212,168,83,0.3)', opacity: 0.45 },
  speakText:   { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1 },

  readOnlyBar:  { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 9, borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.2)', backgroundColor: 'rgba(0,0,0,0.65)', gap: 6, width: '100%' },
  readOnlyLock: { width: 11, height: 14, opacity: 0.5 },
  readOnlyText: { flex: 1, color: 'rgba(237,224,196,0.38)', fontFamily: 'Cinzel_400Regular', fontSize: 9 },

  // Reaction picker popup
  reactionPicker: {
    position: 'absolute', width: PICKER_W,
    flexDirection: 'row', flexWrap: 'wrap',
    backgroundColor: 'rgba(12,8,5,0.97)',
    borderRadius: 12, borderWidth: 1, borderColor: GOLD,
    padding: 6, gap: 2, zIndex: 999,
  },
  pickerEmoji:     { width: 34, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  pickerEmojiText: { fontSize: 20 },
});
