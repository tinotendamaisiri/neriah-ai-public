// src/play/screens/PlaySessionEndScreen.tsx
//
// Wireframe 11. Shown immediately after a Play session ends (loss, quit,
// or completion). Logs the session to the backend on mount, then renders
// a tone-matched header + the headline stats + three navigation pills.

import React, { useEffect, useMemo, useRef } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import TrackedPressable from '../../components/TrackedPressable';
import { useLanguage } from '../../context/LanguageContext';
import { trackError, trackScreen } from '../../services/analytics';
import { playApi } from '../../services/play';
import type { PlayStackParamList } from '../types';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlaySessionEnd'>;
type R = RouteProp<PlayStackParamList, 'PlaySessionEnd'>;

function pickTone(percentage: number): 'tough' | 'mixed' | 'good' | 'excellent' {
  if (percentage <= 30) return 'tough';
  if (percentage <= 60) return 'mixed';
  if (percentage <= 85) return 'good';
  return 'excellent';
}

function formatDuration(secs: number): string {
  const safe = Math.max(0, Math.round(secs));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PlaySessionEndScreen() {
  const navigation = useNavigation<Nav>();
  const routeParams = useRoute<R>();
  const { sessionResult, lessonId } = routeParams.params;
  const { t } = useLanguage();

  const loggedRef = useRef(false);

  useEffect(() => {
    trackScreen('PlaySessionEnd');
  }, []);

  // Log the session once.
  useEffect(() => {
    if (loggedRef.current) return;
    loggedRef.current = true;

    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - sessionResult.duration_seconds * 1000);
    playApi
      .logSession({
        ...sessionResult,
        started_at: startedAt.toISOString(),
        ended_at: endedAt.toISOString(),
      })
      .catch((err) => {
        trackError('play.session.log_failed', err, { lesson_id: lessonId });
      });
  }, [sessionResult, lessonId]);

  const percentage =
    sessionResult.questions_attempted > 0
      ? Math.round((sessionResult.questions_correct / sessionResult.questions_attempted) * 100)
      : 0;
  const tone = useMemo(() => pickTone(percentage), [percentage]);

  const toneTextKey = (
    {
      tough: 'play_session_tone_tough',
      mixed: 'play_session_tone_mixed',
      good: 'play_session_tone_good',
      excellent: 'play_session_tone_excellent',
    } as const
  )[tone];

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={styles.body}>
        {/* Header band — teal */}
        <View style={[playStyles.headerBand, styles.tealHeader]}>
          <Text style={styles.completeLabel}>{t('play_session_complete')}</Text>
          <Text style={styles.toneText}>{t(toneTextKey)}</Text>
          <Text style={styles.reachedText}>
            {t('play_session_reached').replace('{n}', String(sessionResult.questions_attempted))}
          </Text>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.amber700 }]}>{sessionResult.final_score}</Text>
            <Text style={styles.statLabel}>{t('play_session_score')}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.teal500 }]}>
              {sessionResult.questions_correct}/{sessionResult.questions_attempted}
            </Text>
            <Text style={styles.statLabel}>{t('play_session_right')}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statValue, { color: COLORS.text }]}>
              {formatDuration(sessionResult.duration_seconds)}
            </Text>
            <Text style={styles.statLabel}>{t('play_session_time')}</Text>
          </View>
        </View>

        {/* Actions */}
        <TrackedPressable
          analyticsId="play.session.play_again"
          style={[playStyles.primaryPill, styles.cta]}
          onPress={() =>
            navigation.replace('PlayGame', { lessonId, format: sessionResult.game_format })
          }
        >
          <Text style={playStyles.primaryPillText}>{t('play_session_play_again')}</Text>
        </TrackedPressable>

        <TrackedPressable
          analyticsId="play.session.new_game"
          style={[playStyles.secondaryPill, styles.cta]}
          onPress={() => navigation.popToTop()}
        >
          <Text style={playStyles.secondaryPillText}>{t('play_session_new_game')}</Text>
        </TrackedPressable>

        <TrackedPressable
          analyticsId="play.session.library"
          style={styles.linkBtn}
          onPress={() => navigation.replace('PlayLibrary')}
        >
          <Text style={styles.linkText}>{t('play_session_library')}</Text>
        </TrackedPressable>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  body: {
    flexGrow: 1,
    paddingBottom: 40,
  },
  tealHeader: {
    paddingTop: 28,
    paddingBottom: 32,
    alignItems: 'center',
  },
  completeLabel: {
    fontFamily: PLAY_FONT,
    fontSize: 12,
    fontWeight: '700',
    color: COLORS.teal100,
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  toneText: {
    fontFamily: PLAY_FONT,
    fontSize: 28,
    color: COLORS.white,
    fontWeight: '700',
  },
  reachedText: {
    fontFamily: PLAY_FONT,
    fontSize: 13,
    color: COLORS.teal100,
    marginTop: 6,
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  statBox: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    alignItems: 'center',
  },
  statValue: {
    fontFamily: PLAY_FONT,
    fontSize: 24,
    fontWeight: '700',
  },
  statLabel: {
    fontFamily: PLAY_FONT,
    fontSize: 11,
    color: COLORS.textLight,
    marginTop: 4,
    textAlign: 'center',
  },
  cta: {
    marginHorizontal: 24,
    marginTop: 16,
  },
  linkBtn: {
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  linkText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.teal500,
    fontWeight: '600',
  },
});
