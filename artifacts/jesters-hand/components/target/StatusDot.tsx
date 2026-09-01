// Five-color status dot system shared by document fields, canvas elements,
// and connectors. `StatusDot` renders a dot; `DotPickerModal` is the popup
// color menu; `DotLegend` renders the key.
import React from 'react';
import { View, Text, TouchableOpacity, Modal, StyleSheet } from 'react-native';
import { DOT_META, DOT_ORDER, DotColor } from '@/lib/targetTicketService';

export function StatusDot({ dot, size = 12 }: { dot: DotColor | null | undefined; size?: number }) {
  if (!dot) return null;
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: DOT_META[dot].color,
        borderWidth: 1, borderColor: 'rgba(245,232,200,0.55)',
      }}
    />
  );
}

/** Small empty circle used as the "tag me" affordance on fields. */
export function DotSlot({ dot, onPress, size = 16 }: {
  dot: DotColor | null | undefined;
  onPress: () => void;
  size?: number;
}) {
  return (
    <TouchableOpacity onPress={onPress} hitSlop={8} activeOpacity={0.7}>
      {dot ? (
        <StatusDot dot={dot} size={size} />
      ) : (
        <View style={{
          width: size, height: size, borderRadius: size / 2,
          borderWidth: 1.2, borderColor: 'rgba(212,168,83,0.5)',
        }} />
      )}
    </TouchableOpacity>
  );
}

export function DotPickerModal({ visible, onClose, onPick, current }: {
  visible: boolean;
  onClose: () => void;
  onPick: (dot: DotColor | null) => void;
  current?: DotColor | null;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Status</Text>
          {DOT_ORDER.map(d => (
            <TouchableOpacity
              key={d}
              style={[styles.row, current === d && styles.rowActive]}
              onPress={() => { onPick(d); onClose(); }}
            >
              <StatusDot dot={d} size={14} />
              <Text style={styles.rowText}>{DOT_META[d].label}</Text>
            </TouchableOpacity>
          ))}
          {current ? (
            <TouchableOpacity style={styles.row} onPress={() => { onPick(null); onClose(); }}>
              <View style={styles.clearDot} />
              <Text style={[styles.rowText, { color: 'rgba(245,232,200,0.5)' }]}>Clear</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

export function DotLegend() {
  return (
    <View style={styles.legend}>
      {DOT_ORDER.map(d => (
        <View key={d} style={styles.legendItem}>
          <StatusDot dot={d} size={9} />
          <Text style={styles.legendText}>{DOT_META[d].label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center', justifyContent: 'center',
  },
  sheet: {
    backgroundColor: '#0E0900', borderRadius: 14, padding: 14, minWidth: 220,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.35)', gap: 2,
  },
  title: {
    fontSize: 11, color: '#D4A853', fontFamily: 'Cinzel_700Bold',
    letterSpacing: 3, textTransform: 'uppercase', textAlign: 'center', marginBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, paddingHorizontal: 10, borderRadius: 8,
  },
  rowActive: { backgroundColor: 'rgba(212,168,83,0.12)' },
  rowText: { color: '#F5E8C8', fontSize: 13, fontFamily: 'Cinzel_400Regular', letterSpacing: 0.5 },
  clearDot: {
    width: 14, height: 14, borderRadius: 7,
    borderWidth: 1.2, borderColor: 'rgba(245,232,200,0.35)',
  },
  legend: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
    paddingHorizontal: 4, paddingVertical: 6,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendText: { fontSize: 8.5, color: 'rgba(245,232,200,0.6)', fontFamily: 'Inter_400Regular' },
});
