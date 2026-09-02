/**
 * The Contract — welcome page & signed agreement of The Hand.
 *
 * Modes:
 *   • Sign mode (member with no signature, or one older than the current
 *     wording): the full rules scroll, then an acknowledgement form — Joker
 *     ID, name, date (typed) and a finger-drawn signature. Filing it writes
 *     the agreements doc (first sign or re-sign at the newer version) and
 *     unlocks the app. A record of the signing lands in the Jester's
 *     archives.
 *   • View mode (member signed & current): read-only acknowledgement exactly
 *     as signed. Reached from The System.
 *   • Jester mode (00-00): never signs. Reads the contract, and can amend
 *     it — publishing bumps the version, notifies every member, and gates
 *     them to re-sign.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Platform, Image, ActivityIndicator, TextInput, Alert, Dimensions,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { useAuth } from '@/contexts/AuthContext';
import {
  ContractDoc, ContractSection, BUNDLED_CONTRACT, listenContract, publishContract,
} from '@/lib/contractService';
import { Agreement, listenAgreements, signAgreement } from '@/lib/agreementService';
import { broadcastToActiveMembers } from '@/lib/notificationService';
import SignaturePad, { SignatureView } from '@/components/SignaturePad';
import PawPrints from '@/components/PawPrints';
import { MARBLE_TEXT_SHADOW, MARBLE_BTN_BACKING } from '@/lib/legibility';
import { appWindow } from '@/lib/appWindow';

const MARBLE = require('../assets/images/wood_bg.png');

const { width: SW } = appWindow();
const SIDE  = 18;
const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const PAD_W = Math.min(SW - SIDE * 2 - 32, 480);
const PAD_H = 180;

function todayString(): string {
  const d = new Date();
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

// ── Editable working copy (Jester's amend mode) ──────────────────────────────
interface DraftSection { title: string; body: string }
const toDraft   = (secs: ContractSection[]): DraftSection[] =>
  secs.map(s => ({ title: s.title, body: s.lines.join('\n\n') }));
const fromDraft = (drafts: DraftSection[]): ContractSection[] =>
  drafts
    .map(d => ({
      title: d.title.trim(),
      lines: d.body.split(/\n{1,}/).map(l => l.trim()).filter(Boolean),
    }))
    .filter(s => s.title.length > 0 && s.lines.length > 0);

export default function ContractScreen() {
  const insets   = useSafeAreaInsets();
  const topInset = Platform.OS === 'web' ? 50 : insets.top;

  const { user, jokerId, isJester, agreement, refreshAgreement, needsContract } = useAuth();

  // Current wording — live subscription so an amendment published while this
  // screen is open updates the text and version before anyone signs.
  const [contract, setContract] = useState<ContractDoc>(BUNDLED_CONTRACT);
  useEffect(() => listenContract(setContract), []);

  // Signed & current → read-only. Signed but outdated → sign again.
  const signed   = !!agreement;
  const viewOnly = isJester || (signed && !needsContract);

  // Auth guard: members only.
  useEffect(() => {
    if (user === null) router.replace('/');
  }, [user]);

  // ── Form state (sign mode) ────────────────────────────────────────────────
  const [formJokerId, setFormJokerId] = useState('');
  const [formName,    setFormName]    = useState('');
  const [formDate,    setFormDate]    = useState(todayString());
  const [sigPaths,    setSigPaths]    = useState<string[]>([]);
  const [drawing,     setDrawing]     = useState(false);
  const [filing,      setFiling]      = useState(false);
  const [errMsg,      setErrMsg]      = useState<string | null>(null);

  // Prefill from the previous signature when re-signing.
  useEffect(() => {
    if (agreement && !viewOnly) {
      setFormJokerId(prev => prev || agreement.jokerId || jokerId || '');
      setFormName(prev => prev || agreement.name);
      setFormDate(todayString());
      setSigPaths([]);
    }
  }, [agreement, viewOnly, jokerId]);

  const effectiveJokerId = formJokerId || jokerId || '';

  const canSign = useMemo(() =>
    effectiveJokerId.trim().length > 0 &&
    formName.trim().length > 0 &&
    formDate.trim().length > 0 &&
    sigPaths.length > 0,
  [effectiveJokerId, formName, formDate, sigPaths]);

  const file = useCallback(async () => {
    if (!user || filing) return;
    setErrMsg(null);
    if (!canSign) {
      setErrMsg('Fill in your Joker ID, name, and date — and sign with your finger.');
      return;
    }
    setFiling(true);
    try {
      await signAgreement(user.uid, {
        jokerId:        effectiveJokerId.trim(),
        name:           formName.trim(),
        signedDate:     formDate.trim(),
        signaturePaths: sigPaths,
        sigWidth:       PAD_W,
        sigHeight:      PAD_H,
      }, contract.version);
      await refreshAgreement();
      router.replace('/(tabs)/home');
    } catch (error: any) {
      const permissionDenied = error?.code === 'permission-denied';
      setErrMsg(permissionDenied
        ? 'The contract changed while you were signing. Review the latest wording, redraw your signature, and try once more.'
        : 'Could not file your signature. Check your connection and try again.');
    } finally {
      setFiling(false);
    }
  }, [user, filing, canSign, effectiveJokerId, formName, formDate, sigPaths, refreshAgreement, contract.version]);

  // ── Jester amend mode ─────────────────────────────────────────────────────
  const [editing,    setEditing]    = useState(false);
  const [draftHead,  setDraftHead]  = useState('');
  const [drafts,     setDrafts]     = useState<DraftSection[]>([]);
  const [publishing, setPublishing] = useState(false);

  const startEdit = useCallback(() => {
    if (!isJester) return;
    setDraftHead(contract.heading);
    setDrafts(toDraft(contract.sections));
    setEditing(true);
  }, [contract, isJester]);

  const publish = useCallback(() => {
    const sections = fromDraft(drafts);
    if (!draftHead.trim() || sections.length === 0) {
      Alert.alert('Not so fast', 'The contract needs a heading and at least one section.');
      return;
    }
    Alert.alert(
      'Amend the Contract?',
      'Every member will be notified and must review and re-sign before they can use the app again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Amend & Notify',
          style: 'destructive',
          onPress: () => { void doPublish(sections); },
        },
      ],
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, draftHead, contract.version]);

  const doPublish = useCallback(async (sections: ContractSection[]) => {
    if (!user || !isJester || publishing) return;
    setPublishing(true);
    try {
      const newVersion = await publishContract(
        {
          heading:         draftHead.trim(),
          sections,
          acknowledgement: contract.acknowledgement,
        },
        contract.version,
      );
      setContract(c => ({ ...c, version: newVersion, heading: draftHead.trim(), sections }));
      setEditing(false);
      // Tell every member the rules changed without holding the saved screen open.
      void broadcastToActiveMembers(user.uid, {
          type: 'contract_update',
          fromUid: user.uid,
          text: 'Your blood is dry.',
        }).catch(() => { /* notification fan-out is best-effort */ });
      Alert.alert('Amended', `The contract is now version ${newVersion}. Members will re-sign on their next visit.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      Alert.alert(
        'Failed',
        message === 'contract changed'
          ? 'The contract changed while you were editing. Reopen it and try again.'
          : message || 'Could not publish the amendment. Try again.',
      );
    } finally {
      setPublishing(false);
    }
  }, [user, isJester, publishing, draftHead, contract.acknowledgement, contract.version]);

  // ── Jester: signings ledger (who signed, with the actual signature) ──────
  const [signings, setSignings]         = useState<Agreement[] | null>(null);
  const [signingsErr, setSigningsErr]   = useState(false);
  const [openSigning, setOpenSigning]   = useState<string | null>(null);
  useEffect(() => {
    if (!isJester) return;
    return listenAgreements(
      list => { setSignings(list); setSigningsErr(false); },
      ()   => setSigningsErr(true),
    );
  }, [isJester]);

  const backTarget = () =>
    (router.canGoBack() ? router.back() : router.replace('/(tabs)/system'));

  return (
    <View style={s.root}>
      <Image source={MARBLE} style={StyleSheet.absoluteFill} resizeMode="cover" />
      {/* Dark scrim so the contract text stays readable over the marble */}
      <View style={s.scrim} pointerEvents="none" />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingTop: topInset + 18, paddingHorizontal: SIDE, paddingBottom: 60 }}
        showsVerticalScrollIndicator={false}
        scrollEnabled={!drawing}
        keyboardShouldPersistTaps="handled"
      >
        {/* Back button — anyone not being gated can leave */}
        {viewOnly && (
          <TouchableOpacity onPress={backTarget} style={s.backBtn} activeOpacity={0.75}>
            <Feather name="chevron-left" size={18} color={GOLD} />
            <Text style={s.backText}>THE SYSTEM</Text>
          </TouchableOpacity>
        )}

        {editing && isJester ? (
          /* ── Jester: amend mode ── */
          <View>
            <Text style={s.sectionTitle}>HEADING</Text>
            <TextInput
              style={[s.input, s.editHead]}
              value={draftHead}
              onChangeText={setDraftHead}
              multiline
            />
            {drafts.map((d, i) => (
              <View key={i} style={s.editBlock}>
                <Text style={s.sectionTitle}>SECTION {i + 1}</Text>
                <TextInput
                  style={s.input}
                  value={d.title}
                  onChangeText={t => setDrafts(prev => prev.map((p, j) => j === i ? { ...p, title: t } : p))}
                  placeholder="Section title"
                  placeholderTextColor="rgba(237,224,196,0.25)"
                />
                <TextInput
                  style={[s.input, s.editBody]}
                  value={d.body}
                  onChangeText={t => setDrafts(prev => prev.map((p, j) => j === i ? { ...p, body: t } : p))}
                  placeholder="One rule per line"
                  placeholderTextColor="rgba(237,224,196,0.25)"
                  multiline
                />
                <TouchableOpacity
                  onPress={() => setDrafts(prev => prev.filter((_, j) => j !== i))}
                  activeOpacity={0.7}
                  style={s.removeRow}
                >
                  <Feather name="trash-2" size={13} color="rgba(220,60,60,0.85)" />
                  <Text style={s.removeText}>REMOVE SECTION</Text>
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              onPress={() => setDrafts(prev => [...prev, { title: '', body: '' }])}
              activeOpacity={0.8}
              style={s.addBtn}
            >
              <Feather name="plus" size={14} color={GOLD} />
              <Text style={s.addText}>ADD SECTION</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[s.goldBtn, MARBLE_BTN_BACKING, publishing && { opacity: 0.5 }]}
              onPress={publish}
              disabled={publishing}
              activeOpacity={0.8}
            >
              {publishing
                ? <ActivityIndicator size="small" color={GOLD} />
                : <Text style={[s.goldBtnText, MARBLE_TEXT_SHADOW]}>AMEND & NOTIFY THE HAND</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(false)} activeOpacity={0.7} style={s.cancelRow}>
              <Text style={s.cancelText}>CANCEL — KEEP THE CURRENT WORDING</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View>
            <Text style={s.heading}>
              {/* The 🐾 renders in the device's emoji color (often blue-gray),
                  but The Hand's paws are brown — swap in our own drawing. */}
              {contract.heading.split('🐾').map((part, i, arr) => (
                <React.Fragment key={i}>
                  {part}
                  {i < arr.length - 1 && <PawPrints size={22} />}
                </React.Fragment>
              ))}
            </Text>

            {isJester && (
              <View style={s.jesterRow}>
                <Text style={s.jesterNote}>Version {contract.version} — the Jester signs nothing.</Text>
                <TouchableOpacity onPress={startEdit} activeOpacity={0.75} style={s.amendBtn}>
                  <Feather name="edit-3" size={13} color={GOLD} />
                  <Text style={s.amendText}>AMEND</Text>
                </TouchableOpacity>
              </View>
            )}

            {signed && !isJester && needsContract && (
              <View style={s.updateBanner}>
                <Feather name="alert-triangle" size={14} color="#FFD700" />
                <Text style={s.updateText}>
                  The contract has been amended since you signed. Read it over and sign again below.
                </Text>
              </View>
            )}
            {signed && viewOnly && !isJester && (
              <View style={s.sealedBadge}>
                <Feather name="check-circle" size={13} color="#FFD700" />
                <Text style={s.sealedText}>SIGNED & SEALED — {agreement!.signedDate}</Text>
              </View>
            )}

            {signed && needsContract && contract.previous && (
              <View style={s.previousWording}>
                <Text style={s.previousLabel}>YOUR PREVIOUSLY SIGNED WORDING · v{contract.previous.version}</Text>
                <Text style={s.previousHeading}>{contract.previous.heading}</Text>
                {contract.previous.sections.map(sec => (
                  <View key={`old-${sec.title}`} style={s.previousSection}>
                    <Text style={s.previousTitle}>{sec.title}</Text>
                    {sec.lines.map((line, i) => <Text key={i} style={s.previousLine}>{line}</Text>)}
                  </View>
                ))}
                <Text style={s.currentLabel}>AMENDED WORDING · v{contract.version}</Text>
              </View>
            )}
            {contract.sections.map(sec => (
              <View key={sec.title} style={s.section}>
                <View style={s.sectionHead}>
                  <Text style={s.sectionTitle}>{sec.title}</Text>
                  <View style={s.sectionLine} />
                </View>
                {sec.lines.map((line, i) => (
                  <Text key={i} style={s.line}>{line}</Text>
                ))}
              </View>
            ))}

            {isJester && (
              <>
                {/* ── Jester: the signings ledger ── */}
                <View style={s.sectionHead}>
                  <Text style={s.sectionTitle}>
                    SIGNATURES OF THE HAND{signings ? ` · ${signings.length}` : ''}
                  </Text>
                  <View style={s.sectionLine} />
                </View>
                {signingsErr && (
                  <Text style={s.line}>Could not load the signings. Reopen this page to retry.</Text>
                )}
                {signings !== null && signings.length === 0 && !signingsErr && (
                  <Text style={s.line}>No member has signed yet.</Text>
                )}
                {(signings ?? []).map(a => {
                  const open     = openSigning === a.uid;
                  const outdated = a.version < contract.version;
                  return (
                    <View key={a.uid} style={s.panel}>
                      <TouchableOpacity
                        onPress={() => setOpenSigning(open ? null : a.uid)}
                        activeOpacity={0.75}
                        style={s.rowBetween}
                      >
                        <Text style={s.viewValue}>
                          {a.jokerId || '——'} · {a.name || 'Unnamed'}
                        </Text>
                        <Text style={[s.fieldLabel, outdated && { color: '#D08080' }]}>
                          v{a.version}{outdated ? ' — OUTDATED' : ''}  {open ? '▾' : '▸'}
                        </Text>
                      </TouchableOpacity>
                      {open && (
                        <>
                          <View style={s.hairline} />
                          <View style={s.rowBetween}>
                            <Text style={s.fieldLabel}>DATE SIGNED</Text>
                            <Text style={s.viewValue}>{a.signedDate || '——'}</Text>
                          </View>
                          <View style={s.hairline} />
                          <Text style={[s.fieldLabel, { marginTop: 10 }]}>SIGNATURE</Text>
                          <View style={s.sigViewBox}>
                            {a.signaturePaths.length > 0 && a.sigWidth > 0 && a.sigHeight > 0 ? (
                              <SignatureView
                                paths={a.signaturePaths}
                                sourceWidth={a.sigWidth}
                                sourceHeight={a.sigHeight}
                                displayWidth={PAD_W - 24}
                              />
                            ) : (
                              <Text style={s.fieldLabel}>No drawn signature on file.</Text>
                            )}
                          </View>
                        </>
                      )}
                    </View>
                  );
                })}
              </>
            )}

            {!isJester && (
              <>
                {/* ── Acknowledgement ── */}
                <View style={s.sectionHead}>
                  <Text style={s.sectionTitle}>ACKNOWLEDGEMENT</Text>
                  <View style={s.sectionLine} />
                </View>
                <Text style={s.ackText}>{contract.acknowledgement}</Text>

                {viewOnly && agreement ? (
                  /* ── View mode: the signed block, verbatim ── */
                  <View style={s.panel}>
                    <View style={s.rowBetween}>
                      <Text style={s.fieldLabel}>JOKER ID</Text>
                      <Text style={s.viewValue}>{agreement.jokerId}</Text>
                    </View>
                    <View style={s.hairline} />
                    <View style={s.rowBetween}>
                      <Text style={s.fieldLabel}>NAME</Text>
                      <Text style={s.viewValue}>{agreement.name}</Text>
                    </View>
                    <View style={s.hairline} />
                    <View style={s.rowBetween}>
                      <Text style={s.fieldLabel}>DATE</Text>
                      <Text style={s.viewValue}>{agreement.signedDate}</Text>
                    </View>
                    <View style={s.hairline} />
                    <Text style={[s.fieldLabel, { marginTop: 10 }]}>SIGNATURE</Text>
                    <View style={s.sigViewBox}>
                      <SignatureView
                        paths={agreement.signaturePaths}
                        sourceWidth={agreement.sigWidth}
                        sourceHeight={agreement.sigHeight}
                        displayWidth={PAD_W - 24}
                      />
                    </View>
                  </View>
                ) : (
                  /* ── Sign mode: the form ── */
                  <View style={s.panel}>
                    {signed ? (
                      <Text style={s.resignNotice}>
                        A newer contract is ready. Review it, then draw a fresh signature below to replace the signature on your previous version.
                      </Text>
                    ) : null}
                    <Text style={s.fieldLabel}>JOKER ID</Text>
                    <TextInput
                      style={s.input}
                      value={effectiveJokerId}
                      onChangeText={setFormJokerId}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="00-00"
                      placeholderTextColor="rgba(237,224,196,0.25)"
                    />
                    <Text style={s.fieldLabel}>NAME</Text>
                    <TextInput
                      style={s.input}
                      value={formName}
                      onChangeText={setFormName}
                      autoCorrect={false}
                      placeholder="Your name"
                      placeholderTextColor="rgba(237,224,196,0.25)"
                    />
                    <Text style={s.fieldLabel}>DATE</Text>
                    <TextInput
                      style={s.input}
                      value={formDate}
                      onChangeText={setFormDate}
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="MM/DD/YYYY"
                      placeholderTextColor="rgba(237,224,196,0.25)"
                    />

                    <View style={s.sigHeadRow}>
                      <Text style={s.fieldLabel}>SIGNATURE — SIGN WITH YOUR FINGER</Text>
                      {sigPaths.length > 0 && (
                        <TouchableOpacity onPress={() => setSigPaths([])} activeOpacity={0.7}>
                          <Text style={s.clearText}>CLEAR</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                    <View style={{ alignItems: 'center' }}>
                      <SignaturePad
                        width={PAD_W}
                        height={PAD_H}
                        paths={sigPaths}
                        onPathsChange={setSigPaths}
                        onDrawingChange={setDrawing}
                      />
                    </View>

                    {errMsg && (
                      <View style={s.msgRow}>
                        <Feather name="alert-circle" size={13} color="#FF6B6B" />
                        <Text style={s.msgText}>{errMsg}</Text>
                      </View>
                    )}

                    <TouchableOpacity
                      style={[s.goldBtn, (!canSign || filing) && { opacity: 0.5 }]}
                      onPress={() => void file()}
                      disabled={!canSign || filing}
                      activeOpacity={0.8}
                    >
                      {filing
                        ? <ActivityIndicator size="small" color={GOLD} />
                        : <Text style={s.goldBtnText}>
                            {signed ? 'SIGN IN BLOOD' : 'SUBMIT'}
                          </Text>}
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  root:  { flex: 1, backgroundColor: '#000' },
  resignNotice: {
    color: '#EDE0C4',
    fontFamily: 'Cinzel_400Regular',
    fontSize: 11,
    lineHeight: 17,
    marginBottom: 14,
    padding: 10,
    borderWidth: 1,
    borderColor: 'rgba(212,168,83,0.45)',
    borderRadius: 7,
    backgroundColor: 'rgba(212,168,83,0.08)',
  },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.72)' },

  backBtn:  { ...MARBLE_BTN_BACKING, flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 14 },
  backText: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 11, letterSpacing: 2 },

  heading: { ...MARBLE_TEXT_SHADOW, color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 19,
             letterSpacing: 1.5, textAlign: 'center', marginBottom: 12, lineHeight: 28 },

  jesterRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 10 },
  jesterNote: { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.6)', fontFamily: 'Inter_400Regular', fontSize: 12 },
  amendBtn:   { ...MARBLE_BTN_BACKING, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12,
                paddingVertical: 7, borderRadius: 8, borderWidth: 1,
                borderColor: 'rgba(200,165,60,0.45)', backgroundColor: 'rgba(200,165,60,0.1)' },
  amendText:  { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 2 },

  updateBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12,
                  borderRadius: 8, borderWidth: 1, borderColor: 'rgba(255,215,0,0.4)',
                  backgroundColor: 'rgba(255,215,0,0.07)', marginBottom: 10 },
  updateText:   { ...MARBLE_TEXT_SHADOW, flex: 1, color: '#FFD700', fontFamily: 'Inter_500Medium', fontSize: 12,
                  lineHeight: 17 },
  previousWording: { marginTop: 8, padding: 12, borderRadius: 8, borderWidth: 1, borderColor: 'rgba(237,224,196,0.22)', backgroundColor: 'rgba(0,0,0,0.32)' },
  previousLabel: { color: 'rgba(237,224,196,0.58)', fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 1.4, marginBottom: 8 },
  previousHeading: { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.72)', fontFamily: 'Cinzel_600SemiBold', fontSize: 13, marginBottom: 8 },
  previousSection: { marginBottom: 7 },
  previousTitle: { color: 'rgba(212,168,83,0.72)', fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.4, marginBottom: 3 },
  previousLine: { color: 'rgba(237,224,196,0.58)', fontFamily: 'Inter_400Regular', fontSize: 11, lineHeight: 16, marginBottom: 3 },
  currentLabel: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1.8, marginTop: 4 },

  sealedBadge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
                 gap: 6, marginBottom: 8 },
  sealedText:  { ...MARBLE_TEXT_SHADOW, color: '#FFD700', fontFamily: 'Cinzel_600SemiBold', fontSize: 10, letterSpacing: 2 },

  section: { marginTop: 6 },
  sectionHead:  { flexDirection: 'row', alignItems: 'center', gap: 10,
                  marginTop: 20, marginBottom: 10 },
  sectionTitle: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 3 },
  sectionLine:  { flex: 1, height: 1, backgroundColor: 'rgba(200,165,60,0.25)' },

  line: { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.85)', fontFamily: 'Inter_400Regular',
          fontSize: 13, lineHeight: 20, marginBottom: 10 },

  ackText: { ...MARBLE_TEXT_SHADOW, color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 13,
             lineHeight: 20, marginBottom: 14 },

  panel: {
    backgroundColor: 'rgba(5,5,5,0.85)', borderRadius: 10,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)',
    padding: 16, marginTop: 4,
  },
  fieldLabel: { color: CREAM, fontFamily: 'Cinzel_700Bold', fontSize: 10,
                letterSpacing: 2, marginBottom: 8, marginTop: 6, opacity: 0.8 },
  input: { width: '100%', minHeight: 48, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8,
           borderWidth: 1, borderColor: 'rgba(237,224,196,0.18)', color: CREAM,
           fontFamily: 'Inter_400Regular', fontSize: 14, paddingHorizontal: 14,
           paddingVertical: 12, marginBottom: 8 },

  editHead:  { marginTop: 8, marginBottom: 16 },
  editBlock: { marginBottom: 18 },
  editBody:  { minHeight: 140, textAlignVertical: 'top' },
  removeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-end' },
  removeText:{ ...MARBLE_TEXT_SHADOW, color: 'rgba(220,60,60,0.85)', fontFamily: 'Cinzel_600SemiBold',
               fontSize: 9, letterSpacing: 2 },
  addBtn:  { ...MARBLE_BTN_BACKING, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
             paddingVertical: 12, borderRadius: 8, borderWidth: 1, borderStyle: 'dashed',
             borderColor: 'rgba(200,165,60,0.4)', marginBottom: 18 },
  addText: { ...MARBLE_TEXT_SHADOW, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 2 },
  cancelRow:  { alignItems: 'center', paddingVertical: 16 },
  cancelText: { ...MARBLE_TEXT_SHADOW, color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_600SemiBold',
                fontSize: 10, letterSpacing: 2 },

  sigHeadRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                marginTop: 4 },
  clearText:  { color: 'rgba(237,224,196,0.6)', fontFamily: 'Cinzel_600SemiBold',
                fontSize: 10, letterSpacing: 2 },

  msgRow:  { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12 },
  msgText: { color: '#FF6B6B', fontFamily: 'Inter_500Medium', fontSize: 12, flex: 1 },

  goldBtn: { height: 52, borderRadius: 10, marginTop: 16,
             backgroundColor: 'rgba(200,165,60,0.1)',
             borderWidth: 1, borderColor: 'rgba(200,165,60,0.45)',
             alignItems: 'center', justifyContent: 'center' },
  goldBtnText: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 12, letterSpacing: 2 },

  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                paddingVertical: 4 },
  viewValue:  { color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 14 },
  hairline:   { height: 1, backgroundColor: 'rgba(200,165,60,0.14)', marginVertical: 6 },
  sigViewBox: { backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, borderWidth: 1,
                borderColor: 'rgba(200,165,60,0.35)', padding: 12, alignItems: 'center' },
});
