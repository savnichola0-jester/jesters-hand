import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, StyleSheet,
  Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import { useColors } from '@/hooks/useColors';
import {
  GameRoomMessage, listenGameRoomMessages, sendGameRoomMessage,
} from '@/lib/gameRoomCommsService';
import {
  joinGameRoomVoiceChannel, voiceSupported, VoiceSession,
} from '@/lib/voiceService';

export type GameRoomCommsProps = {
  roomId: string;
  jokerId: string;
};

/** Private text and voice controls for one game room; it never posts to Table. */
export default function GameRoomComms({ roomId, jokerId }: GameRoomCommsProps) {
  const colors = useColors();
  const { user } = useAuth();
  const [messages, setMessages] = useState<GameRoomMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [voiceSession, setVoiceSession] = useState<VoiceSession | null>(null);
  const [voiceJoining, setVoiceJoining] = useState(false);
  const [voiceMuted, setVoiceMuted] = useState(false);
  const [voiceMembers, setVoiceMembers] = useState(1);
  const [error, setError] = useState('');

  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setError('');
    const unsubscribe = listenGameRoomMessages(roomId, next => {
      setMessages(next);
      setLoading(false);
    }, listenerError => {
      setError(listenerError.message || 'Could not load this room’s chat.');
      setLoading(false);
    });
    return unsubscribe;
  }, [roomId]);

  useEffect(() => {
    return () => voiceSession?.leave();
  }, [roomId, voiceSession]);

  const latestFirst = useMemo(() => [...messages].reverse(), [messages]);
  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput('');
    setError('');
    try {
      await sendGameRoomMessage(roomId, jokerId, text);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    } catch (sendError) {
      setInput(text);
      setError(sendError instanceof Error ? sendError.message : 'Could not send this message.');
    } finally {
      setSending(false);
    }
  }, [input, jokerId, roomId, sending]);

  const joinVoice = useCallback(async () => {
    setVoiceJoining(true);
    setError('');
    try {
      const session = await joinGameRoomVoiceChannel(roomId, jokerId, {
        onMembersChanged: setVoiceMembers,
        onEnded: () => {
          setVoiceSession(null);
          setVoiceMuted(false);
          setVoiceMembers(1);
        },
      });
      setVoiceSession(session);
      setVoiceMuted(false);
    } catch (joinError) {
      setError(joinError instanceof Error ? joinError.message : 'Could not join room voice.');
    } finally {
      setVoiceJoining(false);
    }
  }, [jokerId, roomId]);

  const styles = makeStyles(colors);
  const inVoice = !!voiceSession;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <View style={styles.titleWrap}>
          <Feather name="message-square" size={16} color={colors.primary} />
          <Text style={styles.title}>ROOM CHAT</Text>
        </View>
        {!voiceSupported() ? (
          <Text style={styles.voiceUnavailable}>Voice on web</Text>
        ) : inVoice ? (
          <View style={styles.voiceControls}>
            <Text style={styles.voiceCount}>{voiceMembers} in voice</Text>
            <TouchableOpacity
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={voiceMuted ? 'Unmute microphone' : 'Mute microphone'}
              onPress={() => {
                voiceSession?.setMuted(!voiceMuted);
                setVoiceMuted(value => !value);
              }}
            >
              <MaterialIcons name={voiceMuted ? 'mic-off' : 'mic'} size={19} color={colors.primary} />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Leave room voice"
              onPress={() => voiceSession?.leave()}
            >
              <MaterialIcons name="call-end" size={18} color={colors.destructive} />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.joinButton}
            onPress={() => void joinVoice()}
            disabled={voiceJoining}
            accessibilityRole="button"
            accessibilityLabel="Join private room voice"
          >
            {voiceJoining
              ? <ActivityIndicator size="small" color={colors.primaryForeground} />
              : <><MaterialIcons name="mic" size={16} color={colors.primaryForeground} /><Text style={styles.joinText}>VOICE</Text></>}
          </TouchableOpacity>
        )}
      </View>

      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
      <FlatList
        style={styles.list}
        data={latestFirst}
        inverted
        keyExtractor={item => item.id}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={latestFirst.length > 0}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={
          loading
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Text style={styles.empty}>A private table for this game’s players.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.message}>
            <Text style={styles.author}>{item.senderUid === user?.uid ? 'You' : item.senderJokerId}</Text>
            <Text style={styles.messageText}>{item.text}</Text>
          </View>
        )}
      />
      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Message this game room…"
          placeholderTextColor={colors.mutedForeground}
          maxLength={1000}
          multiline
          accessibilityLabel="Game-room message"
          onSubmitEditing={() => void send()}
        />
        <TouchableOpacity
          style={styles.sendButton}
          onPress={() => void send()}
          disabled={!input.trim() || sending}
          accessibilityRole="button"
          accessibilityLabel="Send game-room message"
        >
          {sending
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <Feather name="send" size={18} color={colors.primary} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    container: {
      minHeight: 220, maxHeight: 360, overflow: 'hidden',
      borderWidth: 1, borderColor: colors.border, borderRadius: colors.radius,
      backgroundColor: colors.card,
    },
    header: {
      minHeight: 46, paddingHorizontal: 12, flexDirection: 'row',
      alignItems: 'center', justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border,
    },
    titleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { color: colors.text, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
    voiceUnavailable: { color: colors.mutedForeground, fontSize: 11 },
    voiceControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    voiceCount: { color: colors.mutedForeground, fontSize: 11 },
    iconButton: { padding: 7 },
    joinButton: {
      minHeight: 32, paddingHorizontal: 10, gap: 6, flexDirection: 'row',
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: colors.primary, borderRadius: colors.radius,
    },
    joinText: { color: colors.primaryForeground, fontSize: 10, fontWeight: '800', letterSpacing: 0.7 },
    list: { minHeight: 120, paddingHorizontal: 12 },
    message: { paddingVertical: 7 },
    author: { color: colors.primary, fontSize: 11, fontWeight: '700', marginBottom: 2 },
    messageText: { color: colors.text, fontSize: 14, lineHeight: 19 },
    empty: { color: colors.mutedForeground, fontSize: 12, textAlign: 'center', paddingVertical: 18 },
    composer: {
      minHeight: 48, flexDirection: 'row', alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
      paddingLeft: 12, paddingRight: 8,
    },
    input: { flex: 1, color: colors.text, fontSize: 14, maxHeight: 88, paddingVertical: 10 },
    sendButton: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
    error: { color: colors.destructive, fontSize: 12, paddingHorizontal: 12, paddingTop: 7 },
  });
}