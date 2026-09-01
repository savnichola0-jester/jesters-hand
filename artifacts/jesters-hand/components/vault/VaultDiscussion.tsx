// ── Vault discussion sheet ────────────────────────────────────────────────────
// Inkitt-style reading feedback UI, shared by the Vault and the Chamber:
//   • reaction bar for the whole entry
//   • comment thread (each comment can be pinned to the PDF page being read)
//   • reviews tab — one star-rated review per member per entry
// Also renders in "book" mode as the overall saga review sheet (no entry).

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput,
  FlatList, KeyboardAvoidingView, Platform, ActivityIndicator, Alert, ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import { VaultEntry } from '@/lib/vaultService';
import {
  VaultComment, VaultReview, VaultMark, VaultTargetType,
  VAULT_MARK_EMOJIS,
  listenVaultComments, createVaultComment, deleteVaultComment,
  toggleVaultCommentReaction, toggleVaultEntryReaction,
  listenVaultMarks, toggleVaultMark,
  listenVaultReviews, saveVaultReview, deleteVaultReview,
  listenBookReviews, saveBookReview, deleteBookReview,
} from '@/lib/vaultDiscussionService';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const REACTION_EMOJIS = [...VAULT_MARK_EMOJIS];

function confirm(title: string, message: string, onYes: () => void): void {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${message}`)) onYes();
    return;
  }
  Alert.alert(title, message, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: onYes },
  ]);
}

// ── Star picker / display ─────────────────────────────────────────────────────

function Stars({ value, size = 16, onPick }: { value: number; size?: number; onPick?: (n: number) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: onPick ? 8 : 2 }}>
      {[1, 2, 3, 4, 5].map(n => (
        <TouchableOpacity key={n} disabled={!onPick} onPress={() => onPick?.(n)} hitSlop={onPick ? 6 : undefined} activeOpacity={0.7}>
          <Text style={{ fontSize: size, color: n <= value ? GOLD : 'rgba(237,224,196,0.25)' }}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ── Reaction chips row (shared by entry + comments) ───────────────────────────

function ReactionChips({
  reactions, uid, onToggle, compact,
}: {
  reactions: Record<string, string[]>;
  uid: string;
  onToggle: (emoji: string) => void;
  compact?: boolean;
}) {
  const active = Object.entries(reactions ?? {}).filter(([, uids]) => (uids ?? []).length > 0);
  if (active.length === 0) return null;
  return (
    <View style={r.row}>
      {active.map(([emoji, uids]) => {
        const mine = uids.includes(uid);
        return (
          <TouchableOpacity
            key={emoji}
            style={[r.chip, compact && r.chipCompact, mine && r.chipMine]}
            onPress={() => onToggle(emoji)}
            activeOpacity={0.7}
          >
            <Text style={r.chipText}>{emoji} {uids.length}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const r = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
  chip: {
    flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 12,
    backgroundColor: 'rgba(212,168,83,0.08)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)',
  },
  chipCompact: { paddingHorizontal: 6, paddingVertical: 2 },
  chipMine: { borderColor: 'rgba(212,168,83,0.7)', backgroundColor: 'rgba(212,168,83,0.18)' },
  chipText: { color: CREAM, fontSize: 11 },
});

function EmojiPickerRow({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} keyboardShouldPersistTaps="handled">
      <View style={{ flexDirection: 'row', gap: 10, paddingVertical: 6, paddingHorizontal: 2 }}>
        {REACTION_EMOJIS.map(e => (
          <TouchableOpacity key={e} onPress={() => onPick(e)} hitSlop={4} activeOpacity={0.7}>
            <Text style={{ fontSize: 22 }}>{e}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

// ── Main sheet ────────────────────────────────────────────────────────────────

export interface VaultDiscussionProps {
  visible: boolean;
  /** Entry being discussed — null means "book" mode (overall saga review). */
  entry: VaultEntry | null;
  /** Current PDF page in the reader (1-based), if a document is open. */
  currentPage?: number | null;
  /** Tab to open on (e.g. 'reviews' when the reader reached the end). */
  initialTab?: 'comments' | 'reviews';
  /** Paragraph text tapped in the reader — pre-fills a pinned, quoted comment. */
  initialQuote?: string | null;
  /** Exact chapter/paragraph target selected inside the manuscript reader. */
  initialTarget?: VaultDiscussionTarget | null;
  /** Book mode: whose bell to ring on a first review (the Jester's uid). */
  bookNotifyUid?: string;
  onClose: () => void;
}

export interface VaultDiscussionTarget {
  targetType: VaultTargetType;
  targetId: string;
  page: number;
  chapterStartPage: number;
  label: string;
  quote?: string | null;
}

export default function VaultDiscussion({
  visible, entry, currentPage, initialTab, initialQuote, initialTarget, bookNotifyUid, onClose,
}: VaultDiscussionProps) {
  const insets = useSafeAreaInsets();
  const { user, isAdmin, jokerId } = useAuth();
  const uid = user?.uid ?? '';
  const bookMode = !entry;

  const [tab, setTab] = useState<'comments' | 'reviews'>(bookMode ? 'reviews' : initialTab ?? 'comments');
  useEffect(() => { setTab(bookMode ? 'reviews' : initialTab ?? 'comments'); }, [bookMode, entry?.id, visible, initialTab]);
  // Exact chapter/paragraph targets are always pinned. Openings WITHOUT a
  // target or quote reset the pin/quote so stale passage context never leaks
  // into an ordinary whole-entry comment.
  useEffect(() => {
    if (!visible) return;
    if (initialTarget) {
      setPinPage(true);
      setQuoteDraft(initialTarget.quote?.trim() ?? '');
    } else if (initialQuote) {
      setPinPage(true);
      setQuoteDraft(initialQuote);
    } else {
      setPinPage(false);
      setQuoteDraft('');
    }
  }, [visible, initialQuote, initialTarget]);

  // Manuscript chapters — used to label page pins with their chapter.
  const chapters = entry?.chapters?.length ? entry.chapters : null;
  const chapterLabelFor = useCallback((page: number): string | null => {
    if (!chapters) return null;
    // Do not assume the stored list is sorted — pick the chapter with the
    // greatest startPage that is still <= the pinned page.
    let best: { title: string; startPage: number } | null = null;
    for (const c of chapters) {
      if (c.startPage <= page && (!best || c.startPage > best.startPage)) best = c;
    }
    return best?.title ?? null;
  }, [chapters]);

  // Chapter the reader currently has open, with its page bounds — used by the
  // "this chapter only" filter. End is exclusive (next chapter's startPage).
  const currentChapter = useMemo(() => {
    if (!chapters || !currentPage) return null;
    let best: { title: string; startPage: number } | null = null;
    let nextStart = Infinity;
    for (const c of chapters) {
      if (c.startPage <= currentPage && (!best || c.startPage > best.startPage)) best = c;
    }
    if (!best) return null;
    for (const c of chapters) {
      if (c.startPage > best.startPage && c.startPage < nextStart) nextStart = c.startPage;
    }
    return { title: best.title, startPage: best.startPage, endPageExclusive: nextStart };
  }, [chapters, currentPage]);

  const [chapterOnly, setChapterOnly] = useState(false);
  useEffect(() => { setChapterOnly(false); }, [entry?.id, visible]);

  // Live entry reactions come from the parent's entry doc listener via props;
  // the sheet listens to comments/reviews itself.
  const [comments, setComments] = useState<VaultComment[]>([]);
  const [reviews, setReviews] = useState<VaultReview[]>([]);
  const [marks, setMarks] = useState<VaultMark[]>([]);

  useEffect(() => {
    if (!visible) return;
    if (entry) {
      const offC = listenVaultComments(entry.id, setComments, () => {});
      const offR = listenVaultReviews(entry.id, setReviews, () => {});
      return () => { offC(); offR(); };
    }
    return listenBookReviews(setReviews, () => {});
  }, [visible, entry?.id]);

  useEffect(() => {
    setMarks([]);
    if (!visible || !entry || !initialTarget) return;
    return listenVaultMarks(entry.id, initialTarget.targetId, setMarks, () => {});
  }, [visible, entry?.id, initialTarget?.targetId]);

  // ── Composer state ──
  const [draft, setDraft] = useState('');
  const [pinPage, setPinPage] = useState(false);
  const [quoteDraft, setQuoteDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null); // 'entry' | commentId

  // ── Review form state ──
  const myReview = useMemo(() => reviews.find(v => v.uid === uid) ?? null, [reviews, uid]);
  const [rating, setRating] = useState(0);
  const [reviewDraft, setReviewDraft] = useState('');
  const [editingReview, setEditingReview] = useState(false);
  useEffect(() => {
    setRating(myReview?.rating ?? 0);
    setReviewDraft(myReview?.text ?? '');
    setEditingReview(false);
  }, [myReview?.rating, myReview?.text, visible, entry?.id]);

  const sendComment = useCallback(async () => {
    if (!entry || !uid || !jokerId || sending) return;
    const text = draft.trim();
    if (!text) return;
    setSending(true);
    try {
      await createVaultComment(
        { id: entry.id, title: entry.title, section: entry.section, createdBy: entry.createdBy },
        { uid, jokerId },
        text,
        initialTarget?.page ?? (pinPage && currentPage ? currentPage : null),
        initialTarget ? (initialTarget.quote ?? quoteDraft) : (pinPage && currentPage ? quoteDraft : null),
        initialTarget
          ? {
              targetType: initialTarget.targetType,
              targetId: initialTarget.targetId,
              chapterStartPage: initialTarget.chapterStartPage,
            }
          : null,
      );
      setDraft('');
      setQuoteDraft('');
    } catch {
      Alert.alert('Failed', 'Your comment could not be posted. Try again.');
    } finally {
      setSending(false);
    }
  }, [entry, uid, jokerId, sending, draft, pinPage, currentPage, quoteDraft, initialTarget]);

  const submitReview = useCallback(async () => {
    if (!uid || !jokerId || rating < 1 || sending) return;
    setSending(true);
    try {
      if (entry) {
        await saveVaultReview(
          { id: entry.id, title: entry.title, section: entry.section, createdBy: entry.createdBy },
          { uid, jokerId }, rating, reviewDraft,
        );
      } else {
        await saveBookReview({ uid, jokerId }, rating, reviewDraft, bookNotifyUid);
      }
      setEditingReview(false);
    } catch {
      Alert.alert('Failed', 'Your review could not be saved. Try again.');
    } finally {
      setSending(false);
    }
  }, [uid, jokerId, rating, reviewDraft, sending, entry, bookNotifyUid]);

  const removeReview = useCallback((rev: VaultReview) => {
    confirm('Remove this review?', 'It will be filed in the Archives.', async () => {
      try {
        if (entry) await deleteVaultReview(entry.id, rev.uid);
        else await deleteBookReview(rev.uid);
      } catch {
        Alert.alert('Failed', 'Could not remove the review.');
      }
    });
  }, [entry]);

  const removeComment = useCallback((c: VaultComment) => {
    if (!entry) return;
    confirm('Remove this comment?', 'It will be filed in the Archives.', async () => {
      try {
        await deleteVaultComment({ id: entry.id, title: entry.title }, c.id);
      } catch {
        Alert.alert('Failed', 'Could not remove the comment.');
      }
    });
  }, [entry]);

  const avg = useMemo(() => {
    const rated = reviews.filter(v => v.rating > 0);
    if (!rated.length) return null;
    return rated.reduce((sum, v) => sum + v.rating, 0) / rated.length;
  }, [reviews]);

  const targetReactions = useMemo(() => {
    const grouped: Record<string, string[]> = {};
    for (const mark of marks) {
      for (const emoji of mark.emojis) {
        if (!grouped[emoji]) grouped[emoji] = [];
        if (!grouped[emoji].includes(mark.uid)) grouped[emoji].push(mark.uid);
      }
    }
    return grouped;
  }, [marks]);

  const toggleTargetMark = useCallback((emoji: string) => {
    if (!entry || !uid || !jokerId || !initialTarget) return;
    toggleVaultMark(
      entry.id,
      { uid, jokerId },
      {
        targetId: initialTarget.targetId,
        targetType: initialTarget.targetType,
        page: initialTarget.page,
        chapterStartPage: initialTarget.chapterStartPage,
        quote: initialTarget.quote,
      },
      emoji,
    ).catch(() => Alert.alert('Failed', 'Your mark could not be saved. Try again.'));
  }, [entry, uid, jokerId, initialTarget]);

  // Comments shown in the list — optionally narrowed to the chapter being read.
  // Only page-pinned comments can belong to a chapter; unpinned ones are hidden
  // when the filter is on, since they aren't tied to any chapter.
  const visibleComments = useMemo(() => {
    if (initialTarget) return comments.filter(c => c.targetId === initialTarget.targetId);
    if (!chapterOnly || !currentChapter) return comments;
    return comments.filter(c =>
      typeof c.page === 'number' &&
      c.page >= currentChapter.startPage &&
      c.page < currentChapter.endPageExclusive,
    );
  }, [comments, chapterOnly, currentChapter, initialTarget]);

  const renderComment = ({ item }: { item: VaultComment }) => (
    <View style={s.comment}>
      <View style={s.commentHead}>
        <Text style={s.commentAuthor}>JOKER {item.jokerId || '——'}</Text>
        {typeof item.page === 'number' ? (
          <View style={s.pagePill}>
            <Text style={s.pagePillText} numberOfLines={1}>
              {(() => {
                const ch = chapterLabelFor(item.page);
                return ch ? `${ch.toUpperCase().slice(0, 24)} · PG ${item.page}` : `PG ${item.page}`;
              })()}
            </Text>
          </View>
        ) : null}
        {(item.senderUid === uid || isAdmin) && (
          <TouchableOpacity onPress={() => removeComment(item)} hitSlop={8} activeOpacity={0.7}>
            <Feather name="trash-2" size={13} color="rgba(237,224,196,0.4)" />
          </TouchableOpacity>
        )}
      </View>
      {item.quote ? (
        <View style={s.quoteBlock}>
          <Text style={s.quoteText} numberOfLines={4}>“{item.quote}”</Text>
        </View>
      ) : null}
      <Text style={s.commentText}>{item.text}</Text>
      <ReactionChips
        reactions={item.reactions}
        uid={uid}
        compact
        onToggle={e => entry && toggleVaultCommentReaction(entry.id, item.id, uid, e).catch(() => {})}
      />
      <TouchableOpacity onPress={() => setPickerFor(p => p === item.id ? null : item.id)} hitSlop={6} activeOpacity={0.7}>
        <Text style={s.addReaction}>+ react</Text>
      </TouchableOpacity>
      {pickerFor === item.id && (
        <EmojiPickerRow onPick={e => {
          setPickerFor(null);
          if (entry) toggleVaultCommentReaction(entry.id, item.id, uid, e).catch(() => {});
        }} />
      )}
    </View>
  );

  const renderReview = ({ item }: { item: VaultReview }) => (
    <View style={s.comment}>
      <View style={s.commentHead}>
        <Text style={s.commentAuthor}>JOKER {item.jokerId || '——'}</Text>
        <Stars value={item.rating} size={13} />
        {(item.uid === uid || isAdmin) && (
          <TouchableOpacity onPress={() => removeReview(item)} hitSlop={8} activeOpacity={0.7}>
            <Feather name="trash-2" size={13} color="rgba(237,224,196,0.4)" />
          </TouchableOpacity>
        )}
      </View>
      {item.text ? <Text style={s.commentText}>{item.text}</Text> : null}
    </View>
  );

  const showReviewForm = !myReview || editingReview;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.overlay}>
        <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          <View style={s.header}>
            <Text style={s.title} numberOfLines={1}>
              {bookMode ? 'The Saga — Reviews' : entry?.title}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} activeOpacity={0.7}>
              <Feather name="x" size={22} color={CREAM} />
            </TouchableOpacity>
          </View>

          {/* Exact chapter/paragraph mark area, distinct from whole-entry reactions. */}
          {entry && initialTarget ? (
            <View style={s.targetCard}>
              <View style={s.targetHead}>
                <Feather
                  name={initialTarget.targetType === 'chapter' ? 'book-open' : 'message-circle'}
                  size={15}
                  color={GOLD}
                />
                <View style={{ flex: 1 }}>
                  <Text style={s.targetKind}>
                    {initialTarget.targetType === 'chapter' ? 'CHAPTER MARK' : 'PARAGRAPH MARK'}
                  </Text>
                  <Text style={s.targetLabel} numberOfLines={2}>{initialTarget.label}</Text>
                </View>
              </View>
              {initialTarget.quote ? (
                <View style={s.targetQuote}>
                  <Text style={s.quoteText} numberOfLines={3}>“{initialTarget.quote}”</Text>
                </View>
              ) : null}
              <ReactionChips reactions={targetReactions} uid={uid} onToggle={toggleTargetMark} />
              <TouchableOpacity
                onPress={() => setPickerFor(p => p === 'target' ? null : 'target')}
                hitSlop={6}
                activeOpacity={0.7}
              >
                <Text style={s.addReaction}>
                  + mark this {initialTarget.targetType} with an emoji
                </Text>
              </TouchableOpacity>
              {pickerFor === 'target' ? (
                <EmojiPickerRow onPick={e => {
                  setPickerFor(null);
                  toggleTargetMark(e);
                }} />
              ) : null}
            </View>
          ) : entry ? (
            <View style={s.entryReactions}>
              <ReactionChips
                reactions={entry.reactions ?? {}}
                uid={uid}
                onToggle={e => toggleVaultEntryReaction(entry.id, uid, e).catch(() => {})}
              />
              <TouchableOpacity onPress={() => setPickerFor(p => p === 'entry' ? null : 'entry')} hitSlop={6} activeOpacity={0.7}>
                <Text style={s.addReaction}>+ react to this {entry.section === 'stack' ? 'chapter' : 'entry'}</Text>
              </TouchableOpacity>
              {pickerFor === 'entry' && (
                <EmojiPickerRow onPick={e => {
                  setPickerFor(null);
                  toggleVaultEntryReaction(entry.id, uid, e).catch(() => {});
                }} />
              )}
            </View>
          ) : null}

          {/* Tabs */}
          {!bookMode && (
            <View style={s.tabs}>
              {(['comments', 'reviews'] as const).map(t => (
                <TouchableOpacity key={t} style={[s.tab, tab === t && s.tabOn]} onPress={() => setTab(t)} activeOpacity={0.8}>
                  <Text style={[s.tabText, tab === t && s.tabTextOn]}>
                    {t === 'comments' ? `COMMENTS (${visibleComments.length})` : `REVIEWS (${reviews.length})`}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {tab === 'comments' && !bookMode ? (
            <>
              {currentChapter && !initialTarget ? (
                <View style={s.filterRow}>
                  <TouchableOpacity
                    style={[s.filterChip, !chapterOnly && s.filterChipOn]}
                    onPress={() => setChapterOnly(false)}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.filterChipText, !chapterOnly && s.filterChipTextOn]}>ALL</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.filterChip, chapterOnly && s.filterChipOn]}
                    onPress={() => setChapterOnly(true)}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.filterChipText, chapterOnly && s.filterChipTextOn]} numberOfLines={1}>
                      {currentChapter.title.toUpperCase().slice(0, 28)}
                    </Text>
                  </TouchableOpacity>
                </View>
              ) : null}
              <FlatList
                data={visibleComments}
                keyExtractor={c => c.id}
                style={s.list}
                showsVerticalScrollIndicator={false}
                renderItem={renderComment}
                ListEmptyComponent={
                  <Text style={s.empty}>
                    {initialTarget
                      ? `No comments on this ${initialTarget.targetType} yet. Be the first Joker to speak.`
                      : chapterOnly && currentChapter
                      ? 'No comments pinned to this chapter yet.'
                      : 'No comments yet. Be the first Joker to speak.'}
                  </Text>
                }
              />
              {currentPage && !initialTarget ? (
                <>
                  <TouchableOpacity style={s.pinRow} onPress={() => setPinPage(p => !p)} activeOpacity={0.7}>
                    <Feather name={pinPage ? 'check-square' : 'square'} size={15} color={GOLD} />
                    <Text style={s.pinText}>
                      {(() => {
                        const ch = chapterLabelFor(currentPage);
                        return ch ? `Pin to ${ch} · page ${currentPage}` : `Pin to page ${currentPage}`;
                      })()}
                    </Text>
                  </TouchableOpacity>
                  {pinPage ? (
                    <TextInput
                      style={[s.input, s.quoteInput]}
                      placeholder="Quote the passage this is about (optional)…"
                      placeholderTextColor="rgba(237,224,196,0.35)"
                      value={quoteDraft}
                      onChangeText={setQuoteDraft}
                      multiline
                      maxLength={300}
                    />
                  ) : null}
                </>
              ) : null}
              <View style={s.composer}>
                <TextInput
                  style={s.input}
                  placeholder="Speak your piece…"
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={draft}
                  onChangeText={setDraft}
                  multiline
                  maxLength={2000}
                />
                <TouchableOpacity
                  style={[s.sendBtn, (!draft.trim() || sending) && { opacity: 0.4 }]}
                  onPress={sendComment}
                  disabled={!draft.trim() || sending}
                  activeOpacity={0.8}
                >
                  {sending ? <ActivityIndicator size="small" color={GOLD} /> : <Feather name="send" size={17} color={GOLD} />}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              {avg != null && (
                <View style={s.avgRow}>
                  <Stars value={Math.round(avg)} size={15} />
                  <Text style={s.avgText}>{avg.toFixed(1)} · {reviews.length} review{reviews.length === 1 ? '' : 's'}</Text>
                </View>
              )}
              <FlatList
                data={reviews}
                keyExtractor={v => v.id}
                style={s.list}
                showsVerticalScrollIndicator={false}
                renderItem={renderReview}
                ListEmptyComponent={
                  <Text style={s.empty}>
                    {bookMode
                      ? 'No reviews of the saga yet. Deal the first verdict.'
                      : 'No reviews yet on this one.'}
                  </Text>
                }
              />
              {showReviewForm ? (
                <View style={s.reviewForm}>
                  <Text style={s.reviewLabel}>
                    {bookMode ? 'YOUR VERDICT ON THE SAGA' : 'YOUR VERDICT'}
                  </Text>
                  <Stars value={rating} size={26} onPick={setRating} />
                  <TextInput
                    style={[s.input, s.reviewInput]}
                    placeholder="What worked? What didn't? Lay it on the table…"
                    placeholderTextColor="rgba(237,224,196,0.35)"
                    value={reviewDraft}
                    onChangeText={setReviewDraft}
                    multiline
                    maxLength={5000}
                  />
                  <TouchableOpacity
                    style={[s.submitBtn, (rating < 1 || sending) && { opacity: 0.4 }]}
                    onPress={submitReview}
                    disabled={rating < 1 || sending}
                    activeOpacity={0.85}
                  >
                    {sending
                      ? <ActivityIndicator size="small" color={GOLD} />
                      : <Text style={s.submitText}>{myReview ? 'UPDATE REVIEW' : 'FILE REVIEW'}</Text>}
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={s.editMineBtn} onPress={() => setEditingReview(true)} activeOpacity={0.8}>
                  <Feather name="edit-2" size={13} color={GOLD} />
                  <Text style={s.editMineText}>Edit your review</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '84%', minHeight: 380,
    backgroundColor: '#0D0B08',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.25)',
    padding: 16,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 4 },
  title: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1 },

  entryReactions: { marginBottom: 6 },
  targetCard: {
    marginTop: 5, marginBottom: 7, padding: 11, borderRadius: 10,
    backgroundColor: 'rgba(212,168,83,0.08)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.38)',
  },
  targetHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  targetKind: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 9.5, letterSpacing: 1.5,
  },
  targetLabel: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, lineHeight: 16, marginTop: 2,
  },
  targetQuote: {
    marginTop: 8, paddingLeft: 9, borderLeftWidth: 2, borderLeftColor: 'rgba(212,168,83,0.5)',
  },
  addReaction: { color: 'rgba(212,168,83,0.7)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10.5, letterSpacing: 1, marginTop: 6 },

  tabs: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 8 },
  tab: {
    flex: 1, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)', backgroundColor: 'rgba(0,0,0,0.4)',
  },
  tabOn: { borderColor: 'rgba(212,168,83,0.7)', backgroundColor: 'rgba(212,168,83,0.1)' },
  tabText: { color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },
  tabTextOn: { color: GOLD },

  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  filterChip: {
    paddingHorizontal: 12, height: 28, borderRadius: 14,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)', backgroundColor: 'rgba(0,0,0,0.4)',
    maxWidth: '75%',
  },
  filterChipOn: { borderColor: 'rgba(212,168,83,0.7)', backgroundColor: 'rgba(212,168,83,0.12)' },
  filterChipText: { color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_600SemiBold', fontSize: 9.5, letterSpacing: 1 },
  filterChipTextOn: { color: GOLD },

  list: { flexGrow: 1, minHeight: 120 },
  empty: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5,
    textAlign: 'center', paddingVertical: 28, lineHeight: 18,
  },

  comment: {
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(200,165,60,0.1)',
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  commentAuthor: { flex: 1, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 10.5, letterSpacing: 1 },
  commentText: { color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12.5, lineHeight: 19, marginTop: 4 },
  pagePill: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 9,
    backgroundColor: 'rgba(212,168,83,0.12)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  pagePillText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 8.5, letterSpacing: 1 },

  quoteBlock: {
    marginTop: 6, paddingLeft: 10, borderLeftWidth: 2, borderLeftColor: 'rgba(212,168,83,0.5)',
  },
  quoteText: {
    color: 'rgba(237,224,196,0.65)', fontFamily: 'Cinzel_400Regular',
    fontSize: 11.5, lineHeight: 17, fontStyle: 'italic',
  },
  quoteInput: { minHeight: 38, maxHeight: 80, marginBottom: 6 },

  pinRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 },
  pinText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 0.5 },

  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 6 },
  input: {
    flex: 1, minHeight: 42, maxHeight: 110,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12.5,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  sendBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(212,168,83,0.12)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.45)',
  },

  avgRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  avgText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11 },

  reviewForm: { marginTop: 8, gap: 10 },
  reviewLabel: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.5 },
  reviewInput: { minHeight: 76 },
  submitBtn: {
    height: 46, borderRadius: 10,
    backgroundColor: 'rgba(212,168,83,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(212,168,83,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  submitText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },

  editMineBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 42, borderRadius: 10, marginTop: 8,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', backgroundColor: 'rgba(212,168,83,0.06)',
  },
  editMineText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, letterSpacing: 1 },
});
