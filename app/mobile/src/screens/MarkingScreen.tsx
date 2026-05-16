// src/screens/MarkingScreen.tsx
// Core teacher marking flow:
//   1. Class is pre-selected (from HomeScreen) or teacher picks one
//   2. Teacher selects a student from the class list
//   3. Teacher selects an answer key
//   4. Camera capture → upload → annotated result

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  FlatList,
  Modal,
  ScrollView,
} from 'react-native';
import { useRoute, useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Haptics from 'expo-haptics';
import { ScreenContainer } from '../components/ScreenContainer';
import { Ionicons } from '@expo/vector-icons';
import { listStudents, listAnswerKeys, submitMark } from '../services/api';
import {
  resolveRoute,
  gradeOnDevice,
  showUnavailableAlert,
  queueMarkingScan,
  type OnDeviceUserContext,
} from '../services/router';
import { showError } from '../utils/showError';
import { retryWithBackoff } from '../utils/retry';
import { useAuth } from '../context/AuthContext';
import { useModel } from '../context/ModelContext';
import { Student, AnswerKey, MarkResult, RootStackParamList, EducationLevel, CapturedPage } from '../types';
import ScanButton from '../components/ScanButton';
import MarkResultComponent from '../components/MarkResult';
import OfflineGradingStatus from '../components/OfflineGradingStatus';
import { COLORS } from '../constants/colors';

type RouteParams = RootStackParamList['Mark'];

export default function MarkingScreen() {
  const route = useRoute<any>();
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const { suppressNudge } = useModel();

  // Suppress the Wi-Fi download nudge while grading is in progress.
  useEffect(() => {
    suppressNudge(true);
    return () => suppressNudge(false);
  }, [suppressNudge]);

  const routeClassId: string | undefined = route.params?.class_id;
  const routeClassName: string | undefined = route.params?.class_name;
  const routeEdLevel: EducationLevel | undefined = route.params?.education_level;
  const routeAnswerKeyId: string | undefined = route.params?.answer_key_id;

  const [students, setStudents] = useState<Student[]>([]);
  const [answerKeys, setAnswerKeys] = useState<AnswerKey[]>([]);
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [selectedAnswerKey, setSelectedAnswerKey] = useState<AnswerKey | null>(null);
  const [result, setResult] = useState<MarkResult | null>(null);
  const [marking, setMarking] = useState(false);
  const [loadingData, setLoadingData] = useState(false);

  // Session counters — reset when the class changes. Used by the completion
  // overlay after the teacher rolls off the end of the class list.
  const [approvedCount, setApprovedCount] = useState(0);
  const [skippedCount, setSkippedCount] = useState(0);
  const [sessionDone, setSessionDone] = useState(false);

  // Last set of pages submitted from PageReviewScreen — held so that on a
  // duplicate-submission 409, "Replace" can re-navigate to PageReview with
  // the same pages preloaded + replace=true (teacher doesn't re-shoot).
  const pendingPagesRef = useRef<CapturedPage[] | null>(null);

  // Modal state for pickers
  const [studentPickerVisible, setStudentPickerVisible] = useState(false);
  const [answerKeyPickerVisible, setAnswerKeyPickerVisible] = useState(false);
  const [questionsModalVisible, setQuestionsModalVisible] = useState(false);
  const [validationError, setValidationError] = useState('');

  const classId = routeClassId;
  const className = routeClassName ?? 'Select class';
  const educationLevel = routeEdLevel ?? 'grade_7';

  // Load students + answer keys when class changes
  useFocusEffect(
    useCallback(() => {
      if (!classId) return;
      // Do not reset selection/result when returning from PageReview with a
      // result or error. The markResult / markError effects below handle
      // that transition — resetting here would wipe selectedStudent before
      // the approval UI has a chance to render.
      if (route.params?.markResult || route.params?.markError) return;
      // Also skip reset if a student is already selected — camera close
      // re-focuses this screen but should not wipe the teacher's selection
      // mid-marking session. Only the picker, advanceStudent, or a real
      // class change should clear selectedStudent.
      if (selectedStudent) return;
      setSelectedStudent(null);
      setSelectedAnswerKey(null);
      setResult(null);
      setApprovedCount(0);
      setSkippedCount(0);
      setSessionDone(false);
      loadClassData(classId);
    }, [classId, route.params?.markResult, route.params?.markError, selectedStudent]),
  );

  const loadClassData = async (cid: string) => {
    setLoadingData(true);
    try {
      // allSettled, not all — offline cache might cover one call but
      // not the other (e.g. students cached, answer keys never
      // fetched online). We render whatever's available rather than
      // bailing on the whole screen.
      const [studsResult, keysResult] = await Promise.allSettled([
        listStudents(cid),
        listAnswerKeys(cid),
      ]);

      if (studsResult.status === 'fulfilled') setStudents(studsResult.value);
      if (keysResult.status === 'fulfilled') {
        setAnswerKeys(keysResult.value);
        if (routeAnswerKeyId) {
          const preSelected = keysResult.value.find(k => k.id === routeAnswerKeyId) ?? null;
          if (preSelected) setSelectedAnswerKey(preSelected);
        }
      }

      // Only show the error alert when BOTH failed AND it wasn't a
      // network outage. Offline-with-empty-cache is a recoverable
      // state — the screen still renders, the teacher just sees
      // "no students yet" until the cache fills next time they're
      // online. Throwing an alert at them adds nothing.
      const bothFailed =
        studsResult.status === 'rejected' && keysResult.status === 'rejected';
      const isOffline =
        bothFailed &&
        ((studsResult.reason as { isOffline?: boolean })?.isOffline ||
          (keysResult.reason as { isOffline?: boolean })?.isOffline);
      if (bothFailed && !isOffline) {
        Alert.alert('Error', 'Failed to load class data.');
      }
    } finally {
      setLoadingData(false);
    }
  };

  const handleCapture = async (imageUri: string) => {
    if (!classId) {
      Alert.alert('Select class', 'Go to the Home tab and tap a class first.');
      return;
    }
    if (!selectedStudent) {
      Alert.alert('Select student', 'Please select a student before scanning.');
      return;
    }
    if (!selectedAnswerKey) {
      Alert.alert('Select answer key', 'Please select an answer key before scanning.');
      return;
    }
    if (!user) return;

    // Multi-page flow: this capture is page 1. Navigate to PageReviewScreen
    // where the teacher can add more pages (up to 5), reorder, delete, then
    // submit. Submission + Vertex grading happens from there; the result
    // comes back to this screen via route.params.markResult and is consumed
    // by the effect below.
    const firstPage: CapturedPage = {
      id: `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      uri: imageUri,
      width: 0,
      height: 0,
      capturedAt: Date.now(),
    };
    navigation.navigate('PageReview', {
      initialPages: [firstPage],
      studentId: selectedStudent.id,
      answerKeyId: selectedAnswerKey.id,
      educationLevel,
      classId,
      className,
      replace: false,
      // Pass the full answer key + student name through so PageReview's
      // offline-grading branch has everything it needs without a network
      // fetch. Cloud-grading branch ignores these fields.
      answerKey: selectedAnswerKey,
      studentName: `${selectedStudent.first_name ?? ''} ${selectedStudent.surname ?? ''}`.trim(),
    });
  };

  // ── Consume PageReview submit result ───────────────────────────────────────
  // PageReviewScreen navigates back here with route.params.markResult on
  // success or route.params.markError on failure. Run the existing post-scan
  // logic (setResult triggers MarkResultComponent + queue advance) then
  // clear the params so a re-focus doesn't replay them.
  useEffect(() => {
    const markResult: MarkResult | undefined = route.params?.markResult;
    if (markResult) {
      pendingPagesRef.current = null;  // success — drop the stash
      setResult(markResult);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      navigation.setParams({ markResult: undefined });
    }
  }, [route.params?.markResult, navigation]);

  useEffect(() => {
    const markError = route.params?.markError;
    if (!markError) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    // Stash the pages PageReview tried to submit, so "Replace" on the
    // duplicate dialog can re-navigate with them preloaded.
    pendingPagesRef.current = route.params?.pendingPages ?? null;
    if (markError.status === 409 || markError.error_code === 'DUPLICATE_SUBMISSION') {
      handleDuplicateSubmission(markError);
    } else {
      showError({
        title: 'Could not submit',
        message: markError.message ?? 'Please try again.',
      });
    }
    navigation.setParams({ markError: undefined, pendingPages: undefined });
  }, [route.params?.markError, route.params?.pendingPages, navigation]);

  // ── Duplicate-submission dialog ──────────────────────────────────────────
  // Fires when POST /mark returns 409 DUPLICATE_SUBMISSION. The backend
  // included `extra = {existing_mark_id, status, approved, timestamp}` in
  // the response; api.ts's interceptor surfaces it on `err.extra`.
  const handleDuplicateSubmission = (err: any) => {
    const extra = err?.extra ?? err?._raw?.response?.data?.extra ?? {};
    const existingMarkId: string | undefined = extra.existing_mark_id;
    // Prefer the student_id PageReviewScreen forwards on the extra payload —
    // resolve the name from the already-loaded students list so the dialog
    // shows the correct name even if `selectedStudent` has been cleared.
    const studentIdFromExtra: string | undefined = extra.student_id;
    const studentFromList = studentIdFromExtra
      ? students.find(s => s.id === studentIdFromExtra)
      : undefined;
    const resolvedStudent = studentFromList ?? selectedStudent;
    const studentName = resolvedStudent
      ? `${resolvedStudent.first_name} ${resolvedStudent.surname}`.trim()
      : 'this student';
    const answerKeyTitle = selectedAnswerKey?.title ?? selectedAnswerKey?.subject ?? 'this homework';

    Alert.alert(
      'Already graded',
      `${studentName} already has a graded submission for this homework. What would you like to do?`,
      [
        {
          text: 'Review existing',
          onPress: () => {
            if (!existingMarkId) {
              Alert.alert(
                'Cannot locate submission',
                'Please go to the homework detail screen to find this submission.',
              );
              return;
            }
            navigation.navigate('GradingDetail', {
              mark_id: existingMarkId,
              student_name: studentName,
              class_name: className,
              answer_key_title: answerKeyTitle,
            });
          },
        },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: () => {
            // Re-navigate to PageReview with replace=true and the same pages
            // preloaded — teacher just taps Submit again. The pages live in
            // pendingPagesRef, populated by the failed submit's navigation
            // back into MarkingScreen (see PageReviewScreen.handleSubmit).
            const pages = pendingPagesRef.current;
            if (!pages || pages.length === 0 || !selectedStudent || !selectedAnswerKey || !classId) {
              Alert.alert(
                'Cannot retry',
                'Original scan data was lost — please retake the photo.',
              );
              return;
            }
            navigation.navigate('PageReview', {
              initialPages: pages,
              studentId: selectedStudent.id,
              answerKeyId: selectedAnswerKey.id,
              educationLevel,
              classId,
              className,
              replace: true,
            });
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
    );
  };

  // Advance to the next student in the class list. When we run off the end,
  // show the "all students graded" completion overlay instead of silently
  // leaving the teacher on an empty capture screen.
  const advanceStudent = () => {
    if (!selectedStudent || students.length === 0) {
      setResult(null);
      return;
    }
    const idx = students.findIndex((s) => s.id === selectedStudent.id);
    const next = students[idx + 1] ?? null;
    if (next) {
      setSelectedStudent(next);
      setResult(null);
    } else {
      // Past the end — kick into the done state.
      setSelectedStudent(null);
      setResult(null);
      setSessionDone(true);
    }
  };

  const handleResultDone = ({ approved }: { approved: boolean }) => {
    if (approved) setApprovedCount((n) => n + 1);
    else setSkippedCount((n) => n + 1);
    advanceStudent();
  };

  const handleBackToHome = () => {
    setSessionDone(false);
    navigation.navigate('Home');
  };

  const handleMarkAnotherClass = () => {
    setSessionDone(false);
    setApprovedCount(0);
    setSkippedCount(0);
    setSelectedStudent(null);
    setSelectedAnswerKey(null);
    setResult(null);
    navigation.navigate('Home');
  };

  // "Done" in the header — only once the teacher has actually done work this
  // session. Avoids showing the confirm dialog on a fresh-load back-tap.
  const handleExitSession = () => {
    const a = approvedCount;
    const k = skippedCount;
    Alert.alert(
      'Done marking?',
      `You have approved ${a} student${a === 1 ? '' : 's'} and skipped ${k}. Exit the mark flow?`,
      [
        { text: 'Keep Going', style: 'cancel' },
        { text: 'Done', style: 'default', onPress: () => navigation.goBack() },
      ],
    );
  };

  const sessionHasProgress = approvedCount + skippedCount > 0;

  // Completion overlay — shown after the teacher rolls off the last student.
  if (sessionDone) {
    return (
      <View style={styles.doneContainer}>
        <View style={styles.doneCheckCircle}>
          <Ionicons name="checkmark" size={56} color={COLORS.white} />
        </View>
        <Text style={styles.doneTitle}>All students graded</Text>
        {className ? <Text style={styles.doneClass}>in {className}</Text> : null}
        <Text style={styles.doneSubtitle}>
          {approvedCount} of {students.length} approved
          {skippedCount > 0 ? `, ${skippedCount} skipped` : ''}
        </Text>

        <TouchableOpacity style={styles.donePrimaryBtn} onPress={handleBackToHome}>
          <Text style={styles.donePrimaryBtnText}>Back to Home</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.doneSecondaryBtn} onPress={handleMarkAnotherClass}>
          <Text style={styles.doneSecondaryBtnText}>Mark another class</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const showResult = !!result;

  const handleBackPress = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
    } else {
      navigation.navigate('Home');
    }
  };

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
    <View style={styles.container}>
      <View style={styles.topBar}>
        <TouchableOpacity
          onPress={handleBackPress}
          style={styles.topBarBack}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Ionicons name="chevron-back" size={22} color={COLORS.text} />
        </TouchableOpacity>
        <Text style={styles.topBarTitle} numberOfLines={1}>Mark Books</Text>
        {showResult ? (
          <TouchableOpacity
            onPress={() => { setValidationError(''); setStudentPickerVisible(true); }}
            style={styles.topBarAction}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Switch student"
            accessibilityRole="button"
          >
            <Text style={styles.switchStudent}>⇄ Switch student</Text>
          </TouchableOpacity>
        ) : sessionHasProgress ? (
          <TouchableOpacity
            onPress={handleExitSession}
            style={styles.topBarAction}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel="Done marking"
            accessibilityRole="button"
          >
            <Text style={styles.headerDoneText}>Done</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.topBarSpacer} />
        )}
      </View>

      {/* Offline grading readiness pill — silent on cloud-only devices,
          visible when the teacher's setup has something to say about
          local inference (downloading, not yet downloaded, loading, ready). */}
      <OfflineGradingStatus />

      {showResult ? (
        <MarkResultComponent
          result={result!}
          student={selectedStudent ?? undefined}
          onDone={handleResultDone}
        />
      ) : !classId ? (
        <View style={styles.noClass}>
          <Text style={styles.noClassText}>
            Go to the Home tab and tap a class to start marking.
          </Text>
        </View>
      ) : loadingData ? (
        <ActivityIndicator style={styles.centre} size="large" color={COLORS.teal500} />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
          {/* 1. QUESTIONS (top — teacher reviews questions first) */}
          <TouchableOpacity
            style={styles.selector}
            onPress={() => selectedAnswerKey ? setQuestionsModalVisible(true) : setAnswerKeyPickerVisible(true)}
          >
            <Text style={styles.selectorLabel}>Questions</Text>
            <Text style={styles.selectorValue}>
              {selectedAnswerKey
                ? `${selectedAnswerKey.questions?.length ?? 0} questions · ${selectedAnswerKey.total_marks ?? 0} marks`
                : 'Select answer key to view'}
            </Text>
            {selectedAnswerKey && (
              <Text style={{ fontSize: 12, color: COLORS.teal500, fontWeight: '600', marginTop: 4 }}>Tap to view questions →</Text>
            )}
          </TouchableOpacity>

          {/* 2. STUDENT (select who you're marking) */}
          <TouchableOpacity
            style={[styles.selector, !selectedStudent && styles.selectorRequired]}
            onPress={() => { setValidationError(''); setStudentPickerVisible(true); }}
          >
            <Text style={styles.selectorLabel}>Student</Text>
            <Text style={styles.selectorValue}>
              {selectedStudent
                ? `${selectedStudent.first_name} ${selectedStudent.surname}`
                : 'Select student'}
            </Text>
          </TouchableOpacity>

          {/* 3. ANSWER KEY (marking scheme) */}
          <TouchableOpacity
            style={[styles.selector, !selectedAnswerKey && styles.selectorRequired]}
            onPress={() => setAnswerKeyPickerVisible(true)}
          >
            <Text style={styles.selectorLabel}>Answer Key</Text>
            <Text style={styles.selectorValue}>
              {selectedAnswerKey
                ? selectedAnswerKey.title ?? selectedAnswerKey.subject
                : 'Select answer key'}
            </Text>
          </TouchableOpacity>

          {/* Validation error */}
          {validationError ? (
            <View style={{ marginHorizontal: 20, marginTop: 8, backgroundColor: '#FEF2F2', borderRadius: 8, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="alert-circle" size={18} color={COLORS.error} />
              <Text style={{ color: COLORS.error, fontSize: 13, fontWeight: '500', flex: 1 }}>{validationError}</Text>
            </View>
          ) : null}

          {/* Capture button */}
          {marking ? (
            <View style={styles.centre}>
              <ActivityIndicator size="large" color={COLORS.teal500} />
              <Text style={styles.markingText}>Marking...</Text>
            </View>
          ) : (
            <ScanButton
              onCapture={handleCapture}
              disabled={!selectedStudent || !selectedAnswerKey}
              label="Capture Homework"
              onDisabledPress={() => {
                if (!selectedStudent) setValidationError('Please select a student first');
                else if (!selectedAnswerKey) setValidationError('Please select an answer key first');
              }}
            />
          )}
        </ScrollView>
      )}

      {/* Student picker modal — teachers can manually jump to any student at
          any time; the queue advance ("Approve & Next Student") is a
          convenience, not a forced sequence. Picking here also drops any
          on-screen result so the teacher returns to the capture view for the
          newly-chosen student. */}
      <PickerModal
        visible={studentPickerVisible}
        title="Select Student"
        onClose={() => setStudentPickerVisible(false)}
        items={students.map((s) => ({
          id: s.id,
          label: `${s.first_name} ${s.surname}`,
          sublabel: s.register_number ? `#${s.register_number}` : undefined,
        }))}
        onSelect={(id) => {
          setSelectedStudent(students.find((s) => s.id === id) ?? null);
          setResult(null);
          setStudentPickerVisible(false);
        }}
      />

      {/* Answer key picker modal */}
      <PickerModal
        visible={answerKeyPickerVisible}
        title="Select Answer Key"
        onClose={() => setAnswerKeyPickerVisible(false)}
        items={answerKeys.map((ak) => ({
          id: ak.id,
          label: ak.title ?? ak.subject,
          sublabel: ak.total_marks != null ? `${ak.total_marks} marks` : undefined,
        }))}
        onSelect={(id) => {
          setSelectedAnswerKey(answerKeys.find((ak) => ak.id === id) ?? null);
          setAnswerKeyPickerVisible(false);
        }}
      />

      {/* Questions modal */}
      <Modal visible={questionsModalVisible} animationType="slide" onRequestClose={() => setQuestionsModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: COLORS.white }}>
          <View style={[modal.header, { paddingTop: 56 }]}>
            <Text style={modal.title}>Questions</Text>
            <TouchableOpacity onPress={() => setQuestionsModalVisible(false)}>
              <Text style={modal.close}>✕</Text>
            </TouchableOpacity>
          </View>
          {selectedAnswerKey?.question_paper_text ? (
            <ScrollView style={{ padding: 20 }}>
              <Text style={{ fontSize: 15, color: COLORS.text, lineHeight: 22 }}>{selectedAnswerKey.question_paper_text}</Text>
            </ScrollView>
          ) : (selectedAnswerKey?.questions ?? []).length > 0 ? (
            <FlatList
              data={selectedAnswerKey?.questions ?? []}
              keyExtractor={(_, i) => String(i)}
              contentContainerStyle={{ padding: 20 }}
              renderItem={({ item: q }) => (
                <View style={{ marginBottom: 14, borderBottomWidth: 1, borderBottomColor: COLORS.background, paddingBottom: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: COLORS.text }}>Q{q.question_number ?? q.number}: {q.question_text ?? ''}</Text>
                  <Text style={{ fontSize: 13, color: COLORS.gray500, marginTop: 4 }}>Answer: {q.answer ?? q.correct_answer ?? ''}</Text>
                  <Text style={{ fontSize: 12, color: COLORS.teal500, marginTop: 2 }}>{q.marks ?? q.max_marks ?? 0} marks</Text>
                </View>
              )}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
              <Ionicons name="document-text-outline" size={48} color={COLORS.gray200} />
              <Text style={{ fontSize: 16, fontWeight: '600', color: COLORS.text, marginTop: 12 }}>No question paper</Text>
              <Text style={{ fontSize: 13, color: COLORS.gray500, marginTop: 4, textAlign: 'center' }}>The question paper hasn't been uploaded yet.</Text>
            </View>
          )}
        </View>
      </Modal>
    </View>
    </ScreenContainer>
  );
}

// ── Picker modal ──────────────────────────────────────────────────────────────

interface PickerItem {
  id: string;
  label: string;
  sublabel?: string;
}

function PickerModal({
  visible, title, items, onSelect, onClose,
}: {
  visible: boolean;
  title: string;
  items: PickerItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={modal.overlay}>
        <View style={modal.sheet}>
          <View style={modal.header}>
            <Text style={modal.title}>{title}</Text>
            <TouchableOpacity onPress={onClose}>
              <Text style={modal.close}>✕</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <TouchableOpacity style={modal.item} onPress={() => onSelect(item.id)}>
                <Text style={modal.itemLabel}>{item.label}</Text>
                {item.sublabel && <Text style={modal.itemSub}>{item.sublabel}</Text>}
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <Text style={modal.empty}>Nothing here yet.</Text>
            }
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.white },
  topBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  topBarBack: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: COLORS.background,
    alignItems: 'center', justifyContent: 'center',
  },
  topBarTitle: {
    flex: 1, textAlign: 'center',
    fontSize: 17, fontWeight: '700', color: COLORS.text,
  },
  topBarSpacer: { width: 40, height: 40 },
  header: {
    paddingHorizontal: 20, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: COLORS.border, backgroundColor: COLORS.white,
  },
  heading: { fontSize: 24, fontWeight: 'bold', color: COLORS.text },
  subheading: { fontSize: 13, color: COLORS.gray500, marginTop: 2 },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  noClass: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  noClassText: { textAlign: 'center', fontSize: 15, color: COLORS.gray500, lineHeight: 22 },
  selector: {
    marginHorizontal: 16, marginTop: 12, borderWidth: 1, borderColor: COLORS.gray200,
    borderRadius: 10, padding: 14,
  },
  selectorRequired: { borderColor: COLORS.amber100, backgroundColor: COLORS.amber50 },
  selectorLabel: { fontSize: 11, color: COLORS.textLight, fontWeight: '600', textTransform: 'uppercase', marginBottom: 2 },
  selectorValue: { fontSize: 15, color: COLORS.text },
  markingText: { marginTop: 12, fontSize: 16, color: COLORS.gray500 },
  captureBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    backgroundColor: COLORS.teal500, marginHorizontal: 20, marginTop: 20,
    borderRadius: 12, paddingVertical: 16,
  },
  captureBtnText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
  nextButton: {
    backgroundColor: COLORS.teal500, margin: 16, borderRadius: 10,
    padding: 16, alignItems: 'center',
  },
  nextButtonText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },

  // ── Top-bar right-slot actions (Switch student / Done) ───────────────────
  // Replaces the old markHeader row that used to sit below the topBar; both
  // actions now live in the topBar's right slot.
  topBarAction: {
    minWidth: 40,
    paddingHorizontal: 8,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  switchStudent: { fontSize: 14, fontWeight: '600', color: COLORS.teal500 },
  headerDoneText: { fontSize: 14, fontWeight: '700', color: COLORS.teal500 },

  // ── Completion overlay ────────────────────────────────────────────────────
  doneContainer: {
    flex: 1, backgroundColor: COLORS.white,
    justifyContent: 'center', alignItems: 'center', padding: 32,
  },
  doneCheckCircle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: COLORS.teal500,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 24,
  },
  doneTitle: {
    fontSize: 24, fontWeight: 'bold', color: COLORS.text,
    textAlign: 'center',
  },
  doneClass: {
    fontSize: 16, color: COLORS.textLight, marginTop: 4, textAlign: 'center',
  },
  doneSubtitle: {
    fontSize: 14, color: COLORS.gray500, marginTop: 16, marginBottom: 32,
    textAlign: 'center',
  },
  donePrimaryBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 15, paddingHorizontal: 32,
    alignSelf: 'stretch', alignItems: 'center',
  },
  donePrimaryBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 16 },
  doneSecondaryBtn: {
    borderWidth: 1.5, borderColor: COLORS.gray200, borderRadius: 12,
    paddingVertical: 14, paddingHorizontal: 32,
    alignSelf: 'stretch', alignItems: 'center',
    marginTop: 10,
  },
  doneSecondaryBtnText: { color: COLORS.text, fontWeight: '600', fontSize: 15 },
});

const modal = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: COLORS.white, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '70%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  title: { fontSize: 17, fontWeight: '600', color: COLORS.text },
  close: { fontSize: 20, color: COLORS.gray500 },
  item: { padding: 16, borderBottomWidth: 1, borderBottomColor: COLORS.background },
  itemLabel: { fontSize: 16, color: COLORS.text },
  itemSub: { fontSize: 13, color: COLORS.textLight, marginTop: 2 },
  empty: { padding: 24, textAlign: 'center', color: COLORS.textLight },
});
