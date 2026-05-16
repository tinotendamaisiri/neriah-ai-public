// src/screens/StudentHomeScreen.tsx
// Student home: greeting, open assignments, recent feedback, stats card.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import {
  getAssignments,
  getStudentMarks,
  getStudentClassAnalytics,
} from '../services/api';
import { Assignment, StudentMark, StudentClassAnalytics, StudentRootStackParamList } from '../types';
import { Ionicons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import AvatarWithStatus from '../components/AvatarWithStatus';
import { useLanguage } from '../context/LanguageContext';
import { ScreenContainer } from '../components/ScreenContainer';
import StudentResultsView from '../components/StudentResultsView';

type Nav = NativeStackNavigationProp<StudentRootStackParamList>;

interface ClassInfo {
  class_id: string;
  name: string;
  subject: string;
  school_name: string;
  teacher_name: string;
}

export default function StudentHomeScreen() {
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const { t } = useLanguage();

  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [recentMarks, setRecentMarks] = useState<StudentMark[]>([]);
  const [analytics, setAnalytics] = useState<StudentClassAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Sub-tab inside the Homework screen — "assignments" lists open homework
  // and recent feedback; "results" embeds the same view that used to live
  // at the bottom-nav Results tab. Default = assignments.
  const [tab, setTab] = useState<'assignments' | 'results'>('assignments');

  // ── Multi-class switcher ──────────────────────────────────────────────────
  const [enrolledClasses, setEnrolledClasses] = useState<ClassInfo[]>([]);
  const [activeClassId, setActiveClassId] = useState(user?.class_id ?? '');
  const [classPickerOpen, setClassPickerOpen] = useState(false);

  useEffect(() => {
    const classes: ClassInfo[] = ((user as unknown as Record<string, unknown>)?.classes as ClassInfo[] ?? []);
    if (classes.length > 0) {
      setEnrolledClasses(classes);
      AsyncStorage.getItem('active_class_id').then(saved => {
        if (saved && classes.some(c => c.class_id === saved)) setActiveClassId(saved);
        else setActiveClassId(user?.class_id ?? classes[0]?.class_id ?? '');
      }).catch(() => {});
    }
  }, [user]);

  const switchClass = (classId: string) => {
    setActiveClassId(classId);
    setClassPickerOpen(false);
    AsyncStorage.setItem('active_class_id', classId).catch(() => {});
    setLoading(true);
    load(false, classId);
  };

  const activeClass = enrolledClasses.find(c => c.class_id === activeClassId);

  const ASSIGN_CACHE = user ? `cache_assignments_${user.id}` : null;
  const MARKS_CACHE = user ? `cache_marks_${user.id}` : null;

  const load = useCallback(async (isRefresh = false, classIdOverride?: string) => {
    if (!user) return;
    const classId = classIdOverride || activeClassId || user.class_id;
    console.log('[StudentHome] fetching assignments for class:', classId);

    const [assignmentsResult, marksResult] = await Promise.allSettled([
      classId ? getAssignments(classId) : Promise.resolve([]),
      // Recent Feedback shows the latest 3 graded marks. Full history with
      // pending + withdraw lives in the Results sub-tab.
      getStudentMarks(user.id, 3),
    ]);

    if (assignmentsResult.status === 'fulfilled') {
      console.log('[StudentHome] assignments response:', JSON.stringify(assignmentsResult.value));
      setAssignments(assignmentsResult.value);
      if (ASSIGN_CACHE) AsyncStorage.setItem(ASSIGN_CACHE, JSON.stringify(assignmentsResult.value)).catch(() => {});
    } else {
      console.log('[StudentHome] assignments error:', assignmentsResult.status === 'rejected' ? assignmentsResult.reason?.message : 'unknown');
      if (ASSIGN_CACHE) {
        const cached = await AsyncStorage.getItem(ASSIGN_CACHE).catch(() => null);
        if (cached) setAssignments(JSON.parse(cached));
      }
    }

    if (marksResult.status === 'fulfilled') {
      setRecentMarks(marksResult.value);
      if (MARKS_CACHE) AsyncStorage.setItem(MARKS_CACHE, JSON.stringify(marksResult.value)).catch(() => {});
    } else if (MARKS_CACHE) {
      const cached = await AsyncStorage.getItem(MARKS_CACHE).catch(() => null);
      if (cached) setRecentMarks(JSON.parse(cached));
    }

    if (assignmentsResult.status === 'rejected' && marksResult.status === 'rejected' && !isRefresh) {
      Alert.alert('Offline', 'Showing cached data. Pull to refresh when connected.');
    }

    if (classId) {
      try {
        const analyticsData = await getStudentClassAnalytics(classId, user.id);
        setAnalytics(analyticsData);
      } catch {
        // Analytics non-critical
      }
    }

    setLoading(false);
    setRefreshing(false);
  }, [user]);

  useEffect(() => { load(false); }, []);

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const goToCamera = (assignment: Assignment) => {
    if (!user?.class_id) return;
    navigation.navigate('StudentCamera', {
      answer_key_id: assignment.id,
      answer_key_title: assignment.title ?? assignment.subject ?? 'Assignment',
      class_id: user.class_id,
    });
  };

  const gradeColor = (pct: number) => {
    if (pct >= 70) return COLORS.success;
    if (pct >= 50) return COLORS.warning;
    return COLORS.error;
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  const firstName = user?.first_name ?? 'there';

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']} style={{ backgroundColor: COLORS.background }}>
    <View style={styles.container}>
      {/* Header (shared across both sub-tabs) */}
      <View style={styles.header}>
        <View style={styles.headerTitleBlock}>
          <Text style={styles.greeting} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{t('my_homework')}</Text>
          <Text style={styles.subGreeting}>{t('hello_name').replace('{name}', firstName)}</Text>
        </View>
        <AvatarWithStatus
            variant="light"
          initial={firstName[0].toUpperCase()}
          onPress={() => navigation.navigate('StudentSettings' as any)}
        />
      </View>

      {/* Sub-tab segmented control: My Assignments | Results */}
      <View style={styles.tabBar}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'assignments' && styles.tabBtnActive]}
          onPress={() => setTab('assignments')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabBtnText, tab === 'assignments' && styles.tabBtnTextActive]}>
            {t('my_assignments')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'results' && styles.tabBtnActive]}
          onPress={() => setTab('results')}
          activeOpacity={0.7}
        >
          <Text style={[styles.tabBtnText, tab === 'results' && styles.tabBtnTextActive]}>
            {t('results')}
          </Text>
        </TouchableOpacity>
      </View>

      {tab === 'results' ? (
        <StudentResultsView hideEmptyHomeworkLink />
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.teal500} />}
        >

      {/* Class switcher (only if 2+ classes) */}
      {enrolledClasses.length > 1 && (
        <TouchableOpacity
          style={styles.classSwitcher}
          onPress={() => setClassPickerOpen(!classPickerOpen)}
          activeOpacity={0.7}
        >
          <Text style={styles.classSwitcherText}>
            {activeClass ? `${activeClass.name}${activeClass.school_name ? ' — ' + activeClass.school_name : ''}` : t('select_class')}
          </Text>
          <Ionicons name={classPickerOpen ? 'chevron-up' : 'chevron-down'} size={16} color={COLORS.teal500} />
        </TouchableOpacity>
      )}

      {classPickerOpen && (
        <View style={styles.classPickerList}>
          {enrolledClasses.map(c => (
            <TouchableOpacity
              key={c.class_id}
              style={[styles.classPickerItem, c.class_id === activeClassId && styles.classPickerItemActive]}
              onPress={() => switchClass(c.class_id)}
            >
              <Text style={[styles.classPickerName, c.class_id === activeClassId && { color: COLORS.teal500 }]}>
                {c.name}{c.subject ? ` — ${c.subject}` : ''}
              </Text>
              <Text style={styles.classPickerSchool}>{c.school_name || ''}</Text>
              {c.class_id === activeClassId && <Ionicons name="checkmark-circle" size={18} color={COLORS.teal500} />}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Assignments */}
      <Text style={styles.sectionTitle}>{t('my_assignments')}</Text>
      {assignments.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="document-text-outline" size={36} color={COLORS.gray300} style={{ marginBottom: 10 }} />
          <Text style={styles.emptyTitle}>{t('no_assignments_yet')}</Text>
          <Text style={styles.emptyText}>{t('teacher_no_homework')}</Text>
        </View>
      ) : (
        assignments.map(a => {
          const isPendingSetup = a.status === 'pending_setup';
          const isOpen = !isPendingSetup && a.open_for_submission !== false;
          const isSubmitted = a.has_pending_submission === true;
          const isTappable = isOpen && !isSubmitted;
          return (
            <TouchableOpacity
              key={a.id}
              style={styles.assignmentCard}
              onPress={() => isTappable ? goToCamera(a) : undefined}
              activeOpacity={isTappable ? 0.7 : 1}
            >
              <View style={styles.assignmentInfo}>
                <Text style={styles.assignmentTitle}>{a.title ?? a.subject}</Text>
                {a.subject && a.title && (
                  <Text style={styles.assignmentSub}>{a.subject}{a.total_marks ? ` · ${a.total_marks} marks` : ''}</Text>
                )}
              </View>
              {isPendingSetup ? (
                <View style={styles.closedChip}>
                  <Text style={styles.closedChipText}>Coming soon</Text>
                </View>
              ) : isSubmitted ? (
                <View style={styles.submittedChip}>
                  <Text style={styles.submittedChipText}>{t('submitted')}</Text>
                </View>
              ) : isOpen ? (
                <View style={styles.submitChip}>
                  <Text style={styles.submitChipText}>{t('submit')} →</Text>
                </View>
              ) : (
                <View style={styles.closedChip}>
                  <Text style={styles.closedChipText}>{t('closed')}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })
      )}

      {/* Recent feedback — latest 3, tappable, with See more switching to Results sub-tab */}
      {recentMarks.length > 0 && (
        <>
          <Text style={styles.sectionTitle}>{t('recent_feedback')}</Text>
          {recentMarks.slice(0, 3).map(m => {
            const pct = m.max_score > 0 ? Math.round((m.score / m.max_score) * 100) : 0;
            return (
              <TouchableOpacity
                key={m.id}
                style={styles.markCard}
                onPress={() => navigation.navigate('Feedback', { mark_id: m.id, mark: m })}
                activeOpacity={0.75}
              >
                <View style={styles.markCardLeft}>
                  <Text style={styles.markSubject}>{m.answer_key_title ?? 'Assignment'}</Text>
                  {m.feedback ? (
                    <Text style={styles.markFeedback} numberOfLines={2}>{m.feedback}</Text>
                  ) : null}
                </View>
                <View style={[styles.scoreCircle, { borderColor: gradeColor(pct) }]}>
                  <Text style={[styles.scoreText, { color: gradeColor(pct) }]}>{pct}%</Text>
                </View>
              </TouchableOpacity>
            );
          })}
          {/* See more — switches to the Results sub-tab in this same screen */}
          <TouchableOpacity
            style={styles.seeMoreBtn}
            onPress={() => setTab('results')}
            activeOpacity={0.7}
          >
            <Text style={styles.seeMoreText}>{t('see_more')} →</Text>
          </TouchableOpacity>
        </>
      )}

      {/* Class stats */}
      {analytics && analytics.enabled && (
        <>
          <View style={styles.sectionRow}>
            <Text style={styles.sectionTitle}>Class Performance</Text>
            {user?.class_id && (
              <TouchableOpacity onPress={() => navigation.navigate('StudentAnalytics', { class_id: user.class_id! })}>
                <Text style={styles.seeAll}>Full analytics →</Text>
              </TouchableOpacity>
            )}
          </View>
          <View style={styles.statsRow}>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{analytics.student_average ?? '—'}%</Text>
              <Text style={styles.statLabel}>My Average</Text>
            </View>
            <View style={styles.statCard}>
              <Text style={styles.statValue}>{analytics.class_average ?? '—'}%</Text>
              <Text style={styles.statLabel}>Class Average</Text>
            </View>
            {analytics.student_rank != null && analytics.total_students != null && (
              <View style={styles.statCard}>
                <Text style={styles.statValue}>#{analytics.student_rank}</Text>
                <Text style={styles.statLabel}>of {analytics.total_students}</Text>
              </View>
            )}
          </View>
        </>
      )}
        </ScrollView>
      )}
    </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // ── Sub-tab bar (My Assignments / Results) ───────────────────────────────
  tabBar: {
    flexDirection: 'row',
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBtnActive: {
    borderBottomColor: COLORS.teal500,
  },
  tabBtnText: {
    fontSize: 14,
    fontWeight: '600',
    color: COLORS.textLight,
  },
  tabBtnTextActive: {
    color: COLORS.teal500,
  },
  // ── See more (under Recent Feedback) ─────────────────────────────────────
  seeMoreBtn: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  seeMoreText: {
    fontSize: 13,
    fontWeight: '700',
    color: COLORS.teal500,
  },
  header: {
    backgroundColor: COLORS.teal500,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitleBlock: {
    flex: 1,
    paddingRight: 12,
  },
  greeting: { color: COLORS.white, fontSize: 20, fontWeight: '800' },
  subGreeting: { color: COLORS.teal100, fontSize: 12, marginTop: 2 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: COLORS.white, fontSize: 20, fontWeight: '700' },
  classSwitcher: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    marginHorizontal: 16, marginTop: 10, paddingVertical: 8, paddingHorizontal: 14,
    backgroundColor: COLORS.white, borderRadius: 10, borderWidth: 1, borderColor: COLORS.teal100,
  },
  classSwitcherText: { fontSize: 13, fontWeight: '600', color: COLORS.teal500 },
  classPickerList: {
    marginHorizontal: 16, marginTop: 4, backgroundColor: COLORS.white,
    borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: COLORS.border,
  },
  classPickerItem: {
    flexDirection: 'row', alignItems: 'center', padding: 12,
    borderBottomWidth: 1, borderBottomColor: COLORS.background, gap: 8,
  },
  classPickerItemActive: { backgroundColor: COLORS.teal50 },
  classPickerName: { fontSize: 14, fontWeight: '600', color: COLORS.text, flex: 1 },
  classPickerSchool: { fontSize: 12, color: COLORS.gray500 },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginHorizontal: 20,
    marginTop: 24,
    marginBottom: 10,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
    marginHorizontal: 20,
    marginTop: 24,
    marginBottom: 10,
  },
  seeAll: { fontSize: 13, color: COLORS.teal500, fontWeight: '600', marginHorizontal: 20 },
  emptyCard: {
    marginHorizontal: 20,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 28,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  emptyTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700', marginBottom: 4 },
  emptyText: { color: COLORS.textLight, fontSize: 13, textAlign: 'center' },
  assignmentCard: {
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  assignmentInfo: { flex: 1 },
  assignmentTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  assignmentSub: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  submitChip: {
    backgroundColor: COLORS.teal500,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  submitChipText: { color: COLORS.white, fontSize: 13, fontWeight: '700' },
  closedChip: {
    backgroundColor: COLORS.gray100,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  closedChipText: { color: COLORS.gray500, fontSize: 13, fontWeight: '600' },
  submittedChip: {
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  submittedChipText: { color: '#388E3C', fontSize: 13, fontWeight: '700' },
  markCard: {
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  markCardLeft: { flex: 1 },
  markSubject: { fontSize: 14, fontWeight: '700', color: COLORS.text },
  markFeedback: { fontSize: 12, color: COLORS.gray500, marginTop: 4, lineHeight: 18 },
  scoreCircle: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 12,
  },
  scoreText: { fontSize: 14, fontWeight: '800' },
  statsRow: {
    flexDirection: 'row',
    marginHorizontal: 20,
    gap: 10,
    marginBottom: 10,
  },
  statCard: {
    flex: 1,
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  statValue: { fontSize: 22, fontWeight: '800', color: COLORS.teal500 },
  statLabel: { fontSize: 11, color: COLORS.gray500, marginTop: 4, textAlign: 'center' },
});
