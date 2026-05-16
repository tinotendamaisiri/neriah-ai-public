// src/components/StudentResultsView.tsx
//
// Reusable results body — extracted from the original StudentResultsScreen
// so the same UI can be embedded as a sub-tab inside StudentHomeScreen
// without duplicating the load/withdraw/tap-to-feedback logic.
//
// Pending submissions show a Withdraw button. Graded submissions are
// tappable and navigate to the FeedbackScreen for the matching mark_id.
// Auto-refetches on screen focus with a 30s stale check (so newly
// approved marks appear without pull-to-refresh).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Alert,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { getStudentSubmissions, withdrawSubmission } from '../services/api';
import { StudentSubmission, StudentRootStackParamList } from '../types';
import { COLORS } from '../constants/colors';

type Nav = NativeStackNavigationProp<StudentRootStackParamList>;

function gradeColor(pct: number) {
  if (pct >= 70) return COLORS.success;
  if (pct >= 50) return COLORS.warning;
  return COLORS.error;
}

interface Props {
  /**
   * When true, suppresses the bar-chart empty state's "Go to Homework"
   * button — useful when this view is already inside the Homework screen
   * and that button would just self-link.
   */
  hideEmptyHomeworkLink?: boolean;
}

export default function StudentResultsView({ hideEmptyHomeworkLink }: Props) {
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const [submissions, setSubmissions] = useState<StudentSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!user) return;
    void isRefresh; // signature kept for parity with previous screen
    try {
      const data = await getStudentSubmissions(user.id);
      // Sort by submitted_at DESC
      data.sort(
        (a, b) =>
          new Date(b.submitted_at).getTime() - new Date(a.submitted_at).getTime(),
      );
      setSubmissions(data);
    } catch {
      setSubmissions([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { load(false); }, []);

  // Refetch when the parent screen regains focus, with a 30s stale check
  // so we don't hammer the backend on every tab swap.
  const lastFetchRef = useRef<number>(0);
  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - lastFetchRef.current > 30_000) {
        lastFetchRef.current = now;
        load(false);
      }
    }, [load]),
  );

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const handleWithdraw = (sub: StudentSubmission) => {
    Alert.alert(
      'Withdraw submission',
      'Withdraw this submission? You can submit new work after.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Withdraw',
          style: 'destructive',
          onPress: async () => {
            try {
              await withdrawSubmission(sub.mark_id);
              setSubmissions(prev => prev.filter(s => s.mark_id !== sub.mark_id));
            } catch (err: any) {
              if (err?.response?.status === 403) {
                Alert.alert('Already graded', 'This submission has already been graded.');
                load(true);
              } else {
                Alert.alert('Error', 'Could not withdraw. Try again.');
              }
            }
          },
        },
      ],
    );
  };

  const handleTapGraded = (sub: StudentSubmission) => {
    navigation.navigate('Feedback', { mark_id: sub.mark_id });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  return (
    <FlatList
      data={submissions}
      keyExtractor={item => item.mark_id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={COLORS.teal500}
        />
      }
      contentContainerStyle={
        submissions.length === 0 ? styles.emptyFlex : styles.listContent
      }
      ListEmptyComponent={() => (
        <View style={styles.empty}>
          <Ionicons
            name="bar-chart-outline"
            size={56}
            color={COLORS.gray500}
            style={styles.emptyIcon}
          />
          <Text style={styles.emptyTitle}>No submissions yet</Text>
          <Text style={styles.emptyText}>
            Your graded work will appear here once your teacher marks your submissions.
          </Text>
          {!hideEmptyHomeworkLink && (
            <TouchableOpacity
              style={styles.emptyBtn}
              onPress={() => (navigation as any).navigate('StudentHome')}
            >
              <Text style={styles.emptyBtnText}>Go to Homework</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      renderItem={({ item }) => {
        const isPending = item.status === 'pending';

        if (isPending) {
          return (
            <View style={[styles.card, styles.pendingCard]}>
              <View style={styles.cardLeft}>
                <Text style={styles.cardTitle}>{item.answer_key_title ?? 'Submission'}</Text>
                <Text style={styles.cardMeta}>
                  Submitted {new Date(item.submitted_at).toLocaleDateString()}
                </Text>
                <Text style={styles.waitingText}>Waiting for teacher to grade</Text>
              </View>
              <View style={styles.cardRight}>
                <View style={styles.pendingBadge}>
                  <Text style={styles.pendingBadgeText}>Pending</Text>
                </View>
                <TouchableOpacity
                  style={styles.withdrawBtn}
                  onPress={() => handleWithdraw(item)}
                >
                  <Text style={styles.withdrawBtnText}>Withdraw</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }

        const pct = item.percentage ??
          (item.score != null && item.max_score
            ? Math.round((item.score / item.max_score) * 100)
            : null);
        const color = pct != null ? gradeColor(pct) : COLORS.textLight;

        return (
          <TouchableOpacity
            style={[styles.card, styles.gradedCard]}
            onPress={() => handleTapGraded(item)}
            activeOpacity={0.75}
          >
            <View style={styles.cardLeft}>
              <Text style={styles.cardTitle}>{item.answer_key_title ?? 'Assignment'}</Text>
              {item.score != null && item.max_score != null && (
                <Text style={[styles.scoreLine, { color }]}>
                  {item.score}/{item.max_score}
                  {pct != null ? ` (${pct}%)` : ''}
                </Text>
              )}
              <Text style={styles.cardMeta}>
                Submitted {new Date(item.submitted_at).toLocaleDateString()}
                {item.graded_at
                  ? ` · Graded ${new Date(item.graded_at).toLocaleDateString()}`
                  : ''}
              </Text>
            </View>
            <View style={styles.cardRight}>
              <View style={[styles.gradedBadge, { backgroundColor: color }]}>
                <Text style={styles.gradedBadgeText}>Graded</Text>
              </View>
              {pct != null && (
                <View style={[styles.scoreCircle, { borderColor: color }]}>
                  <Text style={[styles.scoreCircleText, { color }]}>{pct}%</Text>
                </View>
              )}
              <Text style={styles.tapHint}>View →</Text>
            </View>
          </TouchableOpacity>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 },
  listContent: { padding: 16, paddingBottom: 40 },
  emptyFlex: { flex: 1, minHeight: 360 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyIcon: { marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: COLORS.gray500, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  emptyBtn: {
    backgroundColor: COLORS.teal500,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  emptyBtnText: { color: COLORS.white, fontSize: 14, fontWeight: '700' },
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  pendingCard: {
    borderColor: COLORS.amber100,
    backgroundColor: COLORS.amber50,
  },
  gradedCard: {
    borderColor: COLORS.teal50,
  },
  cardLeft: { flex: 1, paddingRight: 10 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  scoreLine: { fontSize: 15, fontWeight: '700', marginTop: 4 },
  waitingText: { fontSize: 12, color: COLORS.amber700, marginTop: 4 },
  cardMeta: { fontSize: 11, color: COLORS.textLight, marginTop: 4 },
  cardRight: { alignItems: 'flex-end', gap: 6 },
  pendingBadge: {
    backgroundColor: COLORS.amber300,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  pendingBadgeText: { color: COLORS.white, fontSize: 11, fontWeight: '700' },
  gradedBadge: {
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  gradedBadgeText: { color: COLORS.white, fontSize: 11, fontWeight: '700' },
  withdrawBtn: {
    borderWidth: 1,
    borderColor: '#fca5a5',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  withdrawBtnText: { color: COLORS.error, fontSize: 11, fontWeight: '600' },
  scoreCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.white,
  },
  scoreCircleText: { fontSize: 13, fontWeight: '800' },
  tapHint: { fontSize: 11, color: COLORS.teal500, fontWeight: '600' },
});
