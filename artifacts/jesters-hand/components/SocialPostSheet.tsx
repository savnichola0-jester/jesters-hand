import React, { ReactNode, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Modal, Platform, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import {
  createSocialComment, listenSocialComments, SocialComment,
  SOCIAL_REACTION_EMOJIS, toggleSocialCommentReaction, toggleSocialReaction,
} from '@/lib/socialPostService';

const CREAM = '#EDE0C4';
const GOLD = '#D4A853';

type Props = {
  visible: boolean;
  onClose: () => void;
  title: string;
  parentPath: string;
  currentUid: string;
  currentJokerId: string;
  reactions: Record<string, string[]>;
  commentCount: number;
  children: ReactNode;
  footer?: ReactNode;
};

export default function SocialPostSheet({
  visible, onClose, title, parentPath, currentUid, currentJokerId,
  reactions, commentCount, children, footer,
}: Props) {
  const insets = useSafeAreaInsets();
  const [comments, setComments] = useState<SocialComment[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerFor, setPickerFor] = useState<'post' | string | null>(null);

  useEffect(() => {
    if (!visible) return;
    return listenSocialComments(parentPath, setComments);
  }, [visible, parentPath]);

  const activeReactions = useMemo(
    () => Object.entries(reactions).filter(([, uids]) => uids.length > 0),
    [reactions],
  );

  const chooseReaction = async (emoji: string) => {
    const target = pickerFor;
    setPickerFor(null);
    if (target === 'post') await toggleSocialReaction(parentPath, currentUid, emoji);
    else if (target) await toggleSocialCommentReaction(parentPath, target, currentUid, emoji);
  };

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await createSocialComment(parentPath, currentUid, currentJokerId, text);
      setText('');
    } finally {
      setSending(false);
    }
  };

  const reactionChips = (value: Record<string, string[]>, onPick: () => void) => {
    const entries = Object.entries(value).filter(([, uids]) => uids.length > 0);
    return (
      <View style={s.reactionRow}>
        {entries.map(([emoji, uids]) => (
          <TouchableOpacity
            key={emoji}
            style={[s.reactionChip, uids.includes(currentUid) && s.reactionChipMine]}
            onPress={() => {
              if (onPick === undefined) return;
              if (value === reactions) toggleSocialReaction(parentPath, currentUid, emoji).catch(() => {});
              else {
                const comment = comments.find(c => c.reactions === value);
                if (comment) toggleSocialCommentReaction(parentPath, comment.id, currentUid, emoji).catch(() => {});
              }
            }}
          >
            <Text style={s.reactionEmoji}>{emoji}</Text>
            <Text style={s.reactionCount}>{uids.length}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={s.markButton} onPress={onPick}>
          <Feather name="tag" size={14} color={GOLD} />
          <Text style={s.markText}>MARK</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={s.root}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[s.header, { paddingTop: insets.top }]}>
          <Text style={s.title} numberOfLines={1}>{title}</Text>
          <TouchableOpacity onPress={onClose} hitSlop={10}>
            <Feather name="x" size={24} color={CREAM} />
          </TouchableOpacity>
        </View>
        <ScrollView
          style={s.scroll}
          contentContainerStyle={s.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={s.post}>{children}</View>
          {reactionChips(reactions, () => setPickerFor('post'))}
          {footer}
          <View style={s.divider} />
          <Text style={s.commentsTitle}>SPEAK YOUR PIECE · {commentCount || comments.length}</Text>
          {comments.map(comment => (
            <View key={comment.id} style={s.comment}>
              <Text style={s.commentAuthor}>
                {comment.senderUid === currentUid ? 'YOU' : comment.senderJokerId || 'JOKER'}
              </Text>
              <Text style={s.commentText}>{comment.text}</Text>
              {reactionChips(comment.reactions, () => setPickerFor(comment.id))}
            </View>
          ))}
        </ScrollView>
        <View style={[s.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Speak your piece…"
            placeholderTextColor="rgba(237,224,196,0.35)"
            style={s.input}
            maxLength={2000}
            multiline
          />
          <TouchableOpacity
            style={[s.send, (!text.trim() || sending) && s.disabled]}
            onPress={send}
            disabled={!text.trim() || sending}
          >
            {sending
              ? <ActivityIndicator size="small" color={GOLD} />
              : <Text style={s.sendText}>SPEAK</Text>
            }
          </TouchableOpacity>
        </View>
        {pickerFor ? (
          <View style={[s.picker, { bottom: Math.max(insets.bottom, 10) + 70 }]}>
            {SOCIAL_REACTION_EMOJIS.map(emoji => (
              <TouchableOpacity key={emoji} style={s.pickerEmoji} onPress={() => chooseReaction(emoji)}>
                <Text style={s.pickerEmojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#090806' },
  header: {
    minHeight: 58, paddingHorizontal: 16, paddingBottom: 10,
    flexDirection: 'row', alignItems: 'flex-end',
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.25)',
  },
  title: { flex: 1, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 1.5 },
  scroll: { flex: 1 },
  content: { padding: 14, paddingBottom: 24 },
  post: {
    backgroundColor: 'rgba(5,3,0,0.82)', borderRadius: 10, borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.25)', padding: 12,
  },
  reactionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  reactionChip: {
    minHeight: 30, flexDirection: 'row', gap: 4, alignItems: 'center',
    paddingHorizontal: 8, borderRadius: 15, borderWidth: 1,
    borderColor: 'rgba(237,224,196,0.18)', backgroundColor: 'rgba(0,0,0,0.45)',
  },
  reactionChipMine: { borderColor: 'rgba(212,168,83,0.75)', backgroundColor: 'rgba(212,168,83,0.12)' },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 11 },
  markButton: {
    minHeight: 30, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
  },
  markText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1 },
  divider: { height: 1, backgroundColor: 'rgba(212,168,83,0.2)', marginVertical: 16 },
  commentsTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1.5, marginBottom: 10 },
  comment: {
    padding: 10, marginBottom: 8, borderRadius: 9,
    backgroundColor: 'rgba(237,224,196,0.05)', borderWidth: 1, borderColor: 'rgba(237,224,196,0.1)',
  },
  commentAuthor: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 1.2, marginBottom: 5 },
  commentText: { color: CREAM, fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 19 },
  composer: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 9,
    borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.2)', backgroundColor: '#050403',
  },
  input: {
    flex: 1, minHeight: 42, maxHeight: 90, borderRadius: 9, borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.35)', color: CREAM, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: 'rgba(0,0,0,0.45)', fontFamily: 'Inter_400Regular', fontSize: 13,
  },
  send: {
    minWidth: 66, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 12,
    borderWidth: 1, borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.1)',
  },
  sendText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.2 },
  disabled: { opacity: 0.4 },
  picker: {
    position: 'absolute', left: 14, right: 14, flexDirection: 'row', flexWrap: 'wrap',
    justifyContent: 'center', gap: 4, padding: 8, borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.55)', backgroundColor: '#120E09',
  },
  pickerEmoji: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  pickerEmojiText: { fontSize: 21 },
});