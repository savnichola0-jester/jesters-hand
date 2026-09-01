// SCREEN 3 — Ticket detail: the full file (document + Spread, read-only
// unless you are the author) plus comments and reactions, mirroring the
// Ante screen's social mechanics.
import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Dimensions, Platform,
  Image, ScrollView, Alert, KeyboardAvoidingView, ActivityIndicator, Modal,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  TargetTicket, TicketComment,
  listenTargetTicket, listenTicketComments, createTicketComment,
  deleteTicketComment, deleteTargetTicket,
  toggleTicketReaction, toggleTicketCommentReaction, setTicketMute,
  formatTicketTimestamp, SUIT_LABELS, EMPTY_SPREAD,
} from '@/lib/targetTicketService';
import { getAllMembers } from '@/lib/ticketService';
import { TicketDocument } from '@/components/target/TicketDocument';
import { SpreadCanvas } from '@/components/target/SpreadCanvas';
import { DotLegend } from '@/components/target/StatusDot';
import { SuitIcon } from '@/components/target/SuitIcon';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { showAlert, confirmAction } from '@/lib/confirm';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW, height: SH } = appWindow();
const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 40;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const REACTION_EMOJIS = ['👍', '👎', '👑', '🎭', '😢', '😂', '🖤', '🤍', '🔥', '🗡', '👀', '🃏', '♠️', '♣️', '♥️', '♦️', '🐾'];

type PickerTarget = { kind: 'ticket' } | { kind: 'comment'; commentId: string };

export default function TargetTicketViewScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isAdmin } = useAuth();
  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  const { id } = useLocalSearchParams<{ id?: string }>();
  const ticketId = typeof id === 'string' ? id : '';

  const [ticket, setTicket] = useState<TargetTicket | null | undefined>(undefined);
  const [comments, setComments] = useState<TicketComment[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [commentText, setCommentText] = useState('');
  const [sending, setSending] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  // Pause page scrolling while a canvas gesture (pan/zoom) is in progress.
  const [scrollLocked, setScrollLocked] = useState(false);
  // Local-only spread copy so viewers can pan/zoom without writing.
  const [spreadView, setSpreadView] = useState(EMPTY_SPREAD);

  useEffect(() => {
    if (!ticketId) return;
    return listenTargetTicket(ticketId, t => {
      setTicket(t);
      if (t) setSpreadView(t.spread);
    });
  }, [ticketId]);

  useEffect(() => {
    if (!ticketId) return;
    return listenTicketComments(ticketId, setComments);
  }, [ticketId]);

  useEffect(() => {
    getAllMembers().then(members => {
      const map: Record<string, string> = {};
      members.forEach((m: any) => { map[m.uid] = m.jokerId ?? '——'; });
      setNames(map);
    }).catch(() => {});
  }, []);

  const isAuthor = !!user && !!ticket && ticket.senderUid === user.uid;
  const isMuted  = !!user && !!ticket && ticket.mutedBy.includes(user.uid);

  const sendComment = useCallback(async () => {
    if (!user || !commentText.trim() || sending) return;
    setSending(true);
    try {
      await createTicketComment(ticketId, user.uid, commentText);
      setCommentText('');
    } catch {
      showAlert('Error', 'Could not post the comment.');
    } finally {
      setSending(false);
    }
  }, [user, ticketId, commentText, sending]);

  const confirmDeleteTicket = () => {
    confirmAction(
      'Burn this file?',
      'The ticket and its thread will be deleted for everyone.',
      'Burn It',
      async () => {
        try { await deleteTargetTicket(ticketId); router.back(); }
        catch { showAlert('Error', 'Could not delete the ticket.'); }
      },
    );
  };

  const applyReaction = async (emoji: string) => {
    if (!user || !picker) return;
    try {
      if (picker.kind === 'ticket') await toggleTicketReaction(ticketId, user.uid, emoji);
      else await toggleTicketCommentReaction(ticketId, picker.commentId, user.uid, emoji);
    } catch { /* rules reject → ignore */ }
    setPicker(null);
  };

  const renderReactions = (
    reactions: Record<string, string[]>,
    onToggle: (emoji: string) => void,
  ) => {
    const entries = Object.entries(reactions).filter(([, uids]) => uids.length > 0);
    if (entries.length === 0) return null;
    return (
      <View style={s.reactionsRow}>
        {entries.map(([emoji, uids]) => (
          <TouchableOpacity
            key={emoji}
            style={[s.reactionChip, user && uids.includes(user.uid) && s.reactionChipMine]}
            onPress={() => onToggle(emoji)}
          >
            <Text style={s.reactionEmoji}>{emoji}</Text>
            <Text style={s.reactionCount}>{uids.length}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  if (ticket === undefined) {
    return (
      <View style={[s.root, { justifyContent: 'center' }]}>
        <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <ActivityIndicator color={GOLD} />
      </View>
    );
  }
  if (ticket === null) {
    return (
      <View style={[s.root, { justifyContent: 'center', alignItems: 'center' }]}>
        <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <Text style={{ ...MARBLE_TEXT_SHADOW, color: CREAM, fontFamily: 'Cinzel_600SemiBold' }}>This file was burned.</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', letterSpacing: 2 }}>GO BACK</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* Nav */}
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
          <Text style={s.navTitle} numberOfLines={1} pointerEvents="none">Target Ticket</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
          contentContainerStyle={{ padding: SIDE, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!scrollLocked}
        >
          {/* The file */}
          <View style={[s.tab, { height: TAB_H }]}>
            <Text style={s.tabText} numberOfLines={1}>{ticket.title || 'UNTITLED THEORY'}</Text>
          </View>
          <View style={s.body}>
            <View style={s.metaRow}>
              <SuitIcon suit={ticket.suit} size={18} color={GOLD} />
              <Text style={s.metaText}>
                {SUIT_LABELS[ticket.suit]}
                {names[ticket.senderUid] ? `  ·  Filed by ${names[ticket.senderUid]}` : ''}
                {ticket.createdAt ? `  ·  ${formatTicketTimestamp(ticket.createdAt)}` : ''}
              </Text>
            </View>

            <TicketDocument draft={ticket} editable={false} />

            <Text style={s.spreadLabel}>The Spread</Text>
            <DotLegend />
            <SpreadCanvas
              value={spreadView}
              onChange={setSpreadView}
              editable={false}
              height={Math.round(SH * 0.5)}
              onGestureActive={setScrollLocked}
            />

            {/* Owner / admin actions */}
            <View style={s.ownerRow}>
              {isAuthor && (
                <TouchableOpacity
                  style={s.ownerBtn}
                  onPress={() => router.push({ pathname: '/(tabs)/target-ticket-new', params: { id: ticket.id } })}
                >
                  <Feather name="edit-2" size={13} color={GOLD} />
                  <Text style={s.ownerBtnText}>Amend</Text>
                </TouchableOpacity>
              )}
              {(isAuthor || isAdmin) && (
                <TouchableOpacity style={s.ownerBtn} onPress={confirmDeleteTicket}>
                  <Feather name="trash-2" size={13} color="#D08080" />
                  <Text style={[s.ownerBtnText, { color: '#D08080' }]}>Burn</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={s.ownerBtn}
                onPress={() => user && setTicketMute(ticketId, user.uid, !isMuted).catch(() => {})}
              >
                <Feather name={isMuted ? 'bell-off' : 'bell'} size={13} color={GOLD} />
                <Text style={s.ownerBtnText}>{isMuted ? 'Unmute' : 'Mute'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.ownerBtn} onPress={() => setPicker({ kind: 'ticket' })}>
                <Feather name="smile" size={13} color={GOLD} />
                <Text style={s.ownerBtnText}>React</Text>
              </TouchableOpacity>
            </View>

            {renderReactions(ticket.reactions, emoji =>
              user && toggleTicketReaction(ticketId, user.uid, emoji).catch(() => {}))}
          </View>

          {/* Comments */}
          <Text style={s.commentsHeader}>The Whispers · {ticket.commentCount}</Text>
          {comments.map(c => (
            <View key={c.id} style={s.commentCard}>
              <View style={s.commentTop}>
                <Text style={s.commentAuthor}>{names[c.senderUid] ?? '——'}</Text>
                <Text style={s.commentTime}>{formatTicketTimestamp(c.createdAt)}</Text>
              </View>
              <Text style={s.commentText}>{c.text}</Text>
              <View style={s.commentActions}>
                <TouchableOpacity onPress={() => setPicker({ kind: 'comment', commentId: c.id })}>
                  <Text style={s.commentAction}>React</Text>
                </TouchableOpacity>
                {user && (c.senderUid === user.uid || isAdmin) && (
                  <TouchableOpacity onPress={() =>
                    confirmAction('Delete comment?', 'This cannot be undone.', 'Delete',
                      () => deleteTicketComment(ticketId, c.id).catch(() => {}))
                  }>
                    <Text style={[s.commentAction, { color: '#D08080' }]}>Delete</Text>
                  </TouchableOpacity>
                )}
              </View>
              {renderReactions(c.reactions, emoji =>
                user && toggleTicketCommentReaction(ticketId, c.id, user.uid, emoji).catch(() => {}))}
            </View>
          ))}

          {/* Composer */}
          <View style={s.composer}>
            <TextInput
              style={s.composerInput}
              value={commentText}
              onChangeText={setCommentText}
              placeholder="Add a whisper…"
              placeholderTextColor="rgba(200,165,60,0.35)"
              selectionColor={GOLD}
              multiline
              maxLength={2000}
            />
            <TouchableOpacity
              style={[s.sendBtn, (!commentText.trim() || sending) && { opacity: 0.4 }]}
              disabled={!commentText.trim() || sending}
              onPress={sendComment}
            >
              <Feather name="send" size={17} color="#FFD700" />
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Reaction picker */}
      <Modal visible={!!picker} transparent animationType="fade" onRequestClose={() => setPicker(null)}>
        <TouchableOpacity style={s.pickerBackdrop} activeOpacity={1} onPress={() => setPicker(null)}>
          <View style={s.pickerSheet}>
            {REACTION_EMOJIS.map(e => (
              <TouchableOpacity key={e} style={s.pickerCell} onPress={() => applyReaction(e)}>
                <Text style={{ fontSize: 24 }}>{e}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  nav:  { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10 },
  navRow: { position: 'absolute', bottom: 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center' },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 10, marginLeft: 'auto' },
  navTitle: {
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: CREAM, fontSize: 16, fontFamily: 'Cinzel_700Bold', letterSpacing: 1,
  },
  dagIcon: { width: 34, height: 34 },
  sqIcon:  { width: 34, height: 34 },

  tab: {
    width: Math.min(SW * 0.66, 270),
    backgroundColor: '#0D0D0D', borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(212,168,83,0.5)',
    justifyContent: 'center', paddingHorizontal: 12,
  },
  tabText: { color: GOLD, fontSize: 12, fontFamily: 'Cinzel_700Bold', letterSpacing: 2 },
  body: {
    backgroundColor: '#0A0A0A',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    padding: 14,
  },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaText: { color: 'rgba(237,224,196,0.6)', fontSize: 11, fontFamily: 'Inter_400Regular', flex: 1 },

  spreadLabel: {
    marginTop: 22, marginBottom: 4,
    fontSize: 10.5, color: GOLD, fontFamily: 'Cinzel_700Bold',
    letterSpacing: 2.5, textTransform: 'uppercase',
  },

  ownerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  ownerBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 8,
    paddingHorizontal: 11, paddingVertical: 7,
  },
  ownerBtnText: { color: GOLD, fontSize: 11.5, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 1 },

  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 12,
    paddingHorizontal: 8, paddingVertical: 3, backgroundColor: 'rgba(200,165,60,0.05)',
  },
  reactionChipMine: { borderColor: 'rgba(255,215,0,0.7)', backgroundColor: 'rgba(255,215,0,0.1)' },
  reactionEmoji: { fontSize: 13 },
  reactionCount: { color: CREAM, fontSize: 11, fontFamily: 'Inter_500Medium' },

  commentsHeader: {
    ...MARBLE_TEXT_SHADOW,
    marginTop: 22, marginBottom: 10,
    color: GOLD, fontSize: 12, fontFamily: 'Cinzel_700Bold', letterSpacing: 2.5,
  },
  commentCard: {
    backgroundColor: '#0A0A0A', borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)',
    borderRadius: 9, padding: 12, marginBottom: 10,
  },
  commentTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  commentAuthor: { color: GOLD, fontSize: 11.5, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 1 },
  commentTime: { color: 'rgba(237,224,196,0.4)', fontSize: 10, fontFamily: 'Inter_400Regular' },
  commentText: { color: CREAM, fontSize: 13.5, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  commentActions: { flexDirection: 'row', gap: 16, marginTop: 8 },
  commentAction: { color: 'rgba(212,168,83,0.8)', fontSize: 11, fontFamily: 'Inter_500Medium' },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 6,
  },
  composerInput: {
    flex: 1, minHeight: 44, maxHeight: 110,
    backgroundColor: '#0A0A0A', borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
    borderRadius: 10, color: CREAM, paddingHorizontal: 12, paddingVertical: 11,
    fontSize: 13.5, fontFamily: 'Inter_400Regular',
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,215,0,0.55)', backgroundColor: '#0D0D0D',
  },

  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  pickerSheet: {
    flexDirection: 'row', flexWrap: 'wrap', width: 280,
    backgroundColor: '#0E0900', borderRadius: 14, padding: 10,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', justifyContent: 'center',
  },
  pickerCell: { width: 56, height: 50, alignItems: 'center', justifyContent: 'center' },
});
