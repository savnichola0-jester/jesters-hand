import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ActivityIndicator, Modal,
  FlatList, KeyboardAvoidingView, Alert, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/contexts/AuthContext';
import {
  BlackBookTab, BlackBookEntry, BlackBookEntryInput,
  listenBlackBookEntries, addBlackBookEntry, updateBlackBookEntry,
  deleteBlackBookEntry, formatBlackBookTimestamp,
} from '@/lib/blackBookService';
import { getAllMembers } from '@/lib/ticketService';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';
import SocialPostSheet from '@/components/SocialPostSheet';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW, height: SH } = appWindow();
const NAV_H  = 52;
const SIDE   = 16;
const TAB_H  = 40;
const CREAM  = '#EDE0C4';
const GOLD   = '#D4A853';

// ── Tab configuration ─────────────────────────────────────────────────────────
// Each tab renders the same list/editor machinery; only labels and fields
// differ, so new tag types can be added here without touching the machinery.
// Royals award suits — what each honor stands for.
const AWARD_SUIT_LABELS: Record<string, string> = {
  Spade:   '♠ Loyalty',
  Diamond: '♦ Investment',
  Heart:   '♥ Community',
  Club:    '♣ Discovery',
};

type FieldKey = 'title' | 'date' | 'location' | 'mode' | 'price' | 'progress' | 'notes' | 'suit';

interface FieldDef {
  key: FieldKey;
  label: string;
  placeholder?: string;
  multiline?: boolean;
  /** Render as pill choices instead of free text. */
  choices?: string[];
  /** Optional display text per choice value (the raw value is what's saved). */
  choiceLabels?: Record<string, string>;
  /** Numeric 0–100. */
  percent?: boolean;
  /** Override label/placeholder based on the currently selected mode pill. */
  variantsByMode?: Record<string, { label?: string; placeholder?: string }>;
}

interface TabView {
  subtitle: string;
  empty: string;
  fields: FieldDef[];
}

interface TabConfig {
  id: BlackBookTab;
  label: string;
  member: TabView;
  admin: TabView;
}

const TABS: TabConfig[] = [
  {
    id: 'recruit',
    label: 'RECRUIT',
    member: {
      subtitle: 'Events you attended',
      empty: 'No events logged yet.',
      fields: [
        { key: 'title', label: 'Event Name', placeholder: 'Event name' },
        { key: 'date', label: 'Date & Time', placeholder: 'e.g. Jul 12, 7pm' },
        { key: 'location', label: 'Location', placeholder: 'Where was it?' },
        { key: 'mode', label: 'Attendance', choices: ['In-Person', 'Twitch'] },
      ],
    },
    admin: {
      subtitle: 'Events hosted this year',
      empty: 'No hosted events logged yet.',
      fields: [
        { key: 'title', label: 'Event Name', placeholder: 'Event name' },
        { key: 'date', label: 'Date & Time', placeholder: 'e.g. Jul 12, 7pm' },
        { key: 'mode', label: 'Format', choices: ['In-Person', 'Live'] },
        {
          key: 'location', label: 'Location', placeholder: 'Where was it?',
          variantsByMode: {
            Live: { label: 'Live Location', placeholder: 'Where were you live at? (e.g. Twitch, IG Live)' },
          },
        },
      ],
    },
  },
  {
    id: 'uniform',
    label: 'UNIFORM',
    member: {
      subtitle: 'Merch you own',
      empty: 'No merch logged yet.',
      fields: [
        { key: 'title', label: 'Merch Title', placeholder: 'What did you get?' },
        { key: 'price', label: 'Price', placeholder: 'e.g. $25' },
      ],
    },
    admin: {
      subtitle: 'Merch released',
      empty: 'No merch releases logged yet.',
      fields: [
        { key: 'title', label: 'Merch Title', placeholder: 'What did you release?' },
        { key: 'price', label: 'Price', placeholder: 'e.g. $25' },
      ],
    },
  },
  {
    id: 'turn',
    label: 'THE TURN',
    member: {
      subtitle: 'Your read through the saga',
      empty: 'No reading progress yet.',
      fields: [
        { key: 'title', label: 'Book Title', placeholder: 'Which book?' },
        { key: 'progress', label: 'Progress', percent: true },
        { key: 'notes', label: 'Quick Review', placeholder: 'Your thoughts…', multiline: true },
      ],
    },
    admin: {
      subtitle: 'Writing the saga',
      empty: 'No writing progress yet.',
      fields: [
        { key: 'title', label: 'Book / Project', placeholder: 'Which book?' },
        { key: 'progress', label: 'Progress', percent: true },
        { key: 'notes', label: 'Status Notes', placeholder: 'Writing, editing, publishing…', multiline: true },
      ],
    },
  },
  {
    id: 'royals',
    label: 'ROYALS',
    member: {
      subtitle: 'Honors from the Jester',
      empty: 'No honors bestowed yet.',
      fields: [
        { key: 'title', label: 'Achievement', placeholder: 'Achievement' },
        { key: 'notes', label: 'Details', placeholder: 'Details…', multiline: true },
      ],
    },
    admin: {
      subtitle: 'Career achievements',
      empty: 'No achievements logged yet.',
      fields: [
        { key: 'title', label: 'Achievement', placeholder: 'Achievement' },
        { key: 'notes', label: 'Details', placeholder: 'Details…', multiline: true },
        { key: 'suit', label: 'Suit', choices: ['Spade', 'Diamond', 'Heart', 'Club'],
          choiceLabels: AWARD_SUIT_LABELS },
      ],
    },
  },
];

// Subtitles when peeking at another member's book (read-only third-person view).
const PEEK_SUBTITLES: Record<BlackBookTab, string> = {
  recruit: 'Events they attended',
  uniform: 'Merch they own',
  turn:    'Their read through the saga',
  royals:  'Honors from the Jester',
};

type MemberLite = { uid: string; label: string };
type EditorState = { entryId: string | null; values: Partial<Record<FieldKey, string>> };

export default function StreetArtScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isAdmin, jokerId } = useAuth();

  // ── Peek mode: viewing another member's book (read-only) ──
  const params = useLocalSearchParams<{ uid?: string; label?: string; tab?: string }>();
  const peekUid =
    typeof params.uid === 'string' && params.uid.length > 0 && params.uid !== user?.uid
      ? params.uid
      : null;
  const peeking = !!peekUid;
  const peekLabel = typeof params.label === 'string' && params.label.length > 0 ? params.label : null;

  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  // Deep link (e.g. royals-honor notification) can open a specific tab.
  const paramTab = typeof params.tab === 'string' ? params.tab : undefined;

  const [tabId, setTabId] = useState<BlackBookTab>(
    paramTab && (['recruit', 'uniform', 'turn', 'royals'] as string[]).includes(paramTab)
      ? (paramTab as BlackBookTab)
      : 'recruit',
  );

  useEffect(() => {
    if (paramTab && (['recruit', 'uniform', 'turn', 'royals'] as string[]).includes(paramTab)) {
      setTabId(paramTab as BlackBookTab);
    }
  }, [paramTab]);
  const tab = TABS.find(t => t.id === tabId)!;
  const view: TabView = isAdmin && !peeking ? tab.admin : tab.member;

  // ── Admin ROYALS sub-mode: own honors vs awarding members ──
  const [royalsMode, setRoyalsMode] = useState<'own' | 'award'>('own');
  const [members, setMembers] = useState<MemberLite[]>([]);
  const [awardUid, setAwardUid] = useState<string | null>(null);

  const awarding = isAdmin && !peeking && tabId === 'royals' && royalsMode === 'award';

  useEffect(() => {
    if (!awarding || members.length > 0 || !user) return;
    getAllMembers().then(all => {
      setMembers(all
        .filter(m => m.uid !== user.uid)
        .map((m: any) => ({ uid: m.uid, label: [m.jokerId, m.name].filter(Boolean).join(' — ') || '——' })));
    }).catch(() => {});
  }, [awarding, members.length, user]);

  // Whose book is on the table right now?
  const bookUid = peeking ? peekUid : awarding ? awardUid : (user?.uid ?? null);

  // Can the current user add/edit entries on this tab?
  // Peeking at someone else's book is always read-only.
  const canEdit = peeking ? false
    : tabId !== 'royals' ? !!user
    : isAdmin ? (!awarding || !!awardUid)
    : false; // royals is read-only for members

  // ── Entries ──
  const [entries, setEntries] = useState<BlackBookEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  useEffect(() => {
    if (!bookUid) { setEntries([]); setLoading(false); return; }
    setLoading(true);
    const unsub = listenBlackBookEntries(bookUid, tabId, e => {
      setEntries(e);
      setLoading(false);
    });
    return unsub;
  }, [bookUid, tabId]);
  const openEntry = entries.find(e => e.id === openEntryId) ?? null;

  const switchTab = useCallback((id: BlackBookTab) => {
    if (id === tabId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setTabId(id);
    setRoyalsMode('own');
    setAwardUid(null);
  }, [tabId]);

  // ── Editor modal ──
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);

  const openAdd = useCallback(() => {
    setEditor({ entryId: null, values: {} });
  }, []);

  const openEdit = useCallback((e: BlackBookEntry) => {
    setEditor({
      entryId: e.id,
      values: {
        title: e.title ?? '',
        date: e.date ?? '',
        location: e.location ?? '',
        mode: e.mode ?? '',
        price: e.price ?? '',
        progress: e.progress !== undefined ? String(e.progress) : '',
        notes: e.notes ?? '',
      },
    });
  }, []);

  const setValue = useCallback((key: FieldKey, v: string) => {
    setEditor(prev => prev ? { ...prev, values: { ...prev.values, [key]: v } } : prev);
  }, []);

  const saveEntry = useCallback(async () => {
    if (!editor || !user || !bookUid || saving) return;
    const title = (editor.values.title ?? '').trim();
    if (!title) return;
    const input: BlackBookEntryInput = { title };
    for (const f of view.fields) {
      if (f.key === 'title') continue;
      const raw = editor.values[f.key];
      if (raw === undefined) continue;
      if (f.percent) {
        const n = parseInt(raw, 10);
        // Empty/invalid input clears a previously saved progress value.
        input.progress = isNaN(n) ? null : n;
      } else {
        // Empty strings clear previously saved values on update.
        (input as any)[f.key] = raw;
      }
    }
    setSaving(true);
    try {
      if (editor.entryId) {
        await updateBlackBookEntry(bookUid, editor.entryId, input);
      } else {
        await addBlackBookEntry(bookUid, tabId, user.uid, input);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setEditor(null);
    } catch {
      Alert.alert('Save failed', 'Could not write to the Black Book. Try again.');
    } finally {
      setSaving(false);
    }
  }, [editor, user, bookUid, tabId, view.fields, saving]);

  const confirmDelete = useCallback((e: BlackBookEntry) => {
    if (!bookUid) return;
    Alert.alert('Tear out this page?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: () => deleteBlackBookEntry(bookUid, e.id).catch(() => {
          Alert.alert('Delete failed', 'Could not remove the entry. Try again.');
        }),
      },
    ]);
  }, [bookUid]);

  // ── Renderers ──
  const renderEntry = ({ item }: { item: BlackBookEntry }) => (
    <TouchableOpacity style={s.entryCard} activeOpacity={0.82} onPress={() => setOpenEntryId(item.id)}>
      <View style={s.entryHead}>
        <Text style={s.entryTitle} numberOfLines={2}>{item.title}</Text>
        {canEdit && (
          <View style={s.entryActions}>
            <TouchableOpacity onPress={() => openEdit(item)} hitSlop={8} activeOpacity={0.7}>
              <Feather name="edit-2" size={14} color={GOLD} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => confirmDelete(item)} hitSlop={8} activeOpacity={0.7}>
              <Feather name="trash-2" size={14} color="rgba(224,85,85,0.85)" />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {(item.date || item.location) ? (
        <Text style={s.entryMeta}>
          {[item.date, item.location].filter(Boolean).join('  ·  ')}
        </Text>
      ) : null}
      {item.mode ? (
        <View style={s.modePill}><Text style={s.modePillText}>{item.mode}</Text></View>
      ) : null}
      {item.price ? <Text style={s.entryMeta}>{item.price}</Text> : null}

      {item.progress !== undefined ? (
        <View style={s.progressWrap}>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${item.progress}%` }]} />
          </View>
          <Text style={s.progressPct}>{item.progress}%</Text>
        </View>
      ) : null}

      {item.suit && AWARD_SUIT_LABELS[item.suit] ? (
        <View style={s.modePill}>
          <Text style={s.modePillText}>{AWARD_SUIT_LABELS[item.suit]}</Text>
        </View>
      ) : null}
      {item.notes ? <Text style={s.entryNotes}>{item.notes}</Text> : null}
      <Text style={s.entryDateStamp}>{formatBlackBookTimestamp(item.createdAt)}</Text>
      <View style={s.socialSummary}>
        <Text style={s.socialSummaryText}>
          {Object.values(item.reactions).reduce((n, uids) => n + uids.length, 0)} MARKS
        </Text>
        <Text style={s.socialSummaryText}>{item.commentCount} COMMENTS</Text>
      </View>
    </TouchableOpacity>
  );

  const memberLabel = awardUid ? members.find(m => m.uid === awardUid)?.label : null;

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
          <Text style={s.navTitle} numberOfLines={1}>Street Art</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Screen label ── */}
      <Text style={[s.screenLabel, { top: navBottom + 8 }]} numberOfLines={1}>
        {peeking ? `${peekLabel ?? 'Joker'} — Black Book` : 'Black Book'}
      </Text>

      {/* ── Folder ── */}
      <View style={[s.folderWrap, { top: navBottom + 42 }]}>
        <View style={s.tabsRow}>
          {TABS.map(t => {
            const active = t.id === tabId;
            return (
              <TouchableOpacity
                key={t.id}
                style={[s.tab, active && s.tabActive]}
                onPress={() => switchTab(t.id)}
                activeOpacity={0.8}
              >
                <Text style={[s.tabText, active && s.tabTextActive]} numberOfLines={1}>
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.body}>
          {/* Admin royals sub-mode toggle */}
          {isAdmin && !peeking && tabId === 'royals' ? (
            <View style={s.subToggleRow}>
              <TouchableOpacity
                style={[s.subToggle, royalsMode === 'own' && s.subToggleActive]}
                onPress={() => { setRoyalsMode('own'); setAwardUid(null); }}
                activeOpacity={0.8}
              >
                <Text style={[s.subToggleText, royalsMode === 'own' && s.subToggleTextActive]}>
                  MY HONORS
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.subToggle, royalsMode === 'award' && s.subToggleActive]}
                onPress={() => setRoyalsMode('award')}
                activeOpacity={0.8}
              >
                <Text style={[s.subToggleText, royalsMode === 'award' && s.subToggleTextActive]}>
                  AWARD MEMBERS
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={s.subtitle}>{peeking ? PEEK_SUBTITLES[tabId] : view.subtitle}</Text>
          )}

          {/* Awarding: member picker */}
          {awarding && !awardUid ? (
            members.length === 0 ? (
              <View style={s.centerFill}><ActivityIndicator color={GOLD} /></View>
            ) : (
              <FlatList
                data={members}
                keyExtractor={m => m.uid}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={s.memberRow}
                    onPress={() => setAwardUid(item.uid)}
                    activeOpacity={0.75}
                  >
                    <Text style={s.memberRowText} numberOfLines={1}>{item.label}</Text>
                    <Feather name="chevron-right" size={16} color="rgba(212,168,83,0.5)" />
                  </TouchableOpacity>
                )}
              />
            )
          ) : (
            <>
              {awarding && awardUid ? (
                <TouchableOpacity style={s.awardHead} onPress={() => setAwardUid(null)} activeOpacity={0.75}>
                  <Feather name="chevron-left" size={16} color={GOLD} />
                  <Text style={s.awardHeadText} numberOfLines={1}>{memberLabel}</Text>
                </TouchableOpacity>
              ) : null}

              {loading ? (
                <View style={s.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
              ) : entries.length === 0 ? (
                <View style={s.centerFill}>
                  <Feather name="book" size={30} color="rgba(212,168,83,0.25)" />
                  <Text style={s.emptyText}>
                    {awarding ? 'No honors bestowed on this Joker yet.' : view.empty}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={entries}
                  keyExtractor={e => e.id}
                  style={{ flex: 1 }}
                  contentContainerStyle={{ paddingBottom: 8 }}
                  showsVerticalScrollIndicator={false}
                  renderItem={renderEntry}
                />
              )}

              {canEdit && (
                <TouchableOpacity style={s.actionBtn} onPress={openAdd} activeOpacity={0.85}>
                  <Text style={s.actionBtnText}>
                    {awarding ? 'GIVE CRED' : 'NEW TAG'}
                  </Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </View>

      {/* ── Entry editor ── */}
      <Modal
        visible={!!editor}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setEditor(null)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={s.sheetOverlay}
        >
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle} numberOfLines={1}>
                {editor?.entryId ? 'Edit Tag' : awarding ? `Honor ${memberLabel ?? ''}` : 'New Tag'}
              </Text>
              <TouchableOpacity onPress={() => setEditor(null)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {view.fields.map(f => {
                const variant = f.variantsByMode?.[editor?.values.mode ?? ''];
                const label = variant?.label ?? f.label;
                const placeholder = variant?.placeholder ?? f.placeholder;
                return (
                <View key={f.key}>
                  <Text style={s.fieldLabel}>{label.toUpperCase()}</Text>
                  {f.choices ? (
                    <View style={s.choiceRow}>
                      {f.choices.map(c => {
                        const on = editor?.values[f.key] === c;
                        return (
                          <TouchableOpacity
                            key={c}
                            style={[s.choicePill, on && s.choicePillOn]}
                            onPress={() => setValue(f.key, on ? '' : c)}
                            activeOpacity={0.8}
                          >
                            <Text style={[s.choicePillText, on && s.choicePillTextOn]}>
                              {f.choiceLabels?.[c] ?? c}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ) : f.percent ? (
                    <View style={s.percentRow}>
                      <TextInput
                        style={s.percentInput}
                        placeholder="0"
                        placeholderTextColor="rgba(237,224,196,0.35)"
                        value={editor?.values[f.key] ?? ''}
                        onChangeText={t => setValue(f.key, t.replace(/[^0-9]/g, '').slice(0, 3))}
                        keyboardType="number-pad"
                        maxLength={3}
                      />
                      <Text style={s.percentSign}>%</Text>
                    </View>
                  ) : (
                    <TextInput
                      style={[s.input, f.multiline && s.inputMultiline]}
                      placeholder={placeholder}
                      placeholderTextColor="rgba(237,224,196,0.35)"
                      value={editor?.values[f.key] ?? ''}
                      onChangeText={t => setValue(f.key, t)}
                      multiline={f.multiline}
                      textAlignVertical={f.multiline ? 'top' : 'center'}
                      maxLength={f.multiline ? 2000 : 200}
                    />
                  )}
                </View>
                );
              })}

              <TouchableOpacity
                style={[s.saveBtn, (!(editor?.values.title ?? '').trim() || saving) && s.saveBtnDisabled]}
                onPress={saveEntry}
                disabled={!(editor?.values.title ?? '').trim() || saving}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color={GOLD} size="small" />
                  : <Text style={s.saveBtnText}>{editor?.entryId ? 'SAVE' : awarding ? 'STAMP CRED' : 'PAINT IT'}</Text>
                }
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      {openEntry && user && bookUid ? (
        <SocialPostSheet
          visible
          onClose={() => setOpenEntryId(null)}
          title={openEntry.title}
          parentPath={`blackBook/${bookUid}/entries/${openEntry.id}`}
          currentUid={user.uid}
          currentJokerId={jokerId ?? ''}
          reactions={openEntry.reactions}
          commentCount={openEntry.commentCount}
        >
          <Text style={s.entryTitle}>{openEntry.title}</Text>
          {(openEntry.date || openEntry.location) ? (
            <Text style={s.entryMeta}>{[openEntry.date, openEntry.location].filter(Boolean).join('  ·  ')}</Text>
          ) : null}
          {openEntry.mode ? <Text style={s.entryMeta}>{openEntry.mode}</Text> : null}
          {openEntry.price ? <Text style={s.entryMeta}>{openEntry.price}</Text> : null}
          {openEntry.progress !== undefined ? <Text style={s.entryMeta}>{openEntry.progress}% COMPLETE</Text> : null}
          {openEntry.suit ? <Text style={s.entryMeta}>{AWARD_SUIT_LABELS[openEntry.suit] ?? openEntry.suit}</Text> : null}
          {openEntry.notes ? <Text style={s.entryNotes}>{openEntry.notes}</Text> : null}
          <Text style={s.entryDateStamp}>{formatBlackBookTimestamp(openEntry.createdAt)}</Text>
        </SocialPostSheet>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  screenLabel: {
    ...MARBLE_TEXT_SHADOW,
    position: 'absolute', left: 0, right: 0, textAlign: 'center',
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 18, letterSpacing: 3,
    zIndex: 10,
  },

  folderWrap: { position: 'absolute', left: SIDE, right: SIDE, bottom: SIDE },
  tabsRow: { flexDirection: 'row', gap: 4 },
  tab: {
    flex: 1, height: TAB_H,
    backgroundColor: '#080808',
    borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.18)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 4,
  },
  tabActive: { backgroundColor: '#0D0D0D', borderColor: 'rgba(200,165,60,0.4)' },
  tabText: {
    color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 9.5, letterSpacing: 0.8,
  },
  tabTextActive: { color: CREAM },

  body: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },

  subtitle: {
    color: 'rgba(212,168,83,0.75)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 11, letterSpacing: 1.5, textAlign: 'center', marginBottom: 10,
  },

  subToggleRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  subToggle: {
    flex: 1, height: 34, borderRadius: 8,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  subToggleActive: { borderColor: 'rgba(212,168,83,0.6)', backgroundColor: 'rgba(212,168,83,0.1)' },
  subToggleText: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },
  subToggleTextActive: { color: GOLD },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 12, marginBottom: 6,
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
  },
  memberRowText: { flex: 1, color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1 },

  awardHead: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 8 },
  awardHeadText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1 },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText:  { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, opacity: 0.45, textAlign: 'center' },

  entryCard: {
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    padding: 12, marginBottom: 10,
  },
  entryHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  entryTitle: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 0.5, lineHeight: 19 },
  entryActions: { flexDirection: 'row', gap: 14, paddingTop: 2 },
  entryMeta: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_400Regular', fontSize: 11, marginTop: 5 },
  entryNotes: { color: 'rgba(237,224,196,0.85)', fontFamily: 'Cinzel_400Regular', fontSize: 12, lineHeight: 18, marginTop: 6 },
  entryDateStamp: { color: 'rgba(237,224,196,0.25)', fontFamily: 'Cinzel_400Regular', fontSize: 9, marginTop: 8 },
  socialSummary: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  socialSummaryText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 0.8 },

  modePill: {
    alignSelf: 'flex-start', marginTop: 6,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    backgroundColor: 'rgba(212,168,83,0.1)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  modePillText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1 },

  progressWrap: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  progressTrack: {
    flex: 1, height: 8, borderRadius: 4,
    backgroundColor: 'rgba(200,165,60,0.08)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.2)',
    overflow: 'hidden',
  },
  progressFill: { height: '100%', backgroundColor: 'rgba(212,168,83,0.65)' },
  progressPct: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11, minWidth: 36, textAlign: 'right' },

  actionBtn: {
    height: 50, borderRadius: 10, marginTop: 10,
    backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2.5 },

  // ── Editor sheet ──
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: SH * 0.82,
    backgroundColor: '#0D0B08',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.25)',
    padding: 16,
  },
  sheetHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 6, gap: 12,
  },
  sheetTitle: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 1.5 },

  fieldLabel: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11,
    letterSpacing: 1.5, marginBottom: 5, marginTop: 12,
  },
  input: {
    height: 42,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12,
  },
  inputMultiline: { height: undefined, minHeight: 90, maxHeight: 160, paddingVertical: 10 },

  choiceRow: { flexDirection: 'row', gap: 8 },
  choicePill: {
    flex: 1, height: 38, borderRadius: 8,
    borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.3)',
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  choicePillOn: { borderColor: 'rgba(212,168,83,0.7)', backgroundColor: 'rgba(212,168,83,0.12)' },
  choicePillText: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1 },
  choicePillTextOn: { color: GOLD },

  percentRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  percentInput: {
    width: 90, height: 42,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 14,
    paddingHorizontal: 12, textAlign: 'center',
  },
  percentSign: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14 },

  saveBtn: {
    height: 50, borderRadius: 10, marginTop: 20, marginBottom: 6,
    backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2.5 },
});
