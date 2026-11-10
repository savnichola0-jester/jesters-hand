// Only 00-00 authors Dossiers. Members read explicit published snapshots;
// working drafts and sealed files remain private to their creator.
// List (active / archived) and editor share this route: ?id=<id> or ?id=new.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Image,
  FlatList, ActivityIndicator, BackHandler,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQueryClient, type Query } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import {
  useListDossiers, getListDossiersQueryKey, useGetDossier, getGetDossierQueryKey,
  useCreateDossier, useUpdateDossier,
} from '@workspace/api-client-react';
import type { Dossier, DossierCategory } from '@workspace/api-client-react';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import { BUTTON_ACCENT, BUTTON_ACCENT_SOFT } from '@/lib/buttonAccent';
import type { TicketDraft } from '@/lib/targetTicketService';
import {
  DOSSIER_CATEGORIES, blankDossierDraft, parseDossierDraft, uploadDossierPhoto, useDossierPhotos,
} from '@/lib/dossierService';
import { TicketDocument } from '@/components/target/TicketDocument';
import { SpreadCanvas } from '@/components/target/SpreadCanvas';
import { DotLegend } from '@/components/target/StatusDot';
import { KeyboardAwareScrollViewCompat } from '@/components/KeyboardAwareScrollViewCompat';
import { showAlert, confirmAction } from '@/lib/confirm';
import { appWindow } from '@/lib/appWindow';
import { auth } from '@/lib/firebase';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { width: SW, height: SH } = appWindow();
const NAV_H = 52;
const SIDE = 16;
const CREAM = '#EDE0C4';
const GOLD = '#D4A853';
const BRONZE = '#A8743A';
const DRIP = '#8E1B1B';
const POLL_MS = 45000;

const isDossierKey = (q: Query) => {
  const k = q.queryKey[0];
  return typeof k === 'string' && k.startsWith('/api/dossiers');
};

function errText(e: unknown, fallback: string): string {
  const status = (e as { status?: number } | null)?.status;
  if (status === 409) return 'This dossier changed elsewhere since you opened it. Reload to get the latest version before saving.';
  if (status === 401 || status === 403) return 'Access refused. Sign in to read published dossiers. Only 00-00 can create or change them.';
  if (status === 404) return 'This dossier no longer exists.';
  if (status === 413) return 'The dossier is too large to save. Remove some elements and try again.';
  if (e instanceof Error && e.message) return `${fallback} (${e.message})`;
  return fallback;
}

function fmtDate(iso: string) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Shell ────────────────────────────────────────────────────────

export default function JestersDossierScreen() {
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;
  const { user, isJester, loading } = useAuth();
  const qc = useQueryClient();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const openId = typeof id === 'string' && id ? id : null;

  const scope = `${user?.uid ?? ''}:${isJester}`;
  // Never reuse the author's draft cache for a member session.
  useEffect(() => () => { qc.removeQueries({ predicate: isDossierKey }); }, [qc, scope]);
  useEffect(() => {
    if (loading) return;
    if (!user) {
      qc.removeQueries({ predicate: isDossierKey });
      router.replace('/');
    }
    if (user && !isJester && openId === 'new') router.setParams({ id: '' });
  }, [user, isJester, loading, qc, openId]);

  const dirtyRef = useRef(false);
  const leave = (to: () => void) => {
    if (openId && dirtyRef.current) {
      confirmAction('Discard changes?', 'Unsaved edits to this dossier will be lost.', 'Discard', () => {
        dirtyRef.current = false; to();
      });
    } else to();
  };
  const back = () => leave(() => {
    if (openId) router.setParams({ id: '' });
    else router.replace('/(tabs)/target-ticket');
  });

  useEffect(() => {
    if (!openId) return;
    const hardware = BackHandler.addEventListener('hardwareBackPress', () => { back(); return true; });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; }
    };
    if (Platform.OS === 'web') window.addEventListener('beforeunload', beforeUnload);
    return () => {
      hardware.remove();
      if (Platform.OS === 'web') window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [openId]);

  if (loading || !user) {
    return <View style={s.root}><ActivityIndicator color={GOLD} style={{ marginTop: 140 }} /></View>;
  }

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />
      <View style={[s.nav, { height: navBottom }]}>
        <View style={s.drip} pointerEvents="none">
          {[0.08, 0.22, 0.41, 0.63, 0.79, 0.93].map((x, i) => (
            <View key={i} style={[s.dripBead, { left: `${x * 100}%`, height: 6 + ((i * 7) % 11) }]} />
          ))}
        </View>
        <View style={s.navRow}>
          <View style={s.navLeft}>
            <TouchableOpacity onPress={back} activeOpacity={0.75} testID="dossier-back"
              accessibilityRole="button" accessibilityLabel={openId ? 'Back to dossier list' : 'Back to Target Tickets'}>
              <Image source={NAV_DAGGER} style={s.navIcon} resizeMode="contain" />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => leave(() => router.replace('/(tabs)/home'))} activeOpacity={0.75}
              testID="dossier-home" accessibilityRole="button" accessibilityLabel="Home">
              <Image source={NAV_CARDS} style={s.navIcon} resizeMode="contain" />
            </TouchableOpacity>
          </View>
          <Text style={s.navTitle} numberOfLines={1} pointerEvents="none">The Jester's Dossier</Text>
        </View>
      </View>

      {openId && (openId !== 'new' || isJester)
        ? <DossierEditor key={`${scope}:${openId}`} id={openId} top={navBottom} bottomInset={insets.bottom} dirtyRef={dirtyRef} />
        : <DossierList key={scope} top={navBottom} bottomInset={insets.bottom} />}
    </View>
  );
}

// ─── List ─────────────────────────────────────────────────────────

function DossierList({ top, bottomInset }: { top: number; bottomInset: number }) {
  const { user, isJester } = useAuth();
  const [archived, setArchived] = useState(false);
  const [cat, setCat] = useState<DossierCategory | 'all'>('all');
  const params = { archived };
  const q = useListDossiers(params, {
    query: {
      queryKey: [...getListDossiersQueryKey(params), `${user?.uid}:${isJester}`],
      refetchOnMount: 'always',
      refetchInterval: POLL_MS,
    },
  });
  const rows = useMemo(() => {
    const all = q.data ?? [];
    const f = cat === 'all' ? all : all.filter(d => d.category === cat);
    return [...f].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [q.data, cat]);

  return (
    <>
      <View style={[s.folderWrap, { top: top + 12, bottom: Math.max(bottomInset, 14) + 72 }]}>
        <View style={s.tabRow}>
          {(isJester ? [false, true] : [false]).map(a => (
            <TouchableOpacity key={String(a)} style={[s.tab, archived === a && s.tabActive]}
              onPress={() => setArchived(a)} testID={a ? 'dossier-tab-archived' : 'dossier-tab-active'}
              accessibilityRole="tab" accessibilityState={{ selected: archived === a }}
              accessibilityLabel={a ? 'Archived dossiers' : 'Active dossiers'}>
              <Text style={[s.tabText, archived !== a && { opacity: 0.5 }]}>{a ? 'SEALED' : isJester ? 'OPEN FILES' : 'PUBLISHED'}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.body}>
          <FlatList
            horizontal data={['all', ...DOSSIER_CATEGORIES] as Array<DossierCategory | 'all'>}
            keyExtractor={c => c} showsHorizontalScrollIndicator={false}
            style={s.chipsList} contentContainerStyle={s.chipsRow}
            renderItem={({ item: c }) => (
              <TouchableOpacity style={[s.chip, cat === c && s.chipActive]} onPress={() => setCat(c)}
                testID={`dossier-filter-${c}`} accessibilityRole="button"
                accessibilityLabel={`Filter ${c === 'all' ? 'all categories' : c}`}>
                <Text style={[s.chipText, cat === c && s.chipTextActive]}>{c === 'all' ? 'ALL' : c.toUpperCase()}</Text>
              </TouchableOpacity>
            )}
          />
          {q.isLoading ? (
            <View style={{ padding: 10, gap: 10 }}>
              {[0, 1, 2, 3].map(i => <View key={i} style={s.skel} />)}
            </View>
          ) : q.isError && !q.data ? (
            <ErrorPane message={errText(q.error, 'Could not open the dossier drawer.')} onRetry={() => q.refetch()} />
          ) : rows.length === 0 ? (
            <View style={s.empty}>
              <Feather name={archived ? 'archive' : 'lock'} size={22} color={BRONZE} />
              <Text style={s.emptyTitle}>{archived ? 'Nothing Sealed' : 'The Drawer Is Empty'}</Text>
              <Text style={s.emptyText}>
                {archived ? 'Sealed dossiers are private until restored and published again.'
                  : isJester ? 'Save a private draft, then publish it for everyone to read.'
                  : 'Dossiers published by 00-00 will appear here.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={rows} keyExtractor={d => d.id} showsVerticalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 6 }}
              ItemSeparatorComponent={() => <View style={s.sep} />}
              renderItem={({ item }) => <DossierRow d={item} />}
            />
          )}
          {q.isError && !!q.data && (
            <TouchableOpacity style={s.staleBar} onPress={() => q.refetch()} testID="dossier-list-retry"
              accessibilityRole="button" accessibilityLabel="Refresh failed, retry">
              <Text style={s.staleText}>Refresh failed. Tap to retry.</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
      {isJester && !archived && (
        <TouchableOpacity style={[s.primaryBtn, s.floatBtn, { bottom: Math.max(bottomInset, 14) + 6 }]}
          onPress={() => router.setParams({ id: 'new' })} activeOpacity={0.85}
          testID="dossier-new" accessibilityRole="button" accessibilityLabel="Open a new dossier">
          <Text style={s.primaryText}>Open a Dossier</Text>
        </TouchableOpacity>
      )}
    </>
  );
}

function DossierRow({ d }: { d: Dossier }) {
  return (
    <TouchableOpacity style={s.row} activeOpacity={0.8} onPress={() => router.setParams({ id: d.id })}
      testID={`dossier-row-${d.id}`} accessibilityRole="button" accessibilityLabel={`Open dossier ${d.title}`}>
      <View style={s.seal}><Text style={s.sealText}>{d.category.split(' ').map(w => w[0]).join('')}</Text></View>
      <View style={{ flex: 1 }}>
        <Text style={s.rowTitle} numberOfLines={1}>{d.title || 'Untitled'}</Text>
        <Text style={s.rowMeta} numberOfLines={1}>{d.category}  ·  {d.published ? 'Published' : 'Draft'}  ·  {fmtDate(d.updatedAt)}</Text>
      </View>
      <Feather name="chevron-right" size={16} color={BRONZE} />
    </TouchableOpacity>
  );
}

function ErrorPane({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <View style={s.empty}>
      <Feather name="alert-triangle" size={22} color="#D08080" />
      <Text style={[s.emptyText, { textAlign: 'center', paddingHorizontal: 18 }]}>{message}</Text>
      <TouchableOpacity style={[s.primaryBtn, { paddingHorizontal: 26, marginTop: 8 }]} onPress={onRetry}
        testID="dossier-retry" accessibilityRole="button" accessibilityLabel="Retry">
        <Text style={s.primaryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Editor ───────────────────────────────────────────────────────

function DossierEditor({ id, top, bottomInset, dirtyRef }: {
  id: string; top: number; bottomInset: number; dirtyRef: React.MutableRefObject<boolean>;
}) {
  const isNew = id === 'new';
  const { user, isJester } = useAuth();
  const scope = `${user?.uid}:${isJester}`;
  const qc = useQueryClient();
  const detail = useGetDossier(id, {
    query: {
      queryKey: [...getGetDossierQueryKey(id), scope], enabled: !isNew, refetchOnMount: 'always',
      refetchInterval: isJester ? false : POLL_MS,
    },
  });
  const create = useCreateDossier();
  const update = useUpdateDossier();

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DossierCategory>(DOSSIER_CATEGORIES[0]);
  const [draft, setDraft] = useState<TicketDraft>(() => blankDossierDraft());
  const [record, setRecord] = useState<Dossier | null>(null);
  const [ready, setReady] = useState(isNew);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scrollLocked, setScrollLocked] = useState(false);
  const baseline = useRef('');
  const initFor = useRef<string | null>(isNew ? id : null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const snapshot = (t: string, c: string, d: TicketDraft) => JSON.stringify({ t, c, d });
  useEffect(() => { if (isNew) baseline.current = snapshot('', DOSSIER_CATEGORIES[0], draft); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialise once per record id; later refetches never overwrite edits.
  useEffect(() => {
    if (isNew || !detail.data || (initFor.current === id && isJester)) return;
    initFor.current = id;
    try {
      const d = parseDossierDraft(detail.data);
      setTitle(detail.data.title);
      setCategory(detail.data.category);
      setDraft(d);
      setRecord(detail.data);
      baseline.current = snapshot(detail.data.title, detail.data.category, d);
      setLoadError(null);
      setReady(true);
    } catch (error) {
      setLoadError(errText(error, 'Could not read this dossier.'));
    }
  }, [detail.data, id, isNew, isJester]);

  const dirty = ready && snapshot(title, category, draft) !== baseline.current;
  useEffect(() => { dirtyRef.current = dirty; }, [dirty, dirtyRef]);
  useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);

  const remoteNewer = !!record && !!detail.data && detail.data.version > record.version;
  const photos = useDossierPhotos(draft.spread, ready);

  const pickPhoto = useCallback(async (): Promise<string | null> => {
    if (!user) return null;
    try {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
      if (res.canceled || !res.assets?.[0]?.uri) return null;
      return await uploadDossierPhoto(user.uid, res.assets[0].uri);
    } catch (e) {
      showAlert('Photo not added', e instanceof Error ? e.message : 'Could not upload the photo privately.');
      return null;
    }
  }, [user]);

  const busy = create.isPending || update.isPending;
  const mayEdit = isJester && (isNew || !!record?.canEdit);

  const afterWrite = (saved: Dossier, text: string) => {
    qc.setQueryData([...getGetDossierQueryKey(saved.id), scope], saved);
    void qc.invalidateQueries({ predicate: isDossierKey });
    initFor.current = saved.id;
    setRecord(saved);
    baseline.current = text;
    dirtyRef.current = false;
    setSaveError(null);
  };

  const persist = (archived: boolean, onDone?: () => void, publish = false) => {
    if (busy || !mayEdit) return;
    const t = title.trim();
    if (!t) { setSaveError('A title is required before this dossier can be saved.'); return; }
    let document: string;
    try { document = JSON.stringify({ ...draft, title: t }); } catch { setSaveError('Could not encode this dossier.'); return; }
    const data = { title: t, category, document, archived, publish, version: record ? record.version : 0 };
    const text = snapshot(title, category, draft);
    setSaveError(null);
    const opts = {
      onSuccess: (saved: Dossier) => {
        if (!mounted.current || auth.currentUser?.uid !== user?.uid) return;
        afterWrite(saved, text);
        if (isNew || !record) router.setParams({ id: saved.id });
        onDone?.();
      },
      onError: (e: unknown) => setSaveError(errText(e, 'The dossier was not saved.')),
    };
    if (record) update.mutate({ id: record.id, data }, opts);
    else create.mutate({ data }, opts);
  };

  const reload = () => {
    const doReload = () => {
      initFor.current = null;
      setSaveError(null);
      setLoadError(null);
      void detail.refetch().then(r => {
        if (r.data) {
          try {
            const d = parseDossierDraft(r.data);
            initFor.current = id;
            setTitle(r.data.title); setCategory(r.data.category); setDraft(d); setRecord(r.data);
            baseline.current = snapshot(r.data.title, r.data.category, d);
            setReady(true);
          } catch (error) {
            setLoadError(errText(error, 'Could not read this dossier.'));
          }
        }
      });
    };
    if (dirty) confirmAction('Reload latest?', 'Your unsaved edits will be replaced by the saved version.', 'Reload', doReload);
    else doReload();
  };

  if (!isJester && detail.isError) {
    return <View style={{ marginTop: top + 40 }}>
      <ErrorPane message={errText(detail.error, 'This dossier is no longer published.')} onRetry={() => detail.refetch()} />
    </View>;
  }
  if (!isNew && !ready) {
    if (loadError) {
      return <View style={{ marginTop: top + 40 }}><ErrorPane message={loadError} onRetry={reload} /></View>;
    }
    if (detail.isError) {
      return <View style={{ marginTop: top + 40 }}>
        <ErrorPane message={errText(detail.error, 'Could not open this dossier.')} onRetry={() => detail.refetch()} />
      </View>;
    }
    return <View style={{ marginTop: top + 20, padding: SIDE, gap: 12 }}>
      <View style={[s.skel, { width: '60%' }]} /><View style={[s.skel, { height: 220 }]} /><View style={[s.skel, { height: 300 }]} />
    </View>;
  }

  const archived = record?.archived ?? false;
  const readOnly = archived || !mayEdit;

  return (
    <KeyboardAwareScrollViewCompat
      style={{ position: 'absolute', top, left: 0, right: 0, bottom: 0 }}
      contentContainerStyle={{ padding: SIDE, paddingBottom: Math.max(bottomInset, 14) + 40 }}
      bottomOffset={70}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      scrollEnabled={!scrollLocked}
    >
      <View style={s.ribbon}>
        <Feather name={record?.published ? 'eye' : 'lock'} size={11} color={BRONZE} />
        <Text style={s.ribbonText}>{archived ? 'SEALED  ·  PRIVATE' : record?.published
          ? 'PUBLISHED  ·  ALL MEMBERS' : 'DRAFT  ·  00-00 ONLY'}</Text>
        {dirty && <Text style={s.unsaved}>UNSAVED</Text>}
      </View>

      <View style={s.editTab}>
        <TextInput
          style={s.tabInput} value={title} onChangeText={setTitle} editable={!readOnly}
          placeholder="NAME THIS DOSSIER" placeholderTextColor="rgba(212,168,83,0.4)"
          selectionColor={GOLD} maxLength={120} testID="dossier-title" accessibilityLabel="Dossier title"
        />
      </View>
      <View style={[s.body, { flex: 0, flexShrink: 0, padding: 14 }]}>
        <Text style={s.sectionLabel}>Category</Text>
        <View style={s.catGrid}>
          {DOSSIER_CATEGORIES.map(c => {
            const on = category === c;
            return (
              <TouchableOpacity key={c} disabled={readOnly} style={[s.catBtn, on && s.catBtnOn]}
                onPress={() => setCategory(c)} testID={`dossier-category-${c}`}
                accessibilityRole="radio" accessibilityState={{ selected: on, disabled: readOnly }}
                accessibilityLabel={`Category ${c}`}>
                <View style={[s.catDot, on && { backgroundColor: BUTTON_ACCENT }]} />
                <Text style={[s.catText, on && { color: CREAM }]}>{c}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TicketDocument draft={draft} onChange={setDraft} editable={!readOnly} hideSuit />

        <Text style={[s.sectionLabel, { marginTop: 22 }]}>The Spread</Text>
        <DotLegend />
        {photos.error && <Text style={s.inlineErr}>Some evidence images could not load: {photos.error}</Text>}
        <SpreadCanvas
          value={draft.spread}
          onChange={sp => setDraft(d => ({ ...d, spread: sp }))}
          editable={!readOnly}
          height={Math.round(SH * 0.55)}
          onPickPhoto={pickPhoto}
          onGestureActive={setScrollLocked}
          resolvePhoto={photos.resolvePhoto}
        />
      </View>

      {remoteNewer && (
        <TouchableOpacity style={s.staleBar} onPress={reload} testID="dossier-reload"
          accessibilityRole="button" accessibilityLabel="A newer saved version exists, reload">
          <Text style={s.staleText}>A newer saved version exists. Tap to reload.</Text>
        </TouchableOpacity>
      )}
      {saveError && (
        <View style={s.errBox} accessibilityRole="alert" testID="dossier-save-error">
          <Text style={s.errText}>{saveError}</Text>
          {!isNew && <TouchableOpacity onPress={reload} accessibilityRole="button" accessibilityLabel="Reload latest version">
            <Text style={s.errLink}>Reload latest</Text>
          </TouchableOpacity>}
        </View>
      )}

      {mayEdit && <View style={s.btnRow}>
        {record && (archived ? (
          <TouchableOpacity style={s.ghostBtn} disabled={busy} testID="dossier-restore"
            accessibilityRole="button" accessibilityLabel="Restore dossier"
            onPress={() => persist(false)}>
            <Text style={s.ghostText}>Restore</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.voidBtn} disabled={busy} testID="dossier-archive"
            accessibilityRole="button" accessibilityLabel="Archive dossier"
            onPress={() => confirmAction('Seal this dossier?',
              'This removes it from member view and saves your edits privately. Restoring returns it to a draft; publish it again when ready.',
              'Seal', () => persist(true, () => router.setParams({ id: '' })), false)}>
            <Text style={s.voidText}>Seal</Text>
          </TouchableOpacity>
        ))}
        {!archived && (
          <TouchableOpacity style={[s.primaryBtn, { flex: 2 }, (busy || !dirty) && { opacity: 0.55 }]}
            disabled={busy || (!dirty && !!record)} onPress={() => persist(false)} testID="dossier-save"
            accessibilityRole="button" accessibilityLabel="Save dossier">
            {busy ? <ActivityIndicator color="#FFD700" size="small" />
              : <Text style={s.primaryText}>{record && !dirty ? 'Draft Saved' : 'Save Draft'}</Text>}
          </TouchableOpacity>
        )}
      </View>}
      {mayEdit && !archived && <>
        <TouchableOpacity style={[s.primaryBtn, { marginTop: 12 }, busy && { opacity: 0.55 }]}
          disabled={busy} testID="dossier-publish" accessibilityRole="button" accessibilityLabel="Publish dossier"
          onPress={() => confirmAction('Publish this dossier?',
            'All active members will be able to read this version and its evidence photos. Only 00-00 can create or edit it.',
            'Publish', () => persist(false, undefined, true), false)}>
          <Text style={s.primaryText}>{record?.published ? 'Publish Changes' : 'Publish'}</Text>
        </TouchableOpacity>
        <Text style={[s.emptyText, { marginTop: 10, textAlign: 'center' }]}>
          Save Draft keeps your edits private. Publish shares this version with every member.
        </Text>
      </>}
    </KeyboardAwareScrollViewCompat>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#050302' },
  nav: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 10, borderBottomWidth: 2, borderBottomColor: DRIP },
  drip: { position: 'absolute', left: 0, right: 0, bottom: -12, height: 12 },
  dripBead: { position: 'absolute', top: 0, width: 4, backgroundColor: DRIP, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 },
  navRow: { position: 'absolute', bottom: 8, left: 12, right: 12, flexDirection: 'row', alignItems: 'center' },
  navLeft: { flexDirection: 'row', alignItems: 'center', gap: 4, zIndex: 2 },
  navIcon: { width: 34, height: 34 },
  navTitle: { position: 'absolute', left: 0, right: 0, textAlign: 'center', color: CREAM, fontSize: 15, fontFamily: 'Cinzel_700Bold', letterSpacing: 1 },

  folderWrap: { position: 'absolute', left: SIDE, right: SIDE },
  tabRow: { flexDirection: 'row', gap: 4 },
  tab: {
    paddingHorizontal: 16, height: 38, justifyContent: 'center', backgroundColor: '#0A0806',
    borderTopLeftRadius: 10, borderTopRightRadius: 10, borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(168,116,58,0.4)',
  },
  tabActive: { backgroundColor: '#0D0D0D', borderColor: 'rgba(212,168,83,0.6)' },
  tabText: { color: BUTTON_ACCENT, fontSize: 11, fontFamily: 'Cinzel_700Bold', letterSpacing: 2.5 },
  body: {
    flex: 1, backgroundColor: '#0A0A0A', borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    borderTopRightRadius: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10, paddingHorizontal: 10,
  },
  chipsList: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.14)' },
  chipsRow: { gap: 8, paddingVertical: 10, paddingHorizontal: 4 },
  chip: { height: 28, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(168,116,58,0.55)', justifyContent: 'center', paddingHorizontal: 12 },
  chipActive: { backgroundColor: BUTTON_ACCENT_SOFT, borderColor: BUTTON_ACCENT },
  chipText: { color: BRONZE, fontSize: 9.5, fontFamily: 'Cinzel_700Bold', letterSpacing: 1.4 },
  chipTextActive: { color: BUTTON_ACCENT },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4 },
  seal: { width: 36, height: 36, borderRadius: 18, borderWidth: 1.5, borderColor: DRIP, backgroundColor: 'rgba(142,27,27,0.18)', alignItems: 'center', justifyContent: 'center' },
  sealText: { color: GOLD, fontSize: 11, fontFamily: 'Cinzel_700Bold', letterSpacing: 1 },
  rowTitle: { color: CREAM, fontSize: 14.5, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 0.5 },
  rowMeta: { color: 'rgba(237,224,196,0.5)', fontSize: 10.5, fontFamily: 'Inter_400Regular', marginTop: 3 },
  sep: { height: 1, backgroundColor: 'rgba(212,168,83,0.14)' },
  skel: { height: 54, borderRadius: 8, backgroundColor: 'rgba(168,116,58,0.1)' },
  empty: { alignItems: 'center', marginTop: 48, gap: 8 },
  emptyTitle: { color: GOLD, fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 2 },
  emptyText: { color: 'rgba(237,224,196,0.55)', fontSize: 12, fontFamily: 'Inter_400Regular' },
  staleBar: { marginVertical: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: BRONZE, backgroundColor: 'rgba(168,116,58,0.12)' },
  staleText: { color: CREAM, fontSize: 12, fontFamily: 'Inter_500Medium', textAlign: 'center' },

  primaryBtn: {
    height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,215,0,0.6)', backgroundColor: '#0D0D0D',
  },
  floatBtn: { position: 'absolute', left: SIDE, right: SIDE },
  primaryText: { color: '#FFD700', fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },

  ribbon: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10, marginTop: 6 },
  ribbonText: { color: BRONZE, fontSize: 9.5, fontFamily: 'Cinzel_700Bold', letterSpacing: 2.5 },
  unsaved: { marginLeft: 'auto', color: BUTTON_ACCENT, fontSize: 9.5, fontFamily: 'Cinzel_700Bold', letterSpacing: 2 },
  editTab: {
    width: Math.min(SW * 0.7, 290), height: 40, backgroundColor: '#0D0D0D',
    borderTopLeftRadius: 10, borderTopRightRadius: 10, borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(212,168,83,0.5)', justifyContent: 'center', paddingHorizontal: 12,
  },
  tabInput: { color: GOLD, fontSize: 12, fontFamily: 'Cinzel_700Bold', letterSpacing: 2, paddingVertical: 0, borderBottomWidth: 1, borderColor: BUTTON_ACCENT },
  sectionLabel: { fontSize: 10.5, color: GOLD, fontFamily: 'Cinzel_700Bold', letterSpacing: 2.5, textTransform: 'uppercase', marginBottom: 6 },
  catGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  catBtn: {
    width: '48.5%', flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 10, paddingHorizontal: 10,
    borderWidth: 1, borderColor: 'rgba(168,116,58,0.35)', borderRadius: 8, backgroundColor: 'rgba(200,165,60,0.04)',
  },
  catBtnOn: { borderColor: BUTTON_ACCENT, backgroundColor: 'rgba(250,105,2,0.08)' },
  catDot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1, borderColor: BRONZE },
  catText: { color: 'rgba(237,224,196,0.6)', fontSize: 11.5, fontFamily: 'Inter_500Medium' },
  inlineErr: { color: '#D08080', fontSize: 11.5, fontFamily: 'Inter_400Regular', marginBottom: 6 },
  errBox: { marginTop: 12, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(150,60,60,0.7)', backgroundColor: 'rgba(80,20,20,0.3)', gap: 6 },
  errText: { color: '#E8B0B0', fontSize: 12.5, fontFamily: 'Inter_400Regular' },
  errLink: { color: BUTTON_ACCENT, fontSize: 12, fontFamily: 'Inter_500Medium' },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 18 },
  voidBtn: { flex: 1, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(150,60,60,0.7)', backgroundColor: 'rgba(80,20,20,0.35)' },
  voidText: { color: '#D08080', fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
  ghostBtn: { flex: 1, height: 50, borderRadius: 10, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: BUTTON_ACCENT, backgroundColor: BUTTON_ACCENT_SOFT },
  ghostText: { color: BUTTON_ACCENT, fontSize: 14, fontFamily: 'Cinzel_700Bold', letterSpacing: 3 },
});
