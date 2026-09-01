// ── Protected Recruit/Verdict viewer ─────────────────────────────────────────
// Full-screen, view-only, in-app viewer for a published post (or a reference
// example / preview). No download, save, print, copy or share controls; photo
// bytes come through the authenticated protected fetch (never a plain URL);
// a dynamic per-member watermark is overlaid the whole time.

import React, { useMemo } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, ScrollView, Dimensions, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@/components/FIcon';
import { DesignElement, RecruitSection } from '@/lib/recruitService';
import PostCanvas from './PostCanvas';
import { VaultWatermark } from '@/components/vault/VaultViewer';
import { appWindow } from '@/lib/appWindow';

const CREAM = '#EDE0C4';
const GOLD  = '#D4A853';

export interface RecruitViewerProps {
  visible: boolean;
  onClose: () => void;
  section: RecruitSection;
  elements: DesignElement[];
  /** blank design background vs completed reference example */
  template?: 'blank' | 'example';
  title?: string;
  /** e.g. "RECRUIT ACCESS — ID 14-54"; omit to hide the watermark (admin previews still pass one). */
  watermark?: string;
  /** Small notice under the title bar. */
  notice?: string;
}

export default function RecruitViewer({
  visible, onClose, section, elements, template = 'blank', title, watermark, notice,
}: RecruitViewerProps) {
  const insets = useSafeAreaInsets();
  const { width: SW, height: SH } = appWindow();
  // Fit the 2:3 page into the screen, leaving room for the header.
  const maxW = SW - 16;
  const maxH = SH - insets.top - insets.bottom - 90;
  const pageW = Math.min(maxW, maxH * (1024 / 1536));

  const webProtect: any = useMemo(() => Platform.OS === 'web'
    ? { onContextMenu: (e: any) => e.preventDefault() } : {}, []);

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={[st.root, { paddingTop: insets.top }]} {...webProtect}>
        <View style={st.header}>
          <Text style={st.title} numberOfLines={1}>{title ?? (section === 'recruit' ? 'RECRUIT' : 'VERDICT')}</Text>
          <TouchableOpacity onPress={onClose} style={st.close} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <Feather name="x" size={22} color={CREAM} />
          </TouchableOpacity>
        </View>
        {notice ? <Text style={st.notice}>{notice}</Text> : null}
        <ScrollView
          contentContainerStyle={st.scroll}
          maximumZoomScale={3}
          minimumZoomScale={1}
          showsVerticalScrollIndicator={false}
        >
          <View style={st.pageWrap}>
            <PostCanvas section={section} elements={elements} width={pageW} template={template} />
          </View>
        </ScrollView>
        {watermark ? <VaultWatermark label={watermark} /> : null}
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: 'rgba(5,4,3,0.98)' },
  header: {
    height: 48, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16,
  },
  title: {
    flex: 1, color: GOLD, fontFamily: 'Cinzel_700Bold', fontSize: 15, letterSpacing: 2,
  },
  close: { padding: 4 },
  notice: {
    color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_400Regular', fontSize: 11,
    textAlign: 'center', marginBottom: 6, letterSpacing: 0.5,
  },
  scroll: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  pageWrap: {
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)',
    shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 18, shadowOffset: { width: 0, height: 8 },
  },
});
