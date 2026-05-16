// src/screens/AddHomeworkScreen.tsx
// Create a new homework assignment (answer key) for a class.
// Homework paper upload is mandatory — Gemma 4 auto-generates the marking scheme.

import React, { useCallback, useState } from 'react';
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
  Modal,
  FlatList,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import { listClasses, createAnswerKey } from '../services/api';
import { resolveRoute, showUnavailableAlert } from '../services/router';
import { processPickedImage } from '../utils/imageProcessing';
import { Class } from '../types';
import { COLORS } from '../constants/colors';
import InAppCamera from '../components/InAppCamera';

const COMMON_SUBJECTS = [
  'Mathematics',
  'English Language',
  'English Literature',
  'Science',
  'Physics',
  'Chemistry',
  'Biology',
  'Geography',
  'History',
  'Religious Studies',
  'Agriculture',
  'Commerce',
  'Accounts',
  'Economics',
  'Computer Science',
  'Art',
  'Music',
  'Physical Education',
  'Shona',
  'Ndebele',
  'French',
  'Food and Nutrition',
  'Fashion and Fabrics',
  'Technical Graphics',
  'Building Studies',
];

interface QPFile {
  uri: string;
  name: string;
  mimeType: string;
  label: string;
  /** Pre-read base64 string. Set at pick time so handleCreate never re-reads. */
  base64?: string;
  /** True if auto-enhancement was applied to this file. */
  enhanced?: boolean;
}

export default function AddHomeworkScreen() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const {
    class_id: prefilledClassId,
    class_name: prefilledClassName,
    education_level: prefilledLevel,
  } = route.params ?? {};

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState('');
  const [subjectModalVisible, setSubjectModalVisible] = useState(false);
  const [subjectSearch, setSubjectSearch] = useState('');

  // Due date — default tomorrow at the same time
  const [dueDate, setDueDate] = useState<Date>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d;
  });
  const [showDatePicker, setShowDatePicker] = useState(false);
  // Total marks — empty = AI decides automatically
  const [teacherTotalMarks, setTeacherTotalMarks] = useState('');

  const [classes, setClasses] = useState<Class[]>([]);
  const [selectedClassId, setSelectedClassId] = useState<string>(prefilledClassId ?? '');
  const [showClassPicker, setShowClassPicker] = useState(false);
  const [loading, setLoading] = useState(false);

  // Homework paper state
  const [qpFile, setQpFile] = useState<QPFile | null>(null);
  const [qpText, setQpText] = useState('');
  const [textModalVisible, setTextModalVisible] = useState(false);
  const [textDraft, setTextDraft] = useState('');

  // Camera state — which slot is currently requesting the camera ('qp' | 'ms' | null)
  const [cameraTarget, setCameraTarget] = useState<'qp' | 'ms' | null>(null);

  // Manual marking scheme state (takes precedence over auto-generate when present)
  const [showManualScheme, setShowManualScheme] = useState(false);
  const [msFile, setMsFile] = useState<QPFile | null>(null);
  const [msText, setMsText] = useState('');
  const [msTextModalVisible, setMsTextModalVisible] = useState(false);
  const [msTextDraft, setMsTextDraft] = useState('');

  const selectedClass = prefilledClassId
    ? { id: prefilledClassId, name: prefilledClassName ?? '', education_level: prefilledLevel } as Class
    : classes.find(c => c.id === selectedClassId) ?? null;

  useFocusEffect(
    useCallback(() => {
      if (!prefilledClassId) {
        listClasses().then(setClasses).catch(() => {});
      }
    }, [prefilledClassId]),
  );

  // ── Subject picker ─────────────────────────────────────────────────────────

  const openSubjectModal = () => {
    setSubjectSearch('');
    setSubjectModalVisible(true);
  };

  const pickSubject = (s: string) => {
    setSubject(s);
    setSubjectModalVisible(false);
  };

  const useCustomSubject = () => {
    const custom = subjectSearch.trim();
    if (custom) {
      setSubject(custom);
      setSubjectModalVisible(false);
    }
  };

  const filteredSubjects = subjectSearch.trim()
    ? COMMON_SUBJECTS.filter(s => s.toLowerCase().includes(subjectSearch.toLowerCase()))
    : COMMON_SUBJECTS;

  const isExactMatch = COMMON_SUBJECTS.some(
    s => s.toLowerCase() === subjectSearch.toLowerCase(),
  );

  // ── Homework paper pickers ─────────────────────────────────────────────────

  const handleCamera = () => {
    setCameraTarget('qp');
  };

  // ── Shared: apply a processed image to the QP slot ───────────────────────────
  const applyQPImage = (processed: { uri: string; base64: string; enhanced: boolean }, name: string) => {
    setQpFile({ uri: processed.uri, name, mimeType: 'image/jpeg', label: `Gallery: ${name}`, base64: processed.base64, enhanced: processed.enhanced });
    console.log('[AddHomework] qp image set:', { enhanced: processed.enhanced, base64Length: processed.base64?.length });
    setQpText('');
  };

  const handleGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.85 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read image. Please try again.'); return; }
    const name = asset.fileName ?? `homework_${Date.now()}.jpg`;

    const processed = await processPickedImage(asset.uri);

    if (processed.warnings.length > 0) {
      Alert.alert(
        'This image may be hard to read',
        processed.warnings.join('\n'),
        [
          { text: 'Choose Another', onPress: () => handleGallery() },
          { text: 'Use Anyway', onPress: () => applyQPImage(processed, name) },
        ],
      );
    } else {
      applyQPImage(processed, name);
    }
  };

  const handlePickPDF = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'], copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read PDF. Please try again.'); return; }
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' as any });
      if (!base64) throw new Error('base64 is empty after reading');
      setQpFile({ uri: asset.uri, name: asset.name ?? 'document.pdf', mimeType: 'application/pdf', label: `PDF: ${asset.name}`, base64 });
      setQpText('');
      // Advisory: scanned PDFs may produce lower quality results
      Alert.alert(
        'PDF uploaded',
        'If this is a scanned document, results may vary. A clear photo or typed text gives the best results.',
        [{ text: 'OK' }],
        { cancelable: true },
      );
    } catch (err: any) {
      console.error('[PDF] FileSystem read failed:', err);
      Alert.alert('Error', 'Could not read the PDF file. Please try again.');
    }
  };

  const handlePickWord = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read Word file. Please try again.'); return; }
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' as any });
      if (!base64) throw new Error('base64 is empty after reading');
      const mimeType = asset.mimeType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      setQpFile({ uri: asset.uri, name: asset.name ?? 'document.docx', mimeType, label: `Word: ${asset.name}`, base64 });
      setQpText('');
    } catch (err: any) {
      console.error('[Word] FileSystem read failed:', err);
      Alert.alert('Error', 'Could not read the Word file. Please try again.');
    }
  };

  const handleTextDone = () => {
    const text = textDraft.trim();
    if (text) {
      setQpText(text);
      setQpFile(null);
    }
    setTextModalVisible(false);
  };

  const clearQP = () => {
    setQpFile(null);
    setQpText('');
  };

  // ── Manual scheme pickers ──────────────────────────────────────────────────

  const handleMSCamera = () => {
    setCameraTarget('ms');
  };

  // ── Shared: apply a processed image to the MS slot ───────────────────────────
  const applyMSImage = (processed: { uri: string; base64: string; enhanced: boolean }, name: string) => {
    setMsFile({ uri: processed.uri, name, mimeType: 'image/jpeg', label: `Gallery: ${name}`, base64: processed.base64, enhanced: processed.enhanced });
    setMsText('');
  };

  const handleMSGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.85 });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read image. Please try again.'); return; }
    const name = asset.fileName ?? `scheme_${Date.now()}.jpg`;

    const processed = await processPickedImage(asset.uri);

    if (processed.warnings.length > 0) {
      Alert.alert(
        'This image may be hard to read',
        processed.warnings.join('\n'),
        [
          { text: 'Choose Another', onPress: () => handleMSGallery() },
          { text: 'Use Anyway', onPress: () => applyMSImage(processed, name) },
        ],
      );
    } else {
      applyMSImage(processed, name);
    }
  };

  const handleMSPickPDF = async () => {
    const result = await DocumentPicker.getDocumentAsync({ type: ['application/pdf'], copyToCacheDirectory: true });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read PDF. Please try again.'); return; }
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' as any });
      if (!base64) throw new Error('base64 is empty');
      setMsFile({ uri: asset.uri, name: asset.name ?? 'scheme.pdf', mimeType: 'application/pdf', label: `PDF: ${asset.name}`, base64 });
      setMsText('');
      Alert.alert(
        'PDF uploaded',
        'If this is a scanned document, results may vary. A clear photo or typed text gives the best results.',
        [{ text: 'OK' }],
        { cancelable: true },
      );
    } catch (err: any) {
      console.error('[MS PDF] FileSystem read failed:', err);
      Alert.alert('Error', 'Could not read the PDF file. Please try again.');
    }
  };

  const handleMSPickWord = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (!asset.uri) { Alert.alert('Error', 'Could not read Word file. Please try again.'); return; }
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, { encoding: 'base64' as any });
      if (!base64) throw new Error('base64 is empty');
      const mimeType = asset.mimeType ?? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      setMsFile({ uri: asset.uri, name: asset.name ?? 'scheme.docx', mimeType, label: `Word: ${asset.name}`, base64 });
      setMsText('');
    } catch (err: any) {
      console.error('[MS Word] FileSystem read failed:', err);
      Alert.alert('Error', 'Could not read the Word file. Please try again.');
    }
  };

  const handleMSTextDone = () => {
    const text = msTextDraft.trim();
    if (text) { setMsText(text); setMsFile(null); }
    setMsTextModalVisible(false);
  };

  const clearMS = () => { setMsFile(null); setMsText(''); };

  // ── Due date helpers ───────────────────────────────────────────────────────

  const fmtDueDate = (d: Date): string => {
    const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
    const datePart = d.toLocaleDateString(undefined, opts);
    const timePart = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `${datePart} · ${timePart}`;
  };

  const handleDateChange = (_event: DateTimePickerEvent, selected?: Date) => {
    if (Platform.OS === 'android') setShowDatePicker(false);
    if (selected) setDueDate(selected);
  };

  // ── Create ─────────────────────────────────────────────────────────────────

  const hasQP = !!(qpFile || qpText);
  const hasMS = !!(msFile || msText);
  const hasAnyUpload = hasQP || hasMS;

  const handleCreate = async () => {
    const t = title.trim();
    const s = subject.trim();
    if (!t) { Alert.alert('Title required', 'Please enter a homework title.'); return; }
    if (!s) { Alert.alert('Subject required', 'Please select a subject.'); return; }
    if (!selectedClassId) { Alert.alert('Class required', 'Please select a class.'); return; }
    if (!hasAnyUpload) {
      Alert.alert('Upload required', 'Please upload the homework paper or marking scheme before creating.');
      return;
    }

    const educationLevel = selectedClass?.education_level ?? prefilledLevel ?? '';
    const dueDateIso = dueDate.toISOString();
    const totalMarksNum = teacherTotalMarks.trim() ? parseInt(teacherTotalMarks.trim(), 10) : undefined;

    // ── Route check ───────────────────────────────────────────────────────────
    // Scheme generation requires cloud (Gemma 4 multimodal). On-device scheme
    // generation via LiteRT is text-only and wired through resolveRoute below.
    const route = await resolveRoute('scheme');
    if (route === 'unavailable') {
      showUnavailableAlert();
      return;
    }

    setLoading(true);
    try {
      let ak;
      // base64 is pre-read at pick time — never call FileSystem here
      let qpFileBase64: string | undefined;
      let qpMediaType: string | undefined;

      console.log('[AddHomework] Calling generate-scheme with:', {
        title: t,
        subject: s,
        education_level: educationLevel,
        media_type: qpFile?.mimeType ?? msFile?.mimeType ?? 'text',
        base64Length: (qpFile?.base64 ?? msFile?.base64)?.length,
        hasBase64: !!(qpFile?.base64 ?? msFile?.base64),
        hasText: !!(qpText || msText),
      });

      if (hasMS) {
        if (msFile) {
          if (!msFile.base64) {
            Alert.alert('Error', 'Could not read file. Please re-select it and try again.');
            return;
          }
          qpFileBase64 = msFile.base64;
          qpMediaType = msFile.mimeType;
          ak = await createAnswerKey({
            class_id: selectedClassId,
            title: t,
            education_level: educationLevel,
            subject: s,
            input_type: 'answer_key',
            file_data: msFile.base64,
            media_type: msFile.mimeType,
            due_date: dueDateIso,
            teacher_total_marks: totalMarksNum,
          });
        } else {
          ak = await createAnswerKey({
            class_id: selectedClassId,
            title: t,
            subject: s,
            education_level: educationLevel,
            question_paper_text: msText,
            input_type: 'answer_key',
            due_date: dueDateIso,
            teacher_total_marks: totalMarksNum,
          });
        }
      } else if (qpFile) {
        if (!qpFile.base64) {
          Alert.alert('Error', 'Could not read file. Please re-select it and try again.');
          return;
        }
        qpFileBase64 = qpFile.base64;
        qpMediaType = qpFile.mimeType;
        ak = await createAnswerKey({
          class_id: selectedClassId,
          title: t,
          education_level: educationLevel,
          subject: s,
          input_type: 'question_paper',
          file_data: qpFile.base64,
          media_type: qpFile.mimeType,
          due_date: dueDateIso,
          teacher_total_marks: totalMarksNum,
        });
      } else {
        ak = await createAnswerKey({
          class_id: selectedClassId,
          title: t,
          subject: s,
          education_level: educationLevel,
          question_paper_text: qpText,
          input_type: 'question_paper',
          due_date: dueDateIso,
          teacher_total_marks: totalMarksNum,
        });
      }

      // Navigate to review screen so teacher can inspect/edit before confirming
      const className = selectedClass?.name ?? prefilledClassName ?? '';
      console.log('[AddHomework] generate-scheme response:', JSON.stringify(ak));
      console.log('[AddHomework] Navigating with questions:', JSON.stringify((ak.questions as any) ?? []));
      navigation.replace('ReviewScheme', {
        answer_key_id: ak.id,
        class_id: selectedClassId,
        class_name: className,
        questions: (ak.questions as any) ?? [],
        qp_text: qpText || msText || undefined,
        qp_file_base64: qpFileBase64,
        qp_media_type: qpMediaType,
      });
    } catch (err: any) {
      Alert.alert('Error', err.message ?? 'Could not create homework. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── InAppCamera handler ────────────────────────────────────────────────────

  const handleCameraCapture = async (uri: string) => {
    // InAppCamera already ran enhanceImage internally — mark as enhanced.
    // Read base64 here since the backend upload flow expects it on the file
    // object (InAppCamera no longer computes it).
    let base64 = '';
    try {
      base64 = await FileSystem.readAsStringAsync(uri, { encoding: 'base64' as any });
    } catch (e) {
      console.warn('[AddHomework] failed to read base64 from camera URI:', e);
    }
    if (cameraTarget === 'qp') {
      setQpFile({ uri, name: `homework_${Date.now()}.jpg`, mimeType: 'image/jpeg', label: 'Camera photo', base64, enhanced: true });
      setQpText('');
    } else if (cameraTarget === 'ms') {
      setMsFile({ uri, name: `scheme_${Date.now()}.jpg`, mimeType: 'image/jpeg', label: 'Camera photo', base64, enhanced: true });
      setMsText('');
    }
    setCameraTarget(null);
  };

  return (
    <>
      <InAppCamera
        visible={cameraTarget !== null}
        onCapture={handleCameraCapture}
        onClose={() => setCameraTarget(null)}
        quality={0.85}
      />
      <ScreenContainer>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header — back button + title side-by-side */}
          <View style={styles.headerRow}>
            <BackButton />
            <View style={styles.headerTitleBlock}>
              <Text style={styles.heading}>Add Homework</Text>
            </View>
          </View>
          <Text style={styles.subheading}>
            Upload the homework paper and Neriah will generate the marking scheme for you.
          </Text>

          <View style={styles.form}>
            {/* Class selector */}
            {!prefilledClassId && (
              <>
                <Text style={styles.label}>Class</Text>
                <TouchableOpacity
                  style={styles.pickerButton}
                  onPress={() => setShowClassPicker(v => !v)}
                >
                  <Text style={[styles.pickerText, !selectedClassId && styles.placeholder]}>
                    {selectedClass?.name ?? 'Select a class'}
                  </Text>
                  <Text style={styles.chevronText}>▾</Text>
                </TouchableOpacity>
                {showClassPicker && (
                  <View style={styles.dropdown}>
                    {classes.map(c => (
                      <TouchableOpacity
                        key={c.id}
                        style={[styles.dropdownItem, c.id === selectedClassId && styles.dropdownItemActive]}
                        onPress={() => { setSelectedClassId(c.id); setShowClassPicker(false); }}
                      >
                        <Text style={[styles.dropdownText, c.id === selectedClassId && styles.dropdownTextActive]}>
                          {c.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </>
            )}

            <Text style={styles.label}>Title</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Chapter 5 Revision Test"
              value={title}
              onChangeText={setTitle}
              autoCapitalize="sentences"
            />

            {/* Subject picker */}
            <Text style={styles.label}>Subject</Text>
            <TouchableOpacity style={styles.pickerButton} onPress={openSubjectModal}>
              <Text style={[styles.pickerText, !subject && styles.placeholder]}>
                {subject || 'Select or type a subject'}
              </Text>
              <Text style={styles.chevronText}>▾</Text>
            </TouchableOpacity>

            {/* ── Due Date + Total Marks row ─────────────────────────────── */}
            <View style={styles.dueTotalRow}>
              <View style={styles.dueTotalLeft}>
                <Text style={styles.label}>Due Date</Text>
                <TouchableOpacity
                  style={styles.dateButton}
                  onPress={() => setShowDatePicker(true)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.dateButtonText}>{fmtDueDate(dueDate)}</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.dueTotalRight}>
                <Text style={styles.label}>Total Marks</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. 20"
                  value={teacherTotalMarks}
                  onChangeText={setTeacherTotalMarks}
                  keyboardType="numeric"
                  returnKeyType="done"
                />
              </View>
            </View>

            {showDatePicker && (
              <DateTimePicker
                value={dueDate}
                mode="datetime"
                display={Platform.OS === 'ios' ? 'inline' : 'default'}
                onChange={handleDateChange}
                minimumDate={new Date()}
              />
            )}
            {/* iOS: confirm button to dismiss inline picker */}
            {showDatePicker && Platform.OS === 'ios' && (
              <TouchableOpacity
                style={styles.dateConfirmBtn}
                onPress={() => setShowDatePicker(false)}
              >
                <Text style={styles.dateConfirmText}>Done</Text>
              </TouchableOpacity>
            )}

            {/* ── Homework paper section ──────────────────────────────────── */}
            <Text style={styles.sectionLabel}>HOMEWORK PAPER (required)</Text>
            <Text style={styles.sectionHint}>
              Upload the question paper. Neriah will read it and auto-generate the marking scheme.
            </Text>

            <View style={styles.uploadRow}>
              <TouchableOpacity style={styles.uploadBtn} onPress={handleCamera}>
                <Ionicons name="camera-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                <Text style={styles.uploadLabel}>Camera</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.uploadBtn} onPress={handleGallery}>
                <Ionicons name="image-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                <Text style={styles.uploadLabel}>Gallery</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.uploadBtn} onPress={handlePickPDF}>
                <Ionicons name="document-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                <Text style={styles.uploadLabel}>PDF</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.uploadBtn} onPress={handlePickWord}>
                <Ionicons name="document-text-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                <Text style={styles.uploadLabel}>Word</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.uploadBtn} onPress={() => { setTextDraft(qpText); setTextModalVisible(true); }}>
                <Ionicons name="pencil-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                <Text style={styles.uploadLabel}>Text</Text>
              </TouchableOpacity>
            </View>

            {hasQP && (
              <View style={styles.qpPreview}>
                <Text style={styles.qpPreviewIcon}>✓</Text>
                <Text style={styles.qpPreviewText} numberOfLines={1}>
                  {qpFile ? qpFile.label : `${qpText.length} characters of text`}
                </Text>
                {qpFile?.enhanced && (
                  <View style={styles.enhancedBadge}>
                    <Text style={styles.enhancedBadgeText}>✓ Enhanced</Text>
                  </View>
                )}
                <TouchableOpacity onPress={clearQP} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text style={styles.qpClear}>✕</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* ── Divider + manual scheme link / section ─────────────────── */}
            <View style={styles.divider} />

            <TouchableOpacity
              style={styles.manualSchemeLink}
              onPress={() => {
                if (showManualScheme && hasMS) {
                  Alert.alert(
                    'Remove manual scheme?',
                    'Hiding this section will remove your uploaded marking scheme. Neriah will auto-generate one instead.',
                    [
                      { text: 'Remove', style: 'destructive', onPress: () => { clearMS(); setShowManualScheme(false); } },
                      { text: 'Keep', style: 'cancel' },
                    ],
                  );
                } else {
                  setShowManualScheme(v => !v);
                }
              }}
              activeOpacity={0.6}
            >
              <Text style={styles.manualSchemeLinkText}>
                {showManualScheme ? 'Hide manual marking scheme ↑' : 'Upload marking scheme manually →'}
              </Text>
            </TouchableOpacity>

            {showManualScheme && (
              <>
                <Text style={styles.sectionLabel}>MARKING SCHEME (Manual)</Text>
                <Text style={styles.sectionHint}>
                  {hasMS
                    ? 'Manual scheme will be used instead of auto-generating.'
                    : 'Optional. Upload your own answer key — Neriah will extract the marking scheme from it.'}
                </Text>

                <View style={styles.uploadRow}>
                  <TouchableOpacity style={styles.uploadBtn} onPress={handleMSCamera}>
                    <Ionicons name="camera-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                    <Text style={styles.uploadLabel}>Camera</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.uploadBtn} onPress={handleMSGallery}>
                    <Ionicons name="image-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                    <Text style={styles.uploadLabel}>Gallery</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.uploadBtn} onPress={handleMSPickPDF}>
                    <Ionicons name="document-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                    <Text style={styles.uploadLabel}>PDF</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.uploadBtn} onPress={handleMSPickWord}>
                    <Ionicons name="document-text-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                    <Text style={styles.uploadLabel}>Word</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.uploadBtn} onPress={() => { setMsTextDraft(msText); setMsTextModalVisible(true); }}>
                    <Ionicons name="pencil-outline" size={22} color={COLORS.teal500} style={styles.uploadIcon} />
                    <Text style={styles.uploadLabel}>Text</Text>
                  </TouchableOpacity>
                </View>

                {hasMS && (
                  <View style={styles.qpPreview}>
                    <Text style={styles.qpPreviewIcon}>✓</Text>
                    <Text style={styles.qpPreviewText} numberOfLines={1}>
                      {msFile ? msFile.label : `${msText.length} characters of text`}
                    </Text>
                    {msFile?.enhanced && (
                      <View style={styles.enhancedBadge}>
                        <Text style={styles.enhancedBadgeText}>✓ Enhanced</Text>
                      </View>
                    )}
                    <TouchableOpacity onPress={clearMS} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                      <Text style={styles.qpClear}>✕</Text>
                    </TouchableOpacity>
                  </View>
                )}
              </>
            )}

            <TouchableOpacity
              style={[styles.button, loading && styles.buttonDisabled]}
              onPress={handleCreate}
              disabled={loading}
            >
              {loading ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color={COLORS.white} size="small" />
                  <Text style={styles.buttonText}>
                    {hasMS ? '  Processing marking scheme…' : '  Neriah is generating your marking scheme…'}
                  </Text>
                </View>
              ) : (
                <Text style={styles.buttonText}>Create & Generate Answers</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </ScreenContainer>

      {/* Subject picker modal */}
      <Modal
        visible={subjectModalVisible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        onRequestClose={() => setSubjectModalVisible(false)}
      >
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Subject</Text>
            <TouchableOpacity onPress={() => setSubjectModalVisible(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.searchContainer}>
            <TextInput
              style={styles.searchInput}
              placeholder="Search or type a custom subject…"
              value={subjectSearch}
              onChangeText={setSubjectSearch}
              autoCapitalize="words"
              autoFocus
              clearButtonMode="while-editing"
            />
          </View>

          <FlatList
            data={filteredSubjects}
            keyExtractor={item => item}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const isSelected = item === subject;
              return (
                <TouchableOpacity
                  style={[styles.subjectRow, isSelected && styles.subjectRowSelected]}
                  onPress={() => pickSubject(item)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.subjectRowText, isSelected && styles.subjectRowTextSelected]}>
                    {item}
                  </Text>
                  {isSelected && <Text style={styles.subjectRowCheck}>✓</Text>}
                </TouchableOpacity>
              );
            }}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListFooterComponent={
              subjectSearch.trim() && !isExactMatch ? (
                <TouchableOpacity style={styles.customRow} onPress={useCustomSubject}>
                  <Text style={styles.customRowText}>
                    Use "<Text style={styles.customRowBold}>{subjectSearch.trim()}</Text>"
                  </Text>
                </TouchableOpacity>
              ) : null
            }
          />
        </SafeAreaView>
      </Modal>

      {/* Text input modal — Homework Paper */}
      <Modal
        visible={textModalVisible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        onRequestClose={() => setTextModalVisible(false)}
      >
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setTextModalVisible(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Homework Paper Text</Text>
            <TouchableOpacity onPress={handleTextDone}>
              <Text style={styles.modalDone}>Done</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.modalHint}>
            Type or paste the questions from the paper. Gemma 4 will generate the marking scheme.
          </Text>
          <TextInput
            style={styles.modalTextArea}
            placeholder={'1. Solve for x: 2x + 5 = 13\n2. State Newton\'s first law of motion\n...'}
            value={textDraft}
            onChangeText={setTextDraft}
            multiline
            textAlignVertical="top"
            autoFocus
          />
        </SafeAreaView>
      </Modal>

      {/* Text input modal — Manual Marking Scheme */}
      <Modal
        visible={msTextModalVisible}
        animationType="slide"
        presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
        onRequestClose={() => setMsTextModalVisible(false)}
      >
        <SafeAreaView style={styles.modal}>
          <View style={styles.modalHeader}>
            <TouchableOpacity onPress={() => setMsTextModalVisible(false)}>
              <Text style={styles.modalCancel}>Cancel</Text>
            </TouchableOpacity>
            <Text style={styles.modalTitle}>Marking Scheme Text</Text>
            <TouchableOpacity onPress={handleMSTextDone}>
              <Text style={styles.modalDone}>Done</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.modalHint}>
            Type or paste the marking scheme. Neriah will extract the answers and marks from it.
          </Text>
          <TextInput
            style={styles.modalTextArea}
            placeholder={'1. x = 4  [2 marks]\n2. An object at rest stays at rest unless acted on by a force.  [2 marks]\n...'}
            value={msTextDraft}
            onChangeText={setMsTextDraft}
            multiline
            textAlignVertical="top"
            autoFocus
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.white },
  container: { flexGrow: 1, padding: 24 },
  back: { marginBottom: 24 },
  backText: { fontSize: 16, color: COLORS.gray500 },
  headerRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6,
  },
  headerTitleBlock: { flex: 1 },
  heading: { fontSize: 26, fontWeight: 'bold', color: COLORS.text },
  subheading: { fontSize: 14, color: COLORS.gray500, marginBottom: 28 },
  form: { gap: 8 },
  label: { fontSize: 14, fontWeight: '600', color: COLORS.gray900, marginTop: 8 },
  input: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10,
    padding: 14, fontSize: 16, color: COLORS.text,
  },
  pickerButton: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10, padding: 14,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  pickerText: { fontSize: 16, color: COLORS.text },
  placeholder: { color: COLORS.gray500 },
  chevronText: { color: COLORS.gray500, fontSize: 14 },
  dropdown: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10,
    backgroundColor: COLORS.white, marginTop: 4,
    shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  dropdownItem: { padding: 14, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  dropdownItemActive: { backgroundColor: COLORS.teal50 },
  dropdownText: { fontSize: 15, color: COLORS.text },
  dropdownTextActive: { color: COLORS.teal500, fontWeight: '600' },

  // Due Date + Total Marks row
  dueTotalRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  dueTotalLeft: { flex: 3 },
  dueTotalRight: { flex: 2 },
  dateButton: {
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10,
    padding: 14, backgroundColor: COLORS.white,
  },
  dateButtonText: { fontSize: 14, color: COLORS.text },
  dateConfirmBtn: {
    alignSelf: 'flex-end', marginTop: 8, paddingHorizontal: 20, paddingVertical: 8,
    backgroundColor: COLORS.teal500, borderRadius: 8,
  },
  dateConfirmText: { color: COLORS.white, fontWeight: '700', fontSize: 14 },

  // Homework paper section
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: COLORS.gray500,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: 24, marginBottom: 4,
  },
  sectionHint: { fontSize: 13, color: COLORS.textLight, marginBottom: 12 },
  uploadRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  uploadBtn: {
    flex: 1, alignItems: 'center', paddingVertical: 12,
    borderWidth: 1, borderColor: COLORS.gray200, borderRadius: 10,
    backgroundColor: COLORS.background,
  },
  uploadIcon: { marginBottom: 2 },
  uploadLabel: { fontSize: 11, color: COLORS.gray500, marginTop: 4, fontWeight: '500' },
  qpPreview: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: COLORS.teal50, borderRadius: 10, padding: 12,
    marginTop: 8, borderWidth: 1, borderColor: COLORS.teal100,
  },
  qpPreviewIcon: { fontSize: 16, color: COLORS.teal500, fontWeight: '700' },
  qpPreviewText: { flex: 1, fontSize: 13, color: COLORS.teal700, fontWeight: '500' },
  qpClear: { fontSize: 14, color: COLORS.teal500 },
  enhancedBadge: {
    backgroundColor: COLORS.teal500,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  enhancedBadgeText: { fontSize: 10, color: COLORS.white, fontWeight: '700' },

  // Section divider
  divider: {
    height: 1, backgroundColor: COLORS.border, marginTop: 24, marginBottom: 16,
  },
  manualSchemeLink: {
    alignItems: 'center', paddingVertical: 4,
  },
  manualSchemeLinkText: {
    fontSize: 13, color: COLORS.gray500,
  },

  // Create button
  button: {
    marginTop: 28, backgroundColor: COLORS.teal500, borderRadius: 10,
    padding: 16, alignItems: 'center',
  },
  buttonDisabled: { backgroundColor: COLORS.teal300 },
  buttonText: { color: COLORS.white, fontWeight: 'bold', fontSize: 16 },
  loadingRow: { flexDirection: 'row', alignItems: 'center' },

  // Shared modal shell
  modal: { flex: 1, backgroundColor: COLORS.white },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  modalTitle: { fontSize: 17, fontWeight: '700', color: COLORS.text },
  modalCancel: { fontSize: 16, color: COLORS.gray500 },
  modalDone: { fontSize: 16, color: COLORS.teal500, fontWeight: '700' },

  // Subject modal
  searchContainer: {
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  searchInput: {
    backgroundColor: COLORS.background, borderRadius: 10,
    paddingHorizontal: 14, paddingVertical: 10,
    fontSize: 15, color: COLORS.text,
  },
  subjectRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingVertical: 16,
  },
  subjectRowSelected: { backgroundColor: COLORS.teal50 },
  subjectRowText: { flex: 1, fontSize: 16, color: COLORS.text },
  subjectRowTextSelected: { color: COLORS.teal500, fontWeight: '600' },
  subjectRowCheck: { fontSize: 16, color: COLORS.teal500, fontWeight: '700' },
  separator: { height: 1, backgroundColor: COLORS.border, marginLeft: 20 },
  customRow: {
    paddingHorizontal: 20, paddingVertical: 16,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    backgroundColor: COLORS.background,
  },
  customRowText: { fontSize: 15, color: COLORS.teal500 },
  customRowBold: { fontWeight: '700' },

  // Text modal
  modalHint: {
    fontSize: 13, color: COLORS.gray500, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8,
  },
  modalTextArea: {
    flex: 1, paddingHorizontal: 20, paddingTop: 8,
    fontSize: 15, color: COLORS.text, lineHeight: 22,
  },
});
