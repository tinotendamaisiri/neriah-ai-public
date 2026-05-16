// src/screens/GradingResultsScreen.tsx
// Per-homework grading results: Graded / Pending count cards + tabbed submissions list.

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { getTeacherSubmissions, approveAllMarks, deleteSubmission } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { RootStackParamList, TeacherSubmission } from '../types';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';

type Nav = NativeStackNavigationProp<RootStackParamList>;

type Tab = 'pending' | 'graded';

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso ?? ''; }
}

function fmtTime(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function pct(score?: number, max?: number): string {
  if (score == null || !max) return '';
  return `${Math.round((score / max) * 100)}%`;
}

function scoreColor(score?: number, max?: number): string {
  if (score == null || !max) return COLORS.gray500;
  const p = score / max;
  if (p >= 0.75) return COLORS.teal500;
  if (p >= 0.5) return COLORS.amber500;
  return COLORS.error;
}

/** Submission is graded/approved if approved=true OR status is 'graded'|'approved'. */
function isGraded(s: TeacherSubmission): boolean {
  return s.approved === true || s.status === 'graded' || s.status === 'approved';
}

/** Submission is pending if not yet graded. */
function isPending(s: TeacherSubmission): boolean {
  return !isGraded(s);
}

export default function GradingResultsScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<any>();
  const { user } = useAuth();
  const { t } = useLanguage();
  const { answer_key_id, class_id, class_name, answer_key_title } = route.params as {
    answer_key_id?: string;
    class_id: string;
    class_name: string;
    answer_key_title?: string;
  };

  const isClassView = !answer_key_id;

  const [submissions, setSubmissions] = useState<TeacherSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [tab, setTab] = useState<Tab>('pending');

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const subs = await getTeacherSubmissions({
        class_id,
        teacher_id: user?.id,
        ...(answer_key_id ? { answer_key_id } : {}),
      });
      setSubmissions(
        isClassView
          ? subs
          : subs.filter(s => s.answer_key_id === answer_key_id || !answer_key_id),
      );
    } catch (err: any) {
      // Offline + nothing in cache for this filter — don't yell at
      // the teacher, just render the empty state. Whatever is in
      // submissions state stays there (might be partial from a prior
      // load).
      if (!err?.isOffline) {
        Alert.alert('Error', err.message ?? 'Could not load grading results.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [answer_key_id, class_id, isClassView, user?.id]);

  // Refetch every time this screen gains focus (e.g. returning from GradingDetail)
  useFocusEffect(
    useCallback(() => { loadData(); }, [loadData]),
  );

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData(true);
  }, [loadData]);

  const handleApproveAll = useCallback(() => {
    // Approve All flips already-graded (status==='graded') submissions to
    // approved in bulk. It does NOT trigger grading — that's /grade-all.
    // Skip anything missing a submission id or already approved.
    const toApprove = submissions
      .filter(s => s.status === 'graded' && !s.approved && s.id)
      .map(s => s.id as string);
    if (toApprove.length === 0) return;
    Alert.alert(
      'Approve All',
      `Release grades to all ${toApprove.length} student${toApprove.length === 1 ? '' : 's'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve All',
          onPress: async () => {
            setApproving(true);
            try {
              const result = await approveAllMarks(toApprove);
              Alert.alert(
                'Done',
                `${result.approved} homework${result.approved === 1 ? '' : 's'} approved.`,
              );
              loadData();
            } catch (err: any) {
              Alert.alert('Error', err.message ?? 'Could not approve marks.');
            } finally {
              setApproving(false);
            }
          },
        },
      ],
    );
  }, [submissions, loadData]);

  const graded = submissions.filter(isGraded);
  const pending = submissions.filter(isPending);

  const gradedPcts = graded.map(s => (s.max_score ?? 0) > 0 ? ((s.score ?? 0) / (s.max_score ?? 1)) : 0);
  const avgPct = gradedPcts.length > 0
    ? Math.round(gradedPcts.reduce((a, b) => a + b, 0) / gradedPcts.length * 100)
    : null;
  const highestPct = gradedPcts.length > 0 ? Math.round(Math.max(...gradedPcts) * 100) : null;
  const lowestPct = gradedPcts.length > 0 ? Math.round(Math.min(...gradedPcts) * 100) : null;

  const visibleList = tab === 'pending' ? pending : graded;

  const confirmDelete = (s: TeacherSubmission) => {
    if (!s.id) {
      Alert.alert('Cannot delete', 'This submission has no server ID yet.');
      return;
    }
    const studentLabel = s.student_name ?? 'this student';
    const hwLabel = s.answer_key_title ?? answer_key_title ?? 'this homework';
    Alert.alert(
      'Delete submission?',
      `This will permanently delete ${studentLabel}'s submission for ${hwLabel}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSubmission(s.id as string);
              // Remove the row locally; analytics will refetch on next focus.
              setSubmissions((prev) => prev.filter((x) => x.id !== s.id));
              Alert.alert('Deleted', 'Submission deleted.');
            } catch (err: any) {
              Alert.alert('Could not delete', err.message ?? 'Please try again.');
            }
          },
        },
      ],
    );
  };

  const renderPendingRow = ({ item: s }: { item: TeacherSubmission }) => (
    <View style={styles.row}>
      <View style={styles.rowLeft}>
        <Text style={styles.studentName}>{s.student_name ?? 'Student'}</Text>
        {isClassView && s.answer_key_title && (
          <Text style={styles.homeworkLabel}>{s.answer_key_title}</Text>
        )}
        <Text style={styles.submittedDate}>
          {fmtDate(s.submitted_at)}{s.submitted_at ? ' · ' + fmtTime(s.submitted_at) : ''}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <View style={styles.pendingBadge}>
          <Text style={styles.pendingBadgeText}>Pending</Text>
        </View>
        <TouchableOpacity
          style={styles.gradeBtn}
          onPress={() => navigation.navigate('GradingDetail', {
            mark_id: s.mark_id,
            student_name: s.student_name ?? 'Student',
            class_name,
            answer_key_title: answer_key_title ?? '',
          })}
          activeOpacity={0.8}
        >
          <Text style={styles.gradeBtnText}>Grade</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={() => confirmDelete(s)}
          accessibilityLabel="Delete submission"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={18} color={COLORS.error} />
        </TouchableOpacity>
      </View>
    </View>
  );

  const renderGradedRow = ({ item: s }: { item: TeacherSubmission }) => (
    <TouchableOpacity
      style={styles.row}
      onPress={() => navigation.navigate('GradingDetail', {
        mark_id: s.mark_id,
        student_name: s.student_name ?? 'Student',
        class_name,
        answer_key_title: answer_key_title ?? '',
      })}
      activeOpacity={0.7}
    >
      <View style={styles.rowLeft}>
        <Text style={styles.studentName}>{s.student_name ?? 'Student'}</Text>
        {isClassView && s.answer_key_title && (
          <Text style={styles.homeworkLabel}>{s.answer_key_title}</Text>
        )}
        <Text style={styles.submittedDate}>
          {fmtDate(s.graded_at ?? s.submitted_at)}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.score, { color: scoreColor(s.score, s.max_score) }]}>
          {s.score ?? 0}/{s.max_score ?? '?'}
        </Text>
        <Text style={[styles.scorePct, { color: scoreColor(s.score, s.max_score) }]}>
          {pct(s.score, s.max_score)}
        </Text>
        <View style={styles.gradedBadge}>
          <Text style={styles.gradedBadgeText}>Graded</Text>
        </View>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={(e) => { e.stopPropagation(); confirmDelete(s); }}
          accessibilityLabel="Delete submission"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="trash-outline" size={18} color={COLORS.error} />
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
  );

  const listHeader = (
    <>
      {/* Summary cards */}
      <View style={styles.summaryRow}>
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryNum, { color: COLORS.teal500 }]}>{graded.length}</Text>
          <Text style={styles.summaryLabel}>{t('graded')}</Text>
        </View>
        <View style={styles.summaryCard}>
          <Text style={[styles.summaryNum, { color: COLORS.amber500 }]}>{pending.length}</Text>
          <Text style={styles.summaryLabel}>{t('pending')}</Text>
        </View>
      </View>

      {/* Class stats (only when some are graded) */}
      {avgPct != null && (
        <View style={styles.summaryRow}>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNum, { color: scoreColor(avgPct, 100) }]}>{avgPct}%</Text>
            <Text style={styles.summaryLabel}>{t('class_avg')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNum, { color: scoreColor(highestPct!, 100) }]}>{highestPct}%</Text>
            <Text style={styles.summaryLabel}>{t('highest')}</Text>
          </View>
          <View style={styles.summaryCard}>
            <Text style={[styles.summaryNum, { color: scoreColor(lowestPct!, 100) }]}>{lowestPct}%</Text>
            <Text style={styles.summaryLabel}>{t('lowest')}</Text>
          </View>
        </View>
      )}

      {/* Grade All button */}
      {pending.length > 1 && (
        <View style={styles.gradeAllRow}>
          <TouchableOpacity
            style={[styles.gradeAllBtn, approving && styles.btnDisabled]}
            onPress={handleApproveAll}
            disabled={approving}
            activeOpacity={0.8}
          >
            {approving
              ? <ActivityIndicator color={COLORS.white} size="small" />
              : <Text style={styles.gradeAllBtnText}>Grade All ({pending.length}) ✓</Text>
            }
          </TouchableOpacity>
        </View>
      )}

      {/* Pill tabs */}
      {submissions.length > 0 && (
        <View style={styles.tabRow}>
          {(['pending', 'graded'] as Tab[]).map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.tabPill, tab === t && styles.tabPillActive]}
              onPress={() => setTab(t)}
              activeOpacity={0.7}
            >
              <Text style={[styles.tabPillText, tab === t && styles.tabPillTextActive]}>
                {t === 'pending' ? `Pending (${pending.length})` : `Graded (${graded.length})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </>
  );

  const emptyComponent = (
    <View style={styles.empty}>
      {tab === 'pending' ? (
        <>
          <Ionicons name="checkmark-circle-outline" size={40} color={COLORS.teal500} />
          <Text style={[styles.emptyText, { color: COLORS.teal500, marginTop: 10 }]}>
            All submissions graded
          </Text>
        </>
      ) : (
        <>
          <Ionicons name="time-outline" size={40} color={COLORS.gray400} />
          <Text style={[styles.emptyText, { marginTop: 10 }]}>
            No graded submissions yet
          </Text>
        </>
      )}
    </View>
  );

  return (
    <ScreenContainer scroll={false}>
    <View style={styles.flex}>
      {/* Header — back button + title block side-by-side */}
      <View style={styles.header}>
        <BackButton />
        <View style={styles.headerTitleBlock}>
          <Text style={styles.heading}>
            {isClassView ? 'Homework' : (answer_key_title ?? '')}
          </Text>
          <Text style={styles.subheading}>{t('grading_results')}</Text>
        </View>
      </View>

      {loading ? (
        <View style={styles.centre}>
          <ActivityIndicator size="large" color={COLORS.teal500} />
        </View>
      ) : submissions.length === 0 ? (
        <View style={styles.centre}>
          <Ionicons name="document-outline" size={40} color={COLORS.gray500} />
          <Text style={[styles.emptyText, { marginTop: 12 }]}>{t('no_submissions')}</Text>
        </View>
      ) : (
        <FlatList
          data={(visibleList ?? []).filter(Boolean)}
          keyExtractor={item => item.id}
          renderItem={tab === 'pending' ? renderPendingRow : renderGradedRow}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={emptyComponent}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={COLORS.teal500}
              colors={[COLORS.teal500]}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
        />
      )}
    </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: COLORS.background },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  listContent: { paddingBottom: 60 },

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
  heading: { fontSize: 20, fontWeight: 'bold', color: COLORS.text },
  subheading: { fontSize: 13, color: COLORS.gray500, marginTop: 2 },

  // ── Summary cards ─────────────────────────────────────────────────────────
  summaryRow: { flexDirection: 'row', gap: 12, padding: 16 },
  summaryCard: {
    flex: 1, backgroundColor: COLORS.white, borderRadius: 12,
    padding: 14, alignItems: 'center',
    shadowColor: '#000', shadowOpacity: 0.04, shadowRadius: 4, shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  summaryNum: { fontSize: 24, fontWeight: 'bold', color: COLORS.teal500 },
  summaryLabel: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },

  // ── Grade All ─────────────────────────────────────────────────────────────
  gradeAllRow: { paddingHorizontal: 16, paddingBottom: 4 },
  gradeAllBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  gradeAllBtnText: { color: COLORS.white, fontWeight: 'bold', fontSize: 15 },
  btnDisabled: { opacity: 0.5 },

  // ── Tabs ──────────────────────────────────────────────────────────────────
  tabRow: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12,
  },
  tabPill: {
    flex: 1, paddingVertical: 9, borderRadius: 20,
    backgroundColor: COLORS.gray50, alignItems: 'center',
    borderWidth: 1, borderColor: COLORS.border,
  },
  tabPillActive: {
    backgroundColor: COLORS.teal500, borderColor: COLORS.teal500,
  },
  tabPillText: { fontSize: 13, fontWeight: '600', color: COLORS.gray500 },
  tabPillTextActive: { color: COLORS.white },

  // ── Row ───────────────────────────────────────────────────────────────────
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 12, paddingHorizontal: 16,
    backgroundColor: COLORS.white,
  },
  separator: { height: 1, backgroundColor: COLORS.background },
  rowLeft: { flex: 1 },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  studentName: { fontSize: 15, fontWeight: '600', color: COLORS.text },
  homeworkLabel: { fontSize: 12, color: COLORS.teal500, fontWeight: '600', marginTop: 1 },
  submittedDate: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  score: { fontSize: 16, fontWeight: 'bold' },
  scorePct: { fontSize: 12 },

  pendingBadge: {
    backgroundColor: COLORS.amber50, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  pendingBadgeText: { fontSize: 11, color: COLORS.amber700, fontWeight: '600' },

  gradedBadge: {
    backgroundColor: COLORS.teal50, borderRadius: 8,
    paddingHorizontal: 8, paddingVertical: 3,
  },
  gradedBadgeText: { fontSize: 11, color: COLORS.teal500, fontWeight: '600' },

  deleteBtn: {
    padding: 4,
    marginLeft: 4,
  },

  gradeBtn: {
    backgroundColor: COLORS.teal500, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 6,
  },
  gradeBtnText: { fontSize: 12, color: COLORS.white, fontWeight: '700' },

  // ── Empty ─────────────────────────────────────────────────────────────────
  empty: { alignItems: 'center', paddingTop: 48, paddingBottom: 24 },
  emptyText: { fontSize: 14, color: COLORS.gray500 },
});
