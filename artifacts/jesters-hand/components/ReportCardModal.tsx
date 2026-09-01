// The Card — file a report against the Joker you are whispering with.
// Same framed-card presentation as Place/Raise the Ante, different fields:
// Title, Date, Description, and multi-photo evidence upload (required).

import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, Image,
  ScrollView, KeyboardAvoidingView, Platform, Dimensions, ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import { submitReport, MAX_EVIDENCE } from '@/lib/reportService';
import { appWindow } from '@/lib/appWindow';

const CARD_FRAME = require('../assets/images/ante_card_frame.png');

const { width: SW, height: SH } = appWindow();
const CARD_RATIO = 1536 / 1024;
const CARD_MAX_H = SH - 90;
const CARD_W = Math.min(SW - 24, Math.round(CARD_MAX_H / CARD_RATIO));
const CARD_H = Math.round(CARD_W * CARD_RATIO);
const CARD_SIDE = Math.round(CARD_W * 0.098);
const CARD_TOP  = Math.round(CARD_H * 0.105);
const CARD_BOT  = Math.round(CARD_H * 0.150);

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const RED   = '#B03A3A';

interface Props {
  visible: boolean;
  onClose: () => void;
  reportedUid: string;      // the whisper partner being reported
  reportedLabel: string;    // display name / joker id for the header
}

export default function ReportCardModal({ visible, onClose, reportedUid, reportedLabel }: Props) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => {
    setTitle(''); setDate(''); setDescription('');
    setPhotos([]); setError(null); setDone(false);
  };
  const close = () => { if (!busy) { reset(); onClose(); } };

  const pickPhotos = async () => {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      selectionLimit: MAX_EVIDENCE - photos.length,
      quality: 0.85,
    });
    if (res.canceled) return;
    const uris = res.assets.map(a => a.uri);
    setPhotos(prev => [...prev, ...uris].slice(0, MAX_EVIDENCE));
  };

  const removePhoto = (uri: string) =>
    setPhotos(prev => prev.filter(p => p !== uri));

  const canSubmit =
    title.trim().length > 0 && description.trim().length > 0 &&
    photos.length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      await submitReport({
        reportedUid,
        title, date, description,
        photoUris: photos,
      });
      setDone(true);
    } catch (e: any) {
      setError(e?.message ?? 'The card could not be filed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={s.overlay}
      >
        <View style={{ width: CARD_W, height: CARD_H }}>
          <Image source={CARD_FRAME} style={{ width: CARD_W, height: CARD_H }} resizeMode="stretch" />

          <ScrollView
            style={{ position: 'absolute', top: CARD_TOP, bottom: CARD_BOT, left: CARD_SIDE, right: CARD_SIDE }}
            contentContainerStyle={s.inner}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          >
            {done ? (
              <View style={s.doneWrap}>
                <Text style={s.doneTitle}>CARD FILED</Text>
                <Text style={s.doneBody}>
                  Your report on {reportedLabel} has been delivered to the Jester.
                  Only the Jester can see it.
                </Text>
                <TouchableOpacity style={s.btn} onPress={close} activeOpacity={0.85}>
                  <Text style={s.btnText}>Done</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <>
                <Text style={s.headline}>THE CARD</Text>
                <Text style={s.subline}>Report on {reportedLabel} — goes only to the Jester</Text>

                <Text style={s.label}>Title</Text>
                <TextInput
                  style={s.titleInput}
                  placeholder="Title"
                  placeholderTextColor="rgba(237,224,196,0.4)"
                  value={title}
                  onChangeText={setTitle}
                  maxLength={200}
                />

                <Text style={s.label}>Date</Text>
                <TextInput
                  style={s.titleInput}
                  placeholder="When it happened"
                  placeholderTextColor="rgba(237,224,196,0.4)"
                  value={date}
                  onChangeText={setDate}
                  maxLength={100}
                />

                <Text style={s.label}>Description</Text>
                <TextInput
                  style={s.descInput}
                  placeholder="What happened"
                  placeholderTextColor="rgba(237,224,196,0.4)"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  textAlignVertical="top"
                  maxLength={5000}
                />

                <Text style={s.label}>Upload Evidence Here</Text>
                <Text style={s.evidenceHint}>
                  Required — screenshots or photos. You can add up to {MAX_EVIDENCE}.
                </Text>

                {photos.length > 0 && (
                  <View style={s.thumbRow}>
                    {photos.map(uri => (
                      <View key={uri} style={s.thumbWrap}>
                        <Image source={{ uri }} style={s.thumb} />
                        <TouchableOpacity
                          style={s.thumbX}
                          onPress={() => removePhoto(uri)}
                          activeOpacity={0.8}
                        >
                          <Feather name="x" size={12} color={CREAM} />
                        </TouchableOpacity>
                      </View>
                    ))}
                  </View>
                )}

                {photos.length < MAX_EVIDENCE && (
                  <TouchableOpacity style={s.uploadBtn} onPress={pickPhotos} activeOpacity={0.85}>
                    <Feather name="image" size={15} color={GOLD} />
                    <Text style={s.uploadBtnText}>
                      {photos.length === 0 ? 'Add Evidence' : 'Add More'}
                    </Text>
                  </TouchableOpacity>
                )}

                {error && <Text style={s.error}>{error}</Text>}

                <View style={s.btnRow}>
                  <TouchableOpacity
                    style={[s.btn, s.fileBtn, !canSubmit && s.btnDisabled]}
                    onPress={submit}
                    disabled={!canSubmit}
                    activeOpacity={0.85}
                  >
                    {busy
                      ? <ActivityIndicator color={GOLD} size="small" />
                      : <Text style={[s.btnText, { color: '#E8B4B4' }]}>Pass The Card</Text>}
                  </TouchableOpacity>
                  <TouchableOpacity style={s.btn} onPress={close} activeOpacity={0.85} disabled={busy}>
                    <Text style={s.btnText}>Void</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  inner: { paddingHorizontal: 4, paddingTop: 14, paddingBottom: 16 },
  headline: {
    color: RED, fontFamily: 'Cinzel_700Bold', fontSize: 16,
    letterSpacing: 4, textAlign: 'center', marginTop: 4,
  },
  subline: {
    color: 'rgba(237,224,196,0.7)', fontFamily: 'Cinzel_400Regular',
    fontSize: 10.5, letterSpacing: 1, textAlign: 'center', marginTop: 5,
  },
  label: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12,
    letterSpacing: 2, textAlign: 'center', marginBottom: 6, marginTop: 12,
  },
  titleInput: {
    height: 42,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    paddingHorizontal: 12, textAlign: 'center',
  },
  descInput: {
    minHeight: 110, maxHeight: 170,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 8, borderWidth: 1.2, borderColor: 'rgba(200,165,60,0.5)',
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 13,
    padding: 12,
  },
  evidenceHint: {
    color: 'rgba(237,224,196,0.55)', fontFamily: 'Cinzel_400Regular',
    fontSize: 10, textAlign: 'center', marginBottom: 8,
  },
  thumbRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    justifyContent: 'center', marginBottom: 10,
  },
  thumbWrap: { position: 'relative' },
  thumb: {
    width: 56, height: 56, borderRadius: 6,
    borderWidth: 1, borderColor: 'rgba(200,165,60,0.5)',
  },
  thumbX: {
    position: 'absolute', top: -6, right: -6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: RED, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(0,0,0,0.6)',
  },
  uploadBtn: {
    flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center',
    minHeight: 44, borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.55)', borderStyle: 'dashed',
  },
  uploadBtnText: {
    color: GOLD, fontFamily: 'Cinzel_600SemiBold', fontSize: 12, letterSpacing: 1.5,
  },
  error: {
    color: '#E8B4B4', fontFamily: 'Cinzel_400Regular', fontSize: 11,
    textAlign: 'center', marginTop: 10,
  },
  btnRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    marginTop: 18, gap: 14,
  },
  btn: {
    flex: 1, minHeight: 52, borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1.5, borderColor: 'rgba(200,165,60,0.55)',
    alignItems: 'center', justifyContent: 'center', paddingVertical: 8,
  },
  fileBtn: { borderColor: 'rgba(176,58,58,0.8)' },
  btnDisabled: { opacity: 0.4 },
  btnText: {
    color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 12,
    letterSpacing: 1.5, textAlign: 'center', lineHeight: 18,
  },
  doneWrap: { alignItems: 'center', paddingTop: 40, gap: 18 },
  doneTitle: {
    color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 16, letterSpacing: 4,
  },
  doneBody: {
    color: CREAM, fontFamily: 'Cinzel_400Regular', fontSize: 12.5,
    textAlign: 'center', lineHeight: 20, paddingHorizontal: 10,
  },
});
