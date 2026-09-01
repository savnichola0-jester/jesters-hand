import React, { useRef } from 'react';
import { View, PanResponder, StyleSheet } from 'react-native';

export interface ElementData {
  id: string;
  type: 'jokerInput' | 'cipherInput' | 'takeSeatBtn' | 'image' | 'text';
  x: number;
  y: number;
  width: number;
  height: number;
  uri?: string;
  text?: string;
  fontSize?: number;
  color?: string;
}

// Extra space added around the wrapper so corner handles sit fully inside
// the touchable bounds of the parent view.
const PAD = 12;
const HANDLE = 20; // tap target size
const MIN_W = 60;
const MIN_H = 28;

interface ResizeHandleProps {
  corner: 'tl' | 'tr' | 'bl' | 'br';
  element: ElementData;
  onUpdate: (updates: Partial<ElementData>) => void;
}

function ResizeHandle({ corner, element, onUpdate }: ResizeHandleProps) {
  const elementRef = useRef(element);
  const onUpdateRef = useRef(onUpdate);
  elementRef.current = element;
  onUpdateRef.current = onUpdate;

  const baseState = useRef({ x: 0, y: 0, w: 0, h: 0 });

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Prevent parent drag from stealing while we resize
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        const el = elementRef.current;
        baseState.current = { x: el.x, y: el.y, w: el.width, h: el.height };
      },
      onPanResponderMove: (_, gs) => {
        const { x: bx, y: by, w: bw, h: bh } = baseState.current;
        let newX = bx, newY = by, newW = bw, newH = bh;

        if (corner === 'tl') {
          newX = bx + Math.min(gs.dx, bw - MIN_W);
          newY = by + Math.min(gs.dy, bh - MIN_H);
          newW = Math.max(MIN_W, bw - gs.dx);
          newH = Math.max(MIN_H, bh - gs.dy);
        } else if (corner === 'tr') {
          newY = by + Math.min(gs.dy, bh - MIN_H);
          newW = Math.max(MIN_W, bw + gs.dx);
          newH = Math.max(MIN_H, bh - gs.dy);
        } else if (corner === 'bl') {
          newX = bx + Math.min(gs.dx, bw - MIN_W);
          newW = Math.max(MIN_W, bw - gs.dx);
          newH = Math.max(MIN_H, bh + gs.dy);
        } else {
          newW = Math.max(MIN_W, bw + gs.dx);
          newH = Math.max(MIN_H, bh + gs.dy);
        }

        onUpdateRef.current({ x: newX, y: newY, width: newW, height: newH });
      },
      onPanResponderRelease: () => {},
    })
  ).current;

  // Handles live inside the padded wrapper, so place them at the corners
  // of the padded area (not with negative offsets).
  const posStyle =
    corner === 'tl' ? { top: PAD - HANDLE / 2, left: PAD - HANDLE / 2 }
    : corner === 'tr' ? { top: PAD - HANDLE / 2, right: PAD - HANDLE / 2 }
    : corner === 'bl' ? { bottom: PAD - HANDLE / 2, left: PAD - HANDLE / 2 }
    : { bottom: PAD - HANDLE / 2, right: PAD - HANDLE / 2 };

  return (
    <View
      {...panResponder.panHandlers}
      style={[styles.handle, posStyle]}
    />
  );
}

interface DraggableElementProps {
  element: ElementData;
  isSelected: boolean;
  onSelect: () => void;
  onUpdate: (updates: Partial<ElementData>) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  children: React.ReactNode;
}

export function DraggableElement({
  element,
  isSelected,
  onSelect,
  onUpdate,
  onDragStart,
  onDragEnd,
  children,
}: DraggableElementProps) {
  const elementRef = useRef(element);
  const onSelectRef = useRef(onSelect);
  const onUpdateRef = useRef(onUpdate);
  const onDragStartRef = useRef(onDragStart);
  const onDragEndRef = useRef(onDragEnd);
  elementRef.current = element;
  onSelectRef.current = onSelect;
  onUpdateRef.current = onUpdate;
  onDragStartRef.current = onDragStart;
  onDragEndRef.current = onDragEnd;

  const basePos = useRef({ x: 0, y: 0 });
  const isDragging = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, gs) =>
        Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponderCapture: () => false,
      onPanResponderGrant: () => {
        basePos.current = { x: elementRef.current.x, y: elementRef.current.y };
        onSelectRef.current();
        isDragging.current = false;
      },
      onPanResponderMove: (_, gs) => {
        if (!isDragging.current) {
          isDragging.current = true;
          onDragStartRef.current?.();
        }
        onUpdateRef.current({
          x: basePos.current.x + gs.dx,
          y: basePos.current.y + gs.dy,
        });
      },
      onPanResponderRelease: () => {
        if (isDragging.current) onDragEndRef.current?.();
        isDragging.current = false;
      },
    })
  ).current;

  // The outer wrapper is PAD larger on every side so the corner handles
  // are fully inside its bounds and receive touch events correctly.
  return (
    <View
      {...panResponder.panHandlers}
      style={[
        styles.outerWrapper,
        {
          left: element.x - PAD,
          top: element.y - PAD,
          width: element.width + PAD * 2,
          height: element.height + PAD * 2,
        },
      ]}
    >
      {/* Inner frame that matches the actual element size */}
      <View
        style={[
          styles.innerFrame,
          {
            left: PAD,
            top: PAD,
            width: element.width,
            height: element.height,
            borderColor: isSelected ? '#FFD700' : 'rgba(212,168,83,0.45)',
            borderWidth: isSelected ? 2 : 1,
          },
        ]}
        pointerEvents="none"
      >
        {children}
      </View>

      {isSelected && (
        <>
          <ResizeHandle corner="tl" element={element} onUpdate={onUpdate} />
          <ResizeHandle corner="tr" element={element} onUpdate={onUpdate} />
          <ResizeHandle corner="bl" element={element} onUpdate={onUpdate} />
          <ResizeHandle corner="br" element={element} onUpdate={onUpdate} />
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrapper: {
    position: 'absolute',
    // transparent — just a touch-capture region
  },
  innerFrame: {
    position: 'absolute',
    borderStyle: 'dashed',
    borderRadius: 4,
    overflow: 'hidden',
  },
  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    borderRadius: HANDLE / 2,
    backgroundColor: '#FFD700',
    borderWidth: 2.5,
    borderColor: '#1A0D00',
    zIndex: 300,
  },
});
