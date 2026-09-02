// ── Shared protected-folder screen ────────────────────────────────────────────
// One config-driven screen powering the Vault (The Stack / The Wall) and the
// Chamber (The Margins / The Cut). All layout, permissions, private storage,
// protected viewing, watermarking, admin controls, and activity logging live
// here once — each screen only supplies labels and section definitions.

import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  Dimensions, Platform, Image, ActivityIndicator, Modal,
  FlatList, KeyboardAvoidingView, Alert, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { useAuth } from '@/contexts/AuthContext';
import {
  VaultSection, VaultStatus, VaultEntry, VaultFilePick, VaultActivityRecord,
  listenVaultSection, listenVaultActivity, addVaultEntry, updateVaultEntry,
  replaceVaultFile, deleteVaultEntry, fetchProtectedDataUri, logVaultActivity,
} from '@/lib/vaultService';
import VaultViewer from '@/components/vault/VaultViewer';
import VaultDiscussion from '@/components/vault/VaultDiscussion';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import { confirmAction, showAlert } from '@/lib/confirm';
import { decoderHashOf } from '@/lib/sha256';
import { db } from '@/lib/firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import BellNavIcon from '@/components/BellNavIcon';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';
import ManuscriptScanner, {
  type ManuscriptScannerHandle,
} from '@/components/vault/ManuscriptScanner';
import { isManuscriptScanTooLargeError } from '@/lib/manuscriptScanLimits';
import { reportHiddenJestFound } from '@/lib/hiddenJestService';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const { height: SH } = appWindow();
const NAV_H  = 52;
const SIDE   = 16;
const TAB_H  = 40;
const CREAM  = '#EDE0C4';
const GOLD   = '#D4A853';

export interface FolderSectionDef {
  id: VaultSection;
  /** Tab label, e.g. 'THE STACK'. */
  label: string;
  /** Human name used in activity rows, e.g. 'The Stack'. */
  displayName: string;
  empty: string;
  emptyIcon: string;
  adminBtn: string;
  viewBtn: string;
  /** Bottom-sheet title when adding, e.g. 'Load the Stack'. */
  sheetTitle: string;
  success: string;
  titleLabel: string;
  titlePlaceholder: string;
  descLabel: string;
  uploadLabel: string;
  uploadPlaceholder: string;
  missingFileMsg: string;
  /** 'document' opens the file picker; 'image' opens the photo library. */
  fileKind: 'document' | 'image';
  /** Whether entries support an optional cover image. */
  hasCover: boolean;
  /**
   * Whether entries support the decoder game: the admin sets a secret answer
   * (the Hidden Jest from the Jester's Ticket) and members must enter it to
   * unlock the entry.
   */
  hasDecoder?: boolean;
}

export interface FolderConfig {
  /** Screen name, e.g. 'Vault' or 'Chamber' — drives titles & messages. */
  name: string;
  /** Watermark prefix, e.g. 'VAULT ACCESS'. */
  watermarkPrefix: string;
  /** Viewer header notice, e.g. 'Protected Vault Material — View Only'. */
  notice: string;
  sections: FolderSectionDef[];
  /** Section that shows the overall book/saga review button (e.g. 'stack'). */
  bookReviewSection?: VaultSection;
}

interface FormState {
  entryId: string | null;          // null = new entry
  title: string;
  description: string;
  status: VaultStatus;
  order: string;
  file: VaultFilePick | null;
  cover: VaultFilePick | null;
  /** Manuscript chapter map (documents only) — rows are editable in the form. */
  chapters: { title: string; startPage: string }[];
  /** True while the picked PDF is being scanned for chapter headings. */
  scanning: boolean;
  /** Human-readable result of the most recent automatic PDF scan. */
  scanSummary: string | null;
  /** Decoder answer typed by the admin (blank = keep existing / none). */
  decoder: string;
  /** True when editing an entry that already has a decoder lock. */
  hadDecoder: boolean;
  /** Explicitly remove the existing decoder lock on save. */
  removeDecoder: boolean;
}

const STATUS_LABELS: Record<VaultStatus, string> = {
  published: 'Published',
  hidden: 'Hidden',
  archived: 'Archived',
};

// Thumbnail that pulls its image through authenticated storage (no public URL).
function ProtectedThumb({ path, style }: { path?: string; style: any }) {
  const [uri, setUri] = useState<string | null>(null);
  useEffect(() => {
    setUri(null);
    if (!path) return;
    let alive = true;
    fetchProtectedDataUri(path, 'image/jpeg')
      .then(u => { if (alive) setUri(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [path]);
  if (!path) {
    return (
      <View style={[style, s.thumbFallback]}>
        <Feather name="file-text" size={22} color="rgba(212,168,83,0.45)" />
      </View>
    );
  }
  if (!uri) {
    return (
      <View style={[style, s.thumbFallback]}>
        <ActivityIndicator size="small" color="rgba(212,168,83,0.5)" />
      </View>
    );
  }
  return <Image source={{ uri }} style={style} resizeMode="cover" {...(Platform.OS === 'web' ? { draggable: false } : {})} />;
}

export default function VaultFolderScreen({ config }: { config: FolderConfig }) {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;

  const { user, isAdmin: adminFlag, isVaultKeeper, jokerId } = useAuth();
  // Vault/Chamber administration belongs only to the exact 00-00 admin seat.
  // Treat every other account as a reader even if an admin flag is present.
  const isAdmin = adminFlag && jokerId === '00-00';
  const manuscriptScannerRef = useRef<ManuscriptScannerHandle>(null);
  // Curation (upload / replace / hide / delete) needs the keeper tier —
  // the second Hand is an admin who can VIEW everything here but not curate.
  const canCurate = isAdmin && isVaultKeeper;

  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  const sectionById = useCallback(
    (id: VaultSection) => config.sections.find(t => t.id === id) ?? config.sections[0],
    [config],
  );

  const [sectionId, setSectionId] = useState<VaultSection>(config.sections[0].id);
  const section = sectionById(sectionId);

  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const off = listenVaultSection(sectionId, isAdmin, es => {
      setEntries(es);
      setLoading(false);
    }, () => setLoading(false));
    return off;
  }, [user, isAdmin, sectionId]);

  const switchSection = useCallback((id: VaultSection) => {
    Haptics.selectionAsync().catch(() => {});
    setSectionId(id);
  }, []);

  const watermarkLabel = `${config.watermarkPrefix} — ID ${jokerId ?? '——'}`;

  // ── Decoder game (Chamber): which entries this member has unlocked ──
  const [decoded, setDecoded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!user) return;
    getDoc(doc(db, 'users', user.uid))
      .then(snap => setDecoded((snap.data()?.decodedJests as Record<string, boolean>) ?? {}))
      .catch(() => {});
  }, [user]);
  const isLocked = useCallback(
    (e: VaultEntry) => !!e.decoderHash && !isAdmin && !decoded[e.id],
    [isAdmin, decoded],
  );
  // Decoder prompt state
  const [decoderFor, setDecoderFor]   = useState<VaultEntry | null>(null);
  const [decoderTry, setDecoderTry]   = useState('');
  const [decoderWrong, setDecoderWrong] = useState(false);
  const tryDecode = useCallback(async () => {
    if (!user || !decoderFor?.decoderHash) return;
    if (decoderHashOf(decoderTry) !== decoderFor.decoderHash) {
      setDecoderWrong(true);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      return;
    }
    setDecoded(prev => ({ ...prev, [decoderFor.id]: true }));
    // Persist the unlock on the member's own user doc (best-effort).
    // Persist before reporting: the server independently verifies this flag
    // and the locked Chamber entry before it notifies the Jester.
    await updateDoc(doc(db, 'users', user.uid), { [`decodedJests.${decoderFor.id}`]: true });
    void reportHiddenJestFound(decoderFor.id).catch(() => {});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    const e = decoderFor;
    setDecoderFor(null); setDecoderTry(''); setDecoderWrong(false);
    openEntryUnchecked(e);
  }, [user, decoderFor, decoderTry]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Viewer ──
  const [viewing, setViewing] = useState<VaultEntry | null>(null);
  // Keep the open entry live so reactions/comment counts update in the viewer.
  const liveViewing = viewing ? (entries.find(e => e.id === viewing.id) ?? viewing) : null;

  const openEntryUnchecked = useCallback((e: VaultEntry) => {
    if (!user || !jokerId) return;
    setViewing(e);
    logVaultActivity('view', { id: e.id, title: e.title, section: e.section }, { uid: user.uid, jokerId });
  }, [user, jokerId]);

  // Decoder-aware open: locked entries prompt for the Hidden Jest answer.
  const openEntry = useCallback((e: VaultEntry) => {
    if (isLocked(e)) {
      setDecoderTry(''); setDecoderWrong(false); setDecoderFor(e);
      return;
    }
    openEntryUnchecked(e);
  }, [isLocked, openEntryUnchecked]);

  // ── Notification deep link: ?section=…&entryId=… opens that entry ──
  const params = useLocalSearchParams<{ section?: string; entryId?: string; bookReview?: string }>();
  const [handledLink, setHandledLink] = useState<string | null>(null);
  useEffect(() => {
    const target = typeof params.entryId === 'string' ? params.entryId : null;
    if (!target || target === handledLink) return;
    const wanted = typeof params.section === 'string' ? params.section : null;
    if (wanted && config.sections.some(t => t.id === wanted) && wanted !== sectionId) {
      setSectionId(wanted as VaultSection);
      return; // entries for that section load next; effect re-runs on entries change
    }
    const e = entries.find(x => x.id === target);
    if (e) {
      setHandledLink(target);
      openEntry(e);
    }
  }, [params.entryId, params.section, entries, sectionId, handledLink, config, openEntry]);

  // ── Overall book/saga review sheet ──
  const [bookReviewOpen, setBookReviewOpen] = useState(false);
  // Deep link from a saga-review notification.
  useEffect(() => {
    if (params.bookReview === '1' && config.bookReviewSection) setBookReviewOpen(true);
  }, [params.bookReview, config.bookReviewSection]);
  // The Jester authors every entry; any entry's createdBy is his uid.
  const jesterUid = entries.find(e => e.createdBy)?.createdBy;

  // ── Admin form ──
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  const openAdd = useCallback(() => {
    setForm({
      entryId: null, title: '', description: '', status: 'published', order: '',
      file: null, cover: null, chapters: [], scanning: false, scanSummary: null,
      decoder: '', hadDecoder: false, removeDecoder: false,
    });
  }, []);

  const openEditDetails = useCallback((e: VaultEntry) => {
    setForm({
      entryId: e.id,
      title: e.title,
      description: e.description ?? '',
      status: e.status,
      order: String(e.order ?? 0),
      file: null,
      cover: null,
      chapters: (e.chapters ?? []).map(c => ({ title: c.title, startPage: String(c.startPage) })),
      scanning: false,
      scanSummary: null,
      decoder: '', hadDecoder: !!e.decoderHash, removeDecoder: false,
    });
  }, []);

  const pickDocument = useCallback(async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const isPdf = (a.mimeType ?? '').includes('pdf') || (a.name ?? '').toLowerCase().endsWith('.pdf');
    setForm(prev => prev ? {
      ...prev,
      file: { uri: a.uri, name: a.name, mimeType: a.mimeType ?? undefined, size: a.size },
      chapters: [],
      scanning: isPdf,
      scanSummary: null,
    } : prev);
    if (!isPdf) return;
    // Scan the manuscript for chapter boundaries (best-effort; admin corrects).
    try {
      const scan = await manuscriptScannerRef.current?.scan(a.uri, a.size) ?? null;
      setForm(prev => {
        if (!prev || prev.file?.uri !== a.uri) return prev; // stale pick
        return {
          ...prev,
          scanning: false,
          chapters: (scan?.chapters ?? []).map(c => ({ title: c.title, startPage: String(c.startPage) })),
          scanSummary: scan
            ? `${scan.chapters.length} chapter${scan.chapters.length === 1 ? '' : 's'} found across ${scan.numPages} pages · ${Math.round(scan.confidence * 100)}% confidence`
            : 'Automatic scan unavailable — add chapter rows manually.',
        };
      });
    } catch (error) {
      if (isManuscriptScanTooLargeError(error)) {
        setForm(prev => (prev && prev.file?.uri === a.uri
          ? { ...prev, file: null, chapters: [], scanning: false, scanSummary: null }
          : prev));
        Alert.alert('Manuscript too large', error.message);
        return;
      }
      setForm(prev => (prev && prev.file?.uri === a.uri
        ? { ...prev, scanning: false, scanSummary: 'Automatic scan unavailable — add chapter rows manually.' }
        : prev));
    }
  }, []);

  const pickImage = useCallback(async (target: 'file' | 'cover') => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.9,
    });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const pick: VaultFilePick = { uri: a.uri, name: a.fileName ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' };
    setForm(prev => prev ? { ...prev, [target]: pick } : prev);
  }, []);

  const submitForm = useCallback(async () => {
    if (!form || !user || !jokerId || saving) return;
    if (form.scanning) return; // chapter scan still running — button is disabled too
    const title = form.title.trim();
    if (!title) { Alert.alert('Hold up', 'A title is required.'); return; }
    const orderNum = parseInt(form.order, 10);
    const chapterRows = form.chapters
      .map(c => ({ title: c.title.trim(), startPage: parseInt(c.startPage, 10) }))
      .filter(c => c.title && !isNaN(c.startPage) && c.startPage >= 1);
    const input = {
      title,
      description: form.description,
      status: form.status,
      order: isNaN(orderNum) ? 0 : orderNum,
      ...(section.fileKind === 'document' ? { chapters: chapterRows.length ? chapterRows : null } : {}),
      // Decoder lock: a typed answer sets/changes it; the remove toggle
      // clears it; otherwise an existing lock is kept as-is.
      ...(section.hasDecoder
        ? form.removeDecoder
          ? { decoderHash: null }
          : form.decoder.trim()
            ? { decoderHash: decoderHashOf(form.decoder) }
            : {}
        : {}),
    };
    setSaving(true);
    try {
      if (form.entryId) {
        await updateVaultEntry(form.entryId, input);
        logVaultActivity('edit', { id: form.entryId, title, section: sectionId }, { uid: user.uid, jokerId });
      } else {
        if (!form.file) {
          Alert.alert('Hold up', section.missingFileMsg);
          setSaving(false);
          return;
        }
        const id = await addVaultEntry(sectionId, user.uid, input, form.file, form.cover);
        logVaultActivity('upload', { id, title, section: sectionId }, { uid: user.uid, jokerId });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setForm(null);
      if (!form.entryId) {
        setSuccess(section.success);
        setTimeout(() => setSuccess(null), 3000);
      }
    } catch {
      Alert.alert('Save failed', `Could not write to the ${config.name}. Try again.`);
    } finally {
      setSaving(false);
    }
  }, [form, user, jokerId, saving, sectionId, section, config.name]);

  // ── Admin per-entry menu ──
  const adminAction = useCallback(async (e: VaultEntry, action: 'publish' | 'hide' | 'archive' | 'restore') => {
    if (!user || !jokerId) return;
    const status: VaultStatus =
      action === 'publish' || action === 'restore' ? 'published'
      : action === 'hide' ? 'hidden' : 'archived';
    try {
      await updateVaultEntry(e.id, { status });
      logVaultActivity(action, { id: e.id, title: e.title, section: e.section }, { uid: user.uid, jokerId });
    } catch {
      Alert.alert('Failed', 'Could not update the entry. Try again.');
    }
  }, [user, jokerId]);

  const replacePick = useCallback(async (e: VaultEntry, which: 'file' | 'cover') => {
    if (!user || !jokerId) return;
    const def = sectionById(e.section);
    let pick: VaultFilePick | null = null;
    if (def.fileKind === 'document' && which === 'file') {
      const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      pick = { uri: a.uri, name: a.name, mimeType: a.mimeType ?? undefined, size: a.size };
    } else {
      const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
      if (res.canceled || !res.assets?.[0]) return;
      const a = res.assets[0];
      pick = { uri: a.uri, name: a.fileName ?? undefined, mimeType: a.mimeType ?? 'image/jpeg' };
    }
    try {
      // Determine the replacement map while the old file is still intact.
      // replaceVaultFile then clears the old map before touching Storage and
      // publishes file metadata + the new/empty map in one Firestore update.
      let replacementChapters: { title: string; startPage: number }[] | null | undefined;
      if (which === 'file' && def.fileKind === 'document') {
        replacementChapters = null;
        const isPdf = (pick.mimeType ?? '').includes('pdf') || (pick.name ?? '').toLowerCase().endsWith('.pdf');
        if (isPdf) {
          try {
            replacementChapters = (await manuscriptScannerRef.current?.scan(pick.uri, pick.size))?.chapters ?? null;
          } catch (error) {
            if (isManuscriptScanTooLargeError(error)) throw error;
            // A parser/CDN failure publishes an empty map rather than stale
            // boundaries from the previous manuscript.
          }
        }
      }
      await replaceVaultFile(e, pick, which, replacementChapters);
      logVaultActivity('replace', { id: e.id, title: e.title, section: e.section }, { uid: user.uid, jokerId });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (error) {
      Alert.alert(
        isManuscriptScanTooLargeError(error) ? 'Manuscript too large' : 'Replace failed',
        isManuscriptScanTooLargeError(error)
          ? error.message
          : 'Could not replace the file. Try again.',
      );
    }
  }, [user, jokerId, sectionById]);

  const confirmDelete = useCallback((e: VaultEntry) => {
    confirmAction(`Remove this from the ${config.name}?`, 'This action cannot be undone.', 'Delete', async () => {
      try {
        await deleteVaultEntry(e);
        if (user && jokerId) {
          logVaultActivity('delete', { id: e.id, title: e.title, section: e.section }, { uid: user.uid, jokerId });
        }
      } catch {
        showAlert('Delete failed', 'Could not remove the entry. Try again.');
      }
    });
  }, [user, jokerId, config.name]);

  // React Native Web silently no-ops Alert.alert with a button list, so the
  // per-entry admin menu renders as an in-app sheet on web (native keeps the
  // platform action alert).
  const [webMenu, setWebMenu] = useState<{ title: string; opts: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] } | null>(null);

  const openAdminMenu = useCallback((e: VaultEntry) => {
    const def = sectionById(e.section);
    const opts: { text: string; onPress?: () => void; style?: 'cancel' | 'destructive' }[] = [
      { text: 'Edit Details', onPress: () => openEditDetails(e) },
      {
        text: def.fileKind === 'document' ? 'Replace File' : 'Replace Image',
        onPress: () => replacePick(e, 'file'),
      },
    ];
    if (def.hasCover) {
      opts.push({ text: e.coverPath ? 'Replace Cover Image' : 'Add Cover Image', onPress: () => replacePick(e, 'cover') });
    }
    if (e.status !== 'published') opts.push({ text: e.status === 'archived' ? 'Restore Entry' : 'Publish Entry', onPress: () => adminAction(e, e.status === 'archived' ? 'restore' : 'publish') });
    if (e.status === 'published') opts.push({ text: 'Hide Entry', onPress: () => adminAction(e, 'hide') });
    if (e.status !== 'archived') opts.push({ text: 'Archive Entry', onPress: () => adminAction(e, 'archive') });
    opts.push({ text: 'Change Display Order', onPress: () => openEditDetails(e) });
    opts.push({ text: 'Delete Entry', style: 'destructive', onPress: () => confirmDelete(e) });
    opts.push({ text: 'Cancel', style: 'cancel' });
    if (Platform.OS === 'web') setWebMenu({ title: e.title, opts });
    else Alert.alert(e.title, `Manage this ${config.name} entry`, opts);
  }, [sectionById, openEditDetails, replacePick, adminAction, confirmDelete, config.name]);

  // ── Activity records (admin only, this screen's sections only) ──
  const [showRecords, setShowRecords] = useState(false);
  const [records, setRecords] = useState<VaultActivityRecord[]>([]);
  useEffect(() => {
    if (!showRecords || !isAdmin) return;
    const ids = config.sections.map(t => t.id);
    return listenVaultActivity(rs => setRecords(rs.filter(r => ids.includes(r.section))), () => {});
  }, [showRecords, isAdmin, config]);

  // ── Renderers ──
  const renderEntry = ({ item }: { item: VaultEntry }) => {
    const def = sectionById(item.section);
    return (
      <View style={s.card}>
        <View style={s.cardRow}>
          <ProtectedThumb
            path={def.fileKind === 'image' ? (item.coverPath ?? item.filePath) : item.coverPath}
            style={s.thumb}
          />
          <View style={s.cardBody}>
            <View style={s.cardHead}>
              <Text style={s.cardTitle} numberOfLines={2}>{item.title}</Text>
              {canCurate && (
                <TouchableOpacity onPress={() => openAdminMenu(item)} hitSlop={10} activeOpacity={0.7}>
                  <Feather name="more-vertical" size={17} color={GOLD} />
                </TouchableOpacity>
              )}
            </View>
            {item.description ? <Text style={s.cardDesc} numberOfLines={3}>{item.description}</Text> : null}
            {item.createdAt ? (
              <Text style={s.cardDate}>
                {item.createdAt.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
              </Text>
            ) : null}
            {(item.reviewCount ?? 0) > 0 || (item.commentCount ?? 0) > 0 || Object.values(item.reactions ?? {}).some(u => u.length > 0) ? (
              <View style={s.metaRow}>
                {(item.reviewCount ?? 0) > 0 ? (
                  <View style={s.metaItem}>
                    <Text style={s.metaStar}>★</Text>
                    <Text style={s.metaText}>
                      {((item.ratingSum ?? 0) / (item.reviewCount ?? 1)).toFixed(1)} ({item.reviewCount})
                    </Text>
                  </View>
                ) : null}
                {(item.commentCount ?? 0) > 0 ? (
                  <View style={s.metaItem}>
                    <Feather name="message-circle" size={11} color="rgba(212,168,83,0.7)" />
                    <Text style={s.metaText}>{item.commentCount}</Text>
                  </View>
                ) : null}
                {Object.entries(item.reactions ?? {})
                  .filter(([, uids]) => uids.length > 0)
                  .slice(0, 4)
                  .map(([emoji, uids]) => (
                    <Text key={emoji} style={s.metaText}>{emoji} {uids.length}</Text>
                  ))}
              </View>
            ) : null}
            {isAdmin && item.status !== 'published' ? (
              <View style={s.statusPill}><Text style={s.statusPillText}>{STATUS_LABELS[item.status].toUpperCase()}</Text></View>
            ) : null}
          </View>
        </View>
        <TouchableOpacity style={s.viewBtn} onPress={() => openEntry(item)} activeOpacity={0.85}>
          {isLocked(item) ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <Feather name="lock" size={13} color={GOLD} />
              <Text style={s.viewBtnText}>DECODE TO UNLOCK</Text>
            </View>
          ) : (
            <Text style={s.viewBtnText}>{def.viewBtn}</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={s.root}>
      <ManuscriptScanner ref={manuscriptScannerRef} />
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
          <Text style={s.navTitle} numberOfLines={1}>{config.name}</Text>
          <View style={s.navRight}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      {/* ── Screen label + admin records button ── */}
      <View style={[s.labelRow, { top: navBottom + 8 }]}>
        <Text style={s.screenLabel} numberOfLines={1}>{config.name}</Text>
        {isAdmin && (
          <TouchableOpacity style={s.recordsBtn} onPress={() => setShowRecords(true)} hitSlop={8} activeOpacity={0.75}>
            <Feather name="activity" size={16} color={GOLD} />
          </TouchableOpacity>
        )}
      </View>

      {/* ── Folder ── */}
      <View style={[s.folderWrap, { top: navBottom + 42 }]}>
        <View style={s.tabsRow}>
          {config.sections.map(t => {
            const active = t.id === sectionId;
            return (
              <TouchableOpacity
                key={t.id}
                style={[s.tab, active && s.tabActive]}
                onPress={() => switchSection(t.id)}
                activeOpacity={0.8}
              >
                <Text style={[s.tabText, active && s.tabTextActive]} numberOfLines={1}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={s.body}>
          {success ? (
            <View style={s.successBanner}><Text style={s.successText}>{success}</Text></View>
          ) : null}

          {loading ? (
            <View style={s.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
          ) : entries.length === 0 ? (
            <View style={s.centerFill}>
              <Feather name={section.emptyIcon as any} size={30} color="rgba(212,168,83,0.25)" />
              <Text style={s.emptyText}>{section.empty}</Text>
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

          {config.bookReviewSection === sectionId && (
            <TouchableOpacity style={s.bookReviewBtn} onPress={() => setBookReviewOpen(true)} activeOpacity={0.85}>
              <Feather name="star" size={14} color={GOLD} />
              <Text style={s.bookReviewText}>REVIEW THE SAGA</Text>
            </TouchableOpacity>
          )}

          {canCurate && (
            <TouchableOpacity style={s.actionBtn} onPress={openAdd} activeOpacity={0.85}>
              <Text style={s.actionBtnText}>{section.adminBtn}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── Protected viewer ── */}
      <VaultViewer
        entry={liveViewing}
        watermarkLabel={watermarkLabel}
        notice={config.notice}
        fallbackContentType={viewing && sectionById(viewing.section).fileKind === 'image' ? 'image/jpeg' : undefined}
        onClose={() => setViewing(null)}
      />

      {/* ── Overall book/saga review ── */}
      <VaultDiscussion
        visible={bookReviewOpen}
        entry={null}
        bookNotifyUid={jesterUid}
        onClose={() => setBookReviewOpen(false)}
      />

      {/* ── Admin form ── */}
      <Modal visible={!!form} animationType="slide" transparent onRequestClose={() => setForm(null)}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={s.sheetOverlay}>
          <View style={[s.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle} numberOfLines={1}>
                {form?.entryId ? 'Edit Details' : section.sheetTitle}
              </Text>
              <TouchableOpacity onPress={() => setForm(null)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>

            <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              <Text style={s.fieldLabel}>{section.titleLabel}</Text>
              <TextInput
                style={s.input}
                placeholder={section.titlePlaceholder}
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={form?.title ?? ''}
                onChangeText={t => setForm(p => p ? { ...p, title: t } : p)}
                maxLength={200}
              />

              <Text style={s.fieldLabel}>{section.descLabel}</Text>
              <TextInput
                style={[s.input, s.inputMultiline]}
                placeholder="Short description…"
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={form?.description ?? ''}
                onChangeText={t => setForm(p => p ? { ...p, description: t } : p)}
                multiline
                textAlignVertical="top"
                maxLength={2000}
              />

              {!form?.entryId && (
                <>
                  <Text style={s.fieldLabel}>{section.uploadLabel}</Text>
                  <TouchableOpacity
                    style={s.pickBtn}
                    onPress={() => (section.fileKind === 'document' ? pickDocument() : pickImage('file'))}
                    activeOpacity={0.8}
                  >
                    <Feather name={form?.file ? 'check-circle' : 'upload'} size={16} color={GOLD} />
                    <Text style={s.pickBtnText} numberOfLines={1}>
                      {form?.file ? (form.file.name ?? 'File selected') : section.uploadPlaceholder}
                    </Text>
                  </TouchableOpacity>

                  {section.hasCover && (
                    <>
                      <Text style={s.fieldLabel}>OPTIONAL COVER IMAGE</Text>
                      <TouchableOpacity style={s.pickBtn} onPress={() => pickImage('cover')} activeOpacity={0.8}>
                        <Feather name={form?.cover ? 'check-circle' : 'image'} size={16} color={GOLD} />
                        <Text style={s.pickBtnText} numberOfLines={1}>
                          {form?.cover ? (form.cover.name ?? 'Cover selected') : 'Choose a cover image'}
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </>
              )}

              {/* ── Manuscript chapters (documents only) ── */}
              {section.fileKind === 'document' && (form?.entryId || form?.file) ? (
                <>
                  <Text style={s.fieldLabel}>CHAPTERS</Text>
                  {form?.scanning ? (
                    <View style={s.scanRow}>
                      <ActivityIndicator size="small" color={GOLD} />
                      <Text style={s.scanText}>Reading the manuscript for chapter headings…</Text>
                    </View>
                  ) : (
                    <>
                      {form?.scanSummary ? <Text style={s.chapterHint}>{form.scanSummary}</Text> : null}
                      {(form?.chapters ?? []).map((c, i) => (
                        <View key={i} style={s.chapterEditRow}>
                          <TextInput
                            style={[s.input, s.chapterTitleInput]}
                            placeholder={`Chapter ${i + 1} title…`}
                            placeholderTextColor="rgba(237,224,196,0.35)"
                            value={c.title}
                            onChangeText={t => setForm(p => p ? {
                              ...p, chapters: p.chapters.map((x, j) => j === i ? { ...x, title: t } : x),
                            } : p)}
                            maxLength={120}
                          />
                          <TextInput
                            style={[s.input, s.chapterPageInput]}
                            placeholder="pg"
                            placeholderTextColor="rgba(237,224,196,0.35)"
                            value={c.startPage}
                            onChangeText={t => setForm(p => p ? {
                              ...p, chapters: p.chapters.map((x, j) => j === i ? { ...x, startPage: t.replace(/[^0-9]/g, '').slice(0, 5) } : x),
                            } : p)}
                            keyboardType="number-pad"
                          />
                          <TouchableOpacity
                            onPress={() => setForm(p => p ? { ...p, chapters: p.chapters.filter((_, j) => j !== i) } : p)}
                            hitSlop={8} activeOpacity={0.7}
                          >
                            <Feather name="trash-2" size={15} color="rgba(237,224,196,0.45)" />
                          </TouchableOpacity>
                        </View>
                      ))}
                      <TouchableOpacity
                        style={s.addChapterBtn}
                        onPress={() => setForm(p => p ? { ...p, chapters: [...p.chapters, { title: '', startPage: '' }] } : p)}
                        activeOpacity={0.8}
                      >
                        <Feather name="plus" size={14} color={GOLD} />
                        <Text style={s.addChapterText}>ADD CHAPTER</Text>
                      </TouchableOpacity>
                      <Text style={s.chapterHint}>
                        {(form?.chapters?.length ?? 0) > 0
                          ? 'Detected from the manuscript — correct titles or start pages as needed.'
                          : 'No chapters set — readers will see the manuscript as one piece. Add rows to split it.'}
                      </Text>
                    </>
                  )}
                </>
              ) : null}

              <Text style={s.fieldLabel}>VISIBILITY</Text>
              <View style={s.choiceRow}>
                {(['published', 'hidden', 'archived'] as VaultStatus[]).map(st => {
                  const on = form?.status === st;
                  return (
                    <TouchableOpacity
                      key={st}
                      style={[s.choicePill, on && s.choicePillOn]}
                      onPress={() => setForm(p => p ? { ...p, status: st } : p)}
                      activeOpacity={0.8}
                    >
                      <Text style={[s.choicePillText, on && s.choicePillTextOn]}>{STATUS_LABELS[st].toUpperCase()}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              {section.hasDecoder && (
                <>
                  <Text style={s.fieldLabel}>DECODER — HIDDEN JEST ANSWER (OPTIONAL)</Text>
                  <TextInput
                    style={s.input}
                    placeholder={form?.hadDecoder ? 'Locked — type a new answer to change it' : 'Leave blank for no lock'}
                    placeholderTextColor="rgba(237,224,196,0.35)"
                    value={form?.decoder ?? ''}
                    onChangeText={t => setForm(p => p ? { ...p, decoder: t, removeDecoder: false } : p)}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={120}
                  />
                  <Text style={s.chapterHint}>
                    Members must enter this answer (from the Hidden Jest on the Jester&apos;s Ticket) to unlock the entry.
                    Capitalization and extra spaces don&apos;t matter.
                  </Text>
                  {form?.hadDecoder && (
                    <TouchableOpacity
                      onPress={() => setForm(p => p ? { ...p, removeDecoder: !p.removeDecoder, decoder: '' } : p)}
                      activeOpacity={0.7}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginBottom: 6 }}
                    >
                      <Feather name={form.removeDecoder ? 'check-square' : 'square'} size={14} color={GOLD} />
                      <Text style={s.chapterHint}>Remove the decoder lock — everyone can open it.</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              <Text style={s.fieldLabel}>DISPLAY ORDER</Text>
              <TextInput
                style={[s.input, { width: 110, textAlign: 'center' }]}
                placeholder="0"
                placeholderTextColor="rgba(237,224,196,0.35)"
                value={form?.order ?? ''}
                onChangeText={t => setForm(p => p ? { ...p, order: t.replace(/[^0-9-]/g, '').slice(0, 5) } : p)}
                keyboardType="number-pad"
              />

              <TouchableOpacity
                style={[s.saveBtn, (!(form?.title ?? '').trim() || saving || form?.scanning) && s.saveBtnDisabled]}
                onPress={submitForm}
                disabled={!(form?.title ?? '').trim() || saving || form?.scanning}
                activeOpacity={0.85}
              >
                {saving
                  ? <ActivityIndicator color={GOLD} size="small" />
                  : <Text style={s.saveBtnText}>LOCK IT IN</Text>}
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Decoder prompt (locked Chamber entry) ── */}
      <Modal visible={!!decoderFor} transparent animationType="fade" onRequestClose={() => setDecoderFor(null)}>
        <View style={s.decoderOverlay}>
          <View style={s.decoderCard}>
            <Feather name="lock" size={22} color={GOLD} style={{ alignSelf: 'center', marginBottom: 8 }} />
            <Text style={s.decoderTitle}>{decoderFor?.title}</Text>
            <Text style={s.decoderHint}>
              This entry is locked behind a Hidden Jest. Decode the Jester&apos;s Ticket and enter the answer.
            </Text>
            <TextInput
              style={[s.input, decoderWrong && { borderColor: 'rgba(220,60,60,0.7)' }]}
              placeholder="Enter the decoded answer…"
              placeholderTextColor="rgba(237,224,196,0.35)"
              value={decoderTry}
              onChangeText={t => { setDecoderTry(t); setDecoderWrong(false); }}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={tryDecode}
              maxLength={120}
            />
            {decoderWrong && <Text style={s.decoderWrong}>Not quite. Look closer at the Ticket.</Text>}
            <TouchableOpacity
              style={[s.saveBtn, !decoderTry.trim() && s.saveBtnDisabled]}
              onPress={tryDecode}
              disabled={!decoderTry.trim()}
              activeOpacity={0.85}
            >
              <Text style={s.saveBtnText}>DECODE</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setDecoderFor(null)} activeOpacity={0.7} style={{ marginTop: 10, alignSelf: 'center' }}>
              <Text style={s.decoderHint}>NOT YET</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ── Activity records (admin only) ── */}
      <Modal visible={showRecords && isAdmin} animationType="slide" transparent onRequestClose={() => setShowRecords(false)}>
        <View style={s.sheetOverlay}>
          <View style={[s.sheet, { maxHeight: SH * 0.86, paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle}>{config.name} Activity</Text>
              <TouchableOpacity onPress={() => setShowRecords(false)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>
            {records.length === 0 ? (
              <View style={[s.centerFill, { minHeight: 120 }]}>
                <Text style={s.emptyText}>No {config.name} activity yet.</Text>
              </View>
            ) : (
              <FlatList
                data={records}
                keyExtractor={r => r.id}
                showsVerticalScrollIndicator={false}
                renderItem={({ item }) => (
                  <View style={s.recordRow}>
                    <Text style={s.recordMain} numberOfLines={2}>
                      {[item.jokerId, item.street].filter(Boolean).join(' · ')} — {item.action.toUpperCase()} — {item.entryTitle}
                    </Text>
                    <Text style={s.recordMeta}>
                      {sectionById(item.section).displayName}
                      {item.at ? `  ·  ${item.at.toDate().toLocaleString()}` : ''}
                    </Text>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* ── Per-entry admin menu (web fallback for the native action alert) ── */}
      <Modal visible={!!webMenu} animationType="fade" transparent onRequestClose={() => setWebMenu(null)}>
        <View style={s.sheetOverlay}>
          <View style={[s.sheet, { maxHeight: SH * 0.8, paddingBottom: Math.max(insets.bottom, 16) }]}>
            <View style={s.sheetHeader}>
              <Text style={s.sheetTitle} numberOfLines={1}>{webMenu?.title}</Text>
              <TouchableOpacity onPress={() => setWebMenu(null)} activeOpacity={0.7}>
                <Feather name="x" size={22} color={CREAM} />
              </TouchableOpacity>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              {(webMenu?.opts ?? []).filter(o => o.style !== 'cancel').map((o, i) => (
                <TouchableOpacity
                  key={i}
                  style={s.webMenuRow}
                  activeOpacity={0.75}
                  onPress={() => { setWebMenu(null); o.onPress?.(); }}
                >
                  <Text style={[s.webMenuText, o.style === 'destructive' && { color: '#C0392B' }]}>{o.text}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { ...MARBLE_TEXT_SHADOW, flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  navLeft:  { flexDirection: 'row', alignItems: 'center', gap: 2 },
  navRight: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  dagIcon:  { width: 48, height: 26 },
  sqIcon:   { width: 34, height: 34 },

  scanRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  scanText: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold', fontSize: 11 },
  chapterEditRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  chapterTitleInput: { flex: 1, marginBottom: 0 },
  chapterPageInput: { width: 64, textAlign: 'center', marginBottom: 0 },
  addChapterBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 38, borderRadius: 8, marginTop: 2,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', backgroundColor: 'rgba(212,168,83,0.06)',
  },
  addChapterText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 10.5, letterSpacing: 1.5 },
  chapterHint: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Cinzel_400Regular', fontSize: 10.5,
    lineHeight: 15, marginTop: 8,
  },

  labelRow: {
    position: 'absolute', left: 0, right: 0, zIndex: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
  },
  screenLabel: {
    ...MARBLE_TEXT_SHADOW,
    textAlign: 'center', color: GOLD, fontFamily: 'Cinzel_700Bold',
    fontSize: 18, letterSpacing: 3,
  },
  recordsBtn: {
    position: 'absolute', right: SIDE + 4,
    width: 32, height: 32, borderRadius: 16,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
    backgroundColor: 'rgba(212,168,83,0.08)',
    alignItems: 'center', justifyContent: 'center',
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
    ...MARBLE_TEXT_SHADOW,
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
    backgroundColor: 'rgba(5,3,0,0.82)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
    padding: 12, marginBottom: 10,
  },
  cardRow: { flexDirection: 'row', gap: 12 },
  thumb: {
    width: 64, height: 86, borderRadius: 6,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.25)',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  thumbFallback: { alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1, minWidth: 0 },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  cardTitle: { flex: 1, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 0.5, lineHeight: 19 },
  cardDesc: { color: 'rgba(237,224,196,0.7)', fontFamily: 'Cinzel_400Regular', fontSize: 11.5, lineHeight: 17, marginTop: 4 },
  cardDate: { color: 'rgba(237,224,196,0.3)', fontFamily: 'Cinzel_400Regular', fontSize: 9.5, marginTop: 6 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaText: { color: 'rgba(237,224,196,0.55)', fontSize: 10.5 },
  metaStar: { color: 'rgba(212,168,83,0.85)', fontSize: 11 },

  bookReviewBtn: {
    height: 44, borderRadius: 10, marginTop: 10,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: 'rgba(212,168,83,0.06)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  bookReviewText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11.5, letterSpacing: 2 },

  statusPill: {
    alignSelf: 'flex-start', marginTop: 6,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
    backgroundColor: 'rgba(212,168,83,0.1)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  statusPillText: { color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9, letterSpacing: 1 },

  viewBtn: {
    height: 40, borderRadius: 8, marginTop: 10,
    backgroundColor: 'rgba(200,165,60,0.08)',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  viewBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 11.5, letterSpacing: 2 },

  actionBtn: {
    height: 50, borderRadius: 10, marginTop: 10,
    backgroundColor: 'rgba(200,165,60,0.1)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  actionBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2.5 },

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
  decoderOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.75)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  decoderCard: {
    width: '100%', maxWidth: 420, borderRadius: 14, padding: 20,
    backgroundColor: '#141008', borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  decoderTitle: {
    color: CREAM, fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 6,
  },
  decoderHint: {
    color: 'rgba(237,224,196,0.6)', fontSize: 12, textAlign: 'center',
    lineHeight: 17, marginBottom: 12,
  },
  decoderWrong: {
    color: '#D08080', fontSize: 12, textAlign: 'center', marginBottom: 8,
  },
  input: {
    height: 42,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12,
  },
  inputMultiline: { height: undefined, minHeight: 90, maxHeight: 160, paddingVertical: 10 },

  pickBtn: {
    minHeight: 46, borderRadius: 8,
    borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.4)', borderStyle: 'dashed',
    backgroundColor: 'rgba(0,0,0,0.4)',
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  pickBtnText: { flex: 1, color: 'rgba(237,224,196,0.8)', fontFamily: 'Cinzel_400Regular', fontSize: 12 },

  choiceRow: { flexDirection: 'row', gap: 8 },
  choicePill: {
    flex: 1, height: 38, borderRadius: 8,
    borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.3)',
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  choicePillOn: { borderColor: 'rgba(212,168,83,0.7)', backgroundColor: 'rgba(212,168,83,0.12)' },
  choicePillText: { color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1 },
  choicePillTextOn: { color: GOLD },

  saveBtn: {
    height: 50, borderRadius: 10, marginTop: 20,
    backgroundColor: 'rgba(212,168,83,0.15)',
    borderWidth: 1.5, borderColor: 'rgba(212,168,83,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  saveBtnDisabled: { opacity: 0.4 },
  saveBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 13, letterSpacing: 2.5 },

  recordRow: {
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: 'rgba(200,165,60,0.12)',
  },
  recordMain: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5, letterSpacing: 0.5, lineHeight: 17 },
  webMenuRow: {
    paddingVertical: 13, paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(200,165,60,0.15)',
  },
  webMenuText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 13, letterSpacing: 0.5 },
  recordMeta: { color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_400Regular', fontSize: 10, marginTop: 3 },
});
