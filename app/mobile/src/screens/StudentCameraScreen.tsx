// src/screens/StudentCameraScreen.tsx
// Multi-page image capture for student submissions.
// Allows capturing multiple pages; each page becomes one image in the submission.

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Image,
  Alert,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { StudentRootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import InAppCamera from '../components/InAppCamera';
import { getAnswerKeyQuestions } from '../services/api';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';

type QuestionItem = { question_number: number; question_text: string; marks: number };

type Props = NativeStackScreenProps<StudentRootStackParamList, 'StudentCamera'>;

export default function StudentCameraScreen({ route, navigation }: Props) {
  const { answer_key_id, answer_key_title, class_id } = route.params;
  const [images, setImages] = useState<string[]>([]);
  const [cameraVisible, setCameraVisible] = useState(false);
  const [showQuestions, setShowQuestions] = useState(false);
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [questionPaperText, setQuestionPaperText] = useState('');
  const [questionsLoading, setQuestionsLoading] = useState(false);

  const captureImage = () => {
    setCameraVisible(true);
  };

  const handleCameraCapture = (uri: string) => {
    setCameraVisible(false);
    setImages(prev => [...prev, uri]);
  };

  const removePage = (index: number) => {
    Alert.alert('Remove page', 'Remove this page from your submission?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => setImages(prev => prev.filter((_, i) => i !== index)),
      },
    ]);
  };

  const handleDone = () => {
    if (images.length === 0) {
      Alert.alert('No pages captured', 'Capture at least one page before continuing.');
      return;
    }
    navigation.navigate('StudentPreview', {
      images,
      answer_key_id,
      answer_key_title,
      class_id,
    });
  };

  const openQuestions = async () => {
    setShowQuestions(true);
    if (questions.length > 0 || questionPaperText) return;
    setQuestionsLoading(true);
    try {
      const data = await getAnswerKeyQuestions(answer_key_id);
      setQuestions(data.questions);
      if (data.question_paper_text) setQuestionPaperText(data.question_paper_text);
    } catch {
      // silently fail — modal shows "not available" state
    } finally {
      setQuestionsLoading(false);
    }
  };

  return (
    <>
      <InAppCamera
        visible={cameraVisible}
        onCapture={handleCameraCapture}
        onClose={() => setCameraVisible(false)}
        quality={0.85}
        warningMessage="Your submission photo is unclear. Please retake or choose a clearer image — your teacher needs to read your answers."
      />

      {/* View Assignment modal */}
      <Modal visible={showQuestions} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>{answer_key_title}</Text>
              <TouchableOpacity onPress={() => setShowQuestions(false)} style={styles.modalClose}>
                <Ionicons name="close" size={22} color={COLORS.text} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 20 }}>
              {questionsLoading ? (
                <ActivityIndicator size="large" color={COLORS.teal500} style={{ marginTop: 30 }} />
              ) : questions.length === 0 && !questionPaperText ? (
                <View style={styles.modalEmpty}>
                  <Ionicons name="document-text-outline" size={40} color={COLORS.gray200} />
                  <Text style={styles.modalEmptyText}>No question paper available.</Text>
                  <Text style={styles.modalEmptyHint}>Contact your teacher for the assignment details.</Text>
                </View>
              ) : (
                <>
                  {/* Show raw question paper text when available */}
                  {questionPaperText ? (
                    <View style={styles.qpTextBlock}>
                      <Text style={styles.qpTextLabel}>Question Paper</Text>
                      <Text style={styles.qpText}>{questionPaperText}</Text>
                    </View>
                  ) : null}

                  {/* Question list with marks */}
                  {questions.length > 0 && (
                    <>
                      {questionPaperText ? <Text style={styles.qpTextLabel}>Marks Breakdown</Text> : null}
                      {questions.map(q => (
                        <View key={q.question_number} style={styles.questionCard}>
                          <View style={styles.questionNumBadge}>
                            <Text style={styles.questionNumText}>{q.question_number}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={styles.questionText}>
                              {q.question_text || `Question ${q.question_number}`}
                            </Text>
                            <Text style={styles.questionMarks}>{q.marks} mark{q.marks !== 1 ? 's' : ''}</Text>
                          </View>
                        </View>
                      ))}
                    </>
                  )}
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <ScreenContainer scroll={false}>
      <View style={styles.container}>
      {/* In-screen back-button row replaces the native header so the
          status bar isn't padded by the navigator's default chrome. */}
      <View style={styles.titleRow}>
        <BackButton />
        <Text style={styles.titleText}>Capture Pages</Text>
      </View>
      {/* Assignment context */}
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.assignmentLabel}>Assignment</Text>
          <Text style={styles.assignmentTitle}>{answer_key_title}</Text>
        </View>
        <TouchableOpacity style={styles.viewBtn} onPress={openQuestions}>
          <Ionicons name="eye-outline" size={14} color={COLORS.white} />
          <Text style={styles.viewBtnText}>View</Text>
        </TouchableOpacity>
      </View>

      {/* Page counter */}
      <Text style={styles.pageCount}>
        {images.length === 0
          ? 'No pages captured yet'
          : `${images.length} page${images.length !== 1 ? 's' : ''} captured`}
      </Text>

      {/* Thumbnail strip */}
      {images.length > 0 && (
        <ScrollView
          horizontal
          style={styles.thumbnailScroll}
          contentContainerStyle={styles.thumbnailContent}
          showsHorizontalScrollIndicator={false}
        >
          {images.map((uri, index) => (
            <TouchableOpacity
              key={uri}
              style={styles.thumbnailWrapper}
              onLongPress={() => removePage(index)}
              onPress={() => removePage(index)}
            >
              <Image source={{ uri }} style={styles.thumbnail} />
              <View style={styles.thumbnailBadge}>
                <Text style={styles.thumbnailBadgeText}>{index + 1}</Text>
              </View>
              <View style={styles.thumbnailRemove}>
                <Text style={styles.thumbnailRemoveText}>✕</Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Tip */}
      <View style={styles.tip}>
        <Text style={styles.tipText}>
          Tip: Lay the book flat, hold the phone directly above, and ensure all text is visible.
        </Text>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.captureBtn}
          onPress={captureImage}
        >
          <View style={styles.captureBtnInner}>
            <Ionicons name="camera-outline" size={18} color={COLORS.white} />
            <Text style={styles.captureBtnText}>
              {'  '}{images.length === 0 ? 'Capture Page 1' : 'Add Another Page'}
            </Text>
          </View>
        </TouchableOpacity>

        {images.length > 0 && (
          <TouchableOpacity style={styles.doneBtn} onPress={handleDone}>
            <Text style={styles.doneBtnText}>Preview & Continue →</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
    </ScreenContainer>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  titleRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12,
    backgroundColor: COLORS.background,
  },
  titleText: { fontSize: 22, fontWeight: '700', color: COLORS.text, flex: 1 },
  header: {
    backgroundColor: COLORS.teal500,
    paddingHorizontal: 20,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
  },
  assignmentLabel: { color: COLORS.teal100, fontSize: 12, fontWeight: '600', textTransform: 'uppercase' },
  assignmentTitle: { color: COLORS.white, fontSize: 18, fontWeight: '700', marginTop: 2 },
  viewBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.6)',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  viewBtnText: { color: COLORS.white, fontSize: 13, fontWeight: '600' },
  pageCount: {
    textAlign: 'center',
    color: COLORS.gray500,
    fontSize: 14,
    marginVertical: 16,
  },
  thumbnailScroll: { maxHeight: 130, flexGrow: 0 },
  thumbnailContent: { paddingHorizontal: 16, gap: 10 },
  thumbnailWrapper: {
    width: 90,
    height: 110,
    borderRadius: 8,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: COLORS.teal500,
  },
  thumbnail: { width: '100%', height: '100%' },
  thumbnailBadge: {
    position: 'absolute',
    bottom: 4,
    left: 4,
    backgroundColor: COLORS.teal500,
    borderRadius: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  thumbnailBadgeText: { color: COLORS.white, fontSize: 11, fontWeight: '700' },
  thumbnailRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 10,
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailRemoveText: { color: COLORS.white, fontSize: 11 },
  tip: {
    margin: 16,
    marginTop: 8,
    backgroundColor: COLORS.amber50,
    borderRadius: 10,
    padding: 12,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.amber300,
  },
  tipText: { color: COLORS.amber700, fontSize: 13, lineHeight: 19 },
  actions: { padding: 20, gap: 12 },
  captureBtn: {
    backgroundColor: COLORS.teal500,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
  },
  captureBtnInner: { flexDirection: 'row', alignItems: 'center' },
  btnDisabled: { opacity: 0.6 },
  captureBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  doneBtn: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: COLORS.teal500,
  },
  doneBtnText: { color: COLORS.teal500, fontSize: 16, fontWeight: '700' },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
    paddingBottom: 30,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 18,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text, flex: 1 },
  modalClose: { padding: 4 },
  modalScroll: { paddingHorizontal: 18 },
  modalEmpty: { alignItems: 'center', paddingVertical: 40, gap: 8 },
  modalEmptyText: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  modalEmptyHint: { fontSize: 13, color: COLORS.gray500, textAlign: 'center' },
  questionCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.gray50,
  },
  questionNumBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: COLORS.teal50,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  questionNumText: { fontSize: 13, fontWeight: '700', color: COLORS.teal500 },
  questionText: { fontSize: 14, color: COLORS.text, lineHeight: 20 },
  questionMarks: { fontSize: 12, color: COLORS.gray500, marginTop: 4 },
  qpTextBlock: {
    backgroundColor: COLORS.gray50,
    borderRadius: 10,
    padding: 14,
    marginBottom: 16,
    marginTop: 8,
  },
  qpTextLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.gray500,
    marginBottom: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  qpText: { fontSize: 14, color: COLORS.text, lineHeight: 22 },
});
