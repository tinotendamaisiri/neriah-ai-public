// src/play/screens/PlayPreviewScreen.tsx
//
// Lesson detail + game format chooser. Wireframe 6.
//
// Shows the title, subject/grade, headline stats (best score, sessions
// played, question count), the four game format cards, and links to
// Edit sharing + Delete (owner only).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import { BackButton } from '../../components/BackButton';
import TrackedPressable from '../../components/TrackedPressable';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { track, trackError, trackScreen } from '../../services/analytics';
import { playApi, type PlayLessonStats } from '../../services/play';
import type { GameFormat, PlayLesson, PlayStackParamList } from '../types';
import type { TranslationKey } from '../../i18n/translations';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlayPreview'>;
type R = RouteProp<PlayStackParamList, 'PlayPreview'>;

interface FormatRow {
  key: GameFormat;
  titleKey: TranslationKey;
  subKey: TranslationKey;
  icon: keyof typeof Ionicons.glyphMap;
}

const FORMATS: FormatRow[] = [
  { key: 'lane_runner', titleKey: 'play_game_lane_runner', subKey: 'play_game_lane_runner_sub', icon: 'arrow-forward-circle-outline' },
  { key: 'stacker',     titleKey: 'play_game_stacker',     subKey: 'play_game_stacker_sub',     icon: 'apps-outline' },
  { key: 'blaster',     titleKey: 'play_game_blaster',     subKey: 'play_game_blaster_sub',     icon: 'rocket-outline' },
  { key: 'snake',       titleKey: 'play_game_snake',       subKey: 'play_game_snake_sub',       icon: 'infinite-outline' },
];

export default function PlayPreviewScreen() {
  const navigation = useNavigation<Nav>();
  const routeParams = useRoute<R>();
  const { lessonId, wasExpanded } = routeParams.params;
  const { t } = useLanguage();
  const { user } = useAuth();

  const [lesson, setLesson] = useState<PlayLesson | null>(null);
  const [stats, setStats] = useState<PlayLessonStats | null>(null);
  const [loading, setLoading] = useState(true);

  // Defensive: ignore format-card taps fired in the first 400 ms after the
  // screen regains focus. Eliminates the stale-tap class of "exit on
  // picker auto-routes into a game" reports — a focus-restored Pressable
  // can otherwise replay a buffered touch event on Android.
  const focusedAtRef = useRef<number>(0);

  useEffect(() => {
    trackScreen('PlayPreview');
  }, []);

  // One-time notice when the generator auto-expanded broader-topic
  // questions because the student's notes were too sparse for a full bank.
  // Fires once per navigation; consumed via setParams so re-focusing doesn't
  // re-trigger.
  useEffect(() => {
    if (!wasExpanded) return;
    Alert.alert(
      t('play_preview_expanded_title'),
      t('play_preview_expanded_body'),
    );
    navigation.setParams({ wasExpanded: false } as Partial<R['params']>);
  }, [wasExpanded, navigation, t]);

  const load = useCallback(async () => {
    try {
      const [data, statData] = await Promise.all([
        playApi.getLesson(lessonId),
        playApi.getLessonStats(lessonId).catch(() => null),
      ]);
      setLesson(data);
      setStats(statData);
    } catch (err) {
      trackError('play.preview.load_failed', err, { lesson_id: lessonId });
      Alert.alert('Could not open lesson', 'Please go back and try again.');
    } finally {
      setLoading(false);
    }
  }, [lessonId]);

  useFocusEffect(
    useCallback(() => {
      focusedAtRef.current = Date.now();
      load();
    }, [load]),
  );

  const onPickFormat = useCallback(
    (format: GameFormat) => {
      if (!lesson) return;
      // Drop taps that landed within 400 ms of the focus event — those
      // are almost always replayed/buffered, not deliberate.
      if (Date.now() - focusedAtRef.current < 400) {
        track('play.preview.format_pick.suppressed', { format, lesson_id: lessonId });
        return;
      }
      track('play.preview.format_pick', { format, lesson_id: lessonId });
      navigation.navigate('PlayGame', { lessonId, format });
    },
    [lesson, lessonId, navigation],
  );

  const onDelete = useCallback(() => {
    Alert.alert(
      t('play_preview_delete_confirm_title'),
      t('play_preview_delete_confirm_body'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: t('play_preview_delete_confirm_yes'),
          style: 'destructive',
          onPress: async () => {
            try {
              await playApi.deleteLesson(lessonId);
              track('play.lesson.delete', { lesson_id: lessonId });
              navigation.popToTop();
            } catch (err) {
              trackError('play.lesson.delete_failed', err);
              Alert.alert('Could not delete', 'Please try again.');
            }
          },
        },
      ],
    );
  }, [lessonId, navigation, t]);

  if (loading) {
    return (
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      </ScreenContainer>
    );
  }

  if (!lesson) {
    return null;
  }

  const isOwner = !!user && lesson.owner_id === user.id;

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
      {/* Teal header */}
      <View style={playStyles.headerBand}>
        <View style={playStyles.headerRow}>
          <BackButton variant="onTeal" />
          <View style={{ flex: 1, marginLeft: 12 }}>
            <Text style={playStyles.headerTitle} numberOfLines={2}>
              {lesson.title}
            </Text>
            <Text style={playStyles.headerSub}>
              {[lesson.subject, lesson.grade].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* Stats strip */}
        <View style={styles.statsRow}>
          <Stat
            label={t('play_preview_questions')}
            value={String(lesson.question_count)}
          />
          <Stat
            label={t('play_preview_best_score')}
            value={stats ? String(stats.best_score) : '—'}
            tone="amber"
          />
          <Stat
            label={t('play_preview_sessions_played')}
            value={stats ? String(stats.total_sessions) : '—'}
          />
        </View>

        {/* Pick a game */}
        <Text style={[playStyles.sectionTitle, { marginTop: 20, paddingHorizontal: 0 }]}>
          {t('play_preview_pick_a_game')}
        </Text>
        {FORMATS.map((f) => (
          <TrackedPressable
            key={f.key}
            analyticsId="play.preview.format_card"
            analyticsPayload={{ format: f.key }}
            style={styles.formatCard}
            onPress={() => onPickFormat(f.key)}
          >
            <Ionicons name={f.icon} size={32} color={COLORS.teal500} />
            <View style={{ flex: 1, marginLeft: 14 }}>
              <Text style={styles.formatTitle}>{t(f.titleKey)}</Text>
              <Text style={styles.formatSub}>{t(f.subKey)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={COLORS.teal500} />
          </TrackedPressable>
        ))}

        {/* Sharing + delete (owner only) */}
        <TrackedPressable
          analyticsId="play.preview.edit_sharing"
          style={styles.linkRow}
          onPress={() => navigation.navigate('PlayShare', { lessonId })}
        >
          <Ionicons name="share-social-outline" size={18} color={COLORS.teal500} />
          <Text style={styles.linkText}>{t('play_preview_edit_sharing')}</Text>
        </TrackedPressable>

        {isOwner && (
          <TrackedPressable
            analyticsId="play.preview.delete"
            style={styles.deleteRow}
            onPress={onDelete}
          >
            <Ionicons name="trash-outline" size={18} color={COLORS.error} />
            <Text style={styles.deleteText}>{t('play_preview_delete')}</Text>
          </TrackedPressable>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}

interface StatProps {
  label: string;
  value: string;
  tone?: 'teal' | 'amber';
}

function Stat({ label, value, tone = 'teal' }: StatProps) {
  return (
    <View style={styles.statBox}>
      <Text style={[styles.statValue, tone === 'amber' && { color: COLORS.amber700 }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 40,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  statBox: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  statValue: {
    fontFamily: PLAY_FONT,
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.teal500,
  },
  statLabel: {
    fontFamily: PLAY_FONT,
    fontSize: 11,
    color: COLORS.textLight,
    marginTop: 2,
    textAlign: 'center',
  },
  formatCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.white,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  formatTitle: {
    fontFamily: PLAY_FONT,
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
  },
  formatSub: {
    fontFamily: PLAY_FONT,
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 2,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    marginTop: 16,
  },
  linkText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.teal500,
    fontWeight: '600',
  },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    marginTop: 4,
  },
  deleteText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.error,
    fontWeight: '600',
  },
});
