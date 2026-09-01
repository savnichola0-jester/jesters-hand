import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ActivityIndicator, Modal,
  FlatList, TextInput, KeyboardAvoidingView, Alert,
} from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import { useWhisper } from '@/contexts/WhisperContext';
import {
  Conversation,
  getOrCreateDM, createGroup,
  getConvDisplayName, formatTimestamp, markRead, clearConversation,
  sweepOrphanedConversations,
} from '@/lib/whisperService';
import BellNavIcon from '@/components/BellNavIcon';
import GroupAvatarCollage from '@/components/GroupAvatarCollage';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/lace_bg.png');

const { width: SW } = appWindow();

const NAV_H = 52;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const RED   = '#E53E3E';

export default function WhisperScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user } = useAuth();
  // Member/avatar caches now live in WhisperContext so every screen shares
  // one live listener and avatar changes propagate app-wide immediately.
  const {
    conversations,
    allMembers: allMembersLive,
    membersReady,
    memberCache,
    avatarCache,
  } = useWhisper();
  const params = useLocalSearchParams<{ recipientUid?: string }>();

  // Group creation modal state
  const [groupModalVisible, setGroupModalVisible] = useState(false);
  const [selectedUids, setSelectedUids]           = useState<Set<string>>(new Set());
  const [groupName, setGroupName]                 = useState('');
  const [memberFilter, setMemberFilter]           = useState('');
  const [creatingGroup, setCreatingGroup]         = useState(false);

  // Compose action sheet state
  const [composeSheetVisible, setComposeSheetVisible] = useState(false);

  // New DM modal state
  const [dmModalVisible, setDmModalVisible]       = useState(false);
  const [dmFilter, setDmFilter]                   = useState('');
  const [openingDm, setOpeningDm]                 = useState(false);

  // Members for each modal — exclude current user, derived from the live list
  const otherMembers = allMembersLive.filter(m => m.uid !== user?.uid);

  // Auth guard
  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  // One-time orphan sweep: conversations left with zero members before the
  // last-member-leaves fix are deleted (with their messages) the first time
  // any signed-in user opens Whispers. Best-effort, fire-and-forget.
  const sweptOrphans = useRef(false);
  useEffect(() => {
    if (!user || sweptOrphans.current) return;
    sweptOrphans.current = true;
    sweepOrphanedConversations().catch(console.error);
  }, [user]);

  // Handle incoming recipientUid param → auto-open or create DM
  const handledRecipient = useRef<string | null>(null);
  useEffect(() => {
    const ruid = params.recipientUid;
    if (!ruid || !user || handledRecipient.current === ruid) return;
    handledRecipient.current = ruid;
    getOrCreateDM(user.uid, ruid).then(convId => {
      router.push({ pathname: '/(tabs)/chat', params: { conversationId: convId } });
    }).catch(console.error);
  }, [params.recipientUid, user]);

  const openConversation = useCallback((conv: Conversation) => {
    if (user) markRead(conv.id, user.uid).catch(() => {});
    router.push({ pathname: '/(tabs)/chat', params: { conversationId: conv.id } });
  }, [user]);

  const handleClear = useCallback((conv: Conversation) => {
    const name = getConvDisplayName(conv, user?.uid ?? '', memberCache);
    Alert.alert(
      'Clear Conversation',
      `Remove "${name}" from your Pocket? Other members won't be affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear',
          style: 'destructive',
          onPress: () => {
            if (user) clearConversation(conv.id, user.uid).catch(console.error);
          },
        },
      ],
    );
  }, [user, memberCache]);

  // ── New DM modal ───────────────────────────────────────────────────────────
  const openDmModal = useCallback(() => {
    setDmFilter('');
    setDmModalVisible(true);
  }, []);

  const startDm = useCallback(async (recipientUid: string) => {
    if (!user || openingDm) return;
    setOpeningDm(true);
    try {
      const convId = await getOrCreateDM(user.uid, recipientUid);
      setDmModalVisible(false);
      router.push({ pathname: '/(tabs)/chat', params: { conversationId: convId } });
    } catch (e) {
      console.error('[Whisper] startDm error:', e);
    } finally {
      setOpeningDm(false);
    }
  }, [user, openingDm]);

  const filteredDmMembers = otherMembers.filter(m => {
    if (!dmFilter) return true;
    const f = dmFilter.toLowerCase();
    return (
      m.jokerId.toLowerCase().includes(f) ||
      (m.name ?? '').toLowerCase().includes(f)
    );
  });

  // ── Group modal ────────────────────────────────────────────────────────────
  const openGroupModal = useCallback(() => {
    setSelectedUids(new Set());
    setGroupName('');
    setMemberFilter('');
    setGroupModalVisible(true);
  }, []);

  const toggleMember = useCallback((uid: string) => {
    setSelectedUids(prev => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }, []);

  const confirmCreateGroup = useCallback(async () => {
    if (!user || selectedUids.size === 0) return;
    setCreatingGroup(true);
    try {
      const convId = await createGroup(user.uid, Array.from(selectedUids), groupName || 'Group');
      setGroupModalVisible(false);
      router.push({ pathname: '/(tabs)/chat', params: { conversationId: convId } });
    } catch (e) {
      console.error('[Whisper] createGroup error:', e);
    } finally {
      setCreatingGroup(false);
    }
  }, [user, selectedUids, groupName]);

  const filteredMembers = otherMembers.filter(m => {
    if (!memberFilter) return true;
    const f = memberFilter.toLowerCase();
    return (
      m.jokerId.toLowerCase().includes(f) ||
      (m.name ?? '').toLowerCase().includes(f)
    );
  });

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
          <Text style={s.navTitle}>Pocket</Text>
          <View style={s.navRight}>
            <TouchableOpacity
              onPress={() => setComposeSheetVisible(true)}
              activeOpacity={0.75}
              style={s.composeBtn}
            >
              <Feather name="edit" size={16} color={GOLD} />
            </TouchableOpacity>
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Conversation list ── */}
      {conversations.length === 0 ? (
        <View style={[s.center, { top: navBottom }]}>
          <Feather name="message-circle" size={38} color="rgba(212,168,83,0.25)" />
          <Text style={[MARBLE_TEXT_SHADOW, s.emptyText]}>No deals in your Pocket yet.</Text>
          <Text style={[MARBLE_TEXT_SHADOW, s.emptySubText]}>Start a DM from The Hand, or create a group.</Text>
        </View>
      ) : (
        <FlatList
          style={{ position: 'absolute', top: navBottom, left: 0, right: 0, bottom: 0 }}
          contentContainerStyle={{ paddingVertical: 8 }}
          showsVerticalScrollIndicator={false}
          data={conversations}
          keyExtractor={conv => conv.id}
          renderItem={({ item: conv }) => {
            const unread  = conv.unreadCounts[user?.uid ?? ''] ?? 0;
            const name    = getConvDisplayName(conv, user?.uid ?? '', memberCache);
            const timeStr = formatTimestamp(conv.lastMessageAt);

            const renderRightActions = (
              _progress: any,
              dragX: any,
            ) => {
              return (
                <TouchableOpacity
                  style={s.deleteAction}
                  onPress={() => handleClear(conv)}
                  activeOpacity={0.85}
                >
                  <Feather name="trash-2" size={20} color="#fff" />
                  <Text style={s.deleteActionText}>Delete</Text>
                </TouchableOpacity>
              );
            };

            return (
              <Swipeable
                renderRightActions={renderRightActions}
                rightThreshold={40}
                overshootRight={false}
              >
                <TouchableOpacity
                  style={[s.convRow, unread > 0 && s.convRowUnread]}
                  onPress={() => openConversation(conv)}
                  activeOpacity={0.80}
                >
                  {/* Avatar */}
                  {conv.isGroup ? (
                    <GroupAvatarCollage
                      memberUids={conv.memberUids.filter(u => u !== user?.uid)}
                      avatarCache={avatarCache}
                      memberCache={memberCache}
                    />
                  ) : (() => {
                    const otherUid = conv.memberUids.find(u => u !== user?.uid);
                    const photoUrl = otherUid ? avatarCache[otherUid] : null;
                    return (
                      <View style={s.avatar}>
                        {photoUrl ? (
                          <Image source={{ uri: photoUrl }} style={s.avatarImage} />
                        ) : (
                          <Text style={s.avatarText}>{name.slice(0, 2).toUpperCase()}</Text>
                        )}
                      </View>
                    );
                  })()}

                  {/* Middle */}
                  <View style={s.convMid}>
                    <Text style={s.convName} numberOfLines={1}>{name}</Text>
                    <Text
                      style={[s.convPreview, unread > 0 && s.convPreviewUnread]}
                      numberOfLines={1}
                    >
                      {conv.lastMessage || 'No messages yet'}
                    </Text>
                  </View>

                  {/* Right */}
                  <View style={s.convRight}>
                    {timeStr ? <Text style={s.convTime}>{timeStr}</Text> : null}
                    {unread > 0 ? (
                      <View style={s.unreadBadge}>
                        <Text style={s.unreadText}>{unread > 99 ? '99+' : unread}</Text>
                      </View>
                    ) : null}
                  </View>
                </TouchableOpacity>
              </Swipeable>
            );
          }}
        />
      )}

      {/* ── Compose action sheet ── */}
      <Modal
        visible={composeSheetVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setComposeSheetVisible(false)}
      >
        <TouchableOpacity
          style={s.modalOverlay}
          activeOpacity={1}
          onPress={() => setComposeSheetVisible(false)}
        >
          <View style={s.composeSheet}>
            <View style={s.composeHandle} />
            <TouchableOpacity
              style={s.composeOption}
              activeOpacity={0.75}
              onPress={() => { setComposeSheetVisible(false); openDmModal(); }}
            >
              <View style={s.composeOptionIcon}>
                <Feather name="message-circle" size={20} color={GOLD} />
              </View>
              <View style={s.composeOptionText}>
                <Text style={s.composeOptionTitle}>New DM</Text>
                <Text style={s.composeOptionSub}>Start a private conversation</Text>
              </View>
              <Feather name="chevron-right" size={16} color="rgba(212,168,83,0.4)" />
            </TouchableOpacity>
            <View style={s.composeDivider} />
            <TouchableOpacity
              style={s.composeOption}
              activeOpacity={0.75}
              onPress={() => { setComposeSheetVisible(false); openGroupModal(); }}
            >
              <View style={s.composeOptionIcon}>
                <Feather name="users" size={20} color={GOLD} />
              </View>
              <View style={s.composeOptionText}>
                <Text style={s.composeOptionTitle}>New Group</Text>
                <Text style={s.composeOptionSub}>Create a group conversation</Text>
              </View>
              <Feather name="chevron-right" size={16} color="rgba(212,168,83,0.4)" />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ── New DM modal ── */}
      <Modal
        visible={dmModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setDmModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {/* Modal header */}
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>New DM</Text>
              <TouchableOpacity onPress={() => setDmModalVisible(false)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>

            {/* Member search */}
            <View style={[s.searchRow, { marginTop: 14 }]}>
              <Feather name="search" size={14} color="rgba(237,224,196,0.4)" />
              <TextInput
                style={s.searchInput}
                placeholder="Search Joker ID or name"
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={dmFilter}
                onChangeText={setDmFilter}
              />
            </View>

            {/* Member list */}
            {!membersReady ? (
              <View style={s.modalCenter}>
                <ActivityIndicator color={GOLD} />
              </View>
            ) : (
              <FlatList
                data={filteredDmMembers}
                keyExtractor={m => m.uid}
                style={s.memberList}
                renderItem={({ item }) => {
                  const initials = (item.name ?? item.jokerId).slice(0, 2).toUpperCase();
                  return (
                    <TouchableOpacity
                      style={s.memberRow}
                      onPress={() => startDm(item.uid)}
                      disabled={openingDm}
                      activeOpacity={0.75}
                    >
                      {/* Circular photo / initials */}
                      <View style={s.memberAvatar}>
                        {item.mugUrl ? (
                          <Image source={{ uri: item.mugUrl }} style={s.memberAvatarImage} />
                        ) : (
                          <Text style={s.memberAvatarText}>{initials}</Text>
                        )}
                      </View>
                      <Text style={s.memberJokerId}>{item.jokerId}</Text>
                      {item.name ? <Text style={s.memberName}>{item.name}</Text> : null}
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <Text style={[s.emptyText, { padding: 20, textAlign: 'center' }]}>No members found.</Text>
                }
              />
            )}
          </View>
        </View>
      </Modal>

      {/* ── Group creation modal ── */}
      <Modal
        visible={groupModalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setGroupModalVisible(false)}
      >
        <View style={s.modalOverlay}>
          <View style={s.modalSheet}>
            {/* Modal header */}
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>New Group</Text>
              <TouchableOpacity onPress={() => setGroupModalVisible(false)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>

            {/* Group name input */}
            <TextInput
              style={s.groupNameInput}
              placeholder="Group name (optional)"
              placeholderTextColor="rgba(237,224,196,0.35)"
              value={groupName}
              onChangeText={setGroupName}
            />

            {/* Member search */}
            <View style={s.searchRow}>
              <Feather name="search" size={14} color="rgba(237,224,196,0.4)" />
              <TextInput
                style={s.searchInput}
                placeholder="Search Joker ID or name"
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={memberFilter}
                onChangeText={setMemberFilter}
              />
            </View>

            {/* Selected count */}
            {selectedUids.size > 0 && (
              <Text style={s.selectedCount}>
                {selectedUids.size} member{selectedUids.size > 1 ? 's' : ''} selected
              </Text>
            )}

            {/* Member list */}
            {!membersReady ? (
              <View style={s.modalCenter}>
                <ActivityIndicator color={GOLD} />
              </View>
            ) : (
              <FlatList
                data={filteredMembers}
                keyExtractor={m => m.uid}
                style={s.memberList}
                renderItem={({ item }) => {
                  const selected = selectedUids.has(item.uid);
                  const initials = (item.name ?? item.jokerId).slice(0, 2).toUpperCase();
                  return (
                    <TouchableOpacity
                      style={[s.memberRow, selected && s.memberRowSelected]}
                      onPress={() => toggleMember(item.uid)}
                      activeOpacity={0.75}
                    >
                      <View style={[s.checkBox, selected && s.checkBoxSelected]}>
                        {selected && <Feather name="check" size={12} color="#000" />}
                      </View>
                      {/* Member photo / initials */}
                      <View style={s.memberAvatar}>
                        {item.mugUrl ? (
                          <Image source={{ uri: item.mugUrl }} style={s.memberAvatarImage} />
                        ) : (
                          <Text style={s.memberAvatarText}>{initials}</Text>
                        )}
                      </View>
                      <Text style={s.memberJokerId}>{item.jokerId}</Text>
                      {item.name ? <Text style={s.memberName}>{item.name}</Text> : null}
                    </TouchableOpacity>
                  );
                }}
                ListEmptyComponent={
                  <Text style={s.emptyText}>No members found.</Text>
                }
              />
            )}

            {/* Create button */}
            <TouchableOpacity
              style={[s.createBtn, (selectedUids.size === 0 || creatingGroup) && s.createBtnDisabled]}
              onPress={confirmCreateGroup}
              disabled={selectedUids.size === 0 || creatingGroup}
              activeOpacity={0.85}
            >
              {creatingGroup
                ? <ActivityIndicator color={GOLD} />
                : <Text style={s.createBtnText}>Create Group</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8, gap: 6 },
  navTitle: { flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 6 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },
  composeBtn: {
    width: 34, height: 34, borderRadius: 17,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.35)',
    backgroundColor: 'rgba(200,165,60,0.07)',
    alignItems: 'center', justifyContent: 'center',
  },
  deleteAction: {
    width: 80,
    backgroundColor: RED,
    alignItems: 'center', justifyContent: 'center',
    gap: 4,
  },
  deleteActionText: {
    color: '#fff',
    fontFamily: 'Cinzel_600SemiBold',
    fontSize: 10,
    letterSpacing: 1,
  },
  composeSheet: {
    backgroundColor: '#0D0B08',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.25)',
    paddingBottom: 32, paddingTop: 12,
  },
  composeHandle: {
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(200,165,60,0.25)',
    alignSelf: 'center', marginBottom: 16,
  },
  composeOption: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16, gap: 16,
  },
  composeOptionIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(200,165,60,0.08)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    alignItems: 'center', justifyContent: 'center',
  },
  composeOptionText: { flex: 1, gap: 3 },
  composeOptionTitle: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 14, letterSpacing: 1 },
  composeOptionSub: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_400Regular', fontSize: 11 },
  composeDivider: { height: 1, backgroundColor: 'rgba(200,165,60,0.08)', marginHorizontal: 20 },

  center: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 10 },
  emptyText:    { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 13, opacity: 0.5 },
  emptySubText: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 11, opacity: 0.35, textAlign: 'center', paddingHorizontal: 40 },

  // Conversation rows
  convRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(200,165,60,0.08)',
    backgroundColor: 'rgba(5,3,0,0.7)',
    gap: 12,
  },
  convRowUnread: { backgroundColor: 'rgba(212,168,83,0.06)' },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: 'rgba(200,165,60,0.12)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13 },
  avatarImage: { width: 46, height: 46, borderRadius: 23 },
  convMid: { flex: 1, gap: 4 },
  convName: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 13 },
  convPreview: { color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_400Regular', fontSize: 12 },
  convPreviewUnread: { color: 'rgba(237,224,196,0.75)', fontFamily: 'Cinzel_600SemiBold' },
  convRight: { alignItems: 'flex-end', gap: 6 },
  convTime: { color: 'rgba(237,224,196,0.3)', fontFamily: 'Cinzel_400Regular', fontSize: 10 },
  unreadBadge: {
    minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 5,
    backgroundColor: RED, alignItems: 'center', justifyContent: 'center',
  },
  unreadText: { color: '#fff', fontSize: 10, fontWeight: '700' },

  // Group modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  modalSheet: {
    backgroundColor: '#0D0B08',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.25)',
    maxHeight: '85%', paddingBottom: 24,
  },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(200,165,60,0.12)',
  },
  modalTitle: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 16, letterSpacing: 2 },
  groupNameInput: {
    marginHorizontal: 16, marginTop: 14, marginBottom: 8,
    height: 46, backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 14,
  },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginBottom: 6,
    paddingHorizontal: 12,
    height: 38, backgroundColor: 'rgba(255,255,255,0.04)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.12)',
  },
  searchInput: { flex: 1, color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12, height: 38 },
  selectedCount: {
    color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1,
    marginHorizontal: 16, marginBottom: 4,
  },
  memberList: { maxHeight: 320, marginTop: 2 },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(200,165,60,0.07)',
  },
  memberRowSelected: { backgroundColor: 'rgba(212,168,83,0.06)' },
  checkBox: {
    width: 22, height: 22, borderRadius: 4,
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.35)',
    alignItems: 'center', justifyContent: 'center',
  },
  checkBoxSelected: { backgroundColor: GOLD, borderColor: GOLD },
  memberAvatar: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(200,165,60,0.12)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden',
  },
  memberAvatarImage: { width: 32, height: 32, borderRadius: 16 },
  memberAvatarText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11 },
  memberJokerId: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 1.5 },
  memberName: { color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_400Regular', fontSize: 11, flex: 1 },
  modalCenter: { height: 100, alignItems: 'center', justifyContent: 'center' },
  createBtn: {
    marginHorizontal: 16, marginTop: 12, height: 50, borderRadius: 14,
    backgroundColor: 'rgba(200,165,60,0.12)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  createBtnDisabled: { opacity: 0.4 },
  createBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2 },
});
