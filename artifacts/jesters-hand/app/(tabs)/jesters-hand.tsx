// ── Jester's Hand screen (ADMIN ONLY — Joker 00-00) ──────────────────────────
// Same black-and-cream marble + black tabbed-folder design as Recruit/Vault/
// Chamber. Five tabs: ♦ The Hand, ♥ Reports, ♠ Investigations, ♣ Activity,
// and the Jester's masks — Archive. Members (01-54 … 54-54) never see the
// tile and are bounced home if they somehow land here.
//
// THE HAND: the roster of all 54 permanent Joker ID slots with the three
// administrative actions — Suspend (temporarily disable login, data kept),
// Recover (reset only the cipher), Transfer (permanent wipe, slot handed to
// a new member — Joker ID itself never changes).

import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Image,
  FlatList, TextInput, Modal, ActivityIndicator, KeyboardAvoidingView,
  ScrollView, Dimensions,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/contexts/AuthContext';
import WhisperNavIcon from '@/components/WhisperNavIcon';
import BellNavIcon from '@/components/BellNavIcon';
import {
  RosterSlot, listenRoster, setSuspended, recoverCipher, transferSlot,
} from '@/lib/handService';
import {
  Report, listenReports, fetchEvidenceUrls, formatReportTimestamp,
  setReportStatus, deleteReport,
} from '@/lib/reportService';
import {
  fetchInvestigation, resolveJokerId, ActivityItem, InvestigationResult,
} from '@/lib/investigationService';
import { formatDuration } from '@/lib/sessionService';
import {
  ArchiveRecord, ARCHIVE_TYPE_LABEL, listenArchives, restoreArchive,
  purgeArchive, formatArchiveTimestamp, archivePreview,
} from '@/lib/archiveService';
import { fetchProtectedDataUri } from '@/lib/vaultService';
import AppKeyQr from '@/components/admin/AppKeyQr';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const NAV_DAGGER = require('../../assets/images/nav_dagger.png');
const NAV_CARDS  = require('../../assets/images/nav_cards.png');
const MARBLE     = require('../../assets/images/wood_bg.png');

const NAV_H = 52;
const SIDE  = 16;
const TAB_H = 46;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const RED   = '#B03A3A';

type SectionId = 'hand' | 'reports' | 'investigations' | 'activity' | 'archive';

const SECTIONS: { id: SectionId; suit: string; suitColor: string; label: string }[] = [
  { id: 'hand',           suit: '\u2666', suitColor: RED,   label: 'The Hand' },
  { id: 'reports',        suit: '\u2665', suitColor: RED,   label: 'Reports' },
  { id: 'investigations', suit: '\u2660', suitColor: CREAM, label: 'Investigations' },
  { id: 'activity',       suit: '\u2663', suitColor: CREAM, label: 'Activity' },
  { id: 'archive',        suit: '\u{1F3AD}', suitColor: GOLD, label: 'Archive' },
];

const EMPTY_COPY: Record<SectionId, string> = {
  hand:           '',
  reports:        'No cards have been filed.\nWhen a member files The Card from a Pocket conversation,\nthe report lands here — visible only to you.',
  investigations: 'Search any Joker ID (01-54 … 54-54) to see their complete\npublic activity and login history in one timeline.\nPocket conversations stay private — they never appear here.',
  activity:       'Search any Joker ID (01-54 … 54-54) to see a high-level log of\nwhat they did, where, and when — plus login and logout times.\nNo content is shown here; open Investigations for the full context.',
  archive:        'The archive is empty.\nAnything deleted anywhere in the app lands here first,\nso you can review it, restore it, or erase it for good.',
};

// ── Action modal state ────────────────────────────────────────────────────────

type ActionKind = 'suspend' | 'unsuspend' | 'recover' | 'transfer';

interface PendingAction {
  kind: ActionKind;
  slot: RosterSlot; // slot.member is always set for actions
}

const ACTION_COPY: Record<ActionKind, { title: string; body: string; confirm: string }> = {
  suspend: {
    title: 'SUSPEND',
    body: 'Temporarily disables this Joker ID. The member cannot log in or use the app while suspended. Nothing is deleted or changed — lifting the suspension restores everything exactly as it was.',
    confirm: 'Suspend',
  },
  unsuspend: {
    title: 'LIFT SUSPENSION',
    body: 'Restores this Joker ID. The member can log in again with their existing cipher. All of their data is exactly as they left it.',
    confirm: 'Reinstate',
  },
  recover: {
    title: 'RECOVER',
    body: 'Resets only the cipher connected to this Joker ID. The Joker ID stays exactly the same and no data is deleted or changed. Set the new cipher below and pass it to the member.',
    confirm: 'Reset Cipher',
  },
  transfer: {
    title: 'TRANSFER',
    body: 'PERMANENT. Everything ever created, stored, or completed under this Joker ID is wiped forever — ticket, profile, posts, comments, reactions, messages, Pocket conversations, table, pool, debate, target, black book activity, and all files. The Joker ID itself survives as a clean slot for a new member with the new cipher you set below.\n\nThis cannot be undone.',
    confirm: 'Wipe & Transfer',
  },
};

export default function JestersHandScreen() {
  const insets    = useSafeAreaInsets();
  const topInset  = Platform.OS === 'web' ? 50 : insets.top;
  const navBottom = topInset + NAV_H;
  const { user, isAdmin, isVaultKeeper } = useAuth();

  useEffect(() => { if (user === null) router.replace('/'); }, [user]);
  // Admin-only screen: bounce anyone who isn't 00-00.
  useEffect(() => { if (user && !isAdmin) router.replace('/(tabs)/home'); }, [user, isAdmin]);

  const [section, setSection] = useState<SectionId>('hand');

  // Deep link (e.g. "card passed" notification tap) → open a specific tab.
  const params = useLocalSearchParams<{ section?: string }>();
  useEffect(() => {
    const s = params.section;
    if (s && SECTIONS.some(t => t.id === s)) setSection(s as SectionId);
  }, [params.section]);

  // ── The Hand roster ──
  const [slots, setSlots] = useState<RosterSlot[] | null>(null);
  useEffect(() => {
    if (!user || !isAdmin) return;
    return listenRoster(setSlots);
  }, [user, isAdmin]);

  const [action, setAction] = useState<PendingAction | null>(null);
  const [cipher, setCipher] = useState('');
  const [confirmId, setConfirmId] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const openAction = (kind: ActionKind, slot: RosterSlot) => {
    setCipher(''); setConfirmId(''); setActionError(null);
    setAction({ kind, slot });
  };
  const closeAction = () => { if (!busy) setAction(null); };

  const showBanner = (msg: string) => {
    setBanner(msg);
    setTimeout(() => setBanner(null), 5000);
  };

  // ── Reports ("Cards") ──
  const [reports, setReports] = useState<Report[] | null>(null);
  useEffect(() => {
    if (!user || !isAdmin || section !== 'reports') return;
    return listenReports(setReports);
  }, [user, isAdmin, section]);

  const [openReport, setOpenReport]     = useState<Report | null>(null);
  const [evidence, setEvidence]         = useState<(string | null)[] | null>(null);
  const [evidenceError, setEvidenceError] = useState(false);
  const [suspendArmed, setSuspendArmed] = useState(false);
  const [discardArmed, setDiscardArmed] = useState(false);
  const [reportBusy, setReportBusy]     = useState(false);
  const [reportError, setReportError]   = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  useEffect(() => {
    setEvidence(null); setEvidenceError(false);
    setSuspendArmed(false); setDiscardArmed(false); setReportError(null);
    if (!openReport) return;
    let live = true;
    fetchEvidenceUrls(openReport.evidencePaths)
      .then(urls => { if (live) setEvidence(urls); })
      .catch(() => { if (live) { setEvidence([]); setEvidenceError(true); } });
    return () => { live = false; };
  }, [openReport?.id]);

  // Live status of the reported member (from the same roster listener).
  const reportedMember = openReport
    ? slots?.find(sl => sl.member?.uid === openReport.reportedUid)?.member
    : undefined;

  const suspendReported = async () => {
    if (!openReport) return;
    if (!reportedMember) {
      setReportError('This member no longer holds a slot.');
      return;
    }
    setReportBusy(true); setReportError(null);
    try {
      await setSuspended(reportedMember.uid, true);
      setSuspendArmed(false);
    } catch (err: any) {
      setReportError(err?.message ?? 'Suspension failed. Try again.');
    } finally {
      setReportBusy(false);
    }
  };

  // Close out a settled case: keep the report but move it to Resolved.
  const toggleResolved = async () => {
    if (!openReport) return;
    const next = openReport.status === 'resolved' ? 'open' : 'resolved';
    setReportBusy(true); setReportError(null);
    try {
      await setReportStatus(openReport.id, next);
      setOpenReport(null);
    } catch (err: any) {
      setReportError(err?.message ?? 'The update failed. Try again.');
    } finally {
      setReportBusy(false);
    }
  };

  // Discard forever: delete the report doc and its evidence files.
  const discardReport = async () => {
    if (!openReport) return;
    setReportBusy(true); setReportError(null);
    try {
      await deleteReport(openReport);
      setOpenReport(null);
    } catch (err: any) {
      setReportError(err?.message ?? 'The discard failed. Try again.');
    } finally {
      setReportBusy(false);
    }
  };

  // ── Investigations ──
  const [invQuery, setInvQuery]   = useState('');
  const [invBusy, setInvBusy]     = useState(false);
  const [invError, setInvError]   = useState<string | null>(null);
  const [invResult, setInvResult] = useState<InvestigationResult | null>(null);
  const [openItem, setOpenItem]   = useState<ActivityItem | null>(null);

  // ── Activity (high-level, content-free) ──
  const [actQuery, setActQuery]   = useState('');
  const [actBusy, setActBusy]     = useState(false);
  const [actError, setActError]   = useState<string | null>(null);
  const [actResult, setActResult] = useState<InvestigationResult | null>(null);

  const runLookup = async (
    raw: string,
    set: {
      busy: (b: boolean) => void;
      error: (e: string | null) => void;
      result: (r: InvestigationResult | null) => void;
    },
  ) => {
    const q = raw.trim();
    if (!/^\d{2}-\d{2}$/.test(q)) {
      set.error('Enter a Joker ID like 07-54.');
      return;
    }
    if (q === '00-00') {
      set.error('That is your own Joker ID.');
      return;
    }
    set.busy(true); set.error(null); set.result(null);
    try {
      // The roster listener already maps every slot; fall back to a lookup.
      const fromRoster = slots?.find(sl => sl.member?.jokerId === q)?.member;
      const uid = fromRoster?.uid ?? (await resolveJokerId(q))?.uid;
      if (!uid) {
        set.error(`No member currently holds ${q}.`);
        return;
      }
      set.result(await fetchInvestigation(uid, q));
    } catch (err: any) {
      set.error(err?.message ?? 'The lookup failed. Try again.');
    } finally {
      set.busy(false);
    }
  };

  const runInvestigation = () =>
    runLookup(invQuery, { busy: setInvBusy, error: setInvError, result: setInvResult });
  const runActivity = () =>
    runLookup(actQuery, { busy: setActBusy, error: setActError, result: setActResult });

  // ── Archives ──
  const [archives, setArchives]         = useState<ArchiveRecord[] | null>(null);
  const [archListError, setArchListError] = useState<string | null>(null);
  const [archQuery, setArchQuery]       = useState('');
  const [openArch, setOpenArch]         = useState<ArchiveRecord | null>(null);
  const [archImages, setArchImages]     = useState<(string | null)[] | null>(null);
  const [archBusy, setArchBusy]         = useState(false);
  const [archError, setArchError]       = useState<string | null>(null);
  const [purgeArmed, setPurgeArmed]     = useState(false);

  useEffect(() => {
    if (!isAdmin || section !== 'archive') return;
    const stop = listenArchives(setArchives, () =>
      setArchListError('The archive could not be loaded. Try again.'));
    return stop;
  }, [isAdmin, section]);

  const filteredArchives = useMemo(() => {
    if (!archives) return null;
    const q = archQuery.trim().toLowerCase();
    if (!q) return archives;
    return archives.filter(a =>
      a.title.toLowerCase().includes(q) || a.ownerJokerId.toLowerCase().includes(q));
  }, [archives, archQuery]);

  // Load image previews when an archived item is opened.
  useEffect(() => {
    if (!openArch) { setArchImages(null); setArchError(null); setPurgeArmed(false); return; }
    const imgPaths = openArch.storagePaths.filter(p => !p.match(/^vault\/[^/]+\/file$/));
    if (imgPaths.length === 0) { setArchImages([]); return; }
    let live = true;
    setArchImages(null);
    Promise.all(imgPaths.map(p => fetchProtectedDataUri(p, 'image/jpeg').catch(() => null)))
      .then(uris => { if (live) setArchImages(uris); });
    return () => { live = false; };
  }, [openArch]);

  const doRestore = async () => {
    if (!openArch) return;
    setArchBusy(true); setArchError(null);
    try {
      await restoreArchive(openArch);
      setOpenArch(null);
    } catch (err: any) {
      setArchError(err?.message ?? 'The restore failed. Nothing was changed.');
    } finally {
      setArchBusy(false);
    }
  };

  const doPurge = async () => {
    if (!openArch) return;
    setArchBusy(true); setArchError(null);
    try {
      await purgeArchive(openArch);
      setOpenArch(null);
    } catch (err: any) {
      setArchError(err?.message ?? 'The permanent delete failed. Try again.');
    } finally {
      setArchBusy(false);
    }
  };

  const runAction = async () => {
    if (!action?.slot.member) return;
    const { kind, slot } = action;
    const m = slot.member!;
    const needsCipher = kind === 'recover' || kind === 'transfer';
    if (needsCipher && cipher.trim().length < 6) {
      setActionError('The new cipher must be at least 6 characters.');
      return;
    }
    if (kind === 'transfer' && confirmId.trim().toLowerCase() !== slot.slotId.toLowerCase()) {
      setActionError(`Type ${slot.slotId} exactly to confirm the permanent wipe.`);
      return;
    }
    setBusy(true); setActionError(null);
    try {
      if (kind === 'suspend')        await setSuspended(m.uid, true);
      else if (kind === 'unsuspend') await setSuspended(m.uid, false);
      else if (kind === 'recover')   await recoverCipher(m.uid, cipher.trim());
      else                           await transferSlot(m.uid, m.jokerId, cipher.trim());
      setAction(null);
      showBanner(
        kind === 'suspend'   ? `${slot.slotId} suspended.` :
        kind === 'unsuspend' ? `${slot.slotId} reinstated.` :
        kind === 'recover'   ? `Cipher reset for ${slot.slotId}.` :
        `${slot.slotId} wiped — clean slot ready for its new member.`,
      );
    } catch (err: any) {
      setActionError(err?.message ?? 'The action failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!user || !isAdmin) return <View style={st.root} />;

  const activeMeta = SECTIONS.find(s => s.id === section)!;

  const renderSlot = ({ item }: { item: RosterSlot }) => {
    const m = item.member;
    const status = !m ? 'UNASSIGNED' : m.suspended ? 'SUSPENDED' : 'ACTIVE';
    const statusColor = !m ? 'rgba(237,224,196,0.30)' : m.suspended ? RED : GOLD;
    return (
      <View style={st.row}>
        <View style={st.rowInfo}>
          <Text style={st.rowJoker}>{item.slotId}</Text>
          <Text style={st.rowStreet} numberOfLines={1}>
            {m ? (m.street || m.name || 'No street name yet') : 'Slot not yet claimed'}
          </Text>
          <Text style={[st.rowStatus, { color: statusColor }]}>{status}</Text>
        </View>
        {m ? (
          <View style={st.rowBtns}>
            <TouchableOpacity
              style={[st.actBtn, m.suspended && st.actBtnActive]}
              onPress={() => openAction(m.suspended ? 'unsuspend' : 'suspend', item)}
              activeOpacity={0.8}
            >
              <Text style={[st.actBtnText, m.suspended && { color: '#0A0A0A' }]}>
                {m.suspended ? 'REINSTATE' : 'SUSPEND'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={st.actBtn} onPress={() => openAction('recover', item)} activeOpacity={0.8}>
              <Text style={st.actBtnText}>RECOVER</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[st.actBtn, st.actBtnDanger]} onPress={() => openAction('transfer', item)} activeOpacity={0.8}>
              <Text style={[st.actBtnText, { color: RED }]}>TRANSFER</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </View>
    );
  };

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
          <Text style={st.navTitle} numberOfLines={1}>Jester's Hand</Text>
          <View style={st.navSide}>
            <WhisperNavIcon size={34} />
            <BellNavIcon size={34} />
          </View>
        </View>
      </View>

      <View style={[st.labelRow, { top: navBottom + 8 }]}>
        <Text style={st.screenLabel}>JESTER'S HAND</Text>
      </View>

      {/* ── Folder ── */}
      <View style={[st.folderWrap, { top: navBottom + 42 }]}>
        <View style={st.tabsRow}>
          {SECTIONS.map(s => {
            const active = s.id === section;
            return (
              <TouchableOpacity
                key={s.id}
                style={[st.tab, active && st.tabActive]}
                onPress={() => setSection(s.id)}
                activeOpacity={0.8}
              >
                <Text style={[st.tabSuit, { color: active ? s.suitColor : 'rgba(237,224,196,0.30)' }]}>
                  {s.suit}
                </Text>
                <Text style={[st.tabText, active && st.tabTextActive]} numberOfLines={1}>
                  {s.label.toUpperCase()}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={st.body}>
          {section === 'hand' ? (
            <>
              {banner ? (
                <View style={st.banner}><Text style={st.bannerText}>{banner}</Text></View>
              ) : null}
              {slots === null ? (
                <View style={st.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
              ) : (
                <FlatList
                  data={slots}
                  keyExtractor={s => s.slotId}
                  renderItem={renderSlot}
                  ListHeaderComponent={<AppKeyQr />}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 8 }}
                  ItemSeparatorComponent={() => <View style={st.rowSep} />}
                />
              )}
            </>
          ) : section === 'reports' ? (
            reports === null ? (
              <View style={st.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
            ) : reports.length === 0 ? (
              <View style={st.centerFill}>
                <Text style={[st.emptySuit, { color: RED }]}>{'\u2665'}</Text>
                <Text style={st.emptyTitle}>REPORTS</Text>
                <Text style={st.emptyText}>{EMPTY_COPY.reports}</Text>
              </View>
            ) : (() => {
              const openList     = reports.filter(r => r.status !== 'resolved');
              const resolvedList = reports.filter(r => r.status === 'resolved');
              const shown = showResolved ? resolvedList : openList;
              return (
                <>
                  <View style={st.filterRow}>
                    <TouchableOpacity
                      style={[st.filterBtn, !showResolved && st.filterBtnActive]}
                      onPress={() => setShowResolved(false)}
                      activeOpacity={0.8}
                    >
                      <Text style={[st.filterBtnText, !showResolved && st.filterBtnTextActive]}>
                        OPEN ({openList.length})
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[st.filterBtn, showResolved && st.filterBtnActive]}
                      onPress={() => setShowResolved(true)}
                      activeOpacity={0.8}
                    >
                      <Text style={[st.filterBtnText, showResolved && st.filterBtnTextActive]}>
                        RESOLVED ({resolvedList.length})
                      </Text>
                    </TouchableOpacity>
                  </View>
                  {shown.length === 0 ? (
                    <View style={st.centerFill}>
                      <Text style={[st.emptySuit, { color: RED }]}>{'\u2665'}</Text>
                      <Text style={st.emptyTitle}>{showResolved ? 'RESOLVED' : 'REPORTS'}</Text>
                      <Text style={st.emptyText}>
                        {showResolved
                          ? 'No resolved cases yet.\nReports you mark resolved will move here.'
                          : 'The queue is clear.\nNew cards will land here as they are filed.'}
                      </Text>
                    </View>
                  ) : (
              <FlatList
                data={shown}
                keyExtractor={r => r.id}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingBottom: 8 }}
                ItemSeparatorComponent={() => <View style={st.rowSep} />}
                renderItem={({ item }) => {
                  const ts = formatReportTimestamp(item.createdAt);
                  return (
                    <TouchableOpacity style={st.reportRow} onPress={() => setOpenReport(item)} activeOpacity={0.75}>
                      <View style={st.reportRowTop}>
                        <Text style={st.reportRowIds}>
                          <Text style={{ color: RED }}>{item.reportedJokerId}</Text>
                          <Text style={st.reportRowBy}>  reported by  </Text>
                          <Text style={{ color: GOLD }}>{item.reporterJokerId}</Text>
                        </Text>
                        <Text style={st.reportRowWhen}>{ts.date} · {ts.time}</Text>
                      </View>
                      <Text style={st.reportRowTitle} numberOfLines={1}>{item.title}</Text>
                      <Text style={st.reportRowMeta}>
                        {item.evidencePaths.length} piece{item.evidencePaths.length === 1 ? '' : 's'} of evidence · Tap to open
                      </Text>
                    </TouchableOpacity>
                  );
                }}
              />
                  )}
                </>
              );
            })()
          ) : section === 'archive' ? (
            <>
              <View style={st.invSearchRow}>
                <TextInput
                  style={st.invSearchInput}
                  placeholder="Search by title or Joker ID"
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={archQuery}
                  onChangeText={setArchQuery}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
              </View>
              {archListError ? (
                <Text style={[st.reportError, { marginBottom: 8 }]}>{archListError}</Text>
              ) : null}
              {filteredArchives === null ? (
                <View style={st.centerFill}><ActivityIndicator size="large" color={GOLD} /></View>
              ) : filteredArchives.length === 0 ? (
                <View style={st.centerFill}>
                  <Text style={[st.emptySuit, { color: activeMeta.suitColor }]}>{activeMeta.suit}</Text>
                  <Text style={st.emptyTitle}>ARCHIVE</Text>
                  <Text style={st.emptyText}>
                    {archQuery.trim()
                      ? 'Nothing in the archive matches that search.'
                      : EMPTY_COPY.archive}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={filteredArchives}
                  keyExtractor={a => a.id}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 8 }}
                  ItemSeparatorComponent={() => <View style={st.rowSep} />}
                  renderItem={({ item }) => {
                    const del = formatArchiveTimestamp(item.deletedAt);
                    return (
                      <TouchableOpacity
                        style={st.reportRow}
                        onPress={() => setOpenArch(item)}
                        activeOpacity={0.75}
                      >
                        <View style={st.reportRowTop}>
                          <Text style={[st.invRowAction, { color: GOLD }]}>
                            {ARCHIVE_TYPE_LABEL[item.type]?.toUpperCase() ?? 'ITEM'}
                            {item.ownerJokerId ? `  ·  ${item.ownerJokerId}` : ''}
                          </Text>
                          <Text style={st.reportRowWhen}>{del.date} · {del.time}</Text>
                        </View>
                        <Text style={st.reportRowTitle} numberOfLines={1}>
                          {item.title || archivePreview(item) || 'Untitled'}
                        </Text>
                        <Text style={st.reportRowMeta}>From {item.section}</Text>
                      </TouchableOpacity>
                    );
                  }}
                />
              )}
            </>
          ) : section === 'activity' ? (
            <>
              {/* Search bar */}
              <View style={st.invSearchRow}>
                <TextInput
                  style={st.invSearchInput}
                  placeholder="Search Joker ID"
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={actQuery}
                  onChangeText={t => { setActQuery(t); setActError(null); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  editable={!actBusy}
                  onSubmitEditing={runActivity}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={st.invSearchBtn}
                  onPress={runActivity}
                  disabled={actBusy}
                  activeOpacity={0.85}
                >
                  {actBusy
                    ? <ActivityIndicator size="small" color="#0A0A0A" />
                    : <Text style={st.invSearchBtnText}>SEARCH</Text>}
                </TouchableOpacity>
              </View>
              {actError ? <Text style={[st.reportError, { marginBottom: 8 }]}>{actError}</Text> : null}

              {actBusy && !actResult ? (
                <View style={st.centerFill}>
                  <ActivityIndicator size="large" color={GOLD} />
                  <Text style={st.emptyText}>Pulling the activity log…</Text>
                </View>
              ) : actResult ? (
                <>
                  {/* Status header */}
                  <View style={st.invStatusBlock}>
                    <Text style={st.invStatusJoker}>{actResult.jokerId}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[
                        st.invStatusLabel,
                        { color: actResult.currentlyActive ? GOLD : 'rgba(237,224,196,0.5)' },
                      ]}>
                        {actResult.currentlyActive ? 'CURRENTLY ACTIVE' : 'CURRENTLY OFFLINE'}
                      </Text>
                      <Text style={st.invStatusDetail}>
                        {actResult.statusSince
                          ? actResult.currentlyActive
                            ? `Logged in for ${formatDuration(Date.now() - actResult.statusSince.getTime())} this session`
                            : `Logged out for ${formatDuration(Date.now() - actResult.statusSince.getTime())}`
                          : 'No sessions recorded yet — history begins with their next login.'}
                      </Text>
                    </View>
                  </View>

                  {actResult.items.length === 0 ? (
                    <View style={st.centerFill}>
                      <Text style={st.emptyText}>No activity on record for {actResult.jokerId}.</Text>
                    </View>
                  ) : (
                    <FlatList
                      data={actResult.items}
                      keyExtractor={it => it.id}
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={{ paddingBottom: 8 }}
                      ItemSeparatorComponent={() => <View style={st.rowSep} />}
                      renderItem={({ item }) => {
                        const isSession = item.kind === 'session_login' || item.kind === 'session_logout';
                        const ts = item.at
                          ? {
                              date: item.at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
                              time: item.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                            }
                          : null;
                        return (
                          <View style={st.invRow}>
                            <View style={st.reportRowTop}>
                              <Text style={[
                                st.invRowAction,
                                isSession && { color: item.kind === 'session_login' ? GOLD : 'rgba(237,224,196,0.55)' },
                              ]}>
                                {item.action.toUpperCase()}
                              </Text>
                              <Text style={st.reportRowWhen}>
                                {ts ? `${ts.date} · ${ts.time}` : 'time not recorded'}
                              </Text>
                            </View>
                            <Text style={st.invRowSection}>{item.section}</Text>
                            {item.durationNote
                              ? <Text style={st.invRowDuration}>{item.durationNote}</Text>
                              : null}
                            {/* Deliberately NO content — Activity is high-level only. */}
                          </View>
                        );
                      }}
                    />
                  )}
                </>
              ) : (
                <View style={st.centerFill}>
                  <Text style={[st.emptySuit, { color: activeMeta.suitColor }]}>{activeMeta.suit}</Text>
                  <Text style={st.emptyTitle}>ACTIVITY</Text>
                  <Text style={st.emptyText}>{EMPTY_COPY.activity}</Text>
                </View>
              )}
            </>
          ) : section === 'investigations' ? (
            <>
              {/* Search bar */}
              <View style={st.invSearchRow}>
                <TextInput
                  style={st.invSearchInput}
                  placeholder="Search Joker ID"
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={invQuery}
                  onChangeText={t => { setInvQuery(t); setInvError(null); }}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                  editable={!invBusy}
                  onSubmitEditing={runInvestigation}
                  returnKeyType="search"
                />
                <TouchableOpacity
                  style={st.invSearchBtn}
                  onPress={runInvestigation}
                  disabled={invBusy}
                  activeOpacity={0.85}
                >
                  {invBusy
                    ? <ActivityIndicator size="small" color="#0A0A0A" />
                    : <Text style={st.invSearchBtnText}>SEARCH</Text>}
                </TouchableOpacity>
              </View>
              {invError ? <Text style={[st.reportError, { marginBottom: 8 }]}>{invError}</Text> : null}

              {invBusy && !invResult ? (
                <View style={st.centerFill}>
                  <ActivityIndicator size="large" color={GOLD} />
                  <Text style={st.emptyText}>Pulling the complete file…</Text>
                </View>
              ) : invResult ? (
                <>
                  {/* Status header */}
                  <View style={st.invStatusBlock}>
                    <Text style={st.invStatusJoker}>{invResult.jokerId}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[
                        st.invStatusLabel,
                        { color: invResult.currentlyActive ? GOLD : 'rgba(237,224,196,0.5)' },
                      ]}>
                        {invResult.currentlyActive ? 'CURRENTLY ACTIVE' : 'CURRENTLY OFFLINE'}
                      </Text>
                      <Text style={st.invStatusDetail}>
                        {invResult.statusSince
                          ? invResult.currentlyActive
                            ? `Logged in for ${formatDuration(Date.now() - invResult.statusSince.getTime())} this session`
                            : `Logged out for ${formatDuration(Date.now() - invResult.statusSince.getTime())}`
                          : 'No sessions recorded yet — history begins with their next login.'}
                      </Text>
                    </View>
                  </View>

                  {invResult.items.length === 0 ? (
                    <View style={st.centerFill}>
                      <Text style={st.emptyText}>No public activity on record for {invResult.jokerId}.</Text>
                    </View>
                  ) : (
                    <FlatList
                      data={invResult.items}
                      keyExtractor={it => it.id}
                      showsVerticalScrollIndicator={false}
                      contentContainerStyle={{ paddingBottom: 8 }}
                      ItemSeparatorComponent={() => <View style={st.rowSep} />}
                      renderItem={({ item }) => {
                        const isSession = item.kind === 'session_login' || item.kind === 'session_logout';
                        const ts = item.at
                          ? {
                              date: item.at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }),
                              time: item.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
                            }
                          : null;
                        return (
                          <TouchableOpacity
                            style={st.invRow}
                            onPress={() => { if (!isSession) setOpenItem(item); }}
                            activeOpacity={isSession ? 1 : 0.75}
                          >
                            <View style={st.reportRowTop}>
                              <Text style={[
                                st.invRowAction,
                                isSession && { color: item.kind === 'session_login' ? GOLD : 'rgba(237,224,196,0.55)' },
                              ]}>
                                {item.action.toUpperCase()}
                              </Text>
                              <Text style={st.reportRowWhen}>
                                {ts ? `${ts.date} · ${ts.time}` : 'time not recorded'}
                              </Text>
                            </View>
                            <Text style={st.invRowSection}>{item.section}</Text>
                            {item.durationNote
                              ? <Text style={st.invRowDuration}>{item.durationNote}</Text>
                              : null}
                            {item.content
                              ? <Text style={st.invRowContent} numberOfLines={2}>{item.content}</Text>
                              : null}
                            {!isSession
                              ? <Text style={st.reportRowMeta}>Tap to open the full entry</Text>
                              : null}
                          </TouchableOpacity>
                        );
                      }}
                    />
                  )}
                </>
              ) : (
                <View style={st.centerFill}>
                  <Text style={[st.emptySuit, { color: activeMeta.suitColor }]}>{activeMeta.suit}</Text>
                  <Text style={st.emptyTitle}>INVESTIGATIONS</Text>
                  <Text style={st.emptyText}>{EMPTY_COPY.investigations}</Text>
                </View>
              )}
            </>
          ) : (
            <View style={st.centerFill}>
              <Text style={[st.emptySuit, { color: activeMeta.suitColor }]}>{activeMeta.suit}</Text>
              <Text style={st.emptyTitle}>{activeMeta.label.toUpperCase()}</Text>
              <Text style={st.emptyText}>{EMPTY_COPY[section]}</Text>
            </View>
          )}
        </View>
      </View>

      {/* ── Action confirmation modal ── */}
      <Modal visible={!!action} transparent animationType="fade" onRequestClose={closeAction}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={st.modalBackdrop}
        >
          {action ? (
            <View style={st.modalCard}>
              <Text style={[st.modalTitle, action.kind === 'transfer' && { color: RED }]}>
                {ACTION_COPY[action.kind].title} — {action.slot.slotId}
              </Text>
              <Text style={st.modalBody}>{ACTION_COPY[action.kind].body}</Text>

              {(action.kind === 'recover' || action.kind === 'transfer') && (
                <TextInput
                  style={st.modalInput}
                  placeholder="New cipher (min 6 characters)"
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={cipher}
                  onChangeText={setCipher}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                />
              )}
              {action.kind === 'transfer' && (
                <TextInput
                  style={st.modalInput}
                  placeholder={`Type ${action.slot.slotId} to confirm`}
                  placeholderTextColor="rgba(237,224,196,0.35)"
                  value={confirmId}
                  onChangeText={setConfirmId}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                />
              )}

              {actionError ? <Text style={st.modalError}>{actionError}</Text> : null}

              <View style={st.modalBtns}>
                <TouchableOpacity style={st.modalBtn} onPress={closeAction} disabled={busy} activeOpacity={0.8}>
                  <Text style={st.modalBtnText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[st.modalBtn, st.modalBtnPrimary, action.kind === 'transfer' && st.modalBtnDanger]}
                  onPress={runAction}
                  disabled={busy}
                  activeOpacity={0.8}
                >
                  {busy
                    ? <ActivityIndicator size="small" color={action.kind === 'transfer' ? RED : '#0A0A0A'} />
                    : (
                      <Text style={[
                        st.modalBtnText,
                        action.kind === 'transfer' ? { color: RED } : { color: '#0A0A0A' },
                      ]}>
                        {ACTION_COPY[action.kind].confirm}
                      </Text>
                    )}
                </TouchableOpacity>
              </View>
            </View>
          ) : <View />}
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Open report modal ── */}
      <Modal
        visible={!!openReport}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!reportBusy) setOpenReport(null); }}
      >
        <View style={st.reportOverlay}>
          {openReport ? (
            <View style={st.reportSheet}>
              <View style={st.reportSheetHeader}>
                <Text style={st.reportSheetTitle} numberOfLines={1}>{openReport.title}</Text>
                <TouchableOpacity
                  onPress={() => { if (!reportBusy) setOpenReport(null); }}
                  activeOpacity={0.8}
                  style={st.reportClose}
                >
                  <Text style={st.reportCloseText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
                {(() => {
                  const ts = formatReportTimestamp(openReport.createdAt);
                  return (
                    <View style={st.reportMetaBlock}>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>REPORTED</Text>
                        <Text style={[st.reportMetaValue, { color: RED }]}>{openReport.reportedJokerId}</Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>FILED BY</Text>
                        <Text style={[st.reportMetaValue, { color: GOLD }]}>{openReport.reporterJokerId}</Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>SUBMITTED</Text>
                        <Text style={st.reportMetaValue}>{ts.date} at {ts.time}</Text>
                      </View>
                      {openReport.date ? (
                        <View style={st.reportMetaRow}>
                          <Text style={st.reportMetaLabel}>INCIDENT</Text>
                          <Text style={st.reportMetaValue}>{openReport.date}</Text>
                        </View>
                      ) : null}
                    </View>
                  );
                })()}

                <Text style={st.reportSectionLabel}>WHAT HAPPENED</Text>
                <Text style={st.reportBody}>{openReport.description}</Text>

                <Text style={st.reportSectionLabel}>
                  EVIDENCE ({openReport.evidencePaths.length})
                </Text>
                {evidence === null ? (
                  <ActivityIndicator color={GOLD} style={{ marginVertical: 20 }} />
                ) : evidenceError ? (
                  <Text style={st.reportError}>The evidence files could not be loaded. Try reopening the report.</Text>
                ) : (
                  evidence.map((url, i) => url ? (
                    <Image
                      key={`${i}-${url}`}
                      source={{ uri: url }}
                      style={st.evidenceImg}
                      resizeMode="contain"
                    />
                  ) : (
                    <Text key={`missing-${i}`} style={st.reportError}>
                      Evidence #{i + 1} could not be loaded.
                    </Text>
                  ))
                )}

                {/* Suspend the reported member while investigating */}
                <View style={st.reportActions}>
                  {reportedMember?.suspended ? (
                    <Text style={st.reportSuspendedNote}>
                      {openReport.reportedJokerId} is currently SUSPENDED.
                    </Text>
                  ) : !suspendArmed ? (
                    <TouchableOpacity
                      style={st.suspendBtn}
                      onPress={() => { setReportError(null); setSuspendArmed(true); }}
                      activeOpacity={0.85}
                    >
                      <Text style={st.suspendBtnText}>SUSPEND {openReport.reportedJokerId}</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <Text style={st.reportBody}>
                        Temporarily locks {openReport.reportedJokerId} out of the app while you
                        investigate. Nothing is deleted or changed — you can reinstate them any
                        time from The Hand.
                      </Text>
                      <View style={st.modalBtns}>
                        <TouchableOpacity
                          style={st.modalBtn}
                          onPress={() => setSuspendArmed(false)}
                          disabled={reportBusy}
                          activeOpacity={0.8}
                        >
                          <Text style={st.modalBtnText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[st.modalBtn, st.modalBtnDanger]}
                          onPress={suspendReported}
                          disabled={reportBusy}
                          activeOpacity={0.8}
                        >
                          {reportBusy
                            ? <ActivityIndicator size="small" color={RED} />
                            : <Text style={[st.modalBtnText, { color: RED }]}>Confirm Suspend</Text>}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                  {reportError ? <Text style={st.reportError}>{reportError}</Text> : null}
                </View>

                {/* Close out the case: resolve (keep) or discard (delete forever) */}
                <View style={st.reportActions}>
                  <TouchableOpacity
                    style={st.resolveBtn}
                    onPress={toggleResolved}
                    disabled={reportBusy}
                    activeOpacity={0.85}
                  >
                    {reportBusy && !discardArmed
                      ? <ActivityIndicator size="small" color={GOLD} />
                      : (
                        <Text style={st.resolveBtnText}>
                          {openReport.status === 'resolved' ? 'REOPEN CASE' : 'MARK RESOLVED'}
                        </Text>
                      )}
                  </TouchableOpacity>

                  {!discardArmed ? (
                    <TouchableOpacity
                      style={st.discardBtn}
                      onPress={() => { setReportError(null); setDiscardArmed(true); }}
                      disabled={reportBusy}
                      activeOpacity={0.85}
                    >
                      <Text style={st.discardBtnText}>DISCARD REPORT</Text>
                    </TouchableOpacity>
                  ) : (
                    <>
                      <Text style={st.reportBody}>
                        PERMANENT. The report and all of its evidence files are deleted
                        forever. This cannot be undone.
                      </Text>
                      <View style={st.modalBtns}>
                        <TouchableOpacity
                          style={st.modalBtn}
                          onPress={() => setDiscardArmed(false)}
                          disabled={reportBusy}
                          activeOpacity={0.8}
                        >
                          <Text style={st.modalBtnText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[st.modalBtn, st.modalBtnDanger]}
                          onPress={discardReport}
                          disabled={reportBusy}
                          activeOpacity={0.8}
                        >
                          {reportBusy
                            ? <ActivityIndicator size="small" color={RED} />
                            : <Text style={[st.modalBtnText, { color: RED }]}>Confirm Discard</Text>}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              </ScrollView>
            </View>
          ) : <View />}
        </View>
      </Modal>

      {/* ── Open archived item ── */}
      <Modal
        visible={!!openArch}
        transparent
        animationType="slide"
        onRequestClose={() => { if (!archBusy) setOpenArch(null); }}
      >
        <View style={st.reportOverlay}>
          {openArch ? (
            <View style={st.reportSheet}>
              <View style={st.reportSheetHeader}>
                <Text style={st.reportSheetTitle} numberOfLines={1}>
                  {openArch.title || ARCHIVE_TYPE_LABEL[openArch.type] || 'Archived item'}
                </Text>
                <TouchableOpacity
                  onPress={() => { if (!archBusy) setOpenArch(null); }}
                  activeOpacity={0.8}
                  style={st.reportClose}
                >
                  <Text style={st.reportCloseText}>✕</Text>
                </TouchableOpacity>
              </View>

              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
                {(() => {
                  const del = formatArchiveTimestamp(openArch.deletedAt);
                  const cre = formatArchiveTimestamp(openArch.createdAtOriginal);
                  return (
                    <View style={st.reportMetaBlock}>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>TYPE</Text>
                        <Text style={st.reportMetaValue}>{ARCHIVE_TYPE_LABEL[openArch.type] ?? openArch.type}</Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>JOKER ID</Text>
                        <Text style={[st.reportMetaValue, { color: GOLD }]}>
                          {openArch.ownerJokerId || 'Unknown'}
                        </Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>FROM</Text>
                        <Text style={st.reportMetaValue}>{openArch.section}</Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>CREATED</Text>
                        <Text style={st.reportMetaValue}>{cre.date}{cre.time ? ` at ${cre.time}` : ''}</Text>
                      </View>
                      <View style={st.reportMetaRow}>
                        <Text style={st.reportMetaLabel}>DELETED</Text>
                        <Text style={[st.reportMetaValue, { color: RED }]}>{del.date} at {del.time}</Text>
                      </View>
                    </View>
                  );
                })()}

                <Text style={st.reportSectionLabel}>DELETED CONTENT</Text>
                {(() => {
                  const p = openArch.payload;
                  const FIELD_LABELS: [string, string][] = [
                    ['title', 'Title'], ['name', 'Name'], ['target', 'Target'],
                    ['text', 'Text'], ['description', 'Description'], ['notes', 'Notes'],
                    ['location', 'Location'], ['date', 'Date'], ['price', 'Price'],
                    ['category', 'Category'], ['tab', 'Tab'], ['mode', 'Mode'],
                    ['status', 'Status'], ['suit', 'Suit'],
                  ];
                  const rows = FIELD_LABELS
                    .filter(([k]) => (typeof p[k] === 'string' && p[k].trim()) || typeof p[k] === 'number')
                    .map(([k, label]) => (
                      <View key={k} style={{ marginBottom: 8 }}>
                        <Text style={st.reportMetaLabel}>{label.toUpperCase()}</Text>
                        <Text style={st.reportBody}>{String(p[k])}</Text>
                      </View>
                    ));
                  return rows.length
                    ? rows
                    : <Text style={st.reportBody}>This item has no text content — see the images or files below.</Text>;
                })()}

                {openArch.comments.length > 0 ? (
                  <>
                    <Text style={st.reportSectionLabel}>COMMENTS ({openArch.comments.length})</Text>
                    {openArch.comments.map(c => (
                      <Text key={c.id} style={st.reportBody}>• {String(c.fields?.text ?? '')}</Text>
                    ))}
                  </>
                ) : null}

                {openArch.storagePaths.length > 0 ? (
                  <>
                    <Text style={st.reportSectionLabel}>
                      FILES ({openArch.storagePaths.length})
                    </Text>
                    {archImages === null ? (
                      <ActivityIndicator color={GOLD} style={{ marginVertical: 20 }} />
                    ) : (
                      archImages.map((uri, i) => uri ? (
                        <Image key={i} source={{ uri }} style={st.evidenceImg} resizeMode="contain" />
                      ) : (
                        <Text key={i} style={st.reportRowMeta}>
                          File #{i + 1} is kept in storage but can't be previewed here.
                        </Text>
                      ))
                    )}
                  </>
                ) : null}

                {/* Actions — vault archives are keeper-only: restoring or
                    purging them is Vault/Chamber curation, which the second
                    Hand does not hold. */}
                <View style={st.reportActions}>
                  {openArch.type === 'vault_entry' && !isVaultKeeper ? (
                    <Text style={st.reportBody}>
                      Only the Jester can restore or permanently delete archived Vault documents.
                    </Text>
                  ) : !purgeArmed ? (
                    <>
                      <TouchableOpacity
                        style={[st.modalBtn, st.modalBtnPrimary, { height: 46 }]}
                        onPress={doRestore}
                        disabled={archBusy}
                        activeOpacity={0.85}
                      >
                        {archBusy
                          ? <ActivityIndicator size="small" color="#0A0A0A" />
                          : <Text style={[st.modalBtnText, { color: '#0A0A0A' }]}>RESTORE</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={st.suspendBtn}
                        onPress={() => { setArchError(null); setPurgeArmed(true); }}
                        disabled={archBusy}
                        activeOpacity={0.85}
                      >
                        <Text style={st.suspendBtnText}>PERMANENTLY DELETE</Text>
                      </TouchableOpacity>
                    </>
                  ) : (
                    <>
                      <Text style={st.reportBody}>
                        Permanently delete this archived item? This action cannot be undone.
                      </Text>
                      <View style={st.modalBtns}>
                        <TouchableOpacity
                          style={st.modalBtn}
                          onPress={() => setPurgeArmed(false)}
                          disabled={archBusy}
                          activeOpacity={0.8}
                        >
                          <Text style={st.modalBtnText}>Cancel</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={[st.modalBtn, st.modalBtnDanger]}
                          onPress={doPurge}
                          disabled={archBusy}
                          activeOpacity={0.8}
                        >
                          {archBusy
                            ? <ActivityIndicator size="small" color={RED} />
                            : <Text style={[st.modalBtnText, { color: RED }]}>Permanently Delete</Text>}
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                  {archError ? <Text style={st.reportError}>{archError}</Text> : null}
                </View>
              </ScrollView>
            </View>
          ) : <View />}
        </View>
      </Modal>

      {/* ── Open activity entry (Investigations, read-only) ── */}
      <Modal
        visible={!!openItem}
        transparent
        animationType="slide"
        onRequestClose={() => setOpenItem(null)}
      >
        <View style={st.reportOverlay}>
          {openItem ? (
            <View style={st.reportSheet}>
              <View style={st.reportSheetHeader}>
                <Text style={st.reportSheetTitle} numberOfLines={1}>{openItem.section}</Text>
                <TouchableOpacity
                  onPress={() => setOpenItem(null)}
                  activeOpacity={0.8}
                  style={st.reportClose}
                >
                  <Text style={st.reportCloseText}>✕</Text>
                </TouchableOpacity>
              </View>
              <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 24 }}>
                <View style={st.reportMetaBlock}>
                  <View style={st.reportMetaRow}>
                    <Text style={st.reportMetaLabel}>JOKER ID</Text>
                    <Text style={[st.reportMetaValue, { color: GOLD }]}>{invResult?.jokerId}</Text>
                  </View>
                  <View style={st.reportMetaRow}>
                    <Text style={st.reportMetaLabel}>ACTION</Text>
                    <Text style={st.reportMetaValue}>{openItem.action}</Text>
                  </View>
                  <View style={st.reportMetaRow}>
                    <Text style={st.reportMetaLabel}>WHEN</Text>
                    <Text style={st.reportMetaValue}>
                      {openItem.at
                        ? `${openItem.at.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} at ${openItem.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                        : 'Time not recorded for reactions'}
                    </Text>
                  </View>
                </View>
                <Text style={st.reportSectionLabel}>COMPLETE CONTENT</Text>
                <Text style={st.reportBody}>{openItem.content || '—'}</Text>
                <Text style={st.invReadOnlyNote}>
                  Investigation is read-only. Nothing can be edited from here.
                </Text>
              </ScrollView>
            </View>
          ) : <View />}
        </View>
      </Modal>
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  nav:      { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: '#000', zIndex: 20, justifyContent: 'flex-end' },
  navRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingBottom: 8 },
  navTitle: { ...MARBLE_TEXT_SHADOW, flex: 1, textAlign: 'center', color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
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
  tabsRow: { flexDirection: 'row', gap: 4 },
  tab: {
    flex: 1, height: TAB_H,
    backgroundColor: '#080808',
    borderTopLeftRadius: 10, borderTopRightRadius: 10,
    borderWidth: 1, borderBottomWidth: 0,
    borderColor: 'rgba(200,165,60,0.18)',
    justifyContent: 'center', alignItems: 'center', paddingHorizontal: 2,
  },
  tabActive: { backgroundColor: '#0D0D0D', borderColor: 'rgba(200,165,60,0.4)' },
  tabSuit: { fontSize: 13, lineHeight: 15, marginBottom: 1 },
  tabText: {
    ...MARBLE_TEXT_SHADOW,
    color: 'rgba(237,224,196,0.35)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 7.5, letterSpacing: 0.6, textAlign: 'center',
  },
  tabTextActive: { color: CREAM },

  body: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    borderBottomLeftRadius: 10, borderBottomRightRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    padding: SIDE,
  },

  centerFill: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  emptySuit:  { fontSize: 34 },
  emptyTitle: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2 },
  emptyText:  {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_400Regular',
    fontSize: 12.5, lineHeight: 19, textAlign: 'center',
  },

  banner: {
    borderRadius: 8, borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    backgroundColor: 'rgba(212,168,83,0.12)',
    paddingVertical: 8, paddingHorizontal: 12, marginBottom: 10,
  },
  bannerText: { color: GOLD, fontFamily: 'Inter_500Medium', fontSize: 12.5 },

  // ── Roster rows ──
  row: { paddingVertical: 10, gap: 8 },
  rowSep: { height: 1, backgroundColor: 'rgba(200,165,60,0.12)' },
  rowInfo: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowJoker: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 14, letterSpacing: 1,
    width: 62,
  },
  rowStreet: {
    flex: 1, color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 12.5,
  },
  rowStatus: {
    fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 1.2,
  },
  rowBtns: { flexDirection: 'row', gap: 8 },
  actBtn: {
    flex: 1, height: 30, borderRadius: 7, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)', backgroundColor: '#080808',
    alignItems: 'center', justifyContent: 'center',
  },
  actBtnActive: { backgroundColor: GOLD, borderColor: GOLD },
  actBtnDanger: { borderColor: 'rgba(176,58,58,0.6)' },
  actBtnText: {
    color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 9.5, letterSpacing: 1,
  },

  // ── Report rows ──
  reportRow: { paddingVertical: 10, gap: 4 },
  reportRowTop: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8,
  },
  reportRowIds: { fontFamily: 'Cinzel_700Bold', fontSize: 12.5, letterSpacing: 0.5 },
  reportRowBy: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_400Regular', fontSize: 10,
  },
  reportRowWhen: {
    color: 'rgba(237,224,196,0.45)', fontFamily: 'Inter_400Regular', fontSize: 10.5,
  },
  reportRowTitle: { color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 13 },
  reportRowMeta: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_400Regular', fontSize: 10.5,
  },

  // ── Open report sheet ──
  reportOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'flex-end' },
  reportSheet: {
    height: appWindow().height * 0.86,
    backgroundColor: '#0A0A0A',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    borderWidth: 1, borderBottomWidth: 0, borderColor: 'rgba(200,165,60,0.3)',
    padding: 18,
  },
  reportSheetHeader: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12,
  },
  reportSheetTitle: {
    flex: 1, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 1,
  },
  reportClose: {
    width: 32, height: 32, borderRadius: 16, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)', alignItems: 'center', justifyContent: 'center',
  },
  reportCloseText: { color: CREAM, fontSize: 14 },
  reportMetaBlock: {
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    backgroundColor: '#080808', padding: 12, gap: 6, marginBottom: 14,
  },
  reportMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  reportMetaLabel: {
    width: 88, color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 9.5, letterSpacing: 1.2,
  },
  reportMetaValue: { color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 12.5 },
  reportSectionLabel: {
    color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11,
    letterSpacing: 2, marginTop: 6, marginBottom: 8,
  },
  reportBody: {
    color: CREAM, fontFamily: 'Inter_400Regular', fontSize: 13, lineHeight: 20,
    marginBottom: 14,
  },
  evidenceImg: {
    width: '100%', height: 300, borderRadius: 10, marginBottom: 12,
    backgroundColor: '#050505',
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.18)',
  },
  reportActions: { marginTop: 10, gap: 10 },
  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  filterBtn: {
    flex: 1, height: 32, borderRadius: 7, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.25)', backgroundColor: '#080808',
    alignItems: 'center', justifyContent: 'center',
  },
  filterBtnActive: { borderColor: GOLD, backgroundColor: 'rgba(212,168,83,0.12)' },
  filterBtnText: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Cinzel_600SemiBold',
    fontSize: 10, letterSpacing: 1.2,
  },
  filterBtnTextActive: { color: GOLD },
  resolveBtn: {
    height: 46, borderRadius: 8, borderWidth: 1.5, borderColor: GOLD,
    backgroundColor: 'rgba(212,168,83,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  resolveBtnText: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2,
  },
  discardBtn: {
    height: 46, borderRadius: 8, borderWidth: 1.5, borderColor: RED,
    backgroundColor: 'rgba(176,58,58,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  discardBtnText: {
    color: RED, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2,
  },
  suspendBtn: {
    height: 46, borderRadius: 8, borderWidth: 1.5, borderColor: RED,
    backgroundColor: 'rgba(176,58,58,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  suspendBtnText: {
    color: RED, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2,
  },
  reportSuspendedNote: {
    color: RED, fontFamily: 'Cinzel_600SemiBold', fontSize: 11.5,
    letterSpacing: 1, textAlign: 'center', paddingVertical: 8,
  },
  reportError: { color: RED, fontFamily: 'Inter_500Medium', fontSize: 12 },

  // ── Investigations ──
  invSearchRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
  invSearchInput: {
    flex: 1, height: 42, borderRadius: 8, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.35)', backgroundColor: '#080808',
    color: CREAM, paddingHorizontal: 12, fontFamily: 'Inter_400Regular', fontSize: 13,
    letterSpacing: 1,
  },
  invSearchBtn: {
    height: 42, paddingHorizontal: 16, borderRadius: 8,
    backgroundColor: GOLD, alignItems: 'center', justifyContent: 'center',
  },
  invSearchBtnText: {
    color: '#0A0A0A', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1.5,
  },
  invStatusBlock: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(200,165,60,0.22)',
    backgroundColor: '#080808', padding: 12, marginBottom: 10,
  },
  invStatusJoker: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 17, letterSpacing: 1,
  },
  invStatusLabel: {
    fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1.5,
  },
  invStatusDetail: {
    color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_400Regular',
    fontSize: 11, marginTop: 2,
  },
  invRow: { paddingVertical: 10, gap: 3 },
  invRowAction: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 1,
  },
  invRowSection: {
    color: GOLD, fontFamily: 'Inter_500Medium', fontSize: 11,
  },
  invRowDuration: {
    color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_400Regular', fontSize: 11.5,
  },
  invRowContent: {
    color: CREAM, fontFamily: 'Inter_400Regular', fontSize: 12.5, lineHeight: 18,
  },
  invReadOnlyNote: {
    color: 'rgba(237,224,196,0.4)', fontFamily: 'Inter_400Regular',
    fontSize: 11, textAlign: 'center', marginTop: 8,
  },

  // ── Modal ──
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.82)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  modalCard: {
    width: '100%', maxWidth: 420, borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.35)', backgroundColor: '#0A0A0A',
    padding: 18, gap: 12,
  },
  modalTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 1.5,
    textAlign: 'center',
  },
  modalBody: {
    color: 'rgba(237,224,196,0.75)', fontFamily: 'Inter_400Regular',
    fontSize: 12.5, lineHeight: 19,
  },
  modalInput: {
    height: 44, borderRadius: 8, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.35)', backgroundColor: '#080808',
    color: CREAM, paddingHorizontal: 12, fontFamily: 'Inter_400Regular', fontSize: 13,
  },
  modalError: { color: RED, fontFamily: 'Inter_500Medium', fontSize: 12 },
  modalBtns: { flexDirection: 'row', gap: 10, marginTop: 2 },
  modalBtn: {
    flex: 1, height: 42, borderRadius: 8, borderWidth: 1,
    borderColor: 'rgba(200,165,60,0.4)', backgroundColor: '#080808',
    alignItems: 'center', justifyContent: 'center',
  },
  modalBtnPrimary: { backgroundColor: GOLD, borderColor: GOLD },
  modalBtnDanger: { backgroundColor: 'rgba(176,58,58,0.12)', borderColor: RED },
  modalBtnText: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1 },
});
