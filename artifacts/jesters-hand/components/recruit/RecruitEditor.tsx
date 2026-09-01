// ── Recruit/Verdict visual editor (admin 00-00 only) ─────────────────────────
// Canva-style in-app editor over the official blank templates. Text boxes and
// photo frames live in the 1024×1536 design space; the admin can add, move,
// resize, rotate, duplicate, layer and delete elements, style text (font /
// size / color / align / spacing / bold / italic / capitalization), upload,
// crop (pan+zoom inside the frame) and replace photos, undo/redo, preview,
// save drafts and publish. Photos upload straight into private storage under
// the post's id.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, TextInput, ScrollView,
  PanResponder, Dimensions, ActivityIndicator, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Feather } from '@/components/FIcon';
import {
  DESIGN_W, DESIGN_H, DesignElement, TextElement, PhotoElement, FontKey, TextAlign,
  RecruitSection, uploadRecruitPhoto,
} from '@/lib/recruitService';
import PostCanvas, { FONT_FAMILIES, fontFamilyFor } from './PostCanvas';
import RecruitViewer from './RecruitViewer';
import { appWindow } from '@/lib/appWindow';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';
const INK   = '#1A1512';

const TEXT_COLORS = [INK, '#000000', CREAM, '#FFFFFF', GOLD, '#8C6A2F', '#6E1B1B', '#24391F', '#1F2C42', '#5A5148'];
const FONT_KEYS: FontKey[] = ['serif', 'headline', 'typewriter', 'editorial'];

function uid(): string {
  return `el_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function confirm(title: string, msg: string, onYes: () => void) {
  if (Platform.OS === 'web') {
    // eslint-disable-next-line no-alert
    if (window.confirm(`${title}\n\n${msg}`)) onYes();
  } else {
    Alert.alert(title, msg, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Yes', style: 'destructive', onPress: onYes },
    ]);
  }
}

export interface RecruitEditorProps {
  visible: boolean;
  section: RecruitSection;
  postId: string;
  initialTitle: string;
  initialElements: DesignElement[];
  watermark: string;
  onCancel: () => void;
  onSave: (title: string, elements: DesignElement[], publish: boolean) => Promise<void>;
}

export default function RecruitEditor({
  visible, section, postId, initialTitle, initialElements, watermark, onCancel, onSave,
}: RecruitEditorProps) {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = appWindow();

  // Canvas geometry: fit 2:3 page between header (~96) and toolbar (~120).
  const canvasW = Math.min(SW - 12, (SH - insets.top - insets.bottom - 230) * (DESIGN_W / DESIGN_H));
  const scale = canvasW / DESIGN_W;
  const canvasH = DESIGN_H * scale;

  const [title, setTitle] = useState(initialTitle);
  const [elements, setElements] = useState<DesignElement[]>(initialElements);
  const [past, setPast] = useState<DesignElement[][]>([]);
  const [future, setFuture] = useState<DesignElement[][]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [textPanel, setTextPanel] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Refs so PanResponders (created once per selection) always see fresh state.
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const cropRef = useRef(cropMode);
  cropRef.current = cropMode;

  const selected = elements.find(e => e.id === selectedId) ?? null;

  /** Push current state to history, then apply the change. */
  const commit = useCallback((next: DesignElement[]) => {
    setPast(p => [...p.slice(-49), elementsRef.current]);
    setFuture([]);
    setElements(next);
  }, []);

  /** Change without a history entry (used mid-gesture). */
  const change = useCallback((next: DesignElement[]) => setElements(next), []);

  const undo = () => setPast(p => {
    if (!p.length) return p;
    setFuture(f => [elementsRef.current, ...f]);
    setElements(p[p.length - 1]);
    return p.slice(0, -1);
  });
  const redo = () => setFuture(f => {
    if (!f.length) return f;
    setPast(p => [...p, elementsRef.current]);
    setElements(f[0]);
    return f.slice(1);
  });

  type ElementPatch = Partial<Omit<TextElement, 'type'>> & Partial<Omit<PhotoElement, 'type'>>;
  const patchSel = useCallback((patch: ElementPatch, withHistory = true) => {
    if (!selectedId) return;
    const next = elementsRef.current.map(e => e.id === selectedId ? { ...e, ...patch } as DesignElement : e);
    (withHistory ? commit : change)(next);
  }, [selectedId, commit, change]);

  // Text typing: snapshot the pre-edit state on focus so a single undo entry
  // reverts the whole typing session (mid-typing changes skip history).
  const textBaseline = useRef<DesignElement[] | null>(null);
  const commitTextEdit = useCallback(() => {
    const before = textBaseline.current;
    textBaseline.current = null;
    if (before && before !== elementsRef.current
        && JSON.stringify(before) !== JSON.stringify(elementsRef.current)) {
      setPast(p => [...p.slice(-49), before]);
      setFuture([]);
    }
  }, []);

  // ── Gestures ────────────────────────────────────────────────────────────────
  // One responder per role; they read the selected element via refs.
  const selIdRef = useRef(selectedId);
  selIdRef.current = selectedId;
  const gestureStart = useRef<{ el: DesignElement; all: DesignElement[] } | null>(null);

  const beginGesture = () => {
    const el = elementsRef.current.find(e => e.id === selIdRef.current);
    if (!el) return false;
    gestureStart.current = { el, all: elementsRef.current };
    return true;
  };
  const endGesture = () => {
    // Record one history entry for the whole gesture.
    if (gestureStart.current) {
      const before = gestureStart.current.all;
      setPast(p => [...p.slice(-49), before]);
      setFuture([]);
      gestureStart.current = null;
    }
  };

  const applyToSel = (fn: (el: any) => Partial<DesignElement>) => {
    const start = gestureStart.current;
    if (!start) return;
    change(elementsRef.current.map(e => e.id === start.el.id ? { ...e, ...fn(start.el) } as DesignElement : e));
  };

  const movePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: beginGesture,
    onPanResponderMove: (_e, g) => {
      if (cropRef.current) {
        applyToSel((el: PhotoElement) => ({ imgDX: el.imgDX + g.dx / scale, imgDY: el.imgDY + g.dy / scale }));
      } else {
        applyToSel(el => ({ x: el.x + g.dx / scale, y: el.y + g.dy / scale }));
      }
    },
    onPanResponderRelease: endGesture,
    onPanResponderTerminate: endGesture,
  }), [scale]);

  const resizePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    // Never surrender to the parent move responder mid-drag.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: beginGesture,
    onPanResponderMove: (_e, g) => {
      applyToSel(el => ({
        w: Math.max(60, el.w + g.dx / scale),
        h: Math.max(40, el.h + g.dy / scale),
      }));
    },
    onPanResponderRelease: endGesture,
    onPanResponderTerminate: endGesture,
  }), [scale]);

  const rotatePan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onStartShouldSetPanResponderCapture: () => true,
    // Never surrender to the parent move responder mid-drag.
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: beginGesture,
    onPanResponderMove: (e, g) => {
      const start = gestureStart.current;
      if (!start) return;
      const el = start.el;
      // Handle sits on the top-right corner; rotate by the angle swept around
      // the element's center from the handle's start position to the drag point.
      const rad = (el.rot * Math.PI) / 180;
      const cx = (el.w / 2) * Math.cos(rad) + (el.h / 2) * Math.sin(rad);
      const cy = (el.w / 2) * Math.sin(rad) - (el.h / 2) * Math.cos(rad);
      const a0 = Math.atan2(cy, cx);
      const a1 = Math.atan2(cy + g.dy / scale, cx + g.dx / scale);
      const deg = (a1 - a0) * (180 / Math.PI);
      applyToSel(() => ({ rot: Math.round(((el.rot + deg) % 360 + 540) % 360 - 180) }));
    },
    onPanResponderRelease: endGesture,
    onPanResponderTerminate: endGesture,
  }), [scale]);

  // ── Element ops ─────────────────────────────────────────────────────────────

  const maxZ = elements.reduce((m, e) => Math.max(m, e.z), 0);

  const addText = () => {
    const el: TextElement = {
      id: uid(), type: 'text',
      x: DESIGN_W / 2 - 300, y: DESIGN_H / 2 - 60, w: 600, h: 120, rot: 0, z: maxZ + 1,
      text: 'Tap Edit Text to write…', font: 'serif', size: 44, color: INK,
      align: 'center', lineSpacing: 1.2, letterSpacing: 0, bold: false, italic: false, uppercase: false,
    };
    commit([...elements, el]);
    setSelectedId(el.id);
    setTextPanel(true);
  };

  const pickImage = async (): Promise<{ uri: string; mime?: string } | null> => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], quality: 0.9,
    });
    if (res.canceled || !res.assets?.length) return null;
    const a = res.assets[0];
    return { uri: a.uri, mime: a.mimeType ?? 'image/jpeg' };
  };

  const addPhoto = async () => {
    const img = await pickImage();
    if (!img) return;
    const el: PhotoElement = {
      id: uid(), type: 'photo',
      x: DESIGN_W / 2 - 250, y: DESIGN_H / 2 - 250, w: 500, h: 500, rot: 0, z: maxZ + 1,
      localUri: img.uri, imgScale: 1, imgDX: 0, imgDY: 0,
    };
    commit([...elements, el]);
    setSelectedId(el.id);
    setBusy('Uploading photo…');
    try {
      const path = await uploadRecruitPhoto(postId, img.uri, img.mime);
      setElements(cur => cur.map(e => e.id === el.id ? { ...e, path } as DesignElement : e));
    } catch {
      Alert.alert('Upload failed', 'The photo could not be uploaded. It will not be saved with the design.');
    } finally { setBusy(null); }
  };

  const replacePhoto = async () => {
    if (!selected || selected.type !== 'photo') return;
    const img = await pickImage();
    if (!img) return;
    const id = selected.id;
    commit(elements.map(e => e.id === id
      ? { ...e, localUri: img.uri, path: undefined, imgScale: 1, imgDX: 0, imgDY: 0 } as DesignElement : e));
    setBusy('Uploading photo…');
    try {
      const path = await uploadRecruitPhoto(postId, img.uri, img.mime);
      setElements(cur => cur.map(e => e.id === id ? { ...e, path } as DesignElement : e));
    } catch {
      Alert.alert('Upload failed', 'The photo could not be uploaded.');
    } finally { setBusy(null); }
  };

  const duplicateSel = () => {
    if (!selected) return;
    const copy = { ...selected, id: uid(), x: selected.x + 30, y: selected.y + 30, z: maxZ + 1 };
    commit([...elements, copy]);
    setSelectedId(copy.id);
  };

  const layerSel = (dir: 1 | -1) => {
    if (!selected) return;
    const sorted = [...elements].sort((a, b) => a.z - b.z);
    const idx = sorted.findIndex(e => e.id === selected.id);
    const swapWith = sorted[idx + dir];
    if (!swapWith) return;
    commit(elements.map(e => {
      if (e.id === selected.id) return { ...e, z: swapWith.z };
      if (e.id === swapWith.id) return { ...e, z: selected.z };
      return e;
    }));
  };

  const deleteSel = () => {
    if (!selected) return;
    confirm('Delete element', 'Remove this from the design?', () => {
      commit(elements.filter(e => e.id !== selected.id));
      setSelectedId(null);
      setTextPanel(false);
      setCropMode(false);
    });
  };

  // ── Save / publish ──────────────────────────────────────────────────────────

  const doSave = async (publish: boolean) => {
    const pending = elements.some(e => e.type === 'photo' && !e.path);
    if (pending) {
      Alert.alert('Photos still uploading', 'Wait a moment for photos to finish uploading, then try again.');
      return;
    }
    setBusy(publish ? 'Publishing…' : 'Saving draft…');
    try {
      await onSave(title, elements, publish);
    } catch {
      Alert.alert('Save failed', 'The design could not be saved. Check your connection and try again.');
    } finally { setBusy(null); }
  };

  const handleCancel = () => {
    confirm('Leave the editor', 'Unsaved changes will be lost. Leave anyway?', onCancel);
  };

  // ── Selection overlay geometry ──────────────────────────────────────────────

  const selBox = selected ? {
    left: selected.x * scale, top: selected.y * scale,
    width: selected.w * scale, height: selected.h * scale,
    transform: [{ rotate: `${selected.rot}deg` }],
  } : null;

  // ── Render ──────────────────────────────────────────────────────────────────

  const isText = selected?.type === 'text';
  const isPhoto = selected?.type === 'photo';
  const selText = isText ? selected as TextElement : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleCancel}>
      <View style={[st.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>

        {/* Header: title + main actions */}
        <View style={st.header}>
          <TextInput
            style={st.titleInput}
            value={title}
            onChangeText={setTitle}
            placeholder={section === 'recruit' ? 'Recruit title…' : 'Verdict title…'}
            placeholderTextColor="rgba(237,224,196,0.4)"
            maxLength={120}
          />
          <TouchableOpacity onPress={undo} disabled={!past.length} style={st.hBtn}>
            <Feather name="rotate-ccw" size={19} color={past.length ? CREAM : 'rgba(237,224,196,0.25)'} />
          </TouchableOpacity>
          <TouchableOpacity onPress={redo} disabled={!future.length} style={st.hBtn}>
            <Feather name="refresh-cw" size={19} color={future.length ? CREAM : 'rgba(237,224,196,0.25)'} />
          </TouchableOpacity>
        </View>

        <View style={st.actionRow}>
          <TouchableOpacity style={st.actionBtn} onPress={() => doSave(false)} disabled={!!busy}>
            <Text style={st.actionTxt}>SAVE DRAFT</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.actionBtn} onPress={() => { setSelectedId(null); setPreview(true); }} disabled={!!busy}>
            <Text style={st.actionTxt}>PREVIEW</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[st.actionBtn, st.publishBtn]} onPress={() => doSave(true)} disabled={!!busy}>
            <Text style={[st.actionTxt, { color: '#0B0906' }]}>PUBLISH</Text>
          </TouchableOpacity>
          <TouchableOpacity style={st.actionBtn} onPress={handleCancel} disabled={!!busy}>
            <Text style={st.actionTxt}>CANCEL</Text>
          </TouchableOpacity>
        </View>

        {/* Canvas + reference example. Scrolling is enabled only while nothing
            is selected, so element drags never fight the scroll gesture:
            tap an empty spot to deselect, then scroll to peek at the sample. */}
        <ScrollView
          style={st.canvasArea}
          scrollEnabled={!selectedId}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={st.canvasScroll}
        >
          <View style={{ width: canvasW, height: canvasH }}>
            <PostCanvas section={section} elements={elements} width={canvasW} />
            {/* Tap-catcher: select elements / deselect on empty tap */}
            <View style={StyleSheet.absoluteFill}>
              <TouchableOpacity
                style={StyleSheet.absoluteFill}
                activeOpacity={1}
                onPress={() => { setSelectedId(null); setTextPanel(false); setCropMode(false); }}
              />
              {[...elements].sort((a, b) => a.z - b.z).map(el => (
                el.id === selectedId ? null : (
                  <TouchableOpacity
                    key={el.id}
                    activeOpacity={0.9}
                    onPress={() => { setSelectedId(el.id); setCropMode(false); }}
                    style={{
                      position: 'absolute',
                      left: el.x * scale, top: el.y * scale,
                      width: el.w * scale, height: el.h * scale,
                      transform: [{ rotate: `${el.rot}deg` }],
                    }}
                  />
                )
              ))}
              {/* Selected element: drag body, resize corner, rotate handle */}
              {selBox ? (
                <View style={[st.selBox, selBox, cropMode && st.selBoxCrop]} {...movePan.panHandlers}>
                  {/* Top-left: delete */}
                  <TouchableOpacity style={[st.cornerHandle, st.deleteHandle]} onPress={deleteSel} hitSlop={8}>
                    <Feather name="x" size={14} color="#0B0906" />
                  </TouchableOpacity>
                  {/* Top-right: rotate */}
                  <View style={[st.cornerHandle, st.rotateHandle]} {...rotatePan.panHandlers}>
                    <Feather name="refresh-cw" size={13} color="#0B0906" />
                  </View>
                  {/* Bottom-right: resize */}
                  <View style={[st.cornerHandle, st.resizeHandle]} {...resizePan.panHandlers}>
                    <Feather name="maximize-2" size={13} color="#0B0906" />
                  </View>
                  {cropMode ? <Text style={st.cropHint}>CROP — drag photo, use − / + to zoom</Text> : null}
                </View>
              ) : null}
            </View>
          </View>

          {/* Reference example below the working template (view-only). */}
          <Text style={st.refLabel}>
            REFERENCE EXAMPLE — VIEW ONLY{selectedId ? '  ·  tap empty space, then scroll' : ''}
          </Text>
          <View pointerEvents="none" style={st.refCanvas}>
            <PostCanvas section={section} elements={[]} width={canvasW} template="example" />
          </View>
        </ScrollView>

        {/* Toolbar */}
        <View style={st.toolbar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.toolRow}>
            {!selected ? (<>
              <Tool icon="type" label="Add Text" onPress={addText} />
              <Tool icon="image" label="Add Photo" onPress={addPhoto} />
            </>) : null}
            {isText ? (<>
              <Tool icon="edit-2" label="Edit Text" onPress={() => setTextPanel(true)} />
              <Tool icon="minus" label="Smaller" onPress={() => patchSel({ size: Math.max(10, (selText!.size) - 4) })} />
              <Tool icon="plus" label="Bigger" onPress={() => patchSel({ size: Math.min(240, (selText!.size) + 4) })} />
            </>) : null}
            {isPhoto ? (<>
              <Tool icon="image" label="Replace" onPress={replacePhoto} />
              <Tool icon="check-square" label={cropMode ? 'Done Crop' : 'Crop'} onPress={() => setCropMode(c => !c)} />
              <Tool icon="minus" label="Zoom Out" onPress={() => patchSel({ imgScale: Math.max(1, (selected as PhotoElement).imgScale - 0.15) })} />
              <Tool icon="plus" label="Zoom In" onPress={() => patchSel({ imgScale: Math.min(5, (selected as PhotoElement).imgScale + 0.15) })} />
            </>) : null}
            {selected ? (<>
              <Tool icon="upload" label="Forward" onPress={() => layerSel(1)} />
              <Tool icon="save" label="Backward" onPress={() => layerSel(-1)} />
              <Tool icon="plus" label="Duplicate" onPress={duplicateSel} />
              <Tool icon="trash-2" label="Delete" onPress={deleteSel} />
            </>) : null}
          </ScrollView>
        </View>

        {/* Text style panel */}
        {textPanel && selText ? (
          <View style={st.textPanel}>
            <TextInput
              style={st.textInput}
              value={selText.text}
              onFocus={() => { textBaseline.current = elementsRef.current; }}
              onChangeText={t => patchSel({ text: t }, false)}
              onBlur={commitTextEdit}
              onEndEditing={commitTextEdit}
              multiline
              placeholder="Write here…"
              placeholderTextColor="rgba(237,224,196,0.35)"
            />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={st.chipRow}>
              {FONT_KEYS.map(k => (
                <TouchableOpacity key={k} style={[st.chip, selText.font === k && st.chipOn]} onPress={() => patchSel({ font: k })}>
                  <Text style={[st.chipTxt, { fontFamily: FONT_FAMILIES[k].regular }]}>{FONT_FAMILIES[k].label}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={st.chipRow}>
              {(['left', 'center', 'right'] as TextAlign[]).map(a => (
                <TouchableOpacity key={a} style={[st.chip, selText.align === a && st.chipOn]} onPress={() => patchSel({ align: a })}>
                  <Text style={st.chipTxt}>{a.toUpperCase()}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity style={[st.chip, selText.bold && st.chipOn]} onPress={() => patchSel({ bold: !selText.bold })}>
                <Text style={[st.chipTxt, { fontWeight: '700' }]}>B</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.chip, selText.italic && st.chipOn]} onPress={() => patchSel({ italic: !selText.italic })}>
                <Text style={[st.chipTxt, { fontStyle: 'italic' }]}>I</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[st.chip, selText.uppercase && st.chipOn]} onPress={() => patchSel({ uppercase: !selText.uppercase })}>
                <Text style={st.chipTxt}>AA</Text>
              </TouchableOpacity>
            </View>
            <View style={st.chipRow}>
              <Text style={st.panelLabel}>Line</Text>
              <TouchableOpacity style={st.chip} onPress={() => patchSel({ lineSpacing: Math.max(0.8, +(selText.lineSpacing - 0.1).toFixed(2)) })}><Text style={st.chipTxt}>−</Text></TouchableOpacity>
              <TouchableOpacity style={st.chip} onPress={() => patchSel({ lineSpacing: Math.min(3, +(selText.lineSpacing + 0.1).toFixed(2)) })}><Text style={st.chipTxt}>+</Text></TouchableOpacity>
              <Text style={st.panelLabel}>Letter</Text>
              <TouchableOpacity style={st.chip} onPress={() => patchSel({ letterSpacing: Math.max(-2, selText.letterSpacing - 1) })}><Text style={st.chipTxt}>−</Text></TouchableOpacity>
              <TouchableOpacity style={st.chip} onPress={() => patchSel({ letterSpacing: Math.min(30, selText.letterSpacing + 1) })}><Text style={st.chipTxt}>+</Text></TouchableOpacity>
              {TEXT_COLORS.map(c => (
                <TouchableOpacity
                  key={c}
                  style={[st.swatch, { backgroundColor: c }, selText.color === c && st.swatchOn]}
                  onPress={() => patchSel({ color: c })}
                />
              ))}
            </View>
            <TouchableOpacity style={st.panelClose} onPress={() => { commitTextEdit(); setTextPanel(false); }}>
              <Text style={st.actionTxt}>DONE</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {busy ? (
          <View style={st.busy} pointerEvents="auto">
            <ActivityIndicator color={GOLD} size="large" />
            <Text style={st.busyTxt}>{busy}</Text>
          </View>
        ) : null}

        <RecruitViewer
          visible={preview}
          onClose={() => setPreview(false)}
          section={section}
          elements={elements}
          title={title || (section === 'recruit' ? 'RECRUIT — PREVIEW' : 'VERDICT — PREVIEW')}
          watermark={watermark}
          notice="Preview — exactly what members will see"
        />
      </View>
    </Modal>
  );
}

function Tool({ icon, label, onPress }: { icon: any; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={st.tool} onPress={onPress}>
      <Feather name={icon} size={18} color={GOLD} />
      <Text style={st.toolTxt}>{label}</Text>
    </TouchableOpacity>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0B0906' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingTop: 6 },
  titleInput: {
    flex: 1, color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 15,
    borderBottomWidth: 1, borderBottomColor: 'rgba(212,168,83,0.4)', paddingVertical: 6,
  },
  hBtn: { padding: 8, marginLeft: 4 },
  actionRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  actionBtn: {
    flex: 1, borderWidth: 1, borderColor: GOLD, borderRadius: 6,
    paddingVertical: 8, alignItems: 'center', backgroundColor: 'rgba(212,168,83,0.08)',
  },
  publishBtn: { backgroundColor: GOLD },
  actionTxt: { color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 10, letterSpacing: 1 },
  canvasArea: { flex: 1 },
  canvasScroll: { alignItems: 'center', paddingVertical: 10 },
  refLabel: {
    color: 'rgba(212,168,83,0.7)', fontFamily: 'Cinzel_600SemiBold', fontSize: 10,
    letterSpacing: 1.5, textAlign: 'center', marginTop: 18, marginBottom: 8,
  },
  refCanvas: { borderWidth: 1, borderColor: 'rgba(200,165,60,0.3)', borderRadius: 6, overflow: 'hidden' },
  selBox: {
    position: 'absolute', borderWidth: 1.5, borderColor: GOLD, borderStyle: 'dashed',
    // On web (touch screens in the browser), stop the browser from hijacking
    // the drag for scrolling/pull-to-refresh — that's what made handles jumpy.
    ...(Platform.OS === 'web' ? { touchAction: 'none' as any } : {}),
  },
  selBoxCrop: { borderColor: '#7FB07F', borderStyle: 'solid' },
  cornerHandle: {
    position: 'absolute', width: 26, height: 26, borderRadius: 13,
    backgroundColor: GOLD, borderWidth: 2, borderColor: '#0B0906',
    alignItems: 'center', justifyContent: 'center', zIndex: 5,
    ...(Platform.OS === 'web' ? { touchAction: 'none' as any } : {}),
  },
  deleteHandle: { left: -13, top: -13, backgroundColor: '#C96A5B' },
  rotateHandle: { right: -13, top: -13 },
  resizeHandle: { right: -13, bottom: -13 },
  cropHint: {
    position: 'absolute', top: -56, left: -40, right: -40, textAlign: 'center',
    color: '#7FB07F', fontFamily: 'Inter_500Medium', fontSize: 10,
  },
  toolbar: { borderTopWidth: 1, borderTopColor: 'rgba(212,168,83,0.25)', backgroundColor: '#0E0B08' },
  toolRow: { paddingHorizontal: 10, paddingVertical: 8, gap: 6 },
  tool: { alignItems: 'center', paddingHorizontal: 10, paddingVertical: 4, gap: 3, minWidth: 62 },
  toolTxt: { color: CREAM, fontFamily: 'Inter_500Medium', fontSize: 9.5 },
  textPanel: {
    position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: '#12100C',
    borderTopWidth: 1, borderTopColor: GOLD, padding: 12, gap: 8,
  },
  textInput: {
    minHeight: 64, maxHeight: 130, color: CREAM, fontFamily: 'Inter_400Regular', fontSize: 15,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)', borderRadius: 6, padding: 10,
    textAlignVertical: 'top',
  },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  chip: {
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)', borderRadius: 5,
    paddingHorizontal: 10, paddingVertical: 6,
  },
  chipOn: { backgroundColor: 'rgba(212,168,83,0.25)', borderColor: GOLD },
  chipTxt: { color: CREAM, fontSize: 12 },
  panelLabel: { color: 'rgba(237,224,196,0.6)', fontFamily: 'Inter_500Medium', fontSize: 11, marginLeft: 4 },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: 'rgba(237,224,196,0.4)' },
  swatchOn: { borderWidth: 2.5, borderColor: GOLD },
  panelClose: { alignSelf: 'flex-end', paddingHorizontal: 14, paddingVertical: 6 },
  busy: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(5,4,3,0.7)',
    alignItems: 'center', justifyContent: 'center', gap: 12,
  },
  busyTxt: { color: CREAM, fontFamily: 'Cinzel_600SemiBold', fontSize: 13 },
});
