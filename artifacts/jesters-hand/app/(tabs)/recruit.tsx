// ── Recruit screen ────────────────────────────────────────────────────────────
// Same black-and-cream marble + black tabbed-folder design as the Vault and
// Chamber. Two tabs: RECRUIT (recruitment posts, invitations, live readings,
// special editions, opportunities) and VERDICT (announcements, decisions,
// rule updates, deadlines, official information).
//
// Admin (00-00): blank editable templates first, completed reference examples
// below them (view-only), then drafts and published posts, plus the visual
// editor. Members: published posts only, opened in the protected in-app
// viewer with a per-member watermark.

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Dimensions, Platform,
  Image, ActivityIndicator, FlatList, Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  RecruitSection, RecruitPost, DesignElement,
  listenRecruitSection, saveRecruitPost, setRecruitStatus, deleteRecruitPost,
  newPostId, parseDesign,
} from '@/lib/recruitService';
import PostCanvas from '@/components/recruit/PostCanvas';
import RecruitViewer from '@/components/recruit/RecruitViewer';
import RecruitEditor from '@/components/recruit/RecruitEditor';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 40;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

const { width: SW } = appWindow();
const CARD_W = Math.floor((SW - SIDE * 2 - SIDE * 2 - 12) / 2); // 2-up grid inside folder body

const SECTION_META: Record<RecruitSection, {
  label: string; adminBtn: string; empty: string; notice: string; watermarkPrefix: string;
}> = {
  recruit: {
    label: 'RECRUIT',
    adminBtn: 'New Recruit',
    empty: 'No recruit posts yet.\nRecruitments, invitations and special editions land here.',
    notice: 'Protected Recruit Material — View Only',
    watermarkPrefix: 'RECRUIT ACCESS',
  },
  verdict: {
    label: 'VERDICT',
    adminBtn: 'New Verdict',
    empty: 'No verdicts yet.\nAnnouncements, decisions and official information land here.',
    notice: 'Protected Verdict Material — View Only',
    watermarkPrefix: 'VERDICT ACCESS',
  },
};

interface ViewingState {
  section: RecruitSection;
  elements: DesignElement[];
  template: 'blank' | 'example';
  title: string;
  isReference?: boolean;
}

interface EditingState {
  postId: string;
  isNew: boolean;
  title: string;
  elements: DesignElement[];
}

export default function RecruitScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;
  const { user, isAdmin, jokerId } = useAuth();

  useEffect(() => { if (user === null) router.replace('/'); }, [user]);

  const [section, setSection] = useState<RecruitSection>('recruit');
  const [posts, setPosts] = useState<RecruitPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewing, setViewing] = useState<ViewingState | null>(null);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const un = listenRecruitSection(section, isAdmin, ps => { setPosts(ps); setLoading(false); },
      () => setLoading(false));
    return un;
  }, [user, isAdmin, section]);

  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 2500);
    return () => clearTimeout(t);
  }, [success]);

  const meta = SECTION_META[section];
  const watermark = `${meta.watermarkPrefix} — ID ${jokerId ?? '??-??'}`;

  const drafts = useMemo(() => posts.filter(p => p.status === 'draft'), [posts]);
  const published = useMemo(() => posts.filter(p => p.status === 'published'), [posts]);

  // ── Admin actions ───────────────────────────────────────────────────────────

  const startNew = () => {
    setEditing({ postId: newPostId(), isNew: true, title: '', elements: [] });
  };

  const editPost = (p: RecruitPost) => {
    setEditing({ postId: p.id, isNew: false, title: p.title, elements: parseDesign(p.design) });
  };

  const savedOnce = React.useRef<Set<string>>(new Set());
  const handleSave = async (title: string, elements: DesignElement[], publish: boolean) => {
    if (!user || !editing) return;
    const isNew = editing.isNew && !savedOnce.current.has(editing.postId);
    await saveRecruitPost(editing.postId, section, user.uid, title, elements, publish ? 'published' : 'draft', isNew);
    savedOnce.current.add(editing.postId);
    if (publish) {
      setEditing(null);
      setSuccess(section === 'recruit' ? 'Recruit published.' : 'Verdict published.');
    } else {
      setEditing(e => e ? { ...e, isNew: false, title, elements } : e);
      setSuccess('Draft saved.');
    }
  };

  const postMenu = (p: RecruitPost) => {
    const actions: { label: string; fn: () => void; destructive?: boolean }[] = [
      { label: 'Edit Design', fn: () => editPost(p) },
      p.status === 'published'
        ? { label: 'Unpublish (hide from members)', fn: () => setRecruitStatus(p.id, 'draft') }
        : { label: 'Publish', fn: () => setRecruitStatus(p.id, 'published') },
      { label: 'Delete', destructive: true, fn: () => {
          const doIt = () => deleteRecruitPost(p);
          if (Platform.OS === 'web') {
            // eslint-disable-next-line no-alert
            if (window.confirm('Delete this post for good? Members will no longer see it.')) doIt();
          } else {
            Alert.alert('Delete post', 'Delete this post for good? Members will no longer see it.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: doIt },
            ]);
          }
        } },
    ];
    if (Platform.OS === 'web') {
      // Simple web fallback: cycle via confirm-less prompt list
      const choice = window.prompt(`${p.title}\n\n1 — Edit Design\n2 — ${p.status === 'published' ? 'Unpublish' : 'Publish'}\n3 — Delete\n\nEnter 1, 2 or 3:`);
      const i = Number(choice) - 1;
      if (i >= 0 && i < actions.length) actions[i].fn();
    } else {
      Alert.alert(p.title, undefined, [
        ...actions.map(a => ({ text: a.label, style: a.destructive ? 'destructive' as const : undefined, onPress: a.fn })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };

  // ── Cards ───────────────────────────────────────────────────────────────────

  const PostCard = ({ p }: { p: RecruitPost }) => (
    <TouchableOpacity
      activeOpacity={0.85}
      style={st.card}
      onPress={() => setViewing({
        section, elements: parseDesign(p.design), template: 'blank', title: p.title,
      })}
      onLongPress={isAdmin ? () => postMenu(p) : undefined}
    >
      <View style={st.cardCanvas} pointerEvents="none">
        <PostCanvas section={section} elements={parseDesign(p.design)} width={CARD_W - 2} />
      </View>
      <Text style={st.cardTitle} numberOfLines={1}>{p.title}</Text>
      {isAdmin ? (
        <View style={st.cardBadgeRow}>
          <Text style={[st.badge, p.status === 'published' ? st.badgePub : st.badgeDraft]}>
            {p.status === 'published' ? 'PUBLISHED' : 'DRAFT'}
          </Text>
          <TouchableOpacity onPress={() => postMenu(p)} hitSlop={8}>
            <Feather name="edit" size={14} color={GOLD} />
          </TouchableOpacity>
        </View>
      ) : null}
    </TouchableOpacity>
  );

  // The reference example lives inside the editor, so the grid only ever
  // shows the blank template card.
  const TemplateCard = () => (
    <TouchableOpacity activeOpacity={0.85} style={st.card} onPress={startNew}>
      <View style={st.cardCanvas} pointerEvents="none">
        <PostCanvas section={section} elements={[]} width={CARD_W - 2} template="blank" />
      </View>
      <Text style={st.cardTitle} numberOfLines={1}>Blank Template — tap to design</Text>
    </TouchableOpacity>
  );

  // Build the grid: admin sees templates first, then drafts, then published.
  type Row = { key: string; node: React.ReactNode };
  const gridItems: { key: string; render: () => React.ReactNode }[] = [];
  if (isAdmin) {
    // The reference example lives inside the editor (below the working
    // template), so the grid shows only the blank template card.
    gridItems.push({ key: 'tpl-blank', render: () => <TemplateCard /> });
    drafts.forEach(p => gridItems.push({ key: p.id, render: () => <PostCard p={p} /> }));
  }
  published.forEach(p => gridItems.push({ key: p.id, render: () => <PostCard p={p} /> }));

  return (
    <View style={st.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />

      {/* ── Nav bar ── */}
      <View style={[st.nav, { height: navBottom }]}>
        <View style={st.navRow}>
          <View style={st.navSide}>
            <TouchableOpacity onPress={() => router.back()} activeOpacity={0.75}>
              <Image source={NAV_DAGGER} style={st.dagIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => router.replace('/(tabs)/home')} activeOpacity={0.75}>
              <Image source={NAV_CARDS} style={st.sqIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          <Text style={st.navTitle} numberOfLines={1}>Recruit</Text>
          <View style={st.navSide}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      <View style={[st.labelRow, { top: navBottom + 8 }]}>
        <Text style={st.screenLabel}>RECRUIT</Text>
      </View>

      {/* ── Folder ── */}
      <View style={[st.folderWrap, { top: navBottom + 42 }]}>
        <View style={st.tabsRow}>
          {(['recruit', 'verdict'] as RecruitSection[]).map(id => {
            const active = id === section;
            return (
              <TouchableOpacity
                key={id}
                style={[st.tab, active && st.tabActive]}
                onPress={() => setSection(id)}
                activeOpacity={0.8}
              >
                <Text style={[st.tabText, active && st.tabTextActive]} numberOfLines={1}>
                  {SECTION_META[id].label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={st.body}>
          {success ? (
            <View style={st.successBanner}><Text style={st.successText}>{success}</Text></View>
          ) : null}

          {loading ? (
            <View style={st.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
          ) : gridItems.length === 0 ? (
            <View style={st.centerFill}>
              <Feather name="file-text" size={30} color="rgba(212,168,83,0.25)" />
              <Text style={st.emptyText}>{meta.empty}</Text>
            </View>
          ) : (
            <FlatList
              data={gridItems}
              keyExtractor={i => i.key}
              numColumns={2}
              columnWrapperStyle={{ gap: 12 }}
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingBottom: 8 }}
              showsVerticalScrollIndicator={false}
              renderItem={({ item }) => <>{item.render()}</>}
            />
          )}

          {isAdmin && (
            <TouchableOpacity style={st.actionBtn} onPress={startNew} activeOpacity={0.85}>
              <Text style={st.actionBtnText}>{meta.adminBtn}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Protected viewer ── */}
      {viewing ? (
        <RecruitViewer
          visible
          onClose={() => setViewing(null)}
          section={viewing.section}
          elements={viewing.elements}
          template={viewing.template}
          title={viewing.title}
          watermark={watermark}
          notice={viewing.isReference ? 'Reference example — cannot be edited or published' : meta.notice}
        />
      ) : null}

      {/* ── Editor (admin only) ── */}
      {isAdmin && editing ? (
        <RecruitEditor
          visible
          section={section}
          postId={editing.postId}
          initialTitle={editing.title}
          initialElements={editing.elements}
          watermark={watermark}
          onCancel={() => setEditing(null)}
          onSave={handleSave}
        />
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navSide:  { flexDirection: 'row', alignItems: 'center', gap: 2 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  labelRow: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  screenLabel: {
    ...MARBLE_TEXT_SHADOW,
    textAlign: 'center', color: GOLD, fontFamily: 'Cinzel_700Bold',
    fontSize: 18, letterSpacing: 3,
  },

  folderWrap: { position: 'absolute', left: SIDE, right: SIDE, bottom: SIDE },
  tabsRow: { flexDirection: 'row', gap: 6 },
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
    fontSize: 11, letterSpacing: 1.2,
  },
  tabTextActive: { color: CREAM },

  body: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },

  successBanner: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    backgroundColor: 'rgba(212,168,83,0.12)',
    paddingVertical: 8, paddingHorizontal: 12, marginBottom: 10,
  },
  successText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1, textAlign: 'center' },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyText:  {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, opacity: 0.45,
    textAlign: 'center', lineHeight: 19, paddingHorizontal: 12,
  },

  card: {
    width: CARD_W, marginBottom: 12,
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    padding: 6,
  },
  cardCanvas: {
    borderRadius: 6, overflow: 'hidden',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
  },
  cardTitle: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 10.5,
    letterSpacing: 0.6, marginTop: 6, textAlign: 'center',
  },
  cardBadgeRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 5, paddingHorizontal: 2,
  },
  badge: { fontFamily: 'Inter_600SemiBold', fontSize: 8.5, letterSpacing: 1 },
  badgePub: { color: '#7FB07F' },
  badgeDraft: { color: 'rgba(237,224,196,0.5)' },

  actionBtn: {
    marginTop: 10, borderRadius: 8,
    borderWidth: 1, borderColor: GOLD,
    backgroundColor: 'rgba(212,168,83,0.1)',
    paddingVertical: 12, alignItems: 'center',
  },
  actionBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },
});
