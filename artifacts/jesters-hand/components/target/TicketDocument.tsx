// The structured "document" half of a Target Ticket — editable (creation)
// or read-only (detail view). Field-level status dots share the same
// five-color system as the Spread canvas.
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import {
  TicketDraft, TicketFieldKey, Suit, SUIT_LABELS, DotColor, EvidenceEntry,
} from '@/lib/targetTicketService';
import { SuitIcon } from './SuitIcon';
import { DotSlot, DotPickerModal, StatusDot } from './StatusDot';

const GOLD = '#D4A853';
const CREAM = '#EDE0C4';
const SUITS: Suit[] = ['spade', 'diamond', 'heart', 'club'];

// Half-redacted look for empty evidence/contradiction fields.
function RedactionBars() {
  return (
    <View style={styles.redaction} pointerEvents="none">
      <View style={[styles.redactBar, { width: '72%' }]} />
      <View style={[styles.redactBar, { width: '88%', marginLeft: '8%' }]} />
      <View style={[styles.redactBar, { width: '55%' }]} />
    </View>
  );
}

function FieldHeader({ label, dot, onDot }: {
  label: string;
  dot?: DotColor | null;
  onDot?: () => void;
}) {
  return (
    <View style={styles.fieldHeader}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {onDot
        ? <DotSlot dot={dot} onPress={onDot} size={15} />
        : dot ? <StatusDot dot={dot} size={15} /> : null}
    </View>
  );
}

function Stars({ value, onChange }: { value: number; onChange?: (v: number) => void }) {
  return (
    <View style={styles.stars}>
      {[1, 2, 3, 4, 5].map(i => (
        <TouchableOpacity
          key={i}
          disabled={!onChange}
          onPress={() => onChange?.(value === i ? i - 1 : i)}
          hitSlop={6}
        >
          <Text style={[styles.star, i <= value && styles.starOn]}>★</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export function TicketDocument({ draft, onChange, editable }: {
  draft: TicketDraft;
  onChange?: (next: TicketDraft) => void;
  editable: boolean;
}) {
  const [dotField, setDotField] = useState<TicketFieldKey | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const set = (updates: Partial<TicketDraft>) => onChange?.({ ...draft, ...updates });
  const setEvidence = (i: number, updates: Partial<EvidenceEntry>) =>
    set({ evidence: draft.evidence.map((e, j) => (j === i ? { ...e, ...updates } : e)) });

  const dotFor = (k: TicketFieldKey) => draft.fieldDots[k] ?? null;
  const openDot = (k: TicketFieldKey) => (editable ? () => setDotField(k) : undefined);

  const evidenceEmpty = draft.evidence.every(e => !e.text.trim() && !e.source.trim());
  const contradictionsEmpty = !draft.contradictions.trim();

  return (
    <View style={styles.wrap}>
      {/* Target / Subject */}
      <FieldHeader label="Target / Subject" dot={dotFor('target')} onDot={openDot('target')} />
      {editable ? (
        <TextInput
          style={styles.input}
          value={draft.target}
          onChangeText={t => set({ target: t })}
          placeholder="Which character, event, or mystery…"
          placeholderTextColor="rgba(200,165,60,0.35)"
          selectionColor={GOLD}
        />
      ) : (
        <Text style={styles.readText}>{draft.target || '—'}</Text>
      )}

      {/* Suit / Category */}
      <FieldHeader label="Suit" dot={dotFor('suit')} onDot={openDot('suit')} />
      <View style={styles.suitRow}>
        {SUITS.map(su => {
          const active = draft.suit === su;
          return (
            <TouchableOpacity
              key={su}
              style={[styles.suitBtn, active && styles.suitBtnActive]}
              disabled={!editable}
              onPress={() => set({ suit: su })}
              activeOpacity={0.8}
            >
              <SuitIcon suit={su} size={20} color={active ? '#FFD700' : 'rgba(212,168,83,0.55)'} />
              <Text style={[styles.suitLabel, active && styles.suitLabelActive]} numberOfLines={2}>
                {SUIT_LABELS[su]}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Supporting Evidence */}
      <FieldHeader label="Supporting Evidence" dot={dotFor('evidence')} onDot={openDot('evidence')} />
      <View>
        {draft.evidence.map((e, i) => (
          <View key={i} style={styles.evidenceEntry}>
            {editable ? (
              <>
                <TextInput
                  style={[styles.input, styles.area]}
                  value={e.text}
                  onChangeText={t => setEvidence(i, { text: t })}
                  onFocus={() => setFocusKey(`ev${i}`)}
                  onBlur={() => setFocusKey(null)}
                  placeholder={`Evidence ${i + 1}…`}
                  placeholderTextColor="rgba(200,165,60,0.35)"
                  multiline
                  selectionColor={GOLD}
                />
                <TextInput
                  style={[styles.input, styles.sourceInput]}
                  value={e.source}
                  onChangeText={t => setEvidence(i, { source: t })}
                  onFocus={() => setFocusKey(`ev${i}`)}
                  onBlur={() => setFocusKey(null)}
                  placeholder="Book & Chapter/Page"
                  placeholderTextColor="rgba(200,165,60,0.35)"
                  selectionColor={GOLD}
                />
                {draft.evidence.length > 1 && (
                  <TouchableOpacity
                    style={styles.removeEntry}
                    onPress={() => set({ evidence: draft.evidence.filter((_, j) => j !== i) })}
                  >
                    <Text style={styles.removeEntryText}>✕</Text>
                  </TouchableOpacity>
                )}
              </>
            ) : (
              <>
                <Text style={styles.readText}>{e.text || '—'}</Text>
                {e.source ? <Text style={styles.readSource}>{e.source}</Text> : null}
              </>
            )}
          </View>
        ))}
        {editable && evidenceEmpty && focusKey?.startsWith('ev') !== true && <RedactionBars />}
      </View>
      {editable && (
        <TouchableOpacity
          style={styles.addEntry}
          onPress={() => set({ evidence: [...draft.evidence, { text: '', source: '' }] })}
        >
          <Text style={styles.addEntryText}>+ Add evidence</Text>
        </TouchableOpacity>
      )}

      {/* Character Connections */}
      <FieldHeader label="Character Connections" dot={dotFor('connections')} onDot={openDot('connections')} />
      {editable ? (
        <TextInput
          style={[styles.input, styles.area]}
          value={draft.connections}
          onChangeText={t => set({ connections: t })}
          placeholder="Who's involved, how they relate…"
          placeholderTextColor="rgba(200,165,60,0.35)"
          multiline
          selectionColor={GOLD}
        />
      ) : (
        <Text style={styles.readText}>{draft.connections || '—'}</Text>
      )}

      {/* Contradicting Evidence */}
      <FieldHeader label="Contradicting Evidence" dot={dotFor('contradictions')} onDot={openDot('contradictions')} />
      <View>
        {editable ? (
          <TextInput
            style={[styles.input, styles.area]}
            value={draft.contradictions}
            onChangeText={t => set({ contradictions: t })}
            onFocus={() => setFocusKey('contra')}
            onBlur={() => setFocusKey(null)}
            placeholder="What doesn't fit the theory yet…"
            placeholderTextColor="rgba(200,165,60,0.35)"
            multiline
            selectionColor={GOLD}
          />
        ) : (
          <Text style={styles.readText}>{draft.contradictions || '—'}</Text>
        )}
        {editable && contradictionsEmpty && focusKey !== 'contra' && <RedactionBars />}
      </View>

      {/* Confidence */}
      <FieldHeader label="Confidence Level" dot={dotFor('confidence')} onDot={openDot('confidence')} />
      <Stars value={draft.confidence} onChange={editable ? v => set({ confidence: v }) : undefined} />

      <DotPickerModal
        visible={!!dotField}
        onClose={() => setDotField(null)}
        current={dotField ? dotFor(dotField) : null}
        onPick={d => {
          if (!dotField) return;
          const next = { ...draft.fieldDots };
          if (d) next[dotField] = d; else delete next[dotField];
          set({ fieldDots: next });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  fieldHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 14, marginBottom: 6,
  },
  fieldLabel: {
    fontSize: 10.5, color: GOLD, fontFamily: 'Cinzel_700Bold',
    letterSpacing: 2.5, textTransform: 'uppercase',
  },
  input: {
    backgroundColor: 'rgba(200,165,60,0.06)',
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.3)', borderRadius: 7,
    color: CREAM, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 13.5, fontFamily: 'Inter_400Regular',
  },
  area: { minHeight: 72, textAlignVertical: 'top' },
  readText: { color: CREAM, fontSize: 13.5, fontFamily: 'Inter_400Regular', lineHeight: 19 },
  readSource: {
    color: 'rgba(212,168,83,0.8)', fontSize: 11.5, fontFamily: 'Inter_500Medium',
    marginTop: 3, fontStyle: 'italic',
  },

  suitRow: { flexDirection: 'row', gap: 6 },
  suitBtn: {
    flex: 1, alignItems: 'center', gap: 4, paddingVertical: 9, paddingHorizontal: 3,
    borderWidth: 1, borderColor: 'rgba(212,168,83,0.25)', borderRadius: 8,
    backgroundColor: 'rgba(200,165,60,0.04)',
  },
  suitBtnActive: { borderColor: 'rgba(255,215,0,0.7)', backgroundColor: 'rgba(255,215,0,0.08)' },
  suitLabel: {
    fontSize: 7.5, color: 'rgba(237,224,196,0.55)', fontFamily: 'Inter_500Medium',
    textAlign: 'center', lineHeight: 10,
  },
  suitLabelActive: { color: CREAM },

  evidenceEntry: { marginBottom: 8, gap: 6 },
  sourceInput: { fontSize: 12, paddingVertical: 8 },
  removeEntry: { position: 'absolute', top: 6, right: 8 },
  removeEntryText: { color: 'rgba(224,85,85,0.8)', fontSize: 13 },
  addEntry: { alignSelf: 'flex-start', marginTop: 2 },
  addEntryText: { color: GOLD, fontSize: 12, fontFamily: 'Inter_500Medium' },

  redaction: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center', gap: 7, paddingHorizontal: 14,
  },
  redactBar: { height: 11, backgroundColor: 'rgba(5,5,5,0.92)', borderRadius: 2 },

  stars: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  star: { fontSize: 26, color: 'rgba(212,168,83,0.28)' },
  starOn: { color: '#FFD700' },
});
