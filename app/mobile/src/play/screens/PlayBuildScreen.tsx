// src/play/screens/PlayBuildScreen.tsx
//
// Form for kicking off a new lesson build.
//
//   - Header: Back button, title, profile circle (right) with online dot.
//   - Title input + subject pills (one line) + level pills.
//   - Source: photograph (InAppCamera), gallery image, PDF, Word document.
//     Scanned PDFs/DOCX are routed through extractAttachmentText which
//     falls back to OCR rendering when the file has no embedded text.
//   - Generate game CTA dispatches:
//       online  → playApi.createLesson, navigate to PlayPreview. The
//                 generator always returns 100 questions in one pass; if
//                 it can't, the route returns 503 and the screen Alerts.
//       offline → mints a taskId, navigates to PlayBuildProgress, which
//                 drives the on-device generator.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import NetInfo from '@react-native-community/netinfo';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import { BackButton } from '../../components/BackButton';
import InAppCamera from '../../components/InAppCamera';
import TrackedPressable from '../../components/TrackedPressable';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { track, trackError, trackScreen } from '../../services/analytics';
import { resolveRoute } from '../../services/router';
import { isOcrAvailable, recognizeTextInImage } from '../../services/ocr';
import { extractAttachmentText } from '../../services/clientFileExtract';
import { playApi } from '../../services/play';
import { persistFormSnapshot } from './PlayBuildProgressScreen';
import type { PlayStackParamList } from '../types';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlayBuild'>;

const SUBJECTS = ['Math', 'English', 'Science', 'Other'];
const LEVELS = [
  'Grade 1', 'Grade 2', 'Grade 3', 'Grade 4', 'Grade 5', 'Grade 6', 'Grade 7',
  'Form 1', 'Form 2', 'Form 3', 'Form 4', 'Form 5', 'Form 6',
  'College/University',
];

export default function PlayBuildScreen() {
  const navigation = useNavigation<Nav>();
  const { t } = useLanguage();
  const { user } = useAuth();

  const [title, setTitle] = useState('');
  const [subject, setSubject] = useState<string>('');
  const [level, setLevel] = useState<string>('');
  const [notes, setNotes] = useState('');
  const [generating, setGenerating] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [route, setRoute] = useState<'cloud' | 'on-device' | 'unavailable'>('cloud');

  // Re-evaluate routing whenever network state changes.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const r = await resolveRoute('play_lesson_gen');
        if (!cancelled) setRoute(r);
      } catch {
        /* keep last known */
      }
    };
    refresh();
    const unsub = NetInfo.addEventListener(refresh);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    trackScreen('PlayBuild');
  }, []);

  // ── Note ingestion ──────────────────────────────────────────────────────────

  const appendNotes = useCallback((text: string) => {
    setNotes((prev) => (prev ? `${prev}\n\n${text}` : text));
  }, []);

  const onPhotographNotes = useCallback(async () => {
    track('play.build.photograph_notes');
    if (!isOcrAvailable()) {
      Alert.alert(
        'Camera unavailable here',
        'OCR is not linked in this build. Please type your notes instead.',
      );
      return;
    }
    setShowCamera(true);
  }, []);

  const onCameraCapture = useCallback(async (uri: string) => {
    setShowCamera(false);
    try {
      const text = await recognizeTextInImage(uri);
      if (!text) {
        Alert.alert('No text found', 'We could not read this image. Try a clearer photo.');
        return;
      }
      appendNotes(text);
    } catch (err) {
      trackError('play.build.ocr.failed', err);
      Alert.alert('Could not read photo', 'Please try again or type the notes.');
    }
  }, [appendNotes]);

  const onPickFromGallery = useCallback(async () => {
    track('play.build.pick_gallery');
    try {
      const libPerm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (libPerm.status !== 'granted') {
        Alert.alert('Permission required', 'Please allow photo access to import notes.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.8,
      });
      if (result.canceled) return;
      const uri = result.assets[0]?.uri;
      if (!uri) return;
      setExtracting(true);
      const text = await recognizeTextInImage(uri);
      setExtracting(false);
      if (!text) {
        Alert.alert('No text found', 'We could not read this image. Try a clearer photo.');
        return;
      }
      appendNotes(text);
    } catch (err) {
      setExtracting(false);
      trackError('play.build.pick_gallery.failed', err);
      Alert.alert('Could not import image', 'Please try again or type the notes.');
    }
  }, [appendNotes]);

  const onPickDocument = useCallback(async (kind: 'pdf' | 'word') => {
    track('play.build.pick_document', { kind });
    try {
      const mimeTypes = kind === 'pdf'
        ? ['application/pdf']
        : [
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ];
      const result = await DocumentPicker.getDocumentAsync({
        type: mimeTypes,
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const f = result.assets[0];
      setExtracting(true);
      const b64 = await FileSystem.readAsStringAsync(f.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const text = await extractAttachmentText(b64, kind);
      setExtracting(false);
      if (!text || text.trim().length < 20) {
        Alert.alert(
          'Could not read this file',
          kind === 'pdf'
            ? 'The PDF may be encrypted, image-only, or empty. Try a different file.'
            : 'The document seems empty or in an unsupported format. Try a different file.',
        );
        return;
      }
      appendNotes(text.trim());
    } catch (err) {
      setExtracting(false);
      trackError('play.build.pick_document.failed', err, { kind });
      Alert.alert(
        kind === 'pdf' ? 'Could not open PDF' : 'Could not open document',
        'Please try again.',
      );
    }
  }, [appendNotes]);

  // ── Generate ────────────────────────────────────────────────────────────────

  const canGenerate = title.trim().length > 0 && notes.trim().length > 0 && !generating;

  const onGenerate = useCallback(async () => {
    if (!canGenerate) return;
    track('play.lesson.create.start', {
      surface: 'play.build',
      route,
      title_len: title.trim().length,
      notes_len: notes.trim().length,
    });

    if (route === 'unavailable') {
      Alert.alert(
        'Connect to continue',
        "You're offline and no on-device model is loaded. Connect to use Neriah Play.",
      );
      return;
    }

    if (route === 'cloud') {
      setGenerating(true);
      // Async create — the route returns 201 with status='generating'
      // within seconds. We retry once on a no-response error because a
      // single transient network blip on the cellular link is the most
      // common cause of "Check your internet" — the backend itself is
      // fast (1-2 s) and the worker thread does the long work.
      const tryCreate = async () => playApi.createLesson({
        title: title.trim(),
        source_content: notes.trim(),
        subject: subject || undefined,
        grade: level || undefined,
      });
      try {
        let lesson;
        try {
          lesson = await tryCreate();
        } catch (firstErr) {
          const code = (firstErr as { error_code?: string })?.error_code;
          if (code === 'NO_CONNECTION') {
            track('play.lesson.create.retry', { reason: 'no_connection' });
            await new Promise((r) => setTimeout(r, 1500));
            lesson = await tryCreate();
          } else {
            throw firstErr;
          }
        }
        track('play.lesson.create.queued', {
          path: 'cloud',
          lesson_id: lesson.id,
          status: lesson.status ?? 'unknown',
        });
        navigation.replace('PlayBuildProgress', { cloudLessonId: lesson.id });
      } catch (err) {
        trackError('play.lesson.create.failed', err, { path: 'cloud' });
        const e = err as { title?: string; message?: string };
        // Use the interceptor's title when present so the alert reads
        // "No connection / Check your internet" instead of the
        // hardcoded "Generation failed" — the latter is misleading
        // when the request never even reached the backend.
        Alert.alert(
          e?.title || 'Generation failed',
          e?.message || 'Could not start the game build. Please try again.',
        );
      } finally {
        setGenerating(false);
      }
      return;
    }

    // On-device path — hand off to the progress screen which drives the
    // generator. We don't block the build screen with a spinner since the
    // run can take 5+ minutes. Persist the form first so the progress
    // screen can rehydrate after a background → foreground cycle.
    const taskId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await persistFormSnapshot({
      taskId,
      title: title.trim(),
      subject: subject || undefined,
      grade: level || undefined,
      source_content: notes.trim(),
    });
    navigation.replace('PlayBuildProgress', { taskId });
  }, [canGenerate, route, title, subject, level, notes, navigation]);

  // ── UI ──────────────────────────────────────────────────────────────────────

  const isOnline = route === 'cloud';
  const initials = (user?.first_name?.[0] ?? '').toUpperCase();

  return (
    <ScreenContainer
      scroll={false}
      edges={['top', 'left', 'right']}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 24 : 0}
    >
      {/* Header band — paddingBottom trimmed (no subtitle on this screen)
          and headerRow's marginBottom zeroed so the back button + title +
          profile row sits visually centered in the teal column. */}
      <View style={[playStyles.headerBand, { paddingBottom: 14 }]}>
        <View style={[playStyles.headerRow, { marginBottom: 0 }]}>
          <BackButton variant="onTeal" />
          <Text style={[playStyles.headerTitle, { flex: 1, marginLeft: 12 }]} numberOfLines={1}>
            {t('play_build_title')}
          </Text>
          <View style={styles.profileWrap}>
            <View style={styles.profileCircle}>
              <Text style={styles.profileInitial}>{initials || '·'}</Text>
            </View>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: isOnline ? COLORS.success : COLORS.amber500 },
              ]}
            />
          </View>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* Title */}
        <Text style={styles.label}>{t('play_build_title_label')}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={t('play_build_title_placeholder')}
          placeholderTextColor={COLORS.textLight}
          maxLength={60}
          style={styles.input}
        />

        {/* Subject pills — one line, horizontally scrollable */}
        <Text style={styles.label}>{t('play_build_subject_label')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.singleRowRail}
        >
          {SUBJECTS.map((s) => {
            const active = subject === s;
            return (
              <TrackedPressable
                key={s}
                analyticsId="play.build.subject_select"
                analyticsPayload={{ subject: s }}
                style={[styles.pill, active && styles.pillActive, styles.pillSingleRow]}
                onPress={() => setSubject(active ? '' : s)}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{s}</Text>
              </TrackedPressable>
            );
          })}
        </ScrollView>

        {/* Level pills */}
        <Text style={styles.label}>{t('play_build_level_label')}</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.singleRowRail}
        >
          {LEVELS.map((g) => {
            const active = level === g;
            return (
              <TrackedPressable
                key={g}
                analyticsId="play.build.level_select"
                analyticsPayload={{ level: g }}
                style={[styles.pill, active && styles.pillActive, styles.pillSingleRow]}
                onPress={() => setLevel(active ? '' : g)}
              >
                <Text style={[styles.pillText, active && styles.pillTextActive]}>{g}</Text>
              </TrackedPressable>
            );
          })}
        </ScrollView>

        {/* Source ingestion */}
        <Text style={styles.label}>{t('play_build_source_label')}</Text>
        <View style={styles.sourceGrid}>
          <TrackedPressable
            analyticsId="play.build.source_camera"
            style={styles.sourceBtn}
            onPress={onPhotographNotes}
          >
            <Text style={styles.sourceBtnText}>{t('play_build_source_camera')}</Text>
          </TrackedPressable>
          <TrackedPressable
            analyticsId="play.build.source_gallery"
            style={styles.sourceBtn}
            onPress={onPickFromGallery}
          >
            <Text style={styles.sourceBtnText}>{t('play_build_source_gallery')}</Text>
          </TrackedPressable>
          <TrackedPressable
            analyticsId="play.build.source_pdf"
            style={styles.sourceBtn}
            onPress={() => onPickDocument('pdf')}
          >
            <Text style={styles.sourceBtnText}>{t('play_build_source_pdf')}</Text>
          </TrackedPressable>
          <TrackedPressable
            analyticsId="play.build.source_word"
            style={styles.sourceBtn}
            onPress={() => onPickDocument('word')}
          >
            <Text style={styles.sourceBtnText}>{t('play_build_source_word')}</Text>
          </TrackedPressable>
        </View>

        {extracting && (
          <View style={styles.extractingRow}>
            <ActivityIndicator color={COLORS.teal500} size="small" />
            <Text style={[playStyles.bodyMuted, { marginLeft: 8 }]}>
              {t('play_build_extracting')}
            </Text>
          </View>
        )}

        <TextInput
          value={notes}
          onChangeText={setNotes}
          placeholder={t('play_build_notes_placeholder')}
          placeholderTextColor={COLORS.textLight}
          multiline
          numberOfLines={6}
          style={styles.notesInput}
        />

        {/* Generate — brief spinner during the POST (1-2 s); the long
            wait UI lives on PlayBuildProgressScreen which we navigate
            to immediately after the create. */}
        <TrackedPressable
          analyticsId="play.build.generate"
          style={[
            playStyles.primaryPill,
            { marginTop: 24 },
            !canGenerate && styles.disabled,
          ]}
          onPress={onGenerate}
          disabled={!canGenerate}
        >
          {generating ? (
            <ActivityIndicator color={COLORS.white} />
          ) : (
            <Text style={playStyles.primaryPillText}>{t('play_build_generate')}</Text>
          )}
        </TrackedPressable>

        {!canGenerate && !generating && (
          <Text style={[playStyles.bodyMuted, { marginTop: 8, textAlign: 'center' }]}>
            {t('play_build_validating')}
          </Text>
        )}
      </ScrollView>

      <InAppCamera
        visible={showCamera}
        onCapture={onCameraCapture}
        onClose={() => setShowCamera(false)}
        warningMessage="Hold the page flat and steady so the text reads clearly."
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 48,
  },
  profileWrap: {
    width: 36,
    height: 36,
    marginLeft: 8,
  },
  profileCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: COLORS.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileInitial: {
    fontFamily: PLAY_FONT,
    color: COLORS.teal700,
    fontSize: 15,
    fontWeight: '700',
  },
  statusDot: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: COLORS.teal500,
  },
  label: {
    fontFamily: PLAY_FONT,
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.textLight,
    marginTop: 12,
    marginBottom: 6,
  },
  input: {
    fontFamily: PLAY_FONT,
    fontSize: 15,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    color: COLORS.text,
  },
  singleRowRail: {
    paddingVertical: 4,
    paddingRight: 8,
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: COLORS.gray50,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pillSingleRow: {
    marginRight: 8,
  },
  pillActive: {
    backgroundColor: COLORS.teal500,
    borderColor: COLORS.teal500,
  },
  pillText: {
    fontFamily: PLAY_FONT,
    fontSize: 13,
    color: COLORS.text,
    fontWeight: '600',
  },
  pillTextActive: { color: COLORS.white },
  sourceGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sourceBtn: {
    flexBasis: '48%',
    flexGrow: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: COLORS.teal500,
    backgroundColor: COLORS.white,
  },
  sourceBtnText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.teal500,
  },
  extractingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },
  notesInput: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    minHeight: 140,
    textAlignVertical: 'top',
    padding: 14,
    borderRadius: 12,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.border,
    color: COLORS.text,
    marginTop: 12,
  },
  disabled: {
    opacity: 0.5,
  },
});
