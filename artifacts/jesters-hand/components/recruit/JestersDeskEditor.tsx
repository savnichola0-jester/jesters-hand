import React, { useState } from 'react';
import {
  ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView,
  StyleSheet, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import {
  DeskPhotoKey, DeskTextKey, JestersDeskContent, uploadRecruitPhoto,
} from '@/lib/recruitService';
import { BUTTON_ACCENT, BUTTON_ACCENT_SOFT } from '@/lib/buttonAccent';
import { appWindow } from '@/lib/appWindow';
import JestersDeskDocument from './JestersDeskTemplate';
import RecruitViewer from './RecruitViewer';

export interface JestersDeskEditorProps {
  visible: boolean;
  section: 'recruit' | 'verdict';
  postId: string;
  initialTitle: string;
  initialContent: JestersDeskContent;
  watermark: string;
  onCancel: () => void;
  onSave: (title: string, content: JestersDeskContent, publish: boolean) => Promise<void>;
}

function fieldLabel(field: DeskTextKey): string {
  return field.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function confirmLeave(onLeave: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm('Leave the editor? Unsaved changes will be lost.')) onLeave();
    return;
  }
  Alert.alert('Leave the editor?', 'Unsaved changes will be lost.', [
    { text: 'Keep editing', style: 'cancel' },
    { text: 'Leave', style: 'destructive', onPress: onLeave },
  ]);
}

export default function JestersDeskEditor({
  visible, section, postId, initialTitle, initialContent, watermark, onCancel, onSave,
}: JestersDeskEditorProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = appWindow();
  const documentWidth = Math.min(screenWidth - 28, 724);
  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState<JestersDeskContent>(initialContent);
  const [dirty, setDirty] = useState(false);
  const [activeField, setActiveField] = useState<DeskTextKey | null>(null);
  const [fieldDraft, setFieldDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  const openTextEditor = (field: DeskTextKey) => {
    setFieldDraft(content.text[field] ?? '');
    setActiveField(field);
  };

  const saveTextEditor = () => {
    if (!activeField) return;
    const field = activeField;
    setContent(current => ({
      ...current,
      text: { ...current.text, [field]: fieldDraft },
    }));
    setDirty(true);
    setActiveField(null);
  };

  const pickPhoto = async (field: DeskPhotoKey) => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.9,
      });
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      setBusy('Uploading photo…');
      setError(null);
      const path = await uploadRecruitPhoto(postId, asset.uri, asset.mimeType ?? 'image/jpeg');
      setContent(current => ({
        ...current,
        photos: { ...current.photos, [field]: path },
      }));
      setDirty(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The photo could not be uploaded.');
    } finally {
      setBusy(null);
    }
  };

  const save = async (publish: boolean) => {
    if (busy || activeField) return;
    setBusy(publish ? 'Publishing…' : 'Saving draft…');
    setError(null);
    try {
      await onSave(title, content, publish);
      setDirty(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The post could not be saved.');
    } finally {
      setBusy(null);
    }
  };

  const close = () => {
    const pendingTextChanges = activeField !== null
      && fieldDraft !== (content.text[activeField] ?? '');
    if (!dirty && !pendingTextChanges) {
      onCancel();
      return;
    }
    confirmLeave(onCancel);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <KeyboardAvoidingView style={s.keyboardRoot} behavior="padding" keyboardVerticalOffset={0}>
        <View style={[s.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={s.header}>
            <TouchableOpacity onPress={close} style={s.closeButton} accessibilityLabel="Close editor">
              <Feather name="x" size={21} color={BUTTON_ACCENT} />
            </TouchableOpacity>
            <TextInput
              testID="desk-post-title"
              style={s.titleInput}
              value={title}
              onChangeText={value => { setTitle(value); setDirty(true); }}
              placeholder="Post title"
              placeholderTextColor="rgba(237,224,196,0.48)"
              maxLength={120}
              returnKeyType="done"
            />
          </View>
          <Text style={s.instruction}>Tap any dashed text or photo area to edit it. Scroll to continue the edition.</Text>
          <View style={s.actionRow}>
            <Action title="SAVE DRAFT" onPress={() => void save(false)} disabled={!!busy || !!activeField} />
            <Action title="PREVIEW" onPress={() => setPreview(true)} disabled={!!busy || !!activeField} />
            <Action title="PUBLISH" onPress={() => void save(true)} disabled={!!busy || !!activeField} />
          </View>

          {error ? <Text style={s.error}>{error}</Text> : null}
          <ScrollView
            style={s.canvasScroll}
            contentContainerStyle={s.canvasContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <JestersDeskDocument
              width={documentWidth}
              content={content}
              editable
              onEditText={openTextEditor}
              onPickPhoto={field => void pickPhoto(field)}
            />
          </ScrollView>

          {activeField ? (
            <View style={s.sheetBackdrop}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setActiveField(null)} />
              <View style={[s.editSheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                <View style={s.sheetHeader}>
                  <Text style={s.sheetTitle}>{fieldLabel(activeField)}</Text>
                  <TouchableOpacity onPress={() => setActiveField(null)} accessibilityLabel="Cancel text edit">
                    <Feather name="x" size={20} color="#EDE0C4" />
                  </TouchableOpacity>
                </View>
                <TextInput
                  testID={`desk-input-${activeField}`}
                  style={s.editInput}
                  value={fieldDraft}
                  onChangeText={setFieldDraft}
                  placeholder={`Write ${fieldLabel(activeField).toLowerCase()}…`}
                  placeholderTextColor="rgba(237,224,196,0.42)"
                  multiline
                  maxLength={5000}
                  autoFocus
                  textAlignVertical="top"
                  blurOnSubmit={false}
                />
                <TouchableOpacity style={s.applyButton} onPress={saveTextEditor} accessibilityLabel="Save text">
                  <Text style={s.applyButtonText}>APPLY TEXT</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}

          {busy ? (
            <View style={s.busyOverlay}>
              <ActivityIndicator color={BUTTON_ACCENT} size="large" />
              <Text style={s.busyText}>{busy}</Text>
            </View>
          ) : null}

          <RecruitViewer
            visible={preview}
            onClose={() => setPreview(false)}
            section={section}
            elements={[]}
            template="desk"
            deskContent={content}
            title={title || 'THE JESTER’S DESK'}
            watermark={watermark}
            notice="Preview — exactly what members will see"
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Action({
  title, onPress, disabled,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      testID={`desk-action-${title.toLowerCase().replace(/\s/g, '-')}`}
      style={[s.actionButton, disabled && s.disabledButton]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={s.actionText}>{title}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  keyboardRoot: { flex: 1, backgroundColor: '#0B0906' },
  root: { flex: 1, backgroundColor: '#0B0906' },
  header: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, gap: 8,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.25)',
  },
  closeButton: { padding: 7 },
  titleInput: {
    flex: 1, minHeight: 40, color: '#EDE0C4',
    fontFamily: 'Cinzel_600SemiBold', fontSize: 14,
    borderBottomWidth: 1, borderBottomColor: BUTTON_ACCENT, paddingHorizontal: 4,
  },
  instruction: {
    color: 'rgba(237,224,196,0.68)', fontFamily: 'Inter_400Regular',
    fontSize: 11, textAlign: 'center', paddingHorizontal: 14, paddingVertical: 8,
  },
  actionRow: { flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingBottom: 7 },
  actionButton: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    minHeight: 38, paddingHorizontal: 3,
    borderWidth: 1, borderColor: BUTTON_ACCENT, borderRadius: 6,
    backgroundColor: BUTTON_ACCENT_SOFT,
  },
  actionText: { color: BUTTON_ACCENT, fontFamily: 'Cinzel_700Bold', fontSize: 9, letterSpacing: 0.7 },
  disabledButton: { opacity: 0.42 },
  error: { color: '#F2A399', fontFamily: 'Inter_500Medium', fontSize: 12, textAlign: 'center', padding: 8 },
  canvasScroll: { flex: 1 },
  canvasContent: { alignItems: 'center', paddingBottom: 24 },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject, zIndex: 20,
    justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)',
  },
  editSheet: {
    backgroundColor: '#17130E', borderTopWidth: 1, borderTopColor: BUTTON_ACCENT,
    paddingHorizontal: 14, paddingTop: 12, gap: 10,
  },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: '#EDE0C4', fontFamily: 'Cinzel_600SemiBold', fontSize: 13, letterSpacing: 1 },
  editInput: {
    minHeight: 120, maxHeight: 250, borderWidth: 1, borderColor: BUTTON_ACCENT,
    borderRadius: 6, color: '#F3E6CC', padding: 10,
    fontFamily: 'Inter_400Regular', fontSize: 16,
  },
  applyButton: {
    alignSelf: 'flex-end', minWidth: 124, minHeight: 40,
    backgroundColor: BUTTON_ACCENT, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14,
  },
  applyButtonText: { color: '#1A120A', fontFamily: 'Cinzel_700Bold', fontSize: 11, letterSpacing: 1 },
  busyOverlay: {
    ...StyleSheet.absoluteFillObject, zIndex: 30,
    alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: 'rgba(3,2,1,0.72)',
  },
  busyText: { color: '#EDE0C4', fontFamily: 'Cinzel_600SemiBold', fontSize: 13 },
});
