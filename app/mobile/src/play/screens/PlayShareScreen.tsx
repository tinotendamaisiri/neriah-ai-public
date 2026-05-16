// src/play/screens/PlayShareScreen.tsx
//
// Wireframe 12. Two toggles + Save:
//   - "Share with my class" — uses class_id of the student's first
//     enrolled class (or the lesson's existing class_id when set).
//   - "Allow classmates to copy" — only enabled when the share toggle is on.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { COLORS } from '../../constants/colors';
import { ScreenContainer } from '../../components/ScreenContainer';
import { BackButton } from '../../components/BackButton';
import TrackedPressable from '../../components/TrackedPressable';
import { useAuth } from '../../context/AuthContext';
import { useLanguage } from '../../context/LanguageContext';
import { track, trackError, trackScreen } from '../../services/analytics';
import { playApi } from '../../services/play';
import type { PlayLesson, PlayStackParamList } from '../types';
import { PLAY_FONT, playStyles } from '../playStyles';

type Nav = NativeStackNavigationProp<PlayStackParamList, 'PlayShare'>;
type R = RouteProp<PlayStackParamList, 'PlayShare'>;

interface ClassRef {
  class_id: string;
  name: string;
}

export default function PlayShareScreen() {
  const navigation = useNavigation<Nav>();
  const routeParams = useRoute<R>();
  const { lessonId } = routeParams.params;
  const { t } = useLanguage();
  const { user } = useAuth();

  const [lesson, setLesson] = useState<PlayLesson | null>(null);
  const [shared, setShared] = useState(false);
  const [allowCopy, setAllowCopy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Derive a default class id for the toggle. Prefer the lesson's existing
  // class_id, fall back to the student's first enrolled class.
  const userClasses: ClassRef[] =
    ((user as unknown as Record<string, unknown>)?.classes as ClassRef[] | undefined) ?? [];
  const defaultClassId =
    lesson?.class_id ??
    (user?.class_id as string | undefined) ??
    userClasses[0]?.class_id ??
    null;

  useEffect(() => {
    trackScreen('PlayShare');
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await playApi.getLesson(lessonId);
        if (cancelled) return;
        setLesson(data);
        setShared(!!data.shared_with_class);
        setAllowCopy(!!data.allow_copying);
      } catch (err) {
        trackError('play.share.load_failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lessonId]);

  const onShareToggle = useCallback((next: boolean) => {
    setShared(next);
    if (!next) setAllowCopy(false);
  }, []);

  const onSave = useCallback(async () => {
    if (saving) return;
    if (shared && !defaultClassId) {
      Alert.alert(t('play_share_no_class'));
      return;
    }
    setSaving(true);
    try {
      await playApi.updateSharing(
        lessonId,
        shared,
        allowCopy,
        shared && defaultClassId ? defaultClassId : undefined,
      );
      track('play.lesson.share_update', {
        lesson_id: lessonId,
        shared_with_class: shared,
        allow_copying: allowCopy,
      });
      Alert.alert(t('play_share_saved'));
      navigation.goBack();
    } catch (err) {
      trackError('play.lesson.share_failed', err);
      Alert.alert(
        'Could not save sharing',
        (err as { message?: string })?.message || 'Please try again.',
      );
    } finally {
      setSaving(false);
    }
  }, [saving, shared, allowCopy, defaultClassId, lessonId, navigation, t]);

  if (loading) {
    return (
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
      <View style={playStyles.headerBand}>
        <View style={playStyles.headerRow}>
          <BackButton variant="onTeal" />
          <Text style={[playStyles.headerTitle, { flex: 1, marginLeft: 12 }]} numberOfLines={1}>
            {t('play_share_title')}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <View style={styles.row}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.rowLabel}>{t('play_share_with_class')}</Text>
            {!defaultClassId && (
              <Text style={styles.rowHelp}>{t('play_share_no_class')}</Text>
            )}
          </View>
          <Switch
            value={shared}
            onValueChange={onShareToggle}
            trackColor={{ true: COLORS.teal500, false: COLORS.gray200 }}
            thumbColor={COLORS.white}
            disabled={!defaultClassId}
          />
        </View>

        <View style={styles.row}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={[styles.rowLabel, !shared && { color: COLORS.textLight }]}>
              {t('play_share_allow_copy')}
            </Text>
          </View>
          <Switch
            value={allowCopy && shared}
            onValueChange={setAllowCopy}
            trackColor={{ true: COLORS.teal500, false: COLORS.gray200 }}
            thumbColor={COLORS.white}
            disabled={!shared}
          />
        </View>

        <TrackedPressable
          analyticsId="play.share.save"
          style={[playStyles.primaryPill, { marginTop: 24 }, saving && { opacity: 0.5 }]}
          onPress={onSave}
          disabled={saving}
        >
          {saving ? (
            <ActivityIndicator color={COLORS.white} />
          ) : (
            <Text style={playStyles.primaryPillText}>{t('play_share_save')}</Text>
          )}
        </TrackedPressable>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  loaderWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  body: {
    paddingHorizontal: 24,
    paddingVertical: 18,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  rowLabel: {
    fontFamily: PLAY_FONT,
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
  },
  rowHelp: {
    fontFamily: PLAY_FONT,
    fontSize: 12,
    color: COLORS.textLight,
    marginTop: 4,
  },
});
