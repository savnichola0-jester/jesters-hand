// "The Spread" — free-form detective string-board canvas for Target Tickets.
//
// Architecture notes (for future element types):
// - All element geometry lives in CANVAS coordinates; the viewport applies
//   translate(panX,panY) + scale(zoom) on top. Gesture deltas are divided by
//   zoom to convert screen movement into canvas movement.
// - Every element kind renders through ElementBody; add new kinds there and
//   in the palette list. Manipulation (drag/resize/rotate/delete/dots) is
//   generic via corner controls on the selected element:
//     top-left ✕ delete · top-right ⟳ rotate · bottom-right ⤡ resize.
// - Each CanvasElement wrapper is padded (HANDLE_PAD) so the corner controls
//   sit INSIDE the wrapper's bounds — on native, touches outside a view's
//   frame never register, which is why edge-mounted handles didn't work.
// - All PanResponders refuse termination requests and block the native
//   responder, otherwise a parent ScrollView steals the gesture mid-drag.
//   Parents should also pause their own scrolling via onGestureActive.
// - Connectors are drawn in canvas space between element centers; their
//   midpoint circle is the tap target for selection.
import React, { useRef, useState, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal, Image,
  PanResponder, StyleSheet, ScrollView,
} from 'react-native';
import Svg, { Line, Circle } from 'react-native-svg';
import {
  SpreadState, SpreadElement, SpreadConnector, DotColor, DOT_META,
} from '@/lib/targetTicketService';
import { StatusDot, DotPickerModal } from './StatusDot';

const GOLD = '#D4A853';
const CREAM = '#F5E8C8';

const MIN_SIZE = 44;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
// Padding around each element so corner controls are inside the touch frame.
const HANDLE_PAD = 20;

export type ElementKind = SpreadElement['kind'];

const PALETTE: { kind: ElementKind; label: string }[] = [
  { kind: 'note', label: 'Sticky Note' },
  { kind: 'clipping', label: 'Clipping' },
  { kind: 'photo', label: 'Photo' },
  { kind: 'document', label: 'Document' },
  { kind: 'fingerprint', label: 'Print Card' },
];

// Sized to each artwork's aspect ratio — small enough to sit inside the frame.
const DEFAULT_SIZES: Record<ElementKind, { w: number; h: number }> = {
  note: { w: 110, h: 114 },
  clipping: { w: 125, h: 188 },
  photo: { w: 105, h: 134 },
  document: { w: 115, h: 172 },
  fingerprint: { w: 115, h: 152 },
};

// The uploaded artwork each element is built on.
const ART: Record<ElementKind, any> = {
  note: require('@/assets/images/spread/note.png'),
  clipping: require('@/assets/images/spread/clipping.png'),
  photo: require('@/assets/images/spread/polaroid.png'),
  document: require('@/assets/images/spread/document.png'),
  fingerprint: require('@/assets/images/spread/fingerprint.jpg'),
};

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function center(el: SpreadElement) {
  return { cx: el.x + el.w / 2, cy: el.y + el.h / 2 };
}

// Shared PanResponder hardening: never yield to a parent ScrollView.
const HOLD = {
  onPanResponderTerminationRequest: () => false,
  onShouldBlockNativeResponder: () => true,
};

// ─── Element visual bodies ────────────────────────────────────────
//
// Every element renders its uploaded artwork as the full background, with
// input regions positioned by FRACTIONS of the element's width/height so
// they stay glued to the printed areas at any size.

type EditField = 'text' | 'text2';

/** Fractional box on the artwork → absolute pixels inside the element. */
function fbox(el: SpreadElement, x0: number, x1: number, y0: number, y1: number) {
  return {
    position: 'absolute' as const,
    left: el.w * x0, top: el.h * y0,
    width: el.w * (x1 - x0), height: el.h * (y1 - y0),
  };
}

/** An ante-card-style input bar embedded on the artwork. */
function RegionInput({ el, x0, x1, y0, y1, value, placeholder, active, onChangeText }: {
  el: SpreadElement;
  x0: number; x1: number; y0: number; y1: number;
  value?: string;
  placeholder: string;
  /** Editable only when the element is selected & editable. */
  active: boolean;
  onChangeText: (t: string) => void;
}) {
  const fs = Math.max(7, el.w * 0.055);
  return (
    <View style={[fbox(el, x0, x1, y0, y1), styles.regionInputWrap]} pointerEvents={active ? 'auto' : 'none'}>
      <TextInput
        style={[styles.regionInput, { fontSize: fs }]}
        value={value ?? ''}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor="rgba(237,224,196,0.4)"
        multiline
        textAlignVertical="top"
        editable={active}
        selectionColor={GOLD}
        scrollEnabled={false}
      />
    </View>
  );
}

/** A tap-to-upload photo well embedded on the artwork. */
function RegionPhoto({ el, x0, x1, y0, y1, active, onPress, framed }: {
  el: SpreadElement;
  x0: number; x1: number; y0: number; y1: number;
  active: boolean;
  onPress: () => void;
  framed?: boolean;
}) {
  const fs = Math.max(6, el.w * 0.05);
  const box = [fbox(el, x0, x1, y0, y1), framed && styles.regionPhotoWell];
  const inner = el.uri
    ? <Image source={{ uri: el.uri }} style={StyleSheet.absoluteFill as any} resizeMode="cover" />
    : (active && framed
        ? <Text style={[styles.regionPhotoHint, { fontSize: fs }]}>Tap to{'\n'}upload</Text>
        : null);
  if (!active) return <View style={box} pointerEvents="none">{inner}</View>;
  return (
    <TouchableOpacity style={[box, styles.regionPhotoActive]} onPress={onPress} activeOpacity={0.7}>
      {inner}
    </TouchableOpacity>
  );
}

function ElementBody({ el, active, onField, onPhoto }: {
  el: SpreadElement;
  /** True when selected & editable → inputs become live. */
  active: boolean;
  onField: (field: EditField, value: string) => void;
  onPhoto: () => void;
}) {
  const text = (f: EditField) => (v: string) => onField(f, v);
  const body = (() => {
    switch (el.kind) {
      case 'note':
        return (
          <RegionInput el={el} x0={0.13} x1={0.87} y0={0.31} y1={0.70} active={active}
            value={el.text} placeholder="Mark it…" onChangeText={text('text')} />
        );
      case 'clipping':
        return (
          <>
            {/* under ADD YOUR DETAILS (left column) */}
            <RegionInput el={el} x0={0.05} x1={0.475} y0={0.44} y1={0.70} active={active}
              value={el.text} placeholder="Your details…" onChangeText={text('text')} />
            {/* under UPLOAD YOUR IMAGE (right column) */}
            <RegionPhoto el={el} x0={0.525} x1={0.95} y0={0.44} y1={0.70} active={active} onPress={onPhoto} framed />
            {/* under MORE CONTEXT */}
            <RegionInput el={el} x0={0.2} x1={0.93} y0={0.795} y1={0.885} active={active}
              value={el.text2} placeholder="More context…" onChangeText={text('text2')} />
          </>
        );
      case 'photo':
        return (
          <>
            {/* the polaroid window (artwork already says UPLOAD PHOTO) */}
            <RegionPhoto el={el} x0={0.065} x1={0.9} y0={0.1} y1={0.735} active={active} onPress={onPhoto} />
            {/* caption bar below the window */}
            <RegionInput el={el} x0={0.09} x1={0.88} y0={0.765} y1={0.94} active={active}
              value={el.text} placeholder="Caption…" onChangeText={text('text')} />
          </>
        );
      case 'document':
        return (
          <RegionInput el={el} x0={0.12} x1={0.88} y0={0.265} y1={0.8} active={active}
            value={el.text} placeholder="The intel…" onChangeText={text('text')} />
        );
      case 'fingerprint':
        return (
          <RegionInput el={el} x0={0.1} x1={0.9} y0={0.475} y1={0.89} active={active}
            value={el.text} placeholder="Connections…" onChangeText={text('text')} />
        );
      default:
        return null;
    }
  })();

  return (
    <View style={styles.body}>
      <Image
        source={ART[el.kind]}
        style={{ position: 'absolute', left: 0, top: 0, width: el.w, height: el.h }}
        resizeMode="stretch"
      />
      {body}
    </View>
  );
}

// ─── Draggable / resizable / rotatable wrapper ────────────────────

function CanvasElement({ el, zoom, selected, editable, onSelect, onChange, onDelete, onGestureActive, onField, onPhoto }: {
  el: SpreadElement;
  zoom: number;
  selected: boolean;
  editable: boolean;
  onSelect: () => void;
  onChange: (updates: Partial<SpreadElement>) => void;
  onDelete: () => void;
  onGestureActive: (active: boolean) => void;
  onField: (field: EditField, value: string) => void;
  onPhoto: () => void;
}) {
  const elRef = useRef(el); elRef.current = el;
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const base = useRef({ x: 0, y: 0, w: 0, h: 0, rot: 0 });

  const dragPan = useRef(
    PanResponder.create({
      ...HOLD,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) => Math.abs(gs.dx) + Math.abs(gs.dy) > 4,
      onPanResponderGrant: () => {
        onGestureActive(true);
        onSelect();
        base.current = { ...base.current, x: elRef.current.x, y: elRef.current.y };
      },
      onPanResponderMove: (_, gs) => {
        onChange({
          x: base.current.x + gs.dx / zoomRef.current,
          y: base.current.y + gs.dy / zoomRef.current,
        });
      },
      onPanResponderRelease: () => onGestureActive(false),
      onPanResponderTerminate: () => onGestureActive(false),
    })
  ).current;

  const resizePan = useRef(
    PanResponder.create({
      ...HOLD,
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        onGestureActive(true);
        base.current = { ...base.current, w: elRef.current.w, h: elRef.current.h };
      },
      onPanResponderMove: (_, gs) => {
        onChange({
          w: Math.max(MIN_SIZE, base.current.w + gs.dx / zoomRef.current),
          h: Math.max(MIN_SIZE, base.current.h + gs.dy / zoomRef.current),
        });
      },
      onPanResponderRelease: () => onGestureActive(false),
      onPanResponderTerminate: () => onGestureActive(false),
    })
  ).current;

  const rotatePan = useRef(
    PanResponder.create({
      ...HOLD,
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        onGestureActive(true);
        base.current = { ...base.current, rot: elRef.current.rot };
      },
      onPanResponderMove: (_, gs) => {
        // Drag in any direction spins the element (free angle).
        onChange({ rot: (base.current.rot + (gs.dx + gs.dy) * 0.6) % 360 });
      },
      onPanResponderRelease: () => onGestureActive(false),
      onPanResponderTerminate: () => onGestureActive(false),
    })
  ).current;

  return (
    <View
      style={{
        position: 'absolute',
        left: el.x - HANDLE_PAD,
        top: el.y - HANDLE_PAD,
        width: el.w + HANDLE_PAD * 2,
        height: el.h + HANDLE_PAD * 2,
        zIndex: el.z,
        padding: HANDLE_PAD,
        transform: [{ rotate: `${el.rot}deg` }],
      }}
      {...(editable ? dragPan.panHandlers : {})}
    >
      <View style={{ flex: 1 }} pointerEvents={selected && editable ? 'box-none' : 'none'}>
        <ElementBody el={el} active={selected && editable} onField={onField} onPhoto={onPhoto} />
      </View>
      {!editable && (
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={0.9} onPress={onSelect} />
      )}
      {el.dot ? (
        <View style={styles.elDot} pointerEvents="none"><StatusDot dot={el.dot} size={13} /></View>
      ) : null}
      {selected && editable && (
        <>
          <View style={styles.selBorder} pointerEvents="none" />
          {/* top-left: delete */}
          <TouchableOpacity style={[styles.corner, { left: 0, top: 0 }]} onPress={onDelete} activeOpacity={0.7}>
            <View style={[styles.cornerInner, styles.cornerDelete]}>
              <Text style={styles.cornerGlyph}>✕</Text>
            </View>
          </TouchableOpacity>
          {/* top-right: rotate */}
          <View style={[styles.corner, { right: 0, top: 0 }]} {...rotatePan.panHandlers}>
            <View style={[styles.cornerInner, styles.cornerGold]}>
              <Text style={[styles.cornerGlyph, { color: '#1A1204' }]}>⟳</Text>
            </View>
          </View>
          {/* bottom-right: resize */}
          <View style={[styles.corner, { right: 0, bottom: 0 }]} {...resizePan.panHandlers}>
            <View style={[styles.cornerInner, styles.cornerGold]}>
              <Text style={[styles.cornerGlyph, { color: '#1A1204' }]}>⤡</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

// ─── The canvas ───────────────────────────────────────────────────

export function SpreadCanvas({ value, onChange, editable, height, onPickPhoto, onGestureActive }: {
  value: SpreadState;
  onChange: (next: SpreadState) => void;
  editable: boolean;
  height: number;
  /** Parent supplies photo picking/uploading; returns a URL or null. */
  onPickPhoto?: () => Promise<string | null>;
  /** Parent should pause its own scrolling while a canvas gesture runs. */
  onGestureActive?: (active: boolean) => void;
}) {
  const [selectedEl, setSelectedEl] = useState<string | null>(null);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [linkFrom, setLinkFrom] = useState<string | null>(null);
  const [dotTarget, setDotTarget] = useState<{ kind: 'el' | 'conn'; id: string } | null>(null);
  const [editTextId, setEditTextId] = useState<string | null>(null);
  const [editTextField, setEditTextField] = useState<EditField>('text');
  const [editTextValue, setEditTextValue] = useState('');
  const [viewSize, setViewSize] = useState({ w: 0, h: height });

  const valueRef = useRef(value); valueRef.current = value;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const linkFromRef = useRef(linkFrom); linkFromRef.current = linkFrom;
  const gestureActive = useCallback((a: boolean) => onGestureActive?.(a), [onGestureActive]);

  const patch = useCallback((updates: Partial<SpreadState>) => {
    onChangeRef.current({ ...valueRef.current, ...updates });
  }, []);

  const patchElement = useCallback((id: string, updates: Partial<SpreadElement>) => {
    patch({
      elements: valueRef.current.elements.map(e => (e.id === id ? { ...e, ...updates } : e)),
    });
  }, [patch]);

  // Background pan + pinch zoom (works for authors AND read-only viewers,
  // so anyone can roam the whole spread).
  const gesture = useRef({ panX: 0, panY: 0, zoom: 1, dist: 0, pinching: false });
  const bgPan = useRef(
    PanResponder.create({
      ...HOLD,
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (evt, gs) =>
        evt.nativeEvent.touches.length >= 2 || Math.abs(gs.dx) + Math.abs(gs.dy) > 6,
      onPanResponderGrant: () => {
        gestureActive(true);
        const v = valueRef.current;
        gesture.current = { panX: v.panX, panY: v.panY, zoom: v.zoom, dist: 0, pinching: false };
      },
      onPanResponderMove: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        if (touches.length >= 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.hypot(dx, dy);
          if (!gesture.current.pinching) {
            gesture.current.pinching = true;
            gesture.current.dist = dist;
            gesture.current.zoom = valueRef.current.zoom;
          } else if (gesture.current.dist > 0) {
            const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, gesture.current.zoom * (dist / gesture.current.dist)));
            patch({ zoom: z });
          }
        } else if (!gesture.current.pinching) {
          patch({
            panX: gesture.current.panX + gs.dx,
            panY: gesture.current.panY + gs.dy,
          });
        }
      },
      onPanResponderRelease: (_, gs) => {
        gestureActive(false);
        // Only a plain tap (no pan/pinch) clears selection / cancels linking.
        if (!gesture.current.pinching && Math.abs(gs.dx) + Math.abs(gs.dy) < 6) {
          setSelectedEl(null);
          setSelectedConn(null);
          setLinkFrom(null);
        }
      },
      onPanResponderTerminate: () => gestureActive(false),
    })
  ).current;

  // ── Element ops ──
  const addElement = useCallback(async (kind: ElementKind) => {
    let uri: string | undefined;
    if (kind === 'photo') {
      uri = (await onPickPhoto?.()) ?? undefined;
      if (!uri) return;
    }
    const v = valueRef.current;
    const size = DEFAULT_SIZES[kind];
    const maxZ = v.elements.reduce((m, e) => Math.max(m, e.z), 0);
    // Place at current viewport center.
    const cx = (viewSize.w / 2 - v.panX) / v.zoom;
    const cy = (height / 2 - v.panY) / v.zoom;
    const el: SpreadElement = {
      id: newId(), kind,
      x: cx - size.w / 2, y: cy - size.h / 2,
      w: size.w, h: size.h, rot: 0, z: maxZ + 1,
      text: '', uri, dot: null,
    };
    patch({ elements: [...v.elements, el] });
    setSelectedEl(el.id);
  }, [patch, onPickPhoto, viewSize.w, height]);

  const deleteElement = useCallback((id: string) => {
    const v = valueRef.current;
    patch({
      elements: v.elements.filter(e => e.id !== id),
      connectors: v.connectors.filter(c => c.fromId !== id && c.toId !== id),
    });
    setSelectedEl(cur => (cur === id ? null : cur));
  }, [patch]);

  const deleteConnector = useCallback(() => {
    if (!selectedConn) return;
    patch({ connectors: valueRef.current.connectors.filter(c => c.id !== selectedConn) });
    setSelectedConn(null);
  }, [patch, selectedConn]);

  const handleElementSelect = useCallback((id: string) => {
    if (linkFromRef.current && linkFromRef.current !== id) {
      const v = valueRef.current;
      const exists = v.connectors.some(c =>
        (c.fromId === linkFromRef.current && c.toId === id) ||
        (c.fromId === id && c.toId === linkFromRef.current));
      if (!exists) {
        patch({
          connectors: [...v.connectors, { id: newId(), fromId: linkFromRef.current!, toId: id, dot: null }],
        });
      }
      setLinkFrom(null);
      return;
    }
    // Selecting brings the element to the front (replaces the old ▲▼ arrows).
    const v = valueRef.current;
    const maxZ = v.elements.reduce((m, e) => Math.max(m, e.z), 0);
    const el = v.elements.find(e => e.id === id);
    if (el && el.z < maxZ) patchElement(id, { z: maxZ + 1 });
    setSelectedEl(id);
    setSelectedConn(null);
  }, [patch, patchElement]);

  const applyDot = useCallback((dot: DotColor | null) => {
    if (!dotTarget) return;
    const v = valueRef.current;
    if (dotTarget.kind === 'el') {
      patchElement(dotTarget.id, { dot });
    } else {
      patch({ connectors: v.connectors.map(c => (c.id === dotTarget.id ? { ...c, dot } : c)) });
    }
  }, [dotTarget, patch, patchElement]);

  const openTextEditor = useCallback((id: string, field: EditField = 'text') => {
    const el = valueRef.current.elements.find(e => e.id === id);
    if (!el) return;
    setEditTextField(field);
    setEditTextValue((field === 'text2' ? el.text2 : el.text) ?? '');
    setEditTextId(id);
  }, []);

  const pickPhotoFor = useCallback(async (id: string) => {
    const uri = await onPickPhoto?.();
    if (uri) patchElement(id, { uri });
  }, [onPickPhoto, patchElement]);

  const selected = value.elements.find(e => e.id === selectedEl) ?? null;

  // Canvas-space size for the SVG connector layer (covers all elements).
  const bounds = value.elements.reduce(
    (b, e) => ({
      maxX: Math.max(b.maxX, e.x + e.w + 200),
      maxY: Math.max(b.maxY, e.y + e.h + 200),
    }),
    { maxX: 1200, maxY: 1200 },
  );

  return (
    <View
      style={[styles.frame, { height }]}
      onLayout={e => setViewSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
    >
      {/* Board texture */}
      <View style={styles.board} {...bgPan.panHandlers}>
        <View
          style={{
            position: 'absolute', left: 0, top: 0, width: bounds.maxX, height: bounds.maxY,
            transform: [
              { translateX: value.panX },
              { translateY: value.panY },
              { scale: value.zoom },
            ],
            // scale from top-left so canvas coords stay simple
            transformOrigin: '0 0' as any,
          }}
        >
          {/* Connectors (under elements) */}
          <Svg width={bounds.maxX} height={bounds.maxY} style={StyleSheet.absoluteFill} pointerEvents="none">
            {value.connectors.map(c => {
              const from = value.elements.find(e => e.id === c.fromId);
              const to = value.elements.find(e => e.id === c.toId);
              if (!from || !to) return null;
              const f = center(from), t = center(to);
              const col = c.dot ? DOT_META[c.dot].color : 'rgba(200,60,50,0.85)';
              return (
                <React.Fragment key={c.id}>
                  <Line
                    x1={f.cx} y1={f.cy} x2={t.cx} y2={t.cy}
                    stroke={col} strokeWidth={selectedConn === c.id ? 3.5 : 2}
                  />
                  <Circle cx={f.cx} cy={f.cy} r={4} fill={col} />
                  <Circle cx={t.cx} cy={t.cy} r={4} fill={col} />
                </React.Fragment>
              );
            })}
          </Svg>
          {/* Connector midpoint tap targets */}
          {value.connectors.map(c => {
            const from = value.elements.find(e => e.id === c.fromId);
            const to = value.elements.find(e => e.id === c.toId);
            if (!from || !to) return null;
            const f = center(from), t = center(to);
            const mx = (f.cx + t.cx) / 2, my = (f.cy + t.cy) / 2;
            return (
              <TouchableOpacity
                key={c.id}
                style={[styles.connKnot, { left: mx - 11, top: my - 11 },
                  selectedConn === c.id && styles.connKnotSel]}
                onPress={() => { setSelectedConn(c.id); setSelectedEl(null); setLinkFrom(null); }}
              >
                {c.dot ? <StatusDot dot={c.dot} size={9} /> : <View style={styles.connKnotDot} />}
              </TouchableOpacity>
            );
          })}
          {/* Elements */}
          {[...value.elements].sort((a, b) => a.z - b.z).map(el => (
            <CanvasElement
              key={el.id}
              el={el}
              zoom={value.zoom}
              selected={selectedEl === el.id}
              editable={editable}
              onSelect={() => handleElementSelect(el.id)}
              onChange={u => patchElement(el.id, u)}
              onDelete={() => deleteElement(el.id)}
              onGestureActive={gestureActive}
              onField={(field, v) => patchElement(el.id, { [field]: v })}
              onPhoto={() => pickPhotoFor(el.id)}
            />
          ))}
        </View>
      </View>

      {/* Link-mode banner */}
      {linkFrom && (
        <View style={styles.linkBanner} pointerEvents="none">
          <Text style={styles.linkBannerText}>Tap another element to tie the string</Text>
        </View>
      )}

      {/* Selection toolbar */}
      {editable && (selected || selectedConn) && (
        <View style={styles.selBar}>
          {selected && (
            <>
              <TouchableOpacity style={styles.selBtn} onPress={() => openTextEditor(selected.id, 'text')}>
                <Text style={styles.selBtnText}>✎</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.selBtn} onPress={() => setLinkFrom(selected.id)}>
                <Text style={styles.selBtnText}>⛓</Text>
              </TouchableOpacity>
            </>
          )}
          <TouchableOpacity
            style={styles.selBtn}
            onPress={() => setDotTarget(
              selectedConn ? { kind: 'conn', id: selectedConn } : { kind: 'el', id: selected!.id })}
          >
            <View style={styles.dotBtnRing}>
              {(selectedConn
                ? value.connectors.find(c => c.id === selectedConn)?.dot
                : selected?.dot)
                ? <StatusDot dot={(selectedConn
                    ? value.connectors.find(c => c.id === selectedConn)?.dot
                    : selected?.dot) as DotColor} size={10} />
                : null}
            </View>
          </TouchableOpacity>
          {selectedConn && (
            <TouchableOpacity style={styles.selBtn} onPress={deleteConnector}>
              <Text style={[styles.selBtnText, { color: '#E05555' }]}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Dot picker for read-only viewers is disabled; owners tag freely */}
      {!editable && (selected || selectedConn) && (
        <View style={styles.selBar}>
          <Text style={styles.readOnlyHint}>
            {selectedConn
              ? (value.connectors.find(c => c.id === selectedConn)?.dot
                  ? DOT_META[value.connectors.find(c => c.id === selectedConn)!.dot as DotColor].label
                  : 'String')
              : (selected?.dot ? DOT_META[selected.dot].label : 'Untagged')}
          </Text>
        </View>
      )}

      {/* Palette — horizontally scrollable so all five elements fit */}
      {editable && (
        <View style={styles.paletteWrap} pointerEvents="box-none">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.palette}
          >
            {PALETTE.map(p => (
              <TouchableOpacity key={p.kind} style={styles.paletteBtn} onPress={() => addElement(p.kind)}>
                <Text style={styles.paletteText}>{p.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      <DotPickerModal
        visible={!!dotTarget}
        onClose={() => setDotTarget(null)}
        onPick={applyDot}
        current={dotTarget?.kind === 'el'
          ? value.elements.find(e => e.id === dotTarget.id)?.dot
          : value.connectors.find(c => c.id === dotTarget?.id)?.dot}
      />

      {/* Text editor modal */}
      <Modal visible={!!editTextId} transparent animationType="fade" onRequestClose={() => setEditTextId(null)}>
        <View style={styles.textBackdrop}>
          <View style={styles.textSheet}>
            <Text style={styles.textTitle}>
              {editTextField === 'text2'
                ? 'More Context'
                : value.elements.find(e => e.id === editTextId)?.kind === 'photo' ? 'Caption' : 'Edit'}
            </Text>
            <TextInput
              style={styles.textInput}
              value={editTextValue}
              onChangeText={setEditTextValue}
              multiline
              autoFocus
              placeholder="Write…"
              placeholderTextColor="rgba(200,165,60,0.4)"
              selectionColor={GOLD}
            />
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <TouchableOpacity style={styles.textBtn} onPress={() => setEditTextId(null)}>
                <Text style={styles.textBtnLabel}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.textBtn, styles.textBtnPrimary]}
                onPress={() => {
                  if (editTextId) patchElement(editTextId, { [editTextField]: editTextValue });
                  setEditTextId(null);
                }}
              >
                <Text style={[styles.textBtnLabel, { color: '#FFD700' }]}>Set</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 8,
    overflow: 'hidden', backgroundColor: '#120E06',
  },
  board: { flex: 1 },

  body: { flex: 1, borderRadius: 3, overflow: 'hidden' },
  // Ante-card-style embedded input bars.
  regionInputWrap: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 5, borderWidth: 1, borderColor: 'rgba(200,165,60,0.5)',
    overflow: 'hidden',
  },
  regionInput: {
    flex: 1, color: CREAM, fontFamily: 'Cinzel_400Regular',
    paddingHorizontal: 4, paddingVertical: 3,
  },
  regionPhotoWell: {
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 5, borderWidth: 1, borderColor: 'rgba(200,165,60,0.5)',
    overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
  },
  regionPhotoActive: { overflow: 'hidden', borderRadius: 5 },
  regionPhotoHint: {
    color: 'rgba(237,224,196,0.5)', fontFamily: 'Cinzel_400Regular', textAlign: 'center',
  },

  elDot: { position: 'absolute', top: HANDLE_PAD - 5, right: HANDLE_PAD - 5 },
  selBorder: {
    position: 'absolute',
    left: HANDLE_PAD - 3, top: HANDLE_PAD - 3, right: HANDLE_PAD - 3, bottom: HANDLE_PAD - 3,
    borderWidth: 1.5, borderColor: '#FFD700', borderStyle: 'dashed', borderRadius: 3,
  },
  corner: {
    position: 'absolute', width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center', zIndex: 5,
  },
  cornerInner: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  cornerGold: { backgroundColor: '#FFD700', borderColor: '#5A4A10' },
  cornerDelete: { backgroundColor: '#2A0A0A', borderColor: '#E05555' },
  cornerGlyph: { fontSize: 13, color: '#E05555', fontWeight: '700' as const },

  connKnot: {
    position: 'absolute', width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(10,7,0,0.85)', borderWidth: 1, borderColor: 'rgba(212,168,83,0.5)',
    alignItems: 'center', justifyContent: 'center',
  },
  connKnotSel: { borderColor: '#FFD700', borderWidth: 1.5 },
  connKnotDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: 'rgba(200,60,50,0.9)' },

  linkBanner: {
    position: 'absolute', top: 10, alignSelf: 'center',
    backgroundColor: 'rgba(5,3,0,0.9)', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(255,215,0,0.5)',
  },
  linkBannerText: { fontSize: 11, color: '#FFD700', fontFamily: 'Inter_500Medium' },

  selBar: {
    position: 'absolute', bottom: 54, alignSelf: 'center', flexDirection: 'row',
    backgroundColor: 'rgba(5,3,0,0.92)', borderRadius: 14, padding: 5, gap: 2,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  selBtn: { width: 38, height: 34, alignItems: 'center', justifyContent: 'center', borderRadius: 9 },
  selBtnText: { fontSize: 16, color: GOLD },
  dotBtnRing: {
    width: 18, height: 18, borderRadius: 9, borderWidth: 1.3, borderColor: 'rgba(212,168,83,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  readOnlyHint: { fontSize: 11, color: CREAM, fontFamily: 'Inter_400Regular', paddingHorizontal: 12, paddingVertical: 7 },

  paletteWrap: { position: 'absolute', bottom: 8, left: 0, right: 0 },
  palette: { flexDirection: 'row', gap: 6, paddingHorizontal: 8, flexGrow: 1, justifyContent: 'center' },
  paletteBtn: {
    backgroundColor: 'rgba(5,3,0,0.9)', borderRadius: 10, paddingHorizontal: 11, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.4)',
  },
  paletteText: { fontSize: 10, color: GOLD, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 1 },

  textBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'center', padding: 24 },
  textSheet: {
    backgroundColor: '#0E0900', borderRadius: 14, padding: 18, gap: 12,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  textTitle: {
    fontSize: 12, color: GOLD, fontFamily: 'Cinzel_700Bold', letterSpacing: 3,
    textTransform: 'uppercase', textAlign: 'center',
  },
  textInput: {
    minHeight: 90, maxHeight: 180, backgroundColor: 'rgba(200,165,60,0.07)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', borderRadius: 8,
    color: CREAM, padding: 12, fontSize: 14, fontFamily: 'Inter_400Regular',
    textAlignVertical: 'top',
  },
  textBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 9,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
  },
  textBtnPrimary: { borderColor: 'rgba(255,215,0,0.55)', backgroundColor: 'rgba(255,215,0,0.08)' },
  textBtnLabel: { fontSize: 12, color: GOLD, fontFamily: 'Cinzel_600SemiBold', letterSpacing: 1.5 },
});
