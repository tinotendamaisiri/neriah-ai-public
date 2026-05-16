// src/play/screens/PlayBuildProgressScreen.tsx
//
// Drives an offline (on-device) lesson build. Wireframe 4.
//
// Reads the persisted progress for the given taskId so a backgrounded run
// can resume. Otherwise it blocks awaiting source content from the
// build screen — but in practice the BuildScreen mints the taskId AFTER
// the user fills out the form, persists the form data first, and then
// navigates here. We support both shapes: if no persisted form is found,
// we surface an error and bounce back.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute, useFocusEffect, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import { BackButton } from '../../components/BackButton';
import TrackedPressable from '../../components/TrackedPressable';
import { useLanguage } from '../../context/LanguageContext';
import { track, trackError, trackScreen } from '../../services/analytics';
import { playApi } from '../../services/play';
import {
  generateLessonOnDevice,
  readPersistedProgress,
  clearPersistedProgress,
  TARGET_QUESTION_COUNT,
  OFFLINE_GEN_STORAGE_PREFIX,
} from '../lessonGenerator';
import type { PlayStackParamList, PlayQuestion } from '../types';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlayBuildProgress'>;
type R = RouteProp<PlayStackParamList, 'PlayBuildProgress'>;

// PlayBuildScreen drops the form snapshot here so the progress screen can
// pick it up and run the generator. Keyed off the taskId.
const FORM_STORAGE_PREFIX = 'neriah_play_offline_form_';

export interface OfflineFormSnapshot {
  taskId: string;
  title: string;
  subject?: string;
  grade?: string;
  source_content: string;
}

export async function persistFormSnapshot(snapshot: OfflineFormSnapshot): Promise<void> {
  await AsyncStorage.setItem(
    `${FORM_STORAGE_PREFIX}${snapshot.taskId}`,
    JSON.stringify(snapshot),
  ).catch(() => {});
}

async function readFormSnapshot(taskId: string): Promise<OfflineFormSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(`${FORM_STORAGE_PREFIX}${taskId}`);
    return raw ? (JSON.parse(raw) as OfflineFormSnapshot) : null;
  } catch {
    return null;
  }
}

async function clearFormSnapshot(taskId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(`${FORM_STORAGE_PREFIX}${taskId}`);
  } catch {
    /* ignore */
  }
}

export default function PlayBuildProgressScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<R>();
  const { taskId, cloudLessonId } = route.params;
  const isCloudMode = !!cloudLessonId;
  const { t } = useLanguage();

  const [count, setCount] = useState(0);
  const target = TARGET_QUESTION_COUNT;
  const [stalls, setStalls] = useState(0);
  // Steady time-based ramp for the cloud-mode progress bar (cloud
  // doesn't expose incremental progress — we just show motion).
  const [cloudProgress, setCloudProgress] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef(false);

  useEffect(() => {
    trackScreen('PlayBuildProgress');
  }, []);

  const onCancel = useCallback(() => {
    track('play.lesson.create.cancel', { taskId, cloudLessonId });
    abortRef.current?.abort();
    if (taskId) {
      Promise.all([
        clearPersistedProgress(taskId),
        clearFormSnapshot(taskId),
      ]).catch(() => {});
    }
    // For cloud lessons we DON'T delete the row — the worker keeps
    // running and the lesson will appear in the student's library when
    // ready. They simply leave the wait screen.
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('PlayLibrary');
  }, [navigation, taskId, cloudLessonId]);

  // Intercept Android system back / edge-swipe so a stray gesture doesn't
  // kill an in-progress generation. Confirm before cancelling.
  useFocusEffect(
    useCallback(() => {
      const onBackPress = () => {
        Alert.alert(
          'Stop building?',
          'You will lose the progress on this game.',
          [
            { text: 'Keep building', style: 'cancel' },
            { text: 'Stop', style: 'destructive', onPress: onCancel },
          ],
        );
        return true;
      };
      const sub = BackHandler.addEventListener('hardwareBackPress', onBackPress);
      return () => sub.remove();
    }, [onCancel]),
  );

  // ── Cloud-poll mode ──────────────────────────────────────────────────────
  // Backend created a placeholder lesson with status='generating' and
  // started a worker thread. Poll every 4 s until status flips to
  // 'ready' (→ navigate to PlayPreview) or 'failed' (→ alert + bounce).
  // The polling stops while the screen is unfocused / app backgrounded
  // and resumes on focus, so backgrounding the phone is safe.
  useEffect(() => {
    if (!cloudLessonId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const lesson = await playApi.getLesson(cloudLessonId);
        if (cancelled) return;
        if (lesson.status === 'ready') {
          if (timer) clearInterval(timer);
          track('play.lesson.create.success', {
            path: 'cloud',
            lesson_id: cloudLessonId,
            count: lesson.question_count,
            was_expanded: !!lesson.was_expanded,
          });
          navigation.replace('PlayPreview', {
            lessonId: lesson.id,
            wasExpanded: !!lesson.was_expanded,
          });
        } else if (lesson.status === 'failed') {
          if (timer) clearInterval(timer);
          trackError('play.lesson.create.failed', new Error('worker_failed'), {
            path: 'cloud',
            lesson_id: cloudLessonId,
          });
          Alert.alert(
            'Generation failed',
            lesson.error_message ||
              "We couldn't build a full game from that topic. Try adding more detail or pick a slightly broader topic.",
            [{ text: 'OK', onPress: () => navigation.replace('PlayBuild') }],
          );
        }
        // status === 'generating' or undefined → keep polling
      } catch (err) {
        // Network blip — keep polling, don't bail.
        // (axios offline maps to interceptor reject; we just retry.)
      }
    };

    // First tick immediately, then every 4 s.
    tick();
    timer = setInterval(tick, 4000);

    // Drive the time-based progress fill (~270 s to 0.95).
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const pct = Math.min(0.95, elapsedMs / 270_000);
      setCloudProgress(pct);
    }, 200);

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      clearInterval(progressTimer);
    };
  }, [cloudLessonId, navigation]);

  // Kick off the on-device generator once on mount (offline mode only).
  useEffect(() => {
    if (isCloudMode) return;
    if (!taskId) return;
    if (startedRef.current) return;
    startedRef.current = true;

    let cancelled = false;
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      const form = await readFormSnapshot(taskId);
      if (!form) {
        Alert.alert(
          'Build interrupted',
          'We could not find the form data for this task. Please start over.',
        );
        navigation.replace('PlayBuild');
        return;
      }

      // Resume from persisted progress if any.
      const persisted = await readPersistedProgress(taskId);
      const seed: PlayQuestion[] = persisted?.questions ?? [];
      if (seed.length > 0) setCount(seed.length);

      try {
        const result = await generateLessonOnDevice({
          title: form.title,
          subject: form.subject,
          grade: form.grade,
          source_content: form.source_content,
          existingQuestions: seed,
          taskId,
          signal: controller.signal,
          onProgress: (n) => {
            if (cancelled) return;
            setCount(n);
          },
          onStallHint: (s) => {
            if (cancelled) return;
            setStalls(s);
          },
        });

        if (cancelled || controller.signal.aborted) return;

        if (result.count < TARGET_QUESTION_COUNT) {
          // Contract: every saved lesson has exactly TARGET_QUESTION_COUNT
          // questions. The on-device three-tier generator hit its budget
          // without reaching the target — surface that and bounce back so
          // the student can retry with broader notes.
          Alert.alert(
            t('play_build_short_title'),
            t('play_build_short_body'),
            [{ text: 'OK', onPress: () => navigation.replace('PlayBuild') }],
          );
          return;
        }

        // Persist server-side now that we have a usable lesson. Upload
        // happens online; offline users get the local lesson re-played
        // through the mutation queue (best-effort future work). For now
        // attempt direct upload — if it fails, the AsyncStorage record
        // is still there for retry.
        try {
          const lesson = await playApi.createLesson({
            title: form.title,
            subject: form.subject,
            grade: form.grade,
            source_content: form.source_content,
          });
          // The server runs its own dedup; our local questions act as a
          // hint via source_content. Cleanup the local progress key
          // either way once we've successfully posted.
          await Promise.all([
            clearPersistedProgress(taskId),
            clearFormSnapshot(taskId),
          ]);
          // Auto-expand fills any gap server-side, so the lesson is never
          // a draft on first create. Always go to preview; the preview
          // screen surfaces a one-time notice when the bank was expanded
          // with broader-topic questions.
          navigation.replace('PlayPreview', {
            lessonId: lesson.id,
            wasExpanded: !!lesson.was_expanded,
          });
        } catch (uploadErr) {
          trackError('play.lesson.create.upload_failed', uploadErr, { taskId });
          // We still keep the persisted record so retry works on next
          // online launch. Notify and head back to home so the student
          // isn't blocked.
          Alert.alert(
            'Saved offline',
            'Your lesson is ready. We will sync it the next time you are online.',
            [{ text: 'OK', onPress: () => navigation.replace('PlayLibrary') }],
          );
        }
      } catch (err) {
        if (cancelled) return;
        trackError('play.lesson.create.failed', err, { path: 'on-device', taskId });
        Alert.alert(
          'Generation failed',
          'We could not finish generating questions. Please try again.',
          [{ text: 'OK', onPress: () => navigation.replace('PlayBuild') }],
        );
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const pct = isCloudMode
    ? cloudProgress
    : Math.max(0, Math.min(1, target > 0 ? count / target : 0));

  // Rotating quote rail (only while we're showing the wait UI).
  const QUOTES = [
    'Curiosity is the ignition of every great mind.',
    'Mistakes are proof you are trying.',
    'Mastery starts with one good question.',
    'Slow learning beats fast forgetting.',
    'Knowledge multiplies the moment you share it.',
    'Africa’s brightest minds practise every day.',
    'A mind that questions is a mind that grows.',
    'Practice makes patterns. Patterns become skill.',
    'Every expert was once a complete beginner.',
    'Repetition is the mother of skill.',
    'Small daily reps build big real-world results.',
    'Effort compounds. Stay with it.',
  ];
  const [quoteIdx, setQuoteIdx] = useState(0);
  useEffect(() => {
    setQuoteIdx(Math.floor(Math.random() * QUOTES.length));
    const id = setInterval(() => {
      setQuoteIdx((i) => (i + 1) % QUOTES.length);
    }, 7000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
      <View style={styles.topBar}>
        <BackButton onPress={onCancel} />
      </View>

      <View style={styles.body}>
        {!isCloudMode && (
          <View
            style={[
              playStyles.statusChip,
              playStyles.statusChipOffline,
              { marginBottom: 16 },
            ]}
          >
            <Text style={[playStyles.statusChipText, playStyles.statusChipTextOffline]}>
              {t('play_build_offline_indicator')}
            </Text>
          </View>
        )}

        <Text style={styles.title}>{t('play_build_generating_title')}</Text>
        <Text style={styles.subtitle}>{t('play_build_generating_hint')}</Text>

        <View style={styles.barTrack}>
          <View style={[styles.barFill, { width: `${pct * 100}%` }]} />
        </View>

        {!isCloudMode && (
          <Text style={styles.counter}>
            {t('play_progress_counter')
              .replace('{n}', String(count))
              .replace('{target}', String(target))}
          </Text>
        )}

        <Text style={styles.quote}>“{QUOTES[quoteIdx]}”</Text>

        <Text style={styles.backgroundOk}>
          {t('play_progress_background_ok')}
        </Text>

        <TrackedPressable
          analyticsId="play.progress.cancel"
          style={[styles.cancelBtn]}
          onPress={onCancel}
        >
          <Text style={styles.cancelText}>{t('play_progress_cancel')}</Text>
        </TrackedPressable>

        {stalls > 0 && (
          <Text style={styles.stallNote}>
            {/* Internal indicator — kept short. */}
          </Text>
        )}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  body: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: PLAY_FONT,
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.textLight,
    textAlign: 'center',
    marginBottom: 32,
    paddingHorizontal: 12,
  },
  barTrack: {
    height: 12,
    width: '100%',
    backgroundColor: COLORS.gray50,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  barFill: {
    height: '100%',
    backgroundColor: COLORS.teal500,
  },
  quote: {
    marginTop: 24,
    fontFamily: PLAY_FONT,
    fontSize: 14,
    fontStyle: 'italic',
    color: COLORS.textLight,
    textAlign: 'center',
    paddingHorizontal: 12,
    lineHeight: 21,
  },
  backgroundOk: {
    marginTop: 18,
    fontFamily: PLAY_FONT,
    fontSize: 12,
    color: COLORS.teal500,
    textAlign: 'center',
    fontWeight: '600',
  },
  counter: {
    marginTop: 14,
    fontFamily: PLAY_FONT,
    fontSize: 14,
    fontWeight: '700',
    color: COLORS.amber700,
    textAlign: 'center',
  },
  qualityNote: {
    marginTop: 24,
    fontFamily: PLAY_FONT,
    fontSize: 12,
    color: COLORS.textLight,
    textAlign: 'center',
  },
  cancelBtn: {
    marginTop: 32,
    paddingVertical: 12,
    paddingHorizontal: 28,
  },
  cancelText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.teal500,
    fontWeight: '700',
  },
  stallNote: { height: 0 },
});
