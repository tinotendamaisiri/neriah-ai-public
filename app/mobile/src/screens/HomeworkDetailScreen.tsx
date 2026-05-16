// src/screens/HomeworkDetailScreen.tsx
// View and manage a single homework assignment (answer key).

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
  KeyboardAvoidingView,
  Platform,
  Share,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';
import {
  listAnswerKeys,
  listStudents,
  updateAnswerKey,
  uploadAnswerKeyFile,
  getTeacherSubmissions,
  closeAndGrade,
  approveAllMarks,
} from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { pickFile, PickedFile } from '../utils/filePicker';
import { enhanceImage } from '../services/imageEnhance';
import { AnswerKey, TeacherSubmission } from '../types';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import InAppCamera from '../components/InAppCamera';

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

function fmtDueCountdown(iso?: string | null): string {
  if (!iso) return '';
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'Closed';
    const totalMins = Math.floor(diff / 60000);
    const hours = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hours >= 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return remHours > 0 ? `Closes in ${days}d ${remHours}h` : `Closes in ${days}d`;
    }
    return hours > 0 ? `Closes in ${hours}h ${mins}m` : `Closes in ${mins}m`;
  } catch { return ''; }
}

const LEVEL_LABELS: Record<string, string> = {
  grade_1: 'Grade 1', grade_2: 'Grade 2', grade_3: 'Grade 3',
  grade_4: 'Grade 4', grade_5: 'Grade 5', grade_6: 'Grade 6', grade_7: 'Grade 7',
  form_1: 'Form 1', form_2: 'Form 2', form_3: 'Form 3', form_4: 'Form 4',
  form_5: 'Form 5 (A-Level)', form_6: 'Form 6 (A-Level)',
  tertiary: 'College/University',
};

function levelLabel(level?: string | null): string {
  if (!level) return '';
  return LEVEL_LABELS[level] ?? level;
}

export default function HomeworkDetailScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { user } = useAuth();
  const { t } = useLanguage();
  const { answer_key_id, class_id, class_name } = route.params as {
    answer_key_id: string;
    class_id: string;
    class_name: string;
  };

  const [answerKey, setAnswerKey] = useState<AnswerKey | null>(null);
  const [submissions, setSubmissions] = useState<TeacherSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [togglingOpen, setTogglingOpen] = useState(false);
  const [closingAndGrading, setClosingAndGrading] = useState(false);

  // Rename state (for pending_setup / Unlabeled homework)
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);

  // Marking scheme collapsed by default — keeps the page short. Teacher
  // taps the section header to expand and review the questions.
  const [schemeExpanded, setSchemeExpanded] = useState(false);

  // "Approve all" — shown when there are AI-graded submissions awaiting
  // teacher approval. Common path for submissions that arrived via WhatsApp
  // or email channel where the teacher didn't grade in-app.
  const [approvingAll, setApprovingAll] = useState(false);

  // Camera state for file picker
  const [cameraVisible, setCameraVisible] = useState(false);
  const [cameraResolve, setCameraResolve] = useState<((f: PickedFile | null) => void) | null>(null);

  // Generate-with-AI modal state
  const [aiModalVisible, setAiModalVisible] = useState(false);
  const [qpText, setQpText] = useState('');
  const [generating, setGenerating] = useState(false);

  // Inline question editing (Fix 1)
  const [editingQIdx, setEditingQIdx]   = useState<number | null>(null);
  const [qDraftText, setQDraftText]     = useState('');
  const [qDraftAnswer, setQDraftAnswer] = useState('');
  const [qDraftMarks, setQDraftMarks]   = useState('');
  const [savingQ, setSavingQ]           = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [keysResult, subsResult, studentsResult] = await Promise.allSettled([
        listAnswerKeys(class_id),
        getTeacherSubmissions({ class_id, teacher_id: user?.id }),
        // Used to fill student_name on locally-queued submissions (which
        // arrive from the offline queue without the cloud-side name
        // enrichment, so they otherwise render as "Student").
        listStudents(class_id),
      ]);

      if (keysResult.status === 'rejected') {
        console.error('[HomeworkDetail] listAnswerKeys failed:', keysResult.reason);
        // Offline with empty cache for this class — let the screen
        // render its empty state instead of yelling at the teacher.
        const isOffline = (keysResult.reason as { isOffline?: boolean })?.isOffline;
        if (!isOffline) {
          Alert.alert(t('error'), 'Could not load homework details.');
        }
        return;
      }

      const ak = keysResult.value.find(k => k.id === answer_key_id) ?? null;
      setAnswerKey(ak);

      if (subsResult.status === 'fulfilled') {
        const cloudSubs = subsResult.value.filter(s => s.answer_key_id === answer_key_id);
        // Merge in offline-queued, locally-graded submissions so they show
        // up in this homework's list (and in all aggregate counts) before
        // cloud sync. Dedupe by (student_id, answer_key_id) — once cloud
        // has the same row, it wins.
        const { getQueueAsSubmissions } = await import('../services/offlineQueue');
        const queued = await getQueueAsSubmissions({ class_id, answer_key_id });
        const seenKeys = new Set(cloudSubs.map(s => `${s.student_id}::${s.answer_key_id}`));
        const localOnly = queued
          .filter(q => !seenKeys.has(`${q.student_id}::${q.answer_key_id}`))
          .map(q => q as unknown as TeacherSubmission);

        // Enrich any row that doesn't carry a student_name (chiefly the
        // locally-queued ones, but also covers the rare case of a cloud
        // row whose student doc is gone). Without this the row falls back
        // to the literal "Student" placeholder.
        const nameById = new Map<string, string>();
        if (studentsResult.status === 'fulfilled') {
          for (const st of studentsResult.value) {
            const full = `${st.first_name ?? ''} ${st.surname ?? ''}`.trim();
            if (full) nameById.set(st.id, full);
          }
        }
        const merged = [...cloudSubs, ...localOnly].map(s => {
          if (s.student_name && s.student_name !== 'Unknown') return s;
          const looked = nameById.get(s.student_id);
          return looked ? { ...s, student_name: looked } : s;
        });
        setSubmissions(merged);
      } else {
        console.error('[HomeworkDetail] getTeacherSubmissions failed:', subsResult.reason);
      }
    } finally {
      setLoading(false);
    }
  }, [answer_key_id, class_id, user?.id, t]);

  useFocusEffect(
    useCallback(() => { loadData(); }, [loadData]),
  );

  const handleToggleOpen = async () => {
    if (!answerKey) return;
    setTogglingOpen(true);
    try {
      const updated = await updateAnswerKey(answerKey.id, {
        open_for_submission: !answerKey.open_for_submission,
      });
      setAnswerKey(updated);
    } catch (err: any) {
      Alert.alert(t('error'), err.message ?? 'Could not update assignment.');
    } finally {
      setTogglingOpen(false);
    }
  };

  const handleSaveTitle = async () => {
    const newTitle = titleDraft.trim();
    if (!newTitle || !answerKey) return;
    setSavingTitle(true);
    try {
      const updated = await updateAnswerKey(answerKey.id, { title: newTitle });
      setAnswerKey(updated);
      setEditingTitle(false);
    } catch (err: any) {
      Alert.alert(t('error'), err.message ?? 'Could not rename homework.');
    } finally {
      setSavingTitle(false);
    }
  };

  const openInAppCamera = (): Promise<PickedFile | null> => {
    return new Promise((resolve) => {
      setCameraResolve(() => resolve);
      setCameraVisible(true);
    });
  };

  const handleCameraCapture = (uri: string) => {
    setCameraVisible(false);
    if (cameraResolve) {
      cameraResolve({ uri, name: `photo_${Date.now()}.jpg`, mimeType: 'image/jpeg', isImage: true });
      setCameraResolve(null);
    }
  };

  const handleCameraClose = () => {
    setCameraVisible(false);
    if (cameraResolve) {
      cameraResolve(null);
      setCameraResolve(null);
    }
  };

  const handlePickFile = async () => {
    const file = await pickFile(
      {
        title: t('add_question_paper'),
        takePhoto: t('take_photo'),
        gallery: t('choose_from_gallery'),
        uploadFile: t('upload_file'),
        cancel: t('cancel'),
      },
      openInAppCamera,
    );
    if (!file || !answerKey) return;

    setGenerating(true);
    try {
      const uri = file.isImage ? await enhanceImage(file.uri) : file.uri;
      const updated = await uploadAnswerKeyFile(
        answerKey.id,
        uri,
        file.isImage ? 'question_paper.jpg' : file.name,
        file.isImage ? 'image/jpeg' : file.mimeType,
      );
      setAnswerKey(updated);
      Alert.alert('Done', `Generated ${updated.questions.length} questions from your ${file.isImage ? 'photo' : 'file'}.`);
    } catch (err: any) {
      Alert.alert(t('error'), err.message ?? 'Could not generate marking scheme. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleGenerate = async () => {
    if (!qpText.trim()) {
      Alert.alert(t('error'), 'Question paper text is required.');
      return;
    }
    if (!answerKey) return;
    setGenerating(true);
    try {
      const updated = await updateAnswerKey(answerKey.id, {
        auto_generate: true,
        question_paper_text: qpText.trim(),
        ...(answerKey.education_level ? { education_level: answerKey.education_level as any } : {}),
      });
      setAnswerKey(updated);
      setAiModalVisible(false);
      setQpText('');
      Alert.alert('Done', `Generated ${updated.questions.length} questions from your marking scheme.`);
    } catch (err: any) {
      Alert.alert(t('error'), err.message ?? 'Could not generate marking scheme. Please try again.');
    } finally {
      setGenerating(false);
    }
  };

  const handleSaveQuestion = async (idx: number) => {
    if (!answerKey) return;
    setSavingQ(true);
    const updatedQuestions = answerKey.questions.map((q, i) =>
      i !== idx ? q : {
        ...q,
        question_text: qDraftText,
        correct_answer: qDraftAnswer,
        marks: Math.max(1, Number(qDraftMarks) || 1),
      },
    );
    try {
      const updated = await updateAnswerKey(answerKey.id, {
        questions: updatedQuestions.map(q => ({
          number: q.number,
          question_text: q.question_text,
          correct_answer: (q.correct_answer || q.answer || ''),
          marks: q.marks,
          marking_notes: q.marking_notes,
        })),
      });
      setAnswerKey(updated);
      setEditingQIdx(null);
    } catch (err: any) {
      Alert.alert(t('error'), err.message ?? 'Could not save question.');
    } finally {
      setSavingQ(false);
    }
  };

  const handleCloseModal = () => {
    setAiModalVisible(false);
    setQpText('');
  };

  const handleMarkStudents = () => {
    if (!answerKey) return;
    navigation.navigate('Mark', {
      class_id,
      class_name,
      education_level: answerKey.education_level ?? 'grade_7',
      answer_key_id: answerKey.id,
    });
  };

  /**
   * Bulk-approve every AI-graded submission on this homework that the
   * teacher hasn't yet approved. Use case: the teacher receives WhatsApp
   * or email submissions, opens the homework, and is happy to release
   * the AI grades wholesale without per-student review.
   */
  const handleApproveAll = () => {
    const ids = awaitingApproval
      .map(s => s.id)
      .filter((id): id is string => !!id);
    if (ids.length === 0) return;
    Alert.alert(
      'Approve all',
      `Approve all ${ids.length} graded submission${ids.length !== 1 ? 's' : ''} and release results to students?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve all',
          style: 'default',
          onPress: async () => {
            setApprovingAll(true);
            try {
              const result = await approveAllMarks(ids);
              await loadData();
              const skipped = (result.skipped?.length ?? 0) + (result.errors?.length ?? 0);
              Alert.alert(
                'Approved',
                skipped > 0
                  ? `${result.approved} approved · ${skipped} skipped (already approved or invalid).`
                  : `${result.approved} submission${result.approved !== 1 ? 's' : ''} approved.`,
              );
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Could not approve submissions.');
            } finally {
              setApprovingAll(false);
            }
          },
        },
      ],
    );
  };

  const handleCloseAndGrade = () => {
    if (!answerKey || pendingCount === 0) return;
    Alert.alert(
      'Close & Grade All',
      `Close submissions and grade all ${pendingCount} pending submission${pendingCount !== 1 ? 's' : ''}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Grade All',
          style: 'destructive',
          onPress: async () => {
            setClosingAndGrading(true);
            try {
              const result = await closeAndGrade(answerKey.id);
              setAnswerKey(prev => prev ? { ...prev, open_for_submission: false } : prev);
              Alert.alert(
                'Grading in progress',
                `${result.pending_count} submission${result.pending_count !== 1 ? 's' : ''} queued for grading. You'll receive a notification when done.`,
              );
            } catch (err: any) {
              Alert.alert(t('error'), err.message ?? 'Could not start grading. Please try again.');
            } finally {
              setClosingAndGrading(false);
            }
          },
        },
      ],
    );
  };

  if (loading) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  if (!answerKey) {
    return (
      <View style={styles.centre}>
        <Text style={styles.notFound}>{t('homework_not_found')}</Text>
        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.backLink}>{t('back')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  console.log('[HomeworkDetail] questions:', JSON.stringify(answerKey.questions));
  const isPendingSetup = answerKey.status === 'pending_setup';
  const hasQuestions = answerKey.questions.length > 0;
  const pendingCount = submissions.filter(s => s.status === 'pending').length;
  const gradedCount = submissions.filter(s => s.status === 'graded' || s.status === 'approved').length;
  // Submissions where AI has graded but the teacher hasn't approved yet.
  // These are the only ones the bulk "Approve all" button acts on. Both
  // 'graded' and the legacy 'graded_pending_approval' state qualify — the
  // row badge already groups them under "Awaiting Approval".
  const awaitingApproval = submissions.filter(
    s => s.status === 'graded' || s.status === 'graded_pending_approval',
  );

  return (
    <>
      <InAppCamera
        visible={cameraVisible}
        onCapture={handleCameraCapture}
        onClose={handleCameraClose}
        quality={0.85}
      />
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']} keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Header — back button + title block side-by-side */}
        <View style={styles.header}>
          <BackButton />
          <View style={styles.headerTitleBlock}>
            {/* Rename row — shown for Unlabeled/pending_setup homework */}
            {isPendingSetup && editingTitle ? (
              <View style={styles.renameRow}>
                <TextInput
                  style={styles.renameInput}
                  value={titleDraft}
                  onChangeText={setTitleDraft}
                  placeholder={t('homework_title_placeholder')}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={handleSaveTitle}
                />
                <TouchableOpacity
                  style={[styles.saveBtn, savingTitle && styles.saveBtnDisabled]}
                  onPress={handleSaveTitle}
                  disabled={savingTitle}
                >
                  {savingTitle
                    ? <ActivityIndicator size="small" color={COLORS.white} />
                    : <Text style={styles.saveBtnText}>{t('save')}</Text>
                  }
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.headingRow}>
                <Text style={styles.heading}>{answerKey.title ?? answerKey.subject}</Text>
                {isPendingSetup && (
                  <TouchableOpacity
                    onPress={() => { setTitleDraft(answerKey.title ?? ''); setEditingTitle(true); }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.renameLink}>{t('rename_homework')}</Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {answerKey.title && (
              <Text style={styles.subjectTag}>{answerKey.subject}</Text>
            )}
          </View>
        </View>

        {/* Key info row */}
        <View style={styles.infoCard}>
          <InfoRow label={t('created')} value={fmtDate(answerKey.created_at)} />
          {answerKey.due_date && (
            <InfoRow
              label={t('due_date')}
              value={`${fmtDate(answerKey.due_date)}  ·  ${fmtDueCountdown(answerKey.due_date)}`}
            />
          )}
          {answerKey.education_level && (
            <InfoRow label="Level" value={levelLabel(answerKey.education_level)} />
          )}
          <InfoRow label="Questions" value={String(answerKey.questions.length)} />
          {answerKey.total_marks != null && (
            <InfoRow label="Total marks" value={String(answerKey.total_marks)} />
          )}
          {answerKey.submission_code && (
            <InfoRow label="Submission code" value={answerKey.submission_code} />
          )}
        </View>

        {/* Share-with-students card. Only shown when the homework has
            a submission code — older homework without one falls back to
            the fuzzy email path and doesn't need this surface. The share
            sheet pre-fills the exact subject line students need to copy
            so a single tap-and-paste in their mail app gets the format
            right. */}
        {answerKey.submission_code && (
          <TouchableOpacity
            style={styles.shareCard}
            activeOpacity={0.85}
            onPress={() => {
              const code = answerKey.submission_code;
              const message =
                `Submit your homework "${answerKey.title || 'Homework'}" by emailing ` +
                `mark@neriah.ai with this exact subject:\n\n` +
                `Name: Your Full Name | Code: ${code}\n\n` +
                `Attach a clear photo or PDF of your answers.`;
              Share.share({
                message,
                title: 'Submit homework to Neriah',
              }).catch(() => {/* user cancelled */});
            }}
          >
            <Ionicons name="share-outline" size={18} color={COLORS.white} style={{ marginRight: 8 }} />
            <Text style={styles.shareCardText}>Share with students</Text>
          </TouchableOpacity>
        )}

        {/* Setup section — shown when no questions yet */}
        {!hasQuestions && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>{t('set_up_marking_scheme')}</Text>
            <Text style={styles.sectionHint}>{t('marking_scheme_hint')}</Text>
            <TouchableOpacity style={styles.setupBtn} onPress={handlePickFile}>
              <Ionicons name="document-outline" size={20} color={COLORS.teal500} style={styles.setupBtnIcon} />
              <View style={styles.setupBtnText}>
                <Text style={styles.setupBtnLabel}>{t('upload_question_paper_photo')}</Text>
                <Text style={styles.setupBtnSub}>{t('upload_question_paper_sub')}</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.setupBtn} onPress={() => setAiModalVisible(true)}>
              <Ionicons name="sparkles-outline" size={20} color={COLORS.teal500} style={styles.setupBtnIcon} />
              <View style={styles.setupBtnText}>
                <Text style={styles.setupBtnLabel}>{t('generate_with_ai')}</Text>
                <Text style={styles.setupBtnSub}>{t('generate_with_ai_sub')}</Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Questions summary — shown when questions exist. Collapsible:
            tap the header to fold/unfold the question list. */}
        {hasQuestions && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <TouchableOpacity
                style={styles.schemeTitleRow}
                onPress={() => setSchemeExpanded(v => !v)}
                activeOpacity={0.7}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons
                  name={schemeExpanded ? 'chevron-down' : 'chevron-forward'}
                  size={14}
                  color={COLORS.gray500}
                />
                <Text style={styles.sectionTitle}>{t('marking_scheme')}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={handlePickFile}>
                <Text style={styles.regenerateLink}>{t('regenerate')}</Text>
              </TouchableOpacity>
            </View>
            {schemeExpanded && <>
            {/* Show question paper image when question texts are missing */}
            {answerKey.questions.length > 0 && !answerKey.questions.some(q => q.question_text) && (
              (answerKey as any).qp_image_url ? (
                <View style={{ marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: COLORS.gray500, marginBottom: 8 }}>Question Paper</Text>
                  <Image
                    source={{ uri: (answerKey as any).qp_image_url }}
                    style={{ width: '100%', height: 300, borderRadius: 10, backgroundColor: COLORS.gray50 }}
                    resizeMode="contain"
                  />
                </View>
              ) : (
                <View style={{ backgroundColor: '#FFF8E1', borderRadius: 8, padding: 10, marginBottom: 10, borderLeftWidth: 3, borderLeftColor: '#F5A623' }}>
                  <Text style={{ fontSize: 13, color: '#92400E', lineHeight: 18 }}>
                    Question paper not available. Re-upload the question paper photo to see the questions here.
                  </Text>
                </View>
              )
            )}
            {answerKey.questions.map((q, idx) =>
              editingQIdx === idx ? (
                <View key={q.number ?? idx} style={styles.questionEditCard}>
                  <Text style={styles.questionEditNum}>Q{q.number ?? idx + 1}</Text>

                  <Text style={styles.editLabel}>Question</Text>
                  <TextInput
                    style={styles.editInput}
                    value={qDraftText}
                    onChangeText={setQDraftText}
                    placeholder="Question text"
                    multiline
                    textAlignVertical="top"
                  />

                  <Text style={styles.editLabel}>Correct Answer</Text>
                  <TextInput
                    style={styles.editInput}
                    value={qDraftAnswer}
                    onChangeText={setQDraftAnswer}
                    placeholder="Correct answer"
                    multiline
                    textAlignVertical="top"
                  />

                  <Text style={styles.editLabel}>Marks</Text>
                  <TextInput
                    style={[styles.editInput, styles.editInputSmall]}
                    value={qDraftMarks}
                    onChangeText={setQDraftMarks}
                    keyboardType="numeric"
                    placeholder="1"
                  />

                  <View style={styles.editActions}>
                    <TouchableOpacity
                      style={[styles.editSaveBtn, savingQ && styles.editSaveBtnDisabled]}
                      onPress={() => handleSaveQuestion(idx)}
                      disabled={savingQ}
                    >
                      {savingQ
                        ? <ActivityIndicator size="small" color={COLORS.white} />
                        : <Text style={styles.editSaveBtnText}>{t('save')}</Text>
                      }
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.editCancelBtn}
                      onPress={() => setEditingQIdx(null)}
                      disabled={savingQ}
                    >
                      <Text style={styles.editCancelBtnText}>{t('cancel')}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <TouchableOpacity
                  key={q.number ?? idx}
                  style={styles.questionRow}
                  onPress={() => {
                    setEditingQIdx(idx);
                    setQDraftText(q.question_text ?? '');
                    setQDraftAnswer((q.correct_answer || q.answer || '') ?? '');
                    setQDraftMarks(String(q.marks ?? 1));
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={styles.questionNum}>Q{q.number ?? idx + 1}</Text>
                  <View style={{ flex: 1 }}>
                    {q.question_text ? (
                      <>
                        <Text style={styles.questionText} numberOfLines={0}>{q.question_text}</Text>
                        <Text style={styles.questionAnswer} numberOfLines={0}>Answer: {(q.correct_answer || q.answer || '') ?? '—'}</Text>
                      </>
                    ) : (
                      <Text style={styles.questionAnswer} numberOfLines={0}>
                        {(q.correct_answer || q.answer || '') ? `Answer: ${(q.correct_answer || q.answer || '')}` : '—'}
                      </Text>
                    )}
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={styles.questionMarks}>{(q.marks != null && q.marks > 0) ? `${q.marks} marks` : '—'}</Text>
                  </View>
                  <Text style={styles.editChevron}>›</Text>
                </TouchableOpacity>
              ),
            )}
            </>}
          </View>
        )}

        {/* Submissions — compact: title + open/closed toggle + inline counts */}
        <View style={[styles.section, styles.submissionsSectionCompact]}>
          <View style={styles.submissionsCompactRow}>
            <Text style={styles.sectionTitleInline}>{t('submissions')}</Text>
            <TouchableOpacity
              style={[styles.toggle, answerKey.open_for_submission && styles.toggleOn]}
              onPress={handleToggleOpen}
              disabled={togglingOpen || !hasQuestions}
            >
              {togglingOpen
                ? <ActivityIndicator size="small" color={COLORS.white} />
                : <Text style={styles.toggleText}>
                    {answerKey.open_for_submission ? t('open') : t('closed')}
                  </Text>
              }
            </TouchableOpacity>
          </View>
          {!hasQuestions && (
            <Text style={styles.toggleWarning}>{t('setup_before_open')}</Text>
          )}

          {submissions.length > 0 && (
            <Text style={styles.submCountInline}>
              <Text style={styles.submCountNumInline}>{pendingCount}</Text>
              <Text style={styles.submCountLabelInline}> {t('pending')}  ·  </Text>
              <Text style={styles.submCountNumInline}>{gradedCount}</Text>
              <Text style={styles.submCountLabelInline}> {t('graded')}</Text>
            </Text>
          )}
        </View>

        {/* Student submissions list — sorted earliest first (Fix 2).
            "Approve all" appears next to the title when at least one
            submission is AI-graded but not yet teacher-approved. */}
        {submissions.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionTitle}>{t('student_submissions')}</Text>
              {awaitingApproval.length > 0 && (
                <TouchableOpacity
                  style={[styles.approveAllBtn, approvingAll && styles.approveAllBtnDisabled]}
                  onPress={handleApproveAll}
                  disabled={approvingAll}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                >
                  {approvingAll
                    ? <ActivityIndicator size="small" color={COLORS.white} />
                    : <Text style={styles.approveAllBtnText}>
                        Approve all ({awaitingApproval.length})
                      </Text>
                  }
                </TouchableOpacity>
              )}
            </View>
            {[...submissions]
              .sort((a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime())
              .map(s => (
                <TouchableOpacity
                  key={s.id}
                  style={styles.submissionRow}
                  activeOpacity={0.75}
                  onPress={() => {
                    // Both `graded` (AI-marked, teacher hasn't approved) and
                    // `approved` (final) are reviewable — open GradingDetail.
                    // Local-queue rows carry a synthesised "local_q_*"
                    // mark_id; GradingDetailScreen recognises that prefix
                    // and loads from the offline queue instead of hitting
                    // the API, so the teacher sees the same review UI for
                    // a locally-graded submission as for a cloud one.
                    if ((s.status === 'graded' || s.status === 'approved') && s.mark_id) {
                      navigation.navigate('GradingDetail', {
                        mark_id: s.mark_id,
                        student_name: s.student_name ?? 'Student',
                        class_name,
                        answer_key_title: answerKey?.title ?? '',
                      });
                    } else {
                      Alert.alert(
                        'Awaiting grading',
                        `${s.student_name ?? 'Student'}'s submission has been received and is queued for AI grading.`,
                      );
                    }
                  }}
                >
                  <View style={styles.submissionLeft}>
                    <Text style={styles.submissionName}>{s.student_name ?? 'Student'}</Text>
                    <Text style={styles.submissionDate}>{fmtDate(s.submitted_at)}</Text>
                  </View>
                  <View style={[
                    styles.submissionBadge,
                    // Green (teal) only when the teacher has approved. `graded`
                    // and `graded_pending_approval` get amber so students/
                    // teachers don't see a premature "final" colour for
                    // AI-only results.
                    s.status === 'approved' ? styles.badgeGraded : styles.badgePending,
                  ]}>
                    <Text style={[
                      styles.submissionBadgeText,
                      s.status === 'approved' ? styles.badgeGradedText : styles.badgePendingText,
                    ]}>
                      {s.status === 'approved'
                        ? t('graded')
                        : s.status === 'graded' || s.status === 'graded_pending_approval'
                        ? t('awaiting_approval')
                        : t('pending')}
                    </Text>
                  </View>
                  {(s.status === 'graded' || s.status === 'approved') && (
                    <Text style={styles.submissionChevron}>›</Text>
                  )}
                </TouchableOpacity>
              ))}
          </View>
        )}

        {/* Spacer for bottom button */}
        <View style={{ height: 100 }} />
      </ScrollView>
      </ScreenContainer>

      {/* Bottom action button */}
      <View style={styles.bottomBar}>
        {hasQuestions ? (
          <>
            {answerKey.open_for_submission && pendingCount > 0 && (
              <TouchableOpacity
                style={[styles.gradeAllBtn, closingAndGrading && styles.btnDisabled]}
                onPress={handleCloseAndGrade}
                disabled={closingAndGrading}
                activeOpacity={0.85}
              >
                {closingAndGrading ? (
                  <ActivityIndicator color={COLORS.white} />
                ) : (
                  <View style={styles.gradeAllBtnInner}>
                    <Ionicons name="sparkles-outline" size={16} color={COLORS.white} />
                    <Text style={styles.gradeAllBtnText}>  Close & Grade All ({pendingCount})</Text>
                  </View>
                )}
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.markBtn, (answerKey.open_for_submission && pendingCount > 0) && styles.markBtnSecondary]}
              onPress={handleMarkStudents}
              activeOpacity={0.85}
            >
              <View style={styles.markBtnInner}>
                <Ionicons name="camera-outline" size={16} color={(answerKey.open_for_submission && pendingCount > 0) ? COLORS.teal500 : COLORS.white} />
                <Text style={[styles.markBtnText, (answerKey.open_for_submission && pendingCount > 0) && styles.markBtnTextSecondary]}>
                  {'  '}{t('mark_students')}
                </Text>
              </View>
            </TouchableOpacity>
          </>
        ) : (
          <TouchableOpacity
            style={styles.uploadBtn}
            onPress={handlePickFile}
            activeOpacity={0.85}
          >
            <View style={styles.uploadBtnInner}>
              <Ionicons name="document-outline" size={16} color={COLORS.teal500} />
              <Text style={styles.uploadBtnText}>{'  '}Set Up Marking Scheme</Text>
            </View>
          </TouchableOpacity>
        )}
      </View>

      {/* Full-screen loading overlay — shown while generating from photo/file */}
      {generating && !aiModalVisible && (
        <View style={styles.generatingOverlay}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
          <Text style={styles.generatingText}>Generating marking scheme…</Text>
        </View>
      )}

      {/* Generate with AI modal */}
      <Modal
        visible={aiModalVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={handleCloseModal}
      >
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>{t('generate_scheme')}</Text>
            <TouchableOpacity onPress={handleCloseModal} hitSlop={{ top: 8, bottom: 8, left: 16, right: 8 }}>
              <Text style={styles.modalCancel}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.modalLabel}>{t('question_paper_text')}</Text>
            <Text style={styles.modalHint}>{t('question_paper_hint')}</Text>
            <TextInput
              style={styles.modalTextArea}
              placeholder={t('question_paper_placeholder')}
              value={qpText}
              onChangeText={setQpText}
              multiline
              textAlignVertical="top"
              autoFocus
            />

            <TouchableOpacity
              style={[styles.generateBtn, (generating || !qpText.trim()) && styles.generateBtnDisabled]}
              onPress={handleGenerate}
              disabled={generating || !qpText.trim()}
            >
              {generating
                ? <ActivityIndicator color={COLORS.white} />
                : <Text style={styles.generateBtnText}>{t('generate_scheme_btn')}</Text>
              }
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: COLORS.background },
  content: { paddingBottom: 20 },
  shareCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.teal500,
    marginHorizontal: 20,
    marginBottom: 20,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
  },
  shareCardText: {
    color: COLORS.white,
    fontWeight: '700',
    fontSize: 15,
  },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background },
  notFound: { fontSize: 16, color: COLORS.gray500, marginBottom: 12 },
  backLink: { fontSize: 16, color: COLORS.teal500 },

  header: {
    backgroundColor: COLORS.white, paddingHorizontal: 20,
    paddingTop: 16, paddingBottom: 20,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitleBlock: { flex: 1 },
  backText: { fontSize: 14, color: COLORS.teal500, marginBottom: 10 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 22, fontWeight: 'bold', color: COLORS.text, flex: 1 },
  renameLink: { fontSize: 13, color: COLORS.teal500, fontWeight: '600', marginLeft: 10 },
  subjectTag: { marginTop: 4, fontSize: 13, color: COLORS.gray500 },
  renameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  renameInput: {
    flex: 1, borderWidth: 1, borderColor: COLORS.teal500, borderRadius: 8,
    padding: 10, fontSize: 16, color: COLORS.text,
  },
  saveBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  saveBtnDisabled: { backgroundColor: COLORS.teal300 },
  saveBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },

  infoCard: {
    backgroundColor: COLORS.white, margin: 16, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 8,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.background,
  },
  infoLabel: { fontSize: 14, color: COLORS.gray500 },
  infoValue: { fontSize: 14, fontWeight: '600', color: COLORS.text },

  section: {
    backgroundColor: COLORS.white, marginHorizontal: 16, marginBottom: 12,
    borderRadius: 12, padding: 16,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: COLORS.gray500, textTransform: 'uppercase', marginBottom: 12 },
  sectionHint: { fontSize: 13, color: COLORS.textLight, marginBottom: 12 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  schemeTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  approveAllBtn: {
    backgroundColor: COLORS.teal500,
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 8,
    minWidth: 110, alignItems: 'center', justifyContent: 'center',
  },
  approveAllBtnDisabled: { opacity: 0.6 },
  approveAllBtnText: { color: COLORS.white, fontSize: 12, fontWeight: '700' },
  regenerateLink: { fontSize: 13, color: COLORS.teal500, fontWeight: '600' },

  setupBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: COLORS.background,
  },
  setupBtnIcon: { marginRight: 4 },
  setupBtnText: { flex: 1 },
  setupBtnLabel: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  setupBtnSub: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },

  questionRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.background,
  },
  questionNum: { fontSize: 13, fontWeight: '700', color: COLORS.teal500, minWidth: 28 },
  questionText: { fontSize: 14, fontWeight: '600', color: COLORS.text, lineHeight: 20 },
  questionAnswer: { fontSize: 13, color: COLORS.gray500, marginTop: 3, lineHeight: 18 },
  questionMarks: { fontSize: 12, color: COLORS.gray500, minWidth: 32, textAlign: 'right' },
  editChevron: { fontSize: 18, color: COLORS.gray500, marginLeft: 2 },

  // Inline question edit card (Fix 1)
  questionEditCard: {
    backgroundColor: COLORS.teal50, borderRadius: 10, padding: 12, marginBottom: 8,
    borderWidth: 1, borderColor: COLORS.teal100,
  },
  questionEditNum: { fontSize: 13, fontWeight: '700', color: COLORS.teal500, marginBottom: 6 },
  editLabel: {
    fontSize: 12, fontWeight: '600', color: COLORS.gray500,
    marginBottom: 4, marginTop: 8,
  },
  editInput: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 8,
    padding: 10, fontSize: 14, color: COLORS.text,
    backgroundColor: COLORS.white, minHeight: 42,
  },
  editInputSmall: { minHeight: 0, width: 80 },
  editActions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  editSaveBtn: {
    flex: 1, backgroundColor: COLORS.teal500, borderRadius: 8,
    padding: 10, alignItems: 'center',
  },
  editSaveBtnDisabled: { opacity: 0.6 },
  editSaveBtnText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },
  editCancelBtn: {
    flex: 1, borderWidth: 1, borderColor: COLORS.gray200,
    borderRadius: 8, padding: 10, alignItems: 'center',
  },
  editCancelBtnText: { color: COLORS.gray500, fontWeight: '600', fontSize: 14 },

  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  toggleLabel: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  toggleSub: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  toggle: {
    backgroundColor: COLORS.gray200, borderRadius: 8,
    paddingHorizontal: 14, paddingVertical: 8, minWidth: 70, alignItems: 'center',
  },
  toggleOn: { backgroundColor: COLORS.teal500 },
  toggleText: { color: COLORS.white, fontWeight: '700', fontSize: 13 },
  toggleWarning: { fontSize: 12, color: COLORS.amber500, marginTop: 8 },

  submCountRow: { flexDirection: 'row', gap: 12, marginTop: 16 },
  submCountBadge: {
    flex: 1, backgroundColor: COLORS.background, borderRadius: 10,
    padding: 12, alignItems: 'center',
  },
  submCountNum: { fontSize: 22, fontWeight: 'bold', color: COLORS.teal500 },
  submCountLabel: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },

  // Compact "Submissions" card — collapses the multi-row label / sub-label /
  // big count boxes into a single header row + inline count line.
  submissionsSectionCompact: { paddingVertical: 12 },
  submissionsCompactRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  sectionTitleInline: {
    fontSize: 13, fontWeight: '700', color: COLORS.gray500,
    textTransform: 'uppercase',
  },
  submCountInline: { marginTop: 10 },
  submCountNumInline: { fontSize: 14, fontWeight: '700', color: COLORS.teal500 },
  submCountLabelInline: { fontSize: 13, color: COLORS.gray500 },

  submissionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: COLORS.background,
  },
  submissionLeft: { flex: 1 },
  submissionName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  submissionDate: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  submissionBadge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 4 },
  badgePending: { backgroundColor: COLORS.amber50 },
  badgeGraded: { backgroundColor: COLORS.teal50 },
  submissionBadgeText: { fontSize: 13, fontWeight: '600' },
  badgePendingText: { color: COLORS.amber700 },
  badgeGradedText: { color: COLORS.teal700 },
  submissionChevron: { fontSize: 18, color: COLORS.gray500, marginLeft: 4 },

  // Bottom bar
  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: COLORS.white,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    padding: 16, paddingBottom: 32,
  },
  gradeAllBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    padding: 16, alignItems: 'center', marginBottom: 10,
  },
  gradeAllBtnInner: { flexDirection: 'row', alignItems: 'center' },
  gradeAllBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
  btnDisabled: { opacity: 0.6 },
  markBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    padding: 16, alignItems: 'center',
  },
  markBtnSecondary: {
    backgroundColor: COLORS.white, borderWidth: 1.5, borderColor: COLORS.teal500,
  },
  markBtnInner: { flexDirection: 'row', alignItems: 'center' },
  markBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
  markBtnTextSecondary: { color: COLORS.teal500 },
  uploadBtnInner: { flexDirection: 'row', alignItems: 'center' },
  uploadBtn: {
    backgroundColor: COLORS.amber50, borderRadius: 12,
    padding: 16, alignItems: 'center',
    borderWidth: 1, borderColor: COLORS.amber100,
  },
  uploadBtnText: { color: COLORS.amber700, fontWeight: 'bold', fontSize: 16 },

  // Modal
  modal: { flex: 1, backgroundColor: COLORS.white },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text },
  modalCancel: { fontSize: 16, color: COLORS.teal500, fontWeight: '600' },
  modalBody: { flex: 1, padding: 20 },
  modalLabel: { fontSize: 15, fontWeight: '600', color: COLORS.text, marginBottom: 4 },
  modalHint: { fontSize: 13, color: COLORS.gray500, marginBottom: 12 },
  modalTextArea: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10,
    padding: 14, fontSize: 15, color: COLORS.text, height: 180, marginBottom: 20,
  },
  generatingOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.92)',
    justifyContent: 'center', alignItems: 'center', gap: 16,
    zIndex: 10,
  },
  generatingText: { fontSize: 16, color: COLORS.text, fontWeight: '600' },
  generateBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 10, padding: 16, alignItems: 'center',
  },
  generateBtnDisabled: { backgroundColor: COLORS.teal300 },
  generateBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
});
