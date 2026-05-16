// src/screens/StudentSubmitScreen.tsx
// Lists open assignments; tapping one starts the camera capture flow.

import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../context/AuthContext';
import { getAssignments } from '../services/api';
import { Assignment, StudentRootStackParamList } from '../types';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { COLORS } from '../constants/colors';
import { ScreenContainer } from '../components/ScreenContainer';
import { BackButton } from '../components/BackButton';

type Nav = NativeStackNavigationProp<StudentRootStackParamList>;

export default function StudentSubmitScreen() {
  const { user } = useAuth();
  const navigation = useNavigation<Nav>();
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh = false) => {
    if (!user?.class_id) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const data = await getAssignments(user.class_id);
      setAssignments(data);
    } catch {
      if (!isRefresh) {
        Alert.alert('Error', 'Could not load assignments. Pull down to retry.');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [user]);

  useEffect(() => { load(false); }, []);

  const onRefresh = () => {
    setRefreshing(true);
    load(true);
  };

  const startSubmission = (assignment: Assignment) => {
    if (!user?.class_id) return;
    navigation.navigate('StudentCamera', {
      answer_key_id: assignment.id,
      answer_key_title: assignment.title ?? assignment.subject ?? 'Assignment',
      class_id: user.class_id,
    });
  };

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={COLORS.teal500} />
      </View>
    );
  }

  return (
    <ScreenContainer scroll={false} edges={['top', 'left', 'right']} style={{ backgroundColor: COLORS.background }}>
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <BackButton variant="onTeal" />
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Submit Work</Text>
            <Text style={styles.headerSub}>Choose an assignment to submit</Text>
          </View>
        </View>
      </View>

      {!user?.class_id ? (
        <View style={styles.noClassCard}>
          <MaterialIcons name="school" size={56} color={COLORS.gray500} style={styles.noClassIcon} />
          <Text style={styles.noClassTitle}>Not in a class yet</Text>
          <Text style={styles.noClassText}>
            Ask your teacher for a class join code and add it in Settings.
          </Text>
        </View>
      ) : (
        <FlatList
          data={assignments}
          keyExtractor={item => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.teal500} />}
          contentContainerStyle={assignments.length === 0 ? styles.emptyFlex : styles.listContent}
          ListEmptyComponent={() => (
            <View style={styles.empty}>
              <Ionicons name="clipboard-outline" size={56} color={COLORS.gray500} style={styles.emptyIcon} />
              <Text style={styles.emptyTitle}>No open assignments</Text>
              <Text style={styles.emptyText}>Your teacher hasn't opened any assignments yet.</Text>
            </View>
          )}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.card} onPress={() => startSubmission(item)}>
              <View style={styles.cardIcon}>
                <Ionicons name="create-outline" size={22} color={COLORS.teal500} />
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{item.title ?? item.subject ?? 'Assignment'}</Text>
                {item.subject && item.title && (
                  <Text style={styles.cardSub}>{item.subject}</Text>
                )}
                {item.total_marks != null && (
                  <Text style={styles.cardMeta}>Total marks: {item.total_marks}</Text>
                )}
              </View>
              <View style={styles.cardArrow}>
                <Text style={styles.cardArrowText}>→</Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: {
    backgroundColor: COLORS.teal500,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerTitle: { color: COLORS.white, fontSize: 22, fontWeight: '800' },
  headerSub: { color: COLORS.teal100, fontSize: 13, marginTop: 4 },
  listContent: { padding: 16 },
  emptyFlex: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyIcon: { marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  emptyText: { fontSize: 14, color: COLORS.gray500, textAlign: 'center', lineHeight: 20 },
  noClassCard: {
    flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40,
  },
  noClassIcon: { marginBottom: 16 },
  noClassTitle: { fontSize: 18, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  noClassText: { fontSize: 14, color: COLORS.gray500, textAlign: 'center', lineHeight: 20 },
  card: {
    backgroundColor: COLORS.white,
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  cardIcon: {
    width: 44,
    height: 44,
    borderRadius: 10,
    backgroundColor: COLORS.teal50,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  cardSub: { fontSize: 12, color: COLORS.gray500, marginTop: 2 },
  cardMeta: { fontSize: 12, color: COLORS.textLight, marginTop: 4 },
  cardArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.teal500,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardArrowText: { color: COLORS.white, fontSize: 16, fontWeight: '700' },
});
