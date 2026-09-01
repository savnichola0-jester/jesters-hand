// ── PostCanvas ────────────────────────────────────────────────────────────────
// Pure renderer for a Recruit/Verdict design: template background + text and
// photo elements, laid out in the 1024×1536 design space and scaled to any
// width. Used by list cards (small), the member viewer (full screen) and the
// editor (interactive layer drawn on top by RecruitEditor).

import React, { useEffect, useState } from 'react';
import { View, Text, Image, StyleSheet, Platform } from 'react-native';
import {
  DESIGN_W, DESIGN_H, DesignElement, TextElement, PhotoElement, FontKey,
  RecruitSection, getRecruitPhotoUri,
} from '@/lib/recruitService';

export const TEMPLATE_IMAGES: Record<RecruitSection, { blank: any; example: any }> = {
  recruit: {
    blank: require('../../assets/images/recruit/recruit_blank.png'),
    example: require('../../assets/images/recruit/recruit_example.png'),
  },
  verdict: {
    blank: require('../../assets/images/recruit/verdict_blank.png'),
    example: require('../../assets/images/recruit/verdict_example.png'),
  },
};

// The four editorial font families. Bold/italic map to real variants where
// the family provides them; unavailable variants fall back to regular.
export const FONT_FAMILIES: Record<FontKey, {
  label: string;
  regular: string; bold?: string; italic?: string; boldItalic?: string;
}> = {
  serif: {
    label: 'Newspaper Serif',
    regular: 'PlayfairDisplay_400Regular',
    bold: 'PlayfairDisplay_700Bold',
    italic: 'PlayfairDisplay_400Regular_Italic',
    boldItalic: 'PlayfairDisplay_700Bold_Italic',
  },
  headline: {
    label: 'Condensed Headline',
    regular: 'Oswald_400Regular',
    bold: 'Oswald_700Bold',
  },
  typewriter: {
    label: 'Typewriter',
    regular: 'SpecialElite_400Regular',
  },
  editorial: {
    label: 'Classic Editorial',
    regular: 'EBGaramond_400Regular',
    bold: 'EBGaramond_700Bold',
    italic: 'EBGaramond_400Regular_Italic',
    boldItalic: 'EBGaramond_700Bold_Italic',
  },
};

export function fontFamilyFor(el: Pick<TextElement, 'font' | 'bold' | 'italic'>): string {
  const fam = FONT_FAMILIES[el.font] ?? FONT_FAMILIES.serif;
  if (el.bold && el.italic && fam.boldItalic) return fam.boldItalic;
  if (el.bold && fam.bold) return fam.bold;
  if (el.italic && fam.italic) return fam.italic;
  return fam.regular;
}

// Anti-save props for web: block drag-to-save & long-press context menu.
const WEB_IMG_PROTECT: any = Platform.OS === 'web'
  ? { draggable: false, onContextMenu: (e: any) => e.preventDefault() }
  : {};

/** Resolves a photo element to a displayable uri (local while editing, else
 *  authenticated protected fetch → data uri; never a plain storage URL). */
function usePhotoUri(el: PhotoElement): string | null {
  const [uri, setUri] = useState<string | null>(el.localUri ?? null);
  useEffect(() => {
    let live = true;
    if (el.localUri) { setUri(el.localUri); return; }
    if (!el.path) { setUri(null); return; }
    getRecruitPhotoUri(el.path)
      .then(u => { if (live) setUri(u); })
      .catch(() => { if (live) setUri(null); });
    return () => { live = false; };
  }, [el.localUri, el.path]);
  return uri;
}

function PhotoLayer({ el, scale }: { el: PhotoElement; scale: number }) {
  const uri = usePhotoUri(el);
  return (
    <View
      style={{
        position: 'absolute',
        left: el.x * scale, top: el.y * scale,
        width: el.w * scale, height: el.h * scale,
        transform: [{ rotate: `${el.rot}deg` }],
        overflow: 'hidden',
        backgroundColor: uri ? 'transparent' : 'rgba(0,0,0,0.25)',
      }}
      pointerEvents="none"
    >
      {uri ? (
        <Image
          source={{ uri }}
          {...WEB_IMG_PROTECT}
          style={{
            position: 'absolute',
            left: (el.imgDX - (el.imgScale - 1) * el.w / 2) * scale,
            top: (el.imgDY - (el.imgScale - 1) * el.h / 2) * scale,
            width: el.w * el.imgScale * scale,
            height: el.h * el.imgScale * scale,
            ...(Platform.OS === 'web' ? { userSelect: 'none' as any, pointerEvents: 'none' as any } : {}),
          }}
          resizeMode="cover"
        />
      ) : null}
    </View>
  );
}

function TextLayer({ el, scale }: { el: TextElement; scale: number }) {
  return (
    <View
      style={{
        position: 'absolute',
        left: el.x * scale, top: el.y * scale,
        width: el.w * scale, height: el.h * scale,
        transform: [{ rotate: `${el.rot}deg` }],
        justifyContent: 'center',
      }}
      pointerEvents="none"
    >
      <Text
        style={{
          fontFamily: fontFamilyFor(el),
          fontSize: el.size * scale,
          color: el.color,
          textAlign: el.align,
          lineHeight: el.size * el.lineSpacing * scale,
          letterSpacing: el.letterSpacing * scale,
          ...(Platform.OS === 'web' ? { userSelect: 'none' as any } : {}),
        }}
      >
        {el.uppercase ? el.text.toUpperCase() : el.text}
      </Text>
    </View>
  );
}

export interface PostCanvasProps {
  section: RecruitSection;
  elements: DesignElement[];
  width: number;
  /** Which template image to draw underneath. Defaults to the blank. */
  template?: 'blank' | 'example';
  /** Hide the elements (used to show a bare template card). */
  hideElements?: boolean;
}

export default function PostCanvas({ section, elements, width, template = 'blank', hideElements }: PostCanvasProps) {
  const scale = width / DESIGN_W;
  const height = DESIGN_H * scale;
  const sorted = [...elements].sort((a, b) => a.z - b.z);
  return (
    <View style={{ width, height, backgroundColor: '#151210', overflow: 'hidden' }} pointerEvents="none">
      <Image
        source={TEMPLATE_IMAGES[section][template]}
        {...WEB_IMG_PROTECT}
        style={[StyleSheet.absoluteFill as any, { width, height },
          Platform.OS === 'web' ? { userSelect: 'none' as any, pointerEvents: 'none' as any } : null]}
        resizeMode="cover"
      />
      {!hideElements && sorted.map(el =>
        el.type === 'text'
          ? <TextLayer key={el.id} el={el} scale={scale} />
          : <PhotoLayer key={el.id} el={el} scale={scale} />)}
    </View>
  );
}
