// src/screens/HomeScreen.tsx
// Teacher's class list with per-class homework sections.
// Speed-dial FAB for "New Class" and "Add Homework".

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { listClasses, listAnswerKeys, getTeacherSubmissions } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { AnswerKey, Class, RootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import AvatarWithStatus from '../components/AvatarWithStatus';
import { useModel } from '../context/ModelContext';
import { ScreenContainer } from '../components/ScreenContainer';
import OfflineModelBanner from '../components/OfflineModelBanner';

const CLASSES_CACHE_KEY = (teacherId: string) => `cache_classes_${teacherId}`;

type Nav = NativeStackNavigationProp<RootStackParamList>;

const LEVEL_DISPLAY: Record<string, string> = {
  grade_1: 'Grade 1', grade_2: 'Grade 2', grade_3: 'Grade 3',
  grade_4: 'Grade 4', grade_5: 'Grade 5', grade_6: 'Grade 6', grade_7: 'Grade 7',
  form_1: 'Form 1', form_2: 'Form 2', form_3: 'Form 3',
  form_4: 'Form 4', form_5: 'Form 5 (A-Level)', form_6: 'Form 6 (A-Level)',
  tertiary: 'College/University',
};

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso ?? ''; }
}

/** Short DD/MM/YY format — e.g. "12/04/26". Used on homework cards. */
function fmtDateShort(iso?: string | null): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
  } catch { return iso ?? ''; }
}

// ── Memoized class group item — prevents re-renders on unrelated state changes ─

interface ClassGroupItemProps {
  cls: Class;
  answerKeys: AnswerKey[];
  submCountByKey: Record<string, number>;
  gradedCountByKey: Record<string, number>;
  t: (key: any) => string;
  onCardPress: (cls: Class) => void;
  onAddHomework: (cls: Class) => void;
  onHomeworkPress: (ak: AnswerKey, cls: Class) => void;
  onViewGrading: (ak: AnswerKey, cls: Class) => void;
  /** Toggle the inline-expanded state for this class's homework list.
   *  When expanded, all homework rows render. When collapsed, only the
   *  first two render plus a "+N more" link. */
  onToggleExpand: (cls: Class) => void;
  expanded: boolean;
}

const ClassGroupItem = React.memo(function ClassGroupItem({
  cls, answerKeys, submCountByKey, gradedCountByKey, t,
  onCardPress, onAddHomework, onHomeworkPress, onViewGrading,
  onToggleExpand, expanded,
}: ClassGroupItemProps) {
  return (
    <View style={styles.classGroup}>
      <TouchableOpacity
        style={styles.classCard}
        onPress={() => onCardPress(cls)}
        activeOpacity={0.7}
      >
        <View style={styles.classCardMain}>
          <View style={styles.classInfo}>
            <Text style={styles.className}>{cls.name}</Text>
            <Text style={styles.classMeta}>
              {LEVEL_DISPLAY[cls.education_level] ?? cls.education_level}
            </Text>
          </View>
          <View style={styles.cardStats}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{cls.student_count ?? 0}</Text>
              <Text style={styles.statLabel}>{t('students')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{answerKeys.length}</Text>
              <Text style={styles.statLabel}>{t('homework')}</Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>

      <View style={styles.homeworkSection}>
        {(() => {
          // Show every homework for the class regardless of
          // open_for_submission. Teachers want to see closed homework
          // too — the open/closed status is conveyed per-row by the
          // status badge, not by hiding the row.
          const allKeys = answerKeys;
          const previewKeys = expanded ? allKeys : allKeys.slice(0, 2);
          const hiddenCount = allKeys.length - previewKeys.length;
          return (
            <>
              {previewKeys.map(ak => {
                const subCount = submCountByKey[ak.id] ?? 0;
                const gradedCount = gradedCountByKey[ak.id] ?? 0;
                const isPendingSetup = ak.status === 'pending_setup';
                const hasScheme = ak.questions.length > 0;
                const hasGraded = gradedCount > 0;
                return (
                  <TouchableOpacity
                    key={ak.id}
                    style={[styles.homeworkCard, isPendingSetup && styles.homeworkCardAmber]}
                    onPress={() => onHomeworkPress(ak, cls)}
                    activeOpacity={0.75}
                  >
                    <View style={styles.homeworkCardLeft}>
                      <Text style={styles.homeworkTitle}>{ak.title}</Text>
                      {ak.due_date && (
                        <Text style={styles.homeworkDue}>
                          {t('due_date')} {fmtDateShort(ak.due_date)}
                        </Text>
                      )}
                      <Text style={styles.homeworkSubCount}>{subCount} {t('submissions')}</Text>
                    </View>
                    <View style={styles.homeworkCardRight}>
                      {isPendingSetup ? (
                        <View style={styles.statusBadgeAmber}>
                          <Text style={styles.statusBadgeAmberText}>{t('needs_setup')}</Text>
                        </View>
                      ) : !hasScheme ? (
                        <View style={styles.statusBadgeAmber}>
                          <Text style={styles.statusBadgeAmberText}>Add Scheme</Text>
                        </View>
                      ) : hasGraded ? (
                        <TouchableOpacity
                          style={styles.viewGradingBtn}
                          onPress={(e) => { e.stopPropagation(); onViewGrading(ak, cls); }}
                        >
                          <Text style={styles.viewGradingText}>{t('view_grading')}</Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={styles.statusBadgeTeal}>
                          <Text style={styles.statusBadgeTealText}>{t('ready_to_grade')}</Text>
                        </View>
                      )}
                      <Text style={styles.homeworkChevron}>›</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              {hiddenCount > 0 && (
                <TouchableOpacity style={styles.moreLink} onPress={() => onToggleExpand(cls)}>
                  <Text style={styles.moreLinkText}>+ {hiddenCount} more</Text>
                </TouchableOpacity>
              )}
              {expanded && allKeys.length > 2 && (
                <TouchableOpacity style={styles.moreLink} onPress={() => onToggleExpand(cls)}>
                  <Text style={styles.moreLinkText}>Show less</Text>
                </TouchableOpacity>
              )}
              {allKeys.length === 0 && (
                <TouchableOpacity style={styles.addHomeworkBtn} onPress={() => onAddHomework(cls)}>
                  <Ionicons name="add-circle-outline" size={16} color={COLORS.teal500} />
                  <Text style={styles.addHomeworkText}>{t('add_homework')}</Text>
                </TouchableOpacity>
              )}
            </>
          );
        })()}
        {answerKeys.filter(k => k.open_for_submission === true).length > 0 && (
          <TouchableOpacity style={styles.addHomeworkBtn} onPress={() => onAddHomework(cls)}>
            <Ionicons name="add-circle-outline" size={16} color={COLORS.teal500} />
            <Text style={styles.addHomeworkText}>{t('add_homework')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
});

export default function HomeScreen() {
  const navigation = useNavigation<Nav>();
  const { user } = useAuth();
  const { t, language } = useLanguage();
  // checkWifiNudge runs the gating logic that decides whether the
  // OfflineModelBanner should show its "ready to download" state on focus.
  // Banner reads showWifiNudge / acceptDownload / dismissWifiNudge itself.
  const { checkWifiNudge } = useModel();
  console.log('[HomeScreen] render, language =', language, ', my_classes =', t('my_classes'));
  const [classes, setClasses] = useState<Class[]>([]);
  const [answerKeysByClass, setAnswerKeysByClass] = useState<Record<string, AnswerKey[]>>({});
  const [submCountByKey, setSubmCountByKey] = useState<Record<string, number>>({});
  const [gradedCountByKey, setGradedCountByKey] = useState<Record<string, number>>({});
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fabOpen, setFabOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const cacheKey = user ? CLASSES_CACHE_KEY(user.id) : null;

    const [classData, subData] = await Promise.allSettled([
      listClasses(),
      getTeacherSubmissions({ teacher_id: user?.id }),
    ]);

    let loadedClasses: Class[] = [];

    if (classData.status === 'fulfilled') {
      loadedClasses = classData.value;
      setClasses(loadedClasses);
      if (cacheKey) {
        AsyncStorage.setItem(cacheKey, JSON.stringify(loadedClasses)).catch(() => {});
      }
    } else {
      if (cacheKey) {
        try {
          const cached = await AsyncStorage.getItem(cacheKey);
          if (cached) { loadedClasses = JSON.parse(cached); setClasses(loadedClasses); }
          else setError('Failed to load classes. Pull down to retry.');
        } catch {
          setError('Failed to load classes. Pull down to retry.');
        }
      } else {
        setError('Failed to load classes. Pull down to retry.');
      }
    }

    if (subData.status === 'fulfilled') {
      const subs = subData.value;
      setPendingCount(subs.filter(s => s.status === 'pending').length);
      const countMap: Record<string, number> = {};
      const gradedMap: Record<string, number> = {};
      subs.forEach(s => {
        countMap[s.answer_key_id] = (countMap[s.answer_key_id] ?? 0) + 1;
        if (s.status === 'graded' || s.status === 'approved') {
          gradedMap[s.answer_key_id] = (gradedMap[s.answer_key_id] ?? 0) + 1;
        }
      });
      setSubmCountByKey(countMap);
      setGradedCountByKey(gradedMap);
    }

    // Fetch answer keys for all classes in parallel (best-effort)
    if (loadedClasses.length > 0) {
      const keyResults = await Promise.allSettled(
        loadedClasses.map(c => listAnswerKeys(c.id)),
      );
      const keyMap: Record<string, AnswerKey[]> = {};
      loadedClasses.forEach((c, i) => {
        const r = keyResults[i];
        keyMap[c.id] = r.status === 'fulfilled' ? r.value : [];
      });
      setAnswerKeysByClass(keyMap);
    }

    setLoading(false);
    setRefreshing(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      // Always refetch on focus so student_count is fresh after ClassSetup/ClassDetail.
      // Only show the full loading spinner on cold start (no data yet).
      if (classes.length === 0) setLoading(true);
      load();
      checkWifiNudge();

      // Poll every 30s while screen is focused — keeps student_count and
      // homework count fresh without full-page reload.
      const poll = setInterval(() => { load(); }, 30_000);
      return () => clearInterval(poll);
    }, [load, checkWifiNudge]),
  );

  const handleManageClass = useCallback((cls: Class) => {
    navigation.navigate('ClassDetail', {
      class_id: cls.id,
      class_name: cls.name,
      education_level: cls.education_level,
      curriculum: (cls.curriculum ?? 'zimsec') as 'zimsec' | 'cambridge',
    });
  }, [navigation]);

  const handleAddClass = useCallback(() => {
    setFabOpen(false);
    navigation.navigate('ClassSetup');
  }, [navigation]);

  const handleAddHomeworkForClass = useCallback((cls: Class) => {
    navigation.navigate('AddHomework', { class_id: cls.id, class_name: cls.name, education_level: cls.education_level });
  }, [navigation]);

  const handleAddHomeworkFab = useCallback(() => {
    setFabOpen(false);
    navigation.navigate('AddHomework', {});
  }, [navigation]);

  const handleHomeworkPress = useCallback((ak: AnswerKey, cls: Class) => {
    navigation.navigate('HomeworkDetail', {
      answer_key_id: ak.id,
      class_id: cls.id,
      class_name: cls.name,
    });
  }, [navigation]);

  const handleViewGrading = useCallback((ak: AnswerKey, cls: Class) => {
    navigation.navigate('GradingResults', {
      answer_key_id: ak.id,
      class_id: cls.id,
      class_name: cls.name,
      answer_key_title: ak.title,
    });
  }, [navigation]);

  // Per-class expanded-list state for inline "show all homework"
  // toggling. Stored as a Set<class_id> keyed off the class id so
  // multiple classes can be expanded simultaneously and React.memo
  // on ClassGroupItem doesn't see new identities for unchanged rows.
  const [expandedClasses, setExpandedClasses] = useState<Set<string>>(new Set());
  const handleToggleExpand = useCallback((cls: Class) => {
    setExpandedClasses((prev) => {
      const next = new Set(prev);
      if (next.has(cls.id)) next.delete(cls.id);
      else next.add(cls.id);
      return next;
    });
  }, []);

  if (loading) {
    return (
      <ScreenContainer scroll={false} edges={['top', 'left', 'right']}>
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']} style={{ backgroundColor: COLORS.background }}>
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View>
            <Text style={styles.greeting}>{t('hello')}, {user ? `${user.title ? user.title + ' ' : ''}${user.surname ?? user.first_name ?? 'Teacher'}`.trim() : 'Teacher'}</Text>
            <Text style={styles.heading}>{t('my_classes')}</Text>
          </View>
          <AvatarWithStatus
            initial={(user?.first_name?.[0] ?? user?.surname?.[0] ?? 'T').toUpperCase()}
            onPress={() => navigation.navigate('Settings' as any)}
          />
        </View>
      </View>

      {error && <Text style={styles.error}>{error}</Text>}

      {/* Single unified offline-AI banner — handles every user-facing state:
          downloading/installing/paused (with progress bar), Wi-Fi-nudge
          download prompt (with Download/Later buttons), or hidden when
          offline mode isn't applicable (cloud-only device, model already
          ready). Replaces the previous OfflineGradingStatus pill + the
          inline Wi-Fi nudge that used to stack on top of each other. */}
      <OfflineModelBanner />

      {/* Pending submissions banner */}
      {pendingCount > 0 && (
        <TouchableOpacity
          style={styles.inboxBanner}
          onPress={() => navigation.navigate('TeacherInbox')}
          activeOpacity={0.8}
        >
          <View style={styles.inboxBannerLeft}>
            <Ionicons name="cloud-download-outline" size={22} color={COLORS.teal500} style={styles.inboxBannerIcon} />
            <View>
              <Text style={styles.inboxBannerTitle}>
                {pendingCount} {t('inbox_waiting')}
              </Text>
              <Text style={styles.inboxBannerSub}>{t('inbox_sub')}</Text>
            </View>
          </View>
          <Text style={styles.inboxBannerArrow}>›</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={classes}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        windowSize={5}
        initialNumToRender={5}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor={COLORS.teal500}
          />
        }
        renderItem={({ item: cls }) => (
          <ClassGroupItem
            cls={cls}
            answerKeys={answerKeysByClass[cls.id] ?? []}
            submCountByKey={submCountByKey}
            gradedCountByKey={gradedCountByKey}
            t={t}
            onCardPress={handleManageClass}
            onAddHomework={handleAddHomeworkForClass}
            onHomeworkPress={handleHomeworkPress}
            onViewGrading={handleViewGrading}
            onToggleExpand={handleToggleExpand}
            expanded={expandedClasses.has(cls.id)}
          />
        )}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>{t('no_classes')}</Text>
            <Text style={styles.emptySubtitle}>{t('no_classes_sub')}</Text>
          </View>
        }
      />

      {/* Speed dial overlay */}
      {fabOpen && (
        <TouchableOpacity
          style={styles.fabOverlay}
          activeOpacity={1}
          onPress={() => setFabOpen(false)}
        />
      )}

      {/* Mini FABs — shown when speed dial is open */}
      {fabOpen && (
        <View style={styles.fabOptions}>
          <View style={styles.fabOptionRow}>
            <Text style={styles.fabOptionLabel}>{t('new_class')}</Text>
            <TouchableOpacity style={styles.miniFab} onPress={handleAddClass} activeOpacity={0.8}>
              <Ionicons name="people-outline" size={20} color={COLORS.white} />
            </TouchableOpacity>
          </View>
          <View style={styles.fabOptionRow}>
            <Text style={styles.fabOptionLabel}>{t('add_homework')}</Text>
            <TouchableOpacity style={styles.miniFab} onPress={handleAddHomeworkFab} activeOpacity={0.8}>
              <Ionicons name="book-outline" size={20} color={COLORS.white} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Main FAB */}
      <TouchableOpacity
        style={[styles.fab, fabOpen && styles.fabOpen]}
        onPress={() => setFabOpen(v => !v)}
        activeOpacity={0.8}
      >
        <Ionicons name={fabOpen ? 'close' : 'add'} size={28} color={COLORS.white} />
      </TouchableOpacity>
    </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centre: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    backgroundColor: COLORS.white, paddingHorizontal: 20,
    paddingTop: 16, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  headerRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
  },
  greeting: { fontSize: 13, color: COLORS.gray500 },
  heading: { fontSize: 24, fontWeight: 'bold', color: COLORS.text, marginTop: 2 },
  error: { color: COLORS.error, paddingHorizontal: 20, paddingTop: 12, fontSize: 14 },
  list: { padding: 16, paddingBottom: 120 },

  // ── Class group ──────────────────────────────────────────────────────────────
  classGroup: { marginBottom: 20 },

  classCard: {
    backgroundColor: COLORS.white, borderRadius: 12,
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  classCardMain: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  classInfo: { flex: 1 },
  className: { fontSize: 17, fontWeight: '600', color: COLORS.text },
  classMeta: { fontSize: 13, color: COLORS.gray500, marginTop: 3 },
  cardStats: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statItem: { alignItems: 'center', minWidth: 44 },
  statValue: { fontSize: 18, fontWeight: 'bold', color: COLORS.teal500 },
  statLabel: { fontSize: 10, color: COLORS.textLight, marginTop: 1 },
  statDivider: { width: 1, height: 28, backgroundColor: COLORS.border, marginHorizontal: 4 },
  // ── Homework section ─────────────────────────────────────────────────────────
  homeworkSection: {
    marginTop: 4, marginLeft: 12,
    borderLeftWidth: 2, borderLeftColor: COLORS.teal100,
    paddingLeft: 10,
  },
  homeworkCard: {
    backgroundColor: COLORS.white, borderRadius: 10, marginBottom: 6,
    padding: 12, flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.03, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  homeworkCardAmber: { backgroundColor: COLORS.amber50 },
  homeworkCardLeft: { flex: 1 },
  homeworkTitle: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  homeworkMeta: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  homeworkDue: { fontSize: 12, color: COLORS.amber700, marginTop: 1 },
  homeworkSubCount: { fontSize: 12, color: COLORS.teal500, marginTop: 3, fontWeight: '600' },
  homeworkCardRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusBadgeAmber: {
    backgroundColor: COLORS.amber50, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5, alignItems: 'center',
  },
  statusBadgeAmberText: { fontSize: 10, color: COLORS.amber700, fontWeight: '700', textAlign: 'center' },
  statusBadgeTeal: {
    backgroundColor: COLORS.teal50, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5, alignItems: 'center',
  },
  statusBadgeTealText: { fontSize: 10, color: COLORS.teal500, fontWeight: '700', textAlign: 'center' },
  viewGradingBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 5, alignItems: 'center',
  },
  viewGradingText: { fontSize: 10, color: COLORS.white, fontWeight: '700', textAlign: 'center' },
  homeworkChevron: { fontSize: 18, color: COLORS.gray500 },

  addHomeworkBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 10, paddingHorizontal: 4,
  },
  addHomeworkText: { fontSize: 13, color: COLORS.teal500, fontWeight: '600' },
  moreLink: { paddingVertical: 8, paddingHorizontal: 4 },
  moreLinkText: { fontSize: 13, color: COLORS.teal500, fontWeight: '600' },

  // ── Inbox banner ─────────────────────────────────────────────────────────────
  inboxBanner: {
    marginHorizontal: 16, marginTop: 12, backgroundColor: COLORS.amber50,
    borderRadius: 12, padding: 14, borderWidth: 1, borderColor: COLORS.amber100,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  inboxBannerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  inboxBannerIcon: {},
  inboxBannerTitle: { fontSize: 14, fontWeight: '700', color: COLORS.amber700 },
  inboxBannerSub: { fontSize: 12, color: COLORS.amber500, marginTop: 2 },
  inboxBannerArrow: { fontSize: 20, color: COLORS.amber500 },

  // ── Wi-Fi nudge banner ───────────────────────────────────────────────────────
  wifiNudge: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: COLORS.teal50,
    borderRadius: 12, padding: 12,
    borderWidth: 1, borderColor: COLORS.teal100,
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', gap: 10,
  },
  wifiNudgeRow: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  wifiNudgeText: { fontSize: 13, color: COLORS.teal500, fontWeight: '500', lineHeight: 18, flexShrink: 1 },
  wifiNudgeActions: { flexDirection: 'row', gap: 8, flexShrink: 0 },
  wifiNudgeDownloadBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 7,
  },
  wifiNudgeDownloadText: { fontSize: 13, fontWeight: '700', color: COLORS.white },
  wifiNudgeLaterBtn: {
    borderWidth: 1, borderColor: COLORS.teal100, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 7,
  },
  wifiNudgeLaterText: { fontSize: 13, fontWeight: '600', color: COLORS.teal500 },

  // ── Empty state ───────────────────────────────────────────────────────────────
  emptyContainer: { alignItems: 'center', paddingTop: 64 },
  emptyTitle: { fontSize: 18, fontWeight: '600', color: COLORS.gray900 },
  emptySubtitle: { fontSize: 14, color: COLORS.textLight, marginTop: 6, textAlign: 'center' },

  // ── Speed dial FAB ───────────────────────────────────────────────────────────
  fabOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.25)' },
  fabOptions: {
    position: 'absolute', bottom: 100, right: 20, alignItems: 'flex-end', gap: 12,
  },
  fabOptionRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  fabOptionLabel: {
    backgroundColor: COLORS.gray900, color: COLORS.white,
    fontSize: 13, fontWeight: '600', paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 8, overflow: 'hidden',
  },
  miniFab: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.teal500,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: COLORS.teal500, shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  fab: {
    position: 'absolute', bottom: 28, right: 20, width: 56, height: 56,
    borderRadius: 28, backgroundColor: COLORS.teal500,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: COLORS.teal500, shadowOpacity: 0.4, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  fabOpen: { backgroundColor: COLORS.teal700 },
});
