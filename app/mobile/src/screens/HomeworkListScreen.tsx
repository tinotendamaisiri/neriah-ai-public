// src/screens/HomeworkListScreen.tsx
// All homework assignments for a class — graded/pending counts + filter tabs.

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
import { listAnswerKeys } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { AnswerKey, RootStackParamList } from '../types';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';

type Nav = NativeStackNavigationProp<RootStackParamList>;
type FilterTab = 'all' | 'graded' | 'pending';

// ── Enriched homework type with counts ────────────────────────────────────────

type HomeworkItem = AnswerKey & {
  submission_count: number;
  graded_count: number;
  approved_count?: number;   // backend may not yet ship this on cached items
  pending_count: number;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso?: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: 'numeric', month: 'short', year: 'numeric',
    });
  } catch { return iso ?? ''; }
}

function isOverdue(due?: string | null): boolean {
  if (!due) return false;
  try { return new Date(due) < new Date(); } catch { return false; }
}

/**
 * A homework is classified as "graded" only when it has at least one
 * submission AND every submission has been approved by the teacher.
 * Past-due-with-no-submissions stays pending — there's nothing to grade.
 *
 * Falls back to graded_count when approved_count isn't present (older
 * cached homework records from before the backend started shipping it).
 */
function getStatus(hw: HomeworkItem): 'graded' | 'pending' {
  const submitted = hw.submission_count ?? 0;
  if (submitted <= 0) return 'pending';
  const approved = hw.approved_count ?? hw.graded_count ?? 0;
  return approved >= submitted ? 'graded' : 'pending';
}

// ── Screen ────────────────────────────────────────────────────────────────────

export default function HomeworkListScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<any>();
  const { user } = useAuth();
  const { class_id, class_name } = route.params as { class_id: string; class_name: string };

  const [homeworks, setHomeworks] = useState<HomeworkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<FilterTab>('all');

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const keys = await listAnswerKeys(class_id) as HomeworkItem[];
      // Sort newest first
      keys.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      setHomeworks(keys);
    } catch (err: any) {
      // Offline + empty cache → no homework yet for this class.
      // Don't alert; the screen renders its empty state instead.
      if (!err?.isOffline) {
        Alert.alert('Error', err.message ?? 'Could not load homework list.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [class_id]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    loadData(true);
  }, [loadData]);

  const graded = homeworks.filter(hw => getStatus(hw) === 'graded');
  const pending = homeworks.filter(hw => getStatus(hw) === 'pending');
  const visible = tab === 'graded' ? graded : tab === 'pending' ? pending : homeworks;

  return (
    <ScreenContainer scroll={false}>
    <View style={s.container}>
      {/* Header */}
      <View style={s.header}>
        <TouchableOpacity
          onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Main')}
          style={s.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Ionicons name="chevron-back" size={22} color={COLORS.teal500} />
        </TouchableOpacity>
        <View style={s.headerText}>
          <Text style={s.headerTitle} numberOfLines={1}>{class_name} — Homework</Text>
          <Text style={s.headerSub}>All assignments</Text>
        </View>
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={COLORS.teal500} style={{ marginTop: 60 }} />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={item => item.id}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={COLORS.teal500} />
          }
          contentContainerStyle={visible.length === 0 ? s.emptyContainer : s.listContent}
          ListHeaderComponent={
            <>
              {/* Count cards */}
              <View style={s.countRow}>
                <View style={[s.countCard, s.countCardGreen]}>
                  <Text style={s.countNumber}>{graded.length}</Text>
                  <Text style={s.countLabel}>Graded</Text>
                </View>
                <View style={[s.countCard, s.countCardAmber]}>
                  <Text style={[s.countNumber, s.countNumberAmber]}>{pending.length}</Text>
                  <Text style={[s.countLabel, s.countLabelAmber]}>Pending</Text>
                </View>
              </View>

              {/* Filter tabs */}
              <View style={s.tabRow}>
                {(['all', 'graded', 'pending'] as FilterTab[]).map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[s.tab, tab === t && s.tabActive]}
                    onPress={() => setTab(t)}
                  >
                    <Text style={[s.tabText, tab === t && s.tabTextActive]}>
                      {t === 'all' ? `All (${homeworks.length})` : t === 'graded' ? `Graded (${graded.length})` : `Pending (${pending.length})`}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          }
          renderItem={({ item }) => (
            <HomeworkRow
              hw={item}
              onPress={() => navigation.navigate('HomeworkDetail', {
                answer_key_id: item.id,
                class_id,
                class_name,
              })}
            />
          )}
          ListEmptyComponent={<EmptyState tab={tab} />}
        />
      )}
    </View>
    </ScreenContainer>
  );
}

// ── Homework row card ─────────────────────────────────────────────────────────

function HomeworkRow({ hw, onPress }: { hw: HomeworkItem; onPress: () => void }) {
  const status = getStatus(hw);
  const overdue = isOverdue(hw.due_date) && status !== 'graded';
  const sub = hw.submission_count ?? 0;
  const grad = hw.graded_count ?? 0;
  const pend = hw.pending_count ?? 0;

  return (
    <TouchableOpacity style={card.container} onPress={onPress} activeOpacity={0.75}>
      <View style={card.top}>
        <Text style={card.title} numberOfLines={2}>{hw.title || 'Untitled'}</Text>
        <View style={[card.badge, status === 'graded' ? card.badgeGreen : card.badgeAmber]}>
          <Text style={[card.badgeText, status === 'graded' ? card.badgeTextGreen : card.badgeTextAmber]}>
            {status === 'graded' ? 'Graded' : 'Pending'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={COLORS.gray500} />
      </View>

      <View style={card.metaRow}>
        {hw.subject ? (
          <Text style={card.metaChip}>{hw.subject}</Text>
        ) : null}
        {hw.education_level ? (
          <Text style={card.metaChip}>{hw.education_level}</Text>
        ) : null}
        {hw.submission_code ? (
          <Text
            style={card.codeChip}
            // Long-press to select; the system selection menu lets the
            // teacher Copy. No extra native dep needed.
            selectable
          >
            Code: {hw.submission_code}
          </Text>
        ) : null}
      </View>

      {hw.due_date ? (
        <Text style={[card.due, overdue && card.dueOverdue]}>
          {overdue ? 'Overdue' : `Due ${fmtDate(hw.due_date)}`}
        </Text>
      ) : null}

      <View style={card.statsRow}>
        {sub > 0 && (
          <Text style={card.stat}>{sub} submitted</Text>
        )}
        {grad > 0 && (
          <Text style={card.stat}>{grad} graded{pend > 0 ? ` · ${pend} pending` : ''}</Text>
        )}
      </View>

    </TouchableOpacity>
  );
}

// ── Empty states ──────────────────────────────────────────────────────────────

function EmptyState({ tab }: { tab: FilterTab }) {
  if (tab === 'graded') {
    return (
      <View style={empty.wrap}>
        <Ionicons name="hourglass-outline" size={40} color={COLORS.gray200} />
        <Text style={empty.title}>No graded homework yet</Text>
        <Text style={empty.sub}>Grade student submissions to see them here.</Text>
      </View>
    );
  }
  if (tab === 'pending') {
    return (
      <View style={empty.wrap}>
        <Ionicons name="checkmark-circle" size={40} color={COLORS.success} />
        <Text style={empty.title}>All homework graded!</Text>
        <Text style={empty.sub}>Nothing pending — great work!</Text>
      </View>
    );
  }
  return (
    <View style={empty.wrap}>
      <Ionicons name="document-text-outline" size={40} color={COLORS.gray200} />
      <Text style={empty.title}>No homework assigned yet</Text>
      <Text style={empty.sub}>Tap Add Homework to get started.</Text>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1, borderBottomColor: COLORS.border,
  },
  backBtn: { padding: 4 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text },
  headerSub: { fontSize: 12, color: COLORS.textLight, marginTop: 1 },
  listContent: { paddingBottom: 32 },
  emptyContainer: { flexGrow: 1 },
  countRow: {
    flexDirection: 'row', gap: 12,
    paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4,
  },
  countCard: {
    flex: 1, borderRadius: 12, padding: 16, alignItems: 'center',
  },
  countCardGreen: { backgroundColor: '#E8F8EF' },
  countCardAmber: { backgroundColor: COLORS.amber50 },
  countNumber: { fontSize: 32, fontWeight: '800', color: COLORS.success },
  countNumberAmber: { color: COLORS.amber500 },
  countLabel: { fontSize: 13, fontWeight: '600', color: COLORS.success, marginTop: 2 },
  countLabelAmber: { color: COLORS.amber500 },
  tabRow: {
    flexDirection: 'row', gap: 8,
    paddingHorizontal: 16, paddingVertical: 12,
  },
  tab: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20,
    backgroundColor: COLORS.gray200,
  },
  tabActive: { backgroundColor: COLORS.teal500 },
  tabText: { fontSize: 13, fontWeight: '600', color: COLORS.textLight },
  tabTextActive: { color: COLORS.white },
});

const card = StyleSheet.create({
  container: {
    backgroundColor: COLORS.white, marginHorizontal: 16, marginBottom: 10,
    borderRadius: 12, padding: 14, position: 'relative',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  title: { flex: 1, fontSize: 15, fontWeight: '700', color: COLORS.text },
  badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, flexShrink: 0 },
  badgeGreen: { backgroundColor: '#E8F8EF' },
  badgeAmber: { backgroundColor: COLORS.amber50 },
  badgeText: { fontSize: 11, fontWeight: '700' },
  badgeTextGreen: { color: COLORS.success },
  badgeTextAmber: { color: COLORS.amber500 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 4 },
  metaChip: {
    fontSize: 11, color: COLORS.teal500, fontWeight: '600',
    backgroundColor: COLORS.teal50, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6,
  },
  // Visually distinct from metaChip so the code stands out — it's the
  // one piece of metadata teachers will be sharing with students.
  // Mono-ish font + amber background so it looks like a stamp.
  codeChip: {
    fontSize: 11, color: COLORS.amber500, fontWeight: '700',
    backgroundColor: COLORS.amber50, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6,
    fontFamily: 'Menlo',
    letterSpacing: 0.5,
  },
  due: { fontSize: 12, color: COLORS.textLight, marginBottom: 4 },
  dueOverdue: { color: COLORS.error, fontWeight: '600' },
  statsRow: { flexDirection: 'row', gap: 12, marginTop: 4 },
  stat: { fontSize: 12, color: COLORS.teal500, fontWeight: '600' },
});

const empty = StyleSheet.create({
  wrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 32, paddingTop: 60, gap: 10,
  },
  title: { fontSize: 16, fontWeight: '700', color: COLORS.gray900, textAlign: 'center' },
  sub: { fontSize: 13, color: COLORS.textLight, textAlign: 'center' },
});
