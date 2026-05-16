// src/play/screens/PlayLibraryScreen.tsx
//
// Full library of every Play lesson the student can see — own + class-shared
// + copied. Two filter rails: subject pills + origin pills.
//
// Wireframe 2.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import TrackedPressable from '../../components/TrackedPressable';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { trackScreen } from '../../services/analytics';
import { playApi } from '../../services/play';
import type { PlayLesson, PlayStackParamList } from '../types';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlayLibrary'>;
type OriginFilter = 'all' | 'mine' | 'class' | 'shared';
type CardOrigin = 'mine' | 'class' | 'shared';

// Hard-coded core subject pills — supplemented at runtime by any subject
// values present on the loaded lessons. Keeps the filter useful even when
// the library is empty.
const CORE_SUBJECTS = ['Math', 'English', 'Science'];

export default function PlayLibraryScreen() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const { t } = useLanguage();

  const [lessons, setLessons] = useState<PlayLesson[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [subjectFilter, setSubjectFilter] = useState<string>('all');
  const [subjectModalOpen, setSubjectModalOpen] = useState(false);
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');

  useEffect(() => {
    trackScreen('PlayLibrary');
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await playApi.listLessons();
      setLessons(data);
    } catch {
      // Stay on whatever's already in state — show empty if nothing.
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  const subjects = useMemo(() => {
    const found = new Set<string>(CORE_SUBJECTS);
    for (const l of lessons) if (l.subject) found.add(l.subject);
    return ['all', ...Array.from(found)];
  }, [lessons]);

  const resolveOrigin = useCallback(
    (l: PlayLesson): CardOrigin => {
      if (l.origin === 'mine' || l.origin === 'class' || l.origin === 'shared') {
        return l.origin;
      }
      return l.owner_id === (user?.id ?? '') ? 'mine' : 'class';
    },
    [user?.id],
  );

  const filtered = useMemo(() => {
    return lessons.filter((l) => {
      // Hide in-progress / failed / 0-question lessons from the main
      // list. A lesson with status='generating' is being built by the
      // backend worker thread; status='failed' was a safety-valve trip.
      // Either way the student shouldn't see them as playable cards.
      // Treat undefined status as legacy 'ready' so old rows still
      // show up.
      const status = l.status;
      if (status && status !== 'ready') return false;
      if ((l.question_count ?? 0) < 1) return false;

      if (subjectFilter !== 'all' && l.subject !== subjectFilter) return false;
      if (originFilter === 'all') return true;
      return resolveOrigin(l) === originFilter;
    });
  }, [lessons, subjectFilter, originFilter, resolveOrigin]);

  if (loading) {
    return (
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      </ScreenContainer>
    );
  }

  const subjectLabel =
    subjectFilter === 'all' ? t('play_library_subject_all') : subjectFilter;

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
      {/* Teal header band — title centered, no back button (this is
          the root of the Play stack, students leave it via the
          bottom-tab nav). */}
      <View style={[playStyles.headerBand, styles.centeredHeader]}>
        <Text style={[playStyles.headerTitle, styles.centeredTitle]} numberOfLines={1}>
          {t('play_library_title')}
        </Text>
      </View>

      {/* Origin filter row — All / Mine / Class / Shared, sits below
          the band and is the first thing the student sees. */}
      <View style={styles.originRail}>
        {(['all', 'mine', 'class', 'shared'] as OriginFilter[]).map((o) => {
          const active = originFilter === o;
          const label =
            o === 'all'
              ? t('play_library_filter_all')
              : o === 'mine'
              ? t('play_library_filter_mine')
              : o === 'class'
              ? t('play_library_filter_class')
              : t('play_library_filter_shared');
          return (
            <TrackedPressable
              key={o}
              analyticsId="play.library.filter_origin"
              analyticsPayload={{ origin: o }}
              style={[styles.originChip, active && styles.originChipActive]}
              onPress={() => setOriginFilter(o)}
            >
              <Text style={[styles.originText, active && styles.originTextActive]}>
                {label}
              </Text>
            </TrackedPressable>
          );
        })}
      </View>

      {/* Subject dropdown — replaces the old horizontal-scrolling
          chip rail. Default "All subjects"; tap to choose another. */}
      <Pressable
        style={styles.subjectSelect}
        onPress={() => setSubjectModalOpen(true)}
      >
        <Text style={styles.subjectSelectText}>{subjectLabel}</Text>
        <Ionicons name="chevron-down" size={18} color={COLORS.teal500} />
      </Pressable>

      <Modal
        visible={subjectModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSubjectModalOpen(false)}
      >
        <Pressable
          style={styles.subjectModalScrim}
          onPress={() => setSubjectModalOpen(false)}
        >
          <View style={styles.subjectModalSheet}>
            {subjects.map((s) => {
              const label = s === 'all' ? t('play_library_subject_all') : s;
              const active = subjectFilter === s;
              return (
                <Pressable
                  key={s}
                  onPress={() => {
                    setSubjectFilter(s);
                    setSubjectModalOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.subjectModalRow,
                    pressed && { backgroundColor: COLORS.gray50 },
                  ]}
                >
                  <Text
                    style={[
                      styles.subjectModalRowText,
                      active && { color: COLORS.teal500, fontWeight: '700' },
                    ]}
                  >
                    {label}
                  </Text>
                  {active ? (
                    <Ionicons name="checkmark" size={18} color={COLORS.teal500} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>

      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.teal500} />
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons
              name={lessons.length === 0 ? 'game-controller-outline' : 'library-outline'}
              size={56}
              color={COLORS.teal300}
            />
            <Text style={[playStyles.body, styles.emptyText]}>
              {lessons.length === 0
                ? t('play_library_empty_zero')
                : t('play_library_empty')}
            </Text>
            <TrackedPressable
              analyticsId="play.library.build_cta"
              style={[playStyles.primaryPill, styles.buildCta]}
              onPress={() => navigation.navigate('PlayBuild')}
            >
              <Text style={playStyles.primaryPillText}>{t('play_home_make_new')}</Text>
            </TrackedPressable>
          </View>
        }
        renderItem={({ item }) => {
          const origin = resolveOrigin(item);
          const badgeBgStyle =
            origin === 'mine'
              ? playStyles.originBadgeMine
              : origin === 'class'
              ? playStyles.originBadgeClass
              : playStyles.originBadgeShared;
          const badgeTextStyle =
            origin === 'mine'
              ? playStyles.originBadgeTextMine
              : origin === 'class'
              ? playStyles.originBadgeTextClass
              : playStyles.originBadgeTextShared;
          const badgeLabel =
            origin === 'mine'
              ? t('play_library_origin_mine')
              : origin === 'class'
              ? t('play_library_origin_class')
              : t('play_library_origin_shared');
          return (
            <TrackedPressable
              analyticsId="play.library.lesson.open"
              analyticsPayload={{ lesson_id: item.id, origin }}
              style={playStyles.card}
              onPress={() => navigation.navigate('PlayPreview', { lessonId: item.id })}
            >
              <View style={styles.cardTop}>
                <Text style={playStyles.cardTitle} numberOfLines={2}>
                  {item.title}
                </Text>
                <View style={[playStyles.originBadge, badgeBgStyle]}>
                  <Text style={[playStyles.originBadgeText, badgeTextStyle]}>
                    {badgeLabel}
                  </Text>
                </View>
              </View>
              <Text style={playStyles.cardMeta}>
                {[item.subject, t('play_home_questions_count').replace('{n}', String(item.question_count))]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </TrackedPressable>
          );
        }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  centeredHeader: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredTitle: {
    textAlign: 'center',
  },
  subjectSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: COLORS.white,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: COLORS.border,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  subjectSelectText: {
    fontFamily: PLAY_FONT,
    fontSize: 14,
    color: COLORS.text,
    fontWeight: '600',
  },
  subjectModalScrim: {
    flex: 1,
    backgroundColor: 'rgba(12,18,32,0.45)',
    justifyContent: 'flex-end',
  },
  subjectModalSheet: {
    backgroundColor: COLORS.white,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 12,
    paddingBottom: 24,
  },
  subjectModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  subjectModalRowText: {
    fontFamily: PLAY_FONT,
    fontSize: 15,
    color: COLORS.text,
  },
  originRail: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    gap: 8,
  },
  originChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: COLORS.white,
    borderWidth: 1,
    borderColor: COLORS.teal100,
    marginRight: 8,
  },
  originChipActive: {
    backgroundColor: COLORS.teal100,
    borderColor: COLORS.teal500,
  },
  originText: {
    fontFamily: PLAY_FONT,
    fontSize: 12,
    color: COLORS.teal700,
    fontWeight: '600',
  },
  originTextActive: {
    color: COLORS.teal700,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    flexGrow: 1,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 4,
  },
  emptyWrap: {
    paddingTop: 60,
    alignItems: 'center',
    gap: 14,
  },
  emptyText: { textAlign: 'center', color: COLORS.textLight, paddingHorizontal: 32 },
  buildCta: { marginTop: 8, paddingHorizontal: 28 },
});
