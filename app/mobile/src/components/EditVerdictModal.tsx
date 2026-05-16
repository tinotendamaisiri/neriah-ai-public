// src/components/EditVerdictModal.tsx
// Bottom-sheet (full-screen on small phones) editor for a single verdict row.
// Opened from MarkResult's per-question list. No API calls — edits batched in
// parent state until the teacher taps Approve on the result screen.

import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
} from 'react-native';
import { GradingVerdict, GradingVerdictEnum } from '../types';
import { COLORS } from '../constants/colors';

const { height: SH } = Dimensions.get('window');
const USE_FULL_SCREEN = SH < 700;

const VERDICT_COLOUR: Record<GradingVerdictEnum, string> = {
  correct: COLORS.success,
  partial: COLORS.warning,
  incorrect: COLORS.error,
};

const VERDICT_LABEL: Record<GradingVerdictEnum, string> = {
  correct: '✓ Correct',
  partial: '~ Partial',
  incorrect: '✗ Incorrect',
};

interface Props {
  visible: boolean;
  verdict: GradingVerdict | null;
  onCancel: () => void;
  onSave: (next: GradingVerdict) => void;
}

export default function EditVerdictModal({ visible, verdict, onCancel, onSave }: Props) {
  const [localVerdict, setLocalVerdict] = useState<GradingVerdictEnum>('correct');
  const [marks, setMarks] = useState('0');
  const [feedback, setFeedback] = useState('');

  // Reset state every time a new verdict is loaded.
  useEffect(() => {
    if (!verdict) return;
    setLocalVerdict(verdict.verdict);
    setMarks(String(verdict.awarded_marks ?? 0));
    setFeedback(verdict.feedback ?? '');
  }, [verdict]);

  if (!verdict) return null;

  const handleVerdictChange = (next: GradingVerdictEnum) => {
    setLocalVerdict(next);
    // Auto-fill marks: Correct → max, Incorrect → 0, Partial → keep current
    if (next === 'correct') setMarks(String(verdict.max_marks));
    else if (next === 'incorrect') setMarks('0');
  };

  const handleMarksChange = (raw: string) => {
    // Allow empty while typing, clamp numeric values.
    if (raw === '' || raw === '.') {
      setMarks(raw);
      return;
    }
    const parsed = parseFloat(raw);
    if (isNaN(parsed)) return;
    const clamped = Math.max(0, Math.min(verdict.max_marks, parsed));
    setMarks(String(clamped));
  };

  const handleSave = () => {
    const parsed = parseFloat(marks);
    const finalMarks = isNaN(parsed) ? 0 : Math.max(0, Math.min(verdict.max_marks, parsed));
    onSave({
      ...verdict,
      verdict: localVerdict,
      awarded_marks: finalMarks,
      feedback: feedback.trim() || undefined,
    });
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={!USE_FULL_SCREEN}
      onRequestClose={onCancel}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={USE_FULL_SCREEN ? styles.fullRoot : styles.sheetOverlay}
      >
        {!USE_FULL_SCREEN && <TouchableOpacity style={styles.backdrop} onPress={onCancel} />}
        <View style={USE_FULL_SCREEN ? styles.fullCard : styles.sheetCard}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>Question {verdict.question_number}</Text>
            <TouchableOpacity onPress={onCancel}>
              <Text style={styles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Readonly context */}
            <Text style={styles.fieldLabel}>Question</Text>
            <Text style={styles.readonlyText}>
              {verdict.question_text?.trim() || '—'}
            </Text>

            <Text style={styles.fieldLabel}>Student's answer</Text>
            <Text style={styles.readonlyText}>
              {verdict.student_answer?.trim() || '—'}
            </Text>

            <Text style={styles.fieldLabel}>Expected answer</Text>
            <Text style={styles.readonlyText}>
              {verdict.expected_answer?.trim() || '—'}
            </Text>

            {/* Verdict segmented control */}
            <Text style={styles.fieldLabel}>Verdict</Text>
            <View style={styles.segmented}>
              {(['correct', 'partial', 'incorrect'] as GradingVerdictEnum[]).map((v) => {
                const active = v === localVerdict;
                const colour = VERDICT_COLOUR[v];
                return (
                  <TouchableOpacity
                    key={v}
                    onPress={() => handleVerdictChange(v)}
                    style={[
                      styles.segment,
                      active && { backgroundColor: colour, borderColor: colour },
                    ]}
                  >
                    <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                      {VERDICT_LABEL[v]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Marks */}
            <Text style={styles.fieldLabel}>Awarded marks</Text>
            <View style={styles.marksRow}>
              <TextInput
                style={styles.marksInput}
                value={marks}
                onChangeText={handleMarksChange}
                keyboardType="decimal-pad"
                selectTextOnFocus
              />
              <Text style={styles.marksOutOf}>/ {verdict.max_marks}</Text>
            </View>

            {/* Feedback */}
            <Text style={styles.fieldLabel}>Feedback for the student</Text>
            <TextInput
              style={styles.feedbackInput}
              value={feedback}
              onChangeText={setFeedback}
              placeholder="Explain why they got this wrong (or what they did well)..."
              placeholderTextColor={COLORS.gray500}
              multiline
              textAlignVertical="top"
            />
          </ScrollView>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={onCancel}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.saveBtn} onPress={handleSave}>
              <Text style={styles.saveBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // ── Full-screen (small phones) ─────────────────────────────────────────────
  fullRoot: { flex: 1, backgroundColor: COLORS.white },
  fullCard: { flex: 1, backgroundColor: COLORS.white, paddingTop: 56 },

  // ── Bottom sheet (taller phones) ───────────────────────────────────────────
  sheetOverlay: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheetCard: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    maxHeight: '92%',
    paddingTop: 8,
  },

  // ── Shared ─────────────────────────────────────────────────────────────────
  headerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text },
  closeText: { fontSize: 22, color: COLORS.gray500 },

  scroll: { flexGrow: 0 },
  scrollContent: { padding: 20, gap: 6 },

  fieldLabel: {
    fontSize: 12, fontWeight: '700', color: COLORS.gray500,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 14, marginBottom: 6,
  },
  readonlyText: {
    fontSize: 15, color: COLORS.text, lineHeight: 22,
    backgroundColor: COLORS.background, borderRadius: 8,
    paddingVertical: 10, paddingHorizontal: 12,
  },

  segmented: {
    flexDirection: 'row', gap: 8,
  },
  segment: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 12, borderRadius: 10,
    borderWidth: 1.5, borderColor: COLORS.border,
    backgroundColor: COLORS.white,
  },
  segmentText: { fontSize: 13, fontWeight: '700', color: COLORS.gray500 },
  segmentTextActive: { color: COLORS.white },

  marksRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  marksInput: {
    borderWidth: 1, borderColor: COLORS.teal300, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 22, fontWeight: '700', color: COLORS.teal500,
    minWidth: 100, textAlign: 'center',
  },
  marksOutOf: { fontSize: 20, color: COLORS.gray500, fontWeight: '600' },

  feedbackInput: {
    borderWidth: 1, borderColor: COLORS.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 14, color: COLORS.text, minHeight: 90,
  },

  actions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20,
    borderTopWidth: 1, borderTopColor: COLORS.border,
  },
  cancelBtn: {
    flex: 1, borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  cancelBtnText: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  saveBtn: {
    flex: 1, backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  saveBtnText: { fontSize: 15, fontWeight: '700', color: COLORS.white },
});
