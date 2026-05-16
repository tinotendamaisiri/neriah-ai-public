// src/screens/ReviewSchemeScreen.tsx
// Teacher reviews and edits the Gemma-generated marking scheme before confirming.
// Sits between AddHomeworkScreen and HomeworkCreatedScreen in the nav stack.

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';
import { useNavigation, useRoute } from '@react-navigation/native';
import { updateAnswerKey, regenerateScheme } from '../services/api';
import { ReviewQuestion } from '../types';
import { COLORS } from '../constants/colors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nextNumber(questions: ReviewQuestion[]): number {
  if (questions.length === 0) return 1;
  return Math.max(...questions.map(q => q.question_number)) + 1;
}

// ─── Question card ────────────────────────────────────────────────────────────

interface QuestionCardProps {
  question: ReviewQuestion;
  index: number;
  onChange: (index: number, field: keyof ReviewQuestion, value: string) => void;
  onDelete: (index: number) => void;
  canDelete: boolean;
}

function QuestionCard({ question, index, onChange, onDelete, canDelete }: QuestionCardProps) {
  return (
    <View style={cardStyles.card}>
      <View style={cardStyles.header}>
        <View style={cardStyles.badge}>
          <Text style={cardStyles.badgeText}>Q{question.question_number}</Text>
        </View>
        {canDelete && (
          <TouchableOpacity
            onPress={() => onDelete(index)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={cardStyles.deleteBtn}
          >
            <Text style={cardStyles.deleteBtnText}>✕</Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={cardStyles.fieldLabel}>Question</Text>
      <TextInput
        style={cardStyles.textArea}
        value={question.question_text}
        onChangeText={v => onChange(index, 'question_text', v)}
        multiline
        placeholder="Question text…"
        textAlignVertical="top"
      />

      <Text style={cardStyles.fieldLabel}>Correct Answer</Text>
      <TextInput
        style={cardStyles.textArea}
        value={question.answer}
        onChangeText={v => onChange(index, 'answer', v)}
        multiline
        placeholder="Expected answer…"
        textAlignVertical="top"
      />

      <View style={cardStyles.marksRow}>
        <Text style={cardStyles.fieldLabel}>Marks</Text>
        <TextInput
          style={cardStyles.marksInput}
          value={String(question.marks)}
          onChangeText={v => onChange(index, 'marks', v)}
          keyboardType="decimal-pad"
          selectTextOnFocus
        />
      </View>

      {question.marking_notes ? (
        <>
          <Text style={cardStyles.fieldLabel}>Marking Notes</Text>
          <TextInput
            style={[cardStyles.textArea, cardStyles.notesArea]}
            value={question.marking_notes ?? ''}
            onChangeText={v => onChange(index, 'marking_notes', v)}
            multiline
            placeholder="Acceptable alternative answers, partial credit rules…"
            textAlignVertical="top"
          />
        </>
      ) : null}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    backgroundColor: COLORS.white,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  badge: {
    backgroundColor: COLORS.teal500,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  badgeText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 13,
  },
  deleteBtn: {
    padding: 4,
  },
  deleteBtnText: {
    fontSize: 15,
    color: COLORS.gray500,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.gray500,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4,
    marginTop: 10,
  },
  textArea: {
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: COLORS.text,
    minHeight: 60,
    lineHeight: 20,
  },
  notesArea: {
    minHeight: 48,
  },
  marksRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  marksInput: {
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
    color: COLORS.text,
    width: 72,
    textAlign: 'center',
    marginTop: 10,
  },
});

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function ReviewSchemeScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const {
    answer_key_id,
    class_id,
    class_name,
    questions: initialQuestions,
    qp_text,
    qp_file_base64,
    qp_media_type,
  } = route.params as {
    answer_key_id: string;
    class_id: string;
    class_name: string;
    questions: ReviewQuestion[];
    qp_text?: string;
    qp_file_base64?: string;
    qp_media_type?: string;
  };

  console.log('[ReviewScheme] Received params:', JSON.stringify(route.params));

  const [questions, setQuestions] = useState<ReviewQuestion[]>(
    (initialQuestions ?? []).map(q => ({ ...q })),
  );
  const [confirming, setConfirming] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // ── Edit helpers ────────────────────────────────────────────────────────────

  const handleChange = useCallback((index: number, field: keyof ReviewQuestion, value: string) => {
    setQuestions(prev => {
      const next = [...prev];
      const q = { ...next[index] };
      if (field === 'marks') {
        (q as any)[field] = parseFloat(value) || 0;
      } else {
        (q as any)[field] = value;
      }
      next[index] = q;
      return next;
    });
  }, []);

  const handleDelete = useCallback((index: number) => {
    Alert.alert('Remove question?', 'This will remove Q' + questions[index].question_number + ' from the scheme.', [
      { text: 'Remove', style: 'destructive', onPress: () => setQuestions(prev => prev.filter((_, i) => i !== index)) },
      { text: 'Keep', style: 'cancel' },
    ]);
  }, [questions]);

  const handleAddQuestion = useCallback(() => {
    setQuestions(prev => [
      ...prev,
      {
        question_number: nextNumber(prev),
        question_text: '',
        answer: '',
        marks: 1,
        marking_notes: null,
      },
    ]);
  }, []);

  // ── Confirm & Save ──────────────────────────────────────────────────────────

  const handleConfirm = async () => {
    if (questions.some(q => !q.question_text.trim() || !q.answer.trim())) {
      Alert.alert('Incomplete questions', 'All questions must have question text and an answer.');
      return;
    }

    setConfirming(true);
    try {
      // Map to the field names updateAnswerKey accepts, then mark as confirmed
      const mappedQuestions = questions.map(q => ({
        number: q.question_number,
        correct_answer: q.answer,
        max_marks: q.marks,
        marking_notes: q.marking_notes ?? undefined,
      }));

      await updateAnswerKey(answer_key_id, {
        questions: mappedQuestions,
        status: null,
      } as any);

      navigation.replace('HomeworkCreated', {
        answer_key_id,
        class_id,
        class_name,
      });
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not save the marking scheme. Please try again.');
    } finally {
      setConfirming(false);
    }
  };

  // ── Regenerate ──────────────────────────────────────────────────────────────

  const handleRegenerate = async () => {
    Alert.alert(
      'Regenerate scheme?',
      'Gemma 4 will generate a new marking scheme. Your current edits will be replaced.',
      [
        {
          text: 'Regenerate',
          onPress: async () => {
            setRegenerating(true);
            try {
              const result = await regenerateScheme(answer_key_id, {
                text: qp_text,
                fileBase64: qp_file_base64,
                mediaType: qp_media_type,
              });
              setQuestions((result.questions ?? []).map(q => ({ ...q })));
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Regeneration failed. Please try again.');
            } finally {
              setRegenerating(false);
            }
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  const totalMarks = questions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
  const isDisabled = confirming || regenerating;

  return (
    <ScreenContainer>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header — back button + title side-by-side */}
          <View style={styles.headerRow}>
            <BackButton />
            <Text style={[styles.heading, styles.headerTitleFlex]}>Review Marking Scheme</Text>
          </View>
          <Text style={styles.subheading}>
            Gemma 4 generated this from your question paper. Review and confirm before accepting submissions.
          </Text>

          {questions.length > 0 && (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryText}>
                {questions.length} question{questions.length !== 1 ? 's' : ''} · {totalMarks} mark{totalMarks !== 1 ? 's' : ''} total
              </Text>
            </View>
          )}

          {/* Question cards */}
          {questions.map((q, i) => (
            <QuestionCard
              key={i}
              question={q}
              index={i}
              onChange={handleChange}
              onDelete={handleDelete}
              canDelete={questions.length > 1}
            />
          ))}

          {questions.length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyText}>No questions generated. Add one manually or regenerate.</Text>
            </View>
          )}

          {/* Add question */}
          <TouchableOpacity
            style={styles.addBtn}
            onPress={handleAddQuestion}
            disabled={isDisabled}
          >
            <Text style={styles.addBtnText}>+ Add Question</Text>
          </TouchableOpacity>

          {/* Action buttons */}
          <TouchableOpacity
            style={[styles.primaryButton, isDisabled && styles.primaryButtonDisabled]}
            onPress={handleConfirm}
            disabled={isDisabled}
          >
            {confirming ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={COLORS.white} size="small" />
                <Text style={styles.primaryButtonText}>  Saving…</Text>
              </View>
            ) : (
              <Text style={styles.primaryButtonText}>Confirm & Save</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.outlineButton, isDisabled && styles.outlineButtonDisabled]}
            onPress={handleRegenerate}
            disabled={isDisabled}
          >
            {regenerating ? (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={COLORS.teal500} size="small" />
                <Text style={[styles.outlineButtonText, { marginLeft: 8 }]}>Regenerating…</Text>
              </View>
            ) : (
              <Text style={styles.outlineButtonText}>Regenerate</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.white },
  container: { flexGrow: 1, padding: 24, paddingBottom: 48 },
  back: { marginBottom: 24 },
  backText: { fontSize: 16, color: COLORS.gray500 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6,
  },
  headerTitleFlex: { flex: 1 },
  heading: { fontSize: 24, fontWeight: 'bold', color: COLORS.text },
  subheading: { fontSize: 14, color: COLORS.gray500, lineHeight: 20, marginBottom: 20 },
  summaryRow: {
    backgroundColor: COLORS.teal50,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.teal100,
  },
  summaryText: { fontSize: 13, color: COLORS.teal700, fontWeight: '600' },
  emptyState: {
    borderWidth: 1,
    borderColor: COLORS.gray200,
    borderRadius: 12,
    padding: 24,
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyText: { fontSize: 14, color: COLORS.gray500, textAlign: 'center' },
  addBtn: {
    alignItems: 'center',
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: COLORS.teal300,
    borderRadius: 10,
    borderStyle: 'dashed',
    marginBottom: 28,
  },
  addBtnText: { fontSize: 14, color: COLORS.teal500, fontWeight: '600' },
  primaryButton: {
    backgroundColor: COLORS.teal500,
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonDisabled: { backgroundColor: COLORS.teal300 },
  primaryButtonText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
  outlineButton: {
    borderWidth: 1.5,
    borderColor: COLORS.teal500,
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    marginBottom: 8,
  },
  outlineButtonDisabled: { borderColor: COLORS.teal300 },
  outlineButtonText: { color: COLORS.teal500, fontWeight: '600', fontSize: 16 },
  loadingRow: { flexDirection: 'row', alignItems: 'center' },
});
